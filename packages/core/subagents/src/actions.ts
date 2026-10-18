import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import type { ActionUi, AgentsAction, AgentsActionProvider, AgentsActionTarget, SubagentPresentation, SubagentPresenter } from "../../src/agents-actions-contract.js";
import { agentActionLabels, deepFreeze, errorText, formatAgentDetail, formatAgentError, jsonValue, loadingRegistry, navigatorAttentionSortByState, sanitizeDisplayText, visibleStandaloneAgentAttemptActions, workflowPromptArtifact, workflowResultArtifact, type AgentAttemptActionUi, type AgentAttemptSummary, type AgentDetailPresentation, type StandaloneAgentAttemptActionContext, type WorkflowProgressStyles } from "../../src/index.js";
import { normalizeSubagentRunRequest, type SubagentManager, type SubagentManagerContext, type SubagentProgress, type SubagentRunRequest, type SubagentStatus } from "./contracts.js";
import { attemptValue, statusValue } from "./decode.js";

/**
 * The /subagents actions: the rules the /subagents picker (navigator.ts) and the
 * agents workspace /subagents and /agents open share. Whatever they ask of the person goes through the ActionUi they are
 * given; nothing here calls ctx.ui.
 */

const MAX_DETAIL_TEXT = 4000;

export type NavigatorEntry = {
  readonly status: SubagentStatus;
  readonly request?: SubagentRunRequest;
  readonly requestError?: string;
};
type Inspection = { readonly entry: NavigatorEntry; readonly record: Record<string, unknown> };
/** What the actions ask of the person; the /agents workspace hands its whole ActionUi. */
export type SubagentActionUi = Pick<ActionUi, "notify" | "confirm" | "select" | "input" | "editText" | "openArtifact" | "setWorkingMessage">;

function objectValue(value: unknown): Record<string, unknown> | undefined { return typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : undefined; }
function isFileNotFound(error: unknown): boolean { return objectValue(error)?.code === "ENOENT"; }
function safeRunId(id: string): boolean { return id !== "." && id !== ".." && /^[A-Za-z0-9._-]+$/.test(id); }

function inspectionValue(value: unknown): { status: SubagentStatus; record: Record<string, unknown> } | undefined {
  const record = objectValue(value);
  const status = statusValue(value);
  return record && status ? { status, record } : undefined;
}

// Detail inspections only feed this UI, so they carry the live activity that tool results leave out.
function managerContext(context: ExtensionCommandContext, waitForForeground = true, includeAttemptMetadata = false): SubagentManagerContext {
  return { toolCallId: "subagents-command", signal: undefined, onUpdate: undefined, ...(waitForForeground ? {} : { waitForForeground: false }), ...(includeAttemptMetadata ? { includeAttemptMetadata: true, includeActivity: true } : {}), extensionContext: context };
}

async function loadRequest(storageDirectory: string, id: string): Promise<{ request?: SubagentRunRequest; error?: string }> {
  if (!safeRunId(id)) return {};
  try {
    const value: unknown = JSON.parse(await readFile(join(storageDirectory, id, "request.json"), "utf8"));
    return { request: normalizeSubagentRunRequest(value) };
  } catch (error) {
    if (isFileNotFound(error)) return {};
    return { error: errorText(error) };
  }
}

const ATTENTION_ORDER: Readonly<Record<SubagentStatus["state"], number>> = { running: 0, failed: 1, stopped: 2, completed: 3 };
function attentionSort(entries: readonly NavigatorEntry[]): NavigatorEntry[] {
  return navigatorAttentionSortByState(entries, (entry) => entry.status.state, (entry) => entry.status.finishedAt, ATTENTION_ORDER);
}

export async function loadEntries(manager: SubagentManager, storageDirectory: string, context: ExtensionCommandContext): Promise<NavigatorEntry[]> {
  const value = await manager.inspect({}, managerContext(context));
  if (!Array.isArray(value)) return [];
  const entries: NavigatorEntry[] = [];
  const sessionId = context.sessionManager.getSessionId();
  for (const candidate of value) {
    const status = statusValue(candidate);
    if (!status || status.sessionId !== sessionId) continue;
    const request = await loadRequest(storageDirectory, status.id);
    entries.push({ status, ...(request.request === undefined ? {} : { request: request.request }), ...(request.error === undefined ? {} : { requestError: request.error }) });
  }
  return attentionSort(entries);
}

export async function inspectEntry(manager: SubagentManager, storageDirectory: string, id: string, context: ExtensionCommandContext): Promise<Inspection> {
  const inspected = inspectionValue(await manager.inspect({ id }, managerContext(context, true, true)));
  if (!inspected) throw new Error(`Subagent ${id} returned an invalid inspection`);
  const request = await loadRequest(storageDirectory, id);
  return {
    record: inspected.record,
    entry: { status: inspected.status, ...(request.request === undefined ? {} : { request: request.request }), ...(request.error === undefined ? {} : { requestError: request.error }) },
  };
}

function shortId(id: string): string { return id.length > 12 ? id.slice(0, 8) : id; }
function entryName(entry: NavigatorEntry): string {
  return boundedText(sanitizeDisplayText(entry.request?.label ?? "").trim() || sanitizeDisplayText(shortId(entry.status.id)), 256);
}
/** Names for a list of runs; a repeated name carries its short ID, as in the `/workflow` picker, so every row stays unique. */
export function listNames(entries: readonly NavigatorEntry[]): string[] {
  const names = entries.map(entryName);
  return entries.map(({ status }, index) => {
    const name = names[index] ?? "";
    return names.indexOf(name) === names.lastIndexOf(name) ? name : `${name} ${sanitizeDisplayText(shortId(status.id))}`;
  });
}
export function boundedText(value: unknown, limit = MAX_DETAIL_TEXT): string {
  const text = typeof value === "string" ? value : (() => { try { const serialized: unknown = JSON.stringify(value, null, 2); return typeof serialized === "string" ? serialized : String(value); } catch { return String(value); } })();
  return text.length > limit ? `${text.slice(0, limit)}…` : text;
}
function displayText(value: unknown, limit?: number): string { return sanitizeDisplayText(boundedText(value, limit)); }

function latestAttempt(status: SubagentStatus): AgentAttemptSummary | undefined {
  return [...(status.attemptDetails ?? [])].sort((left, right) => right.attempt - left.attempt)[0];
}
function usageAccounting(status: SubagentStatus): SubagentProgress["accounting"] | undefined {
  return status.progress?.accounting;
}
function detailPresentation(inspection: Inspection): AgentDetailPresentation {
  const { status } = inspection.entry;
  const attempt = latestAttempt(status);
  const state = status.progress?.state;
  const activity = status.progress?.activity;
  const model = state?.model ?? attempt?.setup.model;
  const tools = state?.tools ?? attempt?.setup.tools;
  const lastEventAt = status.progress?.lastEventAt;
  const attempts = status.attempts ?? attempt?.attempt;
  const accounting = usageAccounting(status);
  const error = status.error ?? attempt?.error;
  return {
    state: status.state,
    ...(activity === undefined ? {} : { activity: { kind: activity.kind, text: displayText(activity.text) } }),
    ...(lastEventAt === undefined ? {} : { lastEventAt }),
    ...(model === undefined ? {} : { model: { provider: displayText(model.provider, 256), model: displayText(model.model, 256), ...(model.thinking === undefined ? {} : { thinking: model.thinking }) } }),
    ...(tools === undefined ? {} : { tools: tools.slice(0, 256).map((tool) => displayText(tool, 256)) }),
    ...(attempts === undefined ? {} : { attempts }),
    ...(status.startedAt === undefined ? {} : { startedAt: status.startedAt }),
    ...(status.finishedAt === undefined ? {} : { finishedAt: status.finishedAt }),
    ...(accounting === undefined ? {} : { accounting }),
    ...(error === undefined ? {} : { error: { code: displayText(error.code, 256), message: displayText(error.message) } }),
  };
}
/** Details of the selected run in the order of a /workflow agent: fields, then the error. The prompt and result open in the editor. */
export function detailRows(inspection: Inspection, styles: WorkflowProgressStyles, now: number): string[] {
  const { entry } = inspection;
  const presentation = detailPresentation(inspection);
  return [
    styles.bold(`Selected subagent: ${entryName(entry)}`),
    `ID: ${displayText(entry.status.id, 256)}`,
    ...formatAgentDetail(presentation, styles, entry.status.finishedAt ?? now, { includeError: false }),
    ...(entry.requestError === undefined ? [] : [styles.warning(`Request unavailable: ${displayText(entry.requestError)}`)]),
    ...(presentation.error === undefined ? [] : [formatAgentError(presentation.error, styles)]),
  ];
}

function standaloneActionContext(manager: SubagentManager, inspection: Inspection, ui: AgentAttemptActionUi): StandaloneAgentAttemptActionContext | undefined {
  const status = inspection.entry.status;
  const request = inspection.entry.request;
  const liveData = manager.getAttemptActionData?.(status.id);
  const attempt = attemptValue(liveData?.attempt) ?? latestAttempt(status);
  if (!attempt) return undefined;
  const session = attempt.session;
  const live = liveData?.liveSession && session && liveData.liveSession.reference.transport === session.transport && liveData.liveSession.reference.sessionId === session.sessionId ? liveData.liveSession : undefined;
  const label = request?.label?.trim();
  const name = label || "subagent";
  const actionUi = {
    notify: (message: string, level: "info" | "warning" | "error" = "info") => { ui.notify(message, level); },
    confirm: (title: string, message: string) => ui.confirm(title, message),
    select: (title: string, options: readonly string[]) => ui.select(title, [...options]),
    input: (title: string, placeholder?: string) => ui.input(title, placeholder),
    setWorkingMessage: (message?: string) => { ui.setWorkingMessage?.(message); },
  };
  const actionAttempt = deepFreeze(attempt);
  const actionAgent = deepFreeze({ id: status.id, name, state: status.state, ...(label === undefined ? {} : { label }) });
  return {
    agent: actionAgent,
    attempt: actionAttempt,
    ...(actionAttempt.session === undefined ? {} : { session: actionAttempt.session }),
    ...(live === undefined ? {} : { liveSession: live, ...(liveData?.prepared === undefined ? {} : { prepared: liveData.prepared }), ...(liveData?.handoff === undefined ? {} : { handoff: liveData.handoff }) }),
    signal: liveData?.signal ?? new AbortController().signal,
    ui: Object.freeze(actionUi),
  };
}
function liveSystemPrompt(manager: SubagentManager, status: SubagentStatus): string | undefined {
  return manager.getAttemptActionData?.(status.id)?.prepared?.systemPrompt;
}
type BulkDeleteState = "completed" | "failed";
export const BULK_DELETE: Readonly<Record<string, BulkDeleteState>> = { "Delete all completed": "completed", "Delete all failed": "failed" };
/** The /workflow picker's bulk deletions, offered for the states present in the list. */
export function bulkDeleteLabels(manager: SubagentManager, entries: readonly NavigatorEntry[]): string[] {
  if (manager.delete === undefined) return [];
  return Object.entries(BULK_DELETE).filter(([, state]) => entries.some((entry) => entry.status.state === state)).map(([label]) => label);
}
/**
 * Agent actions plus the /workflow run actions that apply to a standalone run: Delete and Copy run path, before Copy agent ID.
 * `ui` is the one a registered action's visibility sees.
 */
export function actionOptions(manager: SubagentManager, inspection: Inspection, context: ExtensionCommandContext, ui: AgentAttemptActionUi, bulk: readonly string[] = []): string[] {
  const actionContext = standaloneActionContext(manager, inspection, ui);
  const extensionLabels = actionContext === undefined ? [] : visibleStandaloneAgentAttemptActions(loadingRegistry().agentAttemptActions(), actionContext).map(([, action]) => action.label);
  const value = inspection.record.value;
  const labels = agentActionLabels({
    extensionLabels,
    hasWorktree: inspection.entry.status.worktree !== undefined,
    openPrompt: context.mode === "tui" && inspection.entry.request?.prompt !== undefined,
    openSystemPrompt: context.mode === "tui" && liveSystemPrompt(manager, inspection.entry.status) !== undefined,
    openResult: context.mode === "tui" && Object.prototype.hasOwnProperty.call(inspection.record, "value") && jsonValue(value),
    standaloneState: inspection.entry.status.state,
  });
  const runActions = [...(manager.delete !== undefined && inspection.entry.status.state !== "running" ? ["Delete"] : []), ...bulk, ...(context.mode === "tui" ? ["Copy run path"] : [])];
  labels.splice(labels.indexOf("Copy agent ID"), 0, ...runActions);
  return labels;
}
export async function deleteAll(manager: SubagentManager, storageDirectory: string, context: ExtensionCommandContext, state: BulkDeleteState, ui: Pick<ActionUi, "confirm" | "notify">): Promise<boolean> {
  if (!await ui.confirm(`Delete ${state} runs?`, `Delete all ${state} subagent runs and their records? This cannot be undone.`)) return false;
  const skipped: string[] = [];
  let deleted = 0;
  for (const entry of await loadEntries(manager, storageDirectory, context)) {
    if (entry.status.state !== state) continue;
    try {
      await manager.delete?.({ id: entry.status.id }, managerContext(context));
      deleted += 1;
    } catch (error) {
      skipped.push(`${entry.status.id} (${errorText(error)})`);
    }
  }
  if (skipped.length) ui.notify(`Skipped ${state} runs: ${skipped.join(", ")}.`, "warning");
  if (deleted) ui.notify(`Deleted ${String(deleted)} ${state} subagent run(s).`, "info");
  return true;
}
function retryResult(value: unknown): { readonly id: string; readonly state: "running" } | undefined {
  const record = objectValue(value);
  return record && typeof record.id === "string" && record.id.trim() && record.state === "running" ? { id: record.id, state: "running" } : undefined;
}
async function steerSubagent(manager: SubagentManager, storageDirectory: string, id: string, context: ExtensionCommandContext, message: string, ui: Pick<ActionUi, "notify">): Promise<void> {
  const current = await inspectEntry(manager, storageDirectory, id, context);
  if (current.entry.status.state !== "running") throw new Error(`Subagent ${id} is no longer running`);
  await manager.steer({ id, message }, managerContext(context));
  ui.notify(`Steered subagent ${id}.`, "info");
}
/** What the picker does next: inspect the run again, go back to the list once it is gone, or show the new run of a Retry. */
type ActionOutcome = "stay" | "deleted" | { readonly retryId: string };
export async function performAction(manager: SubagentManager, storageDirectory: string, id: string, action: string, context: ExtensionCommandContext, ui: SubagentActionUi, clipboard: (value: string) => Promise<void>): Promise<ActionOutcome> {
  const fresh = await inspectEntry(manager, storageDirectory, id, context);
  const available = actionOptions(manager, fresh, context, ui);
  if (!available.includes(action)) throw new Error(`Action ${action} is no longer available`);
  const actionContext = standaloneActionContext(manager, fresh, ui);
  const registered = actionContext === undefined ? undefined : visibleStandaloneAgentAttemptActions(loadingRegistry().agentAttemptActions(), actionContext).find(([, candidate]) => candidate.label === action);
  if (registered) {
    if (!actionContext || registered[1].runStandalone === undefined) throw new Error(`Action ${action} has no standalone implementation`);
    await registered[1].runStandalone(actionContext);
    return "stay";
  }
  if (action === "Copy agent ID") { await clipboard(fresh.entry.status.id); ui.notify("Copied agent ID.", "info"); return "stay"; }
  if (action === "Copy run path") { await clipboard(join(storageDirectory, fresh.entry.status.id)); ui.notify("Copied run path.", "info"); return "stay"; }
  if (action === "Delete" && manager.delete !== undefined) {
    if (!await ui.confirm("Delete subagent?", `Delete ${entryName(fresh.entry)} (${fresh.entry.status.id}) and its record? This cannot be undone.`)) return "stay";
    await manager.delete({ id: fresh.entry.status.id }, managerContext(context));
    ui.notify(`Deleted subagent ${fresh.entry.status.id}.`, "info");
    return "deleted";
  }
  if (action === "Copy branch" && fresh.entry.status.worktree) { await clipboard(fresh.entry.status.worktree.branch); ui.notify("Copied branch.", "info"); return "stay"; }
  if (action === "Copy worktree path" && fresh.entry.status.worktree) { await clipboard(fresh.entry.status.worktree.path); ui.notify("Copied worktree path.", "info"); return "stay"; }
  if (action === "Open prompt in editor" && fresh.entry.request?.prompt !== undefined) { await ui.openArtifact(workflowPromptArtifact(fresh.entry.request.prompt), "agent prompt"); return "stay"; }
  if (action === "Open system prompt in editor") { const systemPrompt = liveSystemPrompt(manager, fresh.entry.status); if (systemPrompt !== undefined) { await ui.openArtifact(workflowPromptArtifact(systemPrompt), "agent system prompt"); return "stay"; } }
  if (action === "Open result in editor" && Object.prototype.hasOwnProperty.call(fresh.record, "value") && jsonValue(fresh.record.value)) { await ui.openArtifact(workflowResultArtifact(fresh.record.value), "agent result"); return "stay"; }
  if (action === "Steer") {
    const message = await ui.editText("Steer subagent");
    if (message === undefined) return "stay";
    await steerSubagent(manager, storageDirectory, id, context, message, ui);
    return "stay";
  }
  if (action === "Stop") {
    if (!await ui.confirm("Stop subagent?", `Stop subagent ${entryName(fresh.entry)} (${fresh.entry.status.id})? This cannot be undone.`)) return "stay";
    const current = await inspectEntry(manager, storageDirectory, id, context);
    if (current.entry.status.state !== "running") throw new Error(`Subagent ${id} is no longer running`);
    await manager.stop({ id }, managerContext(context));
    ui.notify(`Stopped subagent ${id}.`, "info");
    return "stay";
  }
  if (action === "Retry") {
    const current = await inspectEntry(manager, storageDirectory, id, context);
    if (current.entry.status.state !== "failed" && current.entry.status.state !== "stopped") throw new Error(`Subagent ${id} is no longer retryable`);
    const result = retryResult(await manager.retry({ id }, managerContext(context, false)));
    if (!result) throw new Error("Retry returned an invalid subagent result");
    ui.notify(`Retried subagent ${id} as ${result.id}.`, "info");
    return { retryId: result.id };
  }
  return "stay";
}

interface SubagentActionDependencies {
  readonly manager: SubagentManager;
  readonly storageDirectory: string;
  readonly clipboard: (value: string) => Promise<void>;
}
/** Run inside the /agents workspace: the copies and the external editors. */
const IN_PLACE: ReadonlySet<string> = new Set(["Copy run path", "Copy agent ID", "Copy branch", "Copy worktree path", "Open prompt in editor", "Open system prompt in editor", "Open result in editor"]);
/** Listing asks nobody: a registered action's visibility sees this ui, and the action itself gets the ActionUi of its run. */
const LISTING_UI: AgentAttemptActionUi = { notify() {}, confirm: async () => false, select: async () => undefined, input: async () => undefined };

/** The actions of a subagent (today's /subagents menu without Back) and of the Subagents group (the bulk deletions). */
export function createSubagentActionProvider({ manager, storageDirectory, clipboard }: SubagentActionDependencies, context: ExtensionCommandContext): AgentsActionProvider {
  const labels = async (target: AgentsActionTarget): Promise<string[]> => {
    if (target.kind === "subagents") return bulkDeleteLabels(manager, await loadEntries(manager, storageDirectory, context));
    if (target.kind !== "subagent") return [];
    const options = actionOptions(manager, await inspectEntry(manager, storageDirectory, target.id, context), context, LISTING_UI);
    return options.filter((label) => label !== "Back");
  };
  return {
    async actions(target) {
      return (await labels(target)).map((label): AgentsAction => IN_PLACE.has(label) ? { label, inPlace: true } : { label });
    },
    async run(target, label, ui) {
      try {
        if (!(await labels(target)).includes(label)) throw new Error(`Action ${label} is no longer available`);
        if (target.kind === "subagent") {
          const outcome = await performAction(manager, storageDirectory, target.id, label, context, ui, clipboard);
          return typeof outcome === "object" ? { select: `subagent:${outcome.retryId}` } : {};
        }
        // Only the group is left: labels() offers it the bulk deletions alone.
        const state = BULK_DELETE[label];
        if (state !== undefined) await deleteAll(manager, storageDirectory, context, state, ui);
      } catch (error) {
        ui.notify(`Cannot ${label.toLowerCase()}: ${errorText(error)}`, "warning");
      }
      return {};
    },
  };
}

type Request = Awaited<ReturnType<typeof loadRequest>>;
/** The request labels read so far, kept across presenters (each /agents refresh builds a new one) per manager and storage. */
const REQUEST_CACHES = new WeakMap<object, Map<string, Map<string, Request>>>();
function requestCache(manager: object, storageDirectory: string): Map<string, Request> {
  const byStorage = REQUEST_CACHES.get(manager) ?? new Map<string, Map<string, Request>>();
  REQUEST_CACHES.set(manager, byStorage);
  const cache = byStorage.get(storageDirectory) ?? new Map<string, Request>();
  byStorage.set(storageDirectory, cache);
  return cache;
}

/** The /subagents list names and detail rows of the subagents it can read. */
export function createSubagentPresenter({ manager, storageDirectory }: Omit<SubagentActionDependencies, "clipboard">, context: ExtensionCommandContext): SubagentPresenter {
  const cache = requestCache(manager, storageDirectory);
  const entryOf = (status: SubagentStatus, request: Request): NavigatorEntry => ({ status, ...(request.request === undefined ? {} : { request: request.request }), ...(request.error === undefined ? {} : { requestError: request.error }) });
  return {
    async describe(ids) {
      const results = await Promise.allSettled(ids.map((id) => inspectEntry(manager, storageDirectory, id, context)));
      // The session's subagents as the list has them, for twin names and for the status of one that cannot be inspected.
      //NOTE: when the list cannot be read either, names are among the inspected ones and an uninspectable one is left out.
      const sessionId = context.sessionManager.getSessionId();
      // Each refresh lists the session once more, for twin names among all of its subagents.
      // A failed listing stays undefined, apart from a successful one that is empty.
      const listed: readonly unknown[] | undefined = await manager.inspect({}, managerContext(context)).then((value): readonly unknown[] => Array.isArray(value) ? value as unknown[] : [], (): undefined => undefined);
      const statuses = (listed ?? []).flatMap((candidate) => { const status = statusValue(candidate); return status && status.sessionId === sessionId ? [status] : []; });
      // Forget the requests of subagents the list no longer has.
      if (listed !== undefined) for (const id of [...cache.keys()]) if (!statuses.some((status) => status.id === id)) cache.delete(id);
      const inspected = new Map<string, Inspection>();
      ids.forEach((id, index) => { const result = results[index]; if (result?.status === "fulfilled" && result.value.entry.status.sessionId === sessionId && result.value.entry.status.id === id) inspected.set(id, result.value); });
      const entries: NavigatorEntry[] = [...inspected.values()].map(({ entry }) => entry);
      const failed = new Map<string, Inspection>();
      const uninspected = statuses.filter((status) => !inspected.has(status.id));
      // Only the labels read cleanly are kept: a read that failed is tried again on the next refresh.
      const requests = await Promise.all(uninspected.map(async (status): Promise<Request> => {
        const known = cache.get(status.id);
        if (known !== undefined) return known;
        const loaded = await loadRequest(storageDirectory, status.id);
        if (loaded.error === undefined) cache.set(status.id, loaded);
        return loaded;
      }));
      uninspected.forEach((status, index) => {
        const entry = entryOf(status, requests[index] ?? {});
        entries.push(entry);
        if (ids.includes(status.id)) failed.set(status.id, { entry, record: {} });
      });
      const names = new Map(listNames(entries).map((name, index) => [entries[index]?.status.id ?? "", name]));
      return new Map(ids.flatMap((id): [string, SubagentPresentation][] => {
        const inspection = inspected.get(id) ?? failed.get(id);
        return inspection === undefined ? [] : [[id, { name: names.get(id) ?? "", details: (styles, now) => detailRows(inspection, styles, now) }]];
      }));
    },
  };
}

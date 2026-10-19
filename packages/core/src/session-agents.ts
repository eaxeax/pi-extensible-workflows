import { stat } from "node:fs/promises";
import { join } from "node:path";
import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import type { SubagentManager, SubagentManagerContext, SubagentStatus } from "../subagents/src/contracts.js";
import { attemptValue, safeSubagentId, statusValue } from "../subagents/src/decode.js";
import type { AgentsActionTarget, SubagentPresentation, SubagentPresenter } from "./agents-actions-contract.js";
import type { SessionAgent, SessionAgentsSource, SessionTreeNode } from "./agents-workspace-contract.js";
import { formatAgentsTimeline, type AgentsTimelineEntry } from "./agents-timeline.js";
import { worktreeChanges, type WorktreeChanges } from "./agent-worktree.js";
import { agentLastActivity, agentSilentFor, STALL_MS } from "./agent-activity.js";
import { formatCost, formatTokens } from "./background-widget.js";
import { buildWorkflowPhaseModel, buildWorkflowPhaseTree, workflowPhaseTreeInitialExpanded, workflowPhaseTreeVisibleNodes, type WorkflowPhaseTreeNode } from "./host-phases.js";
import { agentActivityLabel, formatWorkflowNodeDetails, formatWorkflowRuntime, formatWorkflowTreeLine, navigatorAttentionSort, navigatorAttentionSortByState, progressStyleForState, runStateGlyph, type WorkflowProgressStyles } from "./host-view.js";
import { sameFilesystemPath } from "./paths.js";
import { listRunIds, RunStore, type PersistedRun, type WorktreeReference } from "./persistence.js";
import { isHardTerminalRunState, SETTLED_AGENT_STATES, type AgentAccounting, type AgentAttemptError, type AgentAttemptSummary, type AgentRecord, type LaunchSnapshot, type ModelSpec, type WorkflowAgentSession } from "./types.js";
import { budgetUsage } from "./budget.js";
import { errorText, isObject, sanitizeDisplayText } from "./utils.js";

export interface SessionAgentsDependencies {
  readonly home: string | undefined;
  /** The host's live view of a run (activity, in-flight tools) over its persisted state. */
  overlayRun(run: PersistedRun): PersistedRun;
  /** The in-process session of a workflow agent, whatever attempt it runs. */
  liveAgent(runId: string, agentId: string): WorkflowAgentSession | undefined;
  subagents(): SubagentManager | undefined;
  /** Names and details of the subagents, from the subagents extension when it publishes them. */
  readonly subagentPresenter?: () => SubagentPresenter | undefined;
}

/** What a source lists: /agents both, /workflow its runs, /subagents its group. */
export type SessionAgentsScope = "all" | "workflows" | "subagents";

/** The order of the /subagents dashboard (subagents/src/navigator.ts). */
const SUBAGENT_ATTENTION_ORDER: Readonly<Record<SubagentStatus["state"], number>> = { running: 0, failed: 1, stopped: 2, completed: 3 };

/** The /subagents dashboard's manager context; per-agent inspections carry the attempt metadata and live activity. */
function managerContext(context: ExtensionCommandContext, includeAttemptMetadata: boolean): SubagentManagerContext {
  return { toolCallId: "agents-command", signal: undefined, onUpdate: undefined, ...(includeAttemptMetadata ? { includeAttemptMetadata: true, includeActivity: true } : {}), extensionContext: context };
}
function latestAttempt(attempts: readonly AgentAttemptSummary[] | undefined): AgentAttemptSummary | undefined {
  return (attempts ?? []).reduce<AgentAttemptSummary | undefined>((latest, candidate) => !latest || candidate.attempt > latest.attempt ? candidate : latest, undefined);
}
/** The in-process session, only when it runs `attempt` (same transport and session id). */
function attemptLiveSession(session: WorkflowAgentSession | undefined, attempt: AgentAttemptSummary | undefined): WorkflowAgentSession | undefined {
  const reference = attempt?.session;
  return session && reference && session.reference.transport === reference.transport && session.reference.sessionId === reference.sessionId ? session : undefined;
}
/** "<model>[:thinking] <tokens> <cost>", as the dashboards' transcript titles show it. */
function agentSummary(model: ModelSpec | undefined, accounting: AgentAccounting | undefined): string {
  return sanitizeDisplayText([
    model === undefined ? "" : `${model.model}${model.thinking ? `:${model.thinking}` : ""}`,
    formatTokens(accounting === undefined ? undefined : accounting.input + accounting.output),
    formatCost(accounting?.cost),
  ].filter(Boolean).join(" "));
}
function activityLabel(running: boolean, agent: Parameters<typeof agentActivityLabel>[0] | undefined): string | undefined {
  return running && agent !== undefined ? agentActivityLabel(agent) || undefined : undefined;
}
function lastActivity(at: number | undefined): { readonly lastActivityAt?: number } { return at === undefined ? {} : { lastActivityAt: at }; }
/** An agent id as the last part of its key: one that starts like a tree node's part ("node:") or like this escape ("~") gets a "~" first, so no agent key equals a node key and no two ids share a key. */
function agentKeyPart(id: string): string { return id.startsWith("node:") || id.startsWith("~") ? `~${id}` : id; }
/** The tree kind of each /workflow tree node kind. */
const RUN_NODE_KIND: Readonly<Record<WorkflowPhaseTreeNode["kind"], SessionTreeNode["kind"]>> = { workflow: "run", phase: "phase", operation: "operation", shell: "shell", agent: "agent" };
/** The width the details' timeline is drawn at; the pane wraps what is wider. */
const TIMELINE_WIDTH = 64;
/** The timeline rows of workflow agents under their phase names. */
function agentTimeline(agents: readonly { readonly group?: string; readonly agent: AgentRecord }[], styles: WorkflowProgressStyles, now: number): string[] {
  const entries: AgentsTimelineEntry[] = agents.map(({ group, agent }) => ({
    label: agent.label ?? agent.name, ...(group === undefined ? {} : { group }),
    startedAt: agent.startedAt,
    endedAt: agent.startedAt === undefined || agent.durationMs === undefined || !SETTLED_AGENT_STATES.has(agent.state) ? undefined : agent.startedAt + agent.durationMs,
    state: agent.state,
  }));
  return entries.length === 0 ? [] : formatAgentsTimeline(entries, now, TIMELINE_WIDTH, styles);
}
/** The title row of a node: its label and state. */
function nodeTitle(label: string, state: string, styles: WorkflowProgressStyles): string {
  return `${styles.bold(label)} ${progressStyleForState(state, styles)(state)}`;
}
function displayError(error: AgentAttemptError): AgentAttemptError { return { code: sanitizeDisplayText(error.code), message: sanitizeDisplayText(error.message) }; }
/** The strings an agent's /workflow details show, as display text; its states and numbers stay as they are. */
function displayAgent(agent: AgentRecord): AgentRecord {
  return {
    ...agent,
    model: { ...agent.model, provider: sanitizeDisplayText(agent.model.provider), model: sanitizeDisplayText(agent.model.model) },
    tools: agent.tools.map(sanitizeDisplayText),
    ...(agent.structuralPath ? { structuralPath: agent.structuralPath.map(sanitizeDisplayText) } : {}),
    ...(agent.activity ? { activity: { ...agent.activity, text: sanitizeDisplayText(agent.activity.text) } } : {}),
    ...(agent.attemptDetails ? { attemptDetails: agent.attemptDetails.map((attempt) => attempt.error ? { ...attempt, error: displayError(attempt.error) } : attempt) } : {}),
  };
}
/** The text a /workflow tree node shows, as display text; its id, and so its key, stays the run's own. */
function displayNode(node: WorkflowPhaseTreeNode): WorkflowPhaseTreeNode {
  return { ...node, label: sanitizeDisplayText(node.label), phaseId: sanitizeDisplayText(node.phaseId), operationPath: node.operationPath.map(sanitizeDisplayText), ...(node.phase ? { phase: { ...node.phase, name: sanitizeDisplayText(node.phase.name) } } : {}), ...(node.agent ? { agent: displayAgent(node.agent) } : {}) };
}
/** The /subagents dashboard's header counts (headerRows in subagents/src/navigator.ts): the count of each state and the total cost. */
function subagentsCounts(statuses: readonly SubagentStatus[]): string {
  const counts = (["running", "failed", "stopped", "completed"] as const).flatMap((state) => {
    const count = statuses.filter((status) => status.state === state).length;
    return count ? [`${String(count)} ${state}`] : [];
  });
  const cost = formatCost(statuses.reduce((sum, status) => sum + (status.progress?.accounting.cost ?? 0), 0));
  return [...counts, ...(cost ? [cost] : [])].join(" · ");
}
/** A run's styled state glyph, its done/total agents, their cost and its runtime, short enough for the sidebar. */
function runSummary(run: PersistedRun, styles: WorkflowProgressStyles): string {
  const done = run.agents.filter((agent) => SETTLED_AGENT_STATES.has(agent.state)).length;
  const cost = formatCost(run.agents.reduce((sum, agent) => sum + (agent.accounting?.cost ?? 0), 0));
  return [progressStyleForState(run.state, styles)(runStateGlyph(run.state, "⠦")), `${String(done)}/${String(run.agents.length)}`, cost, run.usage && (run.state !== "running" || run.usage.durationMs >= 1000) ? formatWorkflowRuntime(run.usage.durationMs) : ""].filter(Boolean).join(" ");
}
/** The row of a run root or the group: arrow and ▾/▸ in the columns of a depth-0 /workflow row, the bold label, two spaces, the summary. */
function headerLine(label: string, summary: string, selected: boolean, expanded: boolean, expandable: boolean, styles: WorkflowProgressStyles): string {
  return `${selected ? "→" : " "} ${expandable ? expanded ? "▾" : "▸" : " "} ${styles.bold(label)}  ${summary}`;
}

/** The sidebar's whole minutes of silence, as "4m". */
function formatMinutes(ms: number): string { return `${String(Math.floor(ms / 60_000))}m`; }
/** The row mark of a quiet or stalled agent. */
function silenceMark(silence: Silence): string { return `  ⚠ ${silence.kind} ${formatMinutes(silence.ms)}`; }
/** The Subagents group when the manager cannot list: its details say why, and it has no children. */
function unavailableGroup(reason: string): SessionTreeNode {
  const text = `subagents unavailable: ${sanitizeDisplayText(reason)}`;
  return {
    key: "subagents", parentKey: undefined, depth: 0, kind: "group", initiallyExpanded: false,
    line: (styles, selected, expanded) => headerLine("Subagents", styles.warning("unavailable"), selected, expanded, false, styles),
    details: (styles) => [styles.bold(styles.accent("Subagents")), text],
    title: (styles) => nodeTitle("Subagents", "failed", styles),
    agent: undefined,
    target: { kind: "subagents" },
  };
}

/** The least time between two git reads of one worktree. */
const WORKTREE_REFRESH_MS = 5000;
type WorktreeEntry = { changes: WorktreeChanges | undefined; startedAt: number; reading: boolean };
/** The rows of an agent's worktree in its details: branch, path, then the changes once git has answered. Git runs without blocking, at most once per WORKTREE_REFRESH_MS per worktree; the workspace's next redraw shows its answer. */
function worktreeRows(reference: WorktreeReference, cache: Map<string, WorktreeEntry>, styles: WorkflowProgressStyles, now: number): string[] {
  const key = JSON.stringify([reference.path, reference.base]);
  let entry = cache.get(key);
  if (entry === undefined) { entry = { changes: undefined, startedAt: Number.NEGATIVE_INFINITY, reading: false }; cache.set(key, entry); }
  if (!entry.reading && now - entry.startedAt >= WORKTREE_REFRESH_MS) {
    const current = entry;
    current.reading = true;
    current.startedAt = now;
    void worktreeChanges(reference).then((changes) => { current.changes = changes; }, (error: unknown) => { current.changes = { error: errorText(error) }; }).finally(() => { current.reading = false; });
  }
  const changes = entry.changes;
  const rows = [`branch: ${sanitizeDisplayText(reference.branch)}`, `path: ${sanitizeDisplayText(reference.path)}`];
  if (changes === undefined) return [...rows, "worktree: reading…"];
  if ("removed" in changes) return [...rows, "worktree removed"];
  if ("error" in changes) return [...rows, styles.warning(`worktree unavailable: ${sanitizeDisplayText(changes.error)}`)];
  return [...rows, ...changes.stat.map(sanitizeDisplayText), ...(changes.uncommitted ? ["uncommitted changes"] : [])];
}

/** A run's state.json and journal.json identity (modification time, size, inode): equal stamps mean neither was written again. */
async function stateStamp(directory: string): Promise<string | undefined> {
  const infos = await Promise.all(["state.json", "journal.json"].map((name) => stat(join(directory, name)).catch(() => undefined)));
  return infos[0] === undefined ? undefined : infos.map((info) => info === undefined ? "-" : `${String(info.mtimeMs)}:${String(info.size)}:${String(info.ino)}`).join("|");
}

/** Whether summary.json is written no earlier than state.json and journal.json: only then does the summary hold the time the run settled. */
async function summaryIsFresh(directory: string): Promise<boolean> {
  const times = await Promise.all(["summary.json", "state.json", "journal.json"].map(async (name) => (await stat(join(directory, name))).mtimeMs)).catch(() => undefined);
  return times !== undefined && times[0] !== undefined && times[0] >= Math.max(times[1] ?? 0, times[2] ?? 0);
}

/** How long a running workflow agent has been silent, when it is quiet or stalled. */
type Silence = { readonly kind: "quiet" | "stalled"; readonly ms: number };

export function createSessionAgentsSource(context: ExtensionCommandContext, deps: SessionAgentsDependencies, scope: SessionAgentsScope = "all"): SessionAgentsSource {
  const worktreeCache = new Map<string, WorktreeEntry>();
  /** Runs that have reached a terminal state: their snapshot, summary and worktrees are read once. */
  const settled = new Map<string, { stamp: string | undefined; loaded: { run: PersistedRun; snapshot: Readonly<LaunchSnapshot>; waitingFor: string | undefined; worktrees: readonly WorktreeReference[] }; resolvedAt: number | undefined }>();
  const runAgent = (run: PersistedRun, agent: AgentRecord, cache: Map<string, number | undefined>): SessionAgent => {
    const attempt = latestAttempt(agent.attemptDetails);
    const running = !SETTLED_AGENT_STATES.has(agent.state);
    return {
      key: `run:${run.id}:${agentKeyPart(agent.id)}`,
      name: sanitizeDisplayText(agent.label ?? agent.name),
      state: agent.state,
      summary: agentSummary(agent.model, agent.accounting),
      cwd: attempt?.setup.cwd ?? context.cwd,
      attempt: attempt?.attempt,
      // The run comes from this Pi session's RunStore, so its owner is confirmed; the reader checks the file.
      owned: true,
      session: attempt?.session,
      live: attemptLiveSession(deps.liveAgent(run.id, agent.id), attempt),
      activity: activityLabel(running, agent),
      running,
      ...(agent.accounting === undefined ? {} : { tokens: agent.accounting.input + agent.accounting.output, cost: agent.accounting.cost }),
      ...lastActivity(agentLastActivity(agent, cache)),
    };
  };
  /** The run's /workflow tree, every node in the order /workflow draws them, under a header row for the run. */
  const runNodes = (run: PersistedRun, snapshot: Readonly<LaunchSnapshot>, waitingFor: string | undefined, worktrees: readonly WorktreeReference[], now: number, cache: Map<string, number | undefined>): SessionTreeNode[] => {
    const model = buildWorkflowPhaseModel(run, snapshot);
    const tree = buildWorkflowPhaseTree(model);
    const expanded = workflowPhaseTreeInitialExpanded(tree);
    const key = (node: WorkflowPhaseTreeNode): string => node.kind === "workflow" ? `run:${run.id}` : node.kind === "agent" && node.agent ? `run:${run.id}:${agentKeyPart(node.agent.id)}` : `run:${run.id}:node:${node.id}`;
    const shownRun = { workflowName: sanitizeDisplayText(run.workflowName), id: sanitizeDisplayText(run.id) };
    const runTarget: AgentsActionTarget = { kind: "run", runId: run.id };
    // Every node expanded: the sidebar order, a parent before its children.
    return workflowPhaseTreeVisibleNodes(tree, new Set(tree.nodes.map(({ id }) => id))).map((node) => {
      const parent = node.parentId === undefined ? undefined : tree.byId.get(node.parentId);
      const root = node.kind === "workflow";
      // Below its header a run's nodes sit one level deeper than in /workflow, where the phases share the root's depth 0.
      const depth = root ? 0 : node.depth + 1;
      // The run root names its run: the sidebar holds several runs, and /workflow's "Workflow" would not tell them apart.
      const shown = root ? { ...displayNode(node), label: `${shownRun.workflowName} ${shownRun.id.slice(0, 8)}` } : { ...displayNode(node), depth };
      const agent = node.kind === "agent" ? node.agent : undefined;
      const silent = agent === undefined ? undefined : agentSilentFor(agent, now, cache);
      const silence: Silence | undefined = silent === undefined ? undefined : { kind: silent >= STALL_MS ? "stalled" : "quiet", ms: silent };
      const needsPerson: SessionTreeNode["needsPerson"] = root
        ? run.state === "awaiting_input" || run.state === "budget_exhausted" ? run.state : undefined
        : agent?.state === "failed" ? "failed" : silence?.kind;
      const waiting = root && run.state === "awaiting_input" ? `  ◆ waiting${waitingFor === undefined ? "" : `: ${sanitizeDisplayText(waitingFor)}`}` : "";
      return {
        key: key(node),
        parentKey: parent && key(parent),
        depth,
        kind: RUN_NODE_KIND[node.kind],
        // A finished run starts collapsed; inside a run the nodes start as in /workflow.
        initiallyExpanded: root ? !isHardTerminalRunState(run.state) : expanded.has(node.id),
        line: (styles, selected, open) => root
          ? `${headerLine(shown.label, runSummary(run, styles), selected, open, node.children.length > 0, styles)}${waiting && styles.warning(waiting)}`
          : `${formatWorkflowTreeLine(shown, selected, open, styles)}${silence === undefined ? "" : silence.kind === "stalled" ? styles.error(silenceMark(silence)) : styles.warning(silenceMark(silence))}`,
        // The base rows of a run node are never empty; asking must not start a git read, which only drawing does.
        hasDetails: () => true,
        details: (styles, now) => {
          const reference = agent?.worktreeOwner === undefined ? undefined : worktrees.find((candidate) => candidate.owner === agent.worktreeOwner);
          const base = [...formatWorkflowNodeDetails(shownRun, tree, shown, styles, now, false), ...(reference === undefined ? [] : ["", ...worktreeRows(reference, worktreeCache, styles, now)])];
          const unassigned = (root || node.kind === "phase" ? model.unassignedAgents ?? [] : []).map((member) => ({ group: "Unassigned", agent: displayAgent(member) }));
          const timeline = !root && node.kind !== "phase" ? [] : root
            ? agentTimeline([...model.phases.flatMap((phase) => phase.agents.map((member) => ({ group: sanitizeDisplayText(`${phase.name}${phase.occurrence > 1 ? ` #${String(phase.occurrence)}` : ""}`), agent: displayAgent(member) }))), ...unassigned], styles, now)
            : agentTimeline(node.phase === undefined ? unassigned.map(({ agent }) => ({ agent })) : node.phase.agents.map((member) => ({ agent: displayAgent(member) })), styles, now);
          return timeline.length === 0 ? base : [...base, "", ...timeline];
        },
        title: (styles) => nodeTitle(shown.label, node.state, styles),
        agent: agent && runAgent(run, agent, cache),
        target: agent ? { kind: "workflow-agent", runId: run.id, agentId: agent.id } : runTarget,
        ...(needsPerson === undefined ? {} : { needsPerson }),
      };
    });
  };
  const workflowNodes = async (now: number, cache: Map<string, number | undefined>): Promise<SessionTreeNode[]> => {
    const sessionId = context.sessionManager.getSessionId();
    // A display refresh: leave the cleanup of abandoned run temps to the /workflow picker.
    const runIds = await listRunIds(context.cwd, sessionId, deps.home, false);
    for (const id of [...settled.keys()]) if (!runIds.includes(id)) settled.delete(id);
    const loaded = await Promise.all(runIds.map(async (runId) => {
      const store = new RunStore(context.cwd, sessionId, runId, deps.home);
      const cached = settled.get(runId);
      // A run that has reached a terminal state is read once and reused while its state.json is unchanged (file metadata):
      // another Pi can resume it, and a changed file is read in full again.
      const stamp = await stateStamp(store.directory);
      if (cached !== undefined) {
        if (stamp !== undefined && stamp === cached.stamp) return { loaded: { ...cached.loaded, run: deps.overlayRun(cached.loaded.run) }, resolvedAt: cached.resolvedAt };
        settled.delete(runId);
      }
      try {
        const { run, snapshot } = await store.load();
        // As the /workflow picker: a settled run sorts by the time it settled.
        const summary = await store.loadSummary().catch(() => undefined);
        const terminalAt = summary?.terminalAt;
        const parsed = terminalAt === undefined ? Number.NaN : Date.parse(terminalAt);
        const resolvedAt = Number.isFinite(parsed) ? parsed : undefined;
        const waitingFor = run.state === "awaiting_input" ? (await store.awaitingCheckpoints().catch(() => []))[0]?.name : undefined;
        const worktrees = await store.recordedWorktrees().catch(() => []);
        const entry = { loaded: { run, snapshot, waitingFor, worktrees }, resolvedAt };
        if (isHardTerminalRunState(run.state) && await summaryIsFresh(store.directory)) settled.set(runId, { ...entry, stamp });
        const overlaid = deps.overlayRun(run);
        // A running run records its runtime only when it settles: show the time since it was created.
        const created = summary === undefined ? Number.NaN : Date.parse(summary.createdAt);
        const shown = overlaid.state === "running" && Number.isFinite(created)
          ? { ...overlaid, usage: { ...budgetUsage(overlaid.usage), durationMs: Math.max(overlaid.usage?.durationMs ?? 0, now - created) } }
          : overlaid;
        return { loaded: { ...entry.loaded, run: shown }, resolvedAt };
      } catch { return undefined; }
    }));
    return navigatorAttentionSort(loaded.filter((entry) => entry !== undefined)).flatMap(({ loaded: { run, snapshot, waitingFor, worktrees } }) => runNodes(run, snapshot, waitingFor, worktrees, now, cache));
  };
  /** The row of the listed subagent `id`: its key, name and target address that id; `status` gives its state and attempt. */
  const subagent = (manager: SubagentManager, id: string, status: SubagentStatus, owned: boolean, presentation: SubagentPresentation | undefined): SessionTreeNode => {
    const liveData = manager.getAttemptActionData?.(id);
    const attempt = attemptValue(liveData?.attempt) ?? latestAttempt(status.attemptDetails);
    const running = status.state === "running";
    // The label lives in the run's request.json under the manager's storage directory: only the subagents extension's presenter reads it.
    // A presentation name that is blank after sanitizing (empty, controls, whitespace or an escape only) keeps the short id, as /subagents does with a blank label.
    const name = sanitizeDisplayText(presentation?.name ?? "").trim() || sanitizeDisplayText(id.length > 12 ? id.slice(0, 8) : id);
    const agent: SessionAgent = {
      key: `subagent:${id}`,
      name,
      state: status.state,
      summary: agentSummary(status.progress?.state?.model ?? attempt?.setup.model, status.progress?.accounting),
      cwd: attempt?.setup.cwd ?? context.cwd,
      attempt: attempt?.attempt,
      owned,
      session: attempt?.session,
      live: owned ? attemptLiveSession(liveData?.liveSession, attempt) : undefined,
      activity: activityLabel(running, status.progress),
      running,
      ...(status.progress === undefined ? {} : { tokens: status.progress.accounting.input + status.progress.accounting.output, cost: status.progress.accounting.cost, ...lastActivity(status.progress.lastEventAt) }),
    };
    return {
      key: agent.key,
      parentKey: "subagents",
      depth: 1,
      kind: "agent",
      initiallyExpanded: false,
      // The /subagents list row, one level down.
      line: (styles, selected, expanded) => formatWorkflowTreeLine({ kind: "agent", label: name, depth: 1, state: status.state, children: [] }, selected, expanded, styles),
      details: (styles, now) => {
        // A presenter that throws while drawing must not break the pane.
        try { return presentation?.details(styles, now) ?? []; } catch { return []; }
      },
      title: (styles) => nodeTitle(name, status.state, styles),
      agent,
      target: { kind: "subagent", id },
      ...(status.state === "failed" ? { needsPerson: "failed" as const } : {}),
    };
  };
  const subagentNodes = async (): Promise<SessionTreeNode[]> => {
    const manager = deps.subagents();
    if (manager === undefined) return [];
    const sessionId = context.sessionManager.getSessionId();
    let listed: unknown;
    try { listed = await manager.inspect({}, managerContext(context, false)); } catch (error) { return [unavailableGroup(errorText(error))]; }
    if (!Array.isArray(listed)) return [];
    const statuses = listed.map((value) => statusValue(value)).filter((status): status is SubagentStatus => status?.sessionId === sessionId);
    const entries = await Promise.all(statuses.map(async (row) => {
      const record = await manager.inspect({ id: row.id }, managerContext(context, true)).catch(() => undefined);
      // An inspection that names another subagent is dropped, as a failed one: the row keeps the listed id's data and proves no owner.
      const inspected = statusValue(record);
      const own = inspected?.id === row.id ? inspected : undefined;
      // The inspected record, not the list row, proves the owner; the storage directory proves nothing (it may be a custom storageDir).
      const cwd = isObject(record) ? record.cwd : undefined;
      const owned = own !== undefined && own.sessionId === sessionId && safeSubagentId(own.id) && (typeof cwd !== "string" || sameFilesystemPath(cwd, context.cwd));
      return { id: row.id, status: own ?? row, owned };
    }));
    // As /subagents names its rows (loadEntries): every subagent this Pi session lists with a safe id, whatever its
    // inspection shows; owned decides only the transcript and the live stream.
    const requested = new Set(statuses.filter((row) => safeSubagentId(row.id)).map((row) => row.id));
    // Without presentations (no presenter, or a getter or describe() that fails) every subagent keeps its short id.
    const presentations = requested.size > 0 ? await Promise.resolve().then(() => deps.subagentPresenter?.()?.describe([...requested])).catch(() => undefined) : undefined;
    const sorted = navigatorAttentionSortByState(entries, ({ status }) => status.state, ({ status }) => status.finishedAt, SUBAGENT_ATTENTION_ORDER);
    if (sorted.length === 0) return [];
    // Each row is its listed id: its key, name, presentation and target; a presentation for an id not asked for is ignored.
    const children = sorted.map(({ id, status, owned }) => subagent(manager, id, status, owned, requested.has(id) ? presentations?.get(id) : undefined));
    const childNames = children.map((child) => child.agent?.name);
    // The group summarizes its subagents: running while one runs, else failed if one failed, else done.
    const states = sorted.map(({ status }) => status.state);
    const state = states.includes("running") ? "running" : states.includes("failed") ? "failed" : states.every((value) => value === "stopped") ? "stopped" : "completed";
    const counts = subagentsCounts(sorted.map(({ status }) => status));
    const group: SessionTreeNode = {
      key: "subagents",
      parentKey: undefined,
      depth: 0,
      kind: "group",
      // An idle group starts collapsed.
      initiallyExpanded: sorted.some(({ status }) => status.state === "running"),
      line: (styles, selected, expanded) => headerLine("Subagents", counts, selected, expanded, true, styles),
      details: (styles, now) => [styles.bold(styles.accent("Subagents")), counts, "", ...formatAgentsTimeline(
        sorted.map(({ id, status }, index): AgentsTimelineEntry => ({ label: childNames[index] ?? id, startedAt: status.startedAt, endedAt: status.finishedAt, state: status.state })),
        now, TIMELINE_WIDTH, styles)],
      title: (styles) => nodeTitle("Subagents", state, styles),
      agent: undefined,
      target: { kind: "subagents" },
    };
    return [group, ...children];
  };
  return {
    list: async () => {
      const now = Date.now();
      const cache = new Map<string, number | undefined>();
      const [workflows, subagents] = await Promise.all([scope === "subagents" ? [] : workflowNodes(now, cache), scope === "workflows" ? [] : subagentNodes()]);
      return [...workflows, ...subagents];
    },
  };
}

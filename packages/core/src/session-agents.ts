import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import type { SubagentManager, SubagentManagerContext, SubagentStatus } from "../subagents/src/contracts.js";
import { attemptValue, statusValue } from "../subagents/src/decode.js";
import type { AgentsActionTarget, SubagentPresentation, SubagentPresenter } from "./agents-actions-contract.js";
import type { SessionAgent, SessionAgentsSource, SessionTreeNode } from "./agents-workspace-contract.js";
import { formatAgentsTimeline, type AgentsTimelineEntry } from "./agents-timeline.js";
import { agentLastActivity, agentSilentFor, STALL_MS } from "./agent-activity.js";
import { formatCost, formatTokens } from "./background-widget.js";
import { buildWorkflowPhaseModel, buildWorkflowPhaseTree, workflowPhaseTreeInitialExpanded, workflowPhaseTreeVisibleNodes, type WorkflowPhaseTreeNode } from "./host-phases.js";
import { agentActivityLabel, formatWorkflowNodeDetails, formatWorkflowRuntime, formatWorkflowTreeLine, navigatorAttentionSort, navigatorAttentionSortByState, progressStyleForState, runStateGlyph, type WorkflowProgressStyles } from "./host-view.js";
import { sameFilesystemPath } from "./paths.js";
import { listRunIds, RunStore, type PersistedRun } from "./persistence.js";
import { isHardTerminalRunState, SETTLED_AGENT_STATES, type AgentAccounting, type AgentAttemptError, type AgentAttemptSummary, type AgentRecord, type LaunchSnapshot, type ModelSpec, type WorkflowAgentSession } from "./types.js";
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

/** The /subagents dashboard's check before a run's files are read: not the manager's id format, which a custom manager need not share. */
function safeSubagentId(id: string): boolean { return id !== "." && id !== ".." && /^[A-Za-z0-9._-]+$/.test(id); }
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
  return [progressStyleForState(run.state, styles)(runStateGlyph(run.state, "⠦")), `${String(done)}/${String(run.agents.length)}`, cost, run.usage ? formatWorkflowRuntime(run.usage.durationMs) : ""].filter(Boolean).join(" ");
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

/** How long a running workflow agent has been silent, when it is quiet or stalled. */
type Silence = { readonly kind: "quiet" | "stalled"; readonly ms: number };

export function createSessionAgentsSource(context: ExtensionCommandContext, deps: SessionAgentsDependencies, scope: SessionAgentsScope = "all"): SessionAgentsSource {
  const runAgent = (run: PersistedRun, agent: AgentRecord, cache: Map<string, number | undefined>): SessionAgent => {
    const attempt = latestAttempt(agent.attemptDetails);
    const running = !SETTLED_AGENT_STATES.has(agent.state);
    return {
      key: `run:${run.id}:${agent.id}`,
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
  const runNodes = (run: PersistedRun, snapshot: Readonly<LaunchSnapshot>, waitingFor: string | undefined, now: number, cache: Map<string, number | undefined>): SessionTreeNode[] => {
    const model = buildWorkflowPhaseModel(run, snapshot);
    const tree = buildWorkflowPhaseTree(model);
    const expanded = workflowPhaseTreeInitialExpanded(tree);
    const key = (node: WorkflowPhaseTreeNode): string => node.kind === "workflow" ? `run:${run.id}` : node.kind === "agent" && node.agent ? `run:${run.id}:${node.agent.id}` : `run:${run.id}:node:${node.id}`;
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
        details: (styles, now) => {
          const base = formatWorkflowNodeDetails(shownRun, tree, shown, styles, now, false);
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
    const loaded = await Promise.all(runIds.map(async (runId) => {
      const store = new RunStore(context.cwd, sessionId, runId, deps.home);
      try {
        const { run, snapshot } = await store.load();
        // As the /workflow picker: a settled run sorts by the time it settled.
        const terminalAt = (await store.loadSummary().catch(() => undefined))?.terminalAt;
        const resolvedAt = terminalAt === undefined ? undefined : Date.parse(terminalAt);
        const waitingFor = run.state === "awaiting_input" ? (await store.awaitingCheckpoints().catch(() => []))[0]?.name : undefined;
        return { loaded: { run: deps.overlayRun(run), snapshot, waitingFor }, resolvedAt: resolvedAt !== undefined && Number.isFinite(resolvedAt) ? resolvedAt : undefined };
      } catch { return undefined; }
    }));
    return navigatorAttentionSort(loaded.filter((entry) => entry !== undefined)).flatMap(({ loaded: { run, snapshot, waitingFor } }) => runNodes(run, snapshot, waitingFor, now, cache));
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
    const first = sorted[0];
    if (first === undefined) return [];
    // Each row is its listed id: its key, name, presentation and target; a presentation for an id not asked for is ignored.
    const children = sorted.map(({ id, status, owned }) => subagent(manager, id, status, owned, requested.has(id) ? presentations?.get(id) : undefined));
    const childNames = children.map((child) => child.agent?.name);
    // The group takes the state of its first subagent: the one the /subagents order puts first.
    const state = first.status.state;
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

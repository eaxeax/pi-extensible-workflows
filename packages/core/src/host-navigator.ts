import { type ExtensionCommandContext, SettingsManager, truncateToVisualLines, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { ActionUi } from "./agents-actions-contract.js";
import { type PersistedRun } from "./persistence.js";
import { type WorkflowRegistryApi } from "./registry.js";
import { errorText } from "./utils.js";
import { openArtifactInEditor, type WorkflowArtifact } from "./workflow-artifacts.js";
import { agentBreadcrumb, formatNavigatorRun, formatWorkflowPhaseDashboard, navigatorAttentionSort, navigatorRunLabels, SETTLED_AGENT_STATES, themeWorkflowProgressStyles, type WorkflowProgressStyles } from "./host-view.js";
import { buildWorkflowPhaseModel, buildWorkflowPhaseTree, navigateWorkflowPhaseTree, preserveWorkflowPhaseTreeSelection, workflowPhaseTreeInitialExpanded } from "./host-phases.js";
import { type WorkflowRecoveryContext, type createWorkflowRecovery } from "./host-recovery.js";
import { type WorkflowRunRecord } from "./host-runtime.js";
import { getTrajectoryHost, type TrajectoryPublisherProvider } from "./trajectory-host-handle.js";
import { type AgentRecord, type HardTerminalRunState, type JsonValue, type LiveSessionHandoff, type PreparedAgentSession, type WorkflowAgentSession } from "./types.js";
import { agentActionOptions, confirmWithBlocked, deleteBulkRuns, loadWorkflowRunView, loadWorkflowStores, manageAliases, runAgentAction, runWorkflowRunAction, visibleAgentAttemptActions, type ReportBlocked, type WorkflowStoredRun } from "./workflow-actions.js";
import { createPiActionUi, tuiRows, workflowKeyLabel, workflowKeyMatches } from "./pi-action-ui.js";

export { manualDeletionPlan } from "./workflow-actions.js";
export { uiHostCapabilities, workflowKeyLabel, workflowKeyMatches, type UiHostCapabilities } from "./pi-action-ui.js";

const WORKFLOW_PANEL_FOOTER_ROWS = 2;
type WorkflowKeybindings = { matches(data: string, binding: string): boolean };

/**
 * A yes/no question drawn inside a navigator dashboard. Pi's confirm dialog replaces a custom component and afterwards
 * restores the editor rather than the component, which leaves the dashboard's promise pending and the session waiting on it.
 */
export function createInlineConfirm(requestRender: () => void) {
  let pending: { readonly title: string; readonly message: string; yes: boolean; readonly resolve: (value: boolean) => void } | undefined;
  const answer = (value: boolean): void => {
    const current = pending;
    pending = undefined;
    current?.resolve(value);
    requestRender();
  };
  return {
    ask(title: string, message: string): Promise<boolean> {
      answer(false);
      return new Promise<boolean>((resolve) => { pending = { title, message, yes: true, resolve }; requestRender(); });
    },
    active(): boolean { return pending !== undefined; },
    rows(width: number, styles: WorkflowProgressStyles): string[] {
      if (!pending) return [];
      const yes = pending.yes;
      const message = truncateToVisualLines(pending.message, Number.MAX_SAFE_INTEGER, Math.max(1, width), 0).visualLines.map((line) => line.trimEnd());
      return [styles.bold(pending.title), ...message, ...["Yes", "No"].map((option) => (option === "Yes") === yes ? `→ ${styles.accent(option)}` : `  ${option}`)];
    },
    hint(keybindings: unknown): string {
      return `${workflowKeyLabel(keybindings, "tui.select.up", "↑")}/${workflowKeyLabel(keybindings, "tui.select.down", "↓")} select · ${workflowKeyLabel(keybindings, "tui.select.confirm", "enter")} confirm · ${workflowKeyLabel(keybindings, "tui.select.cancel", "esc")} cancel`;
    },
    handleInput(keybindings: WorkflowKeybindings, data: string): void {
      if (!pending) return;
      if (workflowKeyMatches(keybindings, data, "tui.select.up") || workflowKeyMatches(keybindings, data, "tui.select.down")) { pending.yes = !pending.yes; requestRender(); }
      else if (workflowKeyMatches(keybindings, data, "tui.select.confirm")) answer(pending.yes);
      else if (workflowKeyMatches(keybindings, data, "tui.select.cancel")) answer(false);
    },
    cancel(): void { answer(false); },
  };
}

/** Opens the /agents workspace (agents-workspace.ts) with one agent selected: `run:<runId>:<agentId>` or `subagent:<id>`. */
export type OpenAgentsAt = (ctx: ExtensionCommandContext, initialKey: string) => Promise<void>;
const AGENTS_WORKSPACE_KEY = Symbol.for("pi-extensible-workflows.agents-workspace");
const globalAgentsWorkspaces = globalThis as typeof globalThis & Record<symbol, OpenAgentsAt | undefined>;
/** The core host publishes its opener for the /subagents dashboard, which another extension bundle loads with its own copy of this module. */
export function setAgentsWorkspaceOpener(open: OpenAgentsAt | undefined): void { globalAgentsWorkspaces[AGENTS_WORKSPACE_KEY] = open; }
export function getAgentsWorkspaceOpener(): OpenAgentsAt | undefined { return globalAgentsWorkspaces[AGENTS_WORKSPACE_KEY]; }
export type WorkflowNavigatorDependencies = {
  pi: Pick<ExtensionAPI, "registerCommand">;
  home: string | undefined;
  clipboard: (value: string) => Promise<void>;
  extensionAgentDir: string;
  runs: Map<string, WorkflowRunRecord>;
  terminalRunStates: Map<string, HardTerminalRunState>;
  hardTerminalRunStates: ReadonlySet<string>;
  ensureSessionLease: (cwd: string, sessionId: string) => Promise<void>;
  answerCheckpoint: (runId: string, name: string, approved: boolean, silent?: boolean) => Promise<boolean>;
  recovery: ReturnType<typeof createWorkflowRecovery>;
  stopWorkflowRun: (runId: string) => Promise<{ runId: string; state: string; stopped: boolean; reason?: "unknown_run" | "already_terminal" }>;
  moveForegroundToBackground: (runId: string) => Promise<{ runId: string; state: "running"; detached: true }>;
  isForegroundAttached: (runId: string) => boolean;
  liveAgents: {
    get(runId: string, agentId: string): Readonly<{ session?: WorkflowAgentSession; prepared?: Readonly<PreparedAgentSession>; handoff?: LiveSessionHandoff }> | undefined;
    overlay(run: PersistedRun): PersistedRun;
  };
  registry: WorkflowRegistryApi;
  projectTrusted: (context: unknown) => boolean;
  resumeHostContext: (context: unknown) => WorkflowRecoveryContext;
  resumeSelectedWorkflow: (runId: string, foreground: boolean, context: unknown, budgetPatch?: unknown) => Promise<{ workflowName: string; state: "running" | "completed" | "awaiting_approval"; attached: boolean; value?: JsonValue }>;
  reportBlocked?: ReportBlocked;
  setNavigatorOpen?: (open: boolean) => void;
  trajectoryProvider: TrajectoryPublisherProvider;
  coordinateRunMutation?: <T>(task: () => Promise<T>) => Promise<T>;
  /** t and "View transcript" in the dashboard. */
  openAgents: OpenAgentsAt;
};
export function registerWorkflowNavigator(deps: WorkflowNavigatorDependencies): void {
  const { pi, extensionAgentDir, hardTerminalRunStates, ensureSessionLease, projectTrusted, reportBlocked, setNavigatorOpen, trajectoryProvider, openAgents } = deps;
  const command = {
    description: "Open the workflow picker; workflow actions are available contextually",
    handler: async (args, ctx) => {
      const command = args.trim();
      if (command && command !== "trajectory") {
        ctx.ui.notify("Workflow slash commands do not accept arguments. Open the workflow picker with /workflow; actions are available there or through workflow tools.", "warning");
        return;
      }
      if (command === "trajectory") {
        const trajectory = getTrajectoryHost();
        if (!trajectory) {
          ctx.ui.notify("Trajectory is disabled", "warning");
          return;
        }
        await trajectory.open(trajectoryProvider, ctx);
        return;
      }
      await ensureSessionLease(ctx.cwd, ctx.sessionManager.getSessionId());
      const loadStores = (): Promise<WorkflowStoredRun[]> => loadWorkflowStores(deps, ctx, true);
      let stores = await loadStores();
      const ui = createPiActionUi(ctx, { reportBlocked, editorCommand: () => SettingsManager.create(ctx.cwd, extensionAgentDir, { projectTrusted: projectTrusted(ctx) }).getExternalEditorCommand() });
      const setWorkflowStatus = (text: string | undefined) => { ui.status(text); };
      if (!command) {
        for (;;) {
          if (!ctx.hasUI) {
            if (!stores.length) { ctx.ui.notify("No workflow runs in this session. Mutations are available through workflow tools.", "info"); return; }
            const sorted = navigatorAttentionSort(stores);
            const details = await Promise.all(sorted.map(async ({ store, loaded }) => formatNavigatorRun(loaded, await store.awaitingCheckpoints(), await store.worktrees())));
            ctx.ui.notify(`${details.join("\n\n")}\n\nMutations are available through workflow tools.`, "info"); return;
          }
          const sorted = navigatorAttentionSort(stores);
          const labels = navigatorRunLabels(sorted);
          const hasCompleted = sorted.some(({ loaded: { run } }) => run.state === "completed");
          const hasFailed = sorted.some(({ loaded: { run } }) => run.state === "failed");
          const pickerOptions = [...labels, "Model aliases", "Close", ...(hasCompleted ? ["Delete all completed"] : []), ...(hasFailed ? ["Delete all failed"] : [])];
          const runChoice = await ctx.ui.select("Workflows\n", pickerOptions);
          if (!runChoice || runChoice === "Close") return;
          if (runChoice === "Model aliases") { await manageAliases(deps, ctx, ui); stores = await loadStores(); continue; }
          if (runChoice === "Delete all completed") {
            await deleteBulkRuns(deps, ctx, ui, "completed");
            stores = await loadStores();
            continue;
          }
          if (runChoice === "Delete all failed") {
            await deleteBulkRuns(deps, ctx, ui, "failed");
            stores = await loadStores();
            continue;
          }
          const runIndex = labels.indexOf(runChoice);
          if (runIndex < 0) return;
          const selected = sorted[runIndex];
          if (!selected) return;
          const { store } = selected;
          const viewTranscriptOffered = ctx.mode === "tui";
          const loadDashboard = async () => {
            const view = await loadWorkflowRunView(deps, ctx, store);
            return { ...view, dashboard: formatWorkflowPhaseDashboard(view.run, view.snapshot, process.stdout.columns || 80).join("\n"), phaseModel: buildWorkflowPhaseModel(view.run, view.snapshot), agents: view.run.agents, cwd: view.run.cwd };
          };
          const selectAgent = async (dashboard: Awaited<ReturnType<typeof loadDashboard>>): Promise<void> => {
            const byId = new Map(dashboard.agents.map((agent) => [agent.id, agent]));
            const title = (agent: AgentRecord): string => agentBreadcrumb(agent, byId, true);
            const labels = dashboard.agents.map((agent, index) => `#${String(index + 1)} ${title(agent)} [${agent.state}]`);
            const selectedLabel = await ctx.ui.select("Agents", [...labels, "Back"]);
            const selectedIndex = selectedLabel ? labels.indexOf(selectedLabel) : -1;
            const selected = selectedIndex >= 0 ? dashboard.agents[selectedIndex] : undefined;
            if (!selected) return;
            const actions = agentActionOptions(deps, ctx, dashboard, selected, viewTranscriptOffered);
            for (;;) {
              const action = await ctx.ui.select(title(selected), actions);
              if (!action || action === "Back") return;
              const extensionAction = visibleAgentAttemptActions(deps, dashboard, selected).some(([, candidate]) => candidate.label === action);
              await runAgentAction(deps, ui, dashboard, selected, action);
              if (extensionAction) return;
            }
          };
          for (;;) {
            let view = await loadDashboard();
            const actionChoice = ctx.mode === "tui"
              ? await ctx.ui.custom<string | undefined>((tui, theme, keybindings, done) => {
                  let dashboardOffset = 0;
                  let refreshing = false;
                  let disposed = false;
                  let detailsMode = false;
                  let actionMode = false;
                  let actionIndex = 0;
                  let stopRequested = false;
                  let stopStatus: string | undefined;
                  let selectionNeedsScroll = true;
                  let renderedWidth = 80;
                  let refreshGeneration = 0;
                  let frozenAt = Date.now();
                  let previousRunState = view.run.state;
                  let tree = buildWorkflowPhaseTree(view.phaseModel);
                  let selectedNodeId = tree.nodes[0]?.id;
                  let expandedNodeIds = new Set(workflowPhaseTreeInitialExpanded(tree));
                  const terminalRows = () => Math.max(1, tuiRows(tui) - WORKFLOW_PANEL_FOOTER_ROWS);
                  const keyLabel = (binding: string, fallback: string) => workflowKeyLabel(keybindings, binding, fallback);
                  const inlineConfirm = createInlineConfirm(() => { if (!disposed) tui.requestRender(); });
                  const confirmInDashboard = (title: string, message: string): Promise<boolean> => confirmWithBlocked({ confirm: (question, detail) => inlineConfirm.ask(question, detail) }, reportBlocked, title, message);
                  const progressNow = () => {
                    const now = Date.now();
                    if (hardTerminalRunStates.has(view.run.state)) {
                      if (!hardTerminalRunStates.has(previousRunState)) frozenAt = now;
                      previousRunState = view.run.state;
                      return frozenAt;
                    }
                    frozenAt = now;
                    previousRunState = view.run.state;
                    return now;
                  };
                  const selectedAgentRecord = (): AgentRecord | undefined => {
                    const node = selectedNodeId ? tree.byId.get(selectedNodeId) : tree.nodes[0];
                    return node?.kind === "agent" && node.agentId ? view.agents.find((agent) => agent.id === node.agentId) : undefined;
                  };
                  const actionOptions = () => {
                    const agent = selectedAgentRecord();
                    return agent ? agentActionOptions(deps, ctx, view, agent, viewTranscriptOffered) : [...view.actions.keys(), "Back"];
                  };
                  /** t and "View transcript": the /agents workspace opens over Pi on the selected agent; this dashboard is back when it closes. */
                  const viewTranscript = (): void => {
                    const agent = selectedAgentRecord();
                    if (!agent) return;
                    actionMode = false;
                    dashboardOffset = 0;
                    selectionNeedsScroll = true;
                    void openAgents(ctx, `run:${view.run.id}:${agent.id}`).catch((error: unknown) => { ctx.ui.notify(`Cannot open the agents workspace: ${errorText(error)}`, "error"); });
                  };
                  let editorRunning = false;
                  let timer: ReturnType<typeof setInterval> | undefined;
                  const stopTimer = () => {
                    if (timer !== undefined) {
                      clearInterval(timer);
                      timer = undefined;
                    }
                  };
                  /** The in-place actions (copies, editors) use Pi's notices and run the external editor on this dashboard's TUI, one at a time. */
                  const inPlaceUi: ActionUi = {
                    ...ui,
                    async openArtifact(artifact: WorkflowArtifact, label: string): Promise<void> {
                      if (editorRunning) return;
                      editorRunning = true;
                      try {
                        const command = SettingsManager.create(view.cwd, extensionAgentDir, { projectTrusted: projectTrusted(ctx) }).getExternalEditorCommand();
                        await openArtifactInEditor(tui, command, artifact, label, (message, level) => { ctx.ui.notify(message, level); });
                      } catch (error) {
                        ctx.ui.notify(`Cannot open ${label}: ${errorText(error)}`, "warning");
                      } finally {
                        editorRunning = false;
                      }
                    },
                  };
                  const updateDashboard = async () => {
                    const generation = ++refreshGeneration;
                    const hadExpandableNodes = tree.nodes.some((node) => node.children.length > 0);
                    const next = await loadDashboard();
                    if (disposed || generation !== refreshGeneration) return;
                    const previousNodeId = selectedNodeId;
                    const previousExpanded = expandedNodeIds;
                    const selectedAction = actionMode ? actionOptions()[actionIndex] : undefined;
                    view = next;
                    if (hardTerminalRunStates.has(next.run.state) && next.run.agents.every((agent) => SETTLED_AGENT_STATES.has(agent.state))) stopTimer();
                    tree = buildWorkflowPhaseTree(view.phaseModel);
                    selectedNodeId = preserveWorkflowPhaseTreeSelection(tree, { nodeId: previousNodeId }).nodeId;
                    expandedNodeIds = new Set([...previousExpanded].filter((id) => tree.byId.has(id)));
                    if (!hadExpandableNodes && !expandedNodeIds.size && tree.nodes.some((node) => node.children.length > 0)) expandedNodeIds = new Set(workflowPhaseTreeInitialExpanded(tree));
                    const nextActions = actionOptions();
                    const preservedActionIndex = selectedAction ? nextActions.indexOf(selectedAction) : -1;
                    actionIndex = preservedActionIndex >= 0 ? preservedActionIndex : selectedAction ? nextActions.length - 1 : Math.min(actionIndex, Math.max(0, nextActions.length - 1));
                    selectionNeedsScroll = true;
                    tui.requestRender();
                  };
                  const requestStop = () => {
                    if (stopRequested) return;
                    stopRequested = true;
                    stopStatus = undefined;
                    setWorkflowStatus(undefined);
                    /** Stop confirms inside the dashboard and shows its progress above the tree and in Pi's status. */
                    const stopUi: ActionUi = {
                      ...ui,
                      confirm: confirmInDashboard,
                      status(status) {
                        stopStatus = status;
                        setWorkflowStatus(status);
                        if (!disposed) tui.requestRender();
                      },
                    };
                    void runWorkflowRunAction(deps, ctx, stopUi, view, "Stop").then(async (outcome) => {
                      if (outcome === "stopped") { done("__stopped__"); return; }
                      await updateDashboard();
                    }).catch((error: unknown) => {
                      if (disposed) return;
                      stopStatus = `Could not stop workflow ${store.runId}: ${errorText(error)}`;
                      setWorkflowStatus(stopStatus);
                      tui.requestRender();
                    }).finally(() => {
                      stopRequested = false;
                      if (!disposed) tui.requestRender();
                    });
                  };
                  timer = setInterval(() => {
                    if (refreshing || stopRequested) return;
                    refreshing = true;
                    //NOTE: background dashboard refresh self-heals next tick; swallow so a transient render/read error surfaces as an unhandled rejection instead of refreshing state.
                    void updateDashboard().catch(() => undefined).finally(() => { refreshing = false; });
                  }, 1000);
                  timer.unref();
                  if (hardTerminalRunStates.has(view.run.state) && view.run.agents.every((agent) => SETTLED_AGENT_STATES.has(agent.state))) stopTimer();
                  return {
                    render(width: number) {
                      renderedWidth = width;
                      const narrow = width < 80;
                      const styles = themeWorkflowProgressStyles(theme);
                      const agent = selectedAgentRecord();
                      const actions = actionMode ? { title: agent ? "Agent actions" : "Run actions", options: actionOptions(), index: actionIndex } : undefined;
                      const formatPhaseLines = (scrollTop: number): string[] => formatWorkflowPhaseDashboard(view.run, view.snapshot, width, { scrollTop, nodeId: selectedNodeId, expandedNodeIds: [...expandedNodeIds], ...(narrow && !detailsMode && !actionMode ? { treeOnly: true } : {}), ...(narrow && (detailsMode || actionMode) ? { detailsOnly: true } : {}), ...(actions ? { actions } : {}) }, styles, progressNow());
                      const phaseLines = formatPhaseLines(0);
                      const statusLines = stopStatus ? truncateToVisualLines(styles.error(stopStatus), Number.MAX_SAFE_INTEGER, width, 0).visualLines.map((line) => line.trimEnd()) : [];
                      let content = [...statusLines, ...phaseLines];
                      const rows = terminalRows();
                      const hintRows = rows >= 3 ? 1 : 0;
                      const confirmRows = inlineConfirm.rows(width, styles);
                      const viewport = Math.max(1, rows - hintRows - confirmRows.length);
                      const maxOffset = Math.max(0, content.length - viewport);
                      dashboardOffset = Math.max(0, Math.min(maxOffset, dashboardOffset));
                      if (actionMode) {
                        // Options are looked up below the menu title, so a tree or detail line with the same text does not count.
                        const titleRow = actions ? content.findIndex((line) => line.includes(actions.title)) : -1;
                        const rowBelow = (text: string | undefined, above: number): number => text === undefined ? -1 : content.findIndex((line, index) => index > above && line.includes(text));
                        const actionRow = rowBelow(actions?.options[actionIndex], titleRow);
                        const lastRow = titleRow >= 0 && actionRow >= 0 ? rowBelow(actions?.options.at(-1), actionRow - 1) : -1;
                        // A menu that fits stays whole in view, so the actions below the selected one remain visible; a longer one follows the selection.
                        const [top, bottom] = lastRow >= 0 && lastRow - titleRow < viewport ? [titleRow, lastRow] : [actionRow, actionRow];
                        if (top >= 0) {
                          if (top < dashboardOffset) dashboardOffset = top;
                          else if (bottom >= dashboardOffset + viewport) dashboardOffset = bottom - viewport + 1;
                        }
                      } else if (!detailsMode && selectionNeedsScroll) {
                        const selectedRow = content.findIndex((line) => line.startsWith("→"));
                        if (selectedRow >= 0) {
                          if (selectedRow < dashboardOffset) dashboardOffset = selectedRow;
                          else if (selectedRow >= dashboardOffset + viewport) dashboardOffset = selectedRow - viewport + 1;
                        }
                        selectionNeedsScroll = false;
                      }
                      dashboardOffset = Math.max(0, Math.min(maxOffset, dashboardOffset));
                      if (!narrow && !actionMode) content = [...statusLines, ...formatPhaseLines(Math.max(0, dashboardOffset - statusLines.length))];
                      const selectedNode = selectedNodeId ? tree.byId.get(selectedNodeId) : undefined;
                      const enterAction = selectedNode?.kind === "workflow" ? "run actions" : selectedNode?.kind === "agent" ? "agent actions" : selectedNode?.children.length ? "expand/collapse" : narrow ? "inspect" : "focus details";
                      const hint = truncateToVisualLines(theme.fg("dim", inlineConfirm.active() ? inlineConfirm.hint(keybindings) : actionMode ? `${keyLabel("tui.select.up", "↑")}/${keyLabel("tui.select.down", "↓")} actions · ${keyLabel("tui.select.confirm", "enter")} run · ${keyLabel("tui.editor.cursorLeft", "←")} tree · ${keyLabel("tui.select.cancel", "esc")} tree` : `${keyLabel("tui.select.up", "↑")}/${keyLabel("tui.select.down", "↓")} tree · ${keyLabel("tui.editor.cursorLeft", "←")}/${keyLabel("tui.editor.cursorRight", "→")} collapse/expand · ${keyLabel("tui.select.confirm", "enter")} ${enterAction} · a actions${selectedNode?.kind === "agent" ? " · t transcript" : ""} · ${keyLabel("tui.select.cancel", "esc")} ${narrow && detailsMode ? "tree" : "back"}${content.length > viewport ? ` · ${keyLabel("tui.select.pageUp", "pgup")}/${keyLabel("tui.select.pageDown", "pgdn")} scroll` : ""} · auto-refresh 1s`), Number.MAX_SAFE_INTEGER, width, 1).visualLines[0] ?? "";
                      return [...content.slice(dashboardOffset, dashboardOffset + viewport), ...confirmRows, ...(hintRows ? [hint] : [])];
                    },
                    invalidate() {},
                    handleInput(data: string) {
                      if (inlineConfirm.active()) { inlineConfirm.handleInput(keybindings, data); return; }
                      if (stopRequested || editorRunning) return;
                      const narrow = renderedWidth < 80;
                      if (!actionMode && data === "t") { viewTranscript(); tui.requestRender(); return; }
                      if (!actionMode && (data === "a" || data === "A")) { actionMode = true; actionIndex = 0; dashboardOffset = 0; tui.requestRender(); return; }
                      if (actionMode) {
                        const options = actionOptions();
                        if (workflowKeyMatches(keybindings, data, "tui.select.cancel") || workflowKeyMatches(keybindings, data, "tui.editor.cursorLeft")) { actionMode = false; dashboardOffset = 0; tui.requestRender(); return; }
                        if (workflowKeyMatches(keybindings, data, "tui.select.up")) actionIndex = (actionIndex + options.length - 1) % options.length;
                        else if (workflowKeyMatches(keybindings, data, "tui.select.down")) actionIndex = (actionIndex + 1) % options.length;
                        else if (workflowKeyMatches(keybindings, data, "tui.select.pageUp")) dashboardOffset = Math.max(0, dashboardOffset - Math.max(1, terminalRows() - 1));
                        else if (workflowKeyMatches(keybindings, data, "tui.select.pageDown")) dashboardOffset += Math.max(1, terminalRows() - 1);
                        else if (workflowKeyMatches(keybindings, data, "tui.select.confirm")) {
                          const action = options[actionIndex];
                          const agent = selectedAgentRecord();
                          if (!action || action === "Back") { actionMode = false; dashboardOffset = 0; }
                          else if (agent) {
                            if (action === "View transcript") viewTranscript();
                            else {
                              // A registered action closes the menu and refreshes the dashboard once it is done; copies and editors keep the menu.
                              const extensionAction = visibleAgentAttemptActions(deps, view, agent).some(([, candidate]) => candidate.label === action);
                              if (extensionAction) actionMode = false;
                              void runAgentAction(deps, inPlaceUi, view, agent, action).catch((error: unknown) => { ctx.ui.notify(`Cannot run ${action}: ${errorText(error)}`, "warning"); }).finally(() => { if (extensionAction) void updateDashboard(); });
                            }
                          }
                          else if (action === "Open script in editor") void runWorkflowRunAction(deps, ctx, inPlaceUi, view, action).catch((error: unknown) => { ctx.ui.notify(`Cannot run ${action}: ${errorText(error)}`, "warning"); });
                          else if (action === "Stop") requestStop();
                          else done(action);
                        }
                        tui.requestRender();
                        return;
                      }
                      if (workflowKeyMatches(keybindings, data, "tui.select.cancel")) {
                        if (narrow && detailsMode) { detailsMode = false; selectionNeedsScroll = true; } else done("Back");
                      } else if (narrow && detailsMode) {
                        if (workflowKeyMatches(keybindings, data, "tui.select.pageUp")) dashboardOffset = Math.max(0, dashboardOffset - Math.max(1, terminalRows() - 1));
                        else if (workflowKeyMatches(keybindings, data, "tui.select.pageDown")) dashboardOffset += Math.max(1, terminalRows() - 1);
                        else if (workflowKeyMatches(keybindings, data, "tui.select.confirm")) {
                          const node = selectedNodeId ? tree.byId.get(selectedNodeId) : undefined;
                          if (node?.kind === "agent") { actionMode = true; actionIndex = 0; dashboardOffset = 0; }
                        }
                      } else if (workflowKeyMatches(keybindings, data, "tui.editor.cursorLeft")) {
                        const next = navigateWorkflowPhaseTree(tree, selectedNodeId, expandedNodeIds, "left");
                        selectedNodeId = next.nodeId; expandedNodeIds = new Set(next.expandedNodeIds); selectionNeedsScroll = true;
                      } else if (workflowKeyMatches(keybindings, data, "tui.editor.cursorRight")) {
                        const next = navigateWorkflowPhaseTree(tree, selectedNodeId, expandedNodeIds, "right");
                        selectedNodeId = next.nodeId; expandedNodeIds = new Set(next.expandedNodeIds); selectionNeedsScroll = true;
                      } else if (workflowKeyMatches(keybindings, data, "tui.select.up")) {
                        const next = navigateWorkflowPhaseTree(tree, selectedNodeId, expandedNodeIds, "up");
                        selectedNodeId = next.nodeId; selectionNeedsScroll = true;
                      } else if (workflowKeyMatches(keybindings, data, "tui.select.down")) {
                        const next = navigateWorkflowPhaseTree(tree, selectedNodeId, expandedNodeIds, "down");
                        selectedNodeId = next.nodeId; selectionNeedsScroll = true;
                      } else if (workflowKeyMatches(keybindings, data, "tui.select.pageUp")) dashboardOffset = Math.max(0, dashboardOffset - Math.max(1, terminalRows() - 1));
                      else if (workflowKeyMatches(keybindings, data, "tui.select.pageDown")) dashboardOffset += Math.max(1, terminalRows() - 1);
                      else if (workflowKeyMatches(keybindings, data, "tui.select.confirm")) {
                        const node = selectedNodeId ? tree.byId.get(selectedNodeId) : undefined;
                        if (node?.kind === "workflow") {
                          actionMode = true;
                          actionIndex = 0;
                          dashboardOffset = 0;
                        } else if (node?.kind === "agent") {
                          if (narrow) detailsMode = true;
                          else {
                            actionMode = true;
                            actionIndex = 0;
                            dashboardOffset = 0;
                          }
                        } else if (node?.children.length) {
                          if (expandedNodeIds.has(node.id)) expandedNodeIds.delete(node.id); else expandedNodeIds.add(node.id);
                          selectionNeedsScroll = true;
                        } else if (narrow) detailsMode = true;
                      }
                      tui.requestRender();
                    },
                    dispose() { disposed = true; stopTimer(); setWorkflowStatus(undefined); inlineConfirm.cancel(); },
                  };
                })
              : await ctx.ui.select(view.dashboard, [...view.actions.keys(), "Back"]);
            if (actionChoice === "__stopped__") return;
            if (!actionChoice || actionChoice === "Back") { stores = await loadStores(); break; }
            if (actionChoice === "Agents...") { await selectAgent(view); continue; }
            if (actionChoice === "Refresh") continue;
            const outcome = await runWorkflowRunAction(deps, ctx, ui, view, actionChoice);
            if (outcome === "picker") { stores = await loadStores(); break; }
          }
        }
      }
    },
  } satisfies Parameters<ExtensionAPI["registerCommand"]>[1];
  pi.registerCommand("workflow", {
    ...command,
    handler: async (args, ctx) => {
      setNavigatorOpen?.(true);
      try { await command.handler(args, ctx); }
      finally { setNavigatorOpen?.(false); }
    },
  });
}

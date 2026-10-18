import { copyToClipboard, type ExtensionAPI, type ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { Editor, truncateToWidth, type EditorTheme } from "@earendil-works/pi-tui";
import { createInlineConfirm, errorText, formatCost, formatNavigatorColumns, formatWorkflowRuntime, PLAIN_WORKFLOW_PROGRESS_STYLES, progressStyleForState, runStateGlyph, themeWorkflowProgressStyles, workflowKeyLabel, workflowKeyMatches, type WorkflowProgressStyles, type WorkflowTui } from "../../src/index.js";
import { getAgentsWorkspaceOpener, type OpenAgentsAt } from "../../src/host-navigator.js";
import { actionOptions, attentionSort, boundedText, BULK_DELETE, bulkDeleteLabels, deleteAll, detailRows, inspectEntry, listNames, loadEntries, openNavigatorArtifact, performAction, steerSubagent, type ActionOutcome, type DetailMenu, type Inspection, type NavigatorEntry, type SubagentActionUi } from "./actions.js";
import type { SubagentManager } from "./contracts.js";

type RegisterCommand = ExtensionAPI["registerCommand"];

/** The actions' ui over Pi's dialogs, for the picker; the dashboard confirms inline and steers in its own editor. */
function navigatorUi(context: ExtensionCommandContext, tui?: WorkflowTui): SubagentActionUi {
  return {
    notify: (message, level) => { context.ui.notify(message, level); },
    confirm: (title, message) => context.ui.confirm(title, message),
    select: (title, options) => context.ui.select(title, [...options]),
    input: (title, placeholder) => context.ui.input(title, placeholder),
    editText: (title) => context.ui.input(title, "Message for the running subagent"),
    //NOTE: only the TUI dashboard offers the editor actions, and it passes its tui.
    openArtifact: async (artifact, label) => { if (tui) await openNavigatorArtifact(context, tui, artifact, label, (message, level) => { context.ui.notify(message, level); }); },
    setWorkingMessage: (message) => { context.ui.setWorkingMessage(message); },
  };
}

/** Picker rows in the `/workflow` style. */
function pickerLabels(entries: readonly NavigatorEntry[]): string[] {
  const names = listNames(entries);
  return entries.map(({ status }, index) => {
    const name = names[index] ?? "";
    const model = status.progress?.state?.model;
    const cost = formatCost(status.progress?.accounting.cost);
    const runtime = status.startedAt === undefined ? "" : ` runtime=${formatWorkflowRuntime((status.finishedAt ?? Date.now()) - status.startedAt)}`;
    return `${runStateGlyph(status.state, "⠦")} ${name}  ${status.state}${model ? `  ${boundedText(model.model, 256)}${model.thinking ? `:${model.thinking}` : ""}` : ""}${cost ? ` ${cost}` : ""}${runtime}`;
  });
}
function listRows(entries: readonly NavigatorEntry[], selectedId: string, styles: WorkflowProgressStyles): string[] {
  const names = listNames(entries);
  return [styles.bold("Runs"), ...entries.map((entry, index) => `${entry.status.id === selectedId ? "→" : " "} • ${names[index] ?? ""} · ${progressStyleForState(entry.status.state, styles)(runStateGlyph(entry.status.state, "⠦"))}`)];
}
function headerRows(entries: readonly NavigatorEntry[], styles: WorkflowProgressStyles): string[] {
  const counts = (["running", "failed", "stopped", "completed"] as const).flatMap((state) => {
    const count = entries.filter((entry) => entry.status.state === state).length;
    return count ? [`${String(count)} ${state}`] : [];
  });
  const cost = formatCost(entries.reduce((sum, entry) => sum + (entry.status.progress?.accounting.cost ?? 0), 0));
  return [styles.bold(styles.accent("Subagents")), [...counts, ...(cost ? [cost] : [])].join(" · ")];
}

function tuiRows(tui: { terminal?: { rows?: number } }): number { return typeof tui.terminal?.rows === "number" && Number.isFinite(tui.terminal.rows) ? tui.terminal.rows : 24; }
function unrefTimer(timer: ReturnType<typeof setInterval>): void {
  const value: unknown = timer;
  if (typeof value !== "object" || value === null || !("unref" in value) || typeof value.unref !== "function") return;
  Reflect.apply(value.unref, value, []);
}

type DashboardResult = { readonly entry: NavigatorEntry; readonly message: string } | undefined;
// Pi keeps its footer below a custom component; the dashboard leaves room for it as /workflow does.
const DASHBOARD_FOOTER_ROWS = 2;
async function showDetail(manager: SubagentManager, storageDirectory: string, entry: NavigatorEntry, context: ExtensionCommandContext, clipboard: (value: string) => Promise<void>): Promise<void> {
  const ui = navigatorUi(context);
  let inspection = await inspectEntry(manager, storageDirectory, entry.status.id, context);
  for (;;) {
    const action = await context.ui.select(detailRows(inspection, PLAIN_WORKFLOW_PROGRESS_STYLES, Date.now()).join("\n"), actionOptions(manager, inspection, context, ui));
    if (!action || action === "Back") return;
    try {
      const outcome = await performAction(manager, storageDirectory, entry.status.id, action, context, ui, clipboard);
      if (outcome === "deleted" || typeof outcome === "object") return;
      inspection = await inspectEntry(manager, storageDirectory, entry.status.id, context);
    } catch (error) {
      context.ui.notify(`Cannot ${action.toLowerCase()}: ${errorText(error)}`, "warning");
    }
  }
}

/** The `/workflow` dashboard layout for standalone runs: the run list beside the selected run's details. */
async function showDashboard(manager: SubagentManager, storageDirectory: string, initial: readonly NavigatorEntry[], context: ExtensionCommandContext, clipboard: (value: string) => Promise<void>, openAgents: OpenAgentsAt): Promise<void> {
  const first = initial[0];
  if (first === undefined) return;
  let initialInspection: Inspection;
  try { initialInspection = await inspectEntry(manager, storageDirectory, first.status.id, context); }
  catch (error) {
    context.ui.notify(`Cannot inspect subagent ${first.status.id}: ${errorText(error)}`, "warning");
    initialInspection = { entry: first, record: {} };
  }
  const result = await context.ui.custom<DashboardResult>((tui, theme, keybindings, done) => {
    const styles = themeWorkflowProgressStyles(theme);
    const editorTheme: EditorTheme = {
      borderColor: (text) => theme.fg("accent", text),
      selectList: {
        selectedPrefix: (text) => theme.fg("accent", text),
        selectedText: (text) => theme.fg("accent", text),
        description: (text) => theme.fg("muted", text),
        scrollInfo: (text) => theme.fg("dim", text),
        noMatch: (text) => theme.fg("warning", text),
      },
    };
    const steerEditor = new Editor(tui, editorTheme);
    let entries = initial;
    let inspection = initialInspection;
    let offset = 0;
    let detailsMode = false;
    let actionMode = false;
    let actionIndex = 0;
    let steerMode = false;
    const inlineConfirm = createInlineConfirm(() => { if (!disposed) tui.requestRender(); });
    // Pi's confirm would replace the dashboard, so the actions confirm inline.
    const ui: SubagentActionUi = { ...navigatorUi(context, tui), confirm: (title, message) => inlineConfirm.ask(title, message) };
    let actionRunning = false;
    let refreshing = false;
    let disposed = false;
    let generation = 0;
    let renderedWidth = 80;
    let selectionNeedsScroll = true;
    let timer: ReturnType<typeof setInterval> | undefined;
    const keyLabel = (binding: string, fallback: string): string => workflowKeyLabel(keybindings, binding, fallback);
    const matches = (data: string, binding: string): boolean => workflowKeyMatches(keybindings, data, binding);
    const requestRender = (): void => { if (!disposed) tui.requestRender(); };
    const options = (): string[] => actionOptions(manager, inspection, context, ui, bulkDeleteLabels(manager, entries));
    const warn = (message: string): void => {
      if (disposed) return;
      try { context.ui.notify(message, "warning"); } catch { /* The session UI may already be closing. */ }
    };
    const stopTimer = (): void => {
      if (timer === undefined) return;
      clearInterval(timer);
      timer = undefined;
    };
    // Refresh while anything runs; a settled list has nothing left to change.
    const syncTimer = (): void => {
      if (!entries.some((entry) => entry.status.state === "running") && inspection.entry.status.state !== "running") stopTimer();
      else if (timer === undefined && !disposed) {
        timer = setInterval(() => { if (timer !== undefined) void refresh(); }, 1000);
        unrefTimer(timer);
      }
    };
    const apply = (nextEntries: readonly NavigatorEntry[], next: Inspection): void => {
      const selectedAction = actionMode ? options()[actionIndex] : undefined;
      const position = (list: readonly NavigatorEntry[]): number => list.findIndex((entry) => entry.status.id === next.entry.status.id);
      if (position(entries) !== position(nextEntries)) selectionNeedsScroll = true;
      entries = nextEntries;
      inspection = next;
      if (selectedAction !== undefined) {
        const nextOptions = options();
        const kept = nextOptions.indexOf(selectedAction);
        actionIndex = kept >= 0 ? kept : Math.min(actionIndex, Math.max(0, nextOptions.length - 1));
      }
      syncTimer();
      requestRender();
    };
    const reload = async (id = inspection.entry.status.id): Promise<void> => {
      const current = ++generation;
      const nextEntries = await loadEntries(manager, storageDirectory, context);
      if (current !== generation) return;
      const selected = nextEntries.find((entry) => entry.status.id === id) ?? nextEntries[0];
      if (selected === undefined) {
        context.ui.notify("No durable subagent runs in this session.", "info");
        close(undefined);
        return;
      }
      let next: Inspection;
      try { next = await inspectEntry(manager, storageDirectory, selected.status.id, context); }
      catch (error: unknown) {
        // The fresh list still shows, with the row's own data as when moving the selection.
        if (current === generation) apply(nextEntries, { entry: selected, record: {} });
        throw error;
      }
      if (current === generation) apply(nextEntries, next);
    };
    // A tick re-reads only the active runs and the selection; the full list is read on open and after an action.
    // A failed read keeps the last known row, as the /workflow refresh does, so one unreadable run cannot hold back the rest.
    // Moving the selection bumps the generation, so a tick that survives it still has the selection it read.
    //NOTE: a running run whose files vanish keeps the timer alive until the dashboard closes.
    const refresh = async (): Promise<void> => {
      if (disposed || actionRunning || refreshing) return;
      refreshing = true;
      const current = generation;
      const selectedId = inspection.entry.status.id;
      try {
        const stale = entries.filter((entry) => entry.status.state === "running" || entry.status.id === selectedId);
        const results = await Promise.allSettled(stale.map((entry) => inspectEntry(manager, storageDirectory, entry.status.id, context)));
        if (current !== generation) return;
        const fresh = new Map(results.flatMap((result) => result.status === "fulfilled" ? [[result.value.entry.status.id, result.value] as const] : []));
        apply(attentionSort(entries.map((entry) => fresh.get(entry.status.id)?.entry ?? entry)), fresh.get(selectedId) ?? inspection);
      } finally {
        refreshing = false;
      }
    };
    const select = (delta: number): void => {
      const index = Math.max(0, entries.findIndex((entry) => entry.status.id === inspection.entry.status.id));
      const entry = entries[(index + delta + entries.length) % entries.length];
      if (entry === undefined || entry.status.id === inspection.entry.status.id) return;
      // The list row already holds the state; the full inspection adds the result and attempt details.
      inspection = { entry, record: {} };
      selectionNeedsScroll = true;
      const current = ++generation;
      void inspectEntry(manager, storageDirectory, entry.status.id, context).then((next) => {
        if (current === generation) apply(entries, next);
      }, (error: unknown) => { if (current === generation) warn(`Cannot inspect subagent ${entry.status.id}: ${errorText(error)}`); });
    };
    // Reads still in flight check the generation, so closing invalidates them.
    const shutDown = (): void => {
      disposed = true;
      generation += 1;
      stopTimer();
      inlineConfirm.cancel();
    };
    const close = (value: DashboardResult): void => {
      if (disposed) return;
      shutDown();
      done(value);
    };
    // t and "View transcript": the /agents workspace opens over Pi on the selected run; this dashboard is back when it closes.
    const viewTranscript = (): void => {
      actionMode = false;
      offset = 0;
      selectionNeedsScroll = true;
      void openAgents(context, `subagent:${inspection.entry.status.id}`).catch((error: unknown) => { warn(`Cannot open the agents workspace: ${errorText(error)}`); });
    };
    steerEditor.onSubmit = (value) => {
      const message = value.trim();
      if (message) close({ entry: inspection.entry, message });
    };
    const reloadAfterAction = async (id?: string): Promise<void> => {
      try { await reload(id); }
      catch (error: unknown) { warn(`Cannot refresh subagents: ${errorText(error)}`); }
    };
    const runAction = (action: string): void => {
      actionRunning = true;
      requestRender();
      const bulk = BULK_DELETE[action];
      const pending = bulk === undefined ? performAction(manager, storageDirectory, inspection.entry.status.id, action, context, ui, clipboard) : deleteAll(manager, storageDirectory, context, bulk, ui).then((done): ActionOutcome => done ? "stay" : "unchanged");
      void pending.then(async (outcome) => {
        if (disposed || outcome === "unchanged") return;
        // The action already happened: a failed reload must not read as a failed action that invites a second retry.
        await reloadAfterAction(typeof outcome === "object" ? outcome.retryId : undefined);
        actionMode = false;
        actionIndex = 0;
        offset = 0;
        selectionNeedsScroll = true;
      }, async (error: unknown) => {
        warn(`Cannot ${action.toLowerCase()}: ${errorText(error)}`);
        // The menu stays open on fresh options: a failed Stop usually means the run has already settled.
        if (!disposed) await reloadAfterAction();
      }).finally(() => {
        actionRunning = false;
        requestRender();
      });
    };
    syncTimer();
    return {
      render(width: number): string[] {
        if (disposed) return [];
        renderedWidth = width;
        const narrow = width < 80;
        const actions = actionMode ? options() : [];
        const menu: DetailMenu = actionMode ? { options: actions, index: actionIndex } : steerMode ? undefined : "hint";
        const layout = narrow ? detailsMode || actionMode || steerMode ? { detailsOnly: true } : { treeOnly: true } : {};
        const content = [...headerRows(entries, styles), ...formatNavigatorColumns(listRows(entries, inspection.entry.status.id, styles), detailRows(inspection, styles, Date.now(), menu), width, layout)];
        const footer = steerMode ? [styles.bold("Steer subagent"), ...steerEditor.render(width)] : inlineConfirm.rows(width, styles);
        const rows = Math.max(1, tuiRows(tui) - DASHBOARD_FOOTER_ROWS);
        const hintRows = rows >= 3 ? 1 : 0;
        const viewport = Math.max(1, rows - hintRows - footer.length);
        const keepVisible = (row: number): void => {
          if (row < 0) return;
          if (row < offset) offset = row;
          else if (row >= offset + viewport) offset = row - viewport + 1;
        };
        // The selected action is the first arrow in the details column: it precedes the prompt and result.
        if (actionMode) keepVisible(content.findIndex((line) => narrow ? line.startsWith("→ ") : line.includes(" | → ")));
        else if (selectionNeedsScroll && !(narrow && detailsMode)) {
          keepVisible(content.findIndex((line) => line.startsWith("→")));
          selectionNeedsScroll = false;
        }
        offset = Math.max(0, Math.min(Math.max(0, content.length - viewport), offset));
        const up = keyLabel("tui.select.up", "↑");
        const down = keyLabel("tui.select.down", "↓");
        const enter = keyLabel("tui.select.confirm", "enter");
        const esc = keyLabel("tui.select.cancel", "esc");
        const scroll = content.length > viewport ? ` · ${keyLabel("tui.select.pageUp", "pgup")}/${keyLabel("tui.select.pageDown", "pgdn")} scroll` : "";
        const refreshHint = timer === undefined ? "" : " · auto-refresh 1s";
        const back = narrow && detailsMode ? "details" : "list";
        const hint = steerMode ? "enter submit · esc back"
          : inlineConfirm.active() ? inlineConfirm.hint(keybindings)
          : actionMode ? `${up}/${down} actions · ${enter} run · ${keyLabel("tui.editor.cursorLeft", "←")} ${back} · ${esc} ${back}`
            : narrow && detailsMode ? `${up}/${down} scroll · ${enter} actions · a actions · t transcript · ${esc} list${scroll}${refreshHint}`
              : `${up}/${down} select · ${enter} ${narrow ? "details" : "actions"} · a actions · t transcript · ${esc} close${scroll}${refreshHint}`;
        return [...content.slice(offset, offset + viewport), ...footer, ...(hintRows ? [styles.dim(hint)] : [])].map((line) => truncateToWidth(line, Math.max(1, width), "…"));
      },
      invalidate() {},
      handleInput(data: string) {
        if (disposed) return;
        if (inlineConfirm.active()) { inlineConfirm.handleInput(keybindings, data); return; }
        if (actionRunning) return;
        if (steerMode) {
          if (keybindings.matches(data, "tui.select.cancel")) { steerMode = false; actionMode = true; steerEditor.setText(""); }
          else steerEditor.handleInput(data);
          requestRender();
          return;
        }
        const narrow = renderedWidth < 80;
        const page = Math.max(1, tuiRows(tui) - DASHBOARD_FOOTER_ROWS - 1);
        if (matches(data, "tui.select.pageUp")) offset = Math.max(0, offset - page);
        else if (matches(data, "tui.select.pageDown")) offset += page;
        else if (actionMode) {
          const actions = options();
          if (matches(data, "tui.select.cancel") || matches(data, "tui.editor.cursorLeft")) { actionMode = false; offset = 0; selectionNeedsScroll = true; }
          else if (matches(data, "tui.select.up")) actionIndex = (actionIndex + actions.length - 1) % actions.length;
          else if (matches(data, "tui.select.down")) actionIndex = (actionIndex + 1) % actions.length;
          else if (matches(data, "tui.select.confirm")) {
            const action = actions[actionIndex];
            if (action === "Steer") { steerMode = true; actionMode = false; steerEditor.setText(""); }
            else if (action === "View transcript") viewTranscript();
            else if (action && action !== "Back") runAction(action);
            else { actionMode = false; offset = 0; selectionNeedsScroll = true; }
          }
        } else if (data === "a" || data === "A") { actionMode = true; actionIndex = 0; offset = 0; }
        else if (data === "t") viewTranscript();
        else if (matches(data, "tui.select.cancel")) {
          if (!narrow || !detailsMode) { close(undefined); return; }
          detailsMode = false;
          offset = 0;
          selectionNeedsScroll = true;
        } else if (narrow && detailsMode) {
          if (matches(data, "tui.select.up")) offset = Math.max(0, offset - 1);
          else if (matches(data, "tui.select.down")) offset += 1;
          else if (matches(data, "tui.select.confirm")) { actionMode = true; actionIndex = 0; offset = 0; }
        } else if (matches(data, "tui.select.up")) select(-1);
        else if (matches(data, "tui.select.down")) select(1);
        else if (matches(data, "tui.select.confirm")) {
          if (narrow) detailsMode = true;
          else actionMode = true;
          actionIndex = 0;
          offset = 0;
        }
        requestRender();
      },
      dispose() { shutDown(); },
    };
  });
  if (result === undefined) return;
  try { await steerSubagent(manager, storageDirectory, result.entry.status.id, context, result.message, navigatorUi(context)); }
  catch (error) { context.ui.notify(`Cannot steer: ${errorText(error)}`, "warning"); }
}

async function runNavigator(manager: SubagentManager, storageDirectory: string, args: string, context: ExtensionCommandContext, clipboard: (value: string) => Promise<void>, openAgents: OpenAgentsAt): Promise<void> {
  if (args.trim()) {
    context.ui.notify("Subagent slash commands do not accept arguments. Open the picker with /subagents to inspect and control current-session runs.", "warning");
    return;
  }
  for (;;) {
    const entries = await loadEntries(manager, storageDirectory, context);
    if (!entries.length) {
      context.ui.notify("No durable subagent runs in this session.", "info");
      return;
    }
    const labels = pickerLabels(entries);
    if (!context.hasUI) {
      context.ui.notify(labels.join("\n"), "info");
      return;
    }
    if (context.mode === "tui") {
      await showDashboard(manager, storageDirectory, entries, context, clipboard, openAgents);
      return;
    }
    const choice = await context.ui.select("Subagents\n", [...labels, "Close", ...bulkDeleteLabels(manager, entries)]);
    if (!choice || choice === "Close") return;
    const bulk = BULK_DELETE[choice];
    if (bulk !== undefined) {
      try { await deleteAll(manager, storageDirectory, context, bulk, navigatorUi(context)); }
      catch (error) { context.ui.notify(`Cannot delete ${bulk} runs: ${errorText(error)}`, "warning"); }
      continue;
    }
    const selected = entries[labels.indexOf(choice)];
    if (!selected) return;
    try {
      await showDetail(manager, storageDirectory, selected, context, clipboard);
    } catch (error) {
      context.ui.notify(`Cannot inspect subagent ${selected.status.id}: ${errorText(error)}`, "warning");
    }
  }
}

/** The workspace the core workflow extension publishes (src/host.ts); this extension may run without it. */
const openPublishedAgentsWorkspace: OpenAgentsAt = async (context, initialKey) => {
  const open = getAgentsWorkspaceOpener();
  if (open === undefined) { context.ui.notify("The agents workspace needs the pi-extensible-workflows workflow extension.", "warning"); return; }
  await open(context, initialKey);
};

export function registerSubagentNavigator(registerCommand: RegisterCommand, manager: SubagentManager, storageDirectory: string, clipboard: (value: string) => Promise<void> = copyToClipboard, openAgents: OpenAgentsAt = openPublishedAgentsWorkspace): void {
  registerCommand("subagents", {
    description: "Open the durable subagent picker and inspect run status",
    handler: async (args, context) => {
      try {
        await runNavigator(manager, storageDirectory, args, context, clipboard, openAgents);
      } catch (error) {
        context.ui.notify(`Cannot inspect subagents: ${errorText(error)}`, "warning");
      }
    },
  });
}

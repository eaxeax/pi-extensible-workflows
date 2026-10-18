import { truncateToVisualLines, type ExtensionCommandContext, type ExtensionUIContext } from "@earendil-works/pi-coding-agent";
import { Editor, truncateToWidth, type EditorTheme } from "@earendil-works/pi-tui";
import type { ActionUi } from "./agents-actions-contract.js";
import { formatCheckpointReview, themeWorkflowProgressStyles } from "./host-view.js";
import { object, sanitizeDisplayText } from "./utils.js";
import { confirmWithBlocked, type ReportBlocked } from "./workflow-actions.js";
import { openArtifactInEditor } from "./workflow-artifacts.js";

type UiSelect = (title: string, options: string[]) => Promise<string | undefined>;
type UiInput = (title: string, placeholder?: string) => Promise<string | undefined>;
type UiSetStatus = (key: string, text?: string) => void;
type UiCustom = ExtensionUIContext["custom"];
type UiHostCapabilities = { select?: UiSelect; input?: UiInput; setStatus?: UiSetStatus; custom?: UiCustom };
function isUiSelect(value: unknown): value is UiSelect { return typeof value === "function"; }
function isUiInput(value: unknown): value is UiInput { return typeof value === "function"; }
function isUiSetStatus(value: unknown): value is UiSetStatus { return typeof value === "function"; }
function isUiCustom(value: unknown): value is UiCustom { return typeof value === "function"; }
function isCheckpointDecision(value: unknown): value is "Approve" | "Reject" { return value === "Approve" || value === "Reject"; }
export function uiHostCapabilities(ui: unknown): UiHostCapabilities | undefined {
  if (!object(ui)) return undefined;
  const selectValue = ui.select;
  const inputValue = ui.input;
  const setStatusValue = ui.setStatus;
  const customValue = ui.custom;
  const select = isUiSelect(selectValue) ? selectValue.bind(ui) : undefined;
  const input = isUiInput(inputValue) ? inputValue.bind(ui) : undefined;
  const setStatus = isUiSetStatus(setStatusValue) ? setStatusValue.bind(ui) : undefined;
  const custom = isUiCustom(customValue) ? customValue.bind(ui) : undefined;
  return { ...(select ? { select } : {}), ...(input ? { input } : {}), ...(setStatus ? { setStatus } : {}), ...(custom ? { custom } : {}) };
}
function tuiRows(tui: unknown): number {
  const rows = object(tui) && object(tui.terminal) ? tui.terminal.rows : undefined;
  return typeof rows === "number" && Number.isFinite(rows) ? rows : 24;
}
const WORKFLOW_OVERLAY_BORDER_ROWS = 2;
const WORKFLOW_OVERLAY_TOP_MARGIN = 1;
const WORKFLOW_OVERLAY_OPTIONS = { anchor: "top-left", width: "100%", maxHeight: "100%", margin: { top: WORKFLOW_OVERLAY_TOP_MARGIN } } as const;
type WorkflowOverlayComponent = { render(width: number): string[]; invalidate(): void; handleInput?(data: string): void; dispose?(): void };
function borderWorkflowOverlay(component: WorkflowOverlayComponent, theme: { fg(color: "border", text: string): string }): WorkflowOverlayComponent {
  return { ...component, render(width: number) { const border = theme.fg("border", "─".repeat(Math.max(1, width))); return [border, ...component.render(width), border]; } };
}
type KeybindingsHostCapabilities = { getKeys?: (name: string) => readonly string[] };
type KeybindingGetKeys = NonNullable<KeybindingsHostCapabilities["getKeys"]>;
function isKeybindingGetKeys(value: unknown): value is KeybindingGetKeys { return typeof value === "function"; }
function keybindingKeys(keybindings: unknown, name: string): readonly string[] | undefined {
  if (!object(keybindings)) return undefined;
  const getKeys = keybindings.getKeys;
  return isKeybindingGetKeys(getKeys) ? getKeys.call(keybindings, name) : undefined;
}
type WorkflowKeybindings = { matches(data: string, binding: string): boolean };
const WORKFLOW_VIM_KEYS: Readonly<Record<string, string>> = { "tui.select.up": "k", "tui.select.down": "j", "tui.editor.cursorLeft": "h", "tui.editor.cursorRight": "l" };
export function workflowKeyMatches(keybindings: WorkflowKeybindings, data: string, binding: string): boolean { return keybindings.matches(data, binding) || WORKFLOW_VIM_KEYS[binding] === data; }
const WORKFLOW_KEY_LABELS: Readonly<Record<string, string>> = { up: "↑", down: "↓", left: "←", right: "→", pageUp: "pgup", pageDown: "pgdn" };
export function workflowKeyLabel(keybindings: unknown, binding: string, fallback: string, labels: Readonly<Record<string, string>> = WORKFLOW_KEY_LABELS): string {
  const keys = keybindingKeys(keybindings, binding);
  const configured = keys?.length ? keys.map((key) => labels[key] ?? key) : [fallback];
  const vim = WORKFLOW_VIM_KEYS[binding];
  return [...new Set(vim ? [...configured, vim] : configured)].join("/");
}

interface PiActionUiOptions {
  /** Told around each confirmation, as the workflow tools report a blocked run. */
  readonly reportBlocked?: ReportBlocked | undefined;
  /** The external editor command; undefined when none is configured. */
  readonly editorCommand: () => string | undefined;
  /** Every notice, after Pi shows it. */
  readonly onNotify?: (message: string, level?: "info" | "warning" | "error") => void;
}

/** The checkpoint in a bordered overlay with Approve, Reject and Cancel; it keeps its options and hint in view at any height. */
function reviewCheckpointOverlay(ctx: ExtensionCommandContext, checkpoint: Parameters<ActionUi["reviewCheckpoint"]>[0]): Promise<"Approve" | "Reject" | undefined> {
  const review = formatCheckpointReview(checkpoint).split("\n").map(sanitizeDisplayText).join("\n");
  return ctx.ui.custom<"Approve" | "Reject" | undefined>((tui, theme, keybindings, done) => {
    const options = ["Approve", "Reject", "Cancel"];
    let selectedIndex = 0;
    let offset = 0;
    let renderedLines: string[] = [];
    const layout = () => {
      const rows = Math.max(1, tuiRows(tui) - WORKFLOW_OVERLAY_BORDER_ROWS);
      const compactControls = rows < 4;
      const titleRows = rows >= 5 ? 1 : 0;
      const hintRows = rows >= 8 ? 1 : 0;
      const separatorRows = rows >= 8 ? 1 : 0;
      const controlRows = compactControls ? 1 : options.length;
      const contentViewport = Math.max(0, rows - titleRows - hintRows - separatorRows - controlRows);
      return { rows, compactControls, titleRows, hintRows, separatorRows, contentViewport };
    };
    const move = (delta: number) => {
      const maxOffset = Math.max(0, renderedLines.length - layout().contentViewport);
      offset = Math.max(0, Math.min(maxOffset, offset + delta));
    };
    return borderWorkflowOverlay({
      render(width: number) {
        renderedLines = truncateToVisualLines(review, Number.MAX_SAFE_INTEGER, width, 0).visualLines;
        const currentLayout = layout();
        const maxOffset = Math.max(0, renderedLines.length - currentLayout.contentViewport);
        offset = Math.min(offset, maxOffset);
        const keyLabel = (binding: string, fallback: string) => workflowKeyLabel(keybindings, binding, fallback);
        const hint = truncateToVisualLines(theme.fg("dim", `${keyLabel("tui.select.up", "↑")}/${keyLabel("tui.select.down", "↓")}/pgup/pgdn scroll · enter select · esc cancel`), Number.MAX_SAFE_INTEGER, width, 1).visualLines[0] ?? "";
        const controls = currentLayout.compactControls
          ? [options.map((option, index) => `${index === selectedIndex ? "[" : " "}${option}${index === selectedIndex ? "]" : " "}`).join(" ")]
          : options.map((option, index) => `${index === selectedIndex ? "→ " : "  "}${option}`);
        return [
          ...(currentLayout.titleRows ? [theme.fg("accent", "Checkpoint review")] : []),
          ...renderedLines.slice(offset, offset + currentLayout.contentViewport),
          ...(currentLayout.separatorRows ? [""] : []),
          ...controls,
          ...(currentLayout.hintRows ? [hint] : []),
        ];
      },
      invalidate() {},
      handleInput(data: string) {
        if (workflowKeyMatches(keybindings, data, "tui.select.up")) selectedIndex = (selectedIndex + options.length - 1) % options.length;
        else if (workflowKeyMatches(keybindings, data, "tui.select.down")) selectedIndex = (selectedIndex + 1) % options.length;
        else if (workflowKeyMatches(keybindings, data, "tui.select.pageUp")) move(-layout().contentViewport);
        else if (workflowKeyMatches(keybindings, data, "tui.select.pageDown")) move(layout().contentViewport);
        else if (workflowKeyMatches(keybindings, data, "tui.select.confirm")) {
          const selected = options[selectedIndex];
          done(isCheckpointDecision(selected) ? selected : undefined);
        }
        else if (workflowKeyMatches(keybindings, data, "tui.select.cancel")) done(undefined);
        tui.requestRender();
      },
    }, theme);
  }, { overlay: true, overlayOptions: WORKFLOW_OVERLAY_OPTIONS });
}

/** Pi's editor in place of its own input, as the /subagents steer editor: enter submits, esc cancels, an empty text is a cancel. */
function editTextInEditor(ctx: ExtensionCommandContext, title: string): Promise<string | undefined> {
  return ctx.ui.custom<string | undefined>((tui, theme, keybindings, done) => {
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
    const editor = new Editor(tui, editorTheme);
    editor.onSubmit = (value) => { const text = value.trim(); done(text || undefined); };
    return {
      render(width: number): string[] {
        const fit = (line: string) => truncateToWidth(line, Math.max(1, width), "…");
        return [fit(styles.bold(sanitizeDisplayText(title))), ...editor.render(width), fit(styles.dim("enter submit · esc cancel"))];
      },
      invalidate() { editor.invalidate(); },
      handleInput(data: string) {
        if (keybindings.matches(data, "tui.select.cancel")) { done(undefined); return; }
        editor.handleInput(data);
        tui.requestRender();
      },
    };
  });
}

/**
 * The ActionUi over Pi's own UI: its dialogs, the workflow-stop status and the working message. In the TUI the checkpoint
 * review, the text editor and the external editor are custom components; elsewhere they fall back to Pi's dialogs.
 * Pi shows one custom component at a time: a dialog or custom opened while another custom is shown replaces it and afterwards
 * restores the editor rather than that component, which leaves its promise pending and the session waiting on it. So this
 * ActionUi runs while no custom is shown: runAgentsWorkspace (src/agents-command.ts) closes the workspace first.
 */
export function createPiActionUi(ctx: ExtensionCommandContext, options: PiActionUiOptions): ActionUi {
  const capabilities = () => uiHostCapabilities(ctx.ui);
  const notify = (message: string, level?: "info" | "warning" | "error"): void => {
    ctx.ui.notify(message, level);
    options.onNotify?.(message, level);
  };
  const select = async (title: string, choices: readonly string[]): Promise<string | undefined> => capabilities()?.select?.(title, [...choices]);
  const input = async (title: string, placeholder?: string): Promise<string | undefined> => capabilities()?.input?.(title, placeholder);
  return {
    notify,
    confirm: (title, message) => confirmWithBlocked({ confirm: (dialogTitle, dialogMessage) => ctx.ui.confirm(dialogTitle, dialogMessage) }, options.reportBlocked, title, message),
    select,
    input,
    editText: (title) => ctx.mode === "tui" ? editTextInEditor(ctx, title) : input(title),
    async reviewCheckpoint(checkpoint) {
      if (ctx.mode === "tui") return reviewCheckpointOverlay(ctx, checkpoint);
      const choice = await select(formatCheckpointReview(checkpoint), ["Approve", "Reject", "Cancel"]);
      return isCheckpointDecision(choice) ? choice : undefined;
    },
    async openArtifact(artifact, label) {
      const command = ctx.mode === "tui" ? options.editorCommand() : undefined;
      if (command === undefined) { notify(`Cannot open ${label}: no external editor is configured.`, "warning"); return; }
      await ctx.ui.custom<undefined>((tui, _theme, _keybindings, done) => {
        const editorTui = { stop: () => { tui.stop(); return true; }, start: () => { tui.start(); }, requestRender: (force?: boolean) => { tui.requestRender(force); } };
        void openArtifactInEditor(editorTui, command, artifact, label, notify).finally(() => { done(undefined); });
        return { render: () => [], invalidate() {} };
      });
    },
    status(text) { capabilities()?.setStatus?.("workflow-stop", text); },
    setWorkingMessage(message) { ctx.ui.setWorkingMessage(message); },
  };
}

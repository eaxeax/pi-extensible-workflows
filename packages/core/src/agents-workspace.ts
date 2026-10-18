import type { KeybindingsManager, Theme } from "@earendil-works/pi-coding-agent";
import { getKeybindings, HStack, isKeyRelease, matchesKey, parseKey, ScrollView, Text, TUI_KEYBINDINGS, truncateToWidth, TuiAltScreen, visibleWidth, VStack, wrapTextWithAnsi, type Component, type Keybinding, type OverlayHandle, type OverlayOptions, type TuiInputListenerResult, type TuiMouseEvent, type TuiMouseEventResult } from "@earendil-works/pi-tui";
import type { ActionUi, AgentsAction, AgentsActionProvider, AgentsActionTarget } from "./agents-actions-contract.js";
import type { AgentsWorkspaceExit, AgentsWorkspaceOptions, AgentsWorkspaceState, OpenAgentsWorkspace, SessionAgent, SessionTreeNode, TranscriptView } from "./agents-workspace-contract.js";
import { formatCost, formatTokens } from "./background-widget.js";
import { workflowKeyMatches } from "./host-navigator.js";
import { navigateWorkflowPhaseTree, workflowPhaseTreeVisibleNodes, type WorkflowPhaseTree, type WorkflowPhaseTreeDirection, type WorkflowPhaseTreeNode } from "./host-phases.js";
import { progressStyleForState, themeWorkflowProgressStyles, type WorkflowProgressStyles } from "./host-view.js";
import type { TranscriptPoll, TranscriptSource, TranscriptSourceStatus } from "./transcript-source.js";
import { errorText, sanitizeDisplayText } from "./utils.js";
import { openArtifactInEditor, type WorkflowTui } from "./workflow-artifacts.js";

const SEPARATOR = " │ ";
/** Below this width the sidebar hides, at open and when the terminal narrows to it; s still shows it. */
const SIDEBAR_MIN_COLUMNS = 80;
/** Title and hint: one row each above and below the body. */
const FIXED_ROWS = 2;
/** The sidebar filter's input row, under the title while it is open. */
const FILTER_ROWS = 1;
/** The action menu: half the width, 32 columns at least, centred a row and a column clear of the edges, so it never covers the title or the hint. */
const MENU_OVERLAY: OverlayOptions = { width: "50%", minWidth: 32, margin: 1 };
const MENU_TITLES: Readonly<Record<AgentsActionTarget["kind"], string>> = { run: "Run actions", "workflow-agent": "Agent actions", subagent: "Subagent actions", subagents: "Subagents" };

/** As the dashboards: 38% of the width less the separator, 24 to 42 columns, then the separator. */
function sidebarWidth(columns: number): number { return Math.min(42, Math.max(24, Math.floor((columns - SEPARATOR.length) * 0.38))) + SEPARATOR.length; }
function clean(text: string | undefined): string { return sanitizeDisplayText(text ?? "").replace(/\s+/g, " ").trim(); }
/** A mouse report as the alt screen reads one: SGR, or the legacy six bytes. */
function isMouse(data: string): boolean { return (data.startsWith("\x1b[<") && /^\d+;\d+;\d+[Mm]$/.test(data.slice(3))) || (data.length === 6 && data.startsWith("\x1b[M")); }
/** The alt screen's own scroll and search actions: it acts on them before any input listener. */
const ALT_SCREEN_ACTIONS = (Object.keys(TUI_KEYBINDINGS) as (keyof typeof TUI_KEYBINDINGS)[]).filter((id) => id.startsWith("tui.altScreen."));
/**
 * A keypress: what parseKey names, what the alt screen takes for one of its actions (with the keybindings it reads, so also the
 * legacy home and end \x1b[1~ and \x1b[4~ of tmux and screen), text without a control character (é), or a bracketed paste. What
 * else the terminal sends, a focus report or a query's answer, is not one.
 */
function isKey(data: string): boolean {
  if (parseKey(data) !== undefined || data.startsWith("\x1b[200~")) return true;
  const keybindings = getKeybindings();
  return ALT_SCREEN_ACTIONS.some((id) => keybindings.matches(data, id)) || isText(data);
}
function isText(data: string): boolean {
  if (data.length === 0) return false;
  for (const char of data) if (char < " " || char === "\x7f") return false;
  return true;
}
/** The text of a bracketed paste, or `data` itself when it is not one. */
function unpasted(data: string): string {
  const start = "\x1b[200~";
  const end = "\x1b[201~";
  if (!data.startsWith(start)) return data;
  const text = data.slice(start.length);
  return text.endsWith(end) ? text.slice(0, -end.length) : text;
}
/** What makes a fresh transcript: another attempt, another session reference or another owner verdict. */
function identity(agent: SessionAgent): string { return JSON.stringify([agent.attempt ?? null, agent.owned, agent.session ?? null]); }
/** A component of one row, truncated to the width; nothing when the text is empty. */
function row(text: () => string): Component {
  return { render: (width) => { const value = text(); return value ? [truncateToWidth(value, Math.max(1, width), "…")] : []; }, invalidate() {} };
}
/**
 * The sidebar as a /workflow tree whose ids are the node keys, so that /workflow's visibility and navigation
 * (workflowPhaseTreeVisibleNodes, navigateWorkflowPhaseTree) apply to it unchanged; they read only ids, parents and children.
 */
function navigationTree(nodes: readonly SessionTreeNode[]): WorkflowPhaseTree {
  const children = new Map<string, string[]>();
  for (const node of nodes) {
    if (node.parentKey === undefined) continue;
    const siblings = children.get(node.parentKey) ?? [];
    siblings.push(node.key);
    children.set(node.parentKey, siblings);
  }
  // The other fields are placeholders: nothing reads them.
  const treeNodes = nodes.map((node): WorkflowPhaseTreeNode => ({ id: node.key, kind: "phase", label: "", depth: node.depth, phaseId: "", operationPath: [], ...(node.parentKey === undefined ? {} : { parentId: node.parentKey }), children: children.get(node.key) ?? [], state: "running" }));
  //NOTE: a node whose parent is not listed is in no root's subtree, so it never shows.
  return { roots: nodes.filter((node) => node.parentKey === undefined).map(({ key }) => key), nodes: treeNodes, byId: new Map(treeNodes.map((node) => [node.id, node])) };
}

/** The transcript's primary scroll view: reports each layout, and keeps the lines in view when an earlier chunk is placed above them. */
class TranscriptScroll extends ScrollView {
  private kept = 0;
  private laidContent = 0;
  private pendingFromEnd: number | undefined;
  private restoredAt: string | undefined;
  private atStart = false;
  constructor(content: Component, private readonly laidOut: () => void) { super(content, { follow: "end", primary: true, scrollbar: "auto" }); }
  /** Rows added above the lines in view; applied at the next layout, once the content height counts them. */
  keep(rows: number): void { this.kept += rows; }
  /** How many rows lie below the lines in view; 0 at the tail. */
  get fromEnd(): number { return this.isFollowingEnd ? 0 : Math.max(0, this.laidContent - this.viewportHeight - this.scrollTop); }
  /** Scrolls to `rows` above the tail once the content reaches that far (the transcript loads after it opens, the tail chunk first); until then it stays at the top so earlier chunks keep loading. */
  restoreFromEnd(rows: number): void { if (rows > 0) { this.pendingFromEnd = rows; this.restoredAt = undefined; } }
  /** The earliest record is loaded: a place above it is clamped to the top. */
  reachedStart(): void { this.atStart = true; }
  /** Nothing more will load above: a saved place beyond the laid-out content is dropped, the view stays clamped at the top. */
  giveUpRestore(): void {
    this.atStart = true;
    if (this.laidContent > 0) this.pendingFromEnd = undefined;
  }
  /** The content was replaced: a saved place no longer applies. */
  cancelRestore(): void { this.pendingFromEnd = undefined; this.restoredAt = undefined; }
  override updateLayout(contentHeight: number, viewportHeight: number, requestRender: () => void): void {
    super.updateLayout(contentHeight, viewportHeight, requestRender);
    this.laidContent = contentHeight;
    const rows = this.kept;
    this.kept = 0;
    // A place beyond the content is applied once per content height: with nothing new to show, later layouts leave the user's scrolling alone.
    if (this.pendingFromEnd !== undefined && contentHeight > 0 && `${String(contentHeight)}x${String(viewportHeight)}` !== this.restoredAt) {
      const target = contentHeight - viewportHeight - this.pendingFromEnd;
      this.restoredAt = `${String(contentHeight)}x${String(viewportHeight)}`;
      this.scrollTo(Math.max(0, target), { disableFollow: true });
      if (target >= 0 || this.atStart) this.pendingFromEnd = undefined;
    } else if (rows !== 0 && !this.isFollowingEnd) this.scrollTo(this.scrollTop + rows, { disableFollow: true });
    this.laidOut();
  }
}

/** Where a transcript was scrolled to when the workspace stepped aside: the agent's identity and the rows below the lines in view. */
interface TranscriptPlace { readonly identity: string; readonly fromEnd: number }

function transcriptPlace(state: AgentsWorkspaceState | undefined): TranscriptPlace | undefined {
  if (!state || !("transcript" in state)) return undefined;
  const place = state.transcript;
  return typeof place === "object" && place !== null && "identity" in place && "fromEnd" in place && typeof place.identity === "string" && typeof place.fromEnd === "number" ? { identity: place.identity, fromEnd: place.fromEnd } : undefined;
}

/** A label of the menu with the provider that offered it. */
interface MenuEntry { readonly action: AgentsAction; readonly provider: AgentsActionProvider }
/** The action menu open on the node `key`, drawn as an overlay of the alternate screen. */
interface Menu {
  readonly key: string;
  /** The node's target, taken again from every list. */
  target: AgentsActionTarget;
  readonly handle: OverlayHandle;
  /** The labels the last read got, in provider order; undefined until the first answer. */
  entries: readonly MenuEntry[] | undefined;
  index: number;
  /** The selected label: also kept while a read lacks it because a provider could not be read. */
  label: string | undefined;
  /** The first label row in view. */
  top: number;
  /** Counts the reads of the labels: only the latest one's answer is taken. */
  generation: number;
  /** The last read's errors, one for every provider whose labels it could not read: shown after the labels it read. */
  failures: readonly string[];
}
interface Notice { readonly text: string; readonly level: "info" | "warning" | "error" | undefined }

/** The selected agent's transcript; replaced as a whole when another agent, attempt or session is selected. */
interface Shown {
  agent: SessionAgent;
  readonly identity: string;
  /** Both undefined when the agent is not owned. */
  readonly source: TranscriptSource | undefined;
  readonly view: TranscriptView | undefined;
  readonly scroll: TranscriptScroll;
  /** Ends the subscription to agent.live; replaced when a refresh brings another stream. */
  unsubscribe: (() => void) | undefined;
  /** The source's calls in order: a call starts after the previous one settled. */
  queue: Promise<unknown>;
  /** Poll on every tick; cleared by the first poll that started with the agent stopped. */
  polling: boolean;
  pollInFlight: boolean;
  loadingEarlier: boolean;
  /** Set by a rejected loadEarlier: no retry on every frame; cleared by a reset or when the user scrolls away from the top. */
  earlierFailed: boolean;
  loadingRecord: boolean;
  status: TranscriptSourceStatus | undefined;
  reason: string | undefined;
  failure: string | undefined;
  atStart: boolean;
}

class Workspace {
  /** The sidebar tree in sidebar order, by key, and as the /workflow tree the navigation runs on. */
  private nodes: readonly SessionTreeNode[] = [];
  private byKey: ReadonlyMap<string, SessionTreeNode> = new Map();
  private tree: WorkflowPhaseTree = navigationTree([]);
  private selectedKey: string | undefined;
  /**
   * The expansion of every key recorded: its initiallyExpanded the first time a list gives its node children (a phase listed
   * before its first agent then expands as /workflow expands it), so a later list never changes it (a run that finishes while
   * shown does not collapse); then left/right, space, an icon click, and [, ] and the initial key for the ancestors of the agent
   * they selected.
   */
  private readonly expansion = new Map<string, boolean>();
  private listed = false;
  /** options.initialKey until a node was selected. */
  private initialKey: string | undefined;
  /** options.state until a node was selected: its selection is taken after the initial key's. */
  private restore: AgentsWorkspaceState | undefined;
  /** Where the transcript was scrolled when the workspace stepped aside; taken by the next transcript opened. */
  private place: TranscriptPlace | undefined;
  private listing = false;
  /** A failed list, or a throw while no transcript is shown; in the title until the next list succeeds. */
  private failure: string | undefined;
  /** The transcript of the selected node when it is an agent. */
  private shown: Shown | undefined;
  /** The right pane of the selected node when it is not an agent, or an agent's on d; a new one for each selection. */
  private detailsScroll: ScrollView | undefined;
  private focus: "sidebar" | "transcript";
  private sidebarVisible: boolean;
  /** The terminal has SIDEBAR_MIN_COLUMNS at least, as the last resize left it. */
  private wide: boolean;
  /** s hid the sidebar while the terminal was wide: a widening does not bring it back. */
  private sidebarHidden: boolean;
  private expanded: boolean;
  /** d: an agent with details shows them instead of its transcript, for every agent selected until d again. */
  private detailsShown: boolean;
  /** f: the selection moves to the running agent with the newest activity on every refresh. */
  private following: boolean;
  /** Follow mode as the menu opened: opening a menu stops it, but a step-aside action hands it back through the state. */
  private followingBeforeMenu = false;
  /** The sidebar filter text; the one-line input under the title is open while `filtering`. */
  private filter: string;
  private filtering = false;
  private matchCache: { readonly nodes: readonly SessionTreeNode[]; readonly filter: string; readonly result: { readonly direct: ReadonlySet<string>; readonly shown: ReadonlySet<string> } } | undefined;
  private menu: Menu | undefined;
  /** The status row's notices (options.notices, an in-place action's), until the next key. */
  private notices: Notice[];
  /** An in-place action runs: every key but ctrl+c is dropped and the ticks wait. */
  private busy = false;
  /** The in-place editor stopped the alternate screen and has the terminal. */
  private editing = false;
  /** An abort arrived while the editor runs: the workspace is left when the editor exits, not before. */
  private leaveAfterEditor = false;
  private sidebarTop = 0;
  /** The node key of each sidebar row of the last frame, for clicks; undefined for a rule. */
  private sidebarKeys: (string | undefined)[] = [];
  private finished = false;
  private readonly styles: WorkflowProgressStyles;
  /** The refresh and poll ticks; started once the first list settled. */
  private timer: ReturnType<typeof setInterval> | undefined;
  private readonly title: Component = { render: (width) => [this.titleRow(Math.max(1, width))], invalidate() {} };
  private readonly filterRow = row(() => this.filtering ? `/ ${this.filter}▏` : "");
  private readonly hint = row(() => this.styles.dim(this.hintText()));
  private readonly status = row(() => this.statusText());
  private readonly sidebar: Component = { render: (width) => this.renderSidebar(width), handleMouse: (event) => this.sidebarMouse(event), invalidate() {} };
  private readonly placeholder = new TranscriptScroll(row(() => this.listed ? "no agents in this Pi session" : "loading agents…"), () => undefined);
  /** The selected node's details, read at every frame, wrapped to the width. */
  private readonly details: Component = { render: (width) => this.detailsLines(width), invalidate() {} };

  constructor(private readonly alt: TuiAltScreen, theme: Theme, private readonly keybindings: KeybindingsManager, private readonly options: AgentsWorkspaceOptions, private readonly leave: (exit?: AgentsWorkspaceExit, cause?: unknown) => void) {
    this.styles = themeWorkflowProgressStyles(theme);
    this.initialKey = options.initialKey;
    // A workspace that stepped aside for an action opens as it was; the sidebar still starts hidden below 80 columns.
    const state = options.state;
    this.restore = state;
    this.place = transcriptPlace(state);
    for (const [key, expanded] of state?.expansion ?? []) this.expansion.set(key, expanded);
    this.wide = alt.terminal.columns >= SIDEBAR_MIN_COLUMNS;
    // A state's sidebar is the one the user wants (state()): hidden only when s hid it while it could show.
    this.sidebarHidden = state?.sidebarVisible === false;
    this.sidebarVisible = this.wide && !this.sidebarHidden;
    this.focus = this.sidebarVisible ? state?.focus ?? "sidebar" : "transcript";
    this.expanded = state?.toolsExpanded ?? false;
    this.detailsShown = state?.detailsShown ?? false;
    this.following = state?.following ?? false;
    this.filter = state?.filter ?? "";
    this.notices = (options.notices ?? []).map((text) => ({ text: clean(text), level: undefined }));
    // Runs after the alt screen's viewport listener (pgup/pgdn, search, the wheel): start() puts gate() before both.
    alt.addInputListener((data) => this.input(data));
    this.rebuild();
    this.refresh();
  }

  /** Leaves now, or once the editor exits when it has the terminal. */
  abort(): void {
    if (this.editing) this.leaveAfterEditor = true;
    else this.leave();
  }

  /** Throws only what the alt screen's stop threw (a terminal that cannot stop), and only after everything else was let go. */
  dispose(): void {
    this.finished = true;
    try {
      if (this.timer) clearInterval(this.timer);
      this.timer = undefined;
      const shown = this.shown;
      this.shown = undefined;
      if (shown) this.close(shown);
    } finally {
      // Last, so its throw skips nothing here; the caller restores Pi after it. Stopped already while the in-place editor runs.
      if (!this.editing) this.alt.stop({ preserveScreen: true });
    }
  }

  /**
   * Starts the alt screen with the terminal's input going through gate() first: the alt screen's own listener (the page keys, its
   * search box, the wheel) runs before any listener added later; and every resize through resized() first, so that the frame the
   * alt screen then draws has the sidebar it wants. The terminal's start is wrapped only while the alt screen starts; the terminal
   * keeps the wrapped handlers until it stops.
   */
  start(): void {
    const terminal = this.alt.terminal;
    const own = Object.getOwnPropertyDescriptor(terminal, "start");
    const start = terminal.start.bind(terminal);
    // The resize handler runs from the terminal's resize event: a throw must stay here.
    terminal.start = (onInput, onResize) => { start((data) => { this.gate(data, onInput); }, () => { this.guard(() => { this.resized(); }); onResize(); }); };
    try { this.alt.start(); } finally {
      if (own) Object.defineProperty(terminal, "start", own);
      else Reflect.deleteProperty(terminal, "start");
    }
  }
  /**
   * The terminal's input before the alt screen sees it. While an in-place action runs or the menu is open the mouse goes nowhere and
   * every key (isKey: a paste too) to the workspace alone: ctrl+c leaves, the menu takes the rest, an action drops them. A key also
   * ends the notices (not one dropped while an action runs). Key releases and what is not a key (a focus report, the terminal's
   * answer to a query) reach the alt screen as they came.
   */
  private gate(data: string, pass: (data: string) => void): void {
    const held = this.busy || this.menu !== undefined;
    if (isMouse(data)) { if (!held) pass(data); return; }
    if (isKeyRelease(data) || !isKey(data)) { pass(data); return; }
    if (!this.busy && this.notices.length > 0) { this.notices = []; this.alt.requestRender(); }
    if (held) this.input(data);
    else pass(data);
  }
  private input(data: string): TuiInputListenerResult {
    // A throw from a view or a component ends as a status line, not in the alt screen's input dispatch.
    try { return this.key(data); } catch (error) { this.report(error); return { consume: true }; }
  }
  private key(data: string): TuiInputListenerResult {
    if (isKeyRelease(data)) return undefined;
    // The editor owns the terminal: no key is the workspace's meanwhile.
    if (this.editing) return { consume: true };
    // ctrl+c leaves at once, also while the search box or the menu is open or an in-place action runs.
    if (matchesKey(data, "ctrl+c")) { this.leave(); return { consume: true }; }
    if (this.busy) return { consume: true };
    const menu = this.menu;
    if (menu) { this.menuKey(menu, data); this.alt.requestRender(); return { consume: true }; }
    // While an overlay (the search box) is open, every other key is its input.
    if (this.alt.hasOverlay()) return undefined;
    if (this.filtering) { this.filterKey(data); this.alt.requestRender(); return { consume: true }; }
    const is = (keybinding: Keybinding): boolean => this.keybindings.matches(data, keybinding);
    // In the sidebar j, k, h and l move as the arrows do, as in /workflow.
    const sidebar = this.focus === "sidebar";
    const moves = (keybinding: Keybinding): boolean => sidebar ? workflowKeyMatches(this.keybindings, data, keybinding) : is(keybinding);
    if (is("tui.select.cancel")) {
      if (this.filter) this.setFilter("");
      else this.leave();
      this.alt.requestRender();
      return { consume: true };
    }
    if (is("tui.input.tab")) { if (this.sidebarVisible) this.focus = sidebar ? "transcript" : "sidebar"; }
    else if (moves("tui.select.up") || moves("tui.select.down")) {
      const up = moves("tui.select.up");
      if (sidebar) this.navigate(up ? "up" : "down");
      else { this.following = false; this.alt.scrollBy(up ? -1 : 1); }
    } else if (sidebar && (moves("tui.editor.cursorLeft") || moves("tui.editor.cursorRight"))) this.navigate(moves("tui.editor.cursorLeft") ? "left" : "right");
    else if (sidebar && matchesKey(data, "space")) { const node = this.selectedNode(); if (node) this.toggle(node); }
    else if (matchesKey(data, "[") || matchesKey(data, "]")) this.jump(matchesKey(data, "[") ? -1 : 1);
    else if (matchesKey(data, "n") || matchesKey(data, "shift+n")) this.jump(matchesKey(data, "n") ? 1 : -1, (node) => node.needsPerson !== undefined);
    // The alt screen binds its top/bottom actions to home/end only; ctrl+home/ctrl+end reach the transcript here.
    else if (matchesKey(data, "ctrl+home")) { this.following = false; this.alt.scrollToTop(); }
    else if (matchesKey(data, "ctrl+end")) { this.following = false; this.alt.scrollToBottom(); }
    else if (sidebar && matchesKey(data, "/")) this.filtering = true;
    else if (matchesKey(data, "f")) this.toggleFollow();
    else if (matchesKey(data, "s")) {
      this.sidebarVisible = !this.sidebarVisible;
      this.sidebarHidden = !this.sidebarVisible && this.wide;
      this.focus = this.sidebarVisible ? "sidebar" : "transcript";
      this.rebuild();
    } else if (is("app.tools.expand")) {
      this.expanded = !this.expanded;
      this.shown?.view?.setExpanded(this.expanded);
    } else if (matchesKey(data, "a")) { const node = this.selectedNode(); if (node) this.openMenu(node); }
    else if (matchesKey(data, "d")) this.toggleDetails();
    else if (is("tui.select.confirm")) {
      // On a node that is not an agent enter opens the menu; on an agent it loads the large record.
      const node = this.selectedNode();
      if (sidebar && node && !node.agent) this.openMenu(node);
      else this.loadLarge();
    } else return undefined;
    this.alt.requestRender();
    return { consume: true };
  }

  /**
   * A resize across SIDEBAR_MIN_COLUMNS: narrower hides the sidebar, wider shows it again, focused, unless s hid it while the
   * terminal was wide; a resize that stays on one side changes nothing, so s still decides there.
   */
  private resized(): void {
    const wide = this.alt.terminal.columns >= SIDEBAR_MIN_COLUMNS;
    if (wide === this.wide) return;
    this.wide = wide;
    const visible = wide && !this.sidebarHidden;
    if (visible === this.sidebarVisible) return;
    this.sidebarVisible = visible;
    this.focus = visible ? "sidebar" : "transcript";
    this.rebuild();
  }

  private rebuild(): void {
    const transcript = new VStack([{ component: this.detailsScroll ?? this.shown?.scroll ?? this.placeholder, grow: 1, basis: 0 }, { component: this.status, shrink: 0 }]);
    // The sidebar sizes itself from the terminal width (basis auto); stack entries shrink by default, so fixed parts need shrink 0.
    const body = new HStack(this.sidebarVisible ? [{ component: this.sidebar, shrink: 0 }, { component: transcript, grow: 1, basis: 0 }] : [{ component: transcript, grow: 1, basis: 0 }]);
    this.alt.setLayoutRoot(new VStack([{ component: this.title, shrink: 0 }, { component: this.filterRow, shrink: 0 }, { component: body, grow: 1, basis: 0 }, { component: this.hint, shrink: 0 }]));
    // Scroll keys and the wheel act on the primary view of the last frame: draw now, not on the next tick, so none reaches a stale layout.
    this.alt.renderNow();
  }

  private selectedNode(): SessionTreeNode | undefined { return this.selectedKey === undefined ? undefined : this.byKey.get(this.selectedKey); }
  private hasDetails(node: SessionTreeNode): boolean { return node.details(this.styles, Date.now()).length > 0; }
  /** The right pane of the selected node's details, scrolled from the top. */
  private detailsPane(): ScrollView { return new ScrollView(this.details, { primary: true, scrollbar: "auto" }); }
  /**
   * What the workspace keeps when it steps aside for an action. The sidebar is the one the user wants: one hidden below 80 columns
   * is kept shown and focused, so that it opens again as a widening brings it back; hidden only when s hid it while it could show.
   */
  private state(): AgentsWorkspaceState {
    const shown = this.shown;
    const fromEnd = shown ? shown.scroll.fromEnd : 0;
    const state: AgentsWorkspaceState & { readonly transcript?: TranscriptPlace } = {
      selectedKey: this.selectedKey,
      row: Math.max(0, this.visible().findIndex((node) => node.key === this.selectedKey)),
      expansion: [...this.expansion],
      focus: !this.sidebarVisible && !this.sidebarHidden ? "sidebar" : this.focus,
      sidebarVisible: !this.sidebarHidden,
      toolsExpanded: this.expanded,
      detailsShown: this.detailsShown,
      ...(this.following ? { following: true } : {}),
      ...(this.filter ? { filter: this.filter } : {}),
      ...(shown && fromEnd > 0 ? { transcript: { identity: shown.identity, fromEnd } } : {}),
    };
    return state;
  }
  private rawExpanded(node: SessionTreeNode): boolean { return this.expansion.get(node.key) ?? node.initiallyExpanded; }
  /** A filter shows every match under its ancestors, whatever the user collapsed. */
  private isExpanded(node: SessionTreeNode): boolean { return this.filterActive() || this.rawExpanded(node); }
  private expandedKeys(): ReadonlySet<string> { return new Set(this.nodes.filter((node) => this.isExpanded(node)).map(({ key }) => key)); }
  /** The nodes whose ancestors are all expanded, in sidebar order. */
  private visible(): SessionTreeNode[] {
    return workflowPhaseTreeVisibleNodes(this.navTree(), this.expandedKeys()).flatMap(({ id }) => this.byKey.get(id) ?? []);
  }
  private fixedRows(): number { return FIXED_ROWS + (this.filtering ? FILTER_ROWS : 0); }
  private filterActive(): boolean { return this.filter.trim() !== ""; }
  /**
   * The nodes the filter keeps: `direct` match (label, run name or short id containing the text, case-insensitive, or the state
   * named by a "state:" prefix), `shown` adds their ancestors. Undefined without a filter.
   */
  private matches(): { readonly direct: ReadonlySet<string>; readonly shown: ReadonlySet<string> } | undefined {
    if (!this.filterActive()) return undefined;
    const cached = this.matchCache;
    if (cached && cached.nodes === this.nodes && cached.filter === this.filter) return cached.result;
    const result = this.computeMatches();
    this.matchCache = { nodes: this.nodes, filter: this.filter, result };
    return result;
  }
  private computeMatches(): { readonly direct: ReadonlySet<string>; readonly shown: ReadonlySet<string> } {
    const text = this.filter.trim().replace(/\s+/g, " ").toLowerCase();
    const wantedState = text.startsWith("state:") ? text.slice("state:".length).trim() : undefined;
    const direct = new Set<string>();
    for (const node of this.nodes) {
      const title = clean(node.title(this.styles)).toLowerCase();
      // A node that is not an agent has its state as the last word of its title; an agent matches by its name, its state by "state:".
      const words = title.split(" ");
      const state = (node.agent?.state ?? words.at(-1) ?? "").toLowerCase();
      const label = node.agent ? clean(node.agent.name).toLowerCase() : words.slice(0, -1).join(" ");
      const id = (node.key.split(":").at(-1) ?? "").toLowerCase();
      if (wantedState === undefined ? label.includes(text) || id.includes(text) : state === wantedState) direct.add(node.key);
    }
    const shown = new Set(direct);
    for (const key of direct) {
      const seen = new Set<string>();
      for (let parent = this.byKey.get(key)?.parentKey; parent !== undefined && !seen.has(parent); parent = this.byKey.get(parent)?.parentKey) { seen.add(parent); shown.add(parent); }
    }
    return { direct, shown };
  }
  /** The /workflow tree navigation runs on: the whole sidebar, or only the nodes a filter keeps. */
  private navTree(): WorkflowPhaseTree {
    const shown = this.matches()?.shown;
    return shown === undefined ? this.tree : navigationTree(this.nodes.filter((node) => shown.has(node.key)));
  }
  /** The selection stays when its node still shows, else moves to the first match. */
  private setFilter(text: string): void {
    this.filter = text;
    this.keepSelectionShown();
  }
  private keepSelectionShown(): void {
    const matches = this.matches();
    if (!matches || !this.nodes.length || (matches.shown.has(this.selectedKey ?? "") && this.selectedNode())) return;
    const first = this.nodes.find((node) => matches.direct.has(node.key));
    if (first) this.select(first);
  }
  private filterKey(data: string): void {
    const is = (keybinding: Keybinding): boolean => this.keybindings.matches(data, keybinding);
    if (is("tui.select.cancel")) { this.filtering = false; this.setFilter(""); }
    else if (is("tui.select.confirm")) { this.filtering = false; this.setFilter(this.filter.trim()); }
    else if (matchesKey(data, "backspace")) this.setFilter(this.filter.replace(/.$/su, ""));
    else if (data.startsWith("\x1b[200~") || isText(data)) this.setFilter(this.filter + sanitizeDisplayText(unpasted(data)).replace(/\s/g, " "));
  }
  /** f: follow mode on or off; on, the selection moves at once. */
  private toggleFollow(): void {
    this.following = !this.following;
    if (this.following) this.follow();
  }
  /** Moves the selection to the follow target and keeps its transcript at the tail. */
  private follow(): void {
    const target = this.followTarget();
    if (target && target.key !== this.selectedKey) { this.reveal(target); this.select(target); }
    this.shown?.scroll.scrollToEnd();
  }
  /** The running agent with the newest activity; a tie or none keeps the selection. */
  private followTarget(): SessionTreeNode | undefined {
    const shown = this.matches()?.shown;
    const running = this.nodes.filter((node) => node.agent?.running && node.agent.lastActivityAt !== undefined && (shown === undefined || shown.has(node.key)));
    const newest = Math.max(...running.map((node) => node.agent?.lastActivityAt ?? 0));
    const best = running.filter((node) => node.agent?.lastActivityAt === newest);
    return best.length === 1 ? best[0] : undefined;
  }
  /** Under a filter every shown node is open: left goes to the parent, right to the first shown child, and the expansion stays as it is. */
  private navigateShown(direction: "left" | "right"): void {
    this.following = false;
    const key = this.selectedKey;
    const next = key === undefined ? undefined : direction === "left" ? this.byKey.get(key)?.parentKey : this.navTree().byId.get(key)?.children[0];
    const node = next === undefined ? undefined : this.byKey.get(next);
    if (node) this.select(node);
  }
  /** Up, down, left and right exactly as in /workflow: navigateWorkflowPhaseTree over the sidebar and its expansion. */
  private navigate(direction: WorkflowPhaseTreeDirection): void {
    if (this.nodes.length === 0) return;
    if (this.filterActive() && (direction === "left" || direction === "right")) { this.navigateShown(direction); return; }
    const expanded = this.expandedKeys();
    this.following = false;
    const next = navigateWorkflowPhaseTree(this.navTree(), this.selectedKey, expanded, direction);
    for (const node of this.nodes) {
      if (next.expandedNodeIds.has(node.key) !== expanded.has(node.key)) this.expansion.set(node.key, next.expandedNodeIds.has(node.key));
    }
    const node = next.nodeId === undefined ? undefined : this.byKey.get(next.nodeId);
    if (node && node.key !== this.selectedKey) this.select(node);
  }
  /** [ and ]: the agent (n and N: the node that needs a person) before or after the selected node in sidebar order, hidden ones included, round at both ends; its ancestors are expanded. */
  private jump(delta: number, wanted: (node: SessionTreeNode) => boolean = (node) => node.agent !== undefined): void {
    const index = this.nodes.findIndex((node) => node.key === this.selectedKey);
    this.following = false;
    const shown = this.matches()?.shown;
    const others = [...this.nodes.slice(index + 1), ...this.nodes.slice(0, Math.max(0, index))].filter((node) => (shown === undefined || shown.has(node.key)) && wanted(node));
    const next = delta > 0 ? others[0] : others.at(-1);
    if (!next) return;
    this.reveal(next);
    this.select(next);
  }
  private reveal(node: SessionTreeNode): void {
    const seen = new Set<string>();
    for (let key = node.parentKey; key !== undefined && !seen.has(key); key = this.byKey.get(key)?.parentKey) {
      seen.add(key);
      this.expansion.set(key, true);
    }
  }
  /** Space and a click on the ▾/▸ icon: a node with children collapses or expands; any other node stays as it is. */
  private toggle(node: SessionTreeNode): void {
    if (this.hasChildren(node) && !this.filterActive()) this.expansion.set(node.key, !this.rawExpanded(node));
  }
  private hasChildren(node: SessionTreeNode): boolean { return (this.tree.byId.get(node.key)?.children.length ?? 0) > 0; }

  private refresh(): void {
    if (this.listing || this.finished) return;
    this.listing = true;
    // A list() that throws synchronously rejects this promise, as one that returns a rejected promise does.
    void new Promise<readonly SessionTreeNode[]>((resolve) => { resolve(this.options.agents.list()); }).then((nodes) => {
      this.listing = false;
      if (this.finished) return;
      this.failure = undefined;
      this.guard(() => { this.apply(nodes); });
      this.startTicks();
    }, (error: unknown) => {
      this.listing = false;
      if (this.finished) return;
      this.failure = `agents unavailable: ${errorText(error)}`;
      this.alt.requestRender();
      this.startTicks();
    });
  }
  /** Refresh and poll every pollIntervalMs from the first settled list on; called again by later lists, it keeps the running interval. */
  private startTicks(): void {
    if (this.timer || this.finished) return;
    this.timer = setInterval(() => {
      // An in-place action holds the screen (the editor stops it): nothing is read until it settles.
      if (this.busy) return;
      this.refresh();
      if (this.shown) this.poll(this.shown);
    }, this.options.pollIntervalMs ?? 1000);
    this.timer.unref();
  }
  /**
   * A new list keeps the selection and the expansion by key; a removed node gives the selection to the node now at its row.
   * A key takes its initiallyExpanded the first time a list gives its node children. Until a node is selected, the initial key
   * (its ancestors expanded), else the state's selection, else the first agent node (its ancestors expanded), else the first node
   * is selected. An open menu reads its labels again, or closes when its node or the node's target went away.
   */
  private apply(nodes: readonly SessionTreeNode[]): void {
    const row = this.visible().findIndex((node) => node.key === this.selectedKey);
    this.listed = true;
    this.nodes = nodes;
    this.byKey = new Map(nodes.map((node) => [node.key, node]));
    this.tree = navigationTree(nodes);
    // A node without children yet (a phase before its first agent) is not recorded: it takes its initiallyExpanded once it has some.
    for (const node of nodes) if (!this.expansion.has(node.key) && this.hasChildren(node)) this.expansion.set(node.key, node.initiallyExpanded);
    const followed = this.following ? this.followTarget() : undefined;
    if (followed) this.reveal(followed);
    let wanted = followed ?? this.selectedNode();
    if (!wanted && this.selectedKey !== undefined) {
      const visible = this.visible();
      wanted = visible[Math.min(Math.max(0, row), visible.length - 1)];
    } else if (!wanted) wanted = this.firstSelection(nodes);
    const matches = this.matches();
    if (matches && wanted && !matches.shown.has(wanted.key)) wanted = this.nodes.find((node) => matches.direct.has(node.key)) ?? wanted;
    //NOTE: a refresh that moves the selected node under a node the user collapsed leaves it selected but hidden.
    const shown = this.shown;
    const agent = wanted?.agent;
    if (wanted && shown && agent && wanted.key === this.selectedKey && identity(agent) === shown.identity) {
      // A live session registered after the agent was opened, or another one, needs its own subscription.
      if (agent.live !== shown.agent.live) {
        shown.unsubscribe?.();
        shown.unsubscribe = shown.view ? this.subscribe(agent, shown.view) : undefined;
      }
      shown.agent = agent;
      if (agent.running) shown.polling = true;
      // With d on, the pane follows the agent's details: emptied by a refresh it shows the transcript, back again the details.
      if (this.detailsShown && this.hasDetails(wanted) !== (this.detailsScroll !== undefined)) {
        this.detailsScroll = this.detailsScroll ? undefined : this.detailsPane();
        this.rebuild();
      }
    } else if (wanted?.key !== this.selectedKey || shown || agent) this.select(wanted);
    const menu = this.menu;
    const target = menu && this.byKey.get(menu.key)?.target;
    if (menu && !target) this.closeMenu();
    else if (menu && target) {
      menu.target = target;
      this.loadMenu(menu);
    }
    // A transcript scrolled away from the tail (page keys, home, the wheel) ends follow mode.
    if (this.following && this.shown) {
      if (this.shown.scroll.isFollowingEnd) this.shown.scroll.scrollToEnd();
      else this.following = false;
    }
    this.alt.requestRender();
  }
  private firstSelection(nodes: readonly SessionTreeNode[]): SessionTreeNode | undefined {
    const initial = this.initialKey === undefined ? undefined : this.byKey.get(this.initialKey);
    const restore = this.restore;
    if (!initial && restore) {
      const kept = restore.selectedKey === undefined ? undefined : this.byKey.get(restore.selectedKey);
      const visible = this.visible();
      const near = kept ?? visible[Math.min(Math.max(0, restore.row), visible.length - 1)];
      if (near) return near;
    }
    const wanted = initial ?? nodes.find((node) => node.agent !== undefined) ?? nodes[0];
    if (wanted) this.reveal(wanted);
    return wanted;
  }

  /** An agent opens its transcript, shown unless d shows its details; any other node shows its details and opens nothing. */
  private select(node: SessionTreeNode | undefined): void {
    const previous = this.shown;
    this.shown = undefined;
    if (previous) this.close(previous);
    this.selectedKey = node?.key;
    if (node) {
      this.initialKey = undefined;
      this.restore = undefined;
    }
    this.detailsScroll = node && (!node.agent || (this.detailsShown && this.hasDetails(node))) ? this.detailsPane() : undefined;
    if (node?.agent) this.shown = this.open(node.agent);
    this.rebuild();
  }
  /** d on an agent with details: its details instead of its transcript, or the transcript again; the transcript goes on polling. */
  private toggleDetails(): void {
    const node = this.selectedNode();
    if (!node?.agent || !this.hasDetails(node)) return;
    this.detailsShown = !this.detailsShown;
    this.detailsScroll = this.detailsShown ? this.detailsPane() : undefined;
    this.rebuild();
  }

  /** a, and enter on a node that is not an agent: the menu of the node's target, only with providers. */
  private openMenu(node: SessionTreeNode): void {
    const target = node.target;
    if (!target || (this.options.actions ?? []).length === 0 || this.menu) return;
    this.followingBeforeMenu = this.following;
    this.following = false;
    const component: Component = { render: (width) => this.menuLines(width), invalidate() {} };
    const menu: Menu = { key: node.key, target, handle: this.alt.showOverlay(component, MENU_OVERLAY), entries: undefined, index: 0, label: undefined, top: 0, generation: 0, failures: [] };
    this.menu = menu;
    this.loadMenu(menu);
  }
  private closeMenu(): void {
    const menu = this.menu;
    this.menu = undefined;
    menu?.handle.hide();
    this.alt.requestRender();
  }
  /**
   * Asks every provider for the target's labels; a later read wins, and the selected label stays selected, else the last one. A
   * provider that cannot be read costs only its own labels: the others show, then a row with its error.
   */
  private loadMenu(menu: Menu): void {
    const generation = ++menu.generation;
    const target = menu.target;
    const current = (): boolean => !this.finished && this.menu === menu && menu.generation === generation;
    void Promise.allSettled((this.options.actions ?? []).map(async (provider) => (await provider.actions(target)).map((action): MenuEntry => ({ action, provider })))).then((results) => {
      if (!current()) return;
      const entries = results.flatMap((result) => result.status === "fulfilled" ? result.value : []);
      const failures = results.flatMap((result) => result.status === "rejected" ? [errorText(result.reason)] : []);
      const kept = entries.findIndex((entry) => entry.action.label === menu.label);
      // The first label until one was selected; the last one when the selected label went away.
      menu.index = kept >= 0 ? kept : menu.label === undefined ? 0 : Math.max(0, entries.length - 1);
      // A label missing because its provider could not be read is still the one to select when the next read has it.
      if (kept >= 0 || failures.length === 0) menu.label = entries[menu.index]?.action.label;
      menu.entries = entries;
      menu.failures = failures;
      this.alt.requestRender();
    });
  }
  /** ↑↓ and j/k move round the labels read, enter runs the selected one, esc, ← and h close; every other key is dropped. */
  private menuKey(menu: Menu, data: string): void {
    const is = (keybinding: Keybinding): boolean => workflowKeyMatches(this.keybindings, data, keybinding);
    const entries = menu.entries ?? [];
    if (is("tui.select.cancel") || is("tui.editor.cursorLeft")) this.closeMenu();
    else if ((is("tui.select.up") || is("tui.select.down")) && entries.length > 0) {
      menu.index = (menu.index + (is("tui.select.up") ? -1 : 1) + entries.length) % entries.length;
      menu.label = entries[menu.index]?.action.label;
    } else if (is("tui.select.confirm")) {
      const entry = entries[menu.index];
      if (entry) this.choose(menu, entry);
    }
  }
  /** An in-place label runs here; any other leaves the workspace for the caller to run it with Pi's dialogs. */
  private choose(menu: Menu, entry: MenuEntry): void {
    this.closeMenu();
    if (entry.action.inPlace) void this.runInPlace(menu.target, entry);
    else this.leave({ target: menu.target, label: entry.action.label, state: { ...this.state(), ...(this.followingBeforeMenu ? { following: true } : {}) } });
  }
  /** Keys and ticks wait until it settles; what it reports, a failure too, is the status row's notice. */
  private async runInPlace(target: AgentsActionTarget, entry: MenuEntry): Promise<void> {
    const label = entry.action.label;
    this.busy = true;
    try {
      //NOTE: an in-place action (a copy, an editor) selects nothing afterwards.
      await entry.provider.run(target, label, this.inPlaceUi(label));
    } catch (error) {
      this.notify(errorText(error), "error");
    } finally {
      this.busy = false;
      if (!this.finished) this.alt.requestRender();
    }
  }
  private notify(message: string, level?: "info" | "warning" | "error"): void {
    if (this.finished) return;
    this.notices.push({ text: clean(message), level });
    this.alt.requestRender();
  }
  /** Only notify and openArtifact work in place; every other method needs Pi's dialogs and fails, naming the label. */
  private inPlaceUi(label: string): ActionUi {
    const refused = (method: string): Error => new Error(`${label}: ${method} needs Pi's dialogs, which the workspace cannot show`);
    return {
      notify: (message, level) => { this.notify(message, level); },
      confirm: () => Promise.reject(refused("confirm")),
      select: () => Promise.reject(refused("select")),
      input: () => Promise.reject(refused("input")),
      editText: () => Promise.reject(refused("editText")),
      reviewCheckpoint: () => Promise.reject(refused("reviewCheckpoint")),
      openArtifact: (artifact, artifactLabel) => openArtifactInEditor(this.editorTui(), this.options.editorCommand?.(), artifact, artifactLabel, (message, level) => { this.notify(message, level); }),
      status: () => { throw refused("status"); },
      setWorkingMessage: () => { throw refused("setWorkingMessage"); },
    };
  }
  /**
   * The external editor takes the terminal from the alternate screen, not from Pi: stopping keeps Pi's screen as it was (no frame
   * of the workspace written into it) and Pi's TUI stays stopped; starting enters the alternate screen again with a full frame.
   * An abort while the editor runs leaves Pi stopped and the terminal with the editor: the workspace is left when the editor
   * exits, so starting then does not enter the alternate screen again but disposes the workspace and gives Pi the terminal back.
   * Once the workspace is left both do nothing.
   */
  private editorTui(): WorkflowTui {
    return {
      stop: () => {
        if (this.finished || this.editing) return false;
        this.alt.stop({ preserveScreen: true });
        this.editing = true;
        return true;
      },
      start: () => {
        if (this.finished || !this.editing) return;
        if (this.leaveAfterEditor) { this.leave(); return; }
        this.editing = false;
        // A terminal that cannot start again goes back to Pi, which reports why the workspace closed.
        try { this.start(); } catch (error) { this.leave(undefined, error); throw error; }
        // The terminal reported no resize while the editor had it: the width is measured again.
        this.guard(() => { this.resized(); });
        this.alt.renderNow(true);
      },
      requestRender: (force) => { if (!this.finished && !this.editing) this.alt.requestRender(force); },
    };
  }
  private open(agent: SessionAgent): Shown {
    const base = { agent, identity: identity(agent), queue: Promise.resolve(), polling: true, pollInFlight: false, loadingEarlier: false, earlierFailed: false, loadingRecord: false, status: undefined, reason: undefined, failure: undefined, atStart: false };
    // The session file of an agent that is not owned is never opened.
    if (!agent.owned) return { ...base, source: undefined, view: undefined, unsubscribe: undefined, scroll: new TranscriptScroll(new Text("transcript unavailable", 0, 0), () => undefined) };
    let source: TranscriptSource | undefined;
    let view: TranscriptView | undefined;
    let unsubscribe: (() => void) | undefined;
    try {
      source = this.options.openSource(agent);
      view = this.options.createView({ ui: this.alt, cwd: agent.cwd });
      view.setExpanded(this.expanded);
      unsubscribe = this.subscribe(agent, view);
      const shown: Shown = { ...base, source, view, unsubscribe, scroll: new TranscriptScroll(view.component, () => { this.laidOut(); }) };
      const place = this.place;
      this.place = undefined;
      if (place?.identity === shown.identity) shown.scroll.restoreFromEnd(place.fromEnd);
      this.poll(shown);
      return shown;
    } catch (error) {
      // What opened before the throw is closed; the agent stays selected with the error as its status line until another attempt or selection.
      this.close({ source, view, unsubscribe, queue: base.queue });
      return { ...base, source: undefined, view: undefined, unsubscribe: undefined, scroll: new TranscriptScroll(row(() => ""), () => undefined), failure: `transcript unavailable: ${errorText(error)}` };
    }
  }
  /** Forwards the message being generated to the view while it is the one shown. */
  private subscribe(agent: SessionAgent, view: TranscriptView): (() => void) | undefined {
    // The listener runs in the agent session's event emitter: a throw from the view must stay here.
    return agent.live?.subscribe((event) => {
      if (this.shown?.view === view) this.guard(() => { view.live(event); this.alt.requestRender(); });
    });
  }
  /** Every step runs even when an earlier one throws: a view that fails to dispose still lets the source close. */
  private close(shown: Pick<Shown, "source" | "view" | "unsubscribe" | "queue">): void {
    this.guard(() => { shown.unsubscribe?.(); });
    this.guard(() => { shown.view?.dispose(); });
    const source = shown.source;
    // Closing waits for the call in flight: the descriptor must not close under a read.
    if (source) void this.call(shown, () => source.close()).catch(() => undefined);
  }

  private call<T>(shown: Pick<Shown, "queue">, operation: () => Promise<T>): Promise<T> {
    const result = shown.queue.then(operation);
    shown.queue = result.catch(() => undefined);
    return result;
  }
  private failed(shown: Shown, error: unknown): void {
    if (this.shown !== shown) return;
    shown.failure = `transcript read failed: ${errorText(error)}`;
    this.alt.requestRender();
  }
  /** Runs work done after a result, a key or a live event; a throw ends as a status line, never as an uncaught exception or unhandled rejection. */
  private guard(step: () => void): boolean {
    try {
      step();
      return true;
    } catch (error) {
      this.report(error);
      return false;
    }
  }
  /** The shown transcript's status line, or the title while none is shown; nothing once the workspace is left. */
  private report(error: unknown): void {
    if (this.finished) return;
    if (this.shown) this.shown.failure = `transcript failed: ${errorText(error)}`;
    else this.failure = `agents workspace failed: ${errorText(error)}`;
    this.alt.requestRender();
  }
  private poll(shown: Shown): void {
    const { source, view } = shown;
    if (!source || !view || !shown.polling || shown.pollInFlight) return;
    shown.pollInFlight = true;
    let last = false;
    void this.call(shown, () => { last = !shown.agent.running; return source.poll(); }).then((result) => {
      shown.pollInFlight = false;
      if (last) shown.polling = false;
      if (this.shown === shown) this.guard(() => { this.applyPoll(shown, view, result); });
    }, (error: unknown) => {
      shown.pollInFlight = false;
      if (last) shown.polling = false;
      this.failed(shown, error);
    });
  }
  /** The source's state is taken first: a view that throws leaves its error as the status line, and the next poll goes on from the source. */
  private applyPoll(shown: Shown, view: TranscriptView, result: TranscriptPoll): void {
    shown.status = result.status;
    shown.reason = result.reason;
    shown.atStart = result.atStart;
    if (result.atStart) shown.scroll.giveUpRestore();
    shown.failure = undefined;
    if (result.reset) {
      shown.earlierFailed = false;
      view.reset();
      shown.scroll.cancelRestore();
      shown.scroll.scrollToEnd();
    }
    if (result.appended.length > 0) view.append(result.appended);
    this.alt.requestRender();
  }
  /** At the top of the transcript, the chunk before the earliest record is loaded once and placed above it; after a failed load, again only once the user left the top and came back. */
  private laidOut(): void {
    const shown = this.shown;
    const { source, view } = shown ?? {};
    if (!shown || !source || !view) return;
    if (shown.scroll.scrollTop !== 0) { shown.earlierFailed = false; return; }
    // Nothing more will load above: a saved place beyond the content is clamped to the top for good.
    if (shown.earlierFailed || shown.atStart || (shown.status !== undefined && shown.status !== "available")) shown.scroll.giveUpRestore();
    if (shown.loadingEarlier || shown.earlierFailed || shown.atStart || shown.status !== "available") return;
    shown.loadingEarlier = true;
    void this.call(shown, () => source.loadEarlier()).then((result) => {
      shown.loadingEarlier = false;
      if (this.shown !== shown) return;
      shown.atStart = result.atStart;
      if (result.atStart) shown.scroll.reachedStart();
      // A chunk the view could not take is not loaded again on every frame either.
      shown.earlierFailed = !this.guard(() => {
        if (result.records.length > 0) {
          const width = this.transcriptWidth();
          const before = view.component.render(width).length;
          view.prepend(result.records);
          shown.scroll.keep(view.component.render(width).length - before);
        }
        this.alt.requestRender();
      });
    }, (error: unknown) => {
      shown.loadingEarlier = false;
      shown.earlierFailed = true;
      this.failed(shown, error);
    });
  }
  private loadLarge(): void {
    const shown = this.shown;
    const { source, view } = shown ?? {};
    const record = view?.pendingLarge().at(-1);
    if (!shown || !source || !view || !record || shown.loadingRecord) return;
    shown.loadingRecord = true;
    void this.call(shown, () => source.loadRecord(record)).then((full) => {
      shown.loadingRecord = false;
      if (this.shown === shown) this.guard(() => { view.replace(full); this.alt.requestRender(); });
    }, (error: unknown) => {
      shown.loadingRecord = false;
      this.failed(shown, error);
    });
  }

  /** The width the layout gives the transcript: the terminal less the sidebar (scrollbar "auto" takes no column). */
  private transcriptWidth(): number {
    const columns = Math.max(1, this.alt.terminal.columns);
    //NOTE: a sidebar wider than the terminal leaves the transcript no column; the measure then uses one.
    return this.sidebarVisible ? Math.max(1, columns - sidebarWidth(columns)) : columns;
  }

  /** "#<position>/<count>" among the agent nodes, the name, state and summary for an agent; the label and state for any other node. */
  private titleText(): string {
    const matches = this.matches();
    const parts = [
      this.baseTitle(),
      ...(this.following ? [this.styles.muted("following")] : []),
      ...(matches ? [this.styles.muted(`${String(matches.direct.size)} ${matches.direct.size === 1 ? "match" : "matches"}`)] : []),
    ];
    return parts.join(" · ");
  }
  private baseTitle(): string {
    const agent = this.shown?.agent;
    const failure = this.failure ? ` ${this.styles.warning(clean(this.failure))}` : "";
    const node = this.selectedNode();
    if (!agent) return node ? `${node.title(this.styles)}${failure}` : `${this.styles.bold(this.listed ? "no agents" : "agents")}${failure}`;
    const agents = this.nodes.filter((candidate) => candidate.agent !== undefined);
    const position = `#${String(agents.findIndex((candidate) => candidate.key === this.selectedKey) + 1)}/${String(agents.length)}`;
    const state = clean(agent.state);
    return [position, this.styles.bold(clean(agent.name)), progressStyleForState(state, this.styles)(state), this.styles.muted(clean(agent.summary))].filter((part) => part).join(" ") + failure;
  }
  /** The session's totals over the listed agents: "running/total agents · tokens · cost"; parts without data are left out. */
  private totalsText(): string {
    const agents = this.nodes.flatMap((node) => node.agent ?? []);
    if (agents.length === 0) return "";
    const tokens = agents.reduce((sum, { tokens: value }) => sum + (value ?? 0), 0);
    const cost = agents.reduce((sum, { cost: value }) => sum + (value ?? 0), 0);
    return [`${String(agents.filter(({ running }) => running).length)}/${String(agents.length)} running`, formatTokens(tokens), formatCost(cost)].filter((part) => part).join(" · ");
  }
  /** The title, with the totals at the right end when they fit beside it; the title keeps its width first. */
  private titleRow(width: number): string {
    const title = this.titleText();
    const totals = this.totalsText();
    const gap = width - visibleWidth(title) - visibleWidth(totals);
    if (!totals || gap < 2) return truncateToWidth(title, width, "…");
    return `${title}${" ".repeat(gap)}${this.styles.muted(totals)}`;
  }
  /** The selected node's details as /workflow shows them, wrapped to the pane. */
  private detailsLines(width: number): string[] {
    const cell = Math.max(1, width);
    return (this.selectedNode()?.details(this.styles, Date.now()) ?? []).flatMap((line) => wrapTextWithAnsi(line, cell).map((part) => truncateToWidth(part, cell, "")));
  }
  private hintText(): string {
    const key = (keybinding: Keybinding, fallback: string): string => this.keybindings.getKeys(keybinding)[0] ?? fallback;
    const pending = (this.shown?.view?.pendingLarge().length ?? 0) > 0;
    const node = this.selectedNode();
    if (this.filtering) return "enter keep filter · esc clear";
    return [
      ...(this.filterActive() ? [`/ filter: ${clean(this.filter)} · esc clear`] : []),
      this.focus === "sidebar" ? "←→/space fold" : "↑↓ scroll",
      ...(this.following ? ["f stop following"] : []),
      "[ ] agent",
      ...(this.nodes.some((candidate) => candidate.needsPerson !== undefined) ? ["n next"] : []),
      ...((this.options.actions ?? []).length > 0 ? ["a menu"] : []),
      ...(node?.agent && this.hasDetails(node) ? ["d details"] : []),
      ...(this.sidebarVisible ? [`${key("tui.input.tab", "tab")} focus`] : []),
      ...(pending ? [`${key("tui.select.confirm", "enter")} load`] : []),
      `${key("tui.altScreen.search", "ctrl+shift+f")} search`,
      "s sidebar",
      `${key("app.tools.expand", "ctrl+o")} tools`,
      "esc back",
    ].join(" · ");
  }
  /** The notices first, until the next key; then the shown transcript's state. */
  private statusText(): string {
    if (this.notices.length > 0) return this.notices.map(({ text, level }) => level === "warning" ? this.styles.warning(text) : level === "error" ? this.styles.error(text) : text).join(" · ");
    const shown = this.shown;
    // A failure first: also an agent whose transcript could not be opened has one, and no source.
    if (shown?.failure) return this.styles.warning(clean(shown.failure));
    if (!shown?.source) return "";
    if (shown.status === "waiting") return this.styles.muted(shown.agent.running ? "waiting for the first message" : "no transcript");
    if (shown.status === "unavailable") return this.styles.muted(shown.reason ? `transcript unavailable: ${clean(shown.reason)}` : "transcript unavailable");
    return shown.agent.running && shown.agent.activity ? this.styles.dim(clean(shown.agent.activity)) : "";
  }

  /**
   * The visible nodes as their rows, as wide as sidebarWidth of the terminal, scrolled to keep the selection in view; a dim rule
   * above every top-level node but the first row shows where one run (or the group) ends and the next begins.
   */
  private renderSidebar(width: number): string[] {
    const total = Math.min(Math.max(1, width), sidebarWidth(Math.max(1, this.alt.terminal.columns)));
    const cell = Math.max(0, total - SEPARATOR.length);
    const height = Math.max(1, this.alt.terminal.rows - this.fixedRows());
    // A rule is a row without a node: nothing selects it, and the scroll counts it.
    const rows = this.visible().flatMap((node, index): { readonly node: SessionTreeNode | undefined }[] => index > 0 && node.parentKey === undefined ? [{ node: undefined }, { node }] : [{ node }]);
    const selectedRow = rows.findIndex(({ node }) => node !== undefined && node.key === this.selectedKey);
    if (selectedRow >= 0 && selectedRow < this.sidebarTop) this.sidebarTop = selectedRow;
    else if (selectedRow >= this.sidebarTop + height) this.sidebarTop = selectedRow - height + 1;
    this.sidebarTop = Math.max(0, Math.min(this.sidebarTop, rows.length - height));
    const visible = rows.slice(this.sidebarTop, this.sidebarTop + height);
    this.sidebarKeys = visible.map(({ node }) => node?.key);
    return Array.from({ length: height }, (_, index) => {
      const shown = visible[index];
      const node = shown?.node;
      const text = node ? node.line(this.styles, node.key === this.selectedKey, this.isExpanded(node)) : shown ? this.styles.dim("─".repeat(cell)) : "";
      return truncateToWidth(`${truncateToWidth(text, cell, "…", true)}${this.styles.dim(SEPARATOR)}`, total, "", true);
    });
  }
  /**
   * The menu: a heading with the target's kind, the label rows ("→ " on the selected one) and a closing rule, in at most rows - 2
   * rows (the heading and the rule go first when there are fewer), scrolled to keep the selected row in view.
   */
  private menuLines(width: number): string[] {
    const menu = this.menu;
    if (!menu) return [];
    const cell = Math.max(1, width);
    const entries = menu.entries ?? [];
    // The labels read, then a row for every provider that could not be read.
    const items = [
      ...entries.map((entry, index) => `${index === menu.index ? "→ " : "  "}${clean(entry.action.label)}`),
      ...menu.failures.map((failure) => this.styles.warning(`actions unavailable: ${clean(failure)}`)),
    ];
    if (items.length === 0) items.push(this.styles.muted(menu.entries ? "no actions" : "loading…"));
    const budget = Math.max(1, this.alt.terminal.rows - this.fixedRows());
    const framed = budget >= 3;
    const room = framed ? budget - 2 : budget;
    const selected = Math.min(menu.index, items.length - 1);
    if (selected < menu.top) menu.top = selected;
    else if (selected >= menu.top + room) menu.top = selected - room + 1;
    menu.top = Math.max(0, Math.min(menu.top, items.length - room));
    const rows = items.slice(menu.top, menu.top + room).map((item) => truncateToWidth(item, cell, "…"));
    if (!framed) return rows;
    const rule = this.styles.dim("─".repeat(cell));
    const heading = truncateToWidth(`${this.styles.dim("─ ")}${this.styles.bold(MENU_TITLES[menu.target.kind])}${this.styles.dim(` ${"─".repeat(cell)}`)}`, cell, "");
    return [heading, ...rows, rule];
  }
  /**
   * A click on a row selects its node, and on its ▾/▸ icon also toggles it; a click on a rule does nothing; the wheel is left to the
   * transcript. While the menu is open or an in-place action runs gate() lets no mouse report through.
   */
  private sidebarMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
    if (event.button !== "left" || (event.type !== "press" && event.type !== "release" && event.type !== "click")) return undefined;
    if (event.type === "click") {
      const key = this.sidebarKeys[event.y];
      const node = key === undefined ? undefined : this.byKey.get(key);
      if (node) {
        this.focus = "sidebar";
        this.following = false;
        // Runs from pi-tui's mouse dispatch, outside input()'s try/catch: a throw here would escape uncaught.
        try {
          // Every row, a header too, draws its icon at column 2 + 2 * depth (SessionTreeNode.line).
          if (event.x === 2 + 2 * node.depth) this.toggle(node);
          if (node.key !== this.selectedKey) this.select(node);
        } catch (error) { this.report(error); }
      }
    }
    // A handled press makes the release a click on this component.
    return { handled: true };
  }
}

/** Resolves once Pi's TUI is back: with the label the workspace left for, undefined when the user just left. */
export const openAgentsWorkspace: OpenAgentsWorkspace = async (ctx, options) => {
  // Awaited inside an async function: a custom that throws synchronously rejects this promise.
  return await ctx.ui.custom<AgentsWorkspaceExit | undefined>((parent, theme, keybindings, done) => {
    const signal = ctx.signal;
    let workspace: Workspace | undefined;
    /** Set before parent.stop(): from then on leaving restarts Pi, exactly once. */
    let stopped = false;
    let left = false;
    const abort = (): void => { if (workspace) workspace.abort(); else leave(); };
    /** `cause`: what closed the workspace (a terminal that cannot start again after the editor), reported as the first error. */
    const leave = (exit?: AgentsWorkspaceExit, cause?: unknown): void => {
      if (left) return;
      left = true;
      signal?.removeEventListener("abort", abort);
      // Each step runs even when one before it throws (a terminal that cannot stop: setRawMode on a closed TTY), and nothing
      // escapes to the key or abort listener: Pi is started again, the command settles, and the first error is reported once.
      let failure = cause === undefined ? undefined : errorText(cause);
      const step = (run: () => void): void => { try { run(); } catch (error) { failure ??= errorText(error); } };
      step(() => { workspace?.dispose(); });
      if (stopped) step(() => { parent.start(); parent.renderNow(false); });
      done(exit);
      if (failure !== undefined) ctx.ui.notify(`agents workspace failed: ${failure}`, "error");
    };
    signal?.addEventListener("abort", abort, { once: true });
    queueMicrotask(() => {
      if (left) return;
      if (signal?.aborted) { leave(); return; }
      let alt: TuiAltScreen | undefined;
      try {
        stopped = true;
        parent.stop({ preserveScreen: true });
        alt = new TuiAltScreen(parent.terminal, parent.getShowHardwareCursor(), undefined, { mouse: true, copyOnSelect: true, scrollToEndIndicator: () => " ↓ latest " });
        workspace = new Workspace(alt, theme, keybindings, options, leave);
        workspace.start();
        alt.renderNow();
      } catch (error) {
        // Pi must not stay stopped: drop what started, then leave gives the terminal back to Pi, settles and reports this error first, once.
        const started = workspace;
        workspace = undefined;
        try { if (started) started.dispose(); else alt?.stop({ preserveScreen: true }); } catch { /* the terminal goes back to Pi in leave */ }
        leave(undefined, error);
      }
    });
    return { render: (width) => [truncateToWidth("opening agents…", Math.max(1, width), "…")], invalidate() {} };
  }, { overlay: true });
};

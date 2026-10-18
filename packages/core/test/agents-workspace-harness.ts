import assert from "node:assert/strict";
import type { TestContext } from "node:test";
import type { ExtensionCommandContext, KeybindingsManager as PiKeybindings, Theme } from "@earendil-works/pi-coding-agent";
import { KeybindingsManager, stripTerminalSequences, TUI_KEYBINDINGS, TuiAltScreen, truncateToWidth, visibleWidth, type Component, type Terminal, type TUI } from "@earendil-works/pi-tui";
import type { AgentsActionProvider, AgentsActionTarget } from "../src/agents-actions-contract.js";
import type { AgentsWorkspaceExit, AgentsWorkspaceState, SessionAgent, SessionAgentsSource, SessionTreeNode, TranscriptView } from "../src/agents-workspace-contract.js";
import { openAgentsWorkspace } from "../src/agents-workspace.js";
import { formatWorkflowTreeLine } from "../src/host-view.js";
import type { RunState } from "../src/index.js";
import type { TranscriptLiveStream, TranscriptPoll, TranscriptRecord, TranscriptSource } from "../src/transcript-source.js";
import type { WorkflowAgentSessionEvent } from "../src/types.js";

/**
 * The fake Pi and terminal the /agents workspace tests open it on (test/agents-workspace.test.ts), shared with the tests that
 * drive it through the action loop with the real providers (test/agents-workspace-actions.test.ts).
 */

export const ESC = "\x1b";
/** homeTmux and endTmux: home and end as tmux and screen send them. */
export const KEY = { up: `${ESC}[A`, down: `${ESC}[B`, left: `${ESC}[D`, right: `${ESC}[C`, home: `${ESC}[H`, homeTmux: `${ESC}[1~`, endTmux: `${ESC}[4~`, ctrlHome: `${ESC}[1;5H`, ctrlEnd: `${ESC}[1;5F`, pageUp: `${ESC}[5~`, pageDown: `${ESC}[6~`, tab: "\t", enter: "\r", escape: ESC, ctrlC: "\x03", ctrlO: "\x0f", search: `${ESC}[102;6u` };
/** A bracketed paste of `text`, as the terminal hands it on. */
export function paste(text: string): string { return `${ESC}[200~${text}${ESC}[201~`; }
export const THEME = { fg: (_color: string, text: string) => text, bold: (text: string) => text } as unknown as Theme;
export const KEYBINDINGS = new KeybindingsManager({ ...TUI_KEYBINDINGS, "app.tools.expand": { defaultKeys: "ctrl+o", description: "Toggle tool output" } }) as unknown as PiKeybindings;

export function tick(): Promise<void> { return new Promise((resolve) => { setImmediate(resolve); }); }
export async function settle(): Promise<void> { for (let round = 0; round < 10; round += 1) await tick(); }

export class FakeTerminal implements Terminal {
  input: ((data: string) => void) | undefined;
  written = "";
  /** Thrown by start() while set. */
  failStart: Error | undefined;
  /** Thrown by stop() while set, before it lets the input go, as a setRawMode on a closed TTY. */
  failStop: Error | undefined;
  /** Calls of stop(), a failing one too: the alt screen stops the terminal on each of its stops. */
  stops = 0;
  /** What the alt screen asked to hear about a resize; set by start(), cleared by stop(). */
  onResize: (() => void) | undefined;
  constructor(public columns: number, public rows: number) {}
  start(onInput: (data: string) => void, onResize: () => void): void { if (this.failStart) throw this.failStart; this.input = onInput; this.onResize = onResize; }
  stop(): void { this.stops += 1; if (this.failStop) throw this.failStop; this.input = undefined; this.onResize = undefined; }
  /** Takes the new size and reports it, as a terminal window resized by the person does. */
  resize(columns: number): void { this.columns = columns; this.onResize?.(); }
  async drainInput(): Promise<void> {}
  write(data: string): void { this.written += data; }
  get kittyProtocolActive(): boolean { return false; }
  moveBy(): void {}
  hideCursor(): void {}
  showCursor(): void {}
  clearLine(): void {}
  clearFromCursor(): void {}
  clearScreen(): void {}
  setTitle(): void {}
  setProgress(): void {}
}

/**
 * The alternate screen last laid out on each terminal. The workspace keeps its TuiAltScreen to itself, and one that shows no
 * agent creates no view that would hand it over, so the harness notes it where the workspace lays it out.
 */
const screens = new WeakMap<Terminal, TuiAltScreen>();
const setLayoutRoot = Object.getOwnPropertyDescriptor(TuiAltScreen.prototype, "setLayoutRoot");
assert.ok(setLayoutRoot);
TuiAltScreen.prototype.setLayoutRoot = function (this: TuiAltScreen, component: Component | undefined): void {
  screens.set(this.terminal, this);
  Reflect.apply(setLayoutRoot.value as (this: TuiAltScreen, component: Component | undefined) => void, this, [component]);
};

export function entry(offset: number, text = `record ${String(offset)}`): TranscriptRecord { return { kind: "entry", offset, bytes: 10, value: { type: "message", text } }; }
export function entries(from: number, count: number): TranscriptRecord[] { return Array.from({ length: count }, (_, index) => entry(from + index)); }
export function large(offset: number): TranscriptRecord { return { kind: "large", offset, bytes: 2_000_000 }; }
export function polled(appended: readonly TranscriptRecord[], options: Partial<TranscriptPoll> = {}): TranscriptPoll { return { status: "available", reset: false, atStart: false, appended, ...options }; }
function label(record: TranscriptRecord): string { return record.kind === "entry" ? typeof record.value.text === "string" ? record.value.text : "" : `${record.kind} ${String(record.offset)}`; }

type Earlier = { readonly records: readonly TranscriptRecord[]; readonly atStart: boolean };
export class FakeSource implements TranscriptSource {
  readonly calls: string[] = [];
  /** Results of the next polls; an error rejects that poll. */
  readonly polls: (TranscriptPoll | Error)[] = [];
  readonly earlier: Earlier[] = [];
  /** Rejects every loadEarlier while set. */
  failEarlier: Error | undefined;
  /** Holds every loadEarlier until it resolves. */
  earlierGate: Promise<void> | undefined;
  overlapped = false;
  private active = 0;
  constructor(readonly key: string) {}
  poll(): Promise<TranscriptPoll> { return this.run("poll", () => { const next = this.polls.shift(); if (next instanceof Error) throw next; return next ?? polled([]); }); }
  async loadEarlier(): Promise<Earlier> { return await this.run("loadEarlier", async () => { if (this.earlierGate) await this.earlierGate; if (this.failEarlier) throw this.failEarlier; return this.earlier.shift() ?? { records: [], atStart: true }; }); }
  loadRecord(record: { readonly offset: number; readonly bytes: number }): Promise<TranscriptRecord> { return this.run(`loadRecord:${String(record.offset)}`, () => entry(record.offset, `full ${String(record.offset)}`)); }
  close(): Promise<void> { return this.run("close", () => undefined); }
  count(name: string): number { return this.calls.filter((call) => call === name).length; }
  /** Every call settles a turn of the event loop later, so overlapping calls would be seen. */
  private async run<T>(name: string, result: () => T): Promise<T> {
    this.calls.push(name);
    this.active += 1;
    if (this.active > 1) this.overlapped = true;
    await tick();
    this.active -= 1;
    return result();
  }
}

export class FakeView implements TranscriptView {
  readonly calls: string[] = [];
  items: TranscriptRecord[] = [];
  readonly component: Component;
  /** append and live throw while set; render throws once. */
  readonly fail: { append?: Error | undefined; live?: Error | undefined; render?: Error | undefined } = {};
  /** `wrap` gives each record a line of `wrap` columns broken at the width, so its height depends on the width. */
  constructor(readonly key: string, readonly ui: TUI, readonly cwd: string, wrap?: number) {
    this.component = { render: (width) => {
      const error = this.fail.render;
      if (error) { this.fail.render = undefined; throw error; }
      return this.lines(width, wrap);
    }, invalidate() {} };
  }
  private lines(width: number, wrap: number | undefined): string[] {
    return this.items.flatMap((item) => {
      const text = `${this.key} ${label(item)}`;
      if (wrap === undefined) return [truncateToWidth(text, width)];
      const line = text.padEnd(wrap, ".");
      return Array.from({ length: Math.ceil(line.length / width) }, (_, index) => line.slice(index * width, (index + 1) * width));
    });
  }
  reset(): void { this.calls.push("reset"); this.items = []; }
  append(records: readonly TranscriptRecord[]): void { this.calls.push(`append:${String(records.length)}`); if (this.fail.append) throw this.fail.append; this.items.push(...records); }
  prepend(records: readonly TranscriptRecord[]): void { this.calls.push(`prepend:${String(records.length)}`); this.items.unshift(...records); }
  replace(record: TranscriptRecord): void { this.calls.push(`replace:${String(record.offset)}`); this.items = this.items.map((item) => item.offset === record.offset ? record : item); }
  pendingLarge(): readonly { readonly offset: number; readonly bytes: number }[] { return this.items.filter((item) => item.kind === "large").map(({ offset, bytes }) => ({ offset, bytes })); }
  setExpanded(expanded: boolean): void { this.calls.push(`expanded:${String(expanded)}`); }
  live(event: WorkflowAgentSessionEvent): void { this.calls.push(`live:${event.type}`); if (this.fail.live) throw this.fail.live; }
  dispose(): void { this.calls.push("dispose"); }
}

export class FakeLive implements TranscriptLiveStream {
  readonly listeners = new Set<(event: WorkflowAgentSessionEvent) => void>();
  unsubscribed = 0;
  /** Events a subscriber gets synchronously while it subscribes, as a stream that replays the message being generated does. */
  readonly replay: WorkflowAgentSessionEvent[] = [];
  subscribe(listener: (event: WorkflowAgentSessionEvent) => void): () => void {
    this.listeners.add(listener);
    for (const event of this.replay) listener(event);
    return () => { this.unsubscribed += 1; this.listeners.delete(listener); };
  }
  emit(event: WorkflowAgentSessionEvent): void { for (const listener of this.listeners) listener(event); }
}

/**
 * A sidebar node: an agent when `agent` is set; nodes come in sidebar order, a parent before its children. `details` is what an
 * agent shows on d (none by default); `target` its action target (none by default).
 */
export interface Spec { readonly key: string; readonly parent?: string; readonly kind?: SessionTreeNode["kind"]; readonly label?: string; readonly state?: RunState; readonly expanded?: boolean; readonly agent?: SessionAgent; readonly details?: readonly string[]; readonly target?: AgentsActionTarget }
/** Nodes drawn with the /workflow row formatter, as the source draws them; a node that is not an agent details itself as "details of <label>" and "state <state>". */
export function tree(specs: readonly Spec[]): SessionTreeNode[] {
  const depths = new Map<string, number>();
  return specs.map((spec) => {
    const depth = spec.parent === undefined ? 0 : (depths.get(spec.parent) ?? 0) + 1;
    depths.set(spec.key, depth);
    const label = spec.agent?.name ?? spec.label ?? spec.key;
    const state = spec.agent ? spec.agent.state === "completed" || spec.agent.state === "failed" ? spec.agent.state : "running" : spec.state ?? "running";
    const kind = spec.kind ?? (spec.agent ? "agent" : "phase");
    const children = specs.filter((child) => child.parent === spec.key).map(({ key }) => key);
    return {
      key: spec.key, parentKey: spec.parent, depth, kind, initiallyExpanded: spec.expanded ?? children.length > 0, agent: spec.agent,
      line: (styles, selected, expanded) => formatWorkflowTreeLine({ kind, label, depth, state, children }, selected, expanded, styles),
      details: () => spec.agent ? spec.details ?? [] : [`details of ${label}`, `state ${state}`],
      title: () => `${label} ${state}`,
      ...(spec.target === undefined ? {} : { target: spec.target }),
    };
  });
}
/** An agent as the tests list it: in `group` (a run, or "Subagents"), `depth` agents below the group's first level. */
export type Listed = SessionAgent & { readonly group?: string; readonly depth?: number };
export function agent(key: string, options: Partial<Listed> = {}): Listed {
  return { key, name: key, state: "running", summary: "gpt-5 1.2k tok", cwd: `/project/${key}`, attempt: 1, owned: true, session: { transport: "pi", sessionId: `${key}-1` }, live: undefined, activity: undefined, running: true, ...options };
}
/** The tree of listed agents: a run node per group ("build a1b2" by default; "Subagents" gives the group node), each agent under the agent before it with a smaller depth. */
export function nodesOf(agents: readonly Listed[]): SessionTreeNode[] {
  const specs: Spec[] = [];
  let group: string | undefined;
  let chain: string[] = [];
  for (const listed of agents) {
    const name = listed.group ?? "build a1b2";
    if (name !== group) {
      group = name;
      const key = name === "Subagents" ? "subagents" : `run:${name}`;
      specs.push({ key, kind: name === "Subagents" ? "group" : "run", label: name });
      chain = [key];
    }
    chain = chain.slice(0, (listed.depth ?? 0) + 1);
    const parent = chain.at(-1);
    specs.push(parent === undefined ? { key: listed.key, agent: listed } : { key: listed.key, parent, agent: listed });
    chain.push(listed.key);
  }
  return tree(specs);
}

/** What Pi's confirm, select and input answer; unset: false, undefined and undefined, as when the person cancels. */
export interface PiAnswers {
  confirm?: (title: string, message: string) => boolean | Promise<boolean>;
  select?: (title: string, options: readonly string[]) => string | undefined | Promise<string | undefined>;
  input?: (title: string, placeholder: string | undefined) => string | undefined | Promise<string | undefined>;
}
/** A custom component Pi shows and has not closed yet, with the options it was shown with. */
export interface PendingCustom {
  readonly component: Component;
  readonly options: { readonly overlay?: boolean; readonly overlayOptions?: unknown } | undefined;
  /** Closes it with no result, as Pi does when the session ends. */
  close(): void;
}

/**
 * Pi as the workspace sees it: a parent TUI that records its calls, on a fake terminal, and a command context whose dialogs,
 * custom, notify, status and working message are recorded. As Pi, it shows one custom component at a time: its confirm, select,
 * input or custom called while another custom is pending would replace that component and leave its promise pending forever
 * (the invariant on createPiActionUi in src/pi-action-ui.ts), so such a call is noted in `violations` and throws.
 */
export interface FakePi {
  readonly terminal: FakeTerminal;
  /** Calls on the fake parent TUI, in order. */
  readonly parent: string[];
  readonly overlays: (boolean | undefined)[];
  readonly notified: string[];
  /**
   * Everything the command asked of Pi's UI, in order: "custom" and "done" around each custom component, "confirm <title> | <message>",
   * "select <title> | <option>, <option>", "input <title> | <placeholder>", "status <key> <text>" ("status <key> -" clears it),
   * "working <message>" and "notify <level>: <message>".
   */
  readonly events: string[];
  /** The dialogs and customs called while another custom was pending; Pi would have left that custom's promise pending. */
  readonly violations: string[];
  /** The custom components Pi shows now, the latest last. */
  readonly customs: PendingCustom[];
  answers: PiAnswers;
  /** Thrown by the fake parent TUI's start() while set, after it was recorded. */
  parentStartError: Error | undefined;
  readonly ctx: ExtensionCommandContext;
  /** The alternate screen the workspace laid out last on this terminal. */
  alt(): TuiAltScreen;
  /** Renders a frame now and returns its rows without escape sequences. */
  screen(): string[];
  send(...keys: string[]): void;
}

/**
 * `fail` makes opening fail before the workspace exists (the cursor query) or after it was built (the terminal's start);
 * `context` adds fields to the command context (cwd, mode, sessionManager, ...).
 */
export function fakePi(options: { columns?: number | undefined; rows?: number | undefined; signal?: AbortSignal | undefined; fail?: "cursor" | "start" | undefined; keybindings?: PiKeybindings | undefined; theme?: Theme | undefined; context?: Readonly<Record<string, unknown>> | undefined } = {}): FakePi {
  const terminal = new FakeTerminal(options.columns ?? 120, options.rows ?? 20);
  if (options.fail === "start") terminal.failStart = new Error("terminal unavailable");
  const parent: string[] = [];
  const parentTui = {
    terminal,
    getShowHardwareCursor: () => { if (options.fail === "cursor") throw new Error("no cursor"); return false; },
    stop(stopOptions?: { preserveScreen?: boolean }) { parent.push(`stop:${String(stopOptions?.preserveScreen)}`); },
    start() { parent.push("start"); if (pi.parentStartError) throw pi.parentStartError; },
    renderNow(force?: boolean) { parent.push(`renderNow:${String(force)}`); },
    // A custom component asks for a frame after each key; nothing to record.
    requestRender() {},
  } as unknown as TUI;
  const overlays: (boolean | undefined)[] = [];
  const notified: string[] = [];
  const events: string[] = [];
  const violations: string[] = [];
  const customs: PendingCustom[] = [];
  /** Throws, after noting it, when `call` would replace a pending custom component. */
  const shown = (call: string): void => {
    events.push(call);
    if (customs.length === 0) return;
    violations.push(call);
    throw new Error(`Pi's ${call.split(" ")[0] ?? call} would replace a pending custom component`);
  };
  const ctx = {
    cwd: "/project",
    ...options.context,
    signal: options.signal,
    ui: {
      custom: <T>(factory: (tui: TUI, theme: Theme, keybindings: PiKeybindings, done: (result: T) => void) => Component, customOptions?: { overlay?: boolean; overlayOptions?: unknown }) => {
        shown("custom");
        return new Promise<T>((resolve) => {
          overlays.push(customOptions?.overlay);
          let entry: PendingCustom | undefined;
          const state = { closed: false };
          const done = (result: T): void => {
            if (state.closed) return;
            state.closed = true;
            const index = entry === undefined ? -1 : customs.indexOf(entry);
            if (index >= 0) customs.splice(index, 1);
            events.push("done");
            resolve(result);
          };
          const component = factory(parentTui, options.theme ?? THEME, options.keybindings ?? KEYBINDINGS, done);
          assert.ok(component.render(40).every((line) => visibleWidth(line) <= 40));
          // A component closed while it was built is not shown.
          if (!state.closed) { entry = { component, options: customOptions, close: () => { done(undefined as T); } }; customs.push(entry); }
        });
      },
      confirm: (title: string, message: string): Promise<boolean> => { shown(`confirm ${title} | ${message}`); return Promise.resolve(pi.answers.confirm?.(title, message) ?? false); },
      select: (title: string, choices: string[]): Promise<string | undefined> => { shown(`select ${title} | ${choices.join(", ")}`); return Promise.resolve(pi.answers.select?.(title, choices)); },
      input: (title: string, placeholder?: string): Promise<string | undefined> => { shown(`input ${title} | ${placeholder ?? ""}`); return Promise.resolve(pi.answers.input?.(title, placeholder)); },
      notify: (message: string, type?: string) => { notified.push(`${type ?? "info"}: ${message}`); events.push(`notify ${type ?? "info"}: ${message}`); },
      setStatus: (key: string, text?: string) => { events.push(`status ${key} ${text ?? "-"}`); },
      setWorkingMessage: (message?: string) => { events.push(`working ${message ?? "-"}`); },
    },
  } as unknown as ExtensionCommandContext;
  const pi: FakePi = {
    terminal, parent, overlays, notified, events, violations, customs, answers: {}, parentStartError: undefined, ctx,
    alt() { const alt = screens.get(terminal); assert.ok(alt, "the workspace laid out its alternate screen"); return alt; },
    screen() { const alt = pi.alt(); alt.renderNow(); return alt.getScreenLines().map((line) => stripTerminalSequences(line)); },
    send(...keys) { for (const key of keys) { assert.ok(terminal.input, "the alt screen reads the terminal"); terminal.input(key); } },
  };
  return pi;
}

export interface Harness extends FakePi {
  agents: Listed[];
  /** Listed instead of the agents' tree while set. */
  nodes: SessionTreeNode[] | undefined;
  /** Rejects every list() while set. */
  listError: Error | undefined;
  /** Thrown synchronously by every list() while set. */
  listThrow: Error | undefined;
  listCalls: number;
  readonly opened: string[];
  readonly sources: FakeSource[];
  readonly views: FakeView[];
  readonly done: Promise<void>;
  left: boolean;
  /** What openAgentsWorkspace resolved with, once it did. */
  exit: AgentsWorkspaceExit | undefined;
  /** The parent TUI's calls when openAgentsWorkspace resolved. */
  parentAtExit: readonly string[] | undefined;
  source(key: string): FakeSource;
  view(key: string): FakeView;
}

export interface OpenOptions {
  columns?: number;
  rows?: number;
  initialKey?: string;
  signal?: AbortSignal;
  wrap?: number;
  fail?: "cursor" | "start";
  listThrow?: Error;
  listGate?: Promise<void>;
  failView?: string;
  failRender?: string;
  setup?: (source: FakeSource) => void;
  nodes?: SessionTreeNode[];
  source?: SessionAgentsSource;
  actions?: readonly AgentsActionProvider[];
  state?: AgentsWorkspaceState;
  notices?: readonly string[];
  editorCommand?: () => string | undefined;
  keybindings?: PiKeybindings;
  /** Pi's theme; the default draws text as it is. */
  theme?: Theme;
}

/**
 * Opens the workspace with fake Pi pieces; `setup` runs for each source before its first poll settles; `wrap` makes views that wrap;
 * `fail` makes opening fail before the workspace exists (the cursor query) or after it was built (the terminal's start);
 * `listThrow` sets harness.listThrow from the start; `listGate` holds every list() until it resolves; createView throws for `failView`;
 * the view of `failRender` throws from its first render; `nodes` sets harness.nodes; `source` lists instead of the harness;
 * `actions`, `state`, `notices` and `editorCommand` go to the workspace as they are.
 */
export async function open(agents: Listed[], options: OpenOptions = {}): Promise<Harness> {
  const pi = fakePi({ columns: options.columns, rows: options.rows, signal: options.signal, fail: options.fail, keybindings: options.keybindings, theme: options.theme });
  const harness: Harness = Object.assign(pi, {
    agents, nodes: options.nodes, listError: undefined, listThrow: options.listThrow, listCalls: 0, opened: [], sources: [], views: [], left: false,
    done: Promise.resolve(), exit: undefined, parentAtExit: undefined,
    source(key: string) { const source = harness.sources.filter((candidate) => candidate.key === key).at(-1); assert.ok(source, `a source for ${key}`); return source; },
    view(key: string) { const view = harness.views.filter((candidate) => candidate.key === key).at(-1); assert.ok(view, `a view for ${key}`); return view; },
  });
  const done = openAgentsWorkspace(pi.ctx, {
    // Not async: a listThrow leaves list() synchronously, as a plain function's throw would.
    agents: { list: () => {
      harness.listCalls += 1;
      if (harness.listThrow) throw harness.listThrow;
      if (options.source) return options.source.list();
      return (options.listGate ?? Promise.resolve()).then(() => { if (harness.listError) throw harness.listError; return harness.nodes ?? nodesOf(harness.agents); });
    } },
    openSource: (selected) => {
      harness.opened.push(selected.key);
      const source = new FakeSource(selected.key);
      options.setup?.(source);
      harness.sources.push(source);
      return source;
    },
    createView: ({ ui: viewUi, cwd }) => {
      const key = harness.opened.at(-1) ?? "";
      if (key === options.failView) throw new Error("no view");
      const view = new FakeView(key, viewUi, cwd, options.wrap);
      if (key === options.failRender) view.fail.render = new Error("render failed");
      harness.views.push(view);
      return view;
    },
    ...(options.initialKey === undefined ? {} : { initialKey: options.initialKey }),
    ...(options.actions === undefined ? {} : { actions: options.actions }),
    ...(options.state === undefined ? {} : { state: options.state }),
    ...(options.notices === undefined ? {} : { notices: options.notices }),
    ...(options.editorCommand === undefined ? {} : { editorCommand: options.editorCommand }),
  });
  Object.assign(harness, { done: done.then((exit) => { harness.exit = exit; harness.parentAtExit = [...pi.parent]; harness.left = true; }) });
  await settle();
  return harness;
}
export async function leave(harness: Harness, key = KEY.ctrlC): Promise<void> {
  harness.send(key);
  await harness.done;
}
export function timers(t: TestContext): void { t.mock.timers.enable({ apis: ["setInterval"] }); }
/** The uncaught exceptions and unhandled rejections seen while the test runs (Pi handles neither). */
export function escapes(t: TestContext): unknown[] {
  const seen: unknown[] = [];
  const record = (error: unknown): void => { seen.push(error); };
  process.on("uncaughtException", record);
  process.on("unhandledRejection", record);
  t.after(() => { process.off("uncaughtException", record); process.off("unhandledRejection", record); });
  return seen;
}
export function polls(harness: Harness): number { return harness.sources.reduce((total, source) => total + source.count("poll"), 0); }
export async function advance(t: TestContext, times = 1): Promise<void> {
  for (let round = 0; round < times; round += 1) {
    t.mock.timers.tick(1000);
    await settle();
  }
}
export function title(pi: FakePi): string { return pi.screen()[0] ?? ""; }
export function rowOf(pi: FakePi, text: string): number { return pi.screen().findIndex((line) => line.includes(text)); }
/** A left click (SGR press and release) on the 0-based screen `column` and `row`. */
export function click(pi: FakePi, column: number, row: number): void { pi.send(`${ESC}[<0;${String(column + 1)};${String(row + 1)}M`, `${ESC}[<0;${String(column + 1)};${String(row + 1)}m`); }
/** The first body row without the transient scrollbar ("auto") drawn in its last column. */
export function topRow(pi: FakePi): string { return (pi.screen()[1] ?? "").replace(/[\s┃█│]+$/, ""); }
/** The sidebar column of every body row, without the vertical separator: rows, rules, and the empty rows below them. */
export function sidebarColumn(pi: FakePi): string[] {
  return pi.screen().slice(1, -1).map((line) => line.includes("│") ? line.slice(0, line.indexOf("│")).trimEnd() : "");
}
/** The rule the sidebar draws above a top-level node, `cell` columns wide. */
export function rule(cell: number): string { return "─".repeat(cell); }
/** The node rows of the sidebar column: no rules, no empty rows. */
export function sidebarRows(pi: FakePi): string[] {
  return sidebarColumn(pi).filter((line) => line && !/^─+$/.test(line));
}
/** Waits (bounded) for the first agent's view: a real source reads the disk, which takes more than a few turns of the event loop. */
export async function opened(harness: Harness): Promise<void> {
  for (let wait = 0; wait < 400 && harness.views.length === 0; wait += 1) await new Promise((resolve) => { setTimeout(resolve, 5); });
  assert.ok(harness.views.length > 0, "the first agent was opened");
}

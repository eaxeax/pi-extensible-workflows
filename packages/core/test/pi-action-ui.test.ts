import assert from "node:assert/strict";
import test from "node:test";
import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import type { AwaitingCheckpoint } from "../src/decoders.js";
import { formatCheckpointReview } from "../src/host-view.js";
import { createPiActionUi } from "../src/pi-action-ui.js";

type Component = { render(width: number): string[]; invalidate(): void; handleInput?(data: string): void; dispose?(): void };
type FakeTui = { terminal: { rows: number; columns: number }; requestRender(): void; stop(): void; start(): void };
type Factory = (tui: FakeTui, theme: { fg(color: string, text: string): string; bold(text: string): string }, keybindings: { matches(data: string, binding: string): boolean }, done: (value: unknown) => void) => Component;
type Drive = (component: Component, tui: FakeTui) => void | Promise<void>;

type Recorded = { notices: [string, string | undefined][]; statuses: [string, string | undefined][]; working: (string | undefined)[]; customs: unknown[]; selects: [string, string[]][]; inputs: [string, string | undefined][]; tui: FakeTui };

/** A Pi command context whose custom() mounts the component on a fake TUI and hands it to `drive`. */
function piContext(mode: "tui" | "rpc", drive: Drive = () => {}, ui: Record<string, unknown> = {}, rows = 24): { ctx: ExtensionCommandContext; recorded: Recorded } {
  const tui: FakeTui = { terminal: { rows, columns: 80 }, requestRender() {}, stop() {}, start() {} };
  const recorded: Recorded = { notices: [], statuses: [], working: [], customs: [], selects: [], inputs: [], tui };
  const context = {
    cwd: "/repo", mode, hasUI: true,
    ui: {
      notify(message: string, level?: string) { recorded.notices.push([message, level]); },
      setStatus(key: string, text: string | undefined) { recorded.statuses.push([key, text]); },
      setWorkingMessage(message?: string) { recorded.working.push(message); },
      select: async (title: string, options: string[]) => { recorded.selects.push([title, options]); return options[1]; },
      input: async (title: string, placeholder?: string) => { recorded.inputs.push([title, placeholder]); return "typed"; },
      confirm: async () => true,
      custom: (factory: Factory, options?: unknown) => new Promise((resolve) => {
        recorded.customs.push(options);
        const component = factory(tui, { fg: (_color, text) => text, bold: (text) => text }, { matches: (data, binding) => data === binding }, (value) => { component.dispose?.(); resolve(value); });
        void drive(component, tui);
      }),
      ...ui,
    },
  };
  return { ctx: context as unknown as ExtensionCommandContext, recorded };
}

const editorCommand = () => undefined;
const checkpoint: AwaitingCheckpoint = { path: "checkpoint/ship", name: "ship", prompt: "Ship it?", context: { entries: Array.from({ length: 30 }, (_, index) => `entry-${String(index)}`), marker: "CONTEXT_END" } };

void test("confirm reports the blocked state around Pi's confirm, even when it fails", async () => {
  const blocked: unknown[][] = [];
  const asked: string[][] = [];
  const { ctx } = piContext("tui", undefined, { confirm: async (title: string, message: string) => { asked.push([title, message]); return true; } });
  const ui = createPiActionUi(ctx, { reportBlocked: (active, label) => { blocked.push(label === undefined ? [active] : [active, label]); }, editorCommand });
  assert.equal(await ui.confirm("Stop workflow?", "Stop it?"), true);
  assert.deepEqual(asked, [["Stop workflow?", "Stop it?"]]);
  assert.deepEqual(blocked, [[true, "Stop workflow?"], [false]]);
  const failing = createPiActionUi(piContext("tui", undefined, { confirm: async () => { throw new Error("dialog closed"); } }).ctx, { reportBlocked: (active, label) => { blocked.push(label === undefined ? [active] : [active, label]); }, editorCommand });
  await assert.rejects(failing.confirm("Delete workflow?", "Delete it?"), /dialog closed/);
  assert.deepEqual(blocked.slice(2), [[true, "Delete workflow?"], [false]]);
  assert.equal(await createPiActionUi(ctx, { editorCommand }).confirm("No reporter", "fine"), true);
});

void test("notify, status, working message, select and input use Pi's UI", async () => {
  const forwarded: [string, string | undefined][] = [];
  const { ctx, recorded } = piContext("rpc");
  const ui = createPiActionUi(ctx, { editorCommand, onNotify: (message, level) => { forwarded.push([message, level]); } });
  ui.notify("Copied run ID.", "info");
  ui.notify("Plain");
  ui.status("Stopping workflow wf...");
  ui.status(undefined);
  ui.setWorkingMessage("working");
  ui.setWorkingMessage();
  assert.equal(await ui.select("Pick", ["a", "b"]), "b");
  assert.equal(await ui.input("Name", "hint"), "typed");
  assert.deepEqual(recorded.notices, [["Copied run ID.", "info"], ["Plain", undefined]]);
  assert.deepEqual(forwarded, [["Copied run ID.", "info"], ["Plain", undefined]]);
  assert.deepEqual(recorded.statuses, [["workflow-stop", "Stopping workflow wf..."], ["workflow-stop", undefined]]);
  assert.deepEqual(recorded.working, ["working", undefined]);
  assert.deepEqual(recorded.selects, [["Pick", ["a", "b"]]]);
  assert.deepEqual(recorded.inputs, [["Name", "hint"]]);
  const bare = createPiActionUi(piContext("rpc", undefined, { select: undefined, input: undefined, setStatus: undefined }).ctx, { editorCommand });
  assert.equal(await bare.select("Pick", ["a"]), undefined);
  assert.equal(await bare.input("Name"), undefined);
  bare.status("ignored");
});

void test("the TUI checkpoint review is a bordered overlay at every height", async () => {
  const frames = new Map<number, string[]>();
  const { ctx, recorded } = piContext("tui", (component, tui) => {
    for (const rows of [5, 7, 10]) { tui.terminal.rows = rows; frames.set(rows, component.render(60)); }
    component.handleInput?.("tui.select.down");
    component.handleInput?.("tui.select.confirm");
  });
  assert.equal(await createPiActionUi(ctx, { editorCommand }).reviewCheckpoint(checkpoint), "Reject");
  assert.deepEqual(recorded.customs, [{ overlay: true, overlayOptions: { anchor: "top-left", width: "100%", maxHeight: "100%", margin: { top: 1 } } }]);
  // Rows are padded to the overlay width; compare their text.
  const frame = (rows: number): string[] => (frames.get(rows) ?? []).map((line) => line.trimEnd());
  // 3 rows inside the border: two content rows and the options on one row.
  const compact = frame(5);
  assert.equal(compact.length, 5);
  assert.match(compact[0] ?? "", /^─{60}$/);
  assert.match(compact.at(-1) ?? "", /^─{60}$/);
  assert.deepEqual(compact.slice(1, 4), ["Name: ship", "Prompt:", "[Approve]  Reject   Cancel"]);
  // 5 rows: the title, one content row and one row per option.
  assert.deepEqual(frame(7).slice(1, -1), ["Checkpoint review", "Name: ship", "→ Approve", "  Reject", "  Cancel"]);
  // 8 rows: title, two content rows, a separator, the options and the hint.
  assert.deepEqual(frame(10).slice(1, -1), ["Checkpoint review", "Name: ship", "Prompt:", "", "→ Approve", "  Reject", "  Cancel", " ↑/k/↓/j/pgup/pgdn scroll · enter select · esc cancel"]);
});

void test("the TUI checkpoint review scrolls, wraps and cancels", async () => {
  const answers: unknown[] = [];
  for (const keys of [["k", "tui.select.confirm"], ["tui.select.cancel"], ["tui.select.up", "tui.select.up", "tui.select.confirm"], ["j", "j", "j", "tui.select.confirm"]]) {
    const { ctx } = piContext("tui", (component) => { for (const key of keys) component.handleInput?.(key); }, {}, 10);
    answers.push(await createPiActionUi(ctx, { editorCommand }).reviewCheckpoint(checkpoint));
  }
  assert.deepEqual(answers, [undefined, undefined, "Reject", "Approve"]);
  let scrolled: string[] = [];
  let top: string[] = [];
  const { ctx } = piContext("tui", (component) => {
    component.render(40);
    for (let index = 0; index < 50; index += 1) component.handleInput?.("tui.select.pageDown");
    scrolled = component.render(40);
    for (let index = 0; index < 50; index += 1) component.handleInput?.("tui.select.pageUp");
    top = component.render(40);
    component.handleInput?.("tui.select.confirm");
  }, {}, 12);
  assert.equal(await createPiActionUi(ctx, { editorCommand }).reviewCheckpoint(checkpoint), "Approve");
  assert.ok(scrolled.some((line) => line.includes("CONTEXT_END")));
  assert.equal(scrolled.length, 12);
  assert.equal(top[2]?.trimEnd(), "Name: ship");
});

void test("outside the TUI the checkpoint review is Pi's select", async () => {
  const { ctx, recorded } = piContext("rpc");
  assert.equal(await createPiActionUi(ctx, { editorCommand }).reviewCheckpoint(checkpoint), "Reject");
  assert.deepEqual(recorded.selects, [[formatCheckpointReview(checkpoint), ["Approve", "Reject", "Cancel"]]]);
  const cancel = piContext("rpc", undefined, { select: async () => "Cancel" });
  assert.equal(await createPiActionUi(cancel.ctx, { editorCommand }).reviewCheckpoint(checkpoint), undefined);
});

void test("editText hosts Pi's editor: enter submits, esc cancels, an empty text cancels", async () => {
  let rendered: string[] = [];
  const typed = piContext("tui", (component) => {
    for (const key of ["h", "i", " ", "t", "h", "e", "r", "e"]) component.handleInput?.(key);
    rendered = component.render(60);
    component.handleInput?.("\r");
  });
  assert.equal(await createPiActionUi(typed.ctx, { editorCommand }).editText("Steer subagent"), "hi there");
  assert.equal(typed.recorded.customs.length, 1);
  assert.equal(typed.recorded.customs[0], undefined, "the editor replaces Pi's editor, not an overlay");
  assert.equal(rendered[0], "Steer subagent");
  assert.ok(rendered.some((line) => line.includes("hi there")));
  assert.equal(rendered.at(-1), "enter submit · esc cancel");
  const cancelled = piContext("tui", (component) => { component.handleInput?.("x"); component.handleInput?.("tui.select.cancel"); });
  assert.equal(await createPiActionUi(cancelled.ctx, { editorCommand }).editText("Steer subagent"), undefined);
  const empty = piContext("tui", (component) => { component.handleInput?.(" "); component.handleInput?.("\r"); });
  assert.equal(await createPiActionUi(empty.ctx, { editorCommand }).editText("Steer subagent"), undefined);
  const rpc = piContext("rpc");
  assert.equal(await createPiActionUi(rpc.ctx, { editorCommand }).editText("Steer subagent"), "typed");
  assert.deepEqual(rpc.recorded.inputs, [["Steer subagent", undefined]]);
});

void test("openArtifact reports a missing editor and otherwise runs the editor on Pi's TUI", async () => {
  const forwarded: string[] = [];
  const artifact = { extension: ".js" as const, content: "return 1;" };
  const missing = piContext("tui");
  await createPiActionUi(missing.ctx, { editorCommand, onNotify: (message) => { forwarded.push(message); } }).openArtifact(artifact, "workflow script");
  assert.deepEqual(missing.recorded.notices, [["Cannot open workflow script: no external editor is configured.", "warning"]]);
  assert.deepEqual(forwarded, ["Cannot open workflow script: no external editor is configured."]);
  assert.deepEqual(missing.recorded.customs, []);
  const rpc = piContext("rpc");
  await createPiActionUi(rpc.ctx, { editorCommand: () => "true" }).openArtifact(artifact, "agent prompt");
  assert.deepEqual(rpc.recorded.notices, [["Cannot open agent prompt: no external editor is configured.", "warning"]]);
  const events: string[] = [];
  const opened = piContext("tui", undefined, {});
  opened.recorded.tui.stop = () => { events.push("stop"); };
  opened.recorded.tui.start = () => { events.push("start"); };
  opened.recorded.tui.requestRender = () => { events.push("render"); };
  await createPiActionUi(opened.ctx, { editorCommand: () => "true" }).openArtifact(artifact, "workflow script");
  assert.deepEqual(events, ["stop", "start", "render"]);
  assert.deepEqual(opened.recorded.notices, []);
  assert.equal(opened.recorded.customs.length, 1);
  const failed = piContext("tui");
  await createPiActionUi(failed.ctx, { editorCommand: () => "false", onNotify: (message) => { forwarded.push(message); } }).openArtifact(artifact, "agent result");
  assert.deepEqual(failed.recorded.notices, [["Cannot open agent result: external editor exited with code 1.", "warning"]]);
  assert.equal(forwarded.at(-1), "Cannot open agent result: external editor exited with code 1.");
});

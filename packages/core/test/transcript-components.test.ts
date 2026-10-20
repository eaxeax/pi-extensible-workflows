import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";
import { initTheme, SettingsManager } from "@earendil-works/pi-coding-agent";
import { type Container, getCapabilities, setCapabilities, stripTerminalSequences, type Terminal, TuiAltScreen, visibleWidth } from "@earendil-works/pi-tui";
import type * as PiTui from "@earendil-works/pi-tui";
import type { WorkflowProgressStyles } from "../src/host-view.js";
import { createTranscriptView, type TranscriptView } from "../src/transcript-components.js";
import type { TranscriptRecord } from "../src/session-transcript.js";

initTheme("dark", false);

// Pi's components read the terminal capabilities of the pi-tui copy pi-coding-agent resolves, which npm may install apart from
// this package's copy; a test that turns images on sets both, or it passes only on a terminal that draws images itself.
const piTui = await import(pathToFileURL(createRequire(import.meta.resolve("@earendil-works/pi-coding-agent")).resolve("@earendil-works/pi-tui")).href) as typeof PiTui;
function withImages(run: () => void): void {
  const [ours, pis] = [getCapabilities(), piTui.getCapabilities()];
  setCapabilities({ ...ours, images: "kitty" });
  piTui.setCapabilities({ ...pis, images: "kitty" });
  try { run(); } finally { setCapabilities(ours); piTui.setCapabilities(pis); }
}

class FakeTerminal implements Terminal {
  readonly columns = 120;
  readonly rows = 40;
  readonly kittyProtocolActive = false;
  readonly writes: string[] = [];
  start(): void { /* no input in tests */ }
  stop(): void { /* nothing to restore */ }
  drainInput(): Promise<void> { return Promise.resolve(); }
  write(data: string): void { this.writes.push(data); }
  moveBy(): void { /* captured writes only */ }
  hideCursor(): void { /* captured writes only */ }
  showCursor(): void { /* captured writes only */ }
  clearLine(): void { /* captured writes only */ }
  clearFromCursor(): void { /* captured writes only */ }
  clearScreen(): void { /* captured writes only */ }
  setTitle(): void { /* captured writes only */ }
  setProgress(): void { /* captured writes only */ }
}

const ESC = String.fromCharCode(27);
const BEL = String.fromCharCode(7);
const C1_CSI = String.fromCharCode(0x9b);
const C1_OSC = String.fromCharCode(0x9d);
/** A title (OSC 0), a clipboard write (OSC 52), a window title report request (CSI 21 t), and C1 forms of CSI and OSC. */
const HOSTILE = `${ESC}]0;TITLE${BEL}${ESC}]52;c;Y2xpcA==${BEL}${ESC}[21t${C1_CSI}6n${C1_OSC}0;TITLE${BEL}`;
const MB = 1024 * 1024;
const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";
/** A colour of its own for each style the theme gives, none of them the terminal's yellow or dim. */
const THEME_COLOURS: Readonly<Record<keyof WorkflowProgressStyles, string>> = { accent: `${ESC}[38;5;201m`, success: `${ESC}[38;5;202m`, error: `${ESC}[38;5;203m`, warning: `${ESC}[38;5;204m`, muted: `${ESC}[38;5;205m`, dim: `${ESC}[38;5;206m`, bold: `${ESC}[38;5;207m` };
const paintWith = (key: keyof WorkflowProgressStyles) => (text: string): string => `${THEME_COLOURS[key]}${text}${ESC}[39m`;
const STYLES: WorkflowProgressStyles = { accent: paintWith("accent"), success: paintWith("success"), error: paintWith("error"), warning: paintWith("warning"), muted: paintWith("muted"), dim: paintWith("dim"), bold: paintWith("bold") };

function setup(cwd = tmpdir(), settings = SettingsManager.inMemory()): { readonly view: TranscriptView; readonly ui: TuiAltScreen; readonly terminal: FakeTerminal; readonly raw: (width?: number) => string[]; readonly text: (width?: number) => string } {
  const terminal = new FakeTerminal();
  const ui = new TuiAltScreen(terminal);
  const view = createTranscriptView({ ui, cwd, styles: STYLES, settings });
  const raw = (width = 80): string[] => {
    const lines = view.component.render(width);
    for (const line of lines) assert.ok(visibleWidth(line) <= width, `wider than ${String(width)}: ${JSON.stringify(stripTerminalSequences(line))}`);
    return lines;
  };
  return { view, ui, terminal, raw, text: (width = 80) => raw(width).map((line) => stripTerminalSequences(line)).join("\n") };
}
/** None of the sequences of HOSTILE, no BEL and no C1 control reach the screen. */
function assertInert(screen: string): void {
  for (const sequence of [`${ESC}]0;`, `${ESC}]52;`, `${ESC}[21t`]) assert.ok(!screen.includes(sequence), JSON.stringify(sequence));
  const controls = Array.from({ length: screen.length }, (_, index) => screen.charCodeAt(index)).filter((code) => code === 7 || (code >= 0x80 && code <= 0x9f));
  assert.deepEqual(controls, []);
}
function entry(offset: number, value: Readonly<Record<string, unknown>>): TranscriptRecord { return { kind: "entry", offset, bytes: 100, value }; }
function message(offset: number, value: Readonly<Record<string, unknown>>): TranscriptRecord { return entry(offset, { type: "message", message: value }); }
function user(offset: number, text: string): TranscriptRecord { return message(offset, { role: "user", content: text }); }
function call(offset: number, id: string, name: string, args: Readonly<Record<string, unknown>>): TranscriptRecord {
  return message(offset, { role: "assistant", content: [{ type: "toolCall", id, name, arguments: args }], stopReason: "toolUse" });
}
function result(offset: number, id: string, name: string, output: string): TranscriptRecord {
  return message(offset, { role: "toolResult", toolCallId: id, toolName: name, content: [{ type: "text", text: output }], isError: false });
}
function count(text: string, part: string): number { return text.split(part).length - 1; }
/** Each part appears, in this order. */
function assertOrder(text: string, parts: readonly string[]): void {
  let from = 0;
  for (const part of parts) {
    const index = text.indexOf(part, from);
    assert.ok(index >= 0, `missing or out of order: ${part}`);
    from = index + part.length;
  }
}
function lines(prefix: string, total: number): string { return Array.from({ length: total }, (_, index) => `${prefix}-${String(index + 1).padStart(2, "0")}`).join("\n"); }

void test("each record kind renders the text it carries, in file order and within the width", () => {
  const { view, text } = setup();
  view.append([
    entry(0, { type: "session", id: "session-1", cwd: "/project" }),
    user(100, "USER-TEXT"),
    message(200, { role: "assistant", content: [{ type: "thinking", thinking: "THINKING-TEXT" }, { type: "text", text: "ASSISTANT-TEXT" }], stopReason: "stop" }),
    call(300, "c1", "bash", { command: "echo BASH-CALL" }),
    result(400, "c1", "bash", "BASH-RESULT"),
    message(500, { role: "bashExecution", command: "echo USER-BASH", output: "USER-BASH-OUTPUT", exitCode: 2, cancelled: false, truncated: false }),
    message(600, { role: "custom", customType: "note", content: "CUSTOM-MESSAGE", display: true }),
    entry(700, { type: "custom_message", customType: "entry-note", content: [{ type: "text", text: "CUSTOM-ENTRY" }], display: true }),
    entry(800, { type: "custom_message", customType: "hidden-note", content: "CUSTOM-HIDDEN", display: false }),
    entry(900, { type: "compaction", summary: "COMPACTION-SUMMARY", tokensBefore: 999, firstKeptEntryId: "a", systemMessage: { role: "system", content: "COMPACTED-SYSTEM" } }),
    message(1000, { role: "compactionSummary", summary: "COMPACTION-MESSAGE", tokensBefore: 99 }),
    entry(1100, { type: "branch_summary", summary: "BRANCH-SUMMARY", fromId: "b" }),
    message(1200, { role: "branchSummary", summary: "BRANCH-MESSAGE", fromId: "c" }),
    message(1300, { role: "system", content: "SYSTEM-PROMPT" }),
    entry(1400, { type: "model_change", provider: "openai", modelId: "gpt-x" }),
    entry(1500, { type: "thinking_level_change", thinkingLevel: "high" }),
    entry(1600, { type: "label", label: "LABEL-X", targetId: "t1" }),
    entry(1700, { type: "session_info", name: "SESSION-NAME" }),
    entry(1800, { type: "context_edit", targetId: "t2", replacement: null }),
    { kind: "large", offset: 1900, bytes: 2 * MB },
    { kind: "unreadable", offset: 2000, bytes: 512 },
  ]);
  text(40);
  assertOrder(text(), [
    "USER-TEXT", "THINKING-TEXT", "ASSISTANT-TEXT", "$ echo BASH-CALL", "BASH-RESULT", "$ echo USER-BASH", "USER-BASH-OUTPUT", "(exit 2)",
    "[note]", "CUSTOM-MESSAGE", "[entry-note]", "CUSTOM-ENTRY", "custom hidden-note (hidden in Pi)", "CUSTOM-HIDDEN",
    "system prompt", "COMPACTED-SYSTEM", "[compaction]", "Compacted from 999 tokens", "[compaction]", "Compacted from 99 tokens", "[branch]", "Branch summary", "[branch]", "Branch summary",
    "system prompt", "SYSTEM-PROMPT", "model: openai/gpt-x", "thinking level: high", "label LABEL-X on t1", "session name: SESSION-NAME",
    "context edit: t2 left out of the model context", "large record · 2.0MB · enter to load", "unreadable record · 512B",
  ]);
  view.setExpanded(true);
  assertOrder(text(), ["COMPACTION-SUMMARY", "COMPACTION-MESSAGE", "BRANCH-SUMMARY", "BRANCH-MESSAGE"]);
  text(40);
});

void test("a branch summary without text draws nothing, as in Pi's chat; one with text draws Pi's block", () => {
  const { view, text } = setup();
  view.append([entry(100, { type: "branch_summary", summary: "", fromId: "a" })]);
  assert.equal(text().trim(), "");
  view.append([entry(200, { type: "branch_summary", summary: "BRANCH-SUMMARY", fromId: "b" })]);
  assert.equal(count(text(), "[branch]"), 1);
  assert.ok(!text().includes("branch_summary"));
});

void test("records and the live message follow Pi's display settings: thinking, output padding, code block indent and images", () => {
  withImages(() => {
    const settings = SettingsManager.inMemory({ hideThinkingBlock: true, outputPad: 0, markdown: { codeBlockIndent: "»» " }, terminal: { showImages: false } });
    const { view, text } = setup(tmpdir(), settings);
    view.append([
      message(100, { role: "assistant", content: [{ type: "thinking", thinking: "THINKING-TEXT" }, { type: "text", text: "```\nCODE-LINE\n```" }], stopReason: "stop" }),
      call(200, "c1", "alpha", {}),
      message(300, { role: "toolResult", toolCallId: "c1", toolName: "alpha", content: [{ type: "image", data: PNG, mimeType: "image/png" }], isError: false }),
    ]);
    view.live({ type: "message_start", message: { role: "assistant", content: [{ type: "thinking", thinking: "LIVE-THINKING" }] } });
    const screen = text();
    assert.ok(!screen.includes("THINKING-TEXT") && !screen.includes("LIVE-THINKING"), screen);
    assert.equal(count(screen, "Thinking..."), 2);
    assert.match(screen, /^»» CODE-LINE/m);
    assert.match(screen, /\[Image: /, "the image as text, not drawn");
  });
});

void test("a tool block draws its image as wide as Pi's image width setting", () => {
  withImages(() => {
    const { view, raw } = setup(tmpdir(), SettingsManager.inMemory({ terminal: { showImages: true, imageWidthCells: 7 } }));
    view.append([
      call(100, "c1", "alpha", {}),
      message(200, { role: "toolResult", toolCallId: "c1", toolName: "alpha", content: [{ type: "image", data: PNG, mimeType: "image/png" }], isError: false }),
    ]);
    const screen = raw().join("\n");
    // A 1x1 image scales up to the widest it may be, so its Kitty sequence names exactly the setting's columns.
    assert.match(screen, new RegExp(`${ESC}_Ga=T[^;]*,c=7,`), JSON.stringify(stripTerminalSequences(screen)));
    assert.ok(!stripTerminalSequences(screen).includes("[Image: "), "drawn, not as text");
  });
});

void test("a skill invocation is drawn as Pi draws it: the skill folded, then the user's own text", () => {
  const { view, text } = setup();
  view.append([user(100, '<skill name="review" location="/skills/review/SKILL.md">\nSKILL-BODY\n</skill>\n\nUSER-ASK')]);
  assertOrder(text(), ["[skill] review", "USER-ASK"]);
  assert.ok(!text().includes("SKILL-BODY") && !text().includes("<skill"));
  view.setExpanded(true);
  assertOrder(text(), ["[skill]", "review", "SKILL-BODY", "USER-ASK"]);
  text(20);
});

void test("terminal sequences in the session file reach the screen as text only", () => {
  const { view, raw, text } = setup();
  view.append([
    user(100, `${ESC}]0;user title${BEL}USER ${ESC}[31mRED${ESC}[0m`),
    message(200, { role: "assistant", content: [{ type: "text", text: `ASSISTANT ${ESC}]52;c;Y2xpcA==${BEL}CLIP` }], stopReason: "stop" }),
    message(300, { role: "system", content: `SYSTEM ${ESC}[2J CLEAR` }),
  ]);
  const screen = raw().join("\n");
  for (const sequence of [`${ESC}]0;`, `${ESC}[31m`, `${ESC}]52;`, `${ESC}[2J`]) assert.ok(!screen.includes(sequence), JSON.stringify(sequence));
  assertOrder(text(), ["USER RED", "ASSISTANT CLIP", "SYSTEM", "CLEAR"]);
});

void test("terminal sequences in tool arguments and details reach the screen and the terminal as text only", () => {
  const { view, ui, terminal, raw, text } = setup();
  ui.addChild(view.component);
  view.append([
    call(100, "c1", "bash", { command: `echo BASH-ARG ${HOSTILE}` }),
    message(200, { role: "toolResult", toolCallId: "c1", toolName: "bash", content: [{ type: "text", text: "BASH-OUTPUT" }], details: { truncation: { truncated: true }, fullOutputPath: `/tmp/FULL-PATH${HOSTILE}` }, isError: false }),
    call(300, "c2", "read", { path: `READ-PATH${HOSTILE}` }),
    call(400, "c3", "edit", { path: `EDIT-PATH${HOSTILE}`, edits: [{ oldText: `OLD${HOSTILE}`, newText: `NEW${HOSTILE}` }] }),
    message(500, { role: "toolResult", toolCallId: "c3", toolName: "edit", content: [{ type: "text", text: "EDITED" }], details: { diff: `+1 DIFF-LINE${HOSTILE}` }, isError: false }),
    call(600, "c4", "write", { path: `WRITE-PATH${HOSTILE}`, content: `WRITE-CONTENT${HOSTILE}` }),
    call(700, "c5", "grep", { pattern: `GREP-PATTERN${HOSTILE}`, path: "." }),
    call(800, "c6", "custom_tool", { query: `GENERIC-ARG${HOSTILE}`, [`GENERIC-KEY${HOSTILE}`]: `GENERIC-VALUE${C1_CSI}6n` }),
    message(900, { role: "bashExecution", command: `echo BANG-ARG ${HOSTILE}`, output: "BANG-OUTPUT", exitCode: 0, cancelled: false, truncated: true, fullOutputPath: `/tmp/BANG-PATH${HOSTILE}` }),
  ]);
  ui.start();
  try {
    for (const expanded of [false, true]) {
      view.setExpanded(expanded);
      assertInert(raw().join("\n"));
      ui.renderNow(true);
    }
  } finally {
    ui.stop();
  }
  // TuiAltScreen closes hyperlinks itself with an OSC 8 that ends in BEL.
  assertInert(terminal.writes.join("").split(`${ESC}]8;;${BEL}`).join(""));
  assertOrder(text(), [
    "$ echo BASH-ARG", "BASH-OUTPUT", "Full output: /tmp/FULL-PATH", "READ-PATH", "EDIT-PATH", "DIFF-LINE", "WRITE-PATH", "WRITE-CONTENT", "GREP-PATTERN",
    "custom_tool", "GENERIC-ARG", "GENERIC-KEY", "GENERIC-VALUE", "$ echo BANG-ARG", "BANG-OUTPUT", "Output truncated. Full output: /tmp/BANG-PATH",
  ]);
});

void test("tool calls of a message that stopped on an error or an abort show that stop and take no later result", () => {
  const stopped = [
    message(100, { role: "assistant", content: [{ type: "toolCall", id: "c1", name: "alpha", arguments: { query: "FAILED-ARGS" } }], stopReason: "error", errorMessage: `UPSTREAM-FAILED ${ESC}]0;x${BEL}` }),
    message(200, { role: "assistant", content: [{ type: "toolCall", id: "c2", name: "beta", arguments: { query: "ABORTED-ARGS" } }], stopReason: "aborted", errorMessage: "Request was aborted" }),
    message(300, { role: "assistant", content: [{ type: "toolCall", id: "c3", name: "gamma", arguments: { query: "BARE-ARGS" } }], stopReason: "error" }),
  ];
  const late = result(400, "c1", "alpha", "LATE-OUTPUT");
  const { view, raw, text } = setup();
  view.append([...stopped, late]);
  const rendered = text();
  assertOrder(rendered, ["alpha", "FAILED-ARGS", "UPSTREAM-FAILED", "beta", "ABORTED-ARGS", "Operation aborted", "gamma", "BARE-ARGS", "Error", "alpha", "{}", "LATE-OUTPUT"]);
  assert.equal(count(rendered, "UPSTREAM-FAILED"), 1);
  assert.equal(count(rendered, "alpha"), 2);
  assert.ok(!rendered.includes("Request was aborted"));
  assertInert(raw().join("\n"));
  const prepended = setup();
  prepended.view.append([late]);
  prepended.view.prepend(stopped);
  assert.equal(prepended.text(), rendered);
});

void test("the empty message an accepted workflow_result leaves when it ends the session is not drawn; any other stop is", () => {
  const closing = (offset: number): TranscriptRecord => message(offset, { role: "assistant", content: [], stopReason: "error", errorMessage: "This operation was aborted" });
  const { view, text } = setup();
  view.append([
    call(100, "w1", "workflow_result", { result: "DONE-VALUE" }),
    entry(150, { type: "custom", customType: "pi-workflows:tool-timing", data: {} }),
    result(200, "w1", "workflow_result", "Result accepted."),
    closing(300),
    user(400, "NEXT-MESSAGE"),
    closing(500),
    message(600, { role: "toolResult", toolCallId: "w2", toolName: "workflow_result", content: [{ type: "text", text: "Result does not match the required schema." }], isError: true }),
    closing(700),
  ]);
  const rendered = text();
  assertOrder(rendered, ["DONE-VALUE", "Result accepted.", "NEXT-MESSAGE", "This operation was aborted", "Result does not match", "This operation was aborted"]);
  assert.equal(count(rendered, "This operation was aborted"), 2);
  const prepended = setup();
  prepended.view.append([closing(300)]);
  prepended.view.prepend([call(100, "w1", "workflow_result", { result: "DONE-VALUE" }), result(200, "w1", "workflow_result", "Result accepted.")]);
  assert.ok(!prepended.text().includes("aborted"));
});

void test("an earlier call prepended with the id of a later call leaves that call its results", () => {
  const older = [user(100, "OLDER"), call(200, "c1", "alpha", { query: "OLDER-ARGS" })];
  const newer = call(300, "c1", "beta", { query: "NEWER-ARGS" });
  const results = [result(400, "c1", "beta", "NEWER-OUTPUT"), result(500, "c1", "beta", "REPEATED-OUTPUT")];
  const { view, text } = setup();
  view.append([newer]);
  view.prepend(older);
  view.append(results);
  const rendered = text();
  assertOrder(rendered, ["OLDER", "alpha", "OLDER-ARGS", "beta", "NEWER-ARGS", "NEWER-OUTPUT", "beta", "{}", "REPEATED-OUTPUT"]);
  assert.equal(count(rendered, "NEWER-OUTPUT"), 1);
  const loaded = setup();
  loaded.view.append([newer, ...results]);
  loaded.view.prepend(older);
  assert.equal(loaded.text(), rendered);
  const whole = setup();
  whole.view.append([...older, newer, ...results]);
  assert.equal(whole.text(), rendered);
});

void test("a tool call and its result form one block, also when the result comes in a later append", () => {
  const records = [user(100, "BEFORE"), call(200, "c1", "alpha", { query: "CALL-ARGS" }), result(300, "c1", "alpha", "PAIRED-OUTPUT"), user(400, "AFTER")];
  const whole = setup();
  whole.view.append(records);
  const text = whole.text();
  assert.equal(count(text, "alpha"), 1);
  assert.equal(count(text, "PAIRED-OUTPUT"), 1);
  assertOrder(text, ["BEFORE", "alpha", "CALL-ARGS", "PAIRED-OUTPUT", "AFTER"]);
  const later = setup();
  later.view.append(records.slice(0, 2));
  assertOrder(later.text(), ["BEFORE", "alpha", "CALL-ARGS"]);
  assert.ok(!later.text().includes("PAIRED-OUTPUT"));
  later.view.append(records.slice(2));
  assert.equal(later.text(), text);
});

void test("an earlier chunk prepended before a loaded result pairs it with its call", () => {
  const earlier = [user(100, "EARLIER"), call(200, "c1", "alpha", { query: "PREPENDED-ARGS" }), call(300, "c2", "beta", { query: "CHUNK-ARGS" }), result(400, "c2", "beta", "CHUNK-OUTPUT")];
  const loaded = [result(500, "c1", "alpha", "PAIRED-OUTPUT"), user(600, "LATER")];
  const { view, text } = setup();
  view.append(loaded);
  assertOrder(text(), ["alpha", "{}", "PAIRED-OUTPUT", "LATER"]);
  view.prepend(earlier);
  const prepended = text();
  assertOrder(prepended, ["EARLIER", "alpha", "PREPENDED-ARGS", "PAIRED-OUTPUT", "beta", "CHUNK-ARGS", "CHUNK-OUTPUT", "LATER"]);
  assert.equal(count(prepended, "alpha"), 1);
  assert.equal(count(prepended, "PAIRED-OUTPUT"), 1);
  assert.ok(!prepended.includes("{}"));
  const whole = setup();
  whole.view.append([...earlier, ...loaded]);
  assert.equal(prepended, whole.text());
});

interface Rewrite { readonly name: string; readonly loaded: readonly TranscriptRecord[]; readonly change: (view: TranscriptView) => void; readonly whole: readonly TranscriptRecord[]; readonly parts: readonly string[]; readonly counts: Readonly<Record<string, number>> }
const olderCall = [call(100, "c1", "alpha", { query: "OLDER-ARGS" }), result(200, "c1", "alpha", "OLDER-OUTPUT")];
const newerCall = [call(300, "c1", "beta", { query: "NEWER-ARGS" }), result(400, "c1", "beta", "NEWER-OUTPUT")];
const firstCall = call(100, "c1", "alpha", { query: "FIRST-ARGS" });
const firstResult = { ...result(200, "c1", "alpha", "FIRST-OUTPUT"), bytes: 2 * MB };
const secondCall = [call(300, "c1", "beta", { query: "SECOND-ARGS" }), result(400, "c1", "beta", "SECOND-OUTPUT")];
const twoResults = [result(400, "c1", "alpha", "FIRST-OUTPUT"), result(500, "c1", "alpha", "SECOND-OUTPUT")];
const laterCall = call(300, "c1", "alpha", { query: "CALL-ARGS" });
const rewrites: readonly Rewrite[] = [
  { name: "an older call and its result prepended before a loaded call of the same id and its result pair by occurrence", loaded: newerCall, change: (view) => { view.prepend(olderCall); }, whole: [...olderCall, ...newerCall],
    parts: ["alpha", "OLDER-ARGS", "OLDER-OUTPUT", "beta", "NEWER-ARGS", "NEWER-OUTPUT"], counts: { alpha: 1, beta: 1, "{}": 0 } },
  { name: "a large record replaced by the result of the first of two calls of one id completes that call", loaded: [firstCall, { kind: "large", offset: 200, bytes: 2 * MB }, ...secondCall], change: (view) => { view.replace(firstResult); }, whole: [firstCall, firstResult, ...secondCall],
    parts: ["alpha", "FIRST-ARGS", "FIRST-OUTPUT", "beta", "SECOND-ARGS", "SECOND-OUTPUT"], counts: { alpha: 1, "{}": 0 } },
  { name: "a call prepended before two loaded results of its id takes the first and leaves the second without a call", loaded: twoResults, change: (view) => { view.prepend([laterCall]); }, whole: [laterCall, ...twoResults],
    parts: ["alpha", "CALL-ARGS", "FIRST-OUTPUT", "alpha", "{}", "SECOND-OUTPUT"], counts: { alpha: 2, "FIRST-OUTPUT": 1 } },
];
for (const { name, loaded, change, whole, parts, counts } of rewrites) {
  void test(name, () => {
    const { view, text } = setup();
    view.append(loaded);
    change(view);
    const rewritten = text();
    assertOrder(rewritten, parts);
    for (const [part, expected] of Object.entries(counts)) assert.equal(count(rewritten, part), expected, part);
    const reference = setup();
    reference.view.append(whole);
    assert.equal(rewritten, reference.text());
  });
}

void test("a large record replaced by a call between a call and its result moves that result", () => {
  const before = call(100, "c1", "alpha", { query: "BEFORE-ARGS" });
  const output = result(300, "c1", "alpha", "MOVED-OUTPUT");
  const between = { ...call(200, "c1", "beta", { query: "BETWEEN-ARGS" }), bytes: 2 * MB };
  const stopped = { ...message(200, { role: "assistant", content: [{ type: "toolCall", id: "c1", name: "gamma", arguments: { query: "STOPPED-ARGS" } }], stopReason: "aborted" }), bytes: 2 * MB };
  for (const [record, parts] of [[between, ["alpha", "BEFORE-ARGS", "beta", "BETWEEN-ARGS", "MOVED-OUTPUT"]], [stopped, ["alpha", "BEFORE-ARGS", "gamma", "STOPPED-ARGS", "Operation aborted", "alpha", "{}", "MOVED-OUTPUT"]]] as const) {
    const { view, text } = setup();
    view.append([before, { kind: "large", offset: 200, bytes: 2 * MB }, output]);
    assertOrder(text(), ["alpha", "BEFORE-ARGS", "MOVED-OUTPUT"]);
    view.replace(record);
    const replaced = text();
    assertOrder(replaced, parts);
    assert.equal(count(replaced, "MOVED-OUTPUT"), 1);
    const whole = setup();
    whole.view.append([before, record, output]);
    assert.equal(replaced, whole.text());
  }
});

void test("replace swaps a large record in place and pendingLarge lists the ones left", () => {
  const { view, text } = setup();
  view.append([user(100, "FIRST"), { kind: "large", offset: 200, bytes: 3 * MB }, call(300, "c1", "alpha", { query: "CALL-ARGS" }), { kind: "large", offset: 400, bytes: 2 * MB }, user(500, "LAST")]);
  assert.deepEqual(view.pendingLarge(), [{ offset: 200, bytes: 3 * MB }, { offset: 400, bytes: 2 * MB }]);
  assert.equal(view.pendingLarge(), view.pendingLarge(), "kept between changes, not found again on every frame");
  assertOrder(text(), ["FIRST", "large record · 3.0MB · enter to load", "alpha", "large record · 2.0MB · enter to load", "LAST"]);
  view.replace({ kind: "entry", offset: 200, bytes: 3 * MB, value: { type: "message", message: { role: "user", content: "LOADED-USER" } } });
  assert.deepEqual(view.pendingLarge(), [{ offset: 400, bytes: 2 * MB }]);
  assertOrder(text(), ["FIRST", "LOADED-USER", "alpha", "large record · 2.0MB · enter to load", "LAST"]);
  assert.ok(!text().includes("3.0MB"));
  view.replace({ ...result(400, "c1", "alpha", "LOADED-RESULT"), bytes: 2 * MB });
  assert.deepEqual(view.pendingLarge(), []);
  const replaced = text();
  assertOrder(replaced, ["FIRST", "LOADED-USER", "alpha", "CALL-ARGS", "LOADED-RESULT", "LAST"]);
  assert.equal(count(replaced, "alpha"), 1);
  assert.ok(!replaced.includes("large record"));
});

void test("setExpanded reaches tool results and bash executions, also those appended later", () => {
  const { view, text } = setup();
  view.append([
    call(100, "c1", "bash", { command: "seq 30" }),
    result(200, "c1", "bash", lines("tool", 30)),
    message(300, { role: "bashExecution", command: "seq 40", output: lines("bang", 40), exitCode: 0, cancelled: false, truncated: false }),
  ]);
  const collapsed = text();
  assert.ok(collapsed.includes("tool-30") && collapsed.includes("bang-40"));
  assert.ok(!collapsed.includes("tool-01") && !collapsed.includes("bang-01"));
  view.setExpanded(true);
  assert.ok(text().includes("tool-01") && text().includes("bang-01"));
  view.append([call(400, "c2", "bash", { command: "seq 30" }), result(500, "c2", "bash", lines("next", 30))]);
  assert.ok(text().includes("next-01"));
  view.setExpanded(false);
  const recollapsed = text();
  assert.ok(recollapsed.startsWith(collapsed));
  assert.ok(!recollapsed.includes("next-01") && recollapsed.includes("next-30"));
});

void test("blocks made after their records were built open as the others when the view is expanded", () => {
  const cases: readonly { readonly name: string; readonly load: (view: TranscriptView) => void; readonly whole: readonly TranscriptRecord[]; readonly shown: readonly string[] }[] = [
    { name: "a result without its call", load: (view) => { view.append([result(100, "c9", "bash", lines("orphan", 30))]); }, whole: [result(100, "c9", "bash", lines("orphan", 30))], shown: ["orphan-01"] },
    {
      name: "a call prepended before two results of its id",
      load: (view) => { view.append([result(200, "c1", "bash", lines("first", 30)), result(300, "c1", "bash", lines("second", 30))]); view.prepend([call(100, "c1", "bash", { command: "seq 30" })]); },
      whole: [call(100, "c1", "bash", { command: "seq 30" }), result(200, "c1", "bash", lines("first", 30)), result(300, "c1", "bash", lines("second", 30))],
      shown: ["first-01", "second-01"],
    },
    {
      name: "a result moved out of its call by a replaced stopped call",
      load: (view) => {
        view.append([call(100, "c1", "bash", { command: "seq 30" }), { kind: "large", offset: 200, bytes: 2 * MB }, result(300, "c1", "bash", lines("moved", 30))]);
        view.replace({ ...message(200, { role: "assistant", content: [{ type: "toolCall", id: "c1", name: "bash", arguments: { command: "false" } }], stopReason: "aborted" }), bytes: 2 * MB });
      },
      whole: [call(100, "c1", "bash", { command: "seq 30" }), message(200, { role: "assistant", content: [{ type: "toolCall", id: "c1", name: "bash", arguments: { command: "false" } }], stopReason: "aborted" }), result(300, "c1", "bash", lines("moved", 30))],
      shown: ["moved-01"],
    },
    {
      name: "a call whose result changes by replace",
      load: (view) => {
        view.append([call(100, "c1", "bash", { command: "seq 30" }), { kind: "large", offset: 200, bytes: 2 * MB }, result(300, "c1", "bash", lines("later", 30))]);
        view.replace({ ...result(200, "c1", "bash", lines("loaded", 30)), bytes: 2 * MB });
      },
      whole: [call(100, "c1", "bash", { command: "seq 30" }), result(200, "c1", "bash", lines("loaded", 30)), result(300, "c1", "bash", lines("later", 30))],
      shown: ["loaded-01", "later-01"],
    },
  ];
  for (const { name, load, whole, shown } of cases) {
    const { view, text } = setup();
    view.setExpanded(true);
    load(view);
    const rendered = text();
    for (const line of shown) assert.ok(rendered.includes(line), `${name}: ${line}`);
    const loaded = setup();
    loaded.view.setExpanded(true);
    loaded.view.append(whole);
    assert.equal(rendered, loaded.text(), name);
  }
});

void test("the live message streams after the last record and, after message_end, stays until its record is appended", () => {
  const { view, raw, text } = setup();
  view.append([user(100, "QUESTION")]);
  view.live({ type: "message_start", message: { role: "user", content: "NOT-STREAMED" } });
  view.live({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "IGNORED" } });
  assert.ok(!text().includes("NOT-STREAMED") && !text().includes("IGNORED"));
  view.live({ type: "message_start", message: { role: "assistant", content: [] } });
  view.live({ type: "message_update", message: { role: "assistant", content: [{ type: "thinking", thinking: "LIVE-THINKING" }, { type: "text", text: "PARTIAL ANSWER" }] }, assistantMessageEvent: { type: "text_delta", delta: "ANSWER" } });
  assertOrder(text(), ["QUESTION", "LIVE-THINKING", "PARTIAL ANSWER"]);
  view.live({ type: "message_update", message: { role: "assistant", content: [{ type: "text", text: `PARTIAL ANSWER GROWS ${ESC}[2J` }] }, assistantMessageEvent: { type: "text_delta", delta: " GROWS" } });
  assert.equal(count(text(), "PARTIAL ANSWER"), 1);
  assert.ok(!raw().join("\n").includes(`${ESC}[2J`));
  assert.ok(!text().includes("LIVE-THINKING"));
  view.live({ type: "message_update", message: { role: "assistant", content: [{ type: "text", text: "PARTIAL ANSWER GROWS MORE" }] } });
  assert.ok(text().includes("PARTIAL ANSWER GROWS MORE"));
  view.append([user(200, "LATER")]);
  assertOrder(text(), ["QUESTION", "LATER", "PARTIAL ANSWER GROWS MORE"]);
  view.live({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "PARTIAL ANSWER GROWS MORE" }] } });
  assertOrder(text(), ["QUESTION", "LATER", "PARTIAL ANSWER GROWS MORE"]);
  view.append([message(300, { role: "assistant", content: [{ type: "text", text: "THE RECORDED ANSWER" }] })]);
  assert.ok(!text().includes("PARTIAL ANSWER"), "the record takes the finished message's place");
  assertOrder(text(), ["QUESTION", "LATER", "THE RECORDED ANSWER"]);
  assert.equal(count(text(), "THE RECORDED ANSWER"), 1);
});

void test("a finished message keeps its height until its own record arrives, past tool results and the next message", () => {
  const { view, text, raw } = setup();
  view.append([user(100, "QUESTION")]);
  const stream = (body: string): void => {
    view.live({ type: "message_start", message: { role: "assistant", content: [] } });
    view.live({ type: "message_update", message: { role: "assistant", content: [{ type: "text", text: body }] } });
  };
  stream("FIRST-LIVE");
  const height = raw().length;
  view.live({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "FIRST-LIVE" }] } });
  assert.equal(raw().length, height, "message_end does not shrink the content");
  view.live({ type: "message_start", message: { role: "toolResult", content: [] } });
  view.live({ type: "message_end", message: { role: "toolResult", content: [] } });
  view.append([result(200, "c1", "bash", "TOOL-OUTPUT")]);
  assert.ok(text().includes("FIRST-LIVE"), "a tool result is not the message's record");
  stream("SECOND-LIVE");
  assertOrder(text(), ["QUESTION", "TOOL-OUTPUT", "FIRST-LIVE", "SECOND-LIVE"]);
  view.append([message(300, { role: "assistant", content: [{ type: "text", text: "FIRST-RECORD" }] })]);
  assert.ok(!text().includes("FIRST-LIVE"));
  assertOrder(text(), ["FIRST-RECORD", "SECOND-LIVE"]);
  view.live({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "SECOND-LIVE" }] } });
  view.reset();
  assert.equal(text(), "", "reset drops a finished message too");
});

void test("a message_update without a message leaves the live message as it was, with no frame", () => {
  const { view, ui, text } = setup();
  view.live({ type: "message_start", message: { role: "assistant", content: [{ type: "text", text: "STARTED" }] } });
  const before = text();
  let frames = 0;
  ui.requestRender = () => { frames += 1; };
  for (const [type, delta] of [["thinking_delta", "THINK"], ["text_delta", "DELTA"]] as const) view.live({ type: "message_update", assistantMessageEvent: { type, delta } });
  assert.equal(text(), before);
  assert.ok(before.includes("STARTED"));
  assert.equal(frames, 0);
});

void test("a bash call uses Pi's built-in renderer and an unknown tool the generic block", () => {
  const { view, text } = setup();
  view.append([call(100, "c1", "bash", { command: "ls -la BUILTIN" }), call(200, "c2", "custom_tool", { query: "GENERIC-ARG", limit: 3 })]);
  const rendered = text();
  assertOrder(rendered, ["$ ls -la BUILTIN", "custom_tool", "\"query\": \"GENERIC-ARG\"", "\"limit\": 3"]);
  assert.ok(!rendered.includes("\"command\""));
});

void test("a failed edit shows only what its records carry, not a diff of the file on disk", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "transcript-components-edit-"));
  try {
    const target = join(cwd, "target.txt");
    await writeFile(target, "CONTEXT-BEFORE\nOLD-LINE\nCONTEXT-AFTER\n");
    const records = [
      call(100, "c1", "edit", { path: "target.txt", edits: [{ oldText: "OLD-LINE", newText: "NEW-LINE" }] }),
      message(200, { role: "toolResult", toolCallId: "c1", toolName: "edit", content: [{ type: "text", text: "EDIT-FAILED" }], isError: true }),
    ];
    const whole = setup(cwd);
    whole.view.append(records);
    await writeFile(target, "CHANGED-BEFORE\nOLD-LINE\nCHANGED-AFTER\n");
    const split = setup(cwd);
    split.view.append(records.slice(0, 1));
    split.view.append(records.slice(1));
    await new Promise((resolve) => setTimeout(resolve, 100));
    const rendered = whole.text();
    assertOrder(rendered, ["edit", "target.txt", "EDIT-FAILED"]);
    for (const part of ["CONTEXT-BEFORE", "CHANGED-BEFORE", "OLD-LINE", "NEW-LINE"]) assert.ok(!rendered.includes(part), part);
    assert.equal(split.text(), rendered);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

void test("a bash call with its result, or stopped, shows no duration the records do not carry", () => {
  const { view, text } = setup();
  view.append([
    call(100, "c1", "bash", { command: "echo DONE" }),
    result(200, "c1", "bash", "DONE-OUTPUT"),
    message(300, { role: "assistant", content: [{ type: "toolCall", id: "c2", name: "bash", arguments: { command: "echo STOPPED" } }], stopReason: "aborted" }),
  ]);
  const rendered = text();
  assertOrder(rendered, ["$ echo DONE", "DONE-OUTPUT", "$ echo STOPPED", "Operation aborted"]);
  assert.ok(!rendered.includes("Took") && !rendered.includes("Elapsed"));
});

void test("reset drops every record and the live message", () => {
  const { view, text } = setup();
  view.append([user(100, "GONE"), { kind: "large", offset: 200, bytes: 2 * MB }]);
  view.live({ type: "message_start", message: { role: "assistant", content: [{ type: "text", text: "LIVE-GONE" }] } });
  view.reset();
  assert.equal(text(), "");
  assert.deepEqual(view.pendingLarge(), []);
  view.append([result(300, "c1", "alpha", "FRESH")]);
  assertOrder(text(), ["alpha", "FRESH"]);
  view.dispose();
});

void test("user text joins its text parts with nothing and leaves images out, as Pi's chat does", () => {
  const { view, text } = setup();
  view.append([message(100, { role: "user", content: [{ type: "text", text: "FIRST-" }, { type: "image", data: "AAAA", mimeType: "image/png" }, { type: "text", text: "SECOND" }] })]);
  assert.ok(text().includes("FIRST-SECOND"), text());
  assert.ok(!text().includes("[image]"));
});

void test("fallback lines take the theme's colours", () => {
  const { view, raw } = setup();
  view.append([{ kind: "unreadable", offset: 100, bytes: 5 }, entry(200, { type: "model_change", provider: "p", modelId: "m" }), message(300, { role: "system", content: "SYSTEM" })]);
  const lines = raw();
  const line = (needle: string): string => lines.find((candidate) => stripTerminalSequences(candidate).includes(needle)) ?? "";
  assert.ok(line("unreadable").includes(THEME_COLOURS.warning) && !line("unreadable").includes(`${ESC}[33m`), JSON.stringify(line("unreadable")));
  assert.ok(line("model: p/m").includes(THEME_COLOURS.dim) && !line("model: p/m").includes(`${ESC}[2m`), JSON.stringify(line("model: p/m")));
});

void test("with thousands of records a live message_update redraws the message without rebuilding the transcript's children, one frame each", () => {
  const { view, ui, text } = setup();
  view.append(Array.from({ length: 3000 }, (_, index) => user(100 + index, `RECORD-${String(index)}`)));
  const root = view.component as Container;
  let frames = 0;
  ui.requestRender = () => { frames += 1; };
  view.live({ type: "message_start", message: { role: "assistant", content: [] } });
  const children = root.children;
  assert.equal(children.length, 3001, "every record and the live message");
  for (let token = 1; token <= 50; token += 1) view.live({ type: "message_update", message: { role: "assistant", content: [{ type: "text", text: "TOKEN ".repeat(token) }] } });
  assert.equal(root.children, children, "the children were not rebuilt");
  assert.equal(frames, 51, "one frame for the start and one for each update");
  assert.ok(text().includes("TOKEN TOKEN"), "the live message shows its tokens");
});

void test("a streaming tool call has a tool block before the message ends, and its arguments grow in place", () => {
  const { view, text } = setup();
  const streamed = (args: Readonly<Record<string, unknown>>) => ({ type: "message_update" as const, message: { role: "assistant", content: [{ type: "toolCall", id: "c1", name: "bash", arguments: args }] } });
  view.live({ type: "message_start", message: { role: "assistant", content: [] } });
  view.live(streamed({ command: "ls STREAMED" }));
  assert.ok(text().includes("$ ls STREAMED"), text());
  view.live(streamed({ command: "ls STREAMED-MORE" }));
  assert.equal(count(text(), "$ ls"), 1);
  assert.ok(text().includes("ls STREAMED-MORE"));
  view.live({ type: "message_end", message: { role: "assistant", content: [] } });
  assert.ok(text().includes("ls STREAMED-MORE"), "the finished message keeps its tool block until its record arrives");
  view.append([call(100, "c1", "bash", { command: "ls RECORDED" })]);
  assert.ok(!text().includes("STREAMED"));
  assert.equal(count(text(), "$ ls"), 1);
});

void test("a tool without a built-in definition (workflow_result) renders Pi's generic block once, with its arguments and result", () => {
  const { view, text } = setup();
  view.append([call(100, "w1", "workflow_result", { result: "DONE-VALUE" }), result(200, "w1", "workflow_result", "accepted-text")]);
  const rendered = text();
  assertOrder(rendered, ["workflow_result", "DONE-VALUE", "accepted-text"]);
  assert.ok(!rendered.includes("Workflow Result Workflow Result"));
});

void test("the records Pi has no component for show as the transcript describes them, expanded; the hidden ones show nothing", () => {
  const parameters = { type: "object", properties: { path: { type: "string" } } };
  // The rows each record draws, trimmed, and the theme style of its first row.
  const cases: readonly (readonly [TranscriptRecord, readonly string[], (keyof WorkflowProgressStyles)?])[] = [
    [entry(0, { type: "session", id: "session-1", cwd: "/private/cwd" }), []],
    [entry(10, { type: "custom", customType: "pi-workflows:tool-timing", data: { toolName: "hidden-timing" } }), []],
    [entry(20, { type: "usage", kind: "cache_warm", provider: "p", model: "m", usage: {} }), []],
    [message(30, { role: "system", content: "You are a secret system prompt" }), ["system prompt", "You are a secret system prompt"], "dim"],
    [message(40, { role: "system", content: "", sections: { preamble: "rule 0\nrule 1", skills: null }, toolsAdded: [{ name: "read", description: "Read a file", parameters }], toolsRemoved: [{ name: "write" }, { name: "edit" }] }),
      ["system prompt", "[preamble]", "rule 0", "rule 1", "[skills] removed", "[tool read]", "Read a file", ...JSON.stringify(parameters, null, 2).split("\n").map((line) => line.trim()), "tools removed: write, edit"], "dim"],
    [message(50, { role: "custom", customType: "steer", content: [{ type: "text", text: "steered text" }], display: false }), ["custom steer (hidden in Pi)", "steered text"], "dim"],
    [message(60, { role: "reviewer", content: "?" }), ["reviewer message"], "dim"],
    [entry(65, { type: "message", message: null }), ["message"], "dim"],
    [entry(70, { type: "custom_message", customType: "ctx", content: "injected context", display: false }), ["custom ctx (hidden in Pi)", "injected context"], "dim"],
    [entry(80, { type: "custom", customType: "other-ext", data: {} }), ["custom other-ext"], "dim"],
    [entry(90, { type: "model_change", provider: "p", modelId: "m" }), ["model: p/m"], "dim"],
    [entry(100, { type: "thinking_level_change", thinkingLevel: "high" }), ["thinking level: high"], "dim"],
    [entry(110, { type: "context_edit", targetId: "t1", replacement: null }), ["context edit: t1 left out of the model context"], "dim"],
    [entry(120, { type: "context_edit", targetId: "t2", replacement: [{ type: "text", text: "replacement text" }] }), ["context edit: t2 replaced in the model context", "replacement text"], "dim"],
    [entry(130, { type: "label", targetId: "t3", label: "checkpoint-1" }), ["label checkpoint-1 on t3"], "dim"],
    [entry(140, { type: "label", targetId: "t4" }), ["label cleared on t4"], "dim"],
    [entry(150, { type: "session_info", name: "Refactor auth" }), ["session name: Refactor auth"], "dim"],
    [entry(160, { type: "future_entry" }), ["future_entry"], "dim"],
    [{ kind: "large", offset: 170, bytes: 2 * MB }, ["large record · 2.0MB · enter to load"], "dim"],
    [{ kind: "unreadable", offset: 180, bytes: 512 }, ["unreadable record · 512B"], "warning"],
  ];
  for (const [record, rows, style] of cases) {
    const { view, raw, text } = setup();
    view.append([record]);
    view.setExpanded(true);
    const label = JSON.stringify(record);
    assert.deepEqual(text().split("\n").map((line) => line.trim()).filter(Boolean), rows, label);
    if (style !== undefined) assert.ok(raw().find((line) => stripTerminalSequences(line).trim())?.includes(THEME_COLOURS[style]), `${label} in ${style}`);
  }
  // Folded, a long body shows its first rows and a count of the rest.
  const folded = setup();
  folded.view.append([message(0, { role: "system", content: Array.from({ length: 15 }, (_, index) => `rule ${String(index)}`).join("\n") })]);
  const rows = folded.text().split("\n").map((line) => line.trim()).filter(Boolean);
  assert.deepEqual(rows.slice(0, 11), ["system prompt", ...Array.from({ length: 10 }, (_, index) => `rule ${String(index)}`)]);
  assert.match(rows.at(-1) ?? "", /^\.\.\. \+5 lines \(.* to expand\)$/);
  assert.equal(rows.length, 12);
});

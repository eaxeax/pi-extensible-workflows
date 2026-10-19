import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after } from "node:test";
import type { ExtensionCommandContext, Theme } from "@earendil-works/pi-coding-agent";
import { KeybindingsManager, stripTerminalSequences, TUI_KEYBINDINGS, visibleWidth } from "@earendil-works/pi-tui";
import type { ActionUi, AgentsAction, AgentsActionProvider, AgentsActionTarget } from "../src/agents-actions-contract.js";
import type { AgentsWorkspaceState, SessionTreeNode } from "../src/agents-workspace-contract.js";
import { createLaunchSnapshot, DEFAULT_SETTINGS, formatWorkflowPhaseDashboard, RunStore, type AgentRecord, type PersistedRun, type RunState } from "../src/index.js";
import { openAgentsWorkspace } from "../src/agents-workspace.js";
import { navigatorSidebarWidth } from "../src/host-view.js";
import { createSessionAgentsSource } from "../src/session-agents.js";
import { advance, agent, KEYBINDINGS, click, entries, entry, ESC, escapes, FakeLive, fakePi, KEY, large, leave, nodesOf, open, opened, paste, polled, polls, rowOf, rule, settle, sidebarColumn, sidebarRows, timers, title as titleRow, topRow, tree, type FakePi, type Listed, type Spec } from "./agents-workspace-harness.js";

const AGENTS = (): Listed[] => [agent("alpha"), agent("beta", { depth: 1, state: "completed", running: false }), agent("scout", { group: "Subagents", state: "failed", running: false })];
/**
 * run:R
 *   P (phase)
 *     O (operation): a, b
 *     c
 * subagents: s
 */
const TREE = (): Spec[] => [
  { key: "run:R", kind: "run", label: "Workflow" },
  { key: "P", parent: "run:R" },
  { key: "O", parent: "P", kind: "operation" },
  { key: "a", parent: "O", agent: agent("a") },
  { key: "b", parent: "O", agent: agent("b", { state: "completed", running: false }) },
  { key: "c", parent: "P", agent: agent("c") },
  { key: "subagents", kind: "group", label: "Subagents" },
  { key: "s", parent: "subagents", agent: agent("s") },
];

/** The title row without the session totals at its right end. */
function title(pi: FakePi): string { return titleRow(pi).replace(/ {2,}\d+\/\d+ running.*$/, ""); }

void test("the workspace opens over Pi on the alternate screen and restores Pi on esc, ctrl+c and abort", async (t) => {
  timers(t);
  for (const exit of ["esc", "ctrl+c", "abort"] as const) {
    const controller = new AbortController();
    const live = new FakeLive();
    const harness = await open([agent("alpha", { live })], { signal: controller.signal });
    assert.deepEqual(harness.overlays, [true]);
    assert.deepEqual(harness.parent, ["stop:true"], exit);
    assert.ok(harness.terminal.written.includes(`${ESC}[?1049h`), "entered the alternate screen");
    assert.equal(harness.left, false);
    if (exit === "abort") controller.abort();
    else harness.send(exit === "esc" ? KEY.escape : KEY.ctrlC);
    await harness.done;
    await settle();
    assert.deepEqual(harness.parent, ["stop:true", "start", "renderNow:false"], exit);
    assert.ok(harness.terminal.written.endsWith(`${ESC}[?1049l${ESC}[?25h${ESC}[?2026l`), "left the alternate screen with Pi's screen kept");
    assert.equal(harness.source("alpha").calls.at(-1), "close");
    assert.equal(harness.view("alpha").calls.at(-1), "dispose");
    assert.equal(live.unsubscribed, 1);
    const polls = harness.source("alpha").count("poll");
    const lists = harness.listCalls;
    await advance(t, 2);
    assert.equal(harness.source("alpha").count("poll"), polls, "no poll after leaving");
    assert.equal(harness.listCalls, lists, "no refresh after leaving");
  }
});

void test("the layout shows the title, the sidebar tree and the transcript at 120 columns, and starts without the sidebar below 80", async (t) => {
  timers(t);
  const wide = await open(AGENTS(), { columns: 120, setup: (source) => { source.polls.push(polled(entries(0, 5))); } });
  const lines = wide.screen();
  assert.equal(lines.length, 20);
  assert.ok(lines.every((line) => visibleWidth(line) <= 120));
  assert.match(lines[0] ?? "", /^#1\/3 alpha running gpt-5 1\.2k tok/);
  assert.deepEqual(sidebarColumn(wide).slice(0, 6), ["  ▾ build a1b2 · ⠦", "→   ▾ alpha · ⠦", "      • beta · ✓", rule(42), "  ▾ Subagents · ⠦", "    • scout · ✗"], "the first agent selected, every row in the /workflow format, a rule above the group");
  assert.match(lines[1] ?? "", /│ alpha record 0/);
  assert.equal((lines.at(-1) ?? "").trimEnd(), "←→/space fold · [ ] agent · tab focus · ctrl+shift+f search · s sidebar · ctrl+o tools · esc back", "the whole hint fits 120 columns");
  await leave(wide);

  const narrow = await open(AGENTS(), { columns: 70, setup: (source) => { source.polls.push(polled(entries(0, 5))); } });
  const narrowLines = narrow.screen();
  assert.ok(narrowLines.every((line) => visibleWidth(line) <= 70));
  assert.equal(narrowLines[1], "alpha record 0");
  assert.ok(!narrowLines.some((line) => line.includes("Subagents")), "sidebar hidden");
  narrow.send("s");
  const shown = narrow.screen();
  assert.ok(shown.some((line) => line.startsWith("  ▾ Subagents")), "s shows the sidebar");
  assert.ok(shown.every((line) => visibleWidth(line) <= 70));
  await leave(narrow);
});

/** The sidebar is drawn: its Subagents group header shows. */
function sidebarShown(pi: FakePi): boolean { return pi.screen().some((line) => line.includes("▾ Subagents")); }

void test("the sidebar hidden below 80 columns comes back focused when the terminal widens to 80 or more, and hides again when it narrows", async (t) => {
  timers(t);
  const harness = await open(AGENTS(), { columns: 70 });
  assert.equal(sidebarShown(harness), false);
  harness.terminal.resize(80);
  assert.equal(sidebarShown(harness), true, "back at 80 columns");
  assert.match(harness.screen().at(-1) ?? "", /^←→\/space fold/, "with the sidebar focused");
  assert.deepEqual(sidebarRows(harness).slice(0, 2), ["  ▾ build a1b2 · ⠦", "→   ▾ alpha · ⠦"], "on the same node");
  assert.ok(harness.screen().every((line) => visibleWidth(line) <= 80));
  harness.terminal.resize(79);
  assert.equal(sidebarShown(harness), false, "hidden again below 80 columns");
  assert.match(harness.screen().at(-1) ?? "", /^↑↓ scroll/, "the transcript has the focus");
  harness.send("s", "s");
  assert.equal(sidebarShown(harness), false);
  harness.terminal.resize(120);
  assert.equal(sidebarShown(harness), true, "hidden with s while it could not show, it comes back");
  assert.match(harness.screen().at(-1) ?? "", /^←→\/space fold/);
  await leave(harness);
});

void test("a sidebar hidden with s while it could show stays hidden across a resize; s still toggles it", async (t) => {
  timers(t);
  const harness = await open(AGENTS());
  harness.send("s");
  for (const columns of [70, 120]) {
    harness.terminal.resize(columns);
    assert.equal(sidebarShown(harness), false, `${String(columns)} columns`);
    assert.match(harness.screen().at(-1) ?? "", /^↑↓ scroll/);
  }
  harness.send("s");
  assert.equal(sidebarShown(harness), true, "s shows it again");
  harness.terminal.resize(70);
  harness.terminal.resize(120);
  assert.equal(sidebarShown(harness), true, "shown with s, it comes back after the terminal narrowed and widened");
  await leave(harness);
});

void test("a resize that stays below 80 columns keeps a sidebar shown with s, and its focus", async (t) => {
  timers(t);
  const harness = await open(AGENTS(), { columns: 70 });
  harness.send("s");
  assert.equal(sidebarShown(harness), true);
  harness.terminal.resize(71);
  assert.equal(sidebarShown(harness), true, "still shown at 71 columns");
  assert.match(harness.screen().at(-1) ?? "", /^←→\/space fold/, "the sidebar keeps the focus");
  harness.send(KEY.tab);
  harness.terminal.resize(75);
  assert.equal(sidebarShown(harness), true, "still shown at 75 columns");
  assert.match(harness.screen().at(-1) ?? "", /^↑↓ scroll/, "the transcript keeps the focus");
  assert.ok(harness.screen().every((line) => visibleWidth(line) <= 75));
  await leave(harness);
});

void test("pgup and pgdn scroll the transcript while the sidebar has focus", async (t) => {
  timers(t);
  const harness = await open(AGENTS(), { setup: (source) => { source.polls.push(polled(entries(0, 100))); } });
  harness.screen();
  const end = harness.alt().viewportTop;
  assert.equal(end, 100 - 18);
  harness.send(KEY.pageUp);
  harness.screen();
  assert.ok(harness.alt().viewportTop < end);
  harness.send(KEY.pageDown);
  harness.screen();
  assert.equal(harness.alt().viewportTop, end);
  harness.send("s", KEY.pageUp);
  harness.screen();
  assert.ok(harness.alt().viewportTop < end, "a key right after the layout changed scrolls the transcript, not a stale view");
  harness.send("s", KEY.pageDown);
  harness.screen();
  assert.equal(harness.alt().viewportTop, end);
  harness.send(KEY.ctrlHome);
  harness.screen();
  assert.equal(harness.alt().viewportTop, 0, "ctrl+home goes to the top of the transcript");
  assert.equal(harness.alt().isFollowingOutput, false);
  await settle();
  harness.send(KEY.ctrlEnd);
  harness.screen();
  assert.equal(harness.alt().viewportTop, end, "ctrl+end goes back to the end");
  assert.equal(harness.alt().isFollowingOutput, true, "and follows new output again");
  assert.match(title(harness), /^#1\/3 alpha/);
  harness.send(KEY.down);
  assert.match(title(harness), /^#2\/3 beta/, "up/down still select agents");
  await leave(harness);
});

void test("up/down move over every node with the sidebar focused and scroll with the transcript focused; tab, s, [ and ] work with any focus", async (t) => {
  timers(t);
  const harness = await open(AGENTS(), { setup: (source) => { source.polls.push(polled(entries(0, 100))); } });
  harness.send(KEY.down);
  await settle();
  assert.match(title(harness), /^#2\/3 beta/);
  harness.send(KEY.down);
  await settle();
  assert.equal(title(harness).trimEnd(), "Subagents running", "the group is a node too");
  harness.send(KEY.down);
  await settle();
  assert.match(title(harness), /^#3\/3 scout/);
  harness.send(KEY.down);
  await settle();
  assert.equal(title(harness).trimEnd(), "build a1b2 running", "wraps around to the first node");
  harness.send(KEY.up);
  await settle();
  assert.match(title(harness), /^#3\/3 scout/);
  harness.send(KEY.down, KEY.down);
  await settle();
  assert.match(title(harness), /^#1\/3 alpha/);
  const end = harness.alt().viewportTop;
  harness.send(KEY.tab, KEY.up);
  harness.screen();
  assert.equal(harness.alt().viewportTop, end - 1, "up scrolls by a line");
  assert.match(title(harness), /^#1\/3 alpha/);
  harness.send(KEY.down);
  harness.screen();
  assert.equal(harness.alt().viewportTop, end);
  harness.send("]");
  await settle();
  assert.match(title(harness), /^#2\/3 beta/, "] selects the next agent with the transcript focused");
  harness.send("[");
  await settle();
  assert.match(title(harness), /^#1\/3 alpha/);
  harness.send(KEY.tab, KEY.down);
  await settle();
  assert.match(title(harness), /^#2\/3 beta/, "tab gave the focus back to the sidebar");
  harness.send("[");
  await settle();
  harness.send("s");
  const hidden = harness.screen();
  assert.ok(!hidden.some((line) => line.includes("Subagents")), "s hides the sidebar");
  assert.equal((hidden[1] ?? "").replace(/[\s┃█│]+$/, ""), `alpha record ${String(100 - 18)}`, "the transcript takes the whole width");
  harness.send(KEY.up);
  harness.screen();
  assert.equal(harness.alt().viewportTop, 100 - 18 - 1, "without the sidebar up/down scroll");
  assert.match(title(harness), /^#1\/3 alpha/);
  harness.send("]");
  await settle();
  assert.match(title(harness), /^#2\/3 beta/);
  harness.send("s");
  assert.ok(harness.screen().some((line) => line.startsWith("  ▾ Subagents")));
  harness.send(KEY.ctrlO);
  assert.deepEqual(harness.view("beta").calls.filter((call) => call.startsWith("expanded")), ["expanded:false", "expanded:true"]);
  harness.send("[");
  await settle();
  assert.ok(harness.view("alpha").calls.includes("expanded:true"), "a new view keeps tool output expanded");
  await leave(harness);
});

void test("while the search box is open s and q reach it and ctrl+c still leaves", async (t) => {
  timers(t);
  const harness = await open(AGENTS(), { setup: (source) => { source.polls.push(polled(entries(0, 30))); } });
  harness.send(KEY.search);
  assert.equal(harness.alt().hasOverlay(), true);
  harness.send("s", "q");
  const lines = harness.screen();
  assert.ok(lines.some((line) => line.includes("sq")), "the search box got the keys");
  assert.ok(lines.some((line) => line.startsWith("  ▾ Subagents")), "s did not hide the sidebar");
  harness.send(KEY.escape);
  assert.equal(harness.alt().hasOverlay(), false, "esc closes the search box first");
  assert.equal(harness.left, false);
  harness.send(KEY.search, KEY.ctrlC);
  await harness.done;
  assert.deepEqual(harness.parent, ["stop:true", "start", "renderNow:false"]);
});

void test("a click on a sidebar row selects that agent and the wheel over the sidebar scrolls the transcript", async (t) => {
  timers(t);
  const harness = await open(AGENTS(), { setup: (source) => { source.polls.push(polled(entries(0, 100))); } });
  const row = rowOf(harness, "scout");
  assert.ok(row > 0);
  harness.send(`${ESC}[<0;5;${String(row + 1)}M`, `${ESC}[<0;5;${String(row + 1)}m`);
  await settle();
  assert.match(title(harness), /^#3\/3 scout/);
  assert.deepEqual(harness.opened, ["alpha", "scout"]);
  harness.send("[", "[");
  await settle();
  assert.match(title(harness), /^#1\/3 alpha/);
  const end = harness.alt().viewportTop;
  harness.send(`${ESC}[<64;5;${String(row + 1)}M`);
  harness.screen();
  assert.ok(harness.alt().viewportTop < end, "the wheel scrolls the transcript");
  assert.match(title(harness), /^#1\/3 alpha/);
  await leave(harness);
});

void test("a click whose new view throws while drawing shows the error instead of throwing out of the mouse dispatch", async (t) => {
  timers(t);
  const harness = await open(AGENTS(), { failRender: "scout" });
  const row = rowOf(harness, "scout");
  assert.ok(row > 0);
  assert.doesNotThrow(() => { harness.send(`${ESC}[<0;5;${String(row + 1)}M`, `${ESC}[<0;5;${String(row + 1)}m`); });
  // Until the next successful poll replaces it, the failure is the status line.
  assert.match(harness.screen().join("\n"), /render failed/);
  await settle();
  harness.send("[");
  await settle();
  assert.match(title(harness), /^#2\/3/, "the workspace still takes keys after the failed click");
  await leave(harness);
});

void test("a stream that replays synchronously while the view subscribes reaches the view", async (t) => {
  timers(t);
  const live = new FakeLive();
  live.replay.push({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "so far" } });
  const harness = await open([agent("alpha", { live })]);
  assert.ok(harness.view("alpha").calls.includes("live:message_update"), "the replayed event was not dropped");
  await leave(harness);
});

void test("the failure of the earlier history stays in the status line through the next polls, until the user leaves the top or a read fails, and stays cleared after that", async (t) => {
  timers(t);
  const harness = await open([agent("alpha")], { columns: 70, setup: (source) => {
    source.polls.push(polled(entries(1000, 40)), polled([]), polled([]), new Error("permission denied"), polled([]));
    source.failEarlier = new Error("disk read failed");
  } });
  harness.screen();
  harness.send(KEY.home);
  harness.screen();
  await settle();
  assert.ok(harness.screen().some((line) => line.includes("transcript read failed: disk read failed")));
  await advance(t);
  assert.ok(harness.screen().some((line) => line.includes("transcript read failed: disk read failed")), "a poll that succeeded leaves it");
  await advance(t);
  assert.ok(harness.screen().some((line) => line.includes("transcript read failed: disk read failed")), "and so does the next");
  await advance(t);
  assert.ok(harness.screen().some((line) => line.includes("transcript read failed: permission denied")), "a failed poll replaces it");
  await advance(t);
  assert.ok(!harness.screen().some((line) => line.includes("disk read failed") || line.includes("permission denied")), "the next successful poll does not bring the earlier failure back");
  await leave(harness);
});

void test("leaving the top clears the earlier history's failure", async (t) => {
  timers(t);
  const harness = await open([agent("alpha")], { columns: 70, setup: (source) => {
    source.polls.push(polled(entries(1000, 40)));
    source.failEarlier = new Error("disk read failed");
  } });
  harness.screen();
  harness.send(KEY.home);
  harness.screen();
  await settle();
  assert.ok(harness.screen().some((line) => line.includes("disk read failed")));
  harness.send(KEY.pageDown);
  harness.screen();
  assert.ok(!harness.screen().some((line) => line.includes("disk read failed")));
  await leave(harness);
});

void test("selecting another agent closes the previous source, unsubscribes its live stream and disposes its view", async (t) => {
  timers(t);
  const live = new FakeLive();
  const harness = await open([agent("alpha", { live }), agent("beta")]);
  live.emit({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "hi" } });
  assert.ok(harness.view("alpha").calls.includes("live:message_update"));
  assert.equal(harness.view("alpha").ui, harness.alt());
  assert.equal(harness.view("alpha").cwd, "/project/alpha");
  harness.send(KEY.down);
  await settle();
  assert.equal(harness.source("alpha").calls.at(-1), "close");
  assert.equal(live.unsubscribed, 1);
  assert.equal(live.listeners.size, 0);
  assert.equal(harness.view("alpha").calls.at(-1), "dispose");
  assert.deepEqual(harness.opened, ["alpha", "beta"]);
  assert.equal(harness.source("beta").count("poll"), 1);
  assert.equal(harness.source("alpha").overlapped, false);
  await leave(harness);
});

void test("an agent that is not owned shows transcript unavailable and its source is never opened", async (t) => {
  timers(t);
  const harness = await open([agent("alpha"), agent("beta", { owned: false })]);
  harness.send(KEY.down);
  await settle();
  assert.match(title(harness), /^#2\/2 beta/);
  assert.deepEqual(harness.opened, ["alpha"]);
  assert.equal(harness.views.length, 1);
  assert.ok(harness.screen().some((line) => line.includes("│ transcript unavailable")));
  await advance(t, 2);
  assert.deepEqual(harness.opened, ["alpha"]);
  await leave(harness);
});

void test("polling appends and resets while the agent runs, shows waiting, and stops one poll after the agent stops", async (t) => {
  timers(t);
  const harness = await open([agent("alpha")], { columns: 70, setup: (source) => { source.polls.push(polled([], { status: "waiting" }), polled(entries(0, 3)), polled(entries(3, 2)), polled(entries(100, 4), { reset: true })); } });
  const source = harness.source("alpha");
  const view = harness.view("alpha");
  assert.equal(source.count("poll"), 1, "an immediate poll");
  assert.ok(harness.screen().some((line) => line.includes("waiting for the first message")));
  await advance(t);
  assert.deepEqual(view.calls.filter((call) => call !== "expanded:false"), ["append:3"]);
  assert.ok(!harness.screen().some((line) => line.includes("waiting")));
  await advance(t);
  await advance(t);
  assert.deepEqual(view.calls.filter((call) => call !== "expanded:false"), ["append:3", "append:2", "reset", "append:4"]);
  assert.equal(topRow(harness), "alpha record 100");
  const running = source.count("poll");
  harness.agents = [agent("alpha", { running: false, state: "completed" })];
  await advance(t, 4);
  assert.equal(source.count("poll"), running + 1, "one more poll after the agent stopped");
  assert.match(title(harness), /^#1\/1 alpha completed/);
  assert.equal(harness.listCalls >= 6, true, "the agents are listed on every tick");
  assert.equal(source.overlapped, false);
  await leave(harness);
});

void test("reaching the top loads the earlier chunk once and keeps the lines in view where they were, with the sidebar shown", async (t) => {
  timers(t);
  // Each record is a 95-column line: two rows beside the sidebar at 120 and 100 columns, where the whole width would give one.
  for (const columns of [120, 100]) {
    const harness = await open([agent("alpha", { running: false })], { columns, wrap: 95, setup: (source) => {
      source.polls.push(polled(entries(1000, 40)));
      source.earlier.push({ records: entries(900, 30), atStart: false }, { records: entries(880, 20), atStart: true });
    } });
    const source = harness.source("alpha");
    const top = (): string => harness.screen()[1] ?? "";
    // The frame that shows the last chunk; the scroll view learns the content height when it is drawn.
    assert.ok(harness.screen().every((line) => visibleWidth(line) <= columns));
    harness.send(KEY.home);
    assert.ok(top().includes("│ alpha record 1000"), String(columns));
    // The call starts once the source's queue moves on; a frame drawn while it is in flight does not call again.
    await Promise.resolve();
    assert.equal(source.count("loadEarlier"), 1);
    harness.screen();
    await Promise.resolve();
    assert.equal(source.count("loadEarlier"), 1, "loaded once while the chunk is in flight");
    await settle();
    assert.deepEqual(harness.view("alpha").calls.at(-1), "prepend:30");
    assert.ok(top().includes("│ alpha record 1000"), `the lines in view stay where they were at ${String(columns)} columns`);
    assert.equal(harness.alt().viewportTop, 60);
    harness.send(KEY.home);
    assert.ok(top().includes("│ alpha record 900"));
    await settle();
    assert.ok(top().includes("│ alpha record 900"));
    assert.equal(source.count("loadEarlier"), 2);
    harness.send(KEY.home);
    harness.screen();
    await settle();
    assert.equal(source.count("loadEarlier"), 2, "no load at the start of the file");
    assert.equal(source.overlapped, false);
    await leave(harness);
  }
});

void test("enter loads the last large record not loaded yet", async (t) => {
  timers(t);
  const harness = await open([agent("alpha", { running: false })], { setup: (source) => { source.polls.push(polled([entry(0), large(10), entry(20), large(30)])); } });
  const hint = harness.screen().at(-1) ?? "";
  assert.ok(hint.includes("enter load"), "the hint names enter while a record is pending");
  assert.match(hint, /^←→\/space fold · \[ \] agent · tab focus · enter load · /, "the sidebar keys come first while the sidebar has the focus");
  assert.ok(visibleWidth(hint) <= 120);
  harness.send(KEY.enter);
  await settle();
  assert.ok(harness.source("alpha").calls.includes("loadRecord:30"));
  assert.equal(harness.view("alpha").calls.at(-1), "replace:30");
  harness.send(KEY.enter);
  await settle();
  assert.ok(harness.source("alpha").calls.includes("loadRecord:10"));
  assert.equal(harness.view("alpha").calls.at(-1), "replace:10");
  assert.ok(harness.screen().some((line) => line.includes("full 10")));
  assert.equal(harness.source("alpha").overlapped, false);
  await leave(harness);
});

void test("the selection survives a refresh that reorders the agents, and the initial key is selected first", async (t) => {
  timers(t);
  const harness = await open(AGENTS(), { initialKey: "beta" });
  assert.deepEqual(harness.opened, ["beta"]);
  assert.match(title(harness), /^#2\/3 beta/);
  const [alpha, beta, scout] = harness.agents;
  assert.ok(alpha && beta && scout);
  harness.agents = [scout, beta, alpha];
  await advance(t);
  assert.match(title(harness), /^#2\/3 beta/);
  harness.agents = [beta, alpha, scout];
  await advance(t);
  assert.match(title(harness), /^#1\/3 beta/);
  assert.deepEqual(harness.opened, ["beta"]);
  assert.ok(!harness.source("beta").calls.includes("close"));
  harness.agents = [alpha, scout];
  await advance(t);
  assert.match(title(harness), /^#1\/2 alpha/, "a removed agent gives the selection to its neighbour");
  assert.equal(harness.source("beta").calls.at(-1), "close");
  await leave(harness);
});

void test("a new attempt or session reference of the selected agent reopens it", async (t) => {
  timers(t);
  const harness = await open([agent("alpha")]);
  harness.agents = [agent("alpha", { attempt: 2, session: { transport: "pi", sessionId: "alpha-2" } })];
  await advance(t);
  assert.deepEqual(harness.opened, ["alpha", "alpha"]);
  assert.equal(harness.sources[0]?.calls.at(-1), "close");
  assert.equal(harness.views[0]?.calls.at(-1), "dispose");
  assert.equal(harness.views.length, 2);
  harness.agents = [agent("alpha", { attempt: 2, session: { transport: "pi", sessionId: "alpha-2", locator: { sessionFile: "/sessions/alpha-2.jsonl" } } })];
  await advance(t);
  assert.deepEqual(harness.opened, ["alpha", "alpha", "alpha"]);
  await advance(t);
  assert.equal(harness.opened.length, 3, "the same attempt is not reopened");
  await leave(harness);
});

void test("a live stream registered after the agent was opened is subscribed without reopening it", async (t) => {
  timers(t);
  const harness = await open([agent("alpha")]);
  const live = new FakeLive();
  harness.agents = [agent("alpha", { live })];
  await advance(t);
  assert.equal(live.listeners.size, 1, "the new stream is subscribed");
  assert.deepEqual(harness.opened, ["alpha"], "the source is not reopened");
  assert.equal(harness.views.length, 1, "the view is kept");
  live.emit({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "hi" } });
  assert.ok(harness.view("alpha").calls.includes("live:message_update"), "its events reach the view");
  const next = new FakeLive();
  harness.agents = [agent("alpha", { live: next })];
  await advance(t);
  assert.equal(live.unsubscribed, 1, "a replaced stream is unsubscribed");
  assert.equal(next.listeners.size, 1);
  harness.agents = [agent("alpha")];
  await advance(t);
  assert.equal(next.unsubscribed, 1, "a stream that went away is unsubscribed");
  assert.equal(harness.views.length, 1);
  await leave(harness);
});

void test("a rejected loadEarlier is tried once until the user comes back to the top", async (t) => {
  timers(t);
  const harness = await open([agent("alpha")], { columns: 70, setup: (source) => {
    source.polls.push(polled(entries(1000, 40)));
    source.failEarlier = new Error("disk read failed");
  } });
  const source = harness.source("alpha");
  harness.screen();
  harness.send(KEY.home);
  harness.screen();
  await settle();
  assert.equal(source.count("loadEarlier"), 1);
  assert.ok(harness.screen().some((line) => line.includes("transcript read failed: disk read failed")));
  for (let frame = 0; frame < 5; frame += 1) {
    harness.screen();
    await new Promise((resolve) => { setTimeout(resolve, 20); });
  }
  await advance(t, 3);
  harness.screen();
  await settle();
  assert.equal(source.count("loadEarlier"), 1, "no retry on every frame or poll");
  harness.send(KEY.pageDown);
  harness.screen();
  harness.send(KEY.home);
  harness.screen();
  await settle();
  assert.equal(source.count("loadEarlier"), 2, "coming back to the top tries again");
  assert.equal(source.overlapped, false);
  await leave(harness);
});

void test("the sidebar keeps the selected row in view, and clicks select rows after it scrolled", async (t) => {
  timers(t);
  const many = Array.from({ length: 30 }, (_, index) => agent(`a${String(index).padStart(2, "0")}`, { group: index < 15 ? "g1" : "g2" }));
  const harness = await open(many, { rows: 10 });
  assert.ok((harness.screen()[1] ?? "").startsWith("  ▾ g1 · ⠦"));
  assert.ok((harness.screen()[2] ?? "").startsWith("→   • a00 · ⠦"));
  harness.send("[");
  await settle();
  let lines = harness.screen();
  assert.match(title(harness), /^#30\/30 a29/, "[ goes round to the last agent");
  assert.ok(lines.some((line) => line.startsWith("→   • a29 · ⠦")), "the selected row is in view");
  assert.ok(!lines.some((line) => line.includes(" a00")), "the sidebar scrolled");
  assert.ok(lines.every((line) => visibleWidth(line) <= 120));
  const row = rowOf(harness, " a25");
  assert.ok(row > 0);
  harness.send(`${ESC}[<0;5;${String(row + 1)}M`, `${ESC}[<0;5;${String(row + 1)}m`);
  await settle();
  assert.match(title(harness), /^#26\/30 a25/, "the click resolved the scrolled row");
  harness.send(KEY.down, KEY.down, KEY.down, KEY.down, KEY.down);
  await settle();
  lines = harness.screen();
  assert.equal(title(harness).trimEnd(), "g1 running", "down goes round to the first node");
  assert.ok((lines[1] ?? "").startsWith("→ ▾ g1 · ⠦"), "the sidebar scrolled back to the top");
  harness.send(KEY.down);
  await settle();
  assert.match(title(harness), /^#1\/30 a00/);
  assert.ok((harness.screen()[2] ?? "").startsWith("→   • a00 · ⠦"));
  await leave(harness);
});

void test("the status line shows an unavailable transcript with its reason, a failed read, then the agent's activity", async (t) => {
  timers(t);
  const harness = await open([agent("alpha", { activity: "running bash: npm test" })], { setup: (source) => {
    source.polls.push(polled([], { status: "unavailable", reason: "session file was replaced" }), new Error("permission denied"), polled(entries(0, 2)));
  } });
  const status = (): string => (harness.screen().at(-2) ?? "").trimEnd();
  assert.match(status(), /│ transcript unavailable: session file was replaced$/);
  await advance(t);
  assert.match(status(), /│ transcript read failed: permission denied$/);
  await advance(t);
  assert.match(status(), /│ running bash: npm test$/);
  assert.ok(harness.screen().some((line) => line.includes("alpha record 1")));
  await leave(harness);
});

void test("a failed list keeps the previous agents and shows the error in the title", async (t) => {
  timers(t);
  const harness = await open(AGENTS());
  harness.listError = new Error("store locked");
  await advance(t);
  assert.match(title(harness), /^#1\/3 alpha .*agents unavailable: store locked/);
  assert.ok(harness.screen().some((line) => line.includes("scout")), "the previous agents stay");
  assert.ok(!harness.source("alpha").calls.includes("close"));
  harness.listError = undefined;
  await advance(t);
  assert.doesNotMatch(title(harness), /agents unavailable/);
  await leave(harness);
});

void test("the initial key is selected by the first list that contains it", async (t) => {
  timers(t);
  const harness = await open([], { initialKey: "beta" });
  assert.equal(harness.listCalls, 1, "the first list was empty");
  assert.deepEqual(harness.opened, []);
  harness.agents = AGENTS();
  await advance(t);
  assert.match(title(harness), /^#2\/3 beta/);
  assert.deepEqual(harness.opened, ["beta"]);
  await leave(harness);
});

void test("a custom that throws synchronously rejects the workspace's promise instead of throwing out of the call", async () => {
  const ctx = { ui: { custom: () => { throw new Error("no custom"); }, notify() {} } } as unknown as ExtensionCommandContext;
  let opening: Promise<unknown> | undefined;
  assert.doesNotThrow(() => { opening = openAgentsWorkspace(ctx, { agents: { list: async () => [] }, openSource: () => { throw new Error("unexpected openSource"); }, createView: () => { throw new Error("unexpected createView"); } }); });
  assert.ok(opening);
  await assert.rejects(opening, /no custom/);
});

void test("opening that fails while Pi's TUI cannot start again either reports the opening's error once", async (t) => {
  timers(t);
  const escaped = escapes(t);
  const pi = fakePi({ fail: "cursor" });
  pi.parentStartError = new Error("tty gone");
  const exit = await openAgentsWorkspace(pi.ctx, { agents: { list: async () => nodesOf([agent("alpha")]) }, openSource: () => { throw new Error("unexpected openSource"); }, createView: () => { throw new Error("unexpected createView"); } });
  await settle();
  assert.equal(exit, undefined);
  assert.deepEqual(pi.parent, ["stop:true", "start"]);
  assert.deepEqual(pi.notified, ["error: agents workspace failed: no cursor"]);
  assert.deepEqual(escaped, []);
});

void test("a signal aborted before opening never stops Pi", async () => {
  const controller = new AbortController();
  controller.abort();
  const harness = await open(AGENTS(), { signal: controller.signal });
  await harness.done;
  assert.deepEqual(harness.parent, []);
  assert.equal(harness.listCalls, 0);
  assert.deepEqual(harness.opened, []);
});

void test("opening that fails before or after the workspace is built restores Pi, reports once and leaves nothing running", async (t) => {
  timers(t);
  const escaped = escapes(t);
  for (const fail of ["cursor", "start"] as const) {
    const harness = await open(AGENTS(), { fail });
    await harness.done;
    assert.deepEqual(harness.parent, ["stop:true", "start", "renderNow:false"], fail);
    assert.deepEqual(harness.notified, [`error: agents workspace failed: ${fail === "cursor" ? "no cursor" : "terminal unavailable"}`]);
    if (fail === "start") {
      const entered = harness.terminal.written.indexOf(`${ESC}[?1049h`);
      assert.ok(entered >= 0, "the alt screen was entered before the terminal failed");
      assert.ok(harness.terminal.written.indexOf(`${ESC}[?1049l`) > entered, "and left again");
    }
    const lists = harness.listCalls;
    assert.ok(lists <= 1, "at most the first list, called while the workspace was built");
    await advance(t, 3);
    assert.equal(harness.listCalls, lists, `no refresh after opening failed (${fail})`);
    assert.equal(polls(harness), 0, "no poll after opening failed");
    assert.deepEqual(harness.opened, []);
  }
  assert.deepEqual(escaped, []);
});

void test("a terminal that cannot stop on esc, ctrl+c or abort still restores Pi, settles, reports once and leaves nothing running", async (t) => {
  timers(t);
  const escaped = escapes(t);
  for (const exit of ["esc", "ctrl+c", "abort"] as const) {
    const controller = new AbortController();
    const live = new FakeLive();
    const harness = await open([agent("alpha", { live })], { signal: controller.signal });
    harness.terminal.failStop = new Error("setRawMode EBADF");
    if (exit === "abort") controller.abort();
    else harness.send(exit === "esc" ? KEY.escape : KEY.ctrlC);
    await settle();
    assert.equal(harness.left, true, `the command settled (${exit})`);
    assert.deepEqual(harness.parent, ["stop:true", "start", "renderNow:false"], exit);
    assert.deepEqual(harness.notified, ["error: agents workspace failed: setRawMode EBADF"], exit);
    assert.equal(harness.source("alpha").calls.at(-1), "close", "the transcript was closed before the terminal failed");
    assert.equal(harness.view("alpha").calls.at(-1), "dispose");
    assert.equal(live.unsubscribed, 1);
    // The failed stop kept the input wired: leaving again does nothing.
    harness.send(KEY.escape, KEY.ctrlC);
    controller.abort();
    await settle();
    assert.deepEqual(harness.parent, ["stop:true", "start", "renderNow:false"], `left once (${exit})`);
    assert.equal(harness.notified.length, 1);
    const lists = harness.listCalls;
    const pollCount = polls(harness);
    await advance(t, 3);
    assert.equal(harness.listCalls, lists, `no refresh after leaving (${exit})`);
    assert.equal(polls(harness), pollCount, `no poll after leaving (${exit})`);
  }
  assert.deepEqual(escaped, []);
});

void test("Pi's TUI failing to start again after leaving still settles the command and reports the first error once", async (t) => {
  timers(t);
  const escaped = escapes(t);
  for (const exit of ["ctrl+c", "abort", "esc with a terminal that cannot stop"] as const) {
    const controller = new AbortController();
    const harness = await open([agent("alpha")], { signal: controller.signal });
    harness.parentStartError = new Error("tty gone");
    if (exit === "abort") controller.abort();
    else if (exit === "ctrl+c") harness.send(KEY.ctrlC);
    else {
      harness.terminal.failStop = new Error("setRawMode EBADF");
      harness.send(KEY.escape);
    }
    await settle();
    assert.equal(harness.left, true, `the command settled (${exit})`);
    assert.deepEqual(harness.parent, ["stop:true", "start"], exit);
    assert.deepEqual(harness.notified, [`error: agents workspace failed: ${exit === "esc with a terminal that cannot stop" ? "setRawMode EBADF" : "tty gone"}`], exit);
    assert.equal(harness.source("alpha").calls.at(-1), "close");
  }
  assert.deepEqual(escaped, []);
});

void test("the refresh interval starts once the first list settled", async (t) => {
  timers(t);
  let release = (): void => undefined;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const harness = await open(AGENTS(), { listGate: gate });
  assert.equal(harness.listCalls, 1);
  t.mock.timers.tick(1500);
  await settle();
  release();
  await settle();
  assert.match(title(harness), /^#1\/3 alpha/);
  t.mock.timers.tick(600);
  await settle();
  assert.equal(harness.listCalls, 1, "no tick 1000 ms after open, before the first list settled");
  t.mock.timers.tick(400);
  await settle();
  assert.equal(harness.listCalls, 2, "the first tick comes 1000 ms after the first list settled");
  await leave(harness);
});

void test("a list() that throws synchronously, at open or on a later tick, ends in the title and refreshing goes on", async (t) => {
  timers(t);
  const escaped = escapes(t);
  const harness = await open(AGENTS(), { listThrow: new Error("index corrupt") });
  assert.equal(harness.listCalls, 1);
  assert.deepEqual(harness.opened, []);
  // No view yet, so no alt screen handle: wait (bounded) for the throttled frame the alt screen drew on the terminal.
  const drawn = (): boolean => stripTerminalSequences(harness.terminal.written).includes("agents unavailable: index corrupt");
  for (let wait = 0; wait < 100 && !drawn(); wait += 1) await new Promise((resolve) => { setTimeout(resolve, 5); });
  assert.ok(drawn(), "the title shows the throw");
  harness.listThrow = undefined;
  await advance(t);
  assert.equal(harness.listCalls, 2, "the interval started after the throw");
  assert.match(title(harness), /^#1\/3 alpha/);
  assert.deepEqual(harness.opened, ["alpha"]);
  harness.listThrow = new Error("index moved");
  await advance(t);
  assert.match(title(harness), /^#1\/3 alpha .*agents unavailable: index moved/);
  assert.ok(harness.screen().some((line) => line.includes("scout")), "the previous agents stay");
  await advance(t);
  assert.equal(harness.listCalls, 4, "a throw does not stop refreshing");
  harness.listThrow = undefined;
  await advance(t);
  assert.doesNotMatch(title(harness), /agents unavailable/);
  assert.equal(harness.source("alpha").calls.includes("close"), false);
  await leave(harness);
  assert.deepEqual(escaped, []);
});

void test("a view whose append or live throws shows the error as the status line and polling goes on", async (t) => {
  timers(t);
  const escaped = escapes(t);
  const live = new FakeLive();
  const harness = await open([agent("alpha", { live })], { setup: (source) => { source.polls.push(polled(entries(0, 2)), polled(entries(2, 2)), polled(entries(4, 2)), polled(entries(6, 2))); } });
  const source = harness.source("alpha");
  const view = harness.view("alpha");
  const status = (): string => (harness.screen().at(-2) ?? "").trimEnd();
  view.fail.append = new Error("append threw");
  await advance(t);
  assert.match(status(), /│ transcript failed: append threw$/);
  await advance(t);
  assert.equal(source.count("poll"), 3, "polling goes on");
  assert.equal(harness.listCalls, 3, "refreshing goes on");
  view.fail.append = undefined;
  await advance(t);
  assert.ok(!harness.screen().some((line) => line.includes("transcript failed")), "a poll the view took clears the error");
  assert.ok(harness.screen().some((line) => line.includes("alpha record 6")));
  view.fail.live = new Error("live threw");
  live.emit({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "hi" } });
  assert.match(status(), /│ transcript failed: live threw$/);
  await settle();
  assert.equal(source.overlapped, false);
  await leave(harness);
  assert.deepEqual(escaped, []);
});

void test("an agent whose view cannot be created stays selected with the error, closes its source and is not reopened every tick", async (t) => {
  timers(t);
  const escaped = escapes(t);
  const harness = await open(AGENTS(), { failView: "beta" });
  harness.send(KEY.down);
  await settle();
  assert.match(title(harness), /^#2\/3 beta/);
  assert.deepEqual(harness.opened, ["alpha", "beta"]);
  assert.equal(harness.source("beta").calls.at(-1), "close");
  assert.match((harness.screen().at(-2) ?? "").trimEnd(), /│ transcript unavailable: no view$/);
  await advance(t, 2);
  assert.deepEqual(harness.opened, ["alpha", "beta"], "the same attempt is not reopened");
  assert.equal(harness.source("beta").count("poll"), 0);
  harness.send("[");
  await settle();
  assert.match(title(harness), /^#1\/3 alpha/);
  assert.equal(harness.view("alpha").calls.includes("dispose"), false);
  await leave(harness);
  assert.deepEqual(escaped, []);
});

void test("left and right collapse, expand and move to the parent or the first child as in /workflow", async (t) => {
  timers(t);
  const harness = await open([], { nodes: tree(TREE()) });
  assert.match(title(harness), /^#1\/4 a running/, "the first agent node is selected");
  assert.deepEqual(sidebarRows(harness), ["  ▾ Workflow · ⠦", "    ▾ P · ⠦", "      ▾ O · ⠦", "→       • a · ⠦", "        • b · ✓", "      • c · ⠦", "  ▾ Subagents · ⠦", "    • s · ⠦"]);
  harness.send(KEY.right);
  await settle();
  assert.match(title(harness), /^#1\/4 a/, "right on a leaf stays");
  harness.send(KEY.left);
  await settle();
  assert.equal(title(harness).trimEnd(), "O running", "left on a leaf goes to the parent");
  harness.send(KEY.left);
  await settle();
  assert.deepEqual(sidebarRows(harness).slice(2, 4), ["→     ▸ O · ⠦", "      • c · ⠦"], "left on an expanded node collapses it and stays");
  harness.send(KEY.left);
  await settle();
  assert.equal(title(harness).trimEnd(), "P running", "left on a collapsed node goes to the parent");
  harness.send(KEY.right);
  await settle();
  assert.equal(title(harness).trimEnd(), "O running", "right on an expanded node goes to its first child");
  harness.send(KEY.right);
  await settle();
  assert.deepEqual(sidebarRows(harness).slice(2, 4), ["→     ▾ O · ⠦", "        • a · ⠦"], "right on a collapsed node expands it and stays");
  harness.send(KEY.right);
  await settle();
  assert.match(title(harness), /^#1\/4 a/);
  harness.send(KEY.tab, KEY.left);
  await settle();
  assert.match(title(harness), /^#1\/4 a/, "left and right act on the tree only while it has the focus");
  harness.send(KEY.tab, KEY.up, KEY.up, KEY.up, KEY.left);
  await settle();
  assert.deepEqual(sidebarRows(harness), ["→ ▸ Workflow · ⠦", "  ▾ Subagents · ⠦", "    • s · ⠦"], "up from a reached the run root, left collapsed it");
  harness.send(KEY.left);
  await settle();
  assert.equal(title(harness).trimEnd(), "Workflow running", "left on a collapsed root stays");
  await leave(harness);
});

void test("[ and ] jump over the nodes that are not agents and expand the ancestors of the agent they land on", async (t) => {
  timers(t);
  const harness = await open([], { nodes: tree(TREE()) });
  harness.send(KEY.left, KEY.left, KEY.left, KEY.left);
  await settle();
  assert.deepEqual(sidebarRows(harness).slice(0, 2), ["  ▾ Workflow · ⠦", "→   ▸ P · ⠦"], "P and O collapsed");
  harness.send("]");
  await settle();
  assert.match(title(harness), /^#1\/4 a/, "the next agent after P, hidden under it");
  assert.deepEqual(sidebarRows(harness).slice(1, 4), ["    ▾ P · ⠦", "      ▾ O · ⠦", "→       • a · ⠦"], "its ancestors expanded");
  const keys: string[] = [];
  for (const key of ["]", "]", "]", "]", "[", "["]) {
    harness.send(key);
    await settle();
    keys.push(title(harness).split(" ").slice(0, 2).join(" "));
  }
  assert.deepEqual(keys, ["#2/4 b", "#3/4 c", "#4/4 s", "#1/4 a", "#4/4 s", "#3/4 c"], "agents only, in sidebar order, round at both ends");
  harness.send(KEY.down, KEY.left);
  await settle();
  assert.deepEqual(sidebarRows(harness).slice(-1), ["→ ▸ Subagents · ⠦"], "the group collapsed");
  harness.send("]");
  await settle();
  assert.match(title(harness), /^#4\/4 s/);
  assert.deepEqual(sidebarRows(harness).slice(-2), ["  ▾ Subagents · ⠦", "→   • s · ⠦"]);
  await leave(harness);
});

void test("a node that is not an agent shows its details: no source, no polling, no live stream", async (t) => {
  timers(t);
  const live = new FakeLive();
  const specs = TREE().map((spec) => spec.key === "a" ? { ...spec, agent: agent("a", { live }) } : spec);
  const harness = await open([], { nodes: tree(specs) });
  assert.deepEqual(harness.opened, ["a"]);
  assert.equal(live.listeners.size, 1);
  harness.send(KEY.up);
  await settle();
  const lines = harness.screen();
  assert.equal((lines[0] ?? "").replace(/ {2,}\d+\/\d+ running.*$/, ""), "O running", "the title is the node's label and state");
  assert.match(lines[1] ?? "", /│ details of O\s*$/);
  assert.match(lines[2] ?? "", /│ state running\s*$/);
  assert.equal((lines.at(-2) ?? "").replace(/^.*│/, "").trim(), "", "no status line");
  assert.equal(harness.source("a").calls.at(-1), "close");
  assert.equal(live.listeners.size, 0, "the agent's stream is let go");
  const polled = polls(harness);
  await advance(t, 3);
  assert.deepEqual(harness.opened, ["a"], "no source for the node");
  assert.equal(polls(harness), polled, "no polling");
  assert.equal(live.listeners.size, 0);
  assert.doesNotMatch(lines.at(-1) ?? "", /enter load/);
  harness.send(KEY.enter, KEY.ctrlO);
  await settle();
  assert.deepEqual(harness.opened, ["a"]);
  harness.send(KEY.down);
  await settle();
  assert.match(title(harness), /^#1\/4 a/);
  assert.deepEqual(harness.opened, ["a", "a"], "the agent opens again");
  assert.ok(harness.view("a").calls.includes("expanded:true"), "ctrl+o still toggled the tool output");
  await leave(harness);
});

void test("expansion and selection survive a refresh that adds nodes; new nodes take their initial expansion", async (t) => {
  timers(t);
  const harness = await open([], { nodes: tree(TREE()) });
  harness.send(KEY.left, KEY.left);
  await settle();
  assert.equal(title(harness).trimEnd(), "O running");
  harness.nodes = tree([
    { key: "new-run", kind: "run", label: "Fresh" },
    { key: "new-agent", parent: "new-run", agent: agent("n") },
    ...TREE().flatMap((spec) => spec.key === "c" ? [{ key: "d", parent: "O", agent: agent("d") }, { key: "Q", parent: "P", kind: "operation" as const }, { key: "e", parent: "Q", agent: agent("e") }, spec] : [spec]),
  ]);
  await advance(t);
  assert.equal(title(harness).trimEnd(), "O running", "the selection kept by key");
  assert.deepEqual(sidebarRows(harness), [
    "  ▾ Fresh · ⠦",
    "    • n · ⠦",
    "  ▾ Workflow · ⠦",
    "    ▾ P · ⠦",
    "→     ▸ O · ⠦",
    "      ▾ Q · ⠦",
    "        • e · ⠦",
    "      • c · ⠦",
    "  ▾ Subagents · ⠦",
    "    • s · ⠦",
  ], "O stays collapsed (its new child d hidden), the new run and Q come expanded");
  harness.send("]");
  await settle();
  assert.match(title(harness), /^#2\/7 a/, "the next agent in sidebar order, the new run's agent first");
  assert.deepEqual(sidebarRows(harness).slice(4, 8), ["      ▾ O · ⠦", "→       • a · ⠦", "        • b · ✓", "        • d · ⠦"], "O expanded again, with its new child");
  await advance(t);
  assert.match(title(harness), /^#2\/7 a/);
  assert.deepEqual(harness.opened, ["a", "a"], "the selected agent is not reopened by a refresh");
  await leave(harness);
});

void test("a phase listed before it has children is expanded once a later list gives it its first child, as /workflow expands it", async (t) => {
  timers(t);
  const root: Spec = { key: "run:R", kind: "run", label: "Workflow" };
  const plan: Spec = { key: "P", parent: "run:R", label: "plan" };
  const review: Spec = { key: "Q", parent: "run:R", label: "review" };
  const harness = await open([], { nodes: tree([root, plan]) });
  assert.deepEqual(sidebarRows(harness), ["→ ▾ Workflow · ⠦", "      plan · ⠦"], "the phase before its first agent has no icon");
  harness.nodes = tree([root, plan, { key: "a", parent: "P", agent: agent("a") }, review]);
  await advance(t);
  assert.deepEqual(sidebarRows(harness), ["→ ▾ Workflow · ⠦", "    ▾ plan · ⠦", "      • a · ⠦", "      review · ⠦"], "its first child comes in view");
  harness.nodes = tree([root, plan, { key: "a", parent: "P", agent: agent("a") }, review, { key: "b", parent: "Q", agent: agent("b") }]);
  await advance(t);
  assert.deepEqual(sidebarRows(harness), ["→ ▾ Workflow · ⠦", "    ▾ plan · ⠦", "      • a · ⠦", "    ▾ review · ⠦", "      • b · ⠦"], "also a phase first listed by a later list");
  await leave(harness);
});

void test("a node listed before it has children that comes collapsed stays collapsed when a later list gives it its first child", async (t) => {
  timers(t);
  const root: Spec = { key: "run:R", kind: "run", label: "Workflow", state: "completed", expanded: false };
  const harness = await open([], { nodes: tree([root]) });
  assert.deepEqual(sidebarRows(harness), ["→   Workflow · ✓"]);
  harness.nodes = tree([root, { key: "a", parent: "run:R", agent: agent("a", { state: "completed", running: false }) }]);
  await advance(t);
  assert.deepEqual(sidebarRows(harness), ["→ ▸ Workflow · ✓"], "collapsed, its first child hidden");
  await leave(harness);
});

void test("a node the user collapsed stays collapsed through lists that take its children away and give them back", async (t) => {
  timers(t);
  const root: Spec = { key: "run:R", kind: "run", label: "Workflow" };
  const plan: Spec = { key: "P", parent: "run:R", label: "plan" };
  const harness = await open([], { nodes: tree([root, plan, { key: "a", parent: "P", agent: agent("a") }]) });
  harness.send(KEY.left, KEY.left);
  await settle();
  assert.deepEqual(sidebarRows(harness), ["  ▾ Workflow · ⠦", "→   ▸ plan · ⠦"]);
  harness.nodes = tree([root, plan]);
  await advance(t);
  assert.deepEqual(sidebarRows(harness), ["  ▾ Workflow · ⠦", "→     plan · ⠦"]);
  harness.nodes = tree([root, plan, { key: "a", parent: "P", agent: agent("a") }, { key: "b", parent: "P", agent: agent("b") }]);
  await advance(t);
  assert.deepEqual(sidebarRows(harness), ["  ▾ Workflow · ⠦", "→   ▸ plan · ⠦"], "its children back, it stays as the user left it");
  harness.send(" ");
  assert.deepEqual(sidebarRows(harness), ["  ▾ Workflow · ⠦", "→   ▾ plan · ⠦", "      • a · ⠦", "      • b · ⠦"]);
  await leave(harness);
});

void test("the initial key selects its agent and expands its ancestors; without one the first agent node is selected and shown", async (t) => {
  timers(t);
  const collapsed = (): Spec[] => TREE().map((spec) => spec.key === "P" || spec.key === "subagents" ? { ...spec, expanded: false } : spec);
  const keyed = await open([], { nodes: tree(collapsed()), initialKey: "b" });
  assert.match(title(keyed), /^#2\/4 b/);
  assert.deepEqual(keyed.opened, ["b"]);
  assert.deepEqual(sidebarRows(keyed), ["  ▾ Workflow · ⠦", "    ▾ P · ⠦", "      ▾ O · ⠦", "        • a · ⠦", "→       • b · ✓", "      • c · ⠦", "  ▸ Subagents · ⠦"]);
  await leave(keyed);
  const subagent = await open([], { nodes: tree(collapsed()), initialKey: "s" });
  assert.match(title(subagent), /^#4\/4 s/);
  assert.deepEqual(sidebarRows(subagent).slice(-2), ["  ▾ Subagents · ⠦", "→   • s · ⠦"]);
  await leave(subagent);
  const first = await open([], { nodes: tree(collapsed()) });
  assert.match(title(first), /^#1\/4 a/);
  assert.ok(sidebarRows(first).includes("→       • a · ⠦"));
  await leave(first);
});

/** Two runs and the Subagents group: "build a1b2" with alpha over beta, "deploy c3d4" with gamma, then scout. */
const GROUPS = (): Listed[] => [agent("alpha"), agent("beta", { depth: 1 }), agent("gamma", { group: "deploy c3d4" }), agent("scout", { group: "Subagents" })];

void test("a rule above every top-level node but the first row; up, down and clicks never land on it; every line fits at 120 and 70 columns", async (t) => {
  timers(t);
  const rows = (cell: number): string[] => ["  ▾ build a1b2 · ⠦", "→   ▾ alpha · ⠦", "      • beta · ⠦", rule(cell), "  ▾ deploy c3d4 · ⠦", "    • gamma · ⠦", rule(cell), "  ▾ Subagents · ⠦", "    • scout · ⠦"];
  const harness = await open(GROUPS());
  const column = sidebarColumn(harness);
  assert.deepEqual(column.slice(0, 9), rows(42), "the rule fills the sidebar cell");
  assert.deepEqual(column.slice(9), column.slice(9).map(() => ""), "no rule elsewhere");
  assert.ok(harness.screen().every((line) => visibleWidth(line) <= 120));
  const steps: string[] = [];
  for (const key of [KEY.down, KEY.down, KEY.down, KEY.down, KEY.up, KEY.up, KEY.up]) {
    harness.send(key);
    await settle();
    steps.push(title(harness).split(" ").slice(0, 2).join(" "));
  }
  assert.deepEqual(steps, ["#2/4 beta", "deploy c3d4", "#3/4 gamma", "Subagents running", "#3/4 gamma", "deploy c3d4", "#2/4 beta"], "up and down go from node to node over the rules");
  // A click on a rule, in the icon column or further right, changes nothing: not the selection, not the expansion, not the focus.
  harness.send(KEY.tab);
  const before = harness.screen();
  const opened = [...harness.opened];
  assert.match(before.at(-1) ?? "", /^↑↓ scroll/);
  const ruleRow = before.findIndex((line) => line.startsWith("─"));
  assert.ok(ruleRow > 0);
  for (const column of [2, 4, 10]) {
    click(harness, column, ruleRow);
    await settle();
  }
  assert.deepEqual(harness.screen(), before);
  assert.deepEqual(harness.opened, opened);
  await leave(harness);

  const narrow = await open(GROUPS(), { columns: 70 });
  narrow.send("s");
  assert.deepEqual(sidebarColumn(narrow).slice(0, 9), rows(25), "the rule fills the narrower cell");
  for (const step of ["", KEY.down, KEY.down, KEY.down, KEY.down]) {
    if (step) narrow.send(step);
    await settle();
    const frame = narrow.screen();
    assert.ok(frame.every((line) => visibleWidth(line) <= 70), frame.join("\n"));
  }
  await leave(narrow);
});

void test("a click on a row's ▾/▸ icon toggles and selects its node, a click elsewhere on the row only selects; space toggles a node with children and nothing else", async (t) => {
  timers(t);
  const harness = await open(GROUPS());
  // The screen row in the sidebar column: the title and the details pane name a selected node that is not an agent too.
  const row = (text: string): number => sidebarColumn(harness).findIndex((line) => line.includes(text)) + 1;
  // A header's icon is in column 2, as on every depth-0 row.
  click(harness, 2, row("deploy c3d4"));
  await settle();
  assert.equal(title(harness).trimEnd(), "deploy c3d4 running", "the click selected the header");
  assert.deepEqual(sidebarRows(harness).slice(3), ["→ ▸ deploy c3d4 · ⠦", "  ▾ Subagents · ⠦", "    • scout · ⠦"], "and collapsed it");
  click(harness, 2, row("deploy c3d4"));
  await settle();
  assert.deepEqual(sidebarRows(harness).slice(3, 5), ["→ ▾ deploy c3d4 · ⠦", "    • gamma · ⠦"], "a second click expands it again");
  // alpha is at depth 1: its icon is in column 4, its label after it.
  click(harness, 8, row("alpha"));
  await settle();
  assert.match(title(harness), /^#1\/4 alpha/, "a click on the label selects");
  assert.ok(sidebarRows(harness).includes("      • beta · ⠦"), "and toggles nothing");
  click(harness, 3, row("deploy c3d4"));
  await settle();
  assert.equal(title(harness).trimEnd(), "deploy c3d4 running", "a click beside the icon selects");
  assert.ok(sidebarRows(harness).includes("    • gamma · ⠦"), "and toggles nothing");
  click(harness, 4, row("alpha"));
  await settle();
  assert.match(title(harness), /^#1\/4 alpha/, "a click on the icon selects");
  assert.ok(!sidebarRows(harness).some((line) => line.includes("beta")), "and collapses");
  harness.send(" ");
  await settle();
  assert.ok(sidebarRows(harness).includes("      • beta · ⠦"), "space expands the selected node");
  harness.send(" ");
  await settle();
  assert.ok(!sidebarRows(harness).some((line) => line.includes("beta")), "space collapses it");
  assert.match(title(harness), /^#1\/4 alpha/, "and keeps it selected");
  harness.send(" ", KEY.down);
  await settle();
  assert.match(title(harness), /^#2\/4 beta/);
  const leaf = harness.screen();
  harness.send(" ");
  await settle();
  assert.deepEqual(harness.screen(), leaf, "space on a leaf does nothing");
  // The • of a leaf sits in the icon column: a click there only selects.
  click(harness, 4, row("gamma"));
  await settle();
  assert.match(title(harness), /^#3\/4 gamma/);
  assert.ok(sidebarRows(harness).includes("→   • gamma · ⠦"));
  harness.send(KEY.up, KEY.tab, " ");
  await settle();
  assert.equal(title(harness).trimEnd(), "deploy c3d4 running");
  assert.ok(sidebarRows(harness).includes("    • gamma · ⠦"), "space toggles only while the sidebar has the focus");
  await leave(harness);
});

void test("a node's initial expansion counts the first time a list contains it: a run that finishes stays expanded, a new finished run comes collapsed, a new running one expanded", async (t) => {
  timers(t);
  const run = (key: string, state: RunState, expanded: boolean): Spec[] => [
    { key: `run:${key}`, kind: "run", label: key, state, expanded },
    { key: key.toLowerCase(), parent: `run:${key}`, agent: agent(key.toLowerCase(), state === "running" ? {} : { state: "completed", running: false }) },
  ];
  // S holds the agent selected on open, so its expansion is the reveal's; A's is its own.
  const harness = await open([], { nodes: tree([...run("S", "running", true), ...run("A", "running", true)]) });
  assert.deepEqual(sidebarRows(harness), ["  ▾ S · ⠦", "→   • s · ⠦", "  ▾ A · ⠦", "    • a · ⠦"]);
  harness.nodes = tree([...run("S", "running", true), ...run("A", "completed", false), ...run("B", "completed", false), ...run("C", "running", true)]);
  await advance(t);
  assert.deepEqual(sidebarRows(harness), ["  ▾ S · ⠦", "→   • s · ⠦", "  ▾ A · ✓", "    • a · ✓", "  ▸ B · ✓", "  ▾ C · ⠦", "    • c · ⠦"], "A finished while shown and stays expanded");
  harness.nodes = tree([...run("S", "running", true), ...run("A", "completed", false), ...run("B", "running", true), ...run("C", "completed", false)]);
  await advance(t);
  assert.deepEqual(sidebarRows(harness), ["  ▾ S · ⠦", "→   • s · ⠦", "  ▾ A · ✓", "    • a · ✓", "  ▸ B · ⠦", "  ▾ C · ✓", "    • c · ✓"], "a later list changes the expansion of no node already seen");
  await leave(harness);
});

void test("the initial key on an agent of a finished, collapsed run expands its ancestors; the other finished runs stay collapsed", async (t) => {
  timers(t);
  const done = { state: "completed", running: false } as const;
  const harness = await open([], { initialKey: "b", nodes: tree([
    { key: "run:A", kind: "run", label: "A" },
    { key: "a", parent: "run:A", agent: agent("a") },
    { key: "run:B", kind: "run", label: "B", state: "completed", expanded: false },
    { key: "P", parent: "run:B", label: "plan", state: "completed", expanded: false },
    { key: "b", parent: "P", agent: agent("b", done) },
    { key: "run:C", kind: "run", label: "C", state: "completed", expanded: false },
    { key: "c", parent: "run:C", agent: agent("c", done) },
  ]) });
  assert.match(title(harness), /^#2\/3 b completed/);
  assert.deepEqual(harness.opened, ["b"]);
  assert.deepEqual(sidebarRows(harness), ["  ▾ A · ⠦", "    • a · ⠦", "  ▾ B · ✓", "    ▾ plan · ✓", "→     • b · ✓", "  ▸ C · ✓"]);
  await leave(harness);
});

void test("on a short terminal the sidebar keeps the selected row in view, rules counted", async (t) => {
  timers(t);
  const harness = await open(Array.from({ length: 6 }, (_, index) => agent(`a${String(index)}`, { group: `g${String(index)}` })), { rows: 7 });
  const selected = (): string | undefined => sidebarColumn(harness).find((line) => line.startsWith("→"));
  assert.deepEqual(sidebarColumn(harness), ["  ▾ g0 · ⠦", "→   • a0 · ⠦", rule(42), "  ▾ g1 · ⠦", "    • a1 · ⠦"]);
  const seen: string[][] = [];
  // Every node down to the last and round to the first, then back up, then ] and [ across the runs.
  for (const key of [...Array.from({ length: 12 }, () => KEY.down), ...Array.from({ length: 12 }, () => KEY.up), "]", "]", "]", "[", "[", "[", "[", "["]) {
    harness.send(key);
    await settle();
    const column = sidebarColumn(harness);
    seen.push(column);
    assert.ok(selected(), `the selected row is in view after ${String(seen.length)} keys:\n${column.join("\n")}`);
  }
  assert.ok(seen.some((column) => column.some((line) => /^─+$/.test(line))), "with rules in view");
  assert.equal(seen[9]?.at(-1), "→   • a5 · ⠦", "the last node at the bottom");
  assert.deepEqual(seen[10]?.slice(0, 2), ["→ ▾ g0 · ⠦", "    • a0 · ⠦"], "down went round to the first run, at the top without a rule");
  await leave(harness);
});

void test("with the sidebar focused the hint names the fold and agent keys; with the transcript focused it is as before", async (t) => {
  timers(t);
  const harness = await open(AGENTS(), { columns: 200 });
  const hint = (): string => (harness.screen().at(-1) ?? "").trimEnd();
  assert.equal(hint(), "←→/space fold · [ ] agent · tab focus · ctrl+shift+f search · s sidebar · ctrl+o tools · esc back");
  harness.send(KEY.tab);
  assert.equal(hint(), "↑↓ scroll · [ ] agent · tab focus · ctrl+shift+f search · s sidebar · ctrl+o tools · esc back");
  await leave(harness);
});

const homes: string[] = [];
after(() => { for (const home of homes) rmSync(home, { recursive: true, force: true }); });

void test("a run's sidebar rows are its /workflow tree rows, its nodes show the /workflow details, and every line fits at 120 and 70 columns", async (t) => {
  timers(t);
  const home = mkdtempSync(join(tmpdir(), "pi-extensible-workflows-agents-workspace-"));
  homes.push(home);
  const cwd = join(home, "project");
  mkdirSync(cwd);
  const now = Date.now();
  const model = { provider: "openai", model: "gpt" };
  const record = (id: string, state: AgentRecord["state"], extra: Partial<AgentRecord> = {}): AgentRecord => ({ id, name: id, path: id, state, model, tools: [], attempts: 1, attemptDetails: [{ attempt: 1, transport: "local", session: { transport: "local", sessionId: `${id}-1` }, setup: { hookNames: [], model, tools: [], cwd }, accounting: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 } }], ...extra });
  const launch = createLaunchSnapshot({ script: "return true", args: null, metadata: { name: "review flow" }, settings: DEFAULT_SETTINGS, models: ["openai/gpt"], tools: [], agentConfigurations: {}, phases: ["plan", "review", "ship"], schemas: [] });
  const store = new RunStore(cwd, "session", "run", home);
  await store.create({ id: "run", workflowName: "review flow", cwd, sessionId: "session", state: "running", agentSessions: [], phase: "review", phaseHistory: [{ phase: "plan", afterAgent: 0 }, { phase: "review", afterAgent: 1 }], agents: [
    record("planner", "completed", { label: "Planner", startedAt: now - 60_000, durationMs: 20_000 }),
    record("api", "running", { structuralPath: ["p", "a"], startedAt: now - 30_000 }),
    record("helper", "queued", { parentId: "api", structuralPath: ["p", "a"] }),
    record("ui", "completed", { structuralPath: ["p", "b"], startedAt: now - 25_000, durationMs: 10_000 }),
  ] }, launch);
  const overlayRun = (run: PersistedRun): PersistedRun => ({ ...run, activeShellsByPhase: [{ phaseIndex: 1, active: 2, startedAt: now - 3000 }] });
  // A running run's header shows its runtime once it has run a second: a creation time ahead of the clock keeps "1s" out under load.
  const summaryPath = join(store.directory, "summary.json");
  writeFileSync(summaryPath, JSON.stringify({ ...JSON.parse(readFileSync(summaryPath, "utf8")) as object, createdAt: new Date(now + 3_600_000).toISOString() }));
  const context = { cwd, sessionManager: { getSessionId: () => "session" } } as unknown as ExtensionCommandContext;
  const source = createSessionAgentsSource(context, { home, overlayRun, liveAgent: () => undefined, subagents: () => undefined });
  const loaded = await store.load();
  const dashboard = formatWorkflowPhaseDashboard(overlayRun(loaded.run), loaded.snapshot, 70, { treeOnly: true, nodeId: "phase/plan%231/agent/planner" });
  const rows = dashboard.slice(dashboard.indexOf("Tree") + 1);
  const harness = await open([], { source, rows: 24 });
  await opened(harness);
  assert.match(title(harness), /^#1\/4 Planner completed/);
  // The /workflow rows one level deeper, the first agent selected; the root is a header that names the run, as the sidebar can hold several.
  assert.deepEqual(rows.slice(0, 3), ["  ▾ Workflow · ⠦", "  ▾ plan · ✓", "→   • Planner · ✓"]);
  assert.deepEqual(sidebarRows(harness), ["  ▾ review flow run  ⠦ 2/4", ...rows.slice(1).map((row) => `${row.slice(0, 2)}  ${row.slice(2)}`)]);
  harness.send(KEY.down);
  await settle();
  const lines = harness.screen();
  assert.equal((lines[0] ?? "").replace(/ {2,}\d+\/\d+ running.*$/, ""), "review running");
  const details = lines.slice(1, 9).map((line) => line.slice(line.indexOf("│") + 1).trim());
  assert.deepEqual(details.slice(0, 4), ["Selected phase: review", "Status: running", "agents completed=1 running=1 failed=0 cancelled=0 pending=1", "Agents: 3"]);
  assert.ok(details.some((line) => line.startsWith("Elapsed:")), "the phase's usage");
  assert.ok(!lines.some((line) => line.includes("enter ")), "without the /workflow enter hints");
  assert.deepEqual(harness.opened, ["run:run:planner"]);
  assert.ok(lines.every((line) => visibleWidth(line) <= 120));
  await leave(harness);

  const narrow = await open([], { source, columns: 70, rows: 24 });
  await opened(narrow);
  narrow.send("s");
  for (const step of ["", KEY.down, KEY.up, KEY.up, KEY.up]) {
    if (step) narrow.send(step);
    await settle();
    const frame = narrow.screen();
    assert.ok(frame.every((line) => visibleWidth(line) <= 70), frame.join("\n"));
  }
  assert.equal(title(narrow).trimEnd(), "review flow run running");
  assert.ok(narrow.screen().some((line) => line.includes("Selected workflow: review")), "the details wrap beside the sidebar");
  await leave(narrow);
});

function describeTarget(target: AgentsActionTarget): string {
  switch (target.kind) {
    case "run": return `run:${target.runId}`;
    case "workflow-agent": return `agent:${target.runId}/${target.agentId}`;
    case "subagent": return `subagent:${target.id}`;
    case "subagents": return "subagents";
  }
}
/** A provider whose labels the test sets by target kind; it records each run as "<target> <label>" and runs `onRun` for it. */
class FakeProvider implements AgentsActionProvider {
  readonly runs: string[] = [];
  /** The next actions() call waits for it, then reads the labels. */
  hold: Promise<void> | undefined;
  /** Every actions() call rejects with it while set. */
  failure: Error | undefined;
  constructor(public labels: Partial<Record<AgentsActionTarget["kind"], readonly AgentsAction[]>>, readonly onRun: (label: string, ui: ActionUi) => Promise<void> | void = () => undefined) {}
  async actions(target: AgentsActionTarget): Promise<readonly AgentsAction[]> {
    const hold = this.hold;
    if (hold) await hold;
    if (this.failure) throw this.failure;
    return this.labels[target.kind] ?? [];
  }
  async run(target: AgentsActionTarget, label: string, ui: ActionUi): Promise<{ readonly select?: string }> {
    this.runs.push(`${describeTarget(target)} ${label}`);
    await this.onRun(label, ui);
    return {};
  }
}
function steps(...labels: string[]): AgentsAction[] { return labels.map((label) => ({ label })); }
function inPlace(...labels: string[]): AgentsAction[] { return labels.map((label) => ({ label, inPlace: true })); }
const RUN: AgentsActionTarget = { kind: "run", runId: "R" };
/** TREE with the targets the session source gives: the run's nodes the run, its agents themselves, the group and its subagent. */
const TARGETED = (): Spec[] => TREE().map((spec): Spec => ({ ...spec, target: spec.key === "subagents" ? { kind: "subagents" } : spec.key === "s" ? { kind: "subagent", id: "s" } : spec.agent ? { kind: "workflow-agent", runId: "R", agentId: spec.key } : RUN }));
const MENU_HEADING = /─ (Run actions|Agent actions|Subagent actions|Subagents) ─/;
/** The open action menu cut out of the screen as the workspace lays it out (half the width, 32 columns at least, a column clear of each side): heading, rows, closing rule; [] while none is open. */
function menu(pi: FakePi): string[] {
  const lines = pi.screen();
  const top = lines.findIndex((line) => MENU_HEADING.test(line));
  if (top < 0) return [];
  const columns = pi.terminal.columns;
  const width = Math.min(Math.max(Math.floor(columns / 2), 32), columns - 2);
  const column = (lines[top] ?? "").search(MENU_HEADING);
  const block: string[] = [];
  for (const line of lines.slice(top)) {
    const cell = line.slice(column, column + width).trimEnd();
    block.push(cell);
    if (block.length > 1 && /^─+$/.test(cell)) break;
  }
  return block;
}
/** The menu's heading text and its rows without the closing rule. */
function menuRows(pi: FakePi): string[] {
  const block = menu(pi);
  return block.length === 0 ? [] : [(block[0] ?? "").replace(/─/g, "").trim(), ...block.slice(1, -1)];
}
/** The status row under the right pane, without the sidebar. */
function status(pi: FakePi): string { return (pi.screen().at(-2) ?? "").replace(/^.*│/, "").trim(); }
async function until(condition: () => boolean, what: string): Promise<void> {
  for (let wait = 0; wait < 1000 && !condition(); wait += 1) await new Promise((resolve) => { setTimeout(resolve, 5); });
  assert.ok(condition(), what);
}

void test("a opens the action menu on every node with a target, titled by its kind, with every provider's labels in provider order", async (t) => {
  timers(t);
  const first = new FakeProvider({ run: steps("Pause", "Stop"), "workflow-agent": inPlace("Copy agent ID"), subagent: steps("Steer"), subagents: steps("Delete all completed") });
  const second = new FakeProvider({ run: steps("Model aliases"), subagent: inPlace("Copy branch") });
  const specs = TARGETED().map((spec) => spec.key === "c" ? { key: spec.key, parent: "P", agent: agent("c") } : spec);
  const harness = await open([], { nodes: tree(specs), actions: [first, second] });
  const opened = async (keys: readonly string[]): Promise<string[]> => {
    harness.send(...keys, "a");
    await settle();
    const rows = menuRows(harness);
    harness.send(KEY.escape);
    await settle();
    assert.deepEqual(menu(harness), [], "esc closed the menu");
    return rows;
  };
  assert.deepEqual(await opened([]), ["Agent actions", "→ Copy agent ID"], "on a workflow agent");
  assert.equal(harness.left, false, "esc closed only the menu");
  assert.deepEqual(await opened([KEY.up]), ["Run actions", "→ Pause", "  Stop", "  Model aliases"], "on an operation scope");
  assert.deepEqual(await opened([KEY.up]), ["Run actions", "→ Pause", "  Stop", "  Model aliases"], "on a phase");
  assert.deepEqual(await opened([KEY.up]), ["Run actions", "→ Pause", "  Stop", "  Model aliases"], "on the run header");
  assert.equal(title(harness).trimEnd(), "Workflow running");
  harness.send(KEY.down, KEY.down, KEY.down, KEY.down, KEY.down);
  await settle();
  assert.match(title(harness), /^#3\/4 c/);
  harness.send("a");
  await settle();
  assert.deepEqual(menu(harness), [], "no menu on a node without a target");
  assert.equal(harness.alt().hasOverlay(), false);
  assert.deepEqual(await opened([KEY.down]), ["Subagents", "→ Delete all completed"], "on the group");
  assert.deepEqual(await opened([KEY.down, KEY.tab]), ["Subagent actions", "→ Steer", "  Copy branch"], "on a subagent, with the transcript focused");
  assert.deepEqual([...first.runs, ...second.runs], []);
  await leave(harness);
});

void test("the menu shows loading… until the labels come and no actions when there are none", async (t) => {
  timers(t);
  let release = (): void => undefined;
  const provider = new FakeProvider({ run: steps("Pause") });
  provider.hold = new Promise<void>((resolve) => { release = resolve; });
  const harness = await open([], { nodes: tree(TARGETED()), initialKey: "O", actions: [provider] });
  harness.send("a");
  await settle();
  assert.deepEqual(menuRows(harness), ["Run actions", "loading…"]);
  harness.send(KEY.enter);
  await settle();
  assert.equal(harness.left, false, "enter does nothing while the labels load");
  provider.hold = undefined;
  release();
  await settle();
  assert.deepEqual(menuRows(harness), ["Run actions", "→ Pause"]);
  harness.send(KEY.escape, KEY.down, KEY.down, KEY.down, KEY.down, "a");
  await settle();
  assert.equal(title(harness).trimEnd(), "Subagents running");
  assert.deepEqual(menuRows(harness), ["Subagents", "no actions"]);
  harness.send(KEY.enter);
  await settle();
  assert.equal(harness.left, false);
  await leave(harness);
});

void test("labels that cannot be read show actions unavailable, at the first read and on a refresh, and take no key until a read succeeds", async (t) => {
  timers(t);
  const provider = new FakeProvider({ run: steps("Pause", "Stop") });
  provider.failure = new Error("store locked");
  const harness = await open([], { nodes: tree(TARGETED()), initialKey: "O", actions: [provider] });
  harness.send("a");
  await settle();
  assert.deepEqual(menuRows(harness), ["Run actions", "actions unavailable: store locked"], "at the first read");
  harness.send(KEY.enter);
  await settle();
  assert.equal(harness.left, false, "enter runs nothing");
  provider.failure = undefined;
  await advance(t);
  assert.deepEqual(menuRows(harness), ["Run actions", "→ Pause", "  Stop"], "a refresh that reads them shows them");
  harness.send(KEY.down);
  provider.failure = new Error("store gone");
  await advance(t);
  assert.deepEqual(menuRows(harness), ["Run actions", "actions unavailable: store gone"], "a failed refresh shows its error instead of the labels it read before");
  harness.send(KEY.up, KEY.enter);
  await settle();
  assert.equal(harness.left, false, "enter runs nothing");
  provider.failure = undefined;
  await advance(t);
  assert.deepEqual(menuRows(harness), ["Run actions", "  Pause", "→ Stop"], "the next read keeps the label selected before");
  assert.deepEqual(provider.runs, []);
  await leave(harness);
});

void test("a provider whose labels cannot be read costs only its own: the others' labels show in provider order and take the keys, then a row with its error", async (t) => {
  timers(t);
  const first = new FakeProvider({ run: steps("Pause", "Stop") });
  const second = new FakeProvider({ run: steps("Model aliases") });
  const third = new FakeProvider({ run: steps("Delete all completed") });
  second.failure = new Error("aliases locked");
  const harness = await open([], { nodes: tree(TARGETED()), initialKey: "O", actions: [first, second, third] });
  harness.send("a");
  await settle();
  assert.deepEqual(menuRows(harness), ["Run actions", "→ Pause", "  Stop", "  Delete all completed", "actions unavailable: aliases locked"], "the labels read, then the error");
  harness.send(KEY.up);
  await settle();
  assert.deepEqual(menuRows(harness), ["Run actions", "  Pause", "  Stop", "→ Delete all completed", "actions unavailable: aliases locked"], "↑ wraps over the labels, not onto the error row");
  second.failure = undefined;
  await advance(t);
  assert.deepEqual(menuRows(harness), ["Run actions", "  Pause", "  Stop", "  Model aliases", "→ Delete all completed"], "a read that gets them puts them in provider order and keeps the selected label");
  harness.send(KEY.up);
  first.failure = new Error("store gone");
  await advance(t);
  assert.deepEqual(menuRows(harness), ["Run actions", "→ Model aliases", "  Delete all completed", "actions unavailable: store gone"], "the selected label of a provider still read stays selected");
  harness.send(KEY.enter);
  await harness.done;
  assert.deepEqual(harness.exit && { target: harness.exit.target, label: harness.exit.label }, { target: RUN, label: "Model aliases" }, "enter runs it");
  assert.deepEqual([...first.runs, ...second.runs, ...third.runs], []);
});

void test("enter with the sidebar focused opens the menu on a node that is not an agent; on an agent it still loads the large record", async (t) => {
  timers(t);
  const provider = new FakeProvider({ run: steps("Pause"), "workflow-agent": steps("Stop") });
  const harness = await open([], { nodes: tree(TARGETED()), actions: [provider], setup: (source) => { source.polls.push(polled([entry(0), large(10)])); } });
  assert.match(title(harness), /^#1\/4 a/);
  harness.send(KEY.enter);
  await settle();
  assert.deepEqual(menu(harness), [], "no menu on an agent");
  assert.ok(harness.source("a").calls.includes("loadRecord:10"), "enter loaded the record");
  harness.send(KEY.up, KEY.enter);
  await settle();
  assert.deepEqual(menuRows(harness), ["Run actions", "→ Pause"], "enter on the operation scope");
  harness.send(KEY.escape, KEY.tab, KEY.enter);
  await settle();
  assert.deepEqual(menu(harness), [], "not with the transcript focused");
  harness.send("a");
  await settle();
  assert.deepEqual(menuRows(harness), ["Run actions", "→ Pause"], "a still opens it there");
  await leave(harness);
});

void test("without providers a does nothing, enter on a node that is not an agent does nothing, and the hint names no menu", async (t) => {
  timers(t);
  for (const actions of [undefined, []]) {
    const harness = await open([], { nodes: tree(TARGETED()), ...(actions === undefined ? {} : { actions }) });
    harness.send("a");
    await settle();
    assert.equal(harness.alt().hasOverlay(), false);
    harness.send(KEY.up, KEY.enter, "a");
    await settle();
    assert.equal(harness.alt().hasOverlay(), false);
    assert.equal(title(harness).trimEnd(), "O running");
    assert.doesNotMatch(harness.screen().at(-1) ?? "", /a menu/);
    await leave(harness);
  }
});

void test("in the menu ↑↓ and j/k move round, other keys belong to it, esc, ← and h close it, and ctrl+c leaves with no action", async (t) => {
  timers(t);
  const provider = new FakeProvider({ run: steps("One", "Two", "Three") });
  const harness = await open([], { nodes: tree(TARGETED()), initialKey: "O", actions: [provider] });
  const selected = (): string | undefined => menuRows(harness).find((line) => line.startsWith("→ "));
  harness.send("a");
  await settle();
  const moves: (string | undefined)[] = [];
  for (const key of [KEY.down, "j", "j", "k", KEY.up, KEY.up]) {
    harness.send(key);
    moves.push(selected());
  }
  assert.deepEqual(moves, ["→ Two", "→ Three", "→ One", "→ Three", "→ Two", "→ One"]);
  harness.send("s", "q", KEY.tab, "]", " ", KEY.right, "l", KEY.pageDown);
  await settle();
  assert.equal(selected(), "→ One", "the menu kept the keys");
  assert.ok(harness.screen().some((line) => line.startsWith("  ▾ Subagents")), "s did not hide the sidebar");
  assert.equal(title(harness).trimEnd(), "O running", "] selected nothing");
  for (const close of [KEY.escape, KEY.left, "h"]) {
    harness.send(close);
    await settle();
    assert.deepEqual(menu(harness), [], `${JSON.stringify(close)} closed the menu`);
    assert.equal(title(harness).trimEnd(), "O running", "and moved nothing");
    harness.send("a");
    await settle();
    assert.equal(selected(), "→ One", "the menu opens on the first label again");
  }
  harness.send(KEY.ctrlC);
  await harness.done;
  assert.equal(harness.exit, undefined, "ctrl+c leaves with no action");
  assert.deepEqual(harness.parent, ["stop:true", "start", "renderNow:false"]);
  assert.deepEqual(provider.runs, []);
});

/** A wheel step up (SGR) at the 0-based screen `column` and `row`. */
function wheelUp(column: number, row: number): string { return `${ESC}[<64;${String(column + 1)};${String(row + 1)}M`; }

void test("while the menu is open the search key, the page keys, home and end (also as tmux sends them), a paste and the wheel do nothing: no other overlay, the transcript stays where it was", async (t) => {
  timers(t);
  const harness = await open([], { nodes: tree(TARGETED()), actions: [new FakeProvider({ "workflow-agent": steps("One", "Two") })], setup: (source) => { source.polls.push(polled(entries(0, 100))); } });
  harness.screen();
  const end = harness.alt().viewportTop;
  assert.ok(end > 0, "the transcript is longer than the pane");
  const earlier = harness.source("a").count("loadEarlier");
  harness.send("a");
  await settle();
  harness.send(KEY.search, "x", KEY.pageUp, KEY.pageUp, KEY.home, KEY.homeTmux, KEY.endTmux, paste("k"), "é", wheelUp(110, 5), wheelUp(5, 5), KEY.down);
  await settle();
  harness.screen();
  assert.equal(harness.alt().viewportTop, end, "the transcript did not scroll");
  assert.equal(harness.source("a").count("loadEarlier"), earlier, "nor read earlier records");
  assert.equal(harness.alt().isFollowingOutput, true);
  assert.deepEqual(menuRows(harness), ["Agent actions", "  One", "→ Two"], "the menu had the keys");
  harness.send(KEY.escape);
  await settle();
  assert.deepEqual(menu(harness), [], "esc closed the menu");
  assert.equal(harness.alt().hasOverlay(), false, "and no search box was left under it");
  assert.equal(harness.left, false);
  harness.send(KEY.pageUp);
  harness.screen();
  assert.ok(harness.alt().viewportTop < end, "the page keys scroll again once it closed");
  await leave(harness);
});

void test("the menu fits the terminal at 120, 70 and 40 columns and 10 rows, with the selected row in view", async (t) => {
  timers(t);
  const labels = [...Array.from({ length: 11 }, (_, index) => `Label ${String(index + 1)}`), `Label 12 ${"with a very long description ".repeat(6)}`];
  for (const columns of [120, 70, 40]) {
    const harness = await open([], { columns, rows: 10, nodes: tree(TARGETED()), initialKey: "O", actions: [new FakeProvider({ run: steps(...labels) })] });
    const check = (selected: string): void => {
      const lines = harness.screen();
      assert.equal(lines.length, 10);
      assert.ok(lines.every((line) => visibleWidth(line) <= columns), `${String(columns)} columns:\n${lines.join("\n")}`);
      const block = menu(harness);
      const top = lines.findIndex((line) => MENU_HEADING.test(line));
      assert.ok(top >= 1 && top + block.length <= 9, `at most rows - 2 rows, clear of the title and the hint (${String(columns)} columns):\n${lines.join("\n")}`);
      assert.ok(block.length <= 8);
      assert.ok(block.some((line) => line.startsWith(`→ ${selected}`)), `${selected} in view at ${String(columns)} columns:\n${block.join("\n")}`);
    };
    harness.send("a");
    await settle();
    check("Label 1");
    assert.equal(menu(harness).length, 8, "six labels between the heading and the closing rule");
    harness.send(KEY.up);
    check("Label 12");
    const long = menu(harness).find((line) => line.startsWith("→ Label 12")) ?? "";
    assert.ok(long.endsWith("…"), "a long label is cut at the width");
    harness.send(KEY.down);
    check("Label 1");
    for (let step = 0; step < 7; step += 1) harness.send("j");
    check("Label 8");
    await leave(harness);
  }
});

void test("a refresh re-reads the labels and keeps the selected one, else the last; a late answer is dropped; clicks on the sidebar do nothing while it is open; it closes when its node goes away", async (t) => {
  timers(t);
  const provider = new FakeProvider({ run: steps("Pause", "Stop", "Delete") });
  const harness = await open([], { nodes: tree(TARGETED()), initialKey: "O", actions: [provider] });
  harness.send("a");
  await settle();
  harness.send(KEY.down);
  assert.deepEqual(menuRows(harness), ["Run actions", "  Pause", "→ Stop", "  Delete"]);
  provider.labels = { run: steps("Resume", "Stop") };
  await advance(t);
  assert.deepEqual(menuRows(harness), ["Run actions", "  Resume", "→ Stop"], "Stop kept");
  provider.labels = { run: steps("Resume", "Approve", "Cancel") };
  await advance(t);
  assert.deepEqual(menuRows(harness), ["Run actions", "  Resume", "  Approve", "→ Cancel"], "the last label once Stop went away");
  let release = (): void => undefined;
  provider.hold = new Promise<void>((resolve) => { release = resolve; });
  await advance(t);
  provider.hold = undefined;
  provider.labels = { run: steps("Fresh") };
  await advance(t);
  assert.deepEqual(menuRows(harness), ["Run actions", "→ Fresh"]);
  provider.labels = { run: steps("Stale") };
  release();
  await settle();
  assert.deepEqual(menuRows(harness), ["Run actions", "→ Fresh"], "the earlier tick's answer came late and was dropped");
  // The menu covers the middle of the screen; the start of each sidebar row stays in view.
  const row = rowOf(harness, "    • s · ");
  assert.ok(row > 0);
  click(harness, 6, row);
  click(harness, 2, rowOf(harness, "  ▾ Subagents"));
  await settle();
  assert.equal(title(harness).trimEnd(), "O running", "the clicks selected nothing");
  assert.ok(harness.screen().some((line) => line.startsWith("  ▾ Subagents · ⠦")), "and toggled nothing");
  assert.deepEqual(harness.opened, []);
  harness.nodes = tree(TARGETED().filter((spec) => !["O", "a", "b"].includes(spec.key)));
  await advance(t);
  assert.deepEqual(menu(harness), [], "the menu closed with its node");
  assert.match(title(harness), /^#1\/2 c/, "the selection went to the node now at its row");
  harness.send("s");
  assert.ok(!harness.screen().some((line) => line.includes("Subagents")), "the workspace has the keys again");
  assert.deepEqual(provider.runs, []);
  await leave(harness);
});

void test("a label that needs Pi's dialogs leaves the workspace as esc does and resolves with the target, the label and the state once Pi is back", async (t) => {
  timers(t);
  const provider = new FakeProvider({ run: steps("Pause", "Stop") });
  const harness = await open([], { nodes: tree(TARGETED()), actions: [provider] });
  harness.send(KEY.up, "a");
  await settle();
  harness.send(KEY.down, KEY.enter);
  await harness.done;
  assert.deepEqual(harness.parentAtExit, ["stop:true", "start", "renderNow:false"], "Pi restarted before the promise resolved");
  assert.deepEqual(harness.exit && { ...harness.exit, state: { ...harness.exit.state, expansion: Object.fromEntries(harness.exit.state.expansion) } }, {
    target: RUN, label: "Stop",
    state: { selectedKey: "O", row: 2, expansion: { "run:R": true, P: true, O: true, subagents: true }, focus: "sidebar", sidebarVisible: true, toolsExpanded: false, detailsShown: false },
  });
  assert.deepEqual(provider.runs, [], "the caller runs it with Pi's dialogs");
  assert.equal(harness.source("a").calls.at(-1), "close");
  assert.ok(harness.terminal.written.endsWith(`${ESC}[?1049l${ESC}[?25h${ESC}[?2026l`));
  const lists = harness.listCalls;
  await advance(t, 2);
  assert.equal(harness.listCalls, lists, "nothing runs after leaving");
});

void test("an in-place label runs inside the workspace: other keys are ignored and the ticks pause until it settles, then its notice shows until the next key", async (t) => {
  timers(t);
  const escaped = escapes(t);
  const gates: (() => void)[] = [];
  const provider = new FakeProvider({ "workflow-agent": inPlace("Copy agent ID") }, async (_label, ui) => {
    await new Promise<void>((resolve) => { gates.push(resolve); });
    ui.notify("Copied agent ID.");
  });
  const harness = await open([], { nodes: tree(TARGETED()), actions: [provider], setup: (source) => { source.polls.push(polled(entries(0, 100))); } });
  harness.send("a");
  await settle();
  harness.send(KEY.enter);
  await settle();
  assert.deepEqual(provider.runs, ["agent:R/a Copy agent ID"]);
  assert.deepEqual(menu(harness), [], "the menu closed");
  const before = harness.screen();
  const end = harness.alt().viewportTop;
  assert.ok(end > 0, "the transcript is longer than the pane");
  const lists = harness.listCalls;
  const pollCount = polls(harness);
  const earlier = harness.source("a").count("loadEarlier");
  harness.send(KEY.down, "s", "a", KEY.escape, KEY.tab, "]", KEY.enter, "d", KEY.pageUp, KEY.pageUp, KEY.search, "x", KEY.home, KEY.homeTmux, KEY.endTmux, paste("s"), "é", wheelUp(110, 5), wheelUp(5, 5));
  await settle();
  assert.deepEqual(harness.screen(), before, "every key was ignored");
  assert.equal(harness.alt().viewportTop, end, "the page keys, home and end (also as tmux sends them) and the wheel did not scroll the transcript");
  assert.equal(harness.source("a").count("loadEarlier"), earlier, "nor read earlier records from the source");
  assert.equal(harness.alt().hasOverlay(), false, "the search key opened no search box");
  assert.equal(harness.left, false);
  await advance(t, 2);
  assert.equal(harness.listCalls, lists, "no refresh while it runs");
  assert.equal(polls(harness), pollCount, "no poll while it runs");
  gates.shift()?.();
  await settle();
  assert.equal(status(harness), "Copied agent ID.");
  assert.equal(harness.alt().hasOverlay(), false, "and none opens once it settled");
  await advance(t);
  assert.ok(harness.listCalls > lists && polls(harness) > pollCount, "the ticks go on");
  assert.equal(status(harness), "Copied agent ID.", "the notice outlasts a refresh");
  harness.send(KEY.pageUp);
  assert.equal(status(harness), "", "the next key clears it, also one the alt screen takes");
  assert.ok(harness.alt().viewportTop < end, "and the page keys scroll again");
  harness.send("a");
  await settle();
  harness.send(KEY.enter);
  await settle();
  harness.send(KEY.ctrlC);
  await harness.done;
  assert.equal(harness.exit, undefined, "ctrl+c still leaves while it runs");
  gates.shift()?.();
  await settle();
  assert.deepEqual(harness.notified, []);
  assert.deepEqual(escaped, []);
});

void test("an in-place label that asks for one of Pi's dialogs is reported in the status row with its label", async (t) => {
  timers(t);
  const escaped = escapes(t);
  const provider = new FakeProvider({ run: inPlace("Copy run ID", "Open script in editor") }, async (label, ui) => {
    if (label === "Copy run ID") await ui.confirm("Copy?", "Copy the run ID?");
    else ui.status("opening");
  });
  const harness = await open([], { nodes: tree(TARGETED()), initialKey: "O", actions: [provider] });
  harness.send("a");
  await settle();
  harness.send(KEY.enter);
  await settle();
  assert.match(status(harness), /^Copy run ID: confirm needs Pi's dialogs/);
  harness.send("a");
  await settle();
  harness.send(KEY.down, KEY.enter);
  await settle();
  assert.match(status(harness), /^Open script in editor: status needs Pi's dialogs/);
  harness.send(KEY.down);
  await settle();
  assert.match(title(harness), /^#1\/4 a/, "the workspace goes on");
  await leave(harness);
  assert.deepEqual(escaped, []);
});

const EDITOR_SCRIPT = `import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
const [opened, release, code, file] = process.argv.slice(2);
writeFileSync(\`\${opened}.part\`, readFileSync(file, "utf8"));
renameSync(\`\${opened}.part\`, opened);
const wait = () => { if (existsSync(release)) process.exit(Number(code)); else setTimeout(wait, 10); };
wait();
`;
/** An external editor that notes the artifact in `opened-<round>` and exits with `code` once `release-<round>` exists. */
function editor(): { readonly dir: string; command(round: number, code: number): string; opened(round: number): string; release(round: number): void } {
  const dir = mkdtempSync(join(tmpdir(), "pi-extensible-workflows-agents-editor-"));
  homes.push(dir);
  const script = join(dir, "editor.mjs");
  writeFileSync(script, EDITOR_SCRIPT);
  return {
    dir,
    command: (round, code) => `${process.execPath} ${script} ${join(dir, `opened-${String(round)}`)} ${join(dir, `release-${String(round)}`)} ${String(code)}`,
    opened: (round) => join(dir, `opened-${String(round)}`),
    release: (round) => { writeFileSync(join(dir, `release-${String(round)}`), ""); },
  };
}

void test("an in-place editor leaves the alternate screen without writing the workspace into Pi's screen, comes back with a full redraw, and never starts Pi's TUI", async (t) => {
  timers(t);
  const external = editor();
  let round = 0;
  let code = 0;
  let finished = 0;
  const provider = new FakeProvider({ run: inPlace("Open script in editor") }, async (_label, ui) => {
    await ui.openArtifact({ extension: ".js", content: "return 1;" }, "script");
    finished += 1;
  });
  const harness = await open([], { nodes: tree(TARGETED()), initialKey: "O", actions: [provider], editorCommand: () => external.command(round, code) });
  harness.send("a");
  await settle();
  harness.send(KEY.enter);
  await until(() => existsSync(external.opened(0)), "the editor started");
  assert.equal(readFileSync(external.opened(0), "utf8"), "return 1;");
  const stopped = harness.terminal.written;
  assert.ok(stopped.endsWith(`${ESC}[?1049l${ESC}[?25h${ESC}[?2026l`), "left the alternate screen keeping Pi's screen, with nothing written after it");
  assert.equal(harness.terminal.input, undefined, "the editor has the terminal");
  assert.deepEqual(harness.parent, ["stop:true"], "Pi's TUI stays stopped");
  external.release(0);
  await until(() => finished === 1, "the editor exited");
  await settle();
  const restarted = harness.terminal.written.slice(stopped.length);
  assert.ok(restarted.includes(`${ESC}[?1049h`), "entered the alternate screen again");
  assert.ok(stripTerminalSequences(restarted).includes("O running"), "and drew the whole frame");
  assert.ok(harness.terminal.input, "the workspace reads the terminal again");
  assert.equal(Object.hasOwn(harness.terminal, "start"), false, "through its own start");
  assert.deepEqual(harness.parent, ["stop:true"]);
  assert.equal(status(harness), "", "nothing to report");
  harness.send("a");
  await settle();
  harness.send(KEY.search, "x");
  await settle();
  assert.ok(!harness.screen().some((line) => line.includes("Find in transcript")), "the workspace still reads the keys first: the search key opened no box over the menu");
  assert.deepEqual(menuRows(harness), ["Run actions", "→ Open script in editor"], "the menu kept the keys");
  harness.send(KEY.escape);
  await settle();
  assert.deepEqual(menu(harness), []);
  assert.equal(harness.alt().hasOverlay(), false);
  round = 1;
  code = 3;
  harness.send("a");
  await settle();
  harness.send(KEY.enter);
  await until(() => existsSync(external.opened(1)), "the editor started again");
  external.release(1);
  await until(() => finished === 2, "the editor exited again");
  await settle();
  assert.equal(status(harness), "Cannot open script: external editor exited with code 3.");
  await leave(harness);
  assert.deepEqual(harness.parent, ["stop:true", "start", "renderNow:false"]);
});

void test("a resize across 80 columns while the in-place editor has the terminal hides or shows the sidebar, with its focus, when the workspace comes back", async (t) => {
  timers(t);
  const external = editor();
  let round = 0;
  let finished = 0;
  const provider = new FakeProvider({ run: inPlace("Open script in editor") }, async (_label, ui) => {
    await ui.openArtifact({ extension: ".js", content: "return 1;" }, "script");
    finished += 1;
  });
  const harness = await open([], { nodes: tree(TARGETED()), initialKey: "O", actions: [provider], editorCommand: () => external.command(round, 0) });
  for (const [columns, shown] of [[70, false], [120, true]] as const) {
    harness.send("a");
    await settle();
    harness.send(KEY.enter);
    await until(() => existsSync(external.opened(round)), "the editor started");
    assert.equal(harness.terminal.onResize, undefined, "no resize reaches the workspace while the editor has the terminal");
    harness.terminal.columns = columns;
    external.release(round);
    await until(() => finished === round + 1, "the editor exited");
    await settle();
    assert.ok(harness.terminal.input, "the workspace is back");
    assert.equal(sidebarShown(harness), shown, `${String(columns)} columns`);
    assert.match(harness.screen().at(-1) ?? "", shown ? /^←→\/space fold/ : /^↑↓ scroll/, shown ? "the sidebar has the focus" : "the transcript has the focus");
    assert.match(title(harness), /^O running/, "on the same node");
    round += 1;
  }
  await leave(harness);
});

void test("an in-place editor without a configured editor reports it in the status row", async (t) => {
  timers(t);
  for (const editorCommand of [undefined, () => undefined]) {
    const provider = new FakeProvider({ run: inPlace("Open script in editor") }, (_label, ui) => ui.openArtifact({ extension: ".js", content: "return 1;" }, "script"));
    const harness = await open([], { nodes: tree(TARGETED()), initialKey: "O", actions: [provider], ...(editorCommand === undefined ? {} : { editorCommand }) });
    harness.send("a");
    await settle();
    harness.send(KEY.enter);
    await settle();
    assert.equal(status(harness), "Cannot open script: no external editor is configured.");
    assert.deepEqual(harness.parent, ["stop:true"]);
    await leave(harness);
  }
});

void test("an abort while the artifact is written starts no editor and gives Pi the terminal back once", async (t) => {
  timers(t);
  const escaped = escapes(t);
  const external = editor();
  const controller = new AbortController();
  const provider = new FakeProvider({ run: inPlace("Open script in editor") }, async (_label, ui) => {
    const opening = ui.openArtifact({ extension: ".js", content: "return 1;" }, "script");
    controller.abort();
    await opening;
  });
  const harness = await open([], { nodes: tree(TARGETED()), initialKey: "O", actions: [provider], signal: controller.signal, editorCommand: () => external.command(0, 0) });
  harness.send("a");
  await settle();
  harness.send(KEY.enter);
  await harness.done;
  await settle();
  assert.equal(existsSync(external.opened(0)), false, "no editor started");
  assert.deepEqual(harness.parent, ["stop:true", "start", "renderNow:false"], "Pi was restored once");
  assert.equal(harness.terminal.stops, 1);
  assert.deepEqual(escaped, []);
});

void test("a transcript scrolled up comes back at the same place after a step-aside action; one at the tail stays at the tail", async (t) => {
  timers(t);
  const setup = (source: Parameters<NonNullable<Parameters<typeof open>[1]>["setup"] & object>[0]): void => { source.polls.push(polled(entries(0, 100))); };
  const provider = new FakeProvider({ "workflow-agent": steps("Stop") });
  const nodes = tree(TARGETED());
  for (const up of [true, false]) {
    const first = await open([], { nodes, initialKey: "a", actions: [provider], setup });
    first.screen();
    const end = first.alt().viewportTop;
    assert.equal(end, 100 - 18);
    if (up) { first.send(KEY.pageUp); first.screen(); }
    const top = first.alt().viewportTop;
    assert.equal(top < end, up);
    first.send("a");
    await settle();
    first.send(KEY.enter);
    await first.done;
    assert.ok(first.exit);
    const second = await open([], { nodes, actions: [provider], setup, state: first.exit.state });
    second.screen();
    await settle();
    second.screen();
    assert.equal(second.alt().viewportTop, top, up ? "the same place" : "the tail");
    await leave(second);
  }
});

void test("a saved place beyond the reopened content is clamped to the top and the view can still scroll", async (t) => {
  timers(t);
  const provider = new FakeProvider({ "workflow-agent": steps("Stop") });
  const nodes = tree(TARGETED());
  const first = await open([], { nodes, initialKey: "a", actions: [provider], setup: (source) => { source.polls.push(polled(entries(0, 100))); } });
  first.screen();
  first.send(KEY.pageUp);
  first.send(KEY.pageUp);
  first.screen();
  first.send("a");
  await settle();
  first.send(KEY.enter);
  await first.done;
  assert.ok(first.exit);
  const second = await open([], { nodes, actions: [provider], setup: (source) => { source.polls.push(polled(entries(0, 30))); }, state: first.exit.state });
  for (let round = 0; round < 3; round += 1) { second.screen(); await settle(); }
  second.screen();
  assert.equal(second.alt().viewportTop, 0, "clamped to the top");
  second.send(KEY.pageDown);
  second.screen();
  assert.ok(second.alt().viewportTop > 0, "page down moves the view");
  second.send(KEY.ctrlEnd);
  second.screen();
  assert.equal(second.alt().viewportTop, 30 - 18, "end reaches the tail");
  await leave(second);
});

void test("a place above the tail chunk comes back after earlier chunks are loaded on reopening", async (t) => {
  timers(t);
  const setup = (source: Parameters<NonNullable<Parameters<typeof open>[1]>["setup"] & object>[0]): void => {
    source.polls.push(polled(entries(100, 20)));
    source.earlier.push({ records: entries(0, 100), atStart: true });
  };
  const provider = new FakeProvider({ "workflow-agent": steps("Stop") });
  const nodes = tree(TARGETED());
  const first = await open([], { nodes, initialKey: "a", actions: [provider], setup });
  first.screen();
  first.send(KEY.home);
  await settle();
  first.screen();
  await settle();
  first.screen();
  // The earlier chunk is above the lines in view; page up into it so the place lies above the tail chunk.
  first.send(KEY.pageUp);
  first.screen();
  const top = first.alt().viewportTop;
  assert.ok(top > 0, "not at the start");
  assert.ok(top < 100 + 20 - 18, "not at the tail");
  assert.ok(new RegExp(`record ${String(top)}\\b`).test(first.screen()[1] ?? ""), "the first line in view is the record at the top row");
  const seen = first.screen().slice(1, 4).join("\n");
  first.send("a");
  await settle();
  first.send(KEY.enter);
  await first.done;
  assert.ok(first.exit);
  const second = await open([], { nodes, actions: [provider], setup, state: first.exit.state });
  for (let round = 0; round < 4; round += 1) { second.screen(); await settle(); }
  second.screen();
  assert.equal(second.alt().viewportTop, top, "the same place");
  assert.equal(second.screen().slice(1, 4).join("\n"), seen, "the same lines");
  await leave(second);
});

type PlaceSource = Parameters<NonNullable<Parameters<typeof open>[1]>["setup"] & object>[0];

/** Opens a long transcript, scrolls up into its earlier chunk, steps aside, and returns what the reopened workspace needs. */
async function savedPlace(): Promise<{ provider: FakeProvider; nodes: ReturnType<typeof tree>; state: NonNullable<Awaited<ReturnType<typeof open>>["exit"]>["state"]; top: number }> {
  const setup = (source: PlaceSource): void => { source.polls.push(polled(entries(100, 20))); source.earlier.push({ records: entries(0, 100), atStart: true }); };
  const provider = new FakeProvider({ "workflow-agent": steps("Stop") });
  const nodes = tree(TARGETED());
  const first = await open([], { nodes, initialKey: "a", actions: [provider], setup });
  first.screen();
  first.send(KEY.home);
  await settle();
  first.screen();
  await settle();
  first.screen();
  first.send(KEY.pageUp);
  first.screen();
  const top = first.alt().viewportTop;
  assert.ok(top > 0 && top < 100 + 20 - 18, "a place above the tail chunk");
  first.send("a");
  await settle();
  first.send(KEY.enter);
  await first.done;
  assert.ok(first.exit);
  return { provider, nodes, state: first.exit.state, top };
}

void test("a pending restore is applied once: PageDown while the earlier chunk is held stays, and the place is not applied again when it arrives", async (t) => {
  timers(t);
  const saved = await savedPlace();
  let release: () => void = () => undefined;
  const second = await open([], { nodes: saved.nodes, actions: [saved.provider], state: saved.state, setup: (source) => {
    source.polls.push(polled(entries(100, 20)));
    source.earlier.push({ records: entries(0, 100), atStart: true });
    source.earlierGate = new Promise<void>((resolve) => { release = resolve; });
  } });
  for (let round = 0; round < 3; round += 1) { second.screen(); await settle(); }
  second.screen();
  assert.equal(second.alt().viewportTop, 0, "at the top while the earlier chunk is held");
  second.send(KEY.pageDown);
  second.screen();
  const paged = second.alt().viewportTop;
  assert.ok(paged > 0, "page down moved the view");
  second.screen();
  await settle();
  second.screen();
  assert.equal(second.alt().viewportTop, paged, "the pending restore did not undo page down");
  release();
  for (let round = 0; round < 4; round += 1) { second.screen(); await settle(); }
  second.screen();
  assert.notEqual(second.alt().viewportTop, saved.top, "the user scrolled: the saved place is not applied again");
  assert.ok(second.alt().viewportTop >= paged, "the lines the user chose stay in view");
  await leave(second);
});

void test("a transcript reset while a restore is pending drops the saved place and stays at the tail", async (t) => {
  timers(t);
  const saved = await savedPlace();
  const second = await open([], { nodes: saved.nodes, actions: [saved.provider], state: saved.state, setup: (source) => {
    source.polls.push(polled(entries(500, 40), { reset: true }));
  } });
  for (let round = 0; round < 5; round += 1) { second.screen(); await advance(t); }
  second.screen();
  assert.equal(second.alt().viewportTop, 40 - 18, "at the tail of the new content");
  for (let round = 0; round < 3; round += 1) { second.screen(); await advance(t); }
  second.screen();
  assert.equal(second.alt().viewportTop, 40 - 18, "no later layout jumps back to the old offset");
  await leave(second);
});

void test("a failing earlier load gives up a pending restore: the view stays at the top and can scroll", async (t) => {
  timers(t);
  const saved = await savedPlace();
  const second = await open([], { nodes: saved.nodes, actions: [saved.provider], state: saved.state, setup: (source) => {
    source.polls.push(polled(entries(100, 20)));
    source.failEarlier = new Error("unreadable");
  } });
  for (let round = 0; round < 4; round += 1) { second.screen(); await settle(); }
  second.screen();
  assert.equal(second.alt().viewportTop, 0, "clamped to the top");
  second.send(KEY.pageDown);
  second.screen();
  assert.ok(second.alt().viewportTop > 0, "page down moves the view");
  await leave(second);
});

void test("a poll that is not available gives up a pending restore: later content does not bring the saved place back", async (t) => {
  timers(t);
  const saved = await savedPlace();
  const second = await open([], { nodes: saved.nodes, actions: [saved.provider], state: saved.state, setup: (source) => {
    source.polls.push(polled(entries(100, 20), { status: "unavailable" }), polled(entries(120, 200)));
    source.earlier.push({ records: [], atStart: false });
  } });
  for (let round = 0; round < 6; round += 1) { second.screen(); await advance(t); }
  second.screen();
  assert.equal(second.alt().viewportTop, 0, "the saved place is not applied once the content is long enough");
  second.send(KEY.pageDown);
  second.screen();
  assert.ok(second.alt().viewportTop > 0, "page down moves the view");
  await leave(second);
});

void test("an abort while the editor runs leaves when the editor exits: Pi is started once and the workspace does not come back", async (t) => {
  timers(t);
  const escaped = escapes(t);
  const external = editor();
  let finished = 0;
  const provider = new FakeProvider({ run: inPlace("Open script in editor") }, async (_label, ui) => {
    await ui.openArtifact({ extension: ".js", content: "return 1;" }, "script");
    finished += 1;
  });
  const controller = new AbortController();
  const harness = await open([], { nodes: tree(TARGETED()), initialKey: "O", actions: [provider], signal: controller.signal, editorCommand: () => external.command(0, 3) });
  harness.send("a");
  await settle();
  harness.send(KEY.enter);
  await until(() => existsSync(external.opened(0)), "the editor started");
  const stopped = harness.terminal.written.length;
  assert.equal(harness.terminal.stops, 1, "the editor stopped the terminal");
  const cursorShown = harness.terminal.written.split(`${ESC}[?25h`).length;
  let resolved = false;
  void harness.done.then(() => { resolved = true; });
  controller.abort();
  await settle();
  assert.equal(harness.terminal.input, undefined, "no key reaches the workspace while the editor runs");
  assert.deepEqual(harness.parent, ["stop:true"], "Pi stays stopped while the editor has the terminal");
  assert.equal(resolved, false, "the workspace is not left while the editor runs");
  external.release(0);
  await until(() => finished === 1, "the editor exited");
  await harness.done;
  assert.equal(harness.exit, undefined);
  assert.deepEqual(harness.parent, ["stop:true", "start", "renderNow:false"], "Pi is back");
  assert.equal(harness.terminal.stops, 1, "leaving stops the terminal no second time");
  assert.equal(harness.terminal.written.split(`${ESC}[?25h`).length, cursorShown, "nor shows the cursor again");
  await settle();
  assert.ok(!harness.terminal.written.slice(stopped).includes(`${ESC}[?1049h`), "the alternate screen was not entered again");
  assert.equal(harness.terminal.input, undefined);
  assert.deepEqual(harness.parent, ["stop:true", "start", "renderNow:false"], "Pi was started once");
  assert.equal(harness.terminal.stops, 1, "the terminal was stopped once");
  assert.deepEqual(harness.notified, [], "the editor's exit code goes nowhere once the workspace is left");
  assert.deepEqual(escaped, []);
});

void test("a terminal that cannot start again after the editor gives it back to Pi once and reports why the workspace closed", async (t) => {
  timers(t);
  const escaped = escapes(t);
  const external = editor();
  let finished = 0;
  const provider = new FakeProvider({ run: inPlace("Open script in editor") }, async (_label, ui) => {
    await ui.openArtifact({ extension: ".js", content: "return 1;" }, "script");
    finished += 1;
  });
  const harness = await open([], { nodes: tree(TARGETED()), initialKey: "O", actions: [provider], editorCommand: () => external.command(0, 0) });
  harness.send("a");
  await settle();
  harness.send(KEY.enter);
  await until(() => existsSync(external.opened(0)), "the editor started");
  harness.terminal.failStart = new Error("terminal unavailable");
  external.release(0);
  await until(() => finished === 1, "the editor exited");
  await harness.done;
  await settle();
  assert.equal(harness.exit, undefined);
  assert.deepEqual(harness.parent, ["stop:true", "start", "renderNow:false"], "Pi is back, started once");
  assert.deepEqual(harness.notified, ["error: agents workspace failed: terminal unavailable"], "reported once");
  assert.equal(harness.terminal.input, undefined, "the workspace reads nothing");
  assert.equal(Object.hasOwn(harness.terminal, "start"), false, "the terminal's start is its own again");
  const lists = harness.listCalls;
  await advance(t, 2);
  assert.equal(harness.listCalls, lists, "nothing runs after leaving");
  assert.deepEqual(escaped, []);
});

/** The state of a workspace that stepped aside with the agent b selected. */
function stateOf(overrides: Partial<AgentsWorkspaceState> = {}): AgentsWorkspaceState {
  return { selectedKey: "b", row: 4, expansion: [], focus: "sidebar", sidebarVisible: true, toolsExpanded: false, detailsShown: false, ...overrides };
}

void test("a state restores the selection by key, the expansion, the focus, the tools and the notices until the next key; the initial key wins over it", async (t) => {
  timers(t);
  const harness = await open([], { nodes: tree(TREE()), state: stateOf({ expansion: [["subagents", false], ["O", true]], focus: "transcript", toolsExpanded: true }), notices: ["Paused workflow Workflow.", "Moved to background."] });
  assert.match(title(harness), /^#2\/4 b/);
  assert.deepEqual(harness.opened, ["b"]);
  assert.deepEqual(sidebarRows(harness), ["  ▾ Workflow · ⠦", "    ▾ P · ⠦", "      ▾ O · ⠦", "        • a · ⠦", "→       • b · ✓", "      • c · ⠦", "  ▸ Subagents · ⠦"], "the recorded collapse kept, the keys not recorded as they come");
  assert.match(harness.screen().at(-1) ?? "", /^↑↓ scroll/, "the transcript has the focus");
  assert.ok(harness.view("b").calls.includes("expanded:true"), "tool output expanded");
  assert.equal(status(harness), "Paused workflow Workflow. · Moved to background.");
  await advance(t);
  assert.equal(status(harness), "Paused workflow Workflow. · Moved to background.", "until the next key");
  harness.send(KEY.down);
  assert.equal(status(harness), "");
  await leave(harness);

  const keyed = await open([], { nodes: tree(TREE()), initialKey: "s", state: stateOf({ expansion: [["subagents", false]] }) });
  assert.match(title(keyed), /^#4\/4 s/);
  assert.deepEqual(sidebarRows(keyed).slice(-2), ["  ▾ Subagents · ⠦", "→   • s · ⠦"], "the initial key's ancestors expanded");
  await leave(keyed);
});

void test("the notices end at any key: one parseKey does not name (é), home and end as tmux sends them, a paste; a focus report or a query's answer leaves them", async (t) => {
  timers(t);
  for (const key of ["é", KEY.homeTmux, KEY.endTmux, paste("x")]) {
    const harness = await open([], { nodes: tree(TREE()), notices: ["Paused workflow Workflow."] });
    harness.send(`${ESC}[I`, `${ESC}[O`, `${ESC}[?62;22c`);
    assert.equal(status(harness), "Paused workflow Workflow.", "not keys");
    harness.send(key);
    assert.equal(status(harness), "", JSON.stringify(key));
    await leave(harness);
  }
});

void test("a state whose key went away selects the node now at its row; a recorded collapse holds while new keys take their initial expansion", async (t) => {
  timers(t);
  const harness = await open([], { nodes: tree(TREE()), state: stateOf({ selectedKey: "gone", row: 2 }) });
  assert.equal(title(harness).trimEnd(), "O running");
  await leave(harness);
  const collapsed = await open([], { nodes: tree(TREE()), state: stateOf({ selectedKey: "s", row: 0, expansion: [["P", false], ["run:R", true]] }) });
  assert.deepEqual(sidebarRows(collapsed), ["  ▾ Workflow · ⠦", "    ▸ P · ⠦", "  ▾ Subagents · ⠦", "→   • s · ⠦"]);
  await leave(collapsed);
  const beyond = await open([], { nodes: tree(TREE()), state: stateOf({ selectedKey: "gone", row: 30 }) });
  assert.match(title(beyond), /^#4\/4 s/, "a row past the end gives the last visible node");
  await leave(beyond);
});

void test("a state's sidebar stays hidden below 80 columns; its tools and d hold", async (t) => {
  timers(t);
  const narrow = await open([], { columns: 70, nodes: tree(TREE()), state: stateOf({ sidebarVisible: true, focus: "sidebar" }) });
  assert.ok(!narrow.screen().some((line) => line.includes("Subagents")), "sidebar hidden");
  assert.match(narrow.screen().at(-1) ?? "", /^↑↓ scroll · \[ \] agent · ctrl\+shift\+f search/, "the transcript has the focus and tab moves nothing");
  await leave(narrow);
  const hidden = await open([], { nodes: tree(TREE()), state: stateOf({ sidebarVisible: false, focus: "sidebar" }) });
  assert.ok(!hidden.screen().some((line) => line.includes("Subagents")), "a hidden sidebar stays hidden");
  assert.match(hidden.screen().at(-1) ?? "", /^↑↓ scroll/);
  await leave(hidden);
  const specs = TREE().map((spec) => spec.key === "b" ? { ...spec, details: ["Model: gpt-5", "Tokens: 1.2k"] } : spec);
  const details = await open([], { nodes: tree(specs), state: stateOf({ detailsShown: true }) });
  assert.match(details.screen()[1] ?? "", /│ Model: gpt-5\s*$/, "the agent's details shown");
  assert.equal(details.source("b").count("poll") > 0, true, "its transcript still opened");
  await leave(details);
});

void test("an agent's details are read only while drawn: selecting it with its transcript shown asks hasDetails, d reads details", async () => {
  const counter = { reads: 0 };
  const reads = (): number => counter.reads;
  const nodes = tree(TREE()).map((node) => node.key === "b" ? { ...node, hasDetails: () => true, details: () => { counter.reads += 1; return ["Model: gpt-5"]; } } : node);
  const harness = await open([], { nodes, state: stateOf() });
  await settle();
  assert.equal(reads(), 0, "no details() call while the transcript is shown");
  assert.ok((harness.screen().at(-1) ?? "").includes("d details"), "the hint comes from hasDetails");
  harness.send("d");
  await settle();
  assert.ok(reads() > 0, "d draws the details");
  await leave(harness);
});

/** Opens TARGETED at `columns`, presses `keys`, then steps aside for the selected agent's Stop: the state its exit keeps. */
async function steppedAside(columns: number, ...keys: string[]): Promise<AgentsWorkspaceState> {
  const harness = await open([], { columns, nodes: tree(TARGETED()), actions: [new FakeProvider({ "workflow-agent": steps("Stop") })] });
  harness.send(...keys, "a");
  await settle();
  harness.send(KEY.enter);
  await harness.done;
  const exit = harness.exit;
  assert.ok(exit);
  assert.equal(exit.label, "Stop");
  return exit.state;
}

void test("a sidebar hidden below 80 columns when the workspace stepped aside comes back focused when it opens again on a wide terminal", async (t) => {
  timers(t);
  const narrow = await steppedAside(70);
  for (const columns of [120, 70]) {
    const again = await open([], { columns, nodes: tree(TARGETED()), state: narrow });
    if (columns === 70) {
      assert.equal(sidebarShown(again), false, "still hidden below 80 columns");
      assert.match(again.screen().at(-1) ?? "", /^↑↓ scroll/);
      again.terminal.resize(120);
    }
    assert.equal(sidebarShown(again), true, `opened at ${String(columns)} columns`);
    assert.match(again.screen().at(-1) ?? "", /^←→\/space fold/, "with the sidebar focused");
    assert.match(title(again), /^#1\/4 a/, "on the same node");
    await leave(again);
  }
});

void test("a sidebar hidden with s while it could show stays hidden when the workspace stepped aside and opens again, also across a resize; s still shows it", async (t) => {
  timers(t);
  const hidden = await steppedAside(120, "s");
  for (const columns of [70, 120]) {
    const again = await open([], { columns, nodes: tree(TARGETED()), state: hidden });
    assert.equal(sidebarShown(again), false, `opened at ${String(columns)} columns`);
    if (columns === 120) again.terminal.resize(70);
    again.terminal.resize(120);
    assert.equal(sidebarShown(again), false, `opened at ${String(columns)} columns, then 120`);
    assert.match(again.screen().at(-1) ?? "", /^↑↓ scroll/, "the transcript has the focus");
    again.send("s");
    assert.equal(sidebarShown(again), true, "s shows it");
    assert.match(title(again), /^#1\/4 a/, "on the same node");
    await leave(again);
  }
});

void test("the exit's state is the workspace's at that moment and opens it again as it was", async (t) => {
  timers(t);
  const specs = TARGETED().map((spec) => spec.key === "b" ? { ...spec, details: ["Model: gpt-5"] } : spec);
  const provider = new FakeProvider({ "workflow-agent": steps("Stop") });
  const harness = await open([], { nodes: tree(specs), actions: [provider] });
  harness.send(KEY.down, KEY.down, KEY.down, KEY.left, KEY.up, KEY.up, KEY.ctrlO, "d", KEY.tab);
  await settle();
  assert.match(title(harness), /^#2\/4 b/);
  const frame = harness.screen();
  harness.send("a");
  await settle();
  harness.send(KEY.enter);
  await harness.done;
  const exit = harness.exit;
  assert.ok(exit);
  assert.deepEqual(exit.target, { kind: "workflow-agent", runId: "R", agentId: "b" });
  assert.deepEqual({ ...exit.state, expansion: Object.fromEntries(exit.state.expansion) }, { selectedKey: "b", row: 4, expansion: { "run:R": true, P: true, O: true, subagents: false }, focus: "transcript", sidebarVisible: true, toolsExpanded: true, detailsShown: true });
  const again = await open([], { nodes: tree(specs), actions: [provider], state: exit.state });
  assert.deepEqual(again.screen(), frame, "the same frame");
  assert.ok(again.view("b").calls.includes("expanded:true"));
  await leave(again);
});

void test("with no agent node the first node is selected", async (t) => {
  timers(t);
  const harness = await open([], { nodes: tree([{ key: "run:R", kind: "run", label: "Workflow" }, { key: "P", parent: "run:R" }, { key: "Q", parent: "P", kind: "operation" }]) });
  assert.equal(title(harness).trimEnd(), "Workflow running");
  assert.deepEqual(sidebarRows(harness), ["→ ▾ Workflow · ⠦", "    ▾ P · ⠦", "        Q · ⠦"]);
  assert.match(harness.screen()[1] ?? "", /│ details of Workflow\s*$/);
  assert.deepEqual(harness.opened, []);
  await leave(harness);
});

void test("d shows an agent's details instead of its transcript, which keeps polling; the choice holds while the selection moves between agents", async (t) => {
  timers(t);
  const specs = TREE().map((spec) => spec.key === "a" ? { ...spec, details: ["Model: gpt-5", "Tokens: 1.2k"] } : spec.key === "b" ? { ...spec, details: ["Model: b-model"] } : spec);
  const harness = await open([], { nodes: tree(specs), setup: (source) => { source.polls.push(polled(entries(0, 3))); } });
  const pane = (): string => (harness.screen()[1] ?? "").replace(/^.*│ /, "").replace(/[\s┃█]+$/, "");
  assert.equal(pane(), "a record 0");
  assert.match(harness.screen().at(-1) ?? "", / · d details · /);
  harness.send("d");
  assert.equal(pane(), "Model: gpt-5");
  assert.match(harness.screen()[2] ?? "", /│ Tokens: 1\.2k\s*$/);
  assert.match(title(harness), /^#1\/4 a running/, "the title stays the agent's");
  const before = harness.source("a").count("poll");
  await advance(t, 2);
  assert.ok(harness.source("a").count("poll") > before, "the transcript keeps polling");
  harness.send("d");
  assert.equal(pane(), "a record 0", "d again shows the transcript");
  harness.send("d", KEY.down);
  await settle();
  assert.match(title(harness), /^#2\/4 b/);
  assert.equal(pane(), "Model: b-model", "the next agent shows its details too");
  harness.send(KEY.down);
  await settle();
  assert.match(title(harness), /^#3\/4 c/);
  assert.equal(pane(), "c record 0", "an agent without details shows its transcript");
  assert.doesNotMatch(harness.screen().at(-1) ?? "", /d details/);
  harness.send("d");
  assert.equal(pane(), "c record 0", "d does nothing there");
  harness.send(KEY.up);
  await settle();
  assert.equal(pane(), "Model: b-model", "and the choice still holds");
  harness.send(KEY.up, KEY.up, "d");
  await settle();
  assert.equal(title(harness).trimEnd(), "O running");
  assert.equal(pane(), "details of O", "d does nothing on a node that is not an agent");
  harness.send("]");
  await settle();
  assert.equal(pane(), "Model: gpt-5");
  await leave(harness);
});

void test("a refresh that leaves the selected agent without details while d is on shows its transcript, and its details again once they are back", async (t) => {
  timers(t);
  const withDetails = (): Spec[] => TREE().map((spec) => spec.key === "a" ? { ...spec, details: ["Model: gpt-5"] } : spec);
  const harness = await open([], { nodes: tree(withDetails()), setup: (source) => { source.polls.push(polled(entries(0, 3))); } });
  const pane = (): string => (harness.screen()[1] ?? "").replace(/^.*│ /, "").replace(/[\s┃█]+$/, "");
  harness.send("d");
  assert.equal(pane(), "Model: gpt-5");
  harness.nodes = tree(TREE());
  await advance(t);
  assert.equal(pane(), "a record 0", "no details: the transcript");
  assert.doesNotMatch(harness.screen().at(-1) ?? "", /d details/);
  assert.match(title(harness), /^#1\/4 a/, "the agent stays selected");
  assert.equal(harness.opened.filter((key) => key === "a").length, 1, "its transcript was not opened again");
  harness.nodes = tree(withDetails());
  await advance(t);
  assert.equal(pane(), "Model: gpt-5", "d still on: the details are back");
  harness.send("d");
  assert.equal(pane(), "a record 0", "d turns them off");
  await leave(harness);
});

void test("j, k, h and l move in the sidebar as the arrows do, and only there", async (t) => {
  timers(t);
  const harness = await open([], { nodes: tree(TREE()) });
  const moves: string[] = [];
  for (const key of ["k", "k", "j", "h", "h", "l", "l", "j"]) {
    harness.send(key);
    await settle();
    moves.push(sidebarRows(harness).find((line) => line.startsWith("→")) ?? "");
  }
  assert.deepEqual(moves, ["→     ▾ O · ⠦", "→   ▾ P · ⠦", "→     ▾ O · ⠦", "→     ▸ O · ⠦", "→   ▾ P · ⠦", "→     ▸ O · ⠦", "→     ▾ O · ⠦", "→       • a · ⠦"]);
  harness.send(KEY.tab, "k", "h", "j", "l");
  await settle();
  assert.match(title(harness), /^#1\/4 a/, "with the transcript focused they move nothing");
  await leave(harness);
});

void test("the hint names a menu with providers, d details on an agent with details, tab focus while the sidebar shows and enter load as before", async (t) => {
  timers(t);
  const specs = TARGETED().map((spec) => spec.key === "a" ? { ...spec, details: ["Model: gpt-5"] } : spec);
  const actions = [new FakeProvider({})];
  const harness = await open([], { nodes: tree(specs), actions });
  const hint = (): string => (harness.screen().at(-1) ?? "").trimEnd();
  assert.equal(hint(), "←→/space fold · [ ] agent · a menu · d details · tab focus · ctrl+shift+f search · s sidebar · ctrl+o tools · esc back");
  assert.equal(visibleWidth(hint()), 118, "118 columns with the default keys and an agent selected");
  harness.send(KEY.tab);
  assert.equal(hint(), "↑↓ scroll · [ ] agent · a menu · d details · tab focus · ctrl+shift+f search · s sidebar · ctrl+o tools · esc back");
  harness.send(KEY.tab, KEY.up);
  await settle();
  assert.equal(hint(), "←→/space fold · [ ] agent · a menu · tab focus · ctrl+shift+f search · s sidebar · ctrl+o tools · esc back", "no d details on a node that is not an agent");
  harness.send("s");
  assert.equal(hint(), "↑↓ scroll · [ ] agent · a menu · ctrl+shift+f search · s sidebar · ctrl+o tools · esc back", "no tab focus without the sidebar");
  await leave(harness);

  const plain = await open([], { nodes: tree(specs) });
  assert.equal((plain.screen().at(-1) ?? "").trimEnd(), "←→/space fold · [ ] agent · d details · tab focus · ctrl+shift+f search · s sidebar · ctrl+o tools · esc back", "no a menu without providers");
  await leave(plain);

  const pending = await open([], { columns: 200, nodes: tree(specs), actions, setup: (source) => { source.polls.push(polled([entry(0), large(10)])); } });
  assert.equal((pending.screen().at(-1) ?? "").trimEnd(), "←→/space fold · [ ] agent · a menu · d details · tab focus · enter load · ctrl+shift+f search · s sidebar · ctrl+o tools · esc back");
  pending.send(KEY.tab);
  assert.equal((pending.screen().at(-1) ?? "").trimEnd(), "↑↓ scroll · [ ] agent · a menu · d details · tab focus · enter load · ctrl+shift+f search · s sidebar · ctrl+o tools · esc back");
  await leave(pending);
});

type Needs = NonNullable<SessionTreeNode["needsPerson"]>;
function needing(nodes: SessionTreeNode[], needs: Readonly<Record<string, Needs>>): SessionTreeNode[] {
  return nodes.map((node) => { const needsPerson = needs[node.key]; return needsPerson === undefined ? node : { ...node, needsPerson }; });
}
const NEEDY = (): Listed[] => [agent("a", { tokens: 1_000_000, cost: 3 }), agent("b", { depth: 1, running: false, state: "failed", tokens: 200_000, cost: 0.41 }), agent("c", { running: false, state: "completed" }), agent("d", { group: "Subagents" })];

void test("n and N visit the nodes that need a person, wrap, expand hidden ancestors and do nothing without any", async (t) => {
  timers(t);
  const nodes = needing(nodesOf(NEEDY()), { "run:build a1b2": "awaiting_input", b: "failed", d: "stalled" });
  const harness = await open([], { nodes, initialKey: "a" });
  harness.send("n");
  await settle();
  assert.match(title(harness), /^#2\/4 b/, "n goes to the next node that needs a person");
  harness.send("n");
  await settle();
  assert.match(title(harness), /^#4\/4 d/);
  harness.send("n");
  await settle();
  assert.match(title(harness), /^build a1b2 running/, "n wraps round to the first");
  harness.send("N");
  await settle();
  assert.match(title(harness), /^#4\/4 d/, "N wraps back");
  harness.send("N");
  await settle();
  assert.match(title(harness), /^#2\/4 b/, "N goes to the previous one");
  harness.send(KEY.tab, "n");
  await settle();
  assert.match(title(harness), /^#4\/4 d/, "works with the transcript focused");
  await leave(harness);

  const hidden = await open([], { nodes: needing(nodesOf(NEEDY()), { b: "failed" }), initialKey: "c", state: { selectedKey: "c", row: 0, expansion: [["a", false]], focus: "sidebar", sidebarVisible: true, toolsExpanded: false, detailsShown: false } });
  assert.equal(sidebarRows(hidden).some((row) => /\bb\b/.test(row)), false, "b is hidden under the collapsed a");
  hidden.send("n");
  await settle();
  assert.match(title(hidden), /^#2\/4 b/);
  assert.ok(sidebarRows(hidden).some((row) => /\bb\b/.test(row)), "its ancestors were expanded");
  await leave(hidden);

  const none = await open(NEEDY(), { initialKey: "a" });
  none.send("n", "N");
  await settle();
  assert.match(title(none), /^#1\/4 a/, "no node needs a person: n and N do nothing");
  assert.doesNotMatch((none.screen().at(-1) ?? ""), /n next/);
  await leave(none);
});

void test("the hint shows n next only while some node needs a person", async (t) => {
  timers(t);
  const harness = await open([], { nodes: needing(nodesOf(NEEDY()), { b: "failed" }) });
  assert.match(harness.screen().at(-1) ?? "", /\[ \] agent · n next · /);
  harness.nodes = nodesOf(NEEDY());
  await advance(t);
  await settle();
  assert.doesNotMatch(harness.screen().at(-1) ?? "", /n next/);
  await leave(harness);
});

void test("the title ends with the session totals and drops them first when narrow", async (t) => {
  timers(t);
  const listed = (): Listed[] => [agent("a", { tokens: 1000, cost: 3, summary: "s".repeat(40) }), agent("b", { depth: 1, running: false, state: "failed", tokens: 200, cost: 0.41 }), agent("c", { running: false, state: "completed" })];
  const totals = "1/3 running · 1.2kt · $3.41";
  for (const columns of [120, 70, 40]) {
    const harness = await open(listed(), { initialKey: "a", columns });
    const line = titleRow(harness);
    assert.ok(visibleWidth(line) <= columns, `fits ${String(columns)} columns`);
    assert.match(line, /^#1\/3 a /);
    if (columns === 120) assert.ok(line.trimEnd().endsWith(totals), "the totals end the row");
    else assert.ok(!line.includes("running ·") && !line.includes("$3.41"), `no totals at ${String(columns)} columns`);
    await leave(harness);
  }
  const bare = await open([agent("a")], { initialKey: "a" });
  assert.ok(titleRow(bare).trimEnd().endsWith("1/1 running"), "parts without data are left out");
  await leave(bare);
});

const ACTIVE = (a: number, b: number, c: number): Listed[] => [agent("a", { lastActivityAt: a }), agent("b", { lastActivityAt: b }), agent("c", { lastActivityAt: c, running: false, state: "completed" })];

void test("f follows the running agent with the newest activity and stops on navigation", async (t) => {
  timers(t);
  const harness = await open(ACTIVE(10, 20, 99), { initialKey: "a" });
  assert.doesNotMatch(title(harness), /following/);
  harness.send("f");
  assert.match(title(harness), /^#2\/3 b .*following/);
  assert.match(harness.screen().at(-1) ?? "", /f stop following/);
  harness.agents = ACTIVE(30, 20, 99);
  await advance(t);
  assert.match(title(harness), /^#1\/3 a .*following/, "moves with activity");
  harness.agents = ACTIVE(30, 30, 99);
  await advance(t);
  assert.match(title(harness), /^#1\/3 a /, "a tie keeps the selection");
  harness.send(KEY.down);
  assert.doesNotMatch(title(harness), /following/, "an arrow stops it");
  for (const key of ["j", "[", "n", "]"]) {
    harness.send("f");
    assert.match(title(harness), /following/);
    harness.send(key);
    assert.doesNotMatch(title(harness), /following/, `${key} stops it`);
  }
  await leave(harness);
});

void test("f with no running agent keeps the selection, and a click stops it", async (t) => {
  timers(t);
  const harness = await open([agent("a", { running: false, state: "completed", lastActivityAt: 5 }), agent("b", { running: false, state: "completed" })], { initialKey: "b" });
  harness.send("f");
  assert.match(title(harness), /^#2\/2 b .*following/);
  await leave(harness);
  const two = await open(ACTIVE(10, 20, 1), { initialKey: "a" });
  two.send("f");
  click(two, 4, 2);
  assert.doesNotMatch(title(two), /following/);
  await leave(two);
});

void test("opening a menu stops follow mode; a state with following opens following", async (t) => {
  timers(t);
  const provider = new FakeProvider({ "workflow-agent": steps("Stop") });
  const specs = TARGETED().map((spec) => spec.agent ? { ...spec, agent: agent(spec.key, { lastActivityAt: spec.key === "c" ? 9 : 1 }) } : spec);
  const harness = await open([], { nodes: tree(specs), actions: [provider], initialKey: "a" });
  harness.send("f");
  assert.match(title(harness), /^#3\/4 c .*following/);
  harness.send("a");
  await settle();
  assert.doesNotMatch(title(harness), /following/);
  await leave(harness);
  const again = await open([], { nodes: tree(specs), actions: [provider], initialKey: "a", state: { selectedKey: "a", row: 0, expansion: [], focus: "sidebar", sidebarVisible: true, toolsExpanded: false, detailsShown: false, following: true } });
  assert.match(title(again), /^#3\/4 c .*following/);
  await leave(again);

  const aside = await open([], { nodes: tree(specs), actions: [provider], initialKey: "a" });
  aside.send("f");
  aside.send("a");
  await settle();
  assert.doesNotMatch(title(aside), /following/, "the open menu stops it");
  aside.send(KEY.enter);
  await aside.done;
  assert.equal(aside.exit?.state.following, true, "a step-aside hands follow mode back");
  const resumed = await open([], { nodes: tree(specs), actions: [provider], initialKey: "a", state: aside.exit.state });
  assert.match(title(resumed), /^#3\/4 c .*following/);
  await leave(resumed);

  const closed = await open([], { nodes: tree(specs), actions: [provider], initialKey: "a" });
  closed.send("f", "a");
  await settle();
  closed.send(KEY.escape);
  assert.doesNotMatch(title(closed), /following/, "closing the menu leaves it off");
  await leave(closed);
});

const FILTERED = (): Listed[] => [agent("alpha"), agent("beta", { depth: 1, state: "failed", running: false }), agent("gamma", { depth: 1 }), agent("scout", { group: "Subagents", state: "failed", running: false })];

void test("/ filters the sidebar by text with ancestors, shows the count and keeps or moves the selection", async (t) => {
  timers(t);
  const harness = await open(FILTERED(), { initialKey: "gamma" });
  harness.send("/");
  assert.equal(rowOf(harness, "/ ▏"), 1, "the input row opens under the title");
  harness.send("B", "E", "T");
  assert.deepEqual(sidebarRows(harness).map((line) => line.replace(/^[^\w]*/, "").split(" ")[0]), ["build", "alpha", "beta"], "ancestors kept, case-insensitive");
  assert.match(title(harness), /^build a1b2 .* 1 match$/, "the selection stays on the run, shown as an ancestor; the count has no ancestors");
  harness.send("\x7f", "\x7f", "\x7f");
  harness.send("g", "a", "m");
  assert.match(title(harness), /^build a1b2 .* 1 match$/, "the selection stays on the run: it still shows as an ancestor");
  harness.send(KEY.enter);
  assert.equal(rowOf(harness, "/ ▏"), -1, "the input row closes");
  assert.match(harness.screen().at(-1) ?? "", /^\/ filter: gam · esc clear/);
  harness.send(KEY.escape);
  assert.equal(sidebarRows(harness).length, 6, "esc cleared it");
  assert.doesNotMatch(harness.screen().at(-1) ?? "", /filter:/);
  await leave(harness);
});

void test("the filter takes a state: prefix, escapes with esc while open, and keeps the selection that still shows", async (t) => {
  timers(t);
  const harness = await open(FILTERED(), { initialKey: "scout" });
  harness.send("/");
  for (const char of "state:failed") harness.send(char);
  assert.equal(sidebarRows(harness).filter((line) => /alpha|beta|scout/.test(line)).length, 3, "failed agents and the ancestor of beta");
  assert.doesNotMatch(sidebarRows(harness).join("\n"), /gamma/);
  assert.match(title(harness), /^#4\/4 scout .*2 matches/, "the selection stays");
  harness.send(KEY.escape);
  assert.equal(sidebarRows(harness).filter((line) => /gamma/.test(line)).length, 1);
  assert.equal(harness.left, false, "esc closed the filter, not the workspace");
  await leave(harness);
});

/** A theme that wraps text in visible markers: <dim:...>, <accent:...> and <bold:...>. */
const markedRows = (harness: FakePi): string[] => harness.screen().filter((line) => /build|alpha|beta|gam|Gam|scout|delta|Subagents/.test(line) && !line.startsWith("/")).map((line) => line.replace(/\s+<di\S*\s*$/, "").trimEnd());
const MARKED = { fg: (color: string, text: string) => `<${color}:${text}>`, bold: (text: string) => `<bold:${text}>` } as unknown as Theme;

void test("a filter dims the ancestors, emphasizes the matched text once and leaves other matches alone", async (t) => {
  timers(t);
  const harness = await open(FILTERED(), { initialKey: "scout", theme: MARKED });
  const plain = markedRows(harness).join("\n");
  assert.doesNotMatch(plain, /<dim:(?!─)/, "no filter: nothing is dimmed");
  harness.send("/", "G", "a", "m");
  const rows = markedRows(harness);
  assert.match(rows.find((line) => line.includes("build")) ?? "", /^<dim:.*build.*>/, "the run is shown as an ancestor");
  assert.match(rows.find((line) => line.includes("alpha")) ?? "", /^<dim:.*alpha/, "so is alpha");
  const gamma = rows.find((line) => line.includes("gam") && !line.startsWith("#")) ?? "";
  assert.doesNotMatch(gamma, /<dim:/);

  assert.equal((gamma.match(/<accent:gam>/g) ?? []).length, 1);
  assert.match(gamma, /<accent:gam>ma/);
  harness.send(KEY.escape);
  await leave(harness);
});

void test("a filter matching a bold header label accents the match and keeps the label bold around it", async (t) => {
  timers(t);
  const harness = await open(FILTERED(), { theme: MARKED });
  harness.send("/", "b", "u", "i");
  const header = markedRows(harness).find((line) => line.includes("<accent:bui>")) ?? "";
  assert.ok(header, "the run header shows its match accented");
  assert.doesNotMatch(header, /<dim:/, "a direct match is not dimmed");
  assert.match(header, /<accent:bui>ld/, "the text after the match stays in the label");
  assert.equal((header.match(/<accent:bui>/g) ?? []).length, 1);
  harness.send(KEY.escape);
  await leave(harness);
  const group = await open(FILTERED(), { theme: MARKED });
  group.send("/", "a", "g", "e", "n");
  assert.ok(markedRows(group).some((line) => line.includes("Sub<accent:agen>ts")), "the Subagents group label is accented");
  group.send(KEY.escape);
  await leave(group);
});

void test("a filter emphasizes the matched text in the case of the label", async (t) => {
  timers(t);
  const harness = await open([agent("Gamma")], { theme: MARKED });
  harness.send("/", "g", "A", "m");
  const row = markedRows(harness).find((line) => line.includes("Gam") && !line.startsWith("#")) ?? "";
  assert.match(row, /<accent:Gam>ma/);
  assert.equal((row.match(/<accent:Gam>/g) ?? []).length, 1);
  await leave(harness);
});

/** The sidebar row that holds the text, not the title or the filter row. */
const sideRow = (harness: FakePi, text: string): string => harness.screen().find((line) => line.includes(text) && !/^[#/]/.test(line))?.replace(/\s+<di\S*\s*$/, "").trimEnd() ?? "";

void test("a filter maps the match back to the original label where lowercasing changes a letter's length", async (t) => {
  timers(t);
  const first = await open([agent("İnspect")], { theme: MARKED });
  first.send("/", "n", "s", "p");
  const inspect = sideRow(first, "nsp");
  assert.match(inspect, /İ<accent:nsp>ect/);
  await leave(first);
  const second = await open([agent("xİy")], { theme: MARKED });
  second.send("/", "y");
  const row = sideRow(second, "xİ");
  assert.match(row, /xİ<accent:y>/, "a match after the expanding letter keeps its range");
  await leave(second);
});

void test("a filter finds a label whose whitespace was collapsed", async (t) => {
  timers(t);
  const harness = await open([agent("ws01", { name: "Gam\t\tma" })], { theme: MARKED });
  harness.send("/", "m", " ", "m");
  const row = sideRow(harness, "Ga");
  assert.match(row, /Ga<accent:m\s+m>a/);
  await leave(harness);
});

void test("the selected row keeps its marking when dimmed or emphasized", async (t) => {
  timers(t);
  const dimmed = await open(FILTERED(), { initialKey: "alpha", theme: MARKED });
  dimmed.send("/", "g", "a", "m");
  const alpha = markedRows(dimmed).find((line) => line.includes("alpha") && !line.startsWith("#")) ?? "";
  assert.match(alpha, /^<dim:→/, "the dimmed ancestor keeps →");
  await leave(dimmed);
  const emphasized = await open(FILTERED(), { initialKey: "gamma", theme: MARKED });
  emphasized.send("/", "g", "a", "m");
  const gamma = markedRows(emphasized).find((line) => line.includes("<accent:gam>")) ?? "";
  assert.match(gamma, /^→/, "the emphasized match keeps →");
  await leave(emphasized);
});

// eslint-disable-next-line no-control-regex
const ESCAPES = /\x1b\[[0-9;]*m/g;
// eslint-disable-next-line no-control-regex
const UNDIMMED_AFTER_RESET = /\x1b\[(?:22;)?39m(?!\x1b\[38;2;9;9;9m)[^\s\x1b]/;
const DIM_OPEN = "\x1b[38;2;9;9;9m";
const ANSI = {
  fg: (color: string, text: string) => `${color === "dim" ? DIM_OPEN : "\x1b[38;2;1;2;3m"}${text}\x1b[39m`,
  bold: (text: string) => `\x1b[1m${text}\x1b[22m`,
} as unknown as Theme;

void test("a dimmed ancestor stays dim after the coloured parts of its line", async (t) => {
  timers(t);
  const harness = await open(FILTERED(), { initialKey: "scout", theme: ANSI });
  harness.send("/", "g", "a", "m");
  const index = harness.screen().findIndex((line) => line.includes("build"));
  assert.ok(index >= 0, "the run header shows");
  const header = harness.alt().getScreenLines()[index] ?? "";
  assert.ok(header.includes(`${DIM_OPEN}  ▾ build`), "the run header opens dim before its text");
  assert.ok(header.includes(`\x1b[39m${DIM_OPEN}`), "the dim colour is back after the coloured state glyph");
  assert.ok((header.match(ESCAPES) ?? []).length > 4, "the header holds coloured parts of its own");
  assert.doesNotMatch(header, UNDIMMED_AFTER_RESET, "no text follows a reset without the dim colour");
  await leave(harness);
});

void test("a state: match keeps its line", async (t) => {
  timers(t);
  const harness = await open(FILTERED(), { theme: MARKED });
  harness.send("/");
  for (const char of "state:failed") harness.send(char);
  const scout = markedRows(harness).find((line) => line.includes("scout")) ?? "";
  assert.doesNotMatch(scout, /<dim:/);
  assert.doesNotMatch(scout, /<bold:(?:state|failed|scout)>/);
  assert.doesNotMatch(scout, /<accent:/, "no accent emphasis");
  await leave(harness);
  const byId = await open([agent("id77", { name: "delta" })], { theme: MARKED });
  byId.send("/", "i", "d", "7", "7");
  const delta = markedRows(byId).find((line) => line.includes("delta") && !line.startsWith("#")) ?? "";
  assert.ok(delta, "the row matched by its short id shows");
  assert.doesNotMatch(delta, /<bold:|<dim:|<accent:delta/, "a short id match keeps its line");
  await leave(byId);
});

void test("filtered rows fit the sidebar at 120, 70 and 40 columns", async (t) => {
  timers(t);
  for (const columns of [120, 70, 40]) {
    const harness = await open(FILTERED(), { columns, theme: MARKED });
    harness.send("/", "a", "l");
    assert.ok(harness.screen().every((line) => visibleWidth(line) <= columns), `fits ${String(columns)}`);
    await leave(harness);
  }
});

void test("the filter survives a step-aside and fits narrow screens", async (t) => {
  timers(t);
  const provider = new FakeProvider({ "workflow-agent": steps("Stop") });
  const specs = TARGETED();
  const harness = await open([], { nodes: tree(specs), actions: [provider], initialKey: "c" });
  harness.send("/", "c", KEY.enter);
  harness.send("a");
  await settle();
  harness.send(KEY.enter);
  await harness.done;
  const state = harness.exit?.state;
  assert.equal(state?.filter, "c");
  for (const columns of [120, 70, 40]) {
    const again = await open([], { nodes: tree(specs), actions: [provider], state: state, columns });
    assert.match(again.screen().at(-1) ?? "", /filter: c/);
    assert.match(titleRow(again), /\d+ match/, "the count shows");
    assert.ok(sidebarRows(again).length < TARGETED().length, "the restored sidebar is filtered");
    assert.ok(again.screen().every((line) => visibleWidth(line) <= columns), `fits ${String(columns)}`);
    await leave(again);
  }
});

void test("a tie keeps a selection that is not the first of the tied nodes", async (t) => {
  timers(t);
  const harness = await open(ACTIVE(30, 30, 1), { initialKey: "b" });
  harness.send("f");
  assert.match(title(harness), /^#2\/3 b .*following/);
  harness.agents = ACTIVE(40, 40, 1);
  await advance(t);
  assert.match(title(harness), /^#2\/3 b /, "still b");
  await leave(harness);
});

void test("scrolling the transcript away from the tail stops following and the view stays put", async (t) => {
  timers(t);
  const harness = await open(ACTIVE(10, 20, 1), { initialKey: "a", setup: (source) => { source.polls.push(polled(entries(0, 100))); } });
  harness.send("f");
  await settle();
  harness.screen();
  const end = harness.alt().viewportTop;
  assert.ok(end > 0, "a transcript to scroll");
  harness.send(KEY.pageUp);
  harness.screen();
  const top = harness.alt().viewportTop;
  assert.ok(top < end);
  await advance(t);
  harness.screen();
  assert.doesNotMatch(title(harness), /following/);
  assert.equal(harness.alt().viewportTop, top, "the tick does not jump back");
  harness.send("f", KEY.ctrlHome);
  await advance(t);
  assert.doesNotMatch(title(harness), /following/, "ctrl+home stops it");
  await leave(harness);
});

void test("a state word without the state: prefix does not match, and pasted whitespace is normalized", async (t) => {
  timers(t);
  const harness = await open(FILTERED(), { initialKey: "gamma" });
  harness.send("/");
  for (const char of "fail") harness.send(char);
  assert.doesNotMatch(sidebarRows(harness).join("\n"), /alpha|beta|scout/, "fail names no node");
  harness.send(KEY.escape);
  harness.send("/", paste("build \t\n  a1b2"));
  assert.match(sidebarRows(harness).join("\n"), /build a1b2/, "tabs, newlines and repeated spaces match single spaces");
  assert.doesNotMatch(sidebarRows(harness).join("\n"), /gamma/);
  await leave(harness);
});

void test("under a filter left and right move to the parent and the first shown child and space leaves the expansion alone", async (t) => {
  timers(t);
  const harness = await open(FILTERED(), { initialKey: "gamma" });
  harness.send("/", "g", "a", "m", KEY.enter);
  harness.send(KEY.left);
  assert.match(title(harness), /^#1\/4 alpha/, "left goes to the parent");
  harness.send("l");
  assert.match(title(harness), /^#3\/4 gamma/, "l goes to the first shown child, skipping the hidden beta");
  harness.send("h", "h");
  assert.match(title(harness), /^build /, "h again reaches the run");
  harness.send("l", " ");
  assert.match(title(harness), /^#1\/4 alpha/);
  harness.send(KEY.escape);
  assert.equal(sidebarRows(harness).length, 6, "space changed nothing once the filter is cleared");
  await leave(harness);
});

void test("under a filter ] stays on the shown nodes", async (t) => {
  timers(t);
  const harness = await open(FILTERED(), { initialKey: "alpha" });
  harness.send("/", paste("state:failed"), KEY.enter);
  harness.send("]");
  assert.match(title(harness), /^#2\/4 beta/);
  harness.send("]");
  assert.match(title(harness), /^#4\/4 scout/, "gamma is skipped");
  await leave(harness);
});

void test("a refresh that takes the selected node out of the filter moves the selection to the first match", async (t) => {
  timers(t);
  const specs = (second: string): Spec[] => [{ key: "k1", agent: agent("one") }, { key: "k2", agent: agent(second) }, { key: "k3", agent: agent("other") }, { key: "k4", agent: agent("gamut") }];
  const harness = await open([], { nodes: tree(specs("gamma")), initialKey: "k2" });
  harness.send("/", paste("gam"), KEY.enter);
  assert.match(title(harness), /^#2\/4 gamma .*2 matches/);
  harness.nodes = tree(specs("delta"));
  await advance(t);
  assert.match(title(harness), /^#4\/4 gamut .*1 match$/, "the selected node stays listed but no longer matches: the first match is selected");
  assert.doesNotMatch(sidebarRows(harness).join("\n"), /other|delta/, "the sidebar stays filtered");
  await leave(harness);
});

void test("a filter of only spaces filters nothing and esc leaves the workspace", async (t) => {
  timers(t);
  const harness = await open(FILTERED(), { initialKey: "alpha" });
  const rows = sidebarRows(harness);
  harness.send("/", " ", KEY.enter);
  assert.deepEqual(sidebarRows(harness), rows, "every row stays");
  assert.doesNotMatch(titleRow(harness), /match/, "no match count");
  harness.send(KEY.escape);
  await harness.done;
  assert.equal(harness.left, true);
});

void test("n and N under a filter visit only the shown nodes", async (t) => {
  timers(t);
  const nodes = needing(nodesOf(FILTERED()), { alpha: "failed", beta: "failed", gamma: "failed", scout: "failed" });
  const harness = await open([], { nodes, initialKey: "alpha" });
  harness.send("/", paste("state:failed"), KEY.enter);
  harness.send("n");
  assert.match(title(harness), /^#2\/4 beta/);
  harness.send("n");
  assert.match(title(harness), /^#4\/4 scout/, "gamma is skipped");
  harness.send("N");
  assert.match(title(harness), /^#2\/4 beta/);
  await leave(harness);
});

void test("state: does not match the Subagents group, whose state summarizes its children", async (t) => {
  timers(t);
  const nodes = tree([{ key: "subagents", kind: "group", label: "Subagents", state: "failed" }, { key: "scout", parent: "subagents", agent: agent("scout", { state: "failed", running: false }) }]);
  const harness = await open([], { nodes, initialKey: "scout" });
  harness.send("/", paste("state:failed"), KEY.enter);
  assert.match(titleRow(harness), / 1 match\b/);
  await leave(harness);
});

void test("a live event replayed while an agent opens fails on that agent, not on the workspace", async (t) => {
  timers(t);
  const live = new FakeLive();
  live.replay.push({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "x" } });
  const harness = await open([agent("alpha"), agent("beta", { live })], { failLive: "beta" });
  harness.send(KEY.down);
  const screen = harness.screen();
  assert.doesNotMatch(titleRow(harness), /agents workspace failed/);
  assert.ok(screen.some((line) => line.includes("transcript failed: live failed")), "the opened transcript's status line holds the failure");
  await leave(harness);
});

void test("follow only picks among the shown nodes of a filter", async (t) => {
  timers(t);
  const harness = await open(ACTIVE(10, 20, 1), { initialKey: "a" });
  harness.send("/", "a", KEY.enter);
  harness.send("f");
  assert.match(title(harness), /^#1\/3 a .*following/, "b is filtered out");
  await leave(harness);
});


void test("the hint names the keys the user's bindings resolve to", async (t) => {
  timers(t);
  const custom = new KeybindingsManager({ ...TUI_KEYBINDINGS, "app.tools.expand": { defaultKeys: "ctrl+o", description: "Toggle tool output" } }, { "tui.select.up": "u", "tui.select.down": "d", "tui.select.cancel": "ctrl+q", "tui.select.confirm": "ctrl+e", "tui.editor.cursorLeft": "h", "tui.editor.cursorRight": "l" }) as unknown as typeof KEYBINDINGS;
  const harness = await open([agent("alpha")], { keybindings: custom });
  const hint = (): string => (harness.screen().at(-1) ?? "").trimEnd();
  assert.match(hint(), /h\/l\/space fold/, "the sidebar's fold pair follows the bindings");
  harness.send(KEY.tab);
  assert.equal(hint(), "u/d scroll · [ ] agent · tab focus · ctrl+shift+f search · s sidebar · ctrl+o tools · ctrl+q back");
  harness.send(KEY.tab, "/");
  assert.equal(hint(), "ctrl+e keep filter · ctrl+q clear");
  await leave(harness);
});

void test("the sidebar and transcript split at 80, 120 and 200 columns is the navigator's", async (t) => {
  timers(t);
  for (const [columns, sidebar] of [[80, 29], [120, 42], [200, 42]] as const) {
    assert.equal(navigatorSidebarWidth(columns), sidebar, "the shared helper");
    const harness = await open([agent("alpha")], { columns, setup: (source) => { source.polls.push(polled(entries(1, 3))); } });
    const line = harness.screen().find((row) => row.includes("alpha record 1")) ?? "";
    assert.equal(line.indexOf("│ alpha record 1"), sidebar + 1, `the separator follows ${String(sidebar)} sidebar columns at ${String(columns)}`);
    assert.equal(visibleWidth(line), columns);
    await leave(harness);
  }
});

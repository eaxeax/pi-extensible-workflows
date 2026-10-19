import assert from "node:assert/strict";
import test from "node:test";
import { visibleWidth } from "@earendil-works/pi-tui";
import { formatAgentsTimeline, type AgentsTimelineEntry } from "../src/agents-timeline.js";
import { PLAIN_WORKFLOW_PROGRESS_STYLES as PLAIN } from "../src/index.js";

const entries: AgentsTimelineEntry[] = [
  { label: "alpha", group: "build", startedAt: 0, endedAt: 10_000, state: "completed" },
  { label: "beta-with-a-long-label", group: "build", startedAt: 5_000, endedAt: 20_000, state: "failed" },
  { label: "gamma", group: "ship", startedAt: 10_000, state: "running" },
  { label: "delta", group: "ship", state: "queued" },
];

const ANSI = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, "g");

void test("one scale, header, group on its first row", () => {
  const rows = formatAgentsTimeline(entries, 40_000, 100, PLAIN);
  assert.equal(rows[0], "Timeline  0s ── 40s");
  assert.match(rows[1] ?? "", /^build\s+alpha/);
  assert.doesNotMatch(rows[2] ?? "", /build/);
  assert.match(rows[3] ?? "", /^ship\s+gamma/);
  assert.doesNotMatch(rows[4] ?? "", /ship/);
  assert.match(rows[4] ?? "", /○ queued/);
  assert.doesNotMatch(rows[4] ?? "", /█/);
  assert.match(rows[1] ?? "", /10s ✓$/);
  assert.match(rows[2] ?? "", /15s ✗$/);
});

void test("partial eighths at the end edge", () => {
  const [, row] = formatAgentsTimeline([{ label: "a", startedAt: 0, endedAt: 1, state: "completed" }, { label: "b", startedAt: 0, endedAt: 80, state: "completed" }], 80, 40, PLAIN);
  assert.match(row ?? "", /[▏▎▍▌▋▊▉]/);
  const [, full] = formatAgentsTimeline([{ label: "a", startedAt: 0, endedAt: 80, state: "completed" }], 80, 40, PLAIN);
  assert.match(full ?? "", /█{10,}/);
});

void test("a start inside a cell draws a leading partial", () => {
  const [, row] = formatAgentsTimeline([{ label: "a", startedAt: 2, endedAt: 80, state: "completed" }, { label: "b", startedAt: 0, endedAt: 80, state: "completed" }], 80, 40, PLAIN);
  assert.match(row ?? "", /a +[ ▕▐]█{5,}/);
  assert.match(row ?? "", /[▕▐]█/);
});

void test("a bar inside one cell is aligned by where it sits", () => {
  // Span 1000 ms over a bar of about 34 columns: a cell is about 29 ms.
  const draw = (start: number, end: number): string => formatAgentsTimeline([{ label: "x", startedAt: start, endedAt: end, state: "completed" }, { label: "y", startedAt: 0, endedAt: 1000, state: "completed" }], 1000, 40, PLAIN)[1] ?? "";
  const early = draw(515, 518);
  const late = draw(533, 536);
  const glyphOf = (row: string): string => row.replace(/^x\s*/, "").match(/[▏▎▍▌▋▊▉▕▐█]/)?.[0] ?? "";
  assert.match(glyphOf(early), /[▏▎▍]/);
  assert.match(glyphOf(late), /[▕▐]/);
  assert.notEqual(glyphOf(early), glyphOf(late));
});

void test("running entries grow with now", () => {
  // The finished entry shrinks against a scale that follows the running one.
  const count = (now: number): number => (formatAgentsTimeline([{ label: "a", startedAt: 0, state: "running" }, { label: "b", startedAt: 0, endedAt: 100, state: "completed" }], now, 80, PLAIN)[2]?.match(/█/g) ?? []).length;
  assert.ok(count(400) < count(200));
  assert.equal(formatAgentsTimeline([{ label: "a", startedAt: 0, state: "running" }], 5000, 60, PLAIN)[0], "Timeline  0s ── 5s");
  assert.match(formatAgentsTimeline([{ label: "a", startedAt: 0, state: "running" }], 3000, 60, PLAIN)[1] ?? "", /3s ⠦$/);
});

void test("all queued has no scale and no bars", () => {
  const rows = formatAgentsTimeline([{ label: "a", state: "queued" }], 5, 60, PLAIN);
  assert.equal(rows[0], "Timeline  0s ── –");
  assert.match(rows[1] ?? "", /○ queued/);
});

void test("every row fits at 120, 70 and 40 columns", () => {
  for (const width of [120, 70, 40, 20]) {
    const rows = formatAgentsTimeline(entries, 40_000, width, PLAIN);
    for (const row of rows) assert.ok(visibleWidth(row) <= width, `${String(width)}: ${row}`);
    assert.ok(rows.slice(1, 3).every((row) => /\d+s [✓✗]$/.test(row)), `${String(width)} keeps duration and glyph`);
  }
  const beta = (width: number): string => formatAgentsTimeline(entries, 40_000, width, PLAIN)[2] ?? "";
  // The bar is what lies between the label and " <duration> <glyph>", less the two separating spaces.
  const barOf = (row: string, label: string): number => {
    const plain = row.replace(ANSI, "");
    return plain.slice(plain.indexOf(label) + label.length, plain.search(/ \d+s [✓✗]$/)).length - 1;
  };
  assert.ok(beta(40).includes("…"), "the label truncates first");
  assert.ok(barOf(beta(40), "…") >= 10, "the bar keeps ten columns");
  for (const width of [70, 120]) assert.ok(beta(width).includes("beta-with-a-long-label"), String(width));
  assert.ok(barOf(beta(70), "beta-with-a-long-label") > 10 && barOf(beta(120), "beta-with-a-long-label") > barOf(beta(70), "beta-with-a-long-label"));
});

void test("below ten bar columns the bars are dropped", () => {
  const rows = formatAgentsTimeline(entries, 40_000, 24, PLAIN);
  assert.ok(rows.slice(1).every((row) => !/[█▏▎▍▌▋▊▉]/.test(row)));
  assert.match(rows[1] ?? "", /alpha.*10s ✓$/);
});

void test("waiting and retrying entries grow with now", () => {
  for (const state of ["waiting_for_child", "retrying", "paused"]) {
    const rows = formatAgentsTimeline([{ label: "a", startedAt: 0, state }], 60_000, 60, PLAIN);
    assert.doesNotMatch(rows[0] ?? "", /── 0s$/);
    assert.match(rows[1] ?? "", /█{10,}/);
  }
});

void test("a queued row stays readable when the bars are dropped", () => {
  const rows = formatAgentsTimeline([{ label: "delta", state: "queued" }, { label: "alpha", startedAt: 0, endedAt: 10, state: "completed" }], 10, 20, PLAIN);
  assert.match((rows[1] ?? "").trimEnd(), /○ queued$/);
  assert.ok(rows.every((row) => row.length <= 20));
});

void test("an entry that never started reads as queued only when it is queued", () => {
  const never = [{ label: "never", state: "cancelled" }, { label: "lost", state: "failed" }, { label: "alpha", startedAt: 0, endedAt: 10_000, state: "completed" }];
  for (const width of [80, 20]) {
    const rows = formatAgentsTimeline(never, 10_000, width, PLAIN);
    for (const row of rows.slice(1, 3)) {
      assert.match(row, /not started/, `${String(width)}: ${row}`);
      assert.doesNotMatch(row, /queued/, `${String(width)}: ${row}`);
      assert.match(row, /✗$/, `${String(width)}: ${row}`);
      assert.ok(visibleWidth(row) <= width, `${String(width)}: ${row}`);
    }
  }
});

void test("a stopped entry is drawn in the error style of a stopped run", () => {
  const tagged = { ...PLAIN, error: (text: string) => `<error>${text}</error>`, muted: (text: string) => `<muted>${text}</muted>` };
  for (const width of [120, 70, 40]) {
    const rows = formatAgentsTimeline([{ label: "alpha", startedAt: 0, endedAt: 10_000, state: "stopped" }], 10_000, width, tagged);
    assert.match(rows[1] ?? "", /<error>✗<\/error>/, `${String(width)}: ${rows[1] ?? ""}`);
    assert.doesNotMatch(rows[1] ?? "", /<muted>/);
    assert.ok(visibleWidth(rows[1] ?? "") <= width);
  }
});

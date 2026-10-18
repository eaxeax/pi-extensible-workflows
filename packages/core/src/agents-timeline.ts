import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { formatWorkflowRuntime, progressStyleForState, runStateGlyph, type WorkflowProgressStyles } from "./host-view.js";
import { sanitizeDisplayText } from "./utils.js";

/** One row of the timeline: times in ms; an entry without a start has not begun. */
export interface AgentsTimelineEntry {
  readonly label: string;
  readonly group?: string;
  readonly startedAt?: number | undefined;
  readonly endedAt?: number | undefined;
  readonly state: string;
}

/** States that are still going: their bar grows to now. */
const ACTIVE = new Set(["running", "waiting_for_child", "retrying", "paused"]);
const SPINNER = "⠦";
const MIN_BAR = 10;
const MIN_LABEL = 6;
const MAX_GROUP = 14;
const PARTIAL = [" ", "▏", "▎", "▍", "▌", "▋", "▊", "▉"] as const;
const AGENT_GLYPH: Readonly<Record<string, string>> = { queued: "○", waiting_for_child: "…", retrying: "↻", cancelled: "✗" };

function glyph(state: string): string { return state === "running" ? SPINNER : AGENT_GLYPH[state] ?? runStateGlyph(state, SPINNER); }
function pad(text: string, width: number): string { return truncateToWidth(text, width, "…", true); }
/** Right-aligned blocks for a bar's leading edge, by covered eighths: ▕ (1) and ▐ (4); more rounds up to a full block. */
function leading(covered: number): string { return covered <= 2 ? "▕" : covered <= 5 ? "▐" : "█"; }
/** The bar of [start, end] on a scale of `span` ms over `columns` columns: full blocks and a partial eighth at each edge. */
function bar(start: number, end: number, span: number, columns: number): string {
  const first = Math.min(columns * 8 - 1, Math.round((start / span) * columns * 8));
  const last = Math.max(first + 1, Math.min(columns * 8, Math.round((end / span) * columns * 8)));
  const home = Math.floor(first / 8);
  // A bar inside one cell is aligned by where its coverage sits: right part, left edge, or nearest by midpoint.
  if (home === Math.floor((last - 1) / 8)) {
    const from = first - home * 8;
    const to = last - home * 8;
    const glyph = to === 8 || (from > 0 && from + to >= 8) ? leading(to - from) : PARTIAL[to - from] ?? " ";
    return `${" ".repeat(home)}${glyph}${" ".repeat(columns - home - 1)}`;
  }
  let cells = "";
  for (let column = 0; column < columns; column += 1) {
    const covered = Math.min(last, column * 8 + 8) - Math.max(first, column * 8);
    cells += covered <= 0 ? " " : covered >= 8 ? "█" : first > column * 8 && last >= column * 8 + 8 ? leading(covered) : PARTIAL[covered] ?? " ";
  }
  return cells;
}

/** The Gantt rows of `entries` on one scale, each at most `width` columns wide. */
export function formatAgentsTimeline(entries: readonly AgentsTimelineEntry[], now: number, width: number, styles: WorkflowProgressStyles): string[] {
  // An entry without a finite start has not begun; a missing or non-finite end falls back to now (running) or the start.
  const startOf = (entry: AgentsTimelineEntry): number | undefined => entry.startedAt !== undefined && Number.isFinite(entry.startedAt) ? entry.startedAt : undefined;
  const endOf = (entry: AgentsTimelineEntry, start: number): number => entry.endedAt !== undefined && Number.isFinite(entry.endedAt) ? Math.max(start, entry.endedAt) : ACTIVE.has(entry.state) ? Math.max(start, now) : start;
  const spans = entries.flatMap((entry) => { const start = startOf(entry); return start === undefined ? [] : [{ start, end: endOf(entry, start) }]; });
  const origin = spans.reduce((least, { start }) => Math.min(least, start), Infinity);
  const span = spans.length === 0 ? 1 : Math.max(1, spans.reduce((most, { end }) => Math.max(most, end), -Infinity) - origin);
  const header = truncateToWidth(`${styles.bold("Timeline")}  ${styles.dim(`0s ── ${spans.length ? formatWorkflowRuntime(span) : "–"}`)}`, width, "");
  const rows = entries.map((entry, index) => {
    const started = startOf(entry);
    const end = started === undefined ? undefined : endOf(entry, started);
    return {
      label: sanitizeDisplayText(entry.label),
      group: entry.group !== undefined && entry.group !== entries[index - 1]?.group ? sanitizeDisplayText(entry.group) : "",
      started, end,
      duration: started === undefined || end === undefined ? "" : formatWorkflowRuntime(end - started),
      state: entry.state,
    };
  });
  const groupWidth = Math.min(MAX_GROUP, Math.max(0, ...rows.map((row) => visibleWidth(row.group))), Math.max(0, Math.floor(width / 4)));
  const groupColumn = groupWidth ? groupWidth + 1 : 0;
  const barsTail = Math.max(0, ...rows.map((row) => visibleWidth(row.duration))) + 2;
  const labelWidth = Math.max(0, ...rows.map((row) => visibleWidth(row.label)));
  const room = width - groupColumn - barsTail - 1 - MIN_BAR - 1;
  const withBars = room >= Math.min(labelWidth, MIN_LABEL);
  // A row without a start says so: "queued" only for a queued entry, "not started" for any other state (a cancelled pending agent).
  const unstarted = (state: string): string => state === "queued" ? "queued" : "not started";
  // Without bars that word takes the duration slot.
  if (!withBars) for (const row of rows) if (row.started === undefined) row.duration = unstarted(row.state);
  const durationWidth = Math.max(0, ...rows.map((row) => visibleWidth(row.duration)));
  const tail = durationWidth + 2;
  const label = withBars ? Math.min(labelWidth, room) : Math.max(0, Math.min(labelWidth, width - groupColumn - tail - 1));
  const barWidth = width - groupColumn - label - 1 - tail - 1;
  return [header, ...rows.map((row) => {
    const paint = progressStyleForState(row.state, styles);
    const queued = row.state === "queued" && (row.started === undefined || row.end === undefined);
    const middle = withBars ? ` ${row.started === undefined || row.end === undefined ? pad(paint(queued ? "○ queued" : unstarted(row.state)), barWidth) : paint(bar(row.started - origin, row.end - origin, span, barWidth))}` : "";
    const head = `${groupColumn ? `${styles.dim(pad(row.group, groupWidth))} ` : ""}${pad(row.label, label)}${middle}`;
    const end = ` ${styles.dim(row.duration.padStart(durationWidth))} ${queued && withBars ? " " : paint(glyph(row.state))}`;
    // The label and bar give way first: the duration and glyph are cut only when they alone exceed the width.
    return truncateToWidth(`${pad(head, Math.max(0, width - visibleWidth(end)))}${end}`, width, "");
  })];
}

import { statSync } from "node:fs";
import { WORKFLOW_AGENT_STALL_THRESHOLD_MS, type AgentRecord } from "./types.js";

/** Whether a running workflow agent is still moving: the rule the background widget and the /agents sidebar share. */

/**
 * How long an agent may go without an event before the widget and the /agents sidebar say so.
 *
 * Deliberately shorter than the core's own stall threshold. That one answers
 * "is this agent dead"; this one answers "should you go and look". An agent
 * asking a question in its own pane produces exactly this signature — no tool
 * calls, no events, waiting on a person — and the core cannot see it, since the
 * pane is a separate process. Three minutes is longer than any single stretch
 * of thinking and far shorter than the ten minutes it takes to be declared
 * stalled.
 */
export const QUIET_MS = 3 * 60 * 1000;

/** The core's own threshold for calling an agent stalled outright. */
export const STALL_MS = WORKFLOW_AGENT_STALL_THRESHOLD_MS;

/**
 * When this run's agent sessions last grew, by the transcript files themselves.
 *
 * The run state's own `lastEventAt` is not a sign of life: the core keeps it in
 * memory and only writes it out when it persists, so a perfectly busy agent
 * looks silent for minutes at a time. The agent's transcript, on the other
 * hand, is appended to on every turn — if that file is growing, work is
 * happening, whatever the run state says.
 */
/**
 * When an agent's own transcript was last written.
 *
 * The agent record carries the session for each attempt, so the file belongs
 * to this agent alone. Taking the newest write across every session in the run
 * — as a whole-run reading does — lets one busy agent vouch for a silent one:
 * the pair look equally alive while only one of them is.
 *
 * Stat results are cached for the life of a frame. Without that the check is
 * one stat per agent per repaint, several times a second, for a number that
 * cannot have changed between two rows of the same frame.
 */
export function lastTranscriptWrite(agent: AgentRecord, cache: Map<string, number | undefined>): number | undefined {
  const details = agent.attemptDetails ?? [];
  let newest: number | undefined;
  // Only this agent's attempts: a retry writes a new transcript, and the
  // latest one is what says whether it is still moving.
  for (const detail of details) {
    const locator = detail.session?.locator as { sessionFile?: string } | undefined;
    const file = locator?.sessionFile;
    if (!file) continue;
    if (!cache.has(file)) {
      try {
        cache.set(file, statSync(file).mtimeMs);
      } catch {
        // The transcript moved or was cleaned up; another attempt may answer.
        cache.set(file, undefined);
      }
    }
    const mtime = cache.get(file);
    if (mtime !== undefined && (newest === undefined || mtime > newest)) newest = mtime;
  }
  return newest;
}

/**
 * How long an agent has been silent, once that crosses the quiet threshold.
 *
 * An agent thinking hard looks exactly like an agent whose transport died: both
 * are a spinner that does not stop. Silence separates them — but it has to be
 * measured against the transcript, not the run state.
 */
export function agentSilentFor(agent: AgentRecord, now: number, cache: Map<string, number | undefined>): number | undefined {
  if (agent.state !== "running") return undefined;
  const last = Math.max(agent.lastEventAt ?? 0, lastTranscriptWrite(agent, cache) ?? 0);
  if (last === 0) return undefined;
  const silent = now - last;
  return silent >= QUIET_MS ? silent : undefined;
}

/** The newest sign of life of an agent: its last event or its transcript's last write, whichever is later; undefined when neither is known. */
export function agentLastActivity(agent: AgentRecord, cache: Map<string, number | undefined>): number | undefined {
  const last = Math.max(agent.lastEventAt ?? 0, lastTranscriptWrite(agent, cache) ?? 0);
  return last === 0 ? undefined : last;
}

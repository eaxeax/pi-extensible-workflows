import type { AgentSpeed, WorkflowAgentSessionEvent } from "./types.js";

/** The shortest generation span a rate is reported over (pi-tps-status's minimum). */
export const MIN_RATE_SPAN_MS = 250;
/** The live rate looks at this much generation time. */
const LIVE_WINDOW_MS = 10_000;
/** A live rate older than this is not shown: some providers send a tool call's arguments in one burst after a long silence. */
const LIVE_STALE_MS = 2_000;
const CJK = /[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uac00-\ud7af]/g;
const DELTAS = new Set(["text_delta", "thinking_delta", "toolcall_delta"]);
const UNFINISHED = new Set(["error", "aborted", "pending", "deferred"]);

function whole(value: unknown): value is number { return typeof value === "number" && Number.isSafeInteger(value); }
function span(value: unknown): value is number { return typeof value === "number" && Number.isFinite(value) && value >= 0; }

/** The counters when they hold at least one message and are consistent; undefined otherwise. */
export function validAgentSpeed(value: unknown): AgentSpeed | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const { messages, outputTokens, generationMs, firstTokenMs } = value as Record<string, unknown>;
  if (!whole(messages) || messages < 1 || !whole(outputTokens) || outputTokens < messages || !span(generationMs) || !span(firstTokenMs)) return undefined;
  return { messages, outputTokens, generationMs, firstTokenMs };
}

export function addSpeed(left: AgentSpeed | undefined, right: AgentSpeed | undefined): AgentSpeed | undefined {
  if (left === undefined || right === undefined) return left ?? right;
  return { messages: left.messages + right.messages, outputTokens: left.outputTokens + right.outputTokens, generationMs: left.generationMs + right.generationMs, firstTokenMs: left.firstTokenMs + right.firstTokenMs };
}

/** Output tokens per second over the generation time, once that is long enough to mean something. Never use accounting.output here: it includes errored and unobserved responses. */
export function speedTps(speed: AgentSpeed): number | undefined { return speed.generationMs >= MIN_RATE_SPAN_MS ? speed.outputTokens * 1000 / speed.generationMs : undefined; }
export function speedTtftMs(speed: AgentSpeed): number { return speed.firstTokenMs / speed.messages; }
export function speedStats(speed: AgentSpeed): string { return `${String(speed.outputTokens)} tok in ${(speed.generationMs / 1000).toFixed(1)}s`; }

interface Sample { readonly at: number; readonly tokens: number; readonly estimated: boolean; readonly current: boolean }
export interface LiveSpeed { readonly tps: number; readonly estimated: boolean }

/**
 * Counts assistant messages by the contract's rule and keeps the live rate.
 * The window opens at the assistant message_start, which Pi emits when the provider stream yields `start`, and the first
 * token is the first non-empty text, thinking or tool-call delta: a provider (cliproxyapi) sends its *_start events together
 * with message_start, so they mark nothing. TTFT here is stream start to first content: it leaves out Pi's work before
 * `start` and any provider queueing before it, and differs from pi-tps-status, which measures from the user message_start.
 */
export class SpeedTracker {
  #total: AgentSpeed = { messages: 0, outputTokens: 0, generationMs: 0, firstTokenMs: 0 };
  #windowStart: number | undefined;
  #firstTokenAt: number | undefined;
  /** Generation time of the counted messages: the meter's clock, which stops outside a message. */
  #generated = 0;
  #counted = 0;
  #estimate = 0;
  #provider = 0;
  /** The provider's count before the first content: Anthropic reports 1 from message_start, which is not progress. */
  #providerBase = 0;
  /** When the last content delta arrived (the observer's time). */
  #lastContentAt: number | undefined;
  readonly #clock: () => number;
  #samples: Sample[] = [];

  constructor(clock: () => number = Date.now) { this.#clock = clock; }

  observe(event: WorkflowAgentSessionEvent, now: number): void {
    if (event.message?.role !== undefined && event.message.role !== "assistant") return;
    if (event.type === "message_start" && event.message?.role === "assistant") { this.#discard(); this.#windowStart = now; this.#providerBase = event.message.usage?.output ?? 0; }
    else if (event.type === "message_update") this.#update(event, now);
    else if (event.type === "message_end" && event.message?.role === "assistant") this.#end(event, now);
  }

  /** The counters, absent while nothing was counted. */
  speed(): AgentSpeed | undefined { return this.#total.messages > 0 ? { ...this.#total } : undefined; }

  /** The rate while a message streams content; none between messages or after LIVE_STALE_MS without a delta. */
  live(): LiveSpeed | undefined {
    if (this.#firstTokenAt === undefined || this.#lastContentAt === undefined || this.#clock() - this.#lastContentAt > LIVE_STALE_MS) return undefined;
    const first = this.#samples[0], last = this.#samples.at(-1);
    if (first === undefined || last === undefined || last.at - first.at < MIN_RATE_SPAN_MS) return undefined;
    return { tps: (last.tokens - first.tokens) * 1000 / (last.at - first.at), estimated: this.#samples.some((sample) => sample.estimated) };
  }

  #discard(): void {
    this.#samples = this.#samples.filter((sample) => !sample.current);
    this.#windowStart = undefined; this.#firstTokenAt = undefined; this.#lastContentAt = undefined; this.#estimate = 0; this.#provider = 0; this.#providerBase = 0;
  }

  /** Keeps the samples of the last LIVE_WINDOW_MS and one before them, the baseline the rate is measured from after a gap. */
  #push(sample: Sample): void {
    this.#samples.push(sample);
    while (this.#samples.length > 1 && (this.#samples[1]?.at ?? sample.at) <= sample.at - LIVE_WINDOW_MS) this.#samples.shift();
  }

  #update(event: WorkflowAgentSessionEvent, now: number): void {
    const type = event.assistantMessageEvent?.type;
    if (this.#windowStart === undefined || type === undefined) return;
    const delta = event.assistantMessageEvent?.delta;
    const content = DELTAS.has(type) && typeof delta === "string" && delta.length > 0;
    const reported = event.message?.usage?.output;
    if (this.#firstTokenAt === undefined) {
      if (!content) { if (reported !== undefined) this.#providerBase = Math.max(this.#providerBase, reported); return; }
      this.#firstTokenAt = now;
      this.#push({ at: this.#generated, tokens: this.#counted, estimated: false, current: true });
    }
    if (reported !== undefined && reported > this.#providerBase && reported > this.#provider) this.#provider = reported;
    if (!content) return;
    const cjk = delta.match(CJK)?.length ?? 0;
    this.#estimate += Math.ceil(cjk + (delta.length - cjk) / 4);
    this.#lastContentAt = now;
    const estimated = this.#provider === 0;
    this.#push({ at: this.#generated + now - this.#firstTokenAt, tokens: this.#counted + (estimated ? this.#estimate : this.#provider), estimated, current: true });
  }

  #end(event: WorkflowAgentSessionEvent, now: number): void {
    const start = this.#windowStart, firstToken = this.#firstTokenAt;
    const stopReason = event.message?.stopReason, output = event.message?.usage?.output;
    this.#discard();
    if (start === undefined || firstToken === undefined || stopReason === undefined || UNFINISHED.has(stopReason) || output === undefined || !whole(output) || output <= 0) return;
    const generationMs = Math.max(0, now - firstToken);
    // Backdated samples over the last window of the message, like pi-tps-status's recordProviderUsage but anchored at the first token.
    const covered = Math.min(generationMs, LIVE_WINDOW_MS);
    const endAt = this.#generated + generationMs;
    this.#push({ at: endAt - covered, tokens: this.#counted + (generationMs === 0 ? 0 : output * (1 - covered / generationMs)), estimated: false, current: false });
    this.#push({ at: endAt, tokens: this.#counted + output, estimated: false, current: false });
    this.#generated = endAt; this.#counted += output;
    this.#total = { messages: this.#total.messages + 1, outputTokens: this.#total.outputTokens + output, generationMs: this.#total.generationMs + generationMs, firstTokenMs: this.#total.firstTokenMs + Math.max(0, firstToken - start) };
  }
}

const meters = new WeakMap<object, SpeedTracker>();
export function registerSpeedTracker(session: object, tracker: SpeedTracker): void { meters.set(session, tracker); }
export function unregisterSpeedTracker(session: object): void { meters.delete(session); }
/** The live rate of a session running in this process, if it has one. */
export function liveSpeed(session: object | undefined): LiveSpeed | undefined { return session === undefined ? undefined : meters.get(session)?.live(); }

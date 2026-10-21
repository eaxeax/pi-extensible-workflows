import assert from "node:assert/strict";
import test from "node:test";
import { createLiveSessionHandoff } from "../src/session-handoff.js";
import { createPiRuntimeSessionAdapter, normalizePiSessionEvent } from "../src/pi-runtime-adapter.js";
import { liveSpeed } from "../src/agent-speed.js";
import type { WorkflowAgentMessage, WorkflowAgentSession, WorkflowAgentSessionEvent } from "../src/types.js";

const state = { model: { provider: "pi", model: "model" }, tools: ["read"] };
const stats = { tokens: { input: 2, output: 3, cacheRead: 5, cacheWrite: 7, total: 17 }, cost: 0.25 };
function session(): WorkflowAgentSession {
  return { reference: { transport: "local", sessionId: "s" }, getState: () => state, getSessionStats: () => stats, getLastAssistant: () => undefined, subscribe: () => () => undefined, prompt: async () => ({}), steer: async () => undefined, abort: async () => undefined, dispose: async () => undefined };
}
const usage = (output: number) => ({ input: 1, output, cacheRead: 0, cacheWrite: 0, cost: { total: 0 } });
const partial = (output: number): WorkflowAgentMessage => ({ role: "assistant", content: [], usage: usage(output) });
const end = (stopReason: string, output: number): WorkflowAgentSessionEvent => ({ type: "message_end", message: { role: "assistant", content: [], stopReason, usage: usage(output) } });
const start: WorkflowAgentSessionEvent = { type: "message_start", message: partial(0) };
const update = (type: string, delta?: string, output?: number): WorkflowAgentSessionEvent => ({ type: "message_update", message: partial(output ?? 0), assistantMessageEvent: { type, ...(delta === undefined ? {} : { delta }) } });
function harness() {
  let now = 0;
  const live = session();
  const adapter = createPiRuntimeSessionAdapter(live, createLiveSessionHandoff(), () => now);
  const at = (time: number, event: WorkflowAgentSessionEvent) => { now = time; adapter.observe(event); };
  return { adapter, live, at };
}

void test("a normal message counts from the first content to its end, and the live meter shows only while it streams", () => {
  const { adapter, live, at } = harness();
  at(0, start);
  at(800, update("text_start"));
  at(1_000, update("text_delta", "x".repeat(40)));
  at(2_000, update("text_delta", "x".repeat(40)));
  assert.deepEqual(liveSpeed(live), { tps: 20, estimated: true });
  at(3_800, end("stop", 120));
  assert.deepEqual(adapter.snapshot(true).speed, { messages: 1, outputTokens: 120, generationMs: 2_800, firstTokenMs: 1_000 });
  assert.equal(liveSpeed(live), undefined, "after the message the title shows the average");
  adapter.dispose();
  assert.equal(liveSpeed(live), undefined);
});

void test("*_start events and empty deltas do not start the first-token clock: the first non-empty delta does", () => {
  const { adapter, at } = harness();
  at(0, start);
  at(0, update("thinking_start"));
  at(0, update("toolcall_start"));
  at(10, update("toolcall_delta", ""));
  at(5_000, update("toolcall_delta", "abcd"));
  at(30_000, end("toolUse", 100));
  assert.deepEqual(adapter.snapshot(true).speed, { messages: 1, outputTokens: 100, generationMs: 25_000, firstTokenMs: 5_000 });
});

void test("a provider partial with usage.output removes the estimate tag", () => {
  const { live, at } = harness();
  at(0, start);
  at(100, update("text_start"));
  at(1_000, update("text_delta", "abcd", 50));
  at(2_000, update("text_delta", "abcd", 90));
  assert.deepEqual(liveSpeed(live), { tps: 90, estimated: false });
});

void test("a provider count that stays at its message_start value keeps the estimate", () => {
  const { adapter, live, at } = harness();
  at(0, { type: "message_start", message: partial(1) });
  at(100, update("text_start", undefined, 1));
  at(1_100, update("text_delta", "x".repeat(400), 1));
  at(2_100, update("text_delta", "x".repeat(400), 1));
  assert.deepEqual(liveSpeed(live), { tps: 200, estimated: true });
  at(3_100, end("stop", 120));
  assert.deepEqual(adapter.snapshot(true).speed, { messages: 1, outputTokens: 120, generationMs: 2_000, firstTokenMs: 1_100 });
});

void test("a stream silent for more than 2 s shows no live rate, and a burst after the silence is measured from before it", () => {
  const { live, at } = harness();
  at(0, start); at(0, update("text_start")); at(0, update("text_delta", "x".repeat(400))); at(1_000, update("text_delta", "x".repeat(400)));
  assert.deepEqual(liveSpeed(live), { tps: 200, estimated: true });
  at(2_900, { type: "turn_start" });
  assert.equal(liveSpeed(live)?.tps, 200, "within 2 s of the last delta");
  at(3_100, { type: "turn_start" });
  assert.equal(liveSpeed(live), undefined, "more than 2 s without a delta");
  // Ten deltas of a tool call's arguments in 0.4 s after 29 s: the rate covers the silence, not the burst alone.
  for (let index = 0; index < 10; index += 1) at(30_000 + index * 40, update("toolcall_delta", "x".repeat(400)));
  const rate = liveSpeed(live)?.tps ?? 0;
  assert.ok(Math.abs(rate - (1_200 - 200) * 1_000 / (30_360 - 1_000)) < 0.01, String(rate));
});

void test("tool time between messages changes neither the counters nor the rate", () => {
  const { adapter, live, at } = harness();
  at(0, start); at(800, update("text_start")); at(1_000, update("text_delta", "x".repeat(40))); at(3_800, end("toolUse", 120));
  assert.equal(liveSpeed(live), undefined, "no live rate while the tool runs");
  at(13_800, start); at(14_000, update("text_start")); at(14_200, update("text_delta", "x".repeat(40))); at(15_200, update("text_delta", "x".repeat(400)));
  // The first message's 2.8 s and this one's 1 s of generation, not the 15 s of wall time.
  assert.deepEqual(liveSpeed(live), { tps: 230 * 1_000 / 3_800, estimated: true });
  at(17_000, end("stop", 120));
  assert.deepEqual(adapter.snapshot(true).speed, { messages: 2, outputTokens: 240, generationMs: 5_600, firstTokenMs: 1_400 });
});

void test("an errored Pi in-session retry counts only the retried message", () => {
  const { adapter, live, at } = harness();
  at(0, start); at(500, update("text_start")); at(1_000, update("text_delta", "abcdefgh")); at(2_000, end("error", 30));
  assert.equal(adapter.snapshot(true).speed, undefined);
  assert.equal(liveSpeed(live), undefined);
  at(2_100, { type: "agent_start" }); at(2_100, { type: "turn_start" });
  at(2_200, start); at(2_400, update("text_start")); at(2_600, update("text_delta", "abcdefgh")); at(4_400, end("stop", 80));
  assert.deepEqual(adapter.snapshot(true).speed, { messages: 1, outputTokens: 80, generationMs: 1_800, firstTokenMs: 400 });
});

void test("an aborted message is not counted and earlier counts stay", () => {
  const { adapter, at } = harness();
  at(0, start); at(100, update("text_start")); at(100, update("text_delta", "ab")); at(2_100, end("stop", 80));
  at(3_000, start); at(3_100, update("text_start")); at(3_500, update("text_delta", "abcdefgh")); at(5_000, end("aborted", 40));
  assert.deepEqual(adapter.snapshot(true).speed, { messages: 1, outputTokens: 80, generationMs: 2_000, firstTokenMs: 100 });
});

void test("an unfinished message does not leak into the next message", () => {
  const { adapter, at } = harness();
  at(0, start); at(100, update("text_start")); at(100, update("text_delta", "ab"));
  at(5_000, start); at(5_500, update("text_start")); at(5_500, update("text_delta", "ab")); at(6_500, end("stop", 50));
  assert.deepEqual(adapter.snapshot(true).speed, { messages: 1, outputTokens: 50, generationMs: 1_000, firstTokenMs: 500 });
});

void test("a disposed adapter drops its meter and a new session gets a fresh one", () => {
  const first = harness();
  first.at(0, start); first.at(100, update("text_start")); first.at(100, update("text_delta", "ab")); first.at(1_100, update("text_delta", "x".repeat(400)));
  assert.ok(liveSpeed(first.live));
  first.at(2_100, end("stop", 80));
  first.adapter.dispose();
  assert.equal(liveSpeed(first.live), undefined);
  const second = harness();
  assert.equal(liveSpeed(second.live), undefined);
  assert.equal(second.adapter.snapshot(true).speed, undefined);
});

void test("deferred and pending responses, empty windows and zero output are not counted", () => {
  const { adapter, at } = harness();
  at(0, start); at(100, update("text_delta", "ab")); at(900, end("deferred", 10));
  at(1_000, start); at(1_100, update("text_delta", "ab")); at(1_900, end("pending", 10));
  at(2_000, start); at(2_100, update("text_start")); at(2_500, end("stop", 10));
  at(3_000, start); at(3_100, update("text_delta", "ab")); at(4_000, end("stop", 0));
  assert.equal(adapter.snapshot(true).speed, undefined);
});

void test("a Pi-shaped partial keeps usage.output through event normalization", () => {
  let now = 0;
  const live = session();
  const tracked = createPiRuntimeSessionAdapter(live, createLiveSessionHandoff(), () => now);
  const piUsage = (output: number) => ({ input: 1, output, cacheRead: 0, cacheWrite: 0, totalTokens: 1 + output, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } });
  const feed = (time: number, raw: unknown): void => { now = time; const event = normalizePiSessionEvent(raw); assert.ok(event); tracked.observe(event); };
  feed(0, { type: "message_start", message: { role: "assistant", content: [], usage: piUsage(0) } });
  feed(100, { type: "message_update", message: { role: "assistant", content: [], usage: piUsage(0) }, assistantMessageEvent: { type: "text_start" } });
  feed(1_000, { type: "message_update", message: { role: "assistant", content: [], usage: piUsage(50) }, assistantMessageEvent: { type: "text_delta", delta: "abcd" } });
  feed(2_000, { type: "message_update", message: { role: "assistant", content: [], usage: piUsage(90) }, assistantMessageEvent: { type: "text_delta", delta: "abcd" } });
  assert.equal(liveSpeed(live)?.estimated, false);
  tracked.dispose();
});

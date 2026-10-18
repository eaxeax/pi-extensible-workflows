import { createHash, randomUUID } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { readFile, rm } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { URL } from "node:url";
import { isTrajectoryAction, isTrajectoryTarget, trajectoryActionError } from "../../src/trajectory-contracts.js";
import { atomicWriteFile } from "../../src/io.js";
import { sameFilesystemPath } from "../../src/paths.js";
import { isNodeError, object } from "../../src/utils.js";
import { processStart, readStartupHolder, releaseStartupMutex, tryAcquireStartupMutex } from "./startup-mutex.js";
import { TOOL_TIMING_ENTRY_TYPE } from "../../src/tool-timing.js";
const TRAJECTORY_IDLE_EXIT_MS = 5 * 60 * 1000;

type Socket = import("node:stream").Duplex;
type ClientKind = "publisher" | "browser";
type RunFocus = { publisherId: string; runId: string };
type Client = { socket: Socket; kind: ClientKind; publisherId?: string; buffer: Buffer; buffered: number; pendingState: State | undefined; backpressured: boolean; superseded: boolean; focusAware?: boolean; hidden?: boolean; focus?: RunFocus; sentTiming?: Map<string, number>; focusedJson?: { publisher: object; sentTiming: Map<string, number>; json: string } };
type State = { type: "state"; publishers: readonly unknown[]; updatedAt: number; initial?: boolean; truncated?: boolean };
type PendingRequest = { requestId: string; kind: "transcript" | "action"; browser: Client; publisherId: string; publisher: Client; target: { runId?: string; agentId?: string; subagentId?: string; revision?: number }; timer: ReturnType<typeof setTimeout> };
const MAX_FRAME_BYTES = 32 * 1024 * 1024;
const MAX_PENDING_REQUESTS = 128;
const TRANSCRIPT_REQUEST_TIMEOUT_MS = 10_000;
const ACTION_REQUEST_TIMEOUT_MS = 5 * 60 * 1000;
function isTimingEntry(value: unknown): boolean {
  return Boolean(value && typeof value === "object" && !Array.isArray(value) && (value as { type?: unknown }).type === "custom" && (value as { customType?: unknown }).customType === TOOL_TIMING_ENTRY_TYPE);
}
function compactTranscript(value: unknown): unknown {
  if (Array.isArray(value)) return value.filter(isTimingEntry);
  if (!value || typeof value !== "object" || Array.isArray(value)) return { revision: 0, status: "missing", timing: [] };
  const record = value as Record<string, unknown>;
  return { ...record, ...(Array.isArray(record.timing) ? { timing: record.timing.filter(isTimingEntry) } : {}) };
}
function compactRun(run: unknown): unknown {
  if (!run || typeof run !== "object" || Array.isArray(run)) return run;
  const record = run as { transcripts?: unknown };
  if (!record.transcripts || typeof record.transcripts !== "object" || Array.isArray(record.transcripts)) return { ...record, transcripts: {} };
  const transcripts: Record<string, unknown> = {};
  for (const [id, entries] of Object.entries(record.transcripts as Record<string, unknown>)) transcripts[id] = compactTranscript(entries);
  return { ...record, transcripts };
}
function compactSubagent(subagent: unknown): unknown {
  if (!subagent || typeof subagent !== "object" || Array.isArray(subagent)) return subagent;
  const record = subagent as { transcript?: unknown };
  return { ...record, transcript: compactTranscript(record.transcript) };
}
function withoutTiming(run: unknown): unknown {
  if (!run || typeof run !== "object" || Array.isArray(run)) return run;
  const record = run as { transcripts?: unknown };
  if (!record.transcripts || typeof record.transcripts !== "object" || Array.isArray(record.transcripts)) return run;
  const transcripts: Record<string, unknown> = {};
  for (const [id, entry] of Object.entries(record.transcripts as Record<string, unknown>)) transcripts[id] = entry && typeof entry === "object" && !Array.isArray(entry) ? { ...entry, timing: [] } : entry;
  return { ...record, transcripts };
}
/** Timing already delivered at this revision is omitted; the browser keeps the entries it cached. */
function knownTiming(run: unknown, prefix: string, sent: Map<string, number>, mark: (key: string, revision: number) => void): unknown {
  if (!run || typeof run !== "object" || Array.isArray(run)) return run;
  const record = run as { transcripts?: unknown };
  if (!record.transcripts || typeof record.transcripts !== "object" || Array.isArray(record.transcripts)) return run;
  const transcripts: Record<string, unknown> = {};
  for (const [id, entry] of Object.entries(record.transcripts as Record<string, unknown>)) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) { transcripts[id] = entry; continue; }
    const value = entry as { revision?: unknown; timing?: unknown };
    if (typeof value.revision !== "number" || !Array.isArray(value.timing)) { transcripts[id] = entry; continue; }
    if (sent.get(`${prefix}\t${id}`) === value.revision) { const rest = { ...value }; delete rest.timing; transcripts[id] = rest; continue; }
    mark(`${prefix}\t${id}`, value.revision);
    transcripts[id] = entry;
  }
  return { ...record, transcripts };
}
function forgetTiming(run: unknown, prefix: string, sent: Map<string, number>): void {
  if (!run || typeof run !== "object" || Array.isArray(run)) return;
  const record = run as { transcripts?: unknown };
  if (!record.transcripts || typeof record.transcripts !== "object" || Array.isArray(record.transcripts)) return;
  for (const id of Object.keys(record.transcripts)) sent.delete(`${prefix}\t${id}`);
}
function isFocusedPublisher(publisher: unknown, focus: RunFocus | undefined): boolean {
  return focus !== undefined && Boolean(publisher && typeof publisher === "object" && !Array.isArray(publisher)) && (publisher as { id?: unknown }).id === focus.publisherId;
}
/** Tool-timing only drives the focused run's gantt, so every other run ships without it. */
function focusedPublisher(publisher: unknown, focus: RunFocus | undefined, sent?: Map<string, number>, mark: (key: string, revision: number) => void = () => {}): unknown {
  if (!publisher || typeof publisher !== "object" || Array.isArray(publisher)) return publisher;
  const value = publisher as { id?: unknown; runs?: unknown };
  const runs: readonly unknown[] | undefined = Array.isArray(value.runs) ? value.runs as readonly unknown[] : undefined;
  if (!runs) return publisher;
  const focused = isFocusedPublisher(publisher, focus);
  return { ...value, runs: runs.map((run) => {
    const id = run && typeof run === "object" && !Array.isArray(run) ? (run as { run?: { id?: unknown } }).run?.id : undefined;
    const prefix = `${String(value.id)}\t${String(id)}`;
    if (!focused || id !== focus?.runId) { if (sent) forgetTiming(run, prefix, sent); return withoutTiming(run); }
    return sent ? knownTiming(run, prefix, sent, mark) : run;
  }) };
}
function compactPublisher(publisher: unknown): unknown {
  if (!publisher || typeof publisher !== "object" || Array.isArray(publisher)) return publisher;
  const value = publisher as { runs?: unknown; subagents?: unknown };
  return { ...value, ...(Array.isArray(value.runs) ? { runs: value.runs.map(compactRun) } : {}), ...(Array.isArray(value.subagents) ? { subagents: value.subagents.map(compactSubagent) } : {}) };
}
const MAX_METADATA_STRING_BYTES = 64 * 1024;
const MAX_METADATA_ARRAY_ENTRIES = 256;
const MAX_METADATA_OBJECT_KEYS = 64;
const METADATA_ARRAY_KEYS = new Set(["agents", "runs", "subagents"]);
const METADATA_OBJECT_KEYS = new Set(["transcripts"]);
function boundedMetadata(value: unknown, key = "", depth = 0): unknown {
  if (typeof value === "string") {
    const bytes = Buffer.from(value);
    return bytes.length > MAX_METADATA_STRING_BYTES ? bytes.subarray(0, MAX_METADATA_STRING_BYTES).toString("utf8") : value;
  }
  if (typeof value === "number" || typeof value === "boolean" || value === null) return value;
  if (depth >= 12) return undefined;
  if (Array.isArray(value)) {
    const array = value as readonly unknown[];
    const entries = key === "attemptDetails" ? array.slice(-8) : METADATA_ARRAY_KEYS.has(key) ? array : array.length <= MAX_METADATA_ARRAY_ENTRIES ? array : [...array.slice(0, 32), ...array.slice(-MAX_METADATA_ARRAY_ENTRIES + 32)];
    return entries.map((entry) => boundedMetadata(entry, "", depth + 1));
  }
  if (value && typeof value === "object") {
    const result: Record<string, unknown> = {};
    const properties = METADATA_OBJECT_KEYS.has(key) ? Object.keys(value).sort() : Object.keys(value).sort().slice(0, MAX_METADATA_OBJECT_KEYS);
    for (const property of properties) result[property] = boundedMetadata((value as Record<string, unknown>)[property], property, depth + 1);
    return result;
  }
  return undefined;
}
function minimalPublisher(publisher: unknown): unknown {
  return boundedMetadata(publisher);
}
function tinyPublisher(publisher: unknown): unknown {
  if (!publisher || typeof publisher !== "object" || Array.isArray(publisher)) return { id: "publisher" };
  const value = publisher as Record<string, unknown>;
  return { id: typeof value.id === "string" ? value.id.slice(0, 200) : "publisher", title: typeof value.title === "string" ? value.title.slice(0, 200) : undefined, cwd: typeof value.cwd === "string" ? value.cwd.slice(0, 1024) : undefined, sessionId: typeof value.sessionId === "string" ? value.sessionId.slice(0, 200) : undefined, connected: value.connected === true };
}
function encodePublisherList(publishers: readonly unknown[], updatedAt: number, maxBytes: number, initial: boolean, truncated: boolean, serialize: (publisher: unknown) => string, fallback?: (publisher: unknown) => string): { serialized: string; truncated: boolean } {
  const prefix = `{"type":"state","publishers":[`;
  const suffix = (isTruncated: boolean): string => `],"updatedAt":${String(updatedAt)}${initial ? ",\"initial\":true" : ""}${isTruncated ? ",\"truncated\":true" : ""}}`;
  const markerBytes = Buffer.byteLength(suffix(true)) - Buffer.byteLength(suffix(false));
  const parts: string[] = [];
  let bytes = Buffer.byteLength(prefix) + Buffer.byteLength(suffix(false));
  let wasTruncated = truncated;
  for (const publisher of publishers) {
    let serialized: string;
    try { serialized = serialize(publisher); } catch { wasTruncated = true; continue; }
    let nextBytes = bytes + Buffer.byteLength(serialized) + (parts.length ? 1 : 0);
    if (nextBytes + markerBytes >= maxBytes && fallback !== undefined) {
      try { serialized = fallback(publisher); } catch { wasTruncated = true; continue; }
      nextBytes = bytes + Buffer.byteLength(serialized) + (parts.length ? 1 : 0);
    }
    if (nextBytes + markerBytes >= maxBytes) { wasTruncated = true; continue; }
    parts.push(serialized);
    bytes = nextBytes;
  }
  const serialized = `${prefix}${parts.join(",")}${suffix(wasTruncated)}`;
  if (Buffer.byteLength(serialized) < maxBytes) return { serialized, truncated: wasTruncated };
  return { serialized: `${prefix}${suffix(true)}`, truncated: true };
}
/** `serialize` must equal `JSON.stringify(project(publisher))`; it may return a copy encoded earlier for the same publisher state. */
function encodeState(state: State, maxBytes: number, project: (publisher: unknown) => unknown = compactPublisher, serialize: (publisher: unknown) => string = (publisher) => JSON.stringify(project(publisher))): string {
  const initial = state.initial === true;
  const full = encodePublisherList(state.publishers, state.updatedAt, maxBytes, initial, state.truncated === true, serialize);
  if (!full.truncated) return full.serialized;
  return encodePublisherList(state.publishers, state.updatedAt, maxBytes, initial, true, (publisher) => JSON.stringify(minimalPublisher(project(publisher))), (publisher) => JSON.stringify(tinyPublisher(project(publisher)))).serialized;
}
function encodeApplication(value: unknown, maxBytes: number): string {
  let serialized: string;
  try { serialized = JSON.stringify(value); } catch { return "{}"; }
  if (Buffer.byteLength(serialized) < maxBytes) return serialized;
  if (value && typeof value === "object" && !Array.isArray(value)) {
    const record = value as Record<string, unknown>;
    if (record.type === "transcript") serialized = JSON.stringify({ type: "transcript", ...(typeof record.requestId === "string" ? { requestId: record.requestId } : {}), ...(typeof record.publisherId === "string" ? { publisherId: record.publisherId } : {}), ...(typeof record.runId === "string" ? { runId: record.runId } : {}), ...(typeof record.agentId === "string" ? { agentId: record.agentId } : {}), ...(typeof record.subagentId === "string" ? { subagentId: record.subagentId } : {}), ok: false, status: "oversized", revision: typeof record.revision === "number" ? record.revision : 0, error: "Transcript is too large" });
    else if (record.type === "action-result") serialized = JSON.stringify({ type: "action-result", ...(typeof record.requestId === "string" ? { requestId: record.requestId } : {}), ok: false, error: "Trajectory action result is too large" });
    else serialized = JSON.stringify({ type: "error", error: "Trajectory message is too large" });
  }
  return Buffer.byteLength(serialized) < maxBytes ? serialized : "{}";
}
function frame(payload: string, maxBytes: number): Buffer {
  const body = Buffer.from(payload);
  if (body.length >= maxBytes) throw new Error("Trajectory WebSocket frame is too large");
  if (body.length < 126) return Buffer.concat([Buffer.from([0x81, body.length]), body]);
  if (body.length <= 0xffff) { const header = Buffer.alloc(4); header[0] = 0x81; header[1] = 126; header.writeUInt16BE(body.length, 2); return Buffer.concat([header, body]); }
  const header = Buffer.alloc(10); header[0] = 0x81; header[1] = 127; header.writeBigUInt64BE(BigInt(body.length), 2); return Buffer.concat([header, body]);
}

function isState(value: unknown): value is State {
  return Boolean(value && typeof value === "object" && !Array.isArray(value) && (value as { type?: unknown }).type === "state");
}

function writeFrame(client: Client, packet: Buffer, onDelivered?: () => void): void {
  try {
    if (!client.socket.write(packet)) client.backpressured = true;
    onDelivered?.();
  } catch { client.socket.destroy(); }
}

function send(client: Client, value: unknown, maxBytes: number): void {
  try { writeFrame(client, frame(encodeApplication(value, maxBytes), maxBytes)); } catch { client.socket.destroy(); }
}

/** Grows the receive buffer geometrically, so assembling a frame from many chunks copies each byte a bounded number of times. */
function reserve(client: Client, bytes: number, maxBytes: number): void {
  if (bytes <= client.buffer.length) return;
  const grown = Buffer.allocUnsafe(Math.max(bytes, Math.min(maxBytes + 14, client.buffer.length * 2)));
  client.buffer.copy(grown, 0, 0, client.buffered);
  client.buffer = grown;
}

function parseFrames(client: Client, chunk: Buffer, maxBytes: number): readonly string[] {
  // A chunk may carry several complete frames; only the unfinished frame left after parsing is bounded.
  reserve(client, client.buffered + chunk.length, maxBytes);
  client.buffered += chunk.copy(client.buffer, client.buffered);
  const messages: string[] = [];
  let start = 0;
  let needed = 2;
  while (client.buffered - start >= 2) {
    const buffer = client.buffer.subarray(start, client.buffered);
    const first = buffer[0] ?? 0;
    const second = buffer[1] ?? 0;
    const opcode = first & 0x0f;
    const masked = (second & 0x80) !== 0;
    if ((first & 0x70) !== 0 || (first & 0x80) === 0 || !masked) throw new Error("Invalid Trajectory WebSocket frame");
    let offset = 2;
    let length = second & 0x7f;
    if (length === 126) { if (buffer.length < 4) { needed = 4; break; } length = buffer.readUInt16BE(2); offset = 4; }
    else if (length === 127) { if (buffer.length < 10) { needed = 10; break; } const longLength = buffer.readBigUInt64BE(2); if (longLength > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error("Trajectory WebSocket frame is too large"); length = Number(longLength); offset = 10; }
    if (length >= maxBytes) throw new Error("Trajectory WebSocket frame is too large");
    if (opcode >= 0x8 && (length > 125 || (first & 0x80) === 0)) throw new Error("Invalid Trajectory WebSocket control frame");
    if (buffer.length < offset + 4 + length) { needed = offset + 4 + length; break; }
    const mask = buffer.subarray(offset, offset + 4); offset += 4;
    const data = buffer.subarray(offset, offset + length);
    start += offset + length;
    if (opcode === 0x8) { client.socket.end(); break; }
    if (opcode === 0x9) { const pong = Buffer.alloc(2 + length); pong[0] = 0x8a; pong[1] = length; for (let index = 0; index < length; index += 1) pong[index + 2] = (data[index] ?? 0) ^ (mask[index % 4] ?? 0); writeFrame(client, pong); continue; }
    if (opcode === 0xA) continue;
    if (opcode !== 0x1) throw new Error("Unsupported Trajectory WebSocket frame");
    const decoded = Buffer.alloc(length);
    for (let index = 0; index < length; index += 1) decoded[index] = (data[index] ?? 0) ^ (mask[index % 4] ?? 0);
    messages.push(decoded.toString("utf8"));
  }
  // Only the unfinished frame moves to the front, and the buffer is sized for it once its header is known.
  if (start > 0) { client.buffer.copy(client.buffer, 0, start, client.buffered); client.buffered -= start; }
  if (client.buffered > maxBytes + 14) throw new Error("Trajectory WebSocket buffer is too large");
  if (client.buffer.length > maxBytes + 14) { const trimmed = Buffer.allocUnsafe(maxBytes + 14); client.buffer.copy(trimmed, 0, 0, client.buffered); client.buffer = trimmed; }
  reserve(client, needed, maxBytes);
  return messages;
}

function writeJson(response: ServerResponse, status: number, value: unknown): void {
  const body = JSON.stringify(value);
  response.writeHead(status, { "content-type": "application/json; charset=utf-8", "content-length": Buffer.byteLength(body), "cache-control": "no-store" });
  response.end(body);
}
function authorized(request: IncomingMessage, port: number): boolean {
  const origin = request.headers.origin;
  return origin === undefined || origin === `http://127.0.0.1:${String(port)}` || origin === `http://localhost:${String(port)}`;
}

type TrajectoryServerOptions = { maxFrameBytes?: number; fingerprint?: string };
export function createTrajectoryServer(port: number, lockPath: string, options: TrajectoryServerOptions = {}): Server {
  const maxFrameBytes = options.maxFrameBytes ?? MAX_FRAME_BYTES;
  const serverFingerprint = options.fingerprint ?? "";
  let startedAt = 0;
  const clients = new Set<Client>();
  const publishers = new Map<string, { client: Client; value: Record<string, unknown>; generation: number; state?: Record<string, unknown> }>();
  let latest: State = { type: "state", publishers: [], updatedAt: Date.now(), initial: true };
  const pending = new Map<Client, Map<string, PendingRequest>>();
  let idleTimer: ReturnType<typeof setTimeout> | undefined;
  let closed = false;
  const emit = (client: Client, value: unknown) => { send(client, value, maxFrameBytes); };
  const pendingFor = (browser: Client): Map<string, PendingRequest> => { let requests = pending.get(browser); if (!requests) { requests = new Map(); pending.set(browser, requests); } return requests; };
  const hasPendingRequest = (requests: ReadonlyMap<string, PendingRequest>, requestId: string): boolean => [...requests.values()].some((request) => request.requestId === requestId);
  const publisherRequestIdFor = (requestId: string): string => [...pending.values()].some((requests) => requests.has(requestId)) ? randomUUID() : requestId;
  const errorResponse = (_publisherRequestId: string, request: PendingRequest, status: string, error: string): unknown => request.kind === "action" ? { type: "action-result", requestId: request.requestId, ok: false, error } : { type: "transcript", requestId: request.requestId, publisherId: request.publisherId, ...(request.target.runId === undefined ? {} : { runId: request.target.runId }), ...(request.target.agentId === undefined ? {} : { agentId: request.target.agentId }), ...(request.target.subagentId === undefined ? {} : { subagentId: request.target.subagentId }), ok: false, status, revision: request.target.revision ?? 0, error };
  const clearPending = (client: Client, error: string): void => {
    const own = pending.get(client);
    if (own) { for (const [requestId, request] of own) { clearTimeout(request.timer); emit(client, errorResponse(requestId, request, "disconnected", error)); } own.clear(); pending.delete(client); }
    for (const [browser, requests] of pending) { for (const [requestId, request] of requests) { if (request.publisher !== client) continue; clearTimeout(request.timer); requests.delete(requestId); emit(browser, errorResponse(requestId, request, "disconnected", error)); } if (!requests.size) pending.delete(browser); }
  };
  const rejectRequest = (browser: Client, requestId: string, request: PendingRequest, error: string): void => {
    const requests = pending.get(browser);
    if (!requests || requests.get(requestId) !== request) return;
    requests.delete(requestId);
    if (!requests.size) pending.delete(browser);
    emit(browser, errorResponse(requestId, request, "failed", error));
  };
  const busy = () => closed || [...publishers.values()].some(({ value }) => value.connected === true);
  const scheduleIdleExit = () => {
    if (busy() || idleTimer !== undefined) return;
    idleTimer = setTimeout(() => {
      idleTimer = undefined;
      void tryAcquireStartupMutex(lockPath).then(async (token) => {
        // A Pi holding the startup mutex may be about to reuse this server, so the exit waits for another idle period.
        if (token === undefined) { scheduleIdleExit(); return; }
        if (busy() || idleTimer !== undefined) { await releaseStartupMutex(lockPath, token); return; }
        server.closeAllConnections();
        for (const client of clients) client.socket.destroy();
        server.close(() => {
          void removeOwnLock().then(() => releaseStartupMutex(lockPath, token)).then(() => { process.exit(0); }).catch(() => { process.exit(1); });
        });
      }).catch(() => { process.exit(1); });
    }, TRAJECTORY_IDLE_EXIT_MS);
    idleTimer.unref();
  };
  // Runs under the startup mutex; a Pi may have replaced the lock while this server was idle.
  const removeOwnLock = async (): Promise<void> => {
    let current: unknown;
    try { current = JSON.parse(await readFile(lockPath, "utf8")); }
    catch (error) { if (isNodeError(error, "ENOENT")) return; throw error; }
    if (object(current) && current.pid === process.pid && current.startedAt === startedAt) await rm(lockPath, { force: true });
  };
  const cancelIdleExit = () => {
    if (idleTimer !== undefined) { clearTimeout(idleTimer); idleTimer = undefined; }
  };
  // Each published publisher state is an immutable object, so its encodings are shared by every browser and kept only while that state is referenced.
  const encodedPublishers = new WeakMap<object, string>();
  const encodedUnfocusedPublishers = new WeakMap<object, string>();
  const reuse = (cache: WeakMap<object, string>, publisher: unknown, encode: () => string): string => {
    if (!publisher || typeof publisher !== "object") return encode();
    let json = cache.get(publisher);
    if (json === undefined) { json = encode(); cache.set(publisher, json); }
    return json;
  };
  const sharedFrame = (state: State): Buffer => frame(encodeState(state, maxFrameBytes, compactPublisher, (publisher) => reuse(encodedPublishers, publisher, () => JSON.stringify(compactPublisher(publisher)))), maxFrameBytes);
  // A backpressured browser keeps only the newest state and encodes it on drain, so replaced snapshots are never serialized.
  // Timing counts as delivered only for the state actually written, encoded with the focus current at that moment.
  // A hidden browser gets no state; showing it again sends ui:focus, which delivers the latest state.
  const deliverState = (client: Client, state: State, shared?: () => Buffer): void => {
    if (client.hidden === true) { client.pendingState = undefined; return; }
    if (client.backpressured) { client.pendingState = state; return; }
    if (client.focusAware !== true) { writeFrame(client, shared?.() ?? sharedFrame(state)); return; }
    const sent = (client.sentTiming ??= new Map<string, number>());
    const focus = client.focus;
    const marks: [string, number][] = [];
    const project = (publisher: unknown): unknown => compactPublisher(focusedPublisher(publisher, focus, sent, (key, revision) => marks.push([key, revision])));
    // ui:focus replaces sentTiming, so only the focused run ever has delivery marks and other publishers encode the same for every browser.
    // The focused publisher is reused only after an encoding that shipped no new timing, because then the same state encodes the same until focus changes.
    const serialize = (publisher: unknown): string => {
      if (!isFocusedPublisher(publisher, focus)) return reuse(encodedUnfocusedPublishers, publisher, () => JSON.stringify(compactPublisher(focusedPublisher(publisher, undefined))));
      const cached = client.focusedJson;
      if (cached !== undefined && cached.publisher === publisher && cached.sentTiming === sent) return cached.json;
      const before = marks.length;
      const json = JSON.stringify(project(publisher));
      if (marks.length === before && publisher && typeof publisher === "object") client.focusedJson = { publisher, sentTiming: sent, json };
      return json;
    };
    const stateFrame = frame(encodeState(state, maxFrameBytes, project, serialize), maxFrameBytes);
    writeFrame(client, stateFrame, () => { for (const [key, revision] of marks) sent.set(key, revision); });
  };
  const broadcast = (value: unknown) => {
    if (isState(value)) {
      try {
        let shared: Buffer | undefined;
        for (const client of clients) if (client.kind === "browser") deliverState(client, value, () => shared ??= sharedFrame(value));
      } catch {
        for (const client of clients) if (client.kind === "browser") client.socket.destroy();
      }
      return;
    }
    for (const client of clients) if (client.kind === "browser") emit(client, value);
  };
  let viewers = 0;
  // Publishers poll their run directory, so they only need a fast cadence while a visible browser is watching.
  const notifyViewers = () => {
    const count = [...clients].filter((candidate) => candidate.kind === "browser" && candidate.hidden !== true).length;
    if (count === viewers) return;
    viewers = count;
    for (const candidate of clients) if (candidate.kind === "publisher") emit(candidate, { type: "publisher:viewers", count });
  };
  const publishState = () => {
    const values = [...publishers.values()].map((entry) => entry.state ??= { ...entry.value, generation: entry.generation });
    latest = { type: "state", publishers: values, updatedAt: Date.now() };
    broadcast(latest);
  };
  const disconnect = (client: Client) => {
    clearPending(client, client.kind === "publisher" ? "Publisher is disconnected" : "Trajectory browser disconnected");
    clients.delete(client);
    if (client.kind === "browser") notifyViewers();
    if (client.kind === "publisher" && client.publisherId && publishers.get(client.publisherId)?.client === client) {
      publishers.delete(client.publisherId);
      publishState();
      scheduleIdleExit();
    }
  };
  const handleMessage = (client: Client, raw: string) => {
    let value: unknown;
    try { value = JSON.parse(raw); } catch { return; }
    if (!value || typeof value !== "object" || Array.isArray(value)) return;
    const message = value as Record<string, unknown>;
    if (client.superseded) return;
    if (message.type === "publisher:detach" && client.kind === "publisher" && client.publisherId && publishers.get(client.publisherId)?.client === client) { clearPending(client, "Publisher is disconnected"); publishers.delete(client.publisherId); publishState(); scheduleIdleExit(); return; }
    if (message.type === "ui:attach") { client.kind = "browser"; client.hidden = message.visible === false; try { deliverState(client, latest); } catch { client.socket.destroy(); } notifyViewers(); return; }
    if (message.type === "ui:focus" && client.kind === "browser") {
      const publisherId = typeof message.publisherId === "string" ? message.publisherId : undefined;
      const runId = typeof message.runId === "string" ? message.runId : undefined;
      client.focusAware = true;
      // Browsers that predate visibility omit the field and stay visible.
      client.hidden = message.visible === false;
      client.sentTiming = new Map<string, number>();
      if (publisherId !== undefined && runId !== undefined) client.focus = { publisherId, runId };
      else delete client.focus;
      try { deliverState(client, latest); } catch { client.socket.destroy(); }
      notifyViewers();
      return;
    }
    if (client.kind === "publisher" && message.type === "publisher:attach" && typeof message.publisherId === "string") {
      cancelIdleExit();
      client.publisherId = message.publisherId;
      const previous = publishers.get(message.publisherId);
      if (previous && previous.client !== client) {
        previous.client.superseded = true;
        clearPending(previous.client, "Publisher replaced");
        emit(previous.client, { type: "publisher:replaced" });
        previous.client.socket.end();
      }
      const generation = (previous?.generation ?? 0) + 1;
      publishers.set(message.publisherId, { client, value: { ...(previous?.value ?? { id: message.publisherId }), id: message.publisherId, connected: true }, generation });
      emit(client, { type: "publisher:viewers", count: viewers });
      publishState();
      return;
    }
    if (client.kind === "publisher" && message.type === "publisher:state" && typeof message.publisher === "object" && message.publisher !== null) {
      const publisher = message.publisher as Record<string, unknown>;
      const id = typeof publisher.id === "string" ? publisher.id : client.publisherId;
      if (!id || client.publisherId !== id || publishers.get(id)?.client !== client) return;
      cancelIdleExit();
      const previous = publishers.get(id);
      const generation = previous?.generation ?? 1;
      const runs = Array.isArray(message.runs) ? message.runs : [];
      const subagents = Array.isArray(message.subagents) ? message.subagents : [];
      publishers.set(id, { client, value: { ...publisher, connected: true, runs, subagents, generation, ...(message.truncated === true || publisher.truncated === true ? { truncated: true } : {}) }, generation });
      publishState();
      return;
    }
    if (client.kind === "publisher" && (message.type === "publisher:action-result" || message.type === "publisher:transcript-result") && typeof message.requestId === "string") {
      for (const [browser, requests] of pending) {
        const request = requests.get(message.requestId);
        if (!request || request.publisher !== client || request.publisherId !== message.publisherId || message.type !== (request.kind === "action" ? "publisher:action-result" : "publisher:transcript-result")) continue;
        const responseRevision = message.requestedRevision ?? message.revision;
        const targetMatches = request.kind === "action" || (request.target.runId === message.runId && request.target.agentId === message.agentId && request.target.subagentId === message.subagentId && (request.target.revision === undefined || request.target.revision === responseRevision));
        if (!targetMatches) return;
        clearTimeout(request.timer);
        requests.delete(message.requestId);
        if (!requests.size) pending.delete(browser);
        if (request.kind === "action") emit(browser, { type: "action-result", requestId: request.requestId, ...(message.ok === true ? { ok: true, ...(message.result === undefined ? {} : { result: message.result }) } : { ok: false, error: typeof message.error === "string" ? message.error : "Trajectory action failed" }) });
        else emit(browser, { type: "transcript", requestId: request.requestId, publisherId: request.publisherId, ...(request.target.runId === undefined ? {} : { runId: request.target.runId }), ...(request.target.agentId === undefined ? {} : { agentId: request.target.agentId }), ...(request.target.subagentId === undefined ? {} : { subagentId: request.target.subagentId }), ok: message.ok === true, status: typeof message.status === "string" ? message.status : message.ok === true ? "available" : "failed", revision: typeof message.revision === "number" ? message.revision : request.target.revision ?? 0, ...(message.ok === true ? { entries: Array.isArray(message.entries) ? message.entries : [] } : { error: typeof message.error === "string" ? message.error : "Transcript failed" }) });
        return;
      }
      return;
    }
    if (client.kind === "browser" && message.type === "ui:transcript") {
      const validId = (value: unknown): value is string => typeof value === "string" && value.length >= 1 && value.length <= 200;
      if (!validId(message.publisherId)) return;
      const runRequest = validId(message.runId) && validId(message.agentId) && message.subagentId === undefined;
      const subagentRequest = validId(message.subagentId) && message.runId === undefined && message.agentId === undefined;
      if (!runRequest && !subagentRequest) return;
      const requestId = validId(message.requestId) ? message.requestId : randomUUID();
      const revision = message.revision === undefined ? undefined : typeof message.revision === "number" && Number.isSafeInteger(message.revision) && message.revision >= 0 ? message.revision : undefined;
      const target = publishers.get(message.publisherId);
      if (!target || !target.value.connected) { emit(client, { type: "transcript", requestId, publisherId: message.publisherId, ...(runRequest ? { runId: message.runId, agentId: message.agentId } : { subagentId: message.subagentId }), ok: false, status: "disconnected", revision: revision ?? 0, error: "Publisher is disconnected" }); return; }
      // Legacy publishers sent transcript bodies in state. New publishers send metadata and use the RPC below.
      let legacyEntries: unknown[] | undefined;
      if (runRequest && Array.isArray(target.value.runs)) {
        for (const item of target.value.runs) {
          if (!item || typeof item !== "object" || Array.isArray(item)) continue;
          const record = item as { run?: { id?: unknown }; transcripts?: unknown };
          if (record.run?.id !== message.runId || !record.transcripts || typeof record.transcripts !== "object" || Array.isArray(record.transcripts)) continue;
          const found = (record.transcripts as Record<string, unknown>)[message.agentId as string];
          if (Array.isArray(found)) legacyEntries = found;
          break;
        }
      } else if (subagentRequest && Array.isArray(target.value.subagents)) {
        for (const item of target.value.subagents) {
          if (!item || typeof item !== "object" || Array.isArray(item)) continue;
          const record = item as { id?: unknown; transcript?: unknown };
          if (record.id === message.subagentId && Array.isArray(record.transcript)) { legacyEntries = record.transcript; break; }
        }
      }
      if (legacyEntries !== undefined) {
        const reply = { type: "transcript", requestId, publisherId: message.publisherId, ...(runRequest ? { runId: message.runId, agentId: message.agentId } : { subagentId: message.subagentId }), ok: true, status: legacyEntries.length ? "available" : "empty", revision: revision ?? 1, entries: legacyEntries };
        if (Buffer.byteLength(JSON.stringify(reply)) > maxFrameBytes) emit(client, { ...reply, ok: false, status: "oversized", entries: undefined, error: "Transcript is too large" }); else emit(client, reply);
        return;
      }
      const requests = pendingFor(client);
      const requestTarget = runRequest ? { runId: message.runId as string, agentId: message.agentId as string, ...(revision === undefined ? {} : { revision }) } : { subagentId: message.subagentId as string, ...(revision === undefined ? {} : { revision }) };
      if (requests.size >= MAX_PENDING_REQUESTS || hasPendingRequest(requests, requestId)) { emit(client, { type: "transcript", requestId, publisherId: message.publisherId, ...(runRequest ? { runId: message.runId, agentId: message.agentId } : { subagentId: message.subagentId }), ok: false, status: "failed", revision: revision ?? 0, error: "Too many pending Trajectory requests" }); return; }
      const publisherRequestId = publisherRequestIdFor(requestId);
      const request: PendingRequest = { requestId, kind: "transcript", browser: client, publisherId: message.publisherId, publisher: target.client, target: requestTarget, timer: setTimeout(() => { rejectRequest(client, publisherRequestId, request, "Trajectory request timed out"); }, TRANSCRIPT_REQUEST_TIMEOUT_MS) };
      requests.set(publisherRequestId, request);
      emit(target.client, { type: "publisher:transcript", requestId: publisherRequestId, publisherId: message.publisherId, ...(runRequest ? { runId: message.runId, agentId: message.agentId } : { subagentId: message.subagentId }), ...(revision === undefined ? {} : { revision }) });
      return;
    }
    if (client.kind !== "browser" || message.type !== "ui:action" || typeof message.publisherId !== "string") return;
    const requestId = typeof message.requestId === "string" && message.requestId.length >= 1 && message.requestId.length <= 200 ? message.requestId : randomUUID();
    if (!isTrajectoryAction(message.action)) { emit(client, { type: "action-result", requestId, ok: false, error: "Unsupported Trajectory action" }); return; }
    if (!isTrajectoryTarget(message.target)) { emit(client, { type: "action-result", requestId, ok: false, error: "Invalid Trajectory action target" }); return; }
    const actionError = trajectoryActionError(message.action, message.target);
    if (actionError !== undefined) { emit(client, { type: "action-result", requestId, ok: false, error: actionError }); return; }
    const target = publishers.get(message.publisherId);
    if (!target || !target.value.connected) { emit(client, { type: "action-result", requestId, ok: false, error: "Publisher is disconnected" }); return; }
    const publisherRequestId = publisherRequestIdFor(requestId);
    const outbound = { type: "publisher:action", requestId: publisherRequestId, action: message.action, target: message.target, ...(typeof message.name === "string" ? { name: message.name } : {}), ...(message.payload === undefined ? {} : { payload: message.payload }) };
    if (Buffer.byteLength(JSON.stringify(outbound)) >= maxFrameBytes) { emit(client, { type: "action-result", requestId, ok: false, error: "Trajectory action is too large" }); return; }
    const requests = pendingFor(client);
    if (requests.size >= MAX_PENDING_REQUESTS || hasPendingRequest(requests, requestId)) { emit(client, { type: "action-result", requestId, ok: false, error: "Too many pending Trajectory requests" }); return; }
    const request: PendingRequest = { requestId, kind: "action", browser: client, publisherId: message.publisherId, publisher: target.client, target: {}, timer: setTimeout(() => { rejectRequest(client, publisherRequestId, request, "Trajectory request timed out"); }, ACTION_REQUEST_TIMEOUT_MS) };
    requests.set(publisherRequestId, request);
    emit(target.client, outbound);
  };
  const server = createServer((request, response) => {
    let url: URL;
    try { url = new URL(request.url ?? "/", `http://127.0.0.1:${String(port)}`); }
    catch { writeJson(response, 400, { error: "Invalid request" }); return; }
    if (!authorized(request, port)) { writeJson(response, 403, { error: "Forbidden" }); return; }
    const path = url.pathname;
    // The identity lets an attaching Pi tell its own server from any other one answering on the port.
    if (request.method === "GET" && path === "/health") { writeJson(response, 200, { ok: true, pid: process.pid, fingerprint: serverFingerprint, startedAt }); return; }
    if (request.method === "GET" && (path === "/" || path === "/index.html")) {
      void readFile(new URL("./assets/index.html", import.meta.url)).then((html) => {
        response.writeHead(200, { "content-type": "text/html; charset=utf-8", "content-length": html.byteLength, "cache-control": "no-store" });
        response.end(html);
      }).catch(() => { writeJson(response, 500, { error: "Trajectory UI is unavailable" }); });
      return;
    }
    if (request.method === "GET" && path === "/marked.min.js") {
      void readFile(new URL("./assets/marked.min.js", import.meta.url)).then((script) => {
        response.writeHead(200, { "content-type": "application/javascript; charset=utf-8", "content-length": script.byteLength, "cache-control": "no-store" });
        response.end(script);
      }).catch(() => { writeJson(response, 500, { error: "Trajectory markdown renderer is unavailable" }); });
      return;
    }
    if (request.method === "GET" && path === "/morphdom.min.js") {
      void readFile(new URL("./assets/morphdom.min.js", import.meta.url)).then((script) => {
        response.writeHead(200, { "content-type": "application/javascript; charset=utf-8", "content-length": script.byteLength, "cache-control": "no-store" });
        response.end(script);
      }).catch(() => { writeJson(response, 500, { error: "Trajectory DOM diffing library is unavailable" }); });
      return;
    }
    if (request.method === "GET" && path === "/prism.min.js") {
      void readFile(new URL("./assets/prism.min.js", import.meta.url)).then((script) => {
        response.writeHead(200, { "content-type": "application/javascript; charset=utf-8", "content-length": script.byteLength, "cache-control": "no-store" });
        response.end(script);
      }).catch(() => { writeJson(response, 500, { error: "Trajectory syntax highlighting library is unavailable" }); });
      return;
    }
    if (request.method === "GET" && (path === "/favicon.png" || path === "/favicon.ico")) {
      void readFile(new URL("./assets/favicon.png", import.meta.url)).then((icon) => {
        response.writeHead(200, { "content-type": "image/png", "content-length": icon.byteLength, "cache-control": "no-store" });
        response.end(icon);
      }).catch(() => { writeJson(response, 404, { error: "Not found" }); });
      return;
    }
    writeJson(response, 404, { error: "Not found" });
  });
  server.on("upgrade", (request, socket) => {
    let url: URL;
    try { url = new URL(request.url ?? "/", `http://127.0.0.1:${String(port)}`); }
    catch { socket.destroy(); return; }
    const key = request.headers["sec-websocket-key"];
    if (!authorized(request, port) || url.pathname !== "/ws" || typeof key !== "string") { socket.destroy(); return; }
    const accept = createHash("sha1").update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`).digest("base64");
    socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
    const client: Client = { socket, kind: "publisher", buffer: Buffer.alloc(0), buffered: 0, pendingState: undefined, backpressured: false, superseded: false };
    socket.on("drain", () => {
      const pendingState = client.pendingState;
      client.pendingState = undefined;
      client.backpressured = false;
      if (pendingState !== undefined) { try { deliverState(client, pendingState); } catch { socket.destroy(); } }
    });
    clients.add(client);
    socket.on("data", (chunk: unknown) => {
      if (!Buffer.isBuffer(chunk)) return;
      try { for (const message of parseFrames(client, chunk, maxFrameBytes)) handleMessage(client, message); } catch { socket.destroy(); }
    });
    socket.on("close", () => { disconnect(client); });
    socket.on("error", () => { disconnect(client); });
    // A dropped tab only sends FIN, and an upgraded socket stays half-open until this side closes it.
    socket.on("end", () => { socket.destroy(); });
  });
  // Listening is emitted before the event loop accepts a connection, so the synchronous atomic write publishes the lock before /health can answer.
  server.once("listening", () => {
    startedAt = Date.now();
    try { atomicWriteFile(lockPath, `${JSON.stringify({ pid: process.pid, port, fingerprint: serverFingerprint, startedAt, start: processStart(process.pid) })}\n`, true); }
    catch (error) { server.close(); server.emit("error", error); return; }
    scheduleIdleExit();
  });
  server.on("close", () => { closed = true; if (idleTimer !== undefined) { clearTimeout(idleTimer); idleTimer = undefined; } });
  return server;
}

// The spawning Pi records this server in its startup holder, which then stays held until this server publishes or exits; without that record the startup was abandoned.
async function awaitStartupRecord(lockPath: string, token: string): Promise<void> {
  for (let attempt = 0; attempt < 60; attempt += 1) {
    const holder = readStartupHolder(lockPath, token);
    if (holder === undefined) break;
    if (holder.server?.pid === process.pid) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error("Trajectory startup was abandoned before the server listened");
}

async function main(): Promise<void> {
  const args = new Map<string, string>();
  for (let index = 2; index + 1 < process.argv.length; index += 2) args.set(process.argv[index] ?? "", process.argv[index + 1] ?? "");
  const port = Number(args.get("--port"));
  const lockPath = args.get("--lock");
  const fingerprint = args.get("--fingerprint");
  const startupToken = args.get("--startup");
  if (!Number.isSafeInteger(port) || port < 1 || port > 65535 || !lockPath || !fingerprint) throw new Error("Invalid Trajectory server arguments");
  if (startupToken !== undefined) await awaitStartupRecord(lockPath, startupToken);
  const server = createTrajectoryServer(port, lockPath, { fingerprint });
  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(port, "127.0.0.1", () => { resolve(); }); });
}

if (process.argv[1] && sameFilesystemPath(fileURLToPath(import.meta.url), process.argv[1])) void main().catch((error: unknown) => { console.error(error); process.exitCode = 1; });

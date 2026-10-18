import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { createConnection, createServer as createNetServer, type Socket } from "node:net";
import { watch } from "node:fs";
import { lstat, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createTrajectoryServer } from "../src/server.js";
import { identityOf, releaseStartupMutex, tryAcquireStartupMutex } from "../src/startup-mutex.js";

async function availablePort(): Promise<number> {
  const probe = createNetServer();
  await new Promise<void>((resolve, reject) => {
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", () => { resolve(); });
  });
  const address = probe.address();
  assert.ok(address && typeof address === "object");
  const port = address.port;
  await new Promise<void>((resolve, reject) => probe.close((error) => { if (error) reject(error); else resolve(); }));
  return port;
}

async function listen(server: ReturnType<typeof createTrajectoryServer>, port: number): Promise<void> {
  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(port, "127.0.0.1", resolve); });
}

function maskedFrame(value: string): Buffer {
  const data = Buffer.from(value);
  const mask = Buffer.from([1, 2, 3, 4]);
  let header: Buffer;
  if (data.length < 126) header = Buffer.from([0x81, 0x80 | data.length]);
  else if (data.length <= 0xffff) {
    header = Buffer.alloc(4);
    header[0] = 0x81;
    header[1] = 0x80 | 126;
    header.writeUInt16BE(data.length, 2);
  } else {
    header = Buffer.alloc(10);
    header[0] = 0x81;
    header[1] = 0x80 | 127;
    header.writeBigUInt64BE(BigInt(data.length), 2);
  }
  const body = Buffer.alloc(data.length);
  for (let index = 0; index < data.length; index += 1) body[index] = (data[index] ?? 0) ^ (mask[index % 4] ?? 0);
  return Buffer.concat([header, mask, body]);
}

function maskedCloseFrame(): Buffer {
  return Buffer.from([0x88, 0x80, 1, 2, 3, 4]);
}

function decodeTextFrame(buffer: Buffer): { payload: string; consumed: number } | undefined {
  if (buffer.length < 2) return undefined;
  const second = buffer[1] ?? 0;
  assert.equal(second & 0x80, 0);
  let offset = 2;
  let length = second & 0x7f;
  if (length === 126) {
    if (buffer.length < 4) return undefined;
    length = buffer.readUInt16BE(2);
    offset = 4;
  } else if (length === 127) {
    if (buffer.length < 10) return undefined;
    length = Number(buffer.readBigUInt64BE(2));
    offset = 10;
  }
  if (buffer.length < offset + length) return undefined;
  return { payload: buffer.subarray(offset, offset + length).toString("utf8"), consumed: offset + length };
}

const frameLeftovers = new WeakMap<Socket, Buffer>();
function isViewerFrame(value: unknown): boolean {
  return typeof value === "object" && value !== null && (value as { type?: unknown }).type === "publisher:viewers";
}
/** Reads one frame, keeping unread bytes so coalesced frames stay available to the next read. */
async function readJsonFrame(socket: Socket, accept: (value: unknown) => boolean = (value) => !isViewerFrame(value)): Promise<unknown> {
  return new Promise((resolve, reject) => {
    let buffer = frameLeftovers.get(socket) ?? Buffer.alloc(0);
    const timer = setTimeout(() => { reject(new Error("timed out waiting for Trajectory frame")); }, 2000);
    const drain = (): boolean => {
      for (;;) {
        const decoded = decodeTextFrame(buffer);
        if (!decoded) { frameLeftovers.set(socket, buffer); return false; }
        buffer = buffer.subarray(decoded.consumed);
        const value: unknown = JSON.parse(decoded.payload);
        if (!accept(value)) continue;
        frameLeftovers.set(socket, buffer);
        clearTimeout(timer);
        socket.off("data", onData);
        resolve(value);
        return true;
      }
    };
    const onData = (chunk: Buffer) => { buffer = Buffer.concat([buffer, chunk]); drain(); };
    if (drain()) return;
    socket.on("data", onData);
    socket.once("error", reject);
  });
}

function publisherState(id: string, blob: string, subagents: readonly unknown[] = [], title = ""): string {
  return JSON.stringify({
    type: "publisher:state",
    publisher: { id, ...(title ? { title } : {}) },
    runs: [{ run: { id, workflowName: id, agents: [], state: "completed" }, transcripts: { agent: [{ type: "message", text: blob }] }, snapshot: {}, awaiting: [] }],
    subagents,
  });
}

async function handshake(port: number, origin: string): Promise<{ socket: Socket; response: string }> {
  return new Promise((resolve, reject) => {
    const socket = createConnection(port, "127.0.0.1");
    let data = "";
    const onData = (chunk: Buffer) => {
      data += chunk.toString("latin1");
      if (!data.includes("\r\n\r\n")) return;
      socket.off("data", onData);
      resolve({ socket, response: data });
    };
    socket.on("data", onData);
    socket.once("error", reject);
    socket.write(`GET /ws HTTP/1.1\r\nHost: 127.0.0.1:${String(port)}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\nOrigin: ${origin}\r\n\r\n`);
  });
}

async function waitForHealth(port: number): Promise<void> {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    try {
      if ((await fetch(`http://127.0.0.1:${String(port)}/health`, { signal: AbortSignal.timeout(300) })).ok) return;
    } catch { /* The child is still starting. */ }
    const remaining = deadline - Date.now();
    if (remaining > 0) await new Promise((resolve) => setTimeout(resolve, Math.min(50, remaining)));
  }
  throw new Error("Trajectory server did not become healthy");
}

async function handshakeWhenReady(port: number, origin: string): Promise<{ socket: Socket; response: string }> {
  await waitForHealth(port);
  return handshake(port, origin);
}

void test("Trajectory persists the server fingerprint in its listening lock", async () => {
  const root = await mkdtemp(join(tmpdir(), "trajectory-server-lock-"));
  const port = await availablePort();
  const fingerprint = "server-hash:html-hash";
  const server = createTrajectoryServer(port, join(root, "trajectory.lock"), { fingerprint });
  await listen(server, port);
  try {
    const lock: unknown = JSON.parse(await readFile(join(root, "trajectory.lock"), "utf8"));
    assert.ok(typeof lock === "object" && lock !== null && "startedAt" in lock && typeof lock.startedAt === "number" && lock.startedAt <= Date.now());
    assert.deepEqual({ ...lock, startedAt: undefined }, { ...identityOf(process.pid), port, fingerprint, startedAt: undefined });
  } finally {
    server.closeAllConnections();
    server.closeIdleConnections();
    server.close();
    server.unref();
    await rm(root, { recursive: true, force: true });
  }
});

void test("Trajectory HTTP and WebSocket boundaries require localhost and origin", async () => {
  const root = await mkdtemp(join(tmpdir(), "trajectory-server-"));
  const port = await availablePort();
  const server = createTrajectoryServer(port, join(root, "trajectory.lock"));
  await listen(server, port);
  try {
    const base = `http://127.0.0.1:${String(port)}`;
    assert.equal((await fetch(`${base}/health`)).status, 200);
    assert.equal((await fetch(`${base}/health`, { headers: { host: `localhost:${String(port)}` } })).status, 200);
    assert.equal((await fetch(`${base}/health?token=ignored`)).status, 200);
    for (const path of ["/", "/index.html", "/marked.min.js"]) assert.equal((await fetch(`${base}${path}`)).status, 200);
    assert.equal((await fetch(`${base}/health`, { headers: { origin: "http://evil.test" } })).status, 403);
    const valid = await handshake(port, `http://127.0.0.1:${String(port)}`);
    assert.match(valid.response, /^HTTP\/1\.1 101 Switching Protocols/);
    const state = new Promise<Buffer>((resolve) => valid.socket.once("data", resolve));
    valid.socket.write(maskedFrame(JSON.stringify({ type: "ui:attach" })));
    assert.ok((await state).length > 2);
    valid.socket.destroy();
    const invalidOrigin = await new Promise<string>((resolve) => {
      const socket = createConnection(port, "127.0.0.1");
      let response = "";
      socket.on("data", (chunk) => { response += chunk.toString("latin1"); });
      socket.once("close", () => { resolve(response); });
      socket.write(`GET /ws HTTP/1.1\r\nHost: 127.0.0.1:${String(port)}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\nOrigin: http://evil.test\r\n\r\n`);
    });
    assert.doesNotMatch(invalidOrigin, /101 Switching Protocols/);
    const unmasked = await handshake(port, `http://127.0.0.1:${String(port)}`);
    const closed = new Promise<void>((resolve) => unmasked.socket.once("close", () => { resolve(); }));
    unmasked.socket.write(Buffer.from([0x81, 1, 0x78]));
    await closed;
  } finally {
    server.closeAllConnections();
    server.closeIdleConnections();
    server.close();
    server.unref();
    await rm(root, { recursive: true, force: true });
  }
});

void test("Trajectory keeps the browser socket when combined publisher state exceeds the frame cap", async () => {
  const root = await mkdtemp(join(tmpdir(), "trajectory-server-cap-"));
  const port = await availablePort();
  const maxFrameBytes = 1000;
  const blob = "x".repeat(400);
  const title = "x".repeat(300);
  const first = publisherState("one", blob, [], title);
  const second = publisherState("two", blob, [], title);
  assert.ok(Buffer.byteLength(first) < maxFrameBytes);
  assert.ok(Buffer.byteLength(second) < maxFrameBytes);
  const server = createTrajectoryServer(port, join(root, "trajectory.lock"), { maxFrameBytes });
  await listen(server, port);
  const sockets: Socket[] = [];
  try {
    const origin = `http://127.0.0.1:${String(port)}`;
    const publisherOne = await handshake(port, origin);
    const publisherTwo = await handshake(port, origin);
    sockets.push(publisherOne.socket, publisherTwo.socket);
    publisherOne.socket.write(maskedFrame(JSON.stringify({ type: "publisher:attach", publisherId: "one" })));
    publisherOne.socket.write(maskedFrame(first));
    publisherTwo.socket.write(maskedFrame(JSON.stringify({ type: "publisher:attach", publisherId: "two" })));
    publisherTwo.socket.write(maskedFrame(second));
    await new Promise((resolve) => setTimeout(resolve, 100));
    const browser = await handshake(port, origin);
    sockets.push(browser.socket);
    const closed = new Promise<string>((resolve) => browser.socket.once("close", () => { resolve("closed"); }));
    const state = readJsonFrame(browser.socket);
    browser.socket.write(maskedFrame(JSON.stringify({ type: "ui:attach" })));
    const message = await Promise.race([state, closed.then((value) => { throw new Error(value); })]);
    assert.equal((message as { type?: unknown }).type, "state");
    assert.equal((message as { truncated?: unknown }).truncated, true);
    const publishers = (message as { publishers?: unknown[] }).publishers;
    assert.ok(Array.isArray(publishers));
    assert.equal(publishers.length, 2);
    for (const publisher of publishers) {
      assert.equal((publisher as { connected?: unknown }).connected, true);
      const runs = (publisher as { runs?: { transcripts?: { agent?: unknown[] } }[] }).runs;
      assert.deepEqual(runs?.[0]?.transcripts?.agent ?? [], []);
    }
  } finally {
    for (const socket of sockets) socket.destroy();
    server.closeAllConnections();
    server.closeIdleConnections();
    server.close();
    server.unref();
    await rm(root, { recursive: true, force: true });
  }
});

void test("Trajectory tells a replaced publisher to stop reconnecting", async () => {
  const root = await mkdtemp(join(tmpdir(), "trajectory-server-replaced-publisher-"));
  const port = await availablePort();
  const server = createTrajectoryServer(port, join(root, "trajectory.lock"));
  await listen(server, port);
  const sockets: Socket[] = [];
  try {
    const origin = `http://127.0.0.1:${String(port)}`;
    const first = await handshake(port, origin);
    const second = await handshake(port, origin);
    sockets.push(first.socket, second.socket);
    first.socket.write(maskedFrame(JSON.stringify({ type: "publisher:attach", publisherId: "same" })));
    await new Promise((resolve) => setTimeout(resolve, 25));
    const replaced = readJsonFrame(first.socket);
    second.socket.write(maskedFrame(JSON.stringify({ type: "publisher:attach", publisherId: "same" })));
    assert.deepEqual(await replaced, { type: "publisher:replaced" });
  } finally {
    for (const socket of sockets) socket.destroy();
    server.closeAllConnections();
    server.closeIdleConnections();
    server.close();
    server.unref();
    await rm(root, { recursive: true, force: true });
  }
});
void test("Trajectory invalidates an active transcript across same-id publisher replacement", async () => {
  const root = await mkdtemp(join(tmpdir(), "trajectory-server-publisher-generation-"));
  const port = await availablePort();
  const server = createTrajectoryServer(port, join(root, "trajectory.lock"));
  await listen(server, port);
  const sockets: Socket[] = [];
  try {
    const origin = `http://127.0.0.1:${String(port)}`;
    const publisherOne = await handshake(port, origin);
    const publisherTwo = await handshake(port, origin);
    const browser = await handshake(port, origin);
    sockets.push(publisherOne.socket, publisherTwo.socket, browser.socket);
    const initialState = readJsonFrame(browser.socket);
    browser.socket.write(maskedFrame(JSON.stringify({ type: "ui:attach" })));
    assert.deepEqual((await initialState as { publishers?: unknown[] }).publishers, []);
    publisherOne.socket.write(maskedFrame(JSON.stringify({ type: "publisher:attach", publisherId: "same" })));
    const attachedState = await readJsonFrame(browser.socket) as { publishers?: { generation?: unknown }[] };
    assert.equal(attachedState.publishers?.[0]?.generation, 1);
    publisherOne.socket.write(maskedFrame(JSON.stringify({ type: "publisher:state", publisher: { id: "same" }, runs: [{ run: { id: "run", agents: [] }, transcripts: { agent: { revision: 1, status: "available", timing: [] } } }], subagents: [] })));
    const firstState = await readJsonFrame(browser.socket) as { publishers?: { generation?: unknown }[] };
    assert.equal(firstState.publishers?.[0]?.generation, 1);
    const forwarded = readJsonFrame(publisherOne.socket);
    browser.socket.write(maskedFrame(JSON.stringify({ type: "ui:transcript", requestId: "active", publisherId: "same", runId: "run", agentId: "agent", revision: 1 })));
    assert.equal((await forwarded as { type?: unknown }).type, "publisher:transcript");
    publisherTwo.socket.write(maskedFrame(JSON.stringify({ type: "publisher:attach", publisherId: "same" })));
    const replacementBrowser = await handshake(port, origin);
    sockets.push(replacementBrowser.socket);
    const replacementState = readJsonFrame(replacementBrowser.socket);
    replacementBrowser.socket.write(maskedFrame(JSON.stringify({ type: "ui:attach" })));
    assert.equal((await replacementState as { publishers?: { generation?: unknown }[] }).publishers?.[0]?.generation, 2);
  } finally {
    for (const socket of sockets) socket.destroy();
    server.closeAllConnections();
    server.closeIdleConnections();
    server.close();
    server.unref();
    await rm(root, { recursive: true, force: true });
  }
});

void test("Trajectory removes disconnected publishers from browser state", async () => {
  const root = await mkdtemp(join(tmpdir(), "trajectory-server-disconnect-"));
  const port = await availablePort();
  const server = createTrajectoryServer(port, join(root, "trajectory.lock"));
  await listen(server, port);
  const sockets: Socket[] = [];
  try {
    const origin = `http://127.0.0.1:${String(port)}`;
    const publisherOne = await handshake(port, origin);
    const publisherTwo = await handshake(port, origin);
    sockets.push(publisherOne.socket, publisherTwo.socket);
    publisherOne.socket.write(maskedFrame(JSON.stringify({ type: "publisher:attach", publisherId: "one" })));
    publisherOne.socket.write(maskedFrame(publisherState("one", "one")));
    publisherTwo.socket.write(maskedFrame(JSON.stringify({ type: "publisher:attach", publisherId: "two" })));
    publisherTwo.socket.write(maskedFrame(publisherState("two", "two")));
    await new Promise((resolve) => setTimeout(resolve, 100));

    const browser = await handshake(port, origin);
    sockets.push(browser.socket);
    const initial = readJsonFrame(browser.socket);
    browser.socket.write(maskedFrame(JSON.stringify({ type: "ui:attach" })));
    const firstState = await initial as { publishers?: { id?: unknown }[] };
    assert.deepEqual(firstState.publishers?.map((publisher) => publisher.id), ["one", "two"]);

    const nextState = readJsonFrame(browser.socket);
    publisherOne.socket.write(maskedCloseFrame());
    const afterDisconnect = await nextState as { publishers: { id?: unknown; connected?: unknown }[] };
    assert.deepEqual(afterDisconnect.publishers.map((publisher) => publisher.id), ["two"]);
    assert.equal(afterDisconnect.publishers.some((publisher) => publisher.connected === false), false);
  } finally {
    for (const socket of sockets) socket.destroy();
    server.closeAllConnections();
    server.closeIdleConnections();
    server.close();
    server.unref();
    await rm(root, { recursive: true, force: true });
  }
});

void test("Trajectory fetches one agent transcript after compacting combined state", async () => {
  const root = await mkdtemp(join(tmpdir(), "trajectory-server-transcript-"));
  const port = await availablePort();
  const maxFrameBytes = 800;
  const blob = "x".repeat(400);
  const first = publisherState("one", blob);
  const second = publisherState("two", blob);
  const server = createTrajectoryServer(port, join(root, "trajectory.lock"), { maxFrameBytes });
  await listen(server, port);
  const sockets: Socket[] = [];
  try {
    const origin = `http://127.0.0.1:${String(port)}`;
    const publisherOne = await handshake(port, origin);
    const publisherTwo = await handshake(port, origin);
    sockets.push(publisherOne.socket, publisherTwo.socket);
    publisherOne.socket.write(maskedFrame(JSON.stringify({ type: "publisher:attach", publisherId: "one" })));
    publisherOne.socket.write(maskedFrame(first));
    publisherTwo.socket.write(maskedFrame(JSON.stringify({ type: "publisher:attach", publisherId: "two" })));
    publisherTwo.socket.write(maskedFrame(second));
    await new Promise((resolve) => setTimeout(resolve, 100));
    const browser = await handshake(port, origin);
    sockets.push(browser.socket);
    const state = readJsonFrame(browser.socket);
    browser.socket.write(maskedFrame(JSON.stringify({ type: "ui:attach" })));
    const compact = await state as { publishers?: { runs?: { transcripts?: { agent?: unknown[] } }[] }[] };
    assert.deepEqual(compact.publishers?.[0]?.runs?.[0]?.transcripts?.agent ?? [], []);
    const reply = readJsonFrame(browser.socket);
    browser.socket.write(maskedFrame(JSON.stringify({ type: "ui:transcript", publisherId: "one", runId: "one", agentId: "agent" })));
    const transcript = await reply as { type?: unknown; agentId?: unknown; entries?: unknown };
    assert.equal(transcript.type, "transcript");
    assert.equal(transcript.agentId, "agent");
    assert.deepEqual(transcript.entries, [{ type: "message", text: blob }]);
  } finally {
    for (const socket of sockets) socket.destroy();
    server.closeAllConnections();
    server.closeIdleConnections();
    server.close();
    server.unref();
    await rm(root, { recursive: true, force: true });
  }
});

void test("Trajectory relays subagents and compacts only transcript bodies", async () => {
  const root = await mkdtemp(join(tmpdir(), "trajectory-server-subagent-state-"));
  const port = await availablePort();
  const maxFrameBytes = 1800;
  const timing = { type: "custom", customType: "pi-workflows:tool-timing", data: { toolCallId: "call", toolName: "bash", startedAt: 1, completedAt: 2, durationMs: 1, isError: false } };
  const subagent = { id: "subagent", state: "running", cwd: process.cwd(), worktree: { path: "/tmp/worktree", branch: "subagent" }, tools: ["bash"], toolDefinitions: [{ name: "bash", description: "Execute a bash command" }], attempt: { attempt: 1, setup: { tools: ["bash"], cwd: process.cwd() } }, transcript: [{ type: "message", text: "x".repeat(500) }, timing] };
  const server = createTrajectoryServer(port, join(root, "trajectory.lock"), { maxFrameBytes });
  await listen(server, port);
  const sockets: Socket[] = [];
  try {
    const origin = `http://127.0.0.1:${String(port)}`;
    const publisher = await handshake(port, origin);
    sockets.push(publisher.socket);
    publisher.socket.write(maskedFrame(JSON.stringify({ type: "publisher:attach", publisherId: "one" })));
    publisher.socket.write(maskedFrame(publisherState("one", "run", [subagent])));
    const publisherTwo = await handshake(port, origin);
    sockets.push(publisherTwo.socket);
    publisherTwo.socket.write(maskedFrame(JSON.stringify({ type: "publisher:attach", publisherId: "two" })));
    publisherTwo.socket.write(maskedFrame(publisherState("two", "x".repeat(1100))));
    await new Promise((resolve) => setTimeout(resolve, 100));
    const browser = await handshake(port, origin);
    sockets.push(browser.socket);
    const state = readJsonFrame(browser.socket);
    browser.socket.write(maskedFrame(JSON.stringify({ type: "ui:attach" })));
    const value = await state as { publishers?: { subagents?: { id?: unknown; worktree?: unknown; transcript?: unknown[]; toolDefinitions?: { name?: unknown }[] }[] }[] };
    const current = value.publishers?.[0]?.subagents?.[0];
    assert.ok(current);
    assert.equal(current.id, "subagent");
    assert.deepEqual(current.worktree, { path: "/tmp/worktree", branch: "subagent" });
    assert.deepEqual(current.transcript, [timing]);
    assert.equal(current.toolDefinitions?.[0]?.name, "bash");
    const reply = readJsonFrame(browser.socket);
    browser.socket.write(maskedFrame(JSON.stringify({ type: "ui:transcript", publisherId: "one", subagentId: "subagent" })));
    const transcript = await reply as { subagentId?: unknown; entries?: { text?: unknown }[] };
    assert.equal(transcript.subagentId, "subagent");
    assert.equal(transcript.entries?.[0]?.text, "x".repeat(500));
  } finally {
    for (const socket of sockets) socket.destroy();
    server.closeAllConnections();
    server.closeIdleConnections();
    server.close();
    server.unref();
    await rm(root, { recursive: true, force: true });
  }
});

void test("Trajectory rejects an oversized subagent transcript reply", async () => {
  const root = await mkdtemp(join(tmpdir(), "trajectory-server-subagent-transcript-cap-"));
  const port = await availablePort();
  const maxFrameBytes = 1000;
  const transcript = Array.from({ length: 20 }, () => ({ type: "message", text: "x", value: 1e20 }));
  const publisherMessage = JSON.stringify({ type: "publisher:state", publisher: { id: "one" }, runs: [], subagents: [{ id: "subagent", state: "running", transcript }] }).replaceAll("100000000000000000000", "1e20");
  assert.ok(Buffer.byteLength(publisherMessage) <= maxFrameBytes);
  const server = createTrajectoryServer(port, join(root, "trajectory.lock"), { maxFrameBytes });
  await listen(server, port);
  const sockets: Socket[] = [];
  try {
    const origin = `http://127.0.0.1:${String(port)}`;
    const publisher = await handshake(port, origin);
    sockets.push(publisher.socket);
    publisher.socket.write(maskedFrame(JSON.stringify({ type: "publisher:attach", publisherId: "one" })));
    publisher.socket.write(maskedFrame(publisherMessage));
    await new Promise((resolve) => setTimeout(resolve, 100));
    const browser = await handshake(port, origin);
    sockets.push(browser.socket);
    const state = readJsonFrame(browser.socket);
    browser.socket.write(maskedFrame(JSON.stringify({ type: "ui:attach" })));
    const value = await state as { publishers?: { subagents?: { id?: unknown; transcript?: unknown[] }[] }[] };
    const current = value.publishers?.[0]?.subagents?.[0];
    assert.ok(current);
    assert.equal(current.id, "subagent");
    assert.deepEqual(current.transcript, []);
    const reply = readJsonFrame(browser.socket);
    browser.socket.write(maskedFrame(JSON.stringify({ type: "ui:transcript", publisherId: "one", subagentId: "subagent" })));
    const transcriptReply = await reply as { subagentId?: unknown; ok?: unknown; error?: unknown };
    assert.equal(transcriptReply.subagentId, "subagent");
    assert.equal(transcriptReply.ok, false);
    assert.equal(transcriptReply.error, "Transcript is too large");
  } finally {
    for (const socket of sockets) socket.destroy();
    server.closeAllConnections();
    server.closeIdleConnections();
    server.close();
    server.unref();
    await rm(root, { recursive: true, force: true });
  }
});

void test("Trajectory correlates duplicate browser request IDs to their requesting browser", async () => {
  const root = await mkdtemp(join(tmpdir(), "trajectory-server-request-correlation-"));
  const port = await availablePort();
  const server = createTrajectoryServer(port, join(root, "trajectory.lock"));
  await listen(server, port);
  const sockets: Socket[] = [];
  try {
    const origin = `http://127.0.0.1:${String(port)}`;
    const publisher = await handshake(port, origin);
    sockets.push(publisher.socket);
    publisher.socket.write(maskedFrame(JSON.stringify({ type: "publisher:attach", publisherId: "one" })));
    publisher.socket.write(maskedFrame(JSON.stringify({ type: "publisher:state", publisher: { id: "one" }, runs: [{ run: { id: "one", agents: [] }, transcripts: { agent: { revision: 1, status: "available", timing: [] } } }], subagents: [] })));
    await new Promise((resolve) => setTimeout(resolve, 50));
    const browserOne = await handshake(port, origin);
    const browserTwo = await handshake(port, origin);
    sockets.push(browserOne.socket, browserTwo.socket);
    const stateOne = readJsonFrame(browserOne.socket);
    browserOne.socket.write(maskedFrame(JSON.stringify({ type: "ui:attach" })));
    await stateOne;
    const stateTwo = readJsonFrame(browserTwo.socket);
    browserTwo.socket.write(maskedFrame(JSON.stringify({ type: "ui:attach" })));
    await stateTwo;
    const request = { type: "ui:transcript", requestId: "shared-request", publisherId: "one", runId: "one", agentId: "agent" };
    browserOne.socket.write(maskedFrame(JSON.stringify(request)));
    const forwardedOne = await readJsonFrame(publisher.socket) as { requestId?: unknown };
    browserTwo.socket.write(maskedFrame(JSON.stringify(request)));
    const forwardedTwo = await readJsonFrame(publisher.socket) as { requestId?: unknown };
    assert.notEqual(forwardedOne.requestId, forwardedTwo.requestId);
    for (const forwarded of [forwardedOne, forwardedTwo]) publisher.socket.write(maskedFrame(JSON.stringify({ type: "publisher:transcript-result", requestId: forwarded.requestId, publisherId: "one", runId: "one", agentId: "agent", ok: true, status: "available", revision: 1, entries: [{ requestId: forwarded.requestId }] })));
    const responseOne = await readJsonFrame(browserOne.socket) as { entries?: { requestId?: unknown }[] };
    const responseTwo = await readJsonFrame(browserTwo.socket) as { entries?: { requestId?: unknown }[] };
    assert.equal(responseOne.entries?.[0]?.requestId, forwardedOne.requestId);
    assert.equal(responseTwo.entries?.[0]?.requestId, forwardedTwo.requestId);
  } finally {
    for (const socket of sockets) socket.destroy();
    server.closeAllConnections();
    server.closeIdleConnections();
    server.close();
    server.unref();
    await rm(root, { recursive: true, force: true });
  }
});
void test("Trajectory does not let transcript results settle action requests", async () => {
  const root = await mkdtemp(join(tmpdir(), "trajectory-server-request-kind-"));
  const port = await availablePort();
  const server = createTrajectoryServer(port, join(root, "trajectory.lock"));
  await listen(server, port);
  const sockets: Socket[] = [];
  try {
    const origin = `http://127.0.0.1:${String(port)}`;
    const publisher = await handshake(port, origin);
    sockets.push(publisher.socket);
    publisher.socket.write(maskedFrame(JSON.stringify({ type: "publisher:attach", publisherId: "one" })));
    publisher.socket.write(maskedFrame(publisherState("one", "run")));
    await new Promise((resolve) => setTimeout(resolve, 50));
    const browser = await handshake(port, origin);
    sockets.push(browser.socket);
    const state = readJsonFrame(browser.socket);
    browser.socket.write(maskedFrame(JSON.stringify({ type: "ui:attach" })));
    await state;
    const forwarded = readJsonFrame(publisher.socket);
    browser.socket.write(maskedFrame(JSON.stringify({ type: "ui:action", requestId: "same-request", publisherId: "one", action: "retry", target: { kind: "run", id: "run-id" } })));
    const action = await forwarded as { requestId?: unknown };
    publisher.socket.write(maskedFrame(JSON.stringify({ type: "publisher:transcript-result", requestId: action.requestId, publisherId: "one", runId: "run-id", agentId: "agent", ok: true, status: "available", revision: 1, entries: [{ type: "message" }] })));
    publisher.socket.write(maskedFrame(JSON.stringify({ type: "publisher:action-result", requestId: action.requestId, publisherId: "one", ok: true, result: { accepted: true } })));
    const result = await readJsonFrame(browser.socket) as { type?: unknown; result?: unknown };
    assert.deepEqual(result, { type: "action-result", requestId: "same-request", ok: true, result: { accepted: true } });
  } finally {
    for (const socket of sockets) socket.destroy();
    server.closeAllConnections();
    server.closeIdleConnections();
    server.close();
    server.unref();
    await rm(root, { recursive: true, force: true });
  }
});
void test("Trajectory relays target-addressed actions and rejects run-only subagent actions", async () => {
  const root = await mkdtemp(join(tmpdir(), "trajectory-server-actions-"));
  const port = await availablePort();
  const server = createTrajectoryServer(port, join(root, "trajectory.lock"));
  await listen(server, port);
  const sockets: Socket[] = [];
  try {
    const origin = `http://127.0.0.1:${String(port)}`;
    const publisher = await handshake(port, origin);
    sockets.push(publisher.socket);
    publisher.socket.write(maskedFrame(JSON.stringify({ type: "publisher:attach", publisherId: "one" })));
    publisher.socket.write(maskedFrame(publisherState("one", "run")));
    await new Promise((resolve) => setTimeout(resolve, 100));
    const browser = await handshake(port, origin);
    sockets.push(browser.socket);
    const state = readJsonFrame(browser.socket);
    browser.socket.write(maskedFrame(JSON.stringify({ type: "ui:attach" })));
    await state;
    const runAction = readJsonFrame(publisher.socket);
    browser.socket.write(maskedFrame(JSON.stringify({ type: "ui:action", requestId: "run-request", publisherId: "one", action: "retry", target: { kind: "run", id: "run-id" } })));
    assert.deepEqual(await runAction, { type: "publisher:action", requestId: "run-request", action: "retry", target: { kind: "run", id: "run-id" } });
    const subagentAction = readJsonFrame(publisher.socket);
    browser.socket.write(maskedFrame(JSON.stringify({ type: "ui:action", requestId: "subagent-request", publisherId: "one", action: "steer", target: { kind: "subagent", id: "subagent" }, payload: { message: "continue" } })));
    assert.deepEqual(await subagentAction, { type: "publisher:action", requestId: "subagent-request", action: "steer", target: { kind: "subagent", id: "subagent" }, payload: { message: "continue" } });
    const rejection = readJsonFrame(browser.socket);
    browser.socket.write(maskedFrame(JSON.stringify({ type: "ui:action", requestId: "rejection", publisherId: "one", action: "pause", target: { kind: "subagent", id: "subagent" } })));
    const value = await rejection as { requestId?: unknown; ok?: unknown; error?: unknown };
    assert.equal(value.requestId, "rejection");
    assert.equal(value.ok, false);
    assert.equal(value.error, "Trajectory action pause is not supported for subagent targets");
  } finally {
    for (const socket of sockets) socket.destroy();
    server.closeAllConnections();
    server.closeIdleConnections();
    server.close();
    server.unref();
    await rm(root, { recursive: true, force: true });
  }
});

async function waitForExit(child: ReturnType<typeof spawn>, timeoutMs: number): Promise<number | null> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { child.kill("SIGKILL"); reject(new Error("Trajectory server did not exit")); }, timeoutMs);
    child.once("error", (error) => { clearTimeout(timer); reject(error); });
    child.once("exit", (code) => { clearTimeout(timer); resolve(code); });
  });
}

void test("Trajectory idle exit closes open clients and removes its lock", async () => {
  const root = await mkdtemp(join(tmpdir(), "trajectory-server-idle-exit-"));
  const port = await availablePort();
  const lockPath = join(root, "trajectory.lock");
  const moduleUrl = new URL("../src/server.js", import.meta.url).href;
  const childScript = `const realSetTimeout = globalThis.setTimeout; globalThis.setTimeout = (callback, delay, ...args) => realSetTimeout(callback, delay === 300000 ? 10000 : delay, ...args); const { createTrajectoryServer } = await import(${JSON.stringify(moduleUrl)}); const server = createTrajectoryServer(${String(port)}, ${JSON.stringify(lockPath)}, { maxFrameBytes: 33554432, fingerprint: "test-fingerprint" }); server.listen(${String(port)}, "127.0.0.1");`;
  const child = spawn(process.execPath, ["--input-type=module", "-e", childScript], { stdio: "ignore" });
  let socket: Socket | undefined;
  let pending: Socket | undefined;
  try {
    const connected = await handshakeWhenReady(port, `http://127.0.0.1:${String(port)}`);
    socket = connected.socket;
    const socketClosed = new Promise<void>((resolve) => socket?.once("close", () => { resolve(); }));
    assert.match(connected.response, /^HTTP\/1\.1 101 Switching Protocols/);
    // An unterminated request keeps a connection in flight, which is what actually blocks server.close().
    pending = createConnection(port, "127.0.0.1");
    await new Promise<void>((resolve, reject) => { pending?.once("connect", () => { resolve(); }); pending?.once("error", reject); });
    pending.write(`GET /health HTTP/1.1\r\nHost: 127.0.0.1:${String(port)}\r\n`);
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.equal(await waitForExit(child, 15000), 0);
    await socketClosed;
    await assert.rejects(readFile(lockPath), { code: "ENOENT" });
    await assert.rejects(fetch(`http://127.0.0.1:${String(port)}/health`));
  } finally {
    socket?.destroy();
    pending?.destroy();
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    await rm(root, { recursive: true, force: true });
  }
});

type Health = { pid?: unknown; fingerprint?: unknown; startedAt?: unknown };
async function health(port: number): Promise<Health | undefined> {
  try {
    const response = await fetch(`http://127.0.0.1:${String(port)}/health`, { signal: AbortSignal.timeout(300) });
    return response.ok ? await response.json() as Health : undefined;
  } catch { return undefined; }
}
function spawnServer(port: number, lockPath: string): ReturnType<typeof spawn> {
  return spawn(process.execPath, [fileURLToPath(new URL("../src/server.js", import.meta.url)), "--port", String(port), "--lock", lockPath, "--fingerprint", "test-fingerprint"], { stdio: "ignore" });
}

void test("Trajectory answers /health only after its lock names it", { skip: process.platform === "win32" ? "needs a POSIX FIFO" : false }, async () => {
  const root = await mkdtemp(join(tmpdir(), "trajectory-server-publish-"));
  const port = await availablePort();
  const lockPath = join(root, "trajectory.lock");
  // A FIFO with no reader holds back any write into the existing lock file indefinitely.
  execFileSync("mkfifo", [lockPath]);
  const child = spawnServer(port, lockPath);
  try {
    let served: Health | undefined;
    for (let attempt = 0; attempt < 500 && served === undefined && child.exitCode === null; attempt += 1) {
      served = await health(port);
      if (served === undefined) await new Promise((resolve) => setTimeout(resolve, 20));
    }
    assert.ok(served, "Trajectory server never became healthy");
    assert.ok((await lstat(lockPath)).isFile(), "/health answered before the lock was published");
    const lock: unknown = JSON.parse(await readFile(lockPath, "utf8"));
    assert.ok(child.pid);
    assert.deepEqual(lock, { ...identityOf(child.pid), port, fingerprint: "test-fingerprint", startedAt: served.startedAt });
    assert.equal(served.pid, child.pid);
  } finally {
    child.kill("SIGKILL");
    await rm(root, { recursive: true, force: true });
  }
});

void test("Trajectory server that cannot publish its lock exits without answering /health", async () => {
  const root = await mkdtemp(join(tmpdir(), "trajectory-server-publish-failure-"));
  const port = await availablePort();
  const child = spawnServer(port, join(root, "missing", "trajectory.lock"));
  const exited = waitForExit(child, 15000);
  try {
    let answered = false;
    while (child.exitCode === null && !answered) {
      answered = await health(port) !== undefined;
      if (!answered) await new Promise((resolve) => setTimeout(resolve, 20));
    }
    assert.equal(answered, false, "Trajectory reported ready without a lock");
    assert.equal(await exited, 1);
  } finally {
    if (child.exitCode === null) child.kill("SIGKILL");
    await exited.catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  }
});

void test("Trajectory server that cannot listen exits and leaves the current lock alone", async () => {
  const root = await mkdtemp(join(tmpdir(), "trajectory-server-port-taken-"));
  const occupant = createNetServer();
  await new Promise<void>((resolve, reject) => { occupant.once("error", reject); occupant.listen(0, "127.0.0.1", resolve); });
  const address = occupant.address();
  assert.ok(address && typeof address === "object");
  const lockPath = join(root, "trajectory.lock");
  const current = `${JSON.stringify({ pid: process.pid, port: address.port, fingerprint: "current", startedAt: Date.now() })}\n`;
  await writeFile(lockPath, current, "utf8");
  try {
    assert.equal(await waitForExit(spawnServer(address.port, lockPath), 15000), 1);
    assert.equal(await readFile(lockPath, "utf8"), current);
  } finally {
    await new Promise<void>((resolve) => { occupant.close(() => { resolve(); }); });
    await rm(root, { recursive: true, force: true });
  }
});

void test("Trajectory server whose startup was revoked exits without publishing its lock", async () => {
  const root = await mkdtemp(join(tmpdir(), "trajectory-server-revoked-"));
  const port = await availablePort();
  const lockPath = join(root, "trajectory.lock");
  // The Pi that launched it gave up and released the startup, so a later owner's lock must not be replaced.
  const current = `${JSON.stringify({ pid: process.pid, port, fingerprint: "current", startedAt: Date.now() })}\n`;
  await writeFile(lockPath, current, "utf8");
  const child = spawn(process.execPath, [fileURLToPath(new URL("../src/server.js", import.meta.url)), "--port", String(port), "--lock", lockPath, "--fingerprint", "test-fingerprint", "--startup", "revoked-token"], { stdio: "ignore" });
  try {
    assert.equal(await waitForExit(child, 15000), 1);
    assert.equal(await readFile(lockPath, "utf8"), current);
  } finally {
    if (child.exitCode === null) child.kill("SIGKILL");
    await rm(root, { recursive: true, force: true });
  }
});

void test("Trajectory idle exit keeps a lock another process published", async () => {
  const root = await mkdtemp(join(tmpdir(), "trajectory-server-idle-foreign-"));
  const port = await availablePort();
  const lockPath = join(root, "trajectory.lock");
  const moduleUrl = new URL("../src/server.js", import.meta.url).href;
  // Only the idle exit scheduled after the publisher detaches is shortened, so the lock is replaced before it can fire.
  const childScript = `const realSetTimeout = globalThis.setTimeout; let idleTimers = 0; globalThis.setTimeout = (callback, delay, ...args) => realSetTimeout(callback, delay === 300000 && idleTimers++ > 0 ? 50 : delay, ...args); const { createTrajectoryServer } = await import(${JSON.stringify(moduleUrl)}); createTrajectoryServer(${String(port)}, ${JSON.stringify(lockPath)}, { fingerprint: "test-fingerprint" }).listen(${String(port)}, "127.0.0.1");`;
  const child = spawn(process.execPath, ["--input-type=module", "-e", childScript], { stdio: "ignore" });
  const exited = waitForExit(child, 15000);
  let socket: Socket | undefined;
  try {
    socket = (await handshakeWhenReady(port, `http://127.0.0.1:${String(port)}`)).socket;
    const foreign = `${JSON.stringify({ pid: process.pid, port, fingerprint: "other", startedAt: Date.now() })}\n`;
    await writeFile(lockPath, foreign, "utf8");
    socket.write(maskedFrame(JSON.stringify({ type: "publisher:attach", publisherId: "idle" })));
    socket.write(maskedFrame(JSON.stringify({ type: "publisher:detach" })));
    assert.equal(await exited, 0);
    assert.equal(await readFile(lockPath, "utf8"), foreign);
  } finally {
    socket?.destroy();
    if (child.exitCode === null) child.kill("SIGKILL");
    await exited.catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  }
});

void test("Trajectory idle exit waits while a Pi holds the startup mutex", async () => {
  const root = await mkdtemp(join(tmpdir(), "trajectory-server-idle-startup-"));
  const port = await availablePort();
  const lockPath = join(root, "trajectory.lock");
  const moduleUrl = new URL("../src/server.js", import.meta.url).href;
  const childScript = `const realSetTimeout = globalThis.setTimeout; let idleTimers = 0; globalThis.setTimeout = (callback, delay, ...args) => realSetTimeout(callback, delay === 300000 && idleTimers++ > 0 ? 50 : delay, ...args); const { createTrajectoryServer } = await import(${JSON.stringify(moduleUrl)}); createTrajectoryServer(${String(port)}, ${JSON.stringify(lockPath)}, { fingerprint: "test-fingerprint" }).listen(${String(port)}, "127.0.0.1");`;
  const child = spawn(process.execPath, ["--input-type=module", "-e", childScript], { stdio: "ignore" });
  const exited = waitForExit(child, 15000);
  let socket: Socket | undefined;
  let watcher: ReturnType<typeof watch> | undefined;
  try {
    socket = (await handshakeWhenReady(port, `http://127.0.0.1:${String(port)}`)).socket;
    const token = await tryAcquireStartupMutex(lockPath);
    assert.ok(token);
    // The server's own acquisition attempt shows up as its temporary holder file in the mutex directory.
    const holders = watch(`${lockPath}.startup`);
    watcher = holders;
    const attempted = new Promise<void>((resolve) => { holders.on("change", (_event, name) => { if (String(name).includes(`.${String(child.pid)}.`)) resolve(); }); });
    socket.write(maskedFrame(JSON.stringify({ type: "publisher:attach", publisherId: "idle" })));
    socket.write(maskedFrame(JSON.stringify({ type: "publisher:detach" })));
    assert.equal(await Promise.race([attempted.then(() => "attempted"), exited.then(() => "exited")]), "attempted");
    assert.equal(child.exitCode, null);
    assert.equal((await health(port))?.pid, child.pid);

    await releaseStartupMutex(lockPath, token);
    assert.equal(await exited, 0);
    await assert.rejects(readFile(lockPath), { code: "ENOENT" });
  } finally {
    watcher?.close();
    socket?.destroy();
    if (child.exitCode === null) child.kill("SIGKILL");
    await exited.catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  }
});

function timingState(id: string, revision: number, entries: number): string {
  const timing = Array.from({ length: entries }, (_, index) => ({ type: "custom", customType: "pi-workflows:tool-timing", data: { toolCallId: `call-${String(index)}`, toolName: "read", startedAt: 1_000 + index, completedAt: 1_100 + index, durationMs: 100, isError: false } }));
  return JSON.stringify({
    type: "publisher:state",
    publisher: { id },
    runs: [
      { run: { id: "focused", workflowName: "focused", agents: [], state: "running" }, transcripts: { agent: { revision, status: "available", timing } }, snapshot: {}, awaiting: [] },
      { run: { id: "other", workflowName: "other", agents: [], state: "completed" }, transcripts: { agent: { revision, status: "available", timing } }, snapshot: {}, awaiting: [] },
    ],
    subagents: [],
  });
}

type StateFrame = { publishers: { id: string; runs: { run: { id: string }; transcripts: { agent: { revision: number; timing?: unknown[] } } }[] }[] };
function stateFrame(value: unknown): StateFrame {
  assert.ok(value && typeof value === "object" && (value as { type?: unknown }).type === "state");
  return value as StateFrame;
}
function focusedTranscript(frame: StateFrame, runId: string): { revision: number; timing?: unknown[] } {
  const run = frame.publishers[0]?.runs.find((candidate) => candidate.run.id === runId);
  assert.ok(run);
  return run.transcripts.agent;
}

void test("Trajectory ships tool-timing once per revision to the focused browser", async () => {
  const root = await mkdtemp(join(tmpdir(), "trajectory-server-timing-"));
  const port = await availablePort();
  const server = createTrajectoryServer(port, join(root, "trajectory.lock"));
  await listen(server, port);
  const origin = `http://127.0.0.1:${String(port)}`;
  const publisher = await handshake(port, origin);
  const browser = await handshake(port, origin);
  try {
    publisher.socket.write(maskedFrame(JSON.stringify({ type: "publisher:attach", publisherId: "pub" })));
    browser.socket.write(maskedFrame(JSON.stringify({ type: "ui:attach" })));
    await readJsonFrame(browser.socket);
    publisher.socket.write(maskedFrame(timingState("pub", 7, 3)));
    await readJsonFrame(browser.socket);

    browser.socket.write(maskedFrame(JSON.stringify({ type: "ui:focus", publisherId: "pub", runId: "focused" })));
    const first = stateFrame(await readJsonFrame(browser.socket));
    assert.equal(focusedTranscript(first, "focused").timing?.length, 3);
    assert.deepEqual(focusedTranscript(first, "other").timing, []);

    publisher.socket.write(maskedFrame(timingState("pub", 7, 3)));
    const repeated = stateFrame(await readJsonFrame(browser.socket));
    assert.equal(focusedTranscript(repeated, "focused").timing, undefined);

    publisher.socket.write(maskedFrame(timingState("pub", 8, 4)));
    const changed = stateFrame(await readJsonFrame(browser.socket));
    assert.equal(focusedTranscript(changed, "focused").timing?.length, 4);

    browser.socket.write(maskedFrame(JSON.stringify({ type: "ui:focus", publisherId: "pub", runId: "other" })));
    const switched = stateFrame(await readJsonFrame(browser.socket));
    assert.equal(focusedTranscript(switched, "other").timing?.length, 4);
    assert.deepEqual(focusedTranscript(switched, "focused").timing, []);
  } finally {
    publisher.socket.destroy();
    browser.socket.destroy();
    server.closeAllConnections();
    server.close();
    server.unref();
    await rm(root, { recursive: true, force: true });
  }
});

void test("Trajectory tells publishers how many browsers are watching", async () => {
  const root = await mkdtemp(join(tmpdir(), "trajectory-server-viewers-"));
  const port = await availablePort();
  const server = createTrajectoryServer(port, join(root, "trajectory.lock"));
  await listen(server, port);
  const origin = `http://127.0.0.1:${String(port)}`;
  const publisher = await handshake(port, origin);
  const browser = await handshake(port, origin);
  try {
    publisher.socket.write(maskedFrame(JSON.stringify({ type: "publisher:attach", publisherId: "pub" })));
    assert.deepEqual(await readJsonFrame(publisher.socket, isViewerFrame), { type: "publisher:viewers", count: 0 });
    browser.socket.write(maskedFrame(JSON.stringify({ type: "ui:attach" })));
    assert.deepEqual(await readJsonFrame(publisher.socket, isViewerFrame), { type: "publisher:viewers", count: 1 });
    browser.socket.write(maskedCloseFrame());
    assert.deepEqual(await readJsonFrame(publisher.socket, isViewerFrame), { type: "publisher:viewers", count: 0 });
    // A tab that dies sends FIN without a close frame, which must still drop the client.
    const dropped = await handshake(port, origin);
    dropped.socket.write(maskedFrame(JSON.stringify({ type: "ui:attach" })));
    assert.deepEqual(await readJsonFrame(publisher.socket, isViewerFrame), { type: "publisher:viewers", count: 1 });
    dropped.socket.end();
    assert.deepEqual(await readJsonFrame(publisher.socket, isViewerFrame), { type: "publisher:viewers", count: 0 });
  } finally {
    publisher.socket.destroy();
    browser.socket.destroy();
    server.closeAllConnections();
    server.close();
    server.unref();
    await rm(root, { recursive: true, force: true });
  }
});

type ServerSocket = import("node:stream").Duplex;
/** Collects the server side of each upgraded socket in connection order, after the server attached its own handlers. */
function serverSockets(server: ReturnType<typeof createTrajectoryServer>): ServerSocket[] {
  const sockets: ServerSocket[] = [];
  server.on("upgrade", (_request: unknown, socket: ServerSocket) => { sockets.push(socket); });
  return sockets;
}
function maskedControlFrame(opcode: number, value: string): Buffer {
  const data = Buffer.from(value);
  assert.ok(data.length <= 125);
  const mask = Buffer.from([5, 6, 7, 8]);
  const body = Buffer.alloc(data.length);
  for (let index = 0; index < data.length; index += 1) body[index] = (data[index] ?? 0) ^ (mask[index % 4] ?? 0);
  return Buffer.concat([Buffer.from([0x80 | opcode, 0x80 | data.length]), mask, body]);
}
function splitIrregularly(bytes: Buffer): Buffer[] {
  const sizes = [1, 2, 3, 5, 8, 13, 21, 4096, 1, 65_537];
  const chunks: Buffer[] = [];
  for (let offset = 0, index = 0; offset < bytes.length; index += 1) {
    const size = sizes[index % sizes.length] ?? 1;
    chunks.push(bytes.subarray(offset, offset + size));
    offset += size;
  }
  return chunks;
}
function stateTitle(value: unknown): string | undefined {
  if (!value || typeof value !== "object" || (value as { type?: unknown }).type !== "state") return undefined;
  const title = (value as { publishers?: { title?: unknown }[] }).publishers?.[0]?.title;
  return typeof title === "string" ? title : undefined;
}

void test("Trajectory parses several complete frames delivered in one chunk larger than the frame limit", async () => {
  const root = await mkdtemp(join(tmpdir(), "trajectory-server-coalesced-"));
  const port = await availablePort();
  const maxFrameBytes = 1000;
  const server = createTrajectoryServer(port, join(root, "trajectory.lock"), { maxFrameBytes });
  const sides = serverSockets(server);
  await listen(server, port);
  const origin = `http://127.0.0.1:${String(port)}`;
  const publisher = await handshake(port, origin);
  const browser = await handshake(port, origin);
  try {
    const publisherSide = sides[0];
    assert.ok(publisherSide);
    browser.socket.write(maskedFrame(JSON.stringify({ type: "ui:attach" })));
    await readJsonFrame(browser.socket);
    const frames = [maskedFrame(JSON.stringify({ type: "publisher:attach", publisherId: "pub", padding: "p".repeat(150) })), maskedFrame(JSON.stringify({ type: "publisher:state", publisher: { id: "pub", title: "t".repeat(820) }, runs: [], subagents: [] }))];
    const chunk = Buffer.concat(frames);
    assert.ok(chunk.length > maxFrameBytes + 14);
    for (const part of frames) assert.ok(part.length < maxFrameBytes);
    publisherSide.emit("data", chunk);
    const state = await readJsonFrame(browser.socket, (value) => stateTitle(value) !== undefined);
    assert.equal(stateTitle(state), "t".repeat(820));
  } finally {
    publisher.socket.destroy();
    browser.socket.destroy();
    server.closeAllConnections();
    server.close();
    server.unref();
    await rm(root, { recursive: true, force: true });
  }
});

void test("Trajectory assembles WebSocket frames split across arbitrary chunk boundaries", async () => {
  const root = await mkdtemp(join(tmpdir(), "trajectory-server-chunks-"));
  const port = await availablePort();
  const server = createTrajectoryServer(port, join(root, "trajectory.lock"));
  const sides = serverSockets(server);
  await listen(server, port);
  const origin = `http://127.0.0.1:${String(port)}`;
  const publisher = await handshake(port, origin);
  const browser = await handshake(port, origin);
  try {
    const publisherSide = sides[0];
    assert.ok(publisherSide);
    browser.socket.write(maskedFrame(JSON.stringify({ type: "ui:attach" })));
    await readJsonFrame(browser.socket);
    const attach = JSON.stringify({ type: "publisher:attach", publisherId: "pub", padding: "p".repeat(300) });
    const title = "t".repeat(70_000);
    const stream = Buffer.concat([maskedFrame(attach), maskedControlFrame(0x9, JSON.stringify({ ping: "one" })), maskedControlFrame(0xA, "ignored"), maskedFrame(publisherState("pub", "", [], title)), maskedControlFrame(0x9, JSON.stringify({ ping: "two" }))]);
    assert.ok(Buffer.byteLength(attach) > 125 && Buffer.byteLength(attach) <= 0xffff);
    // A socket drops data while no reader is attached, so the browser listens before the publisher's frames are emitted.
    const browserState = readJsonFrame(browser.socket, (value) => stateTitle(value) !== undefined);
    for (const chunk of splitIrregularly(stream)) publisherSide.emit("data", chunk);
    assert.deepEqual(await readJsonFrame(publisher.socket), { ping: "one" });
    assert.deepEqual(await readJsonFrame(publisher.socket), { ping: "two" });
    assert.equal(stateTitle(await browserState), title);
  } finally {
    publisher.socket.destroy();
    browser.socket.destroy();
    server.closeAllConnections();
    server.close();
    server.unref();
    await rm(root, { recursive: true, force: true });
  }
});

/** Totals bytes copied and allocated through the public Buffer API while action runs. */
function countBufferBytes(action: () => void): { copied: number; allocated: number } {
  const totals = { copied: 0, allocated: 0 };
  const saved: [object, string, PropertyDescriptor][] = [];
  const wrap = (target: object, name: string, count: (result: unknown, args: readonly unknown[]) => void): void => {
    const descriptor = Object.getOwnPropertyDescriptor(target, name);
    assert.ok(descriptor && typeof descriptor.value === "function");
    const original = descriptor.value as (...args: unknown[]) => unknown;
    saved.push([target, name, descriptor]);
    Object.defineProperty(target, name, { ...descriptor, value: function (this: unknown, ...args: unknown[]) { const result = Reflect.apply(original, this, args); count(result, args); return result; } });
  };
  try {
    for (const name of ["alloc", "allocUnsafe", "allocUnsafeSlow"]) wrap(Buffer, name, (_result, args) => { totals.allocated += Number(args[0]); });
    wrap(Buffer, "concat", (result) => { totals.copied += (result as Buffer).length; });
    wrap(Buffer.prototype as object, "copy", (result) => { totals.copied += Number(result); });
    action();
  } finally {
    for (const [target, name, descriptor] of saved.reverse()) Object.defineProperty(target, name, descriptor);
  }
  return totals;
}

void test("Trajectory copies a large frame split into small chunks a bounded number of times", async () => {
  const root = await mkdtemp(join(tmpdir(), "trajectory-server-linear-"));
  const port = await availablePort();
  const server = createTrajectoryServer(port, join(root, "trajectory.lock"));
  const sides = serverSockets(server);
  await listen(server, port);
  const origin = `http://127.0.0.1:${String(port)}`;
  const publisher = await handshake(port, origin);
  try {
    const publisherSide = sides[0];
    assert.ok(publisherSide);
    publisherSide.emit("data", maskedFrame(JSON.stringify({ type: "publisher:attach", publisherId: "pub" })));
    const title = "z".repeat(4 * 1024 * 1024);
    const bytes = maskedFrame(publisherState("pub", "", [], title));
    const chunks: Buffer[] = [];
    for (let offset = 0; offset < bytes.length; offset += 16 * 1024) chunks.push(bytes.subarray(offset, offset + 16 * 1024));
    const { copied, allocated } = countBufferBytes(() => { for (const chunk of chunks) publisherSide.emit("data", chunk); });
    // Reassembly once per chunk would copy about chunks.length / 2 times the frame.
    assert.ok(copied <= 2 * bytes.length, `copied ${String(copied)} bytes for a ${String(bytes.length)} byte frame`);
    assert.ok(allocated <= 3 * bytes.length, `allocated ${String(allocated)} bytes for a ${String(bytes.length)} byte frame`);
    const browser = await handshake(port, origin);
    try {
      browser.socket.write(maskedFrame(JSON.stringify({ type: "ui:attach" })));
      assert.equal(stateTitle(await readJsonFrame(browser.socket)), title);
    } finally { browser.socket.destroy(); }
  } finally {
    publisher.socket.destroy();
    server.closeAllConnections();
    server.close();
    server.unref();
    await rm(root, { recursive: true, force: true });
  }
});

/** Makes the next state write report a full socket buffer, as a slow browser would. */
function backpressureNextWrite(socket: ServerSocket): void {
  const write = socket.write.bind(socket) as (chunk: unknown) => boolean;
  socket.write = ((chunk: unknown) => { write(chunk); delete (socket as { write?: unknown }).write; return false; }) as ServerSocket["write"];
}
/** Counts JSON serializations, which every state encoding performs at least once per publisher. */
function countSerializations(action: () => void): number {
  const stringify = JSON.stringify;
  let count = 0;
  JSON.stringify = ((...args: Parameters<typeof JSON.stringify>) => { count += 1; return stringify(...args); }) as typeof JSON.stringify;
  try { action(); } finally { JSON.stringify = stringify; }
  return count;
}

void test("Trajectory encodes only the newest state for a backpressured browser once it drains", async () => {
  const root = await mkdtemp(join(tmpdir(), "trajectory-server-backpressure-"));
  const port = await availablePort();
  const server = createTrajectoryServer(port, join(root, "trajectory.lock"));
  const sides = serverSockets(server);
  await listen(server, port);
  const origin = `http://127.0.0.1:${String(port)}`;
  const publisher = await handshake(port, origin);
  const browser = await handshake(port, origin);
  try {
    const [publisherSide, browserSide] = sides;
    assert.ok(publisherSide && browserSide);
    publisherSide.emit("data", maskedFrame(JSON.stringify({ type: "publisher:attach", publisherId: "pub" })));
    browser.socket.write(maskedFrame(JSON.stringify({ type: "ui:attach" })));
    await readJsonFrame(browser.socket);
    backpressureNextWrite(browserSide);
    publisher.socket.write(maskedFrame(publisherState("pub", "", [], "full")));
    assert.equal(stateTitle(await readJsonFrame(browser.socket, (value) => stateTitle(value) !== undefined)), "full");
    const updates = ["one", "two", "latest"].map((title) => maskedFrame(publisherState("pub", "", [], title)));
    assert.equal(countSerializations(() => { for (const update of updates) publisherSide.emit("data", update); }), 0);
    browserSide.emit("drain");
    assert.equal(stateTitle(await readJsonFrame(browser.socket)), "latest");
    publisher.socket.write(maskedFrame(publisherState("pub", "", [], "after")));
    assert.equal(stateTitle(await readJsonFrame(browser.socket)), "after");
  } finally {
    publisher.socket.destroy();
    browser.socket.destroy();
    server.closeAllConnections();
    server.close();
    server.unref();
    await rm(root, { recursive: true, force: true });
  }
});

void test("Trajectory marks focused timing delivered only for the state a backpressured browser receives", async () => {
  const root = await mkdtemp(join(tmpdir(), "trajectory-server-backpressure-timing-"));
  const port = await availablePort();
  const server = createTrajectoryServer(port, join(root, "trajectory.lock"));
  const sides = serverSockets(server);
  await listen(server, port);
  const origin = `http://127.0.0.1:${String(port)}`;
  const publisher = await handshake(port, origin);
  const browser = await handshake(port, origin);
  try {
    const [publisherSide, browserSide] = sides;
    assert.ok(publisherSide && browserSide);
    publisherSide.emit("data", maskedFrame(JSON.stringify({ type: "publisher:attach", publisherId: "pub" })));
    browser.socket.write(maskedFrame(JSON.stringify({ type: "ui:attach" })));
    await readJsonFrame(browser.socket);
    publisher.socket.write(maskedFrame(timingState("pub", 7, 3)));
    await readJsonFrame(browser.socket);
    browser.socket.write(maskedFrame(JSON.stringify({ type: "ui:focus", publisherId: "pub", runId: "focused" })));
    assert.equal(focusedTranscript(stateFrame(await readJsonFrame(browser.socket)), "focused").timing?.length, 3);

    // Revision 8 and the focus switch are replaced while the socket is full, so neither may count as delivered.
    backpressureNextWrite(browserSide);
    publisher.socket.write(maskedFrame(timingState("pub", 7, 3)));
    assert.equal(focusedTranscript(stateFrame(await readJsonFrame(browser.socket)), "focused").timing, undefined);
    const pending = [maskedFrame(timingState("pub", 8, 4)), maskedFrame(JSON.stringify({ type: "ui:focus", publisherId: "pub", runId: "other" }))];
    assert.equal(countSerializations(() => {
      publisherSide.emit("data", pending[0]);
      browserSide.emit("data", pending[1]);
    }), 0);
    browserSide.emit("drain");
    const drained = stateFrame(await readJsonFrame(browser.socket));
    assert.equal(focusedTranscript(drained, "other").timing?.length, 4);
    assert.deepEqual(focusedTranscript(drained, "focused").timing, []);

    backpressureNextWrite(browserSide);
    publisher.socket.write(maskedFrame(timingState("pub", 8, 4)));
    assert.equal(focusedTranscript(stateFrame(await readJsonFrame(browser.socket)), "other").timing, undefined);
    const refocus = [maskedFrame(JSON.stringify({ type: "ui:focus", publisherId: "pub", runId: "focused" })), maskedFrame(timingState("pub", 9, 5))];
    assert.equal(countSerializations(() => {
      browserSide.emit("data", refocus[0]);
      publisherSide.emit("data", refocus[1]);
      publisherSide.emit("data", refocus[1]);
    }), 0);
    browserSide.emit("drain");
    const refocused = stateFrame(await readJsonFrame(browser.socket));
    assert.equal(focusedTranscript(refocused, "focused").revision, 9);
    assert.equal(focusedTranscript(refocused, "focused").timing?.length, 5);
    publisher.socket.write(maskedFrame(timingState("pub", 9, 5)));
    assert.equal(focusedTranscript(stateFrame(await readJsonFrame(browser.socket)), "focused").timing, undefined);
  } finally {
    publisher.socket.destroy();
    browser.socket.destroy();
    server.closeAllConnections();
    server.close();
    server.unref();
    await rm(root, { recursive: true, force: true });
  }
});

/** Counts serializations of each publisher's state by its id. */
function countPublisherEncodes(ids: readonly string[], action: () => void): Record<string, number> {
  const stringify = JSON.stringify;
  const counts = Object.fromEntries(ids.map((id) => [id, 0]));
  JSON.stringify = ((...args: Parameters<typeof JSON.stringify>) => {
    const result = stringify(...args);
    for (const id of ids) if (typeof result === "string" && result.includes(`"id":"${id}"`)) counts[id] = (counts[id] ?? 0) + 1;
    return result;
  }) as typeof JSON.stringify;
  try { action(); } finally { JSON.stringify = stringify; }
  return counts;
}
function titledTimingState(id: string, revision: number, title: string): Buffer {
  const value = JSON.parse(timingState(id, revision, 3)) as { publisher: Record<string, unknown> };
  value.publisher.title = title;
  return maskedFrame(JSON.stringify(value));
}
function publisherTranscript(frame: unknown, publisherId: string, runId: string): { revision: number; timing?: unknown[] } {
  const publisher = stateFrame(frame).publishers.find((candidate) => candidate.id === publisherId);
  const run = publisher?.runs.find((candidate) => candidate.run.id === runId);
  assert.ok(run);
  return run.transcripts.agent;
}
function hasTitle(publisherId: string, title: string): (value: unknown) => boolean {
  return (value) => Boolean(value && typeof value === "object" && (value as { type?: unknown }).type === "state" && (value as { publishers: { id?: unknown; title?: unknown }[] }).publishers.some((publisher) => publisher.id === publisherId && publisher.title === title));
}

void test("Trajectory serializes an unchanged publisher once for every browser and update", async () => {
  const root = await mkdtemp(join(tmpdir(), "trajectory-server-publisher-cache-"));
  const port = await availablePort();
  const server = createTrajectoryServer(port, join(root, "trajectory.lock"));
  const sides = serverSockets(server);
  await listen(server, port);
  const origin = `http://127.0.0.1:${String(port)}`;
  const clients = [];
  try {
    for (let index = 0; index < 5; index += 1) clients.push(await handshake(port, origin));
    const [aSide, bSide, focusedSide, secondSide, legacySide] = sides;
    assert.ok(aSide && bSide && focusedSide && secondSide && legacySide);
    const [, , focused, second, legacy] = clients.map(({ socket }) => socket);
    assert.ok(focused && second && legacy);
    aSide.emit("data", maskedFrame(JSON.stringify({ type: "publisher:attach", publisherId: "pubA" })));
    bSide.emit("data", maskedFrame(JSON.stringify({ type: "publisher:attach", publisherId: "pubB" })));
    for (const side of [focusedSide, secondSide, legacySide]) side.emit("data", maskedFrame(JSON.stringify({ type: "ui:attach" })));
    for (const side of [focusedSide, secondSide]) side.emit("data", maskedFrame(JSON.stringify({ type: "ui:focus", publisherId: "pubA", runId: "focused" })));
    aSide.emit("data", titledTimingState("pubA", 7, "A-7"));
    bSide.emit("data", titledTimingState("pubB", 1, "B-1"));

    // Two focused browsers and one legacy browser watch three changes of A; unchanged B is not serialized again.
    const aUpdates = [titledTimingState("pubA", 8, "A-8"), titledTimingState("pubA", 9, "A-9"), titledTimingState("pubA", 9, "A-9b")];
    assert.equal(countPublisherEncodes(["pubB"], () => { for (const update of aUpdates) aSide.emit("data", update); }).pubB, 0);
    // A focused browser that already holds A's timing reuses A; B is serialized once for focused and once for legacy browsers.
    const bUpdate = titledTimingState("pubB", 2, "B-2");
    assert.deepEqual(countPublisherEncodes(["pubA", "pubB"], () => { bSide.emit("data", bUpdate); }), { pubA: 0, pubB: 2 });

    // Every read starts before the frames arrive, because an unread socket drops them.
    const [focusedLatest, secondLatest, legacyLatest] = await Promise.all([focused, second, legacy].map((socket) => readJsonFrame(socket, hasTitle("pubB", "B-2"))));
    for (const latest of [focusedLatest, secondLatest]) {
      assert.equal(publisherTranscript(latest, "pubA", "focused").revision, 9);
      assert.equal(publisherTranscript(latest, "pubA", "focused").timing, undefined);
      assert.deepEqual(publisherTranscript(latest, "pubA", "other").timing, []);
      assert.deepEqual(publisherTranscript(latest, "pubB", "focused").timing, []);
    }
    assert.equal(publisherTranscript(legacyLatest, "pubA", "focused").timing?.length, 3);
    assert.equal(publisherTranscript(legacyLatest, "pubB", "focused").timing?.length, 3);

    focusedSide.emit("data", maskedFrame(JSON.stringify({ type: "ui:focus", publisherId: "pubB", runId: "focused" })));
    const switched = await readJsonFrame(focused, hasTitle("pubB", "B-2"));
    assert.equal(publisherTranscript(switched, "pubB", "focused").timing?.length, 3);
    assert.deepEqual(publisherTranscript(switched, "pubA", "focused").timing, []);
    // Refocusing starts a new delivery record, so A's timing ships again instead of a reused copy that omits it.
    focusedSide.emit("data", maskedFrame(JSON.stringify({ type: "ui:focus", publisherId: "pubA", runId: "focused" })));
    const refocused = await readJsonFrame(focused, hasTitle("pubB", "B-2"));
    assert.equal(publisherTranscript(refocused, "pubA", "focused").timing?.length, 3);
    assert.deepEqual(publisherTranscript(refocused, "pubB", "focused").timing, []);
  } finally {
    for (const { socket } of clients) socket.destroy();
    server.closeAllConnections();
    server.close();
    server.unref();
    await rm(root, { recursive: true, force: true });
  }
});

/** Decodes every frame a client socket receives from now on, so no frame is lost between reads. */
function collectFrames(socket: Socket): unknown[] {
  const frames: unknown[] = [];
  let buffer = Buffer.alloc(0);
  socket.on("data", (chunk: Buffer) => {
    buffer = Buffer.concat([buffer, chunk]);
    for (let decoded = decodeTextFrame(buffer); decoded; decoded = decodeTextFrame(buffer)) { buffer = buffer.subarray(decoded.consumed); frames.push(JSON.parse(decoded.payload)); }
  });
  return frames;
}
async function until(condition: () => boolean, label: string): Promise<void> {
  const deadline = Date.now() + 2000;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}`);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}
const viewerCounts = (frames: readonly unknown[]): number[] => frames.filter(isViewerFrame).map((frame) => (frame as { count: number }).count);
const stateTitles = (frames: readonly unknown[]): string[] => frames.flatMap((frame) => stateTitle(frame) ?? []);

void test("Trajectory sends no state to a hidden browser, counts only visible viewers, and resumes it with the latest focused state", async () => {
  const root = await mkdtemp(join(tmpdir(), "trajectory-server-hidden-"));
  const port = await availablePort();
  const server = createTrajectoryServer(port, join(root, "trajectory.lock"));
  const sides = serverSockets(server);
  await listen(server, port);
  const origin = `http://127.0.0.1:${String(port)}`;
  const clients = [];
  try {
    for (let index = 0; index < 4; index += 1) clients.push(await handshake(port, origin));
    const [publisherSide, visibleSide, hiddenSide, legacySide] = sides;
    assert.ok(publisherSide && visibleSide && hiddenSide && legacySide);
    const [publisher, visible, hidden, legacy] = clients.map(({ socket }) => collectFrames(socket));
    assert.ok(publisher && visible && hidden && legacy);
    publisherSide.emit("data", maskedFrame(JSON.stringify({ type: "publisher:attach", publisherId: "pub" })));
    for (const side of [visibleSide, hiddenSide, legacySide]) side.emit("data", maskedFrame(JSON.stringify({ type: "ui:attach" })));
    visibleSide.emit("data", maskedFrame(JSON.stringify({ type: "ui:focus", publisherId: "pub", runId: "focused", visible: true })));
    hiddenSide.emit("data", maskedFrame(JSON.stringify({ type: "ui:focus", publisherId: null, runId: null, visible: false })));
    publisherSide.emit("data", titledTimingState("pub", 7, "S1"));
    await until(() => stateTitles(visible).includes("S1") && stateTitles(legacy).includes("S1"), "visible and legacy browsers to receive S1");
    // The hidden browser's transcript reply is written after any state it was sent, so its arrival proves no state was.
    hiddenSide.emit("data", maskedFrame(JSON.stringify({ type: "ui:transcript", requestId: "hidden-request", publisherId: "pub", runId: "focused", agentId: "agent", revision: 7 })));
    await until(() => publisher.some((frame) => (frame as { type?: unknown }).type === "publisher:transcript"), "the transcript request to reach the publisher");
    const request = publisher.find((frame) => (frame as { type?: unknown }).type === "publisher:transcript") as { requestId: string };
    publisherSide.emit("data", maskedFrame(JSON.stringify({ type: "publisher:transcript-result", requestId: request.requestId, publisherId: "pub", runId: "focused", agentId: "agent", requestedRevision: 7, ok: true, status: "available", revision: 7, entries: [] })));
    await until(() => hidden.some((frame) => (frame as { type?: unknown }).type === "transcript"), "the hidden browser's transcript reply");
    assert.deepEqual(stateTitles(hidden), []);
    assert.deepEqual(viewerCounts(publisher), [0, 1, 2, 3, 2]);

    hiddenSide.emit("data", maskedFrame(JSON.stringify({ type: "ui:focus", publisherId: "pub", runId: "focused", visible: true })));
    await until(() => stateTitles(hidden).includes("S1"), "the resumed browser to receive S1");
    const resumed = hidden.find((frame) => stateTitle(frame) === "S1");
    assert.equal(publisherTranscript(resumed, "pub", "focused").timing?.length, 3);
    await until(() => viewerCounts(publisher).length === 6, "the visible viewer count");
    assert.equal(viewerCounts(publisher).at(-1), 3);
  } finally {
    for (const { socket } of clients) socket.destroy();
    server.closeAllConnections();
    server.close();
    server.unref();
    await rm(root, { recursive: true, force: true });
  }
});

import assert from "node:assert/strict";
import test from "node:test";
import type { ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import workflowExtension, { widgetAgentsOpener } from "../src/host.js";
import { createLaunchSnapshot, DEFAULT_SETTINGS, RunStore } from "../src/index.js";
import { WORKFLOW_RUN_STARTED_EVENT } from "../src/types.js";
import { testExtensionApi } from "./support.js";

const context = (mode: string, session: string, command: boolean): ExtensionCommandContext => ({ mode, hasUI: true, sessionManager: { getSessionId: () => session }, ...(command ? { waitForIdle: async () => {} } : {}) }) as unknown as ExtensionCommandContext;

void test("the widget's opener hands the node key to the workspace on a command context", () => {
  const seen: Array<[ExtensionContext, string]> = [];
  const command = context("tui", "s1", true);
  const opener = widgetAgentsOpener(async (ctx, key) => { seen.push([ctx, key]); }, () => undefined);
  assert.equal(opener.available(command), true);
  opener.open(command, "run:r1:node:phase/p%231");
  assert.deepEqual(seen, [[command, "run:r1:node:phase/p%231"]]);
});

void test("a plain session context uses the remembered command context of the same session, else does nothing", () => {
  const seen: ExtensionContext[] = [];
  const last = context("tui", "s1", true);
  const remembered: { ctx?: ExtensionCommandContext } = {};
  const opener = widgetAgentsOpener(async (ctx) => { seen.push(ctx); }, () => remembered.ctx);
  const plain = context("tui", "s1", false);
  assert.equal(opener.available(plain), false);
  remembered.ctx = last;
  assert.equal(opener.available(plain), true);
  opener.open(plain, "run:r1");
  assert.deepEqual(seen, [last]);
  // The command has returned; the host keeps its context, so a plain widget context of the same session still opens the workspace.
  assert.equal(opener.available(plain), true, "a settled command's context stays usable in the same session");
  opener.open(plain, "run:r1:agent1");
  assert.deepEqual(seen, [last, last]);
  assert.equal(opener.available(context("tui", "s2", false)), false, "another session's context is never used");
  assert.equal(opener.available(context("print", "s1", true)), false, "and nothing opens outside the TUI");
});

void test("two hosts each resolve only their own remembered command context, by session", () => {
  const seenA: ExtensionContext[] = [];
  const seenB: ExtensionContext[] = [];
  const lastA = context("tui", "s1", true);
  const lastB = context("tui", "s2", true);
  const openerA = widgetAgentsOpener(async (ctx) => { seenA.push(ctx); }, () => lastA);
  const openerB = widgetAgentsOpener(async (ctx) => { seenB.push(ctx); }, () => lastB);
  const plain1 = context("tui", "s1", false);
  const plain2 = context("tui", "s2", false);
  assert.equal(openerA.available(plain1), true);
  assert.equal(openerA.available(plain2), false, "host A never uses its context for B's session");
  assert.equal(openerB.available(plain2), true);
  assert.equal(openerB.available(plain1), false, "nor B for A's");
  openerA.open(plain2, "run:r1");
  openerB.open(plain1, "run:r1");
  openerA.open(plain1, "run:r1");
  openerB.open(plain2, "run:r1");
  assert.deepEqual(seenA, [lastA]);
  assert.deepEqual(seenB, [lastB]);
});

void test("a remembered command context that Pi has invalidated is not usable", () => {
  const stale = { mode: "tui", hasUI: true, waitForIdle: async () => {}, sessionManager: { getSessionId: () => { throw new Error("stale"); } } } as unknown as ExtensionCommandContext;
  const opener = widgetAgentsOpener(async () => { throw new Error("must not open"); }, () => stale);
  const plain = context("tui", "s1", false);
  assert.equal(opener.available(plain), false);
  opener.open(plain, "run:r1");
});

void test("the host keeps the command context after /agents returns, so the widget's Enter opens the workspace on the row, until the session shuts down", async () => {
  const home = mkdtempSync(join(tmpdir(), "pi-extensible-workflows-widget-opener-"));
  try {
    const cwd = join(home, "project");
    mkdirSync(cwd);
    const model = { provider: "openai", model: "gpt" };
    const agents = [{ id: "a1", name: "scout", path: "a1", state: "running", model, tools: [], attempts: 1, attemptDetails: [] }];
    const phaseHistory = Array.from({ length: 10 }, (_, index) => ({ phase: `p${String(index)}`, afterAgent: index === 0 ? 0 : 1 }));
    const snapshot = createLaunchSnapshot({ script: "return true", args: null, metadata: { name: "widget" }, settings: DEFAULT_SETTINGS, models: ["openai/gpt"], tools: [], agentConfigurations: {}, schemas: [] });
    const store = new RunStore(cwd, "session", "run", home);
    await store.create({ id: "run", workflowName: "widget", cwd, sessionId: "session", state: "running", agents, agentSessions: [], phaseHistory } as never, snapshot);

    const commands = new Map<string, (args: string, ctx: unknown) => Promise<void>>();
    const handlers = new Map<string, Array<(event: unknown, ctx: unknown) => unknown>>();
    const listeners = new Map<string, Array<(event: unknown) => void>>();
    const opened: Array<string | undefined> = [];
    workflowExtension(testExtensionApi({
      registerCommand(name: string, options: { handler: (args: string, ctx: unknown) => Promise<void> }) { commands.set(name, options.handler); },
      registerTool() {},
      on(name: string, handler: unknown) { handlers.set(name, [...(handlers.get(name) ?? []), handler as (event: unknown, ctx: unknown) => unknown]); },
      registerEntryRenderer() {},
      registerShortcut() {},
      events: {
        on: ((name: string, listener: (event: unknown) => void) => { listeners.set(name, [...(listeners.get(name) ?? []), listener]); return () => {}; }),
        emit: ((name: string, event: unknown) => { for (const listener of listeners.get(name) ?? []) listener(event); }),
      },
    }), home, undefined, undefined, join(home, "agent"), [], async (_ctx, options) => { opened.push(options.initialKey); return undefined; });

    const inputs: Array<(data: string) => { consume?: boolean } | undefined> = [];
    const ui = {
      notify() {},
      // Pi draws a widget factory when it paints and again on each render request; the widget learns its rows from those draws.
      setWidget(_key: string, value: unknown) {
        if (typeof value !== "function") return;
        const tui = { requestRender: () => { component.render(100); } };
        const component = (value as (tui: object, theme: object) => { render(width: number): string[] })(tui, { fg: (_c: string, t: string) => t, bold: (t: string) => t, bg: (_c: string, t: string) => t });
        component.render(100);
      },
      onTerminalInput: (handler: (data: string) => { consume?: boolean } | undefined) => { inputs.push(handler); return () => {}; },
    };
    const session = { cwd, mode: "tui", hasUI: true, sessionManager: { getSessionId: () => "session", getEntries: () => [] }, ui };
    const key = (data: string): boolean => inputs.some((handler) => handler(data)?.consume === true);
    for (const handler of handlers.get("session_start") ?? []) await handler(undefined, session);
    const directory = store.directory;
    const emit = (name: string, event: unknown): void => { for (const listener of listeners.get(name) ?? []) listener(event); };
    emit(WORKFLOW_RUN_STARTED_EVENT, { runId: "run", runDirectory: directory, sessionId: "session" });

    assert.ok(inputs.length > 0, 'the widget installed its terminal-input listener');
    // Before any workspace command ran, the plain session context has nothing to open with.
    key("\u001bo");
    key("\r");
    assert.deepEqual(opened, []);

    // /agents returns; its context is what the widget opens with afterwards.
    await commands.get("agents")?.("", { ...session, waitForIdle: async () => {} });
    assert.deepEqual(opened, [undefined]);
    key("\u001bo");
    key("\r");
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.deepEqual(opened, [undefined, "run:run"]);

    for (const handler of handlers.get("session_shutdown") ?? []) await handler(undefined, session);
    emit(WORKFLOW_RUN_STARTED_EVENT, { runId: "run", runDirectory: directory, sessionId: "session" });
    key("\u001bo");
    key("\r");
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(opened.length, 2, "after the session ends Enter opens nothing");
  } finally { rmSync(home, { recursive: true, force: true }); }
});

/** A workflow host over its own home with a running run in `sessionId`, whose widget listens for keys; `opened` records the initial key of each workspace it opens. */
async function widgetHost(sessionId: string): Promise<{ command: (ctx: object) => Promise<void>; session: object; key: (data: string) => boolean; cleanup: () => void; opened: Array<string | undefined> }> {
  const home = mkdtempSync(join(tmpdir(), "pi-extensible-workflows-widget-hosts-"));
  const cwd = join(home, "project");
  mkdirSync(cwd);
  const model = { provider: "openai", model: "gpt" };
  const agents = [{ id: "a1", name: "scout", path: "a1", state: "running", model, tools: [], attempts: 1, attemptDetails: [] }];
  const snapshot = createLaunchSnapshot({ script: "return true", args: null, metadata: { name: "widget" }, settings: DEFAULT_SETTINGS, models: ["openai/gpt"], tools: [], agentConfigurations: {}, schemas: [] });
  const phaseHistory = Array.from({ length: 10 }, (_, index) => ({ phase: `p${String(index)}`, afterAgent: index === 0 ? 0 : 1 }));
  const store = new RunStore(cwd, sessionId, "run", home);
  await store.create({ id: "run", workflowName: "widget", cwd, sessionId, state: "running", agents, agentSessions: [], phaseHistory } as never, snapshot);
  const commands = new Map<string, (args: string, ctx: unknown) => Promise<void>>();
  const handlers = new Map<string, Array<(event: unknown, ctx: unknown) => unknown>>();
  const listeners = new Map<string, Array<(event: unknown) => void>>();
  const opened: Array<string | undefined> = [];
  workflowExtension(testExtensionApi({
    registerCommand(name: string, options: { handler: (args: string, ctx: unknown) => Promise<void> }) { commands.set(name, options.handler); },
    registerTool() {},
    on(name: string, handler: unknown) { handlers.set(name, [...(handlers.get(name) ?? []), handler as (event: unknown, ctx: unknown) => unknown]); },
    registerEntryRenderer() {},
    registerShortcut() {},
    events: {
      on: ((name: string, listener: (event: unknown) => void) => { listeners.set(name, [...(listeners.get(name) ?? []), listener]); return () => {}; }),
      emit: ((name: string, event: unknown) => { for (const listener of listeners.get(name) ?? []) listener(event); }),
    },
  }), home, undefined, undefined, join(home, "agent"), [], async (_ctx, options) => { opened.push(options.initialKey); return undefined; });
  const inputs: Array<(data: string) => { consume?: boolean } | undefined> = [];
  const ui = {
    notify() {},
    setWidget(_key: string, value: unknown) {
      if (typeof value !== "function") return;
      const tui = { requestRender: () => { component.render(100); } };
      const component = (value as (tui: object, theme: object) => { render(width: number): string[] })(tui, { fg: (_c: string, t: string) => t, bold: (t: string) => t, bg: (_c: string, t: string) => t });
      component.render(100);
    },
    onTerminalInput: (handler: (data: string) => { consume?: boolean } | undefined) => { inputs.push(handler); return () => {}; },
  };
  const session = { cwd, mode: "tui", hasUI: true, sessionManager: { getSessionId: () => sessionId, getEntries: () => [] }, ui };
  for (const handler of handlers.get("session_start") ?? []) await handler(undefined, session);
  for (const listener of listeners.get(WORKFLOW_RUN_STARTED_EVENT) ?? []) listener({ runId: "run", runDirectory: store.directory, sessionId });
  const agentsCommand = commands.get("agents");
  assert.ok(agentsCommand);
  return {
    command: (ctx) => agentsCommand("", { ...session, ...ctx }),
    session,
    key: (data) => inputs.some((handler) => handler(data)?.consume === true),
    cleanup: () => { rmSync(home, { recursive: true, force: true }); },
    opened,
  };
}

void test("two hosts keep their own command context: a widget opens the workspace only on the context its host remembered, in its own session", async () => {
  const a = await widgetHost("session-a");
  const b = await widgetHost("session-b");
  try {
    // Only host A ran /agents.
    await a.command({ waitForIdle: async () => {} });
    assert.deepEqual(a.opened, [undefined]);
    for (const host of [a, b]) { host.key("\u001bo"); host.key("\r"); }
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.deepEqual(a.opened, [undefined, "run:run"], "host A's widget opens on its remembered context");
    assert.deepEqual(b.opened, [], "host B remembered nothing: A's context is not used for it");
  } finally { a.cleanup(); b.cleanup(); }
});

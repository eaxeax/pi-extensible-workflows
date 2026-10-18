import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after } from "node:test";
import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import type { ActionUi, AgentsActionProvider, AgentsActionTarget, SubagentPresenter, SubagentsHandle } from "../src/agents-actions-contract.js";
import { runAgentsWorkspace, type AgentsWorkspaceLoop } from "../src/agents-command.js";
import type { AgentsWorkspaceExit, AgentsWorkspaceOptions, AgentsWorkspaceState, OpenAgentsWorkspace, SessionTreeNode } from "../src/agents-workspace-contract.js";
import workflowExtension from "../src/host.js";
import { createLaunchSnapshot, DEFAULT_SETTINGS, RunStore, type AgentRecord } from "../src/index.js";
import { clearSubagentsHandle, setSubagentsHandle } from "../src/subagent-actions-handle.js";
import { clearSubagentManager, setSubagentManager } from "../src/subagent-manager-handle.js";
import type { SubagentManager } from "../subagents/src/contracts.js";
import { executeCommand, testExtensionApi } from "./support.js";

/** The key every bundle's copy of src/agents-command.ts guards its loop with. */
const LOOP_KEY = Symbol.for("pi-extensible-workflows.agents-workspace-loop");
const RUN: AgentsActionTarget = { kind: "run", runId: "R" };
const SUBAGENT: AgentsActionTarget = { kind: "subagent", id: "s" };
function stateOf(selectedKey: string, overrides: Partial<AgentsWorkspaceState> = {}): AgentsWorkspaceState {
  return { selectedKey, row: 2, expansion: [["run:R", false]], focus: "transcript", sidebarVisible: true, toolsExpanded: true, detailsShown: true, ...overrides };
}
function exitOf(label: string, target: AgentsActionTarget = RUN, state: AgentsWorkspaceState = stateOf("run:R")): AgentsWorkspaceExit { return { target, label, state }; }
const NODE: SessionTreeNode = { key: "run:R", parentKey: undefined, depth: 0, kind: "run", initiallyExpanded: true, line: () => "Workflow", details: () => [], title: () => "Workflow", agent: undefined, target: RUN };

function tick(): Promise<void> { return new Promise((resolve) => { setImmediate(resolve); }); }
async function settle(): Promise<void> { for (let round = 0; round < 10; round += 1) await tick(); }

/** Offers `offers(target)` now; `perform` runs a label, after it is recorded as `<kind>:<label>`. */
class FakeProvider implements AgentsActionProvider {
  readonly runs: string[] = [];
  constructor(private readonly offers: (target: AgentsActionTarget) => readonly string[], private readonly perform: (label: string, ui: ActionUi) => Promise<{ readonly select?: string }> = async () => ({})) {}
  async actions(target: AgentsActionTarget): Promise<readonly { readonly label: string }[]> { return this.offers(target).map((label) => ({ label })); }
  async run(target: AgentsActionTarget, label: string, ui: ActionUi): Promise<{ readonly select?: string }> {
    this.runs.push(`${target.kind}:${label}`);
    return this.perform(label, ui);
  }
}
/** An ActionUi factory whose notify and status calls are recorded in `calls`; notify also goes to the loop's onNotify. */
function recordingUi(calls: string[]): AgentsWorkspaceLoop["actionUi"] {
  return (onNotify) => ({
    notify(message, level) { calls.push(`notify:${message}`); onNotify(message, level); },
    confirm: async () => false,
    select: async () => undefined,
    input: async () => undefined,
    editText: async () => undefined,
    reviewCheckpoint: async () => undefined,
    openArtifact: async () => {},
    status(text) { calls.push(`status:${String(text)}`); },
    setWorkingMessage() {},
  });
}
/** A workspace that resolves each open with the next of `exits` (a function is awaited first), recording the options and "open" in `calls`. */
function opener(exits: (AgentsWorkspaceExit | undefined | (() => Promise<AgentsWorkspaceExit | undefined>))[], calls: string[] = []): { readonly open: OpenAgentsWorkspace; readonly opens: AgentsWorkspaceOptions[] } {
  const opens: AgentsWorkspaceOptions[] = [];
  return {
    opens,
    open: async (_ctx, options) => {
      opens.push(options);
      calls.push("open");
      const next = exits.shift();
      return typeof next === "function" ? next() : next;
    },
  };
}
function commandContext(notices: string[], signal?: AbortSignal): ExtensionCommandContext {
  return { cwd: "/project", signal, ui: { notify(message: string) { notices.push(message); } } } as unknown as ExtensionCommandContext;
}
/** The loop over `open` with a source listing `lists` in turn (an error rejects that list; the last one repeats). */
function loopOf(open: OpenAgentsWorkspace, providers: readonly AgentsActionProvider[], calls: string[], overrides: Partial<AgentsWorkspaceLoop> = {}, lists: (readonly SessionTreeNode[] | Error)[] = [[NODE]]): AgentsWorkspaceLoop & { readonly listed: () => number } {
  let listed = 0;
  const pending = [...lists];
  return {
    open,
    options: {
      agents: { list: async () => { listed += 1; const next = pending.length > 1 ? pending.shift() : pending[0]; if (next instanceof Error) throw next; return next ?? []; } },
      openSource: () => { throw new Error("unexpected openSource"); },
      createView: () => { throw new Error("unexpected createView"); },
      pollIntervalMs: 250,
      editorCommand: () => "vi",
    },
    providers,
    actionUi: recordingUi(calls),
    hasContent: (nodes) => nodes.length > 0,
    onEmpty: () => { calls.push("empty"); },
    listed: () => listed,
    ...overrides,
  };
}

void test("an action goes to the first provider that offers its label now; none: the notice that it is no longer available", async () => {
  const calls: string[] = [];
  const unreadable: AgentsActionProvider = { actions: () => Promise.reject(new Error("unreadable")), run: () => Promise.reject(new Error("unexpected run")) };
  const first = new FakeProvider((target) => target.kind === "run" ? ["Stop"] : []);
  const second = new FakeProvider((target) => target.kind === "run" ? ["Stop", "Pause"] : target.kind === "subagent" ? ["Retry"] : []);
  const { open, opens } = opener([exitOf("Stop"), exitOf("Retry", SUBAGENT), exitOf("Pause"), exitOf("Gone"), undefined]);
  const providers = [unreadable, first, second];
  const notices: string[] = [];
  await runAgentsWorkspace(commandContext(notices), loopOf(open, providers, calls));
  assert.deepEqual(first.runs, ["run:Stop"], "the first that offers it, past one that cannot be read");
  assert.deepEqual(second.runs, ["subagent:Retry", "run:Pause"]);
  assert.deepEqual(calls.filter((call) => call.startsWith("notify:")), ["notify:Gone is no longer available."]);
  assert.equal(opens.length, 5);
  assert.deepEqual(opens.map((options) => options.notices ?? []), [[], [], [], [], ["Gone is no longer available."]]);
  assert.ok(opens.every((options) => options.actions === providers), "every open gets the providers");
  assert.deepEqual(notices, [], "the loop itself shows nothing through Pi");
});

void test("the workspace opens again with the exit's state, the action's select as its initial key and the action's notices", async () => {
  const calls: string[] = [];
  const provider = new FakeProvider(() => ["Retry", "Pause"], async (label, ui) => {
    if (label === "Retry") { ui.notify("Retried subagent s as t.", "info"); return { select: "subagent:t" }; }
    ui.notify("Paused workflow W.");
    ui.notify("Cannot pause twice.", "warning");
    return {};
  });
  const retried = stateOf("subagent:s", { focus: "sidebar" });
  const paused = stateOf("subagent:t", { detailsShown: false });
  const { open, opens } = opener([exitOf("Retry", SUBAGENT, retried), exitOf("Pause", RUN, paused), undefined], calls);
  const loop = loopOf(open, [provider], calls, { initialKey: "run:R:a" });
  await runAgentsWorkspace(commandContext([]), loop);
  assert.equal(opens.length, 3);
  const [first, second, third] = opens;
  assert.ok(first && second && third);
  assert.equal(first.initialKey, "run:R:a");
  assert.equal("state" in first, false);
  assert.equal("notices" in first, false);
  assert.equal(first.agents, loop.options.agents);
  assert.equal(first.openSource, loop.options.openSource);
  assert.equal(first.createView, loop.options.createView);
  assert.equal(first.pollIntervalMs, 250);
  assert.equal(first.editorCommand, loop.options.editorCommand);
  assert.deepEqual(second.state, retried);
  assert.equal(second.initialKey, "subagent:t", "the new run after a Retry");
  assert.deepEqual(second.notices, ["Retried subagent s as t."]);
  assert.equal(second.agents, loop.options.agents);
  assert.deepEqual(third.state, paused);
  assert.equal("initialKey" in third, false, "an action that selects nothing keeps the state's selection");
  assert.deepEqual(third.notices, ["Paused workflow W.", "Cannot pause twice."]);
  assert.deepEqual(calls, ["open", "notify:Retried subagent s as t.", "status:undefined", "open", "notify:Paused workflow W.", "notify:Cannot pause twice.", "status:undefined", "open"], "the status cleared once each action settled, before the workspace is back");
  assert.equal(loop.listed(), 3, "the source is listed before every open");
});

void test("the workspace opens again only once a pending action (a Foreground resume) settled", async () => {
  const calls: string[] = [];
  let release = (): void => {};
  const provider = new FakeProvider(() => ["Resume"], (_label, ui) => new Promise((resolve) => {
    release = () => { ui.notify("Workflow W completed."); resolve({}); };
  }));
  const { open, opens } = opener([exitOf("Resume"), undefined], calls);
  const running = runAgentsWorkspace(commandContext([]), loopOf(open, [provider], calls));
  await settle();
  assert.deepEqual(provider.runs, ["run:Resume"]);
  assert.equal(opens.length, 1, "the workspace stays closed while the run goes on");
  assert.deepEqual(calls, ["open"], "and its status stays");
  release();
  await running;
  assert.equal(opens.length, 2);
  assert.deepEqual(calls, ["open", "notify:Workflow W completed.", "status:undefined", "open"]);
  assert.deepEqual(opens[1]?.notices, ["Workflow W completed."]);
});

void test("an abort while an action runs, or while the workspace is open, opens it no more", async () => {
  const calls: string[] = [];
  const controller = new AbortController();
  let release = (): void => {};
  const provider = new FakeProvider(() => ["Resume"], () => new Promise((resolve) => { release = () => { resolve({}); }; }));
  const { open, opens } = opener([exitOf("Resume"), exitOf("Resume")], calls);
  const running = runAgentsWorkspace(commandContext([], controller.signal), loopOf(open, [provider], calls));
  await settle();
  controller.abort();
  release();
  await running;
  assert.equal(opens.length, 1, "no reopen after the abort");
  assert.deepEqual(calls, ["open", "status:undefined"], "the action's status is still cleared");

  const late = new AbortController();
  const lateCalls: string[] = [];
  const lateProvider = new FakeProvider(() => ["Resume"]);
  const lateOpen = opener([async () => { late.abort(); return exitOf("Resume"); }], lateCalls);
  await runAgentsWorkspace(commandContext([], late.signal), loopOf(lateOpen.open, [lateProvider], lateCalls));
  assert.deepEqual(lateProvider.runs, [], "an exit that comes with the abort runs nothing");
  assert.equal(lateOpen.opens.length, 1);
});

void test("a source with nothing to show calls onEmpty and opens nothing, before the first open and before reopening; a list that fails still opens", async () => {
  const calls: string[] = [];
  const provider = new FakeProvider(() => ["Delete"]);
  const { open, opens } = opener([exitOf("Delete"), exitOf("Delete")], calls);
  await runAgentsWorkspace(commandContext([]), loopOf(open, [provider], calls, {}, [[NODE], []]));
  assert.deepEqual(provider.runs, ["run:Delete"]);
  assert.equal(opens.length, 1, "the last run deleted: no reopen");
  assert.deepEqual(calls, ["open", "status:undefined", "empty"]);

  const emptyCalls: string[] = [];
  const empty = opener([undefined], emptyCalls);
  await runAgentsWorkspace(commandContext([]), loopOf(empty.open, [provider], emptyCalls, {}, [[]]));
  assert.deepEqual(emptyCalls, ["empty"], "nothing to show at first: no open");

  const failingCalls: string[] = [];
  const failing = opener([exitOf("Delete"), undefined], failingCalls);
  await runAgentsWorkspace(commandContext([]), loopOf(failing.open, [provider], failingCalls, {}, [new Error("unreadable")]));
  assert.deepEqual(failingCalls, ["open", "status:undefined", "open"], "a list that fails opens the workspace, whose title says why");
});

void test("one loop at a time across bundles: a second one says the workspace is already open and opens nothing", async () => {
  const calls: string[] = [];
  let leave = (): void => {};
  const { open, opens } = opener([() => new Promise((resolve) => { leave = () => { resolve(undefined); }; })], calls);
  const running = runAgentsWorkspace(commandContext([]), loopOf(open, [], calls));
  await settle();
  assert.equal(opens.length, 1);
  assert.equal("actions" in (opens[0] ?? {}), false, "without providers the workspace gets no actions");
  const notices: string[] = [];
  const second = opener([undefined]);
  const secondLoop = loopOf(second.open, [], []);
  await runAgentsWorkspace(commandContext(notices), secondLoop);
  assert.deepEqual(notices, ["The agents workspace is already open."]);
  assert.equal(second.opens.length, 0);
  assert.equal(secondLoop.listed(), 0, "not even listed");
  leave();
  await running;

  // Another bundle's copy of this module holds the same key.
  Reflect.set(globalThis, LOOP_KEY, true);
  const other: string[] = [];
  try { await runAgentsWorkspace(commandContext(other), loopOf(second.open, [], [])); } finally { Reflect.deleteProperty(globalThis, LOOP_KEY); }
  assert.deepEqual(other, ["The agents workspace is already open."]);
  assert.equal(second.opens.length, 0);

  // A loop that ends with a throw lets the next one run.
  const failing: OpenAgentsWorkspace = () => Promise.reject(new Error("boom"));
  await assert.rejects(runAgentsWorkspace(commandContext([]), loopOf(failing, [], [])), /boom/);
  await runAgentsWorkspace(commandContext([]), loopOf(second.open, [], []));
  assert.equal(second.opens.length, 1);
});

const snapshot = createLaunchSnapshot({ script: "return true", args: null, metadata: { name: "agents" }, settings: DEFAULT_SETTINGS, models: ["openai/gpt"], tools: [], agentConfigurations: {}, schemas: [] });
const homes: string[] = [];
after(() => { for (const home of homes) rmSync(home, { recursive: true, force: true }); });
function fixture(): { home: string; cwd: string } {
  const home = mkdtempSync(join(tmpdir(), "pi-extensible-workflows-agents-loop-"));
  homes.push(home);
  const cwd = join(home, "project");
  mkdirSync(cwd);
  return { home, cwd };
}
function agentRecord(id: string, name: string): AgentRecord {
  return { id, name, path: id, state: "completed", model: { provider: "openai", model: "gpt" }, tools: [], attempts: 1, attemptDetails: [] };
}
async function createRun(home: string, cwd: string, agents: readonly AgentRecord[]): Promise<void> {
  await new RunStore(cwd, "session", "run", home).create({ id: "run", workflowName: "agents", cwd, sessionId: "session", state: "completed", agents: [...agents], agentSessions: [] }, snapshot);
}
type Command = (args: string, ctx: unknown) => Promise<void>;
type Opened = { readonly ctx: ExtensionCommandContext; readonly options: AgentsWorkspaceOptions };
/** The workflow extension with a fake workspace that resolves each open with the next of `exits` (a function is awaited first). */
function host(home: string, exits: (AgentsWorkspaceExit | undefined | (() => Promise<AgentsWorkspaceExit | undefined>))[] = []): { agents: Command | undefined; opened: Opened[] } {
  const commands = new Map<string, Command>();
  const opened: Opened[] = [];
  workflowExtension(testExtensionApi({
    registerCommand(name: string, options: { handler: Command }) { commands.set(name, options.handler); },
    registerTool() {},
    getThinkingLevel: () => "medium",
    getActiveTools: () => ["workflow"],
  }), home, undefined, undefined, join(home, "agent"), [], async (ctx, options) => {
    opened.push({ ctx, options });
    const next = exits.shift();
    return typeof next === "function" ? next() : next;
  });
  return { agents: commands.get("agents"), opened };
}
function piContext(cwd: string, notices: string[]): object {
  return { cwd, mode: "tui", hasUI: true, sessionManager: { getSessionId: () => "session" }, ui: { notify(message: string) { notices.push(message); }, setStatus() {} } };
}
const ZERO = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 };
/** A manager that lists one completed subagent of this Pi session. */
function subagentManager(id: string): SubagentManager {
  const row = { id, sessionId: "session", state: "completed", startedAt: 1, finishedAt: 2, attempts: 1, progress: { accounting: ZERO, toolCalls: [] } };
  return {
    async run() { throw new Error("unexpected run"); },
    async inspect(request) { return request.id === undefined ? [row] : row; },
    async steer() { throw new Error("unexpected steer"); },
    async stop() { throw new Error("unexpected stop"); },
    async retry() { throw new Error("unexpected retry"); },
  };
}

void test("/agents gives the workspace the workflow provider and the published subagent provider, runs a chosen action with Pi's dialogs and opens again", async () => {
  const { home, cwd } = fixture();
  await createRun(home, cwd, [agentRecord("alpha-id", "alpha")]);
  const subagentProvider = new FakeProvider((target) => target.kind === "subagent" ? ["Steer"] : [], async (_label, ui) => { ui.notify("Steered subagent s."); return { select: "subagent:s" }; });
  const presenter: SubagentPresenter = { describe: async (ids) => new Map(ids.map((id) => [id, { name: `named ${id}`, details: () => [`details of ${id}`] }])) };
  const handed: { readonly actions: unknown[]; readonly presenter: unknown[] } = { actions: [], presenter: [] };
  const handle: SubagentsHandle = {
    actions: (ctx) => { handed.actions.push(ctx); return subagentProvider; },
    presenter: (ctx) => { handed.presenter.push(ctx); return presenter; },
  };
  const manager = subagentManager("sub-1");
  setSubagentsHandle(handle);
  setSubagentManager(manager);
  try {
    const state = stateOf("subagent:sub-1");
    const { agents, opened } = host(home, [exitOf("Steer", SUBAGENT, state), undefined]);
    const notices: string[] = [];
    await executeCommand(agents, "", piContext(cwd, notices));
    assert.equal(opened.length, 2, "opened again after the action");
    const [first, second] = opened;
    assert.ok(first && second);
    const providers = first.options.actions ?? [];
    assert.equal(providers.length, 2);
    assert.equal(providers[1], subagentProvider, "the published provider second");
    assert.deepEqual(handed.actions, [first.ctx], "made for this command context");
    const workflowLabels = (await providers[0]?.actions({ kind: "run", runId: "run" }))?.map(({ label }) => label) ?? [];
    assert.ok(workflowLabels.includes("Model aliases") && workflowLabels.includes("Delete all completed"), `the workflow provider first: ${workflowLabels.join(", ")}`);
    assert.equal(typeof first.options.editorCommand, "function", "the editor command for the in-place editors");
    assert.deepEqual(subagentProvider.runs, ["subagent:Steer"]);
    assert.deepEqual(notices, ["Steered subagent s."], "the action's notice through Pi");
    assert.deepEqual(second.options.notices, ["Steered subagent s."], "and in the status row");
    assert.deepEqual(second.options.state, state);
    assert.equal(second.options.initialKey, "subagent:s");
    const listed = await second.options.agents.list();
    assert.equal(listed.find((node) => node.key === "subagent:sub-1")?.agent?.name, "named sub-1", "the published presenter names the subagents");
    assert.ok(handed.presenter.every((ctx) => ctx === first.ctx) && handed.presenter.length > 0);
  } finally {
    clearSubagentManager(manager);
    clearSubagentsHandle(handle);
  }
});

void test("/agents without a published subagents handle gives the workspace the workflow provider only", async () => {
  const { home, cwd } = fixture();
  await createRun(home, cwd, [agentRecord("alpha-id", "alpha")]);
  const { agents, opened } = host(home);
  const notices: string[] = [];
  await executeCommand(agents, "", piContext(cwd, notices));
  assert.equal(opened.length, 1);
  const providers = opened[0]?.options.actions ?? [];
  assert.equal(providers.length, 1);
  assert.ok((await providers[0]?.actions({ kind: "run", runId: "run" }))?.some(({ label }) => label === "Model aliases"));
  assert.deepEqual(await providers[0]?.actions({ kind: "subagent", id: "sub-1" }), [], "it owns no subagent");
  assert.deepEqual(notices, []);
});

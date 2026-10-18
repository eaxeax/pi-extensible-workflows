import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after } from "node:test";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import type { AgentsWorkspaceOptions } from "../src/agents-workspace-contract.js";
import workflowExtension from "../src/host.js";
import { acquireSessionLease, createLaunchSnapshot, DEFAULT_SETTINGS, RunStore, type AgentRecord } from "../src/index.js";
import { hasLiveSessionLease } from "../src/persistence.js";
import { clearSubagentManager, setSubagentManager } from "../src/subagent-manager-handle.js";
import { PLAIN_WORKFLOW_PROGRESS_STYLES } from "../src/host-view.js";
import { createTranscriptView } from "../src/transcript-components.js";
import type { SubagentManager } from "../subagents/src/contracts.js";
import { executeCommand, testExtensionApi } from "./support.js";

type Command = (args: string, ctx: unknown) => Promise<void>;
type Opened = { readonly cwd: string; readonly options: AgentsWorkspaceOptions };

const snapshot = createLaunchSnapshot({ script: "return true", args: null, metadata: { name: "agents" }, settings: DEFAULT_SETTINGS, models: ["openai/gpt"], tools: [], agentConfigurations: {}, schemas: [] });
const homes: string[] = [];
after(() => { for (const home of homes) rmSync(home, { recursive: true, force: true }); });

function fixture(): { home: string; cwd: string } {
  const home = mkdtempSync(join(tmpdir(), "pi-extensible-workflows-agents-command-"));
  homes.push(home);
  const cwd = join(home, "project");
  mkdirSync(cwd);
  return { home, cwd };
}
/** A real pi session file with one user message. */
function piSession(home: string, text: string): { sessionId: string; file: string } {
  const manager = SessionManager.create("/repo", join(home, "sessions"));
  manager.appendMessage({ role: "user", content: [{ type: "text", text }], timestamp: Date.now() });
  const file = manager.getSessionFile();
  assert.ok(file);
  return { sessionId: manager.getSessionId(), file };
}
function agent(id: string, name: string, session?: { sessionId: string; file: string }): AgentRecord {
  const model = { provider: "openai", model: "gpt" };
  return { id, name, path: id, state: "completed", model, tools: [], attempts: 1, attemptDetails: session ? [{ attempt: 1, transport: "local", session: { transport: "local", sessionId: session.sessionId, locator: { sessionFile: session.file } }, setup: { hookNames: [], model, tools: [], cwd: "/repo" }, accounting: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 } }] : [] };
}
async function createRun(home: string, cwd: string, agents: readonly AgentRecord[], runId = "run", phases?: readonly string[]): Promise<void> {
  const launch = phases === undefined ? snapshot : createLaunchSnapshot({ script: "return true", args: null, metadata: { name: "agents" }, settings: DEFAULT_SETTINGS, models: ["openai/gpt"], tools: [], agentConfigurations: {}, phases, schemas: [] });
  await new RunStore(cwd, "session", runId, home).create({ id: runId, workflowName: "agents", cwd, sessionId: "session", state: "completed", agents: [...agents], agentSessions: [] }, launch);
}
/** The workflow extension with a fake workspace opener that records each call; the commands and the session_shutdown handler it registered. */
function host(home: string): { agents: Command | undefined; shutdown: (() => Promise<void>) | undefined; opened: Opened[] } {
  const commands = new Map<string, Command>();
  let shutdown: (() => Promise<void>) | undefined;
  const opened: Opened[] = [];
  workflowExtension(testExtensionApi({
    registerCommand(name: string, options: { handler: Command }) { commands.set(name, options.handler); },
    registerTool() {},
    on(name: string, handler: unknown) { if (name === "session_shutdown") shutdown = handler as typeof shutdown; },
    getThinkingLevel: () => "medium",
    getActiveTools: () => ["workflow"],
  }), home, undefined, undefined, join(home, "agent"), [], async (ctx, options) => { opened.push({ cwd: ctx.cwd, options }); return undefined; });
  return { agents: commands.get("agents"), shutdown, opened };
}
function context(cwd: string, mode: string, notices: string[]): object {
  return { cwd, mode, hasUI: true, sessionManager: { getSessionId: () => "session" }, ui: { notify(message: string) { notices.push(message); } } };
}

void test("/agents needs the TUI, says when the session has no agents, and opens the workspace on this session's agents", async () => {
  const { home, cwd } = fixture();
  const { agents, opened } = host(home);
  assert.ok(agents, "the host registers /agents");
  const notices: string[] = [];
  await executeCommand(agents, "", context(cwd, "rpc", notices));
  assert.deepEqual(notices, ["/agents needs the TUI."]);
  await executeCommand(agents, "", context(cwd, "tui", notices));
  assert.deepEqual(notices.slice(1), ["No agents in this session."]);
  assert.equal(opened.length, 0, "no agents: the workspace does not open");
  // A run whose tree has no agent yet (its root and declared phases only) is shown, as /workflow shows it.
  await createRun(home, cwd, [], "run-empty", ["plan"]);
  await executeCommand(agents, "", context(cwd, "tui", notices));
  assert.equal(notices.length, 2);
  assert.equal(opened.length, 1, "a run without agents: the workspace opens on it");

  const alpha = piSession(home, "ALPHA PROMPT");
  await createRun(home, cwd, [agent("alpha-id", "alpha", alpha)]);
  await executeCommand(agents, "", context(cwd, "tui", notices));
  assert.equal(notices.length, 2);
  assert.equal(opened.length, 2);
  const options = opened[1]?.options;
  assert.ok(options);
  assert.equal(opened[1]?.cwd, cwd);
  assert.equal("initialKey" in options, false, "/agents selects the first agent");
  assert.equal(options.createView, createTranscriptView);
  const listed = await options.agents.list();
  assert.ok(listed.map((entry) => entry.key).includes("run:run-empty"));
  assert.deepEqual(listed.filter((entry) => entry.key.startsWith("run:run:") || entry.key === "run:run").map((entry) => [entry.key, entry.kind]), [["run:run", "run"], ["run:run:node:phase/unassigned", "phase"], ["run:run:alpha-id", "agent"]]);
  const first = listed.find((entry) => entry.key === "run:run:alpha-id")?.agent;
  assert.ok(first);
  const source = options.openSource(first);
  try {
    const poll = await source.poll();
    assert.equal(poll.status, "available");
    assert.match(JSON.stringify(poll.appended), /ALPHA PROMPT/, "openSource reads the agent's session file");
  } finally { await source.close(); }
});

void test("/agents rejects arguments with a usage notice and opens nothing", async () => {
  const { home, cwd } = fixture();
  await createRun(home, cwd, [], "run-empty", ["plan"]);
  const { agents, opened } = host(home);
  assert.ok(agents);
  const notices: string[] = [];
  for (const mode of ["tui", "rpc"]) await executeCommand(agents, "  run-empty ", context(cwd, mode, notices));
  assert.deepEqual(notices, Array(2).fill("/agents takes no arguments. Use /agents to open the agents of this session."));
  assert.equal(opened.length, 0);
  await executeCommand(agents, "   ", context(cwd, "tui", notices));
  assert.equal(opened.length, 1, "blank arguments open the workspace as none do");
});

void test("/agents opens the workspace when the subagents cannot be listed, and the Subagents group says why", async () => {
  const { home, cwd } = fixture();
  const { agents, opened } = host(home);
  assert.ok(agents);
  const manager = { inspect: async () => { throw new Error("inspect failed"); } } as unknown as SubagentManager;
  setSubagentManager(manager);
  try {
    const notices: string[] = [];
    await executeCommand(agents, "", context(cwd, "tui", notices));
    assert.deepEqual(notices, []);
    assert.equal(opened.length, 1);
    const listed = await opened[0]?.options.agents.list();
    const group = listed?.find((node) => node.key === "subagents");
    assert.ok(group, "the Subagents group is still listed");
    assert.deepEqual(listed?.filter((node) => node.parentKey === "subagents"), [], "with no subagent under it");
    assert.match(group.details(PLAIN_WORKFLOW_PROGRESS_STYLES, Date.now()).join("\n"), /subagents unavailable: inspect failed/);
  } finally { clearSubagentManager(manager); }
});

void test("/agents takes this Pi session's lease before it lists anything, and opens nothing while another owner holds it", async () => {
  const { home, cwd } = fixture();
  await createRun(home, cwd, [agent("alpha-id", "alpha")]);
  const taken = await acquireSessionLease(cwd, "session", home);
  const blocked = host(home);
  assert.ok(blocked.agents);
  const notices: string[] = [];
  try {
    await executeCommand(blocked.agents, "", context(cwd, "tui", notices));
    assert.equal(notices.length, 1);
    assert.match(notices[0] ?? "", /^Cannot open the agents workspace: Pi session session is already owned/);
    assert.equal(blocked.opened.length, 0, "no workspace and no listing without the lease");
  } finally { await taken.release(); }

  assert.equal(await hasLiveSessionLease(cwd, "session", home), false);
  const { agents, opened, shutdown } = host(home);
  assert.ok(agents);
  await executeCommand(agents, "", context(cwd, "tui", notices));
  assert.equal(notices.length, 1, "nothing more to say");
  assert.equal(opened.length, 1);
  assert.equal(await hasLiveSessionLease(cwd, "session", home), true, "the host holds the lease while the workspace is open");
  await shutdown?.();
  assert.equal(await hasLiveSessionLease(cwd, "session", home), false, "session_shutdown releases it as before");
});

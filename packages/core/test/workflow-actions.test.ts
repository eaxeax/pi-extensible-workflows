import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import type { ActionUi, AgentsAction, AgentsActionTarget } from "../src/agents-actions-contract.js";
import type { AwaitingCheckpoint } from "../src/decoders.js";
import type { WorkflowRunRecord } from "../src/host-runtime.js";
import { RunStore, type PersistedRun } from "../src/persistence.js";
import { DEFAULT_SETTINGS } from "../src/settings.js";
import { createLaunchSnapshot } from "../src/utils.js";
import { HARD_TERMINAL_RUN_STATES, type AgentAttemptAction, type AgentRecord, type HardTerminalRunState, type RunState } from "../src/types.js";
import { workflowSettingsPath } from "../src/validation.js";
import type { WorkflowArtifact } from "../src/workflow-artifacts.js";
import { createWorkflowActionProvider, loadWorkflowRunView, runAgentAction, runWorkflowRunAction, type WorkflowActionDependencies } from "../src/workflow-actions.js";

type Level = "info" | "warning" | "error" | undefined;
type Answers = {
  confirm?: (title: string, message: string) => boolean;
  select?: (title: string, options: readonly string[]) => string | undefined;
  input?: (title: string, placeholder?: string) => string | undefined;
  review?: (checkpoint: AwaitingCheckpoint) => "Approve" | "Reject" | undefined;
};
type RecordingUi = ActionUi & {
  readonly notices: { message: string; level: Level }[];
  readonly confirms: { title: string; message: string }[];
  readonly selects: { title: string; options: readonly string[] }[];
  readonly inputs: { title: string; placeholder: string | undefined }[];
  readonly statuses: (string | undefined)[];
  readonly opened: { artifact: WorkflowArtifact; label: string }[];
  readonly reviewed: string[];
  readonly working: (string | undefined)[];
};

/** A fake ActionUi that records every call and answers from the scripted functions. */
function recordingUi(answers: Answers = {}): RecordingUi {
  const ui: RecordingUi = {
    notices: [], confirms: [], selects: [], inputs: [], statuses: [], opened: [], reviewed: [], working: [],
    notify(message, level) { ui.notices.push({ message, level }); },
    async confirm(title, message) { ui.confirms.push({ title, message }); return answers.confirm?.(title, message) ?? false; },
    async select(title, options) { ui.selects.push({ title, options }); return answers.select?.(title, options); },
    async input(title, placeholder) { ui.inputs.push({ title, placeholder }); return answers.input?.(title, placeholder); },
    async editText() { throw new Error("workflow actions never edit text"); },
    async reviewCheckpoint(checkpoint) { ui.reviewed.push(checkpoint.name); return answers.review?.(checkpoint); },
    async openArtifact(artifact, label) { ui.opened.push({ artifact, label }); },
    status(text) { ui.statuses.push(text); },
    setWorkingMessage(message) { ui.working.push(message); },
  };
  return ui;
}

const notices = (ui: RecordingUi): string[] => ui.notices.map(({ message }) => message);

type Fixture = { home: string; cwd: string; deps: WorkflowActionDependencies; copied: string[]; calls: unknown[][]; ctx: (mode: "tui" | "rpc") => ExtensionCommandContext };

function fixture(overrides: Partial<WorkflowActionDependencies> = {}): Fixture {
  const home = mkdtempSync(join(tmpdir(), "pi-extensible-workflows-workflow-actions-"));
  const cwd = join(home, "project");
  mkdirSync(cwd, { recursive: true });
  const copied: string[] = [];
  const calls: unknown[][] = [];
  const deps = {
    home,
    clipboard: async (value: string) => { copied.push(value); },
    extensionAgentDir: join(home, "agent"),
    runs: new Map<string, WorkflowRunRecord>(),
    terminalRunStates: new Map<string, HardTerminalRunState>(),
    hardTerminalRunStates: HARD_TERMINAL_RUN_STATES,
    answerCheckpoint: async (...args: unknown[]) => { calls.push(["answerCheckpoint", ...args]); return true; },
    recovery: { answerBudgetDecision: async (...args: unknown[]) => { calls.push(["answerBudgetDecision", ...args]); return { approved: args[2] === true }; } } as unknown as WorkflowActionDependencies["recovery"],
    stopWorkflowRun: async (runId: string) => { calls.push(["stopWorkflowRun", runId]); return { runId, state: "stopped", stopped: true }; },
    moveForegroundToBackground: async (runId: string) => { calls.push(["moveForegroundToBackground", runId]); return { runId, state: "running" as const, detached: true as const }; },
    isForegroundAttached: () => false,
    liveAgents: { get: () => undefined, overlay: (run: PersistedRun) => run },
    registry: { agentAttemptActions: () => ({}) } as unknown as WorkflowActionDependencies["registry"],
    projectTrusted: () => false,
    resumeHostContext: () => ({ model: undefined, modelRegistry: { getAvailable: () => [{ provider: "openai", id: "gpt" }] } }) as unknown as ReturnType<WorkflowActionDependencies["resumeHostContext"]>,
    resumeSelectedWorkflow: async (...args: unknown[]) => { calls.push(["resumeSelectedWorkflow", ...args]); return { workflowName: "wf", state: "running" as const, attached: false }; },
    ...overrides,
  } satisfies WorkflowActionDependencies;
  // Providers never touch Pi's UI: any read of ctx.ui fails the test.
  const forbiddenUi = new Proxy({}, { get(_target, key) { throw new Error(`ctx.ui.${String(key)} used by a workflow action`); } });
  const ctx = (mode: "tui" | "rpc") => ({ cwd, mode, hasUI: true, sessionManager: { getSessionId: () => "session" }, ui: forbiddenUi }) as unknown as ExtensionCommandContext;
  return { home, cwd, deps, copied, calls, ctx };
}

const snapshot = (script = "return true;") => createLaunchSnapshot({ script, args: null, metadata: { name: "wf" }, settings: DEFAULT_SETTINGS, models: ["openai/gpt"], tools: [], agentConfigurations: {}, schemas: [] });

async function createRun(f: Fixture, id: string, state: RunState, extra: Partial<PersistedRun> = {}, script?: string): Promise<RunStore> {
  const store = new RunStore(f.cwd, "session", id, f.home);
  await store.create({ id, workflowName: `${id}-name`, cwd: f.cwd, sessionId: "session", state, agents: [], agentSessions: [], ...extra }, snapshot(script));
  return store;
}

/** A live run record with the lifecycle the run actions drive. */
function liveRun(f: Fixture, store: RunStore, state: string, onPause: "pausing" | "paused" = "pausing"): { state: string } {
  const lifecycle = { state, async pause() { lifecycle.state = onPause; }, async resume() { lifecycle.state = "running"; } };
  f.deps.runs.set(store.runId, { store, metadata: { name: `${store.runId}-name` }, lifecycle, budget: { usage: { tokens: 0, costUsd: 0, durationMs: 0, agentLaunches: 0 } }, abortController: new AbortController() } as unknown as WorkflowRunRecord);
  return lifecycle;
}

const runTarget = (runId: string): AgentsActionTarget => ({ kind: "run", runId });
const labels = (actions: readonly AgentsAction[]): string[] => actions.map(({ label }) => label);
const inPlace = (actions: readonly AgentsAction[]): string[] => actions.filter((action) => action.inPlace).map(({ label }) => label);

void test("run labels follow the run state and the mode, without Refresh, Agents... or Back", async () => {
  const f = fixture();
  await createRun(f, "running", "running");
  await createRun(f, "pausing", "pausing");
  await createRun(f, "paused", "paused");
  await createRun(f, "interrupted", "interrupted");
  const exhausted = await createRun(f, "exhausted", "budget_exhausted", { agents: [{ id: "a", name: "a", path: "a", state: "completed", model: { provider: "openai", model: "gpt" }, tools: [], attempts: 1 }] });
  await exhausted.requestWorkflowDecision({ kind: "budget", proposalId: "proposal-123456789", runId: exhausted.runId, consumed: { tokens: 1, costUsd: 0, durationMs: 0, agentLaunches: 0 }, previous: { tokens: { hard: 1 } }, proposed: { tokens: { hard: 2 } }, budgetVersion: 1 });
  const waiting = await createRun(f, "waiting", "awaiting_input");
  await waiting.awaitCheckpoint({ path: "checkpoint/ship", name: "ship", prompt: "Ship?", context: null });
  await createRun(f, "done", "completed");
  const tui = createWorkflowActionProvider(f.deps, f.ctx("tui"));
  const rpc = createWorkflowActionProvider(f.deps, f.ctx("rpc"));
  const tuiTail = ["Open script in editor", "Copy run path", "Copy run ID", "Model aliases", "Delete all completed"];
  assert.deepEqual(labels(await tui.actions(runTarget("running"))), ["Pause", "Stop", ...tuiTail]);
  assert.deepEqual(labels(await rpc.actions(runTarget("running"))), ["Pause", "Stop", "Model aliases", "Delete all completed"]);
  assert.deepEqual(labels(await tui.actions(runTarget("pausing"))), ["Cancel pause", "Stop", ...tuiTail]);
  assert.deepEqual(labels(await tui.actions(runTarget("paused"))), ["Resume", "Stop", ...tuiTail]);
  assert.deepEqual(labels(await rpc.actions(runTarget("interrupted"))), ["Resume", "Stop", "Model aliases", "Delete all completed"]);
  assert.deepEqual(labels(await tui.actions(runTarget("exhausted"))), ["Resume unchanged", "Adjust budget", "Approve budget proposal", "Reject budget proposal", "Stop", ...tuiTail]);
  assert.deepEqual(labels(await rpc.actions(runTarget("exhausted"))), ["Resume unchanged", "Adjust budget", "Approve budget proposal", "Reject budget proposal", "Stop", "Model aliases", "Delete all completed"]);
  assert.deepEqual(labels(await tui.actions(runTarget("waiting"))), ["Stop", "Review ship", ...tuiTail]);
  assert.deepEqual(labels(await rpc.actions(runTarget("waiting"))), ["Stop", "Approve ship", "Reject ship", "Model aliases", "Delete all completed"]);
  assert.deepEqual(labels(await tui.actions(runTarget("done"))), ["Open script in editor", "Delete", "Copy run path", "Copy run ID", "Model aliases", "Delete all completed"]);
  assert.deepEqual(labels(await rpc.actions(runTarget("done"))), ["Delete", "Model aliases", "Delete all completed"]);
  assert.deepEqual(inPlace(await tui.actions(runTarget("done"))), ["Open script in editor", "Copy run path", "Copy run ID"]);
  assert.deepEqual(inPlace(await rpc.actions(runTarget("running"))), []);
  await createRun(f, "broken", "failed");
  assert.deepEqual(labels(await rpc.actions(runTarget("done"))), ["Delete", "Model aliases", "Delete all completed", "Delete all failed"]);
  const attached = fixture({ isForegroundAttached: (runId) => runId === "attached" });
  await createRun(attached, "attached", "running");
  assert.deepEqual(labels(await createWorkflowActionProvider(attached.deps, attached.ctx("rpc")).actions(runTarget("attached"))), ["Pause", "Move to background", "Stop", "Model aliases"]);
  assert.deepEqual(await tui.actions(runTarget("missing")), []);
  assert.deepEqual(await tui.actions({ kind: "subagent", id: "running" }), []);
  assert.deepEqual(await tui.actions({ kind: "subagents" }), []);
});

const agentRecord = (extra: Partial<AgentRecord> = {}): AgentRecord => ({
  id: "agent-1", name: "reviewer", path: "agent-1", state: "completed", model: { provider: "openai", model: "gpt" }, tools: [], attempts: 1,
  attemptDetails: [{ attempt: 1, transport: "local", session: { transport: "local", sessionId: "native", locator: { sessionFile: "/sessions/native.jsonl" } }, setup: { hookNames: [], model: { provider: "openai", model: "gpt" }, tools: [], cwd: "/repo" }, accounting: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 } }],
  ...extra,
});

async function agentFixture(actions: Readonly<Record<string, AgentAttemptAction>> = {}): Promise<{ f: Fixture; store: RunStore; branch: string; path: string }> {
  const f = fixture({ registry: { agentAttemptActions: () => actions } as unknown as WorkflowActionDependencies["registry"] });
  execFileSync("git", ["init", "-q", f.cwd]);
  execFileSync("git", ["-C", f.cwd, "config", "user.name", "test"]);
  execFileSync("git", ["-C", f.cwd, "config", "user.email", "test@example.com"]);
  writeFileSync(join(f.cwd, "tracked.txt"), "tracked\n");
  execFileSync("git", ["-C", f.cwd, "add", "."]);
  execFileSync("git", ["-C", f.cwd, "commit", "-qm", "initial"]);
  const store = new RunStore(f.cwd, "session", "agents", f.home);
  await store.create({ id: "agents", workflowName: "agents-name", cwd: f.cwd, sessionId: "session", state: "completed", agents: [agentRecord({ prompt: "PROMPT", systemPrompt: "SYSTEM", resultPath: "agent/result", worktreeOwner: "owner" }), agentRecord({ id: "plain", name: "plain", path: "plain" })], agentSessions: [] }, snapshot());
  await store.complete("agent/result", { answer: 42 });
  const { branch, path } = await store.worktree("owner");
  return { f, store, branch, path };
}

void test("agent labels have no View transcript and no Back; copies and editors run in place", async () => {
  const extension: AgentAttemptAction = { label: "Inspect attempt", visible: () => true, run: () => {} };
  const { f } = await agentFixture({ inspect: extension });
  const worktrees = await new RunStore(f.cwd, "session", "agents", f.home).worktrees();
  assert.equal(worktrees.length, 1, "the fixture's worktree record must load");
  const tui = createWorkflowActionProvider(f.deps, f.ctx("tui"));
  const target: AgentsActionTarget = { kind: "workflow-agent", runId: "agents", agentId: "agent-1" };
  const actions = await tui.actions(target);
  assert.deepEqual(labels(actions), ["Inspect attempt", "Copy branch", "Copy worktree path", "Open diff in editor", "Open prompt in editor", "Open system prompt in editor", "Open result in editor", "Copy agent ID"]);
  assert.deepEqual(inPlace(actions), ["Copy branch", "Copy worktree path", "Open diff in editor", "Open prompt in editor", "Open system prompt in editor", "Open result in editor", "Copy agent ID"]);
  assert.deepEqual(labels(await createWorkflowActionProvider(f.deps, f.ctx("rpc")).actions(target)), ["Inspect attempt", "Copy branch", "Copy worktree path", "Copy agent ID"]);
  assert.deepEqual(labels(await tui.actions({ kind: "workflow-agent", runId: "agents", agentId: "plain" })), ["Inspect attempt", "Copy agent ID"]);
  assert.deepEqual(await tui.actions({ kind: "workflow-agent", runId: "agents", agentId: "gone" }), []);
});

void test("agent actions copy, open editors and run registered actions through the ActionUi", async () => {
  const contexts: string[] = [];
  const actions: Record<string, AgentAttemptAction> = {
    inspect: { label: "Inspect attempt", visible: () => true, run: async (context) => { contexts.push(`${context.run.id}/${context.agent.id}/${String(context.attempt.attempt)}/${context.session?.sessionId ?? ""}`); context.ui.notify("from action"); assert.equal(await context.ui.confirm("Sure?", "Really?"), true); assert.equal(await context.ui.select("Pick", ["a", "b"]), "b"); assert.equal(await context.ui.input("Name", "hint"), "typed"); context.ui.setWorkingMessage?.("working"); } },
    broken: { label: "Broken action", visible: () => true, run: () => { throw new Error("action exploded"); } },
  };
  const { f, branch, path } = await agentFixture(actions);
  const provider = createWorkflowActionProvider(f.deps, f.ctx("tui"));
  const target: AgentsActionTarget = { kind: "workflow-agent", runId: "agents", agentId: "agent-1" };
  const ui = recordingUi({ confirm: () => true, select: (_title, options) => options.at(-1), input: () => "typed" });
  for (const label of ["Copy branch", "Copy worktree path", "Copy agent ID"]) assert.deepEqual(await provider.run(target, label, ui), {});
  assert.deepEqual(f.copied, [branch, path, "agent-1"]);
  for (const label of ["Open prompt in editor", "Open system prompt in editor", "Open result in editor"]) await provider.run(target, label, ui);
  assert.deepEqual(ui.opened, [
    { artifact: { extension: ".md", content: "PROMPT" }, label: "agent prompt" },
    { artifact: { extension: ".md", content: "SYSTEM" }, label: "agent system prompt" },
    { artifact: { extension: ".json", content: "{\n  \"answer\": 42\n}\n" }, label: "agent result" },
  ]);
  await provider.run(target, "Inspect attempt", ui);
  assert.deepEqual(contexts, ["agents/agent-1/1/native"]);
  assert.deepEqual(ui.confirms, [{ title: "Sure?", message: "Really?" }]);
  assert.deepEqual(ui.selects, [{ title: "Pick", options: ["a", "b"] }]);
  assert.deepEqual(ui.inputs, [{ title: "Name", placeholder: "hint" }]);
  assert.deepEqual(ui.working, ["working"]);
  await provider.run(target, "Broken action", ui);
  await provider.run(target, "View transcript", ui);
  await provider.run({ kind: "workflow-agent", runId: "agents", agentId: "plain" }, "Copy branch", ui);
  assert.deepEqual(ui.notices, [
    { message: "Copied branch.", level: "info" },
    { message: "Copied worktree path.", level: "info" },
    { message: "Copied agent ID.", level: "info" },
    { message: "from action", level: "info" },
    { message: "Agent attempt action failed: action exploded", level: "error" },
    { message: "Cannot select workflow action: View transcript", level: "warning" },
    { message: "Cannot select workflow action: Copy branch", level: "warning" },
  ]);
  const failing = fixture({ clipboard: async () => { throw new Error("no clipboard"); } });
  await createRun(failing, "copy", "completed");
  const failingUi = recordingUi();
  await createWorkflowActionProvider(failing.deps, failing.ctx("tui")).run(runTarget("copy"), "Copy run ID", failingUi);
  assert.deepEqual(failingUi.notices, [{ message: "Failed to copy run ID: no clipboard", level: "error" }]);
});

void test("run copies and the script editor work on the run's store", async () => {
  const f = fixture();
  const store = await createRun(f, "copy", "running", {}, "// SCRIPT\nreturn 1;");
  const provider = createWorkflowActionProvider(f.deps, f.ctx("tui"));
  const ui = recordingUi();
  await provider.run(runTarget("copy"), "Copy run path", ui);
  await provider.run(runTarget("copy"), "Copy run ID", ui);
  await provider.run(runTarget("copy"), "Open script in editor", ui);
  assert.deepEqual(f.copied, [store.directory, "copy"]);
  assert.deepEqual(notices(ui), ["Copied run path.", "Copied run ID."]);
  assert.deepEqual(ui.opened, [{ artifact: { extension: ".js", content: readFileSync(join(store.directory, "workflow.js"), "utf8") }, label: "workflow script" }]);
  assert.match(ui.opened[0]?.artifact.content ?? "", /SCRIPT/);
});

void test("Pause, Cancel pause, Move to background and budget decisions notify as the dashboard does", async () => {
  const f = fixture({ isForegroundAttached: (runId) => runId === "run" });
  const store = await createRun(f, "run", "running");
  const lifecycle = liveRun(f, store, "running");
  const provider = createWorkflowActionProvider(f.deps, f.ctx("rpc"));
  const ui = recordingUi();
  await provider.run(runTarget("run"), "Pause", ui);
  assert.equal(lifecycle.state, "pausing");
  await store.saveState({ ...(await store.load()).run, state: "pausing" });
  await provider.run(runTarget("run"), "Cancel pause", ui);
  assert.equal(lifecycle.state, "running");
  await store.saveState({ ...(await store.load()).run, state: "running" });
  await provider.run(runTarget("run"), "Move to background", ui);
  const paused = await createRun(f, "paused-now", "running");
  liveRun(f, paused, "running", "paused");
  await provider.run(runTarget("paused-now"), "Pause", ui);
  assert.deepEqual(ui.notices, [
    { message: "Pausing workflow run; it pauses once the active operation finishes.", level: "info" },
    { message: "Cancelled the pending pause of workflow run.", level: "info" },
    { message: "Moved workflow run to background.", level: "info" },
    { message: "Paused workflow paused-now.", level: "info" },
  ]);
  const budget = await createRun(f, "budget", "budget_exhausted");
  for (const proposalId of ["approve-1234567890", "reject-12345678901", "missing-123456789"]) await budget.requestWorkflowDecision({ kind: "budget", proposalId, runId: "budget", consumed: { tokens: 1, costUsd: 0, durationMs: 0, agentLaunches: 0 }, previous: { tokens: { hard: 1 } }, proposed: { tokens: { hard: 2 } }, budgetVersion: 1 });
  f.deps.recovery.answerBudgetDecision = (async (runId: string, proposalId: string, approved: boolean, ...rest: unknown[]) => { f.calls.push(["answerBudgetDecision", runId, proposalId, approved, ...rest]); return proposalId.startsWith("missing") ? undefined : { approved }; }) as unknown as WorkflowActionDependencies["recovery"]["answerBudgetDecision"];
  const budgetUi = recordingUi();
  await provider.run(runTarget("budget"), "Approve budget approve-", budgetUi);
  await provider.run(runTarget("budget"), "Reject budget reject-1", budgetUi);
  await provider.run(runTarget("budget"), "Approve budget missing-", budgetUi);
  assert.deepEqual(budgetUi.notices, [
    { message: "Budget adjustment approve-1234567890 approved.", level: "info" },
    { message: "Budget adjustment reject-12345678901 rejected.", level: "info" },
    { message: "Budget proposal is not pending.", level: "warning" },
  ]);
  const decisions = f.calls.filter(([name]) => name === "answerBudgetDecision");
  assert.deepEqual(decisions.map((call) => call.slice(1, 5)), [["budget", "approve-1234567890", true, true], ["budget", "reject-12345678901", false, true], ["budget", "missing-123456789", true, true]]);
  assert.ok(decisions.every((call) => call[6] === undefined && call[7] === false), "decisions do not wait for the run to finish");
  assert.deepEqual(f.calls.filter(([name]) => name === "moveForegroundToBackground"), [["moveForegroundToBackground", "run"]]);
});

void test("Stop confirms, reports its progress through the status and survives a failing stop", async () => {
  const f = fixture();
  const store = await createRun(f, "run", "running");
  liveRun(f, store, "running");
  const provider = createWorkflowActionProvider(f.deps, f.ctx("tui"));
  const declined = recordingUi({ confirm: () => false });
  await provider.run(runTarget("run"), "Stop", declined);
  assert.deepEqual(declined.confirms, [{ title: "Stop workflow?", message: "Stop workflow run-name (run)? This cannot be undone." }]);
  assert.deepEqual(declined.statuses, []);
  assert.deepEqual(declined.notices, []);
  assert.deepEqual(f.calls, []);
  const accepted = recordingUi({ confirm: () => true });
  await provider.run(runTarget("run"), "Stop", accepted);
  assert.deepEqual(accepted.statuses, ["Stopping workflow run-name...", "Workflow run stopped."]);
  assert.deepEqual(accepted.notices, [{ message: "Stopped workflow run.", level: "info" }]);
  assert.deepEqual(f.calls, [["stopWorkflowRun", "run"]]);
  f.deps.stopWorkflowRun = async () => { throw new Error("cleanup failed"); };
  const failed = recordingUi({ confirm: () => true });
  assert.deepEqual(await provider.run(runTarget("run"), "Stop", failed), {});
  assert.deepEqual(failed.statuses, ["Stopping workflow run-name...", "Could not stop workflow run: cleanup failed"]);
  assert.deepEqual(failed.notices, [{ message: "Cannot stop for run: cleanup failed", level: "warning" }]);
});

void test("Resume asks the mode, parses a budget patch and reports the outcome", async () => {
  const f = fixture();
  await createRun(f, "paused", "paused");
  await createRun(f, "exhausted", "budget_exhausted");
  const results: (() => Promise<{ workflowName: string; state: "running" | "completed" | "awaiting_approval"; attached: boolean; value?: string }>)[] = [
    async () => ({ workflowName: "paused-name", state: "running", attached: false }),
    async () => ({ workflowName: "exhausted-name", state: "completed", attached: false, value: "done" }),
    async () => ({ workflowName: "exhausted-name", state: "awaiting_approval", attached: false }),
    async () => { throw Object.assign(new Error("attached failure"), { workflowResumeAttached: true }); },
    async () => { throw new Error("resume exploded"); },
  ];
  f.deps.resumeSelectedWorkflow = async (...args: unknown[]) => { f.calls.push(["resumeSelectedWorkflow", ...args]); const next = results.shift(); assert.ok(next); return next(); };
  const ctx = f.ctx("tui");
  const provider = createWorkflowActionProvider(f.deps, ctx);
  const modes = ["Background", "Foreground", "Background", "Foreground", "Foreground", "Cancel", "Foreground"];
  const ui = recordingUi({ select: () => modes.shift(), input: () => "{\"tokens\":{\"hard\":3}}" });
  await provider.run(runTarget("paused"), "Resume", ui);
  await provider.run(runTarget("exhausted"), "Resume unchanged", ui);
  await provider.run(runTarget("exhausted"), "Adjust budget", ui);
  await provider.run(runTarget("paused"), "Resume", ui);
  await provider.run(runTarget("paused"), "Resume", ui);
  await provider.run(runTarget("paused"), "Resume", ui);
  assert.deepEqual(ui.selects.map(({ title, options }) => [title, ...options]), Array.from({ length: 6 }, (_, index) => [`Resume ${[1, 2].includes(index) ? "exhausted" : "paused"}-name`, "Foreground", "Background", "Cancel"]));
  assert.deepEqual(ui.inputs, [{ title: "Budget patch (JSON)", placeholder: "{\"tokens\":{\"hard\":null}}" }]);
  const resumes = f.calls.filter(([name]) => name === "resumeSelectedWorkflow");
  assert.deepEqual(resumes.map(([, runId, foreground, context, patch]) => [runId, foreground, context === ctx, patch]), [["paused", false, true, undefined], ["exhausted", true, true, undefined], ["exhausted", false, true, { tokens: { hard: 3 } }], ["paused", true, true, undefined], ["paused", true, true, undefined]]);
  assert.equal(ui.notices.length, 4, "the attached failure stays silent");
  assert.deepEqual(ui.notices.slice(0, 3), [
    { message: "Resumed workflow paused-name in background.", level: "info" },
    { message: "Workflow exhausted-name completed: \"done\"", level: "info" },
    { message: "Budget adjustment for exhausted-name is awaiting approval.", level: "warning" },
  ]);
  const failure = ui.notices[3];
  assert.ok(failure);
  assert.equal(failure.level, "warning");
  assert.match(failure.message, /^Cannot resume workflow paused: [\s\S]*resume exploded/);
  const bad = recordingUi({ select: () => "Foreground", input: () => "{not json" });
  await provider.run(runTarget("exhausted"), "Adjust budget", bad);
  assert.equal(bad.notices.length, 1);
  assert.match(bad.notices[0]?.message ?? "", /^Cannot parse budget patch: /);
  assert.equal(bad.notices[0]?.level, "warning");
  const cancelled = recordingUi({ select: () => "Foreground", input: () => undefined });
  await provider.run(runTarget("exhausted"), "Adjust budget", cancelled);
  assert.deepEqual(cancelled.notices, []);
  assert.equal(f.calls.filter(([name]) => name === "resumeSelectedWorkflow").length, 5);
});

void test("a Foreground resume settles only after the resumed run settles", async () => {
  const f = fixture();
  await createRun(f, "paused", "paused");
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  let resumed = false;
  f.deps.resumeSelectedWorkflow = async () => { resumed = true; await gate; return { workflowName: "paused-name", state: "completed", attached: false }; };
  const ui = recordingUi({ select: () => "Foreground" });
  let settled = false;
  const running = createWorkflowActionProvider(f.deps, f.ctx("tui")).run(runTarget("paused"), "Resume", ui).then((result) => { settled = true; return result; });
  const isResumed = () => resumed;
  for (let attempt = 0; attempt < 100 && !isResumed(); attempt += 1) await new Promise((resolve) => setTimeout(resolve, 5));
  assert.equal(isResumed(), true);
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(settled, false);
  release();
  assert.deepEqual(await running, {});
  assert.deepEqual(notices(ui), ["Workflow paused-name completed."]);
});

void test("Review answers the checkpoint chosen in the review and rpc approves or rejects it directly", async () => {
  const f = fixture();
  const store = await createRun(f, "run", "awaiting_input");
  await store.awaitCheckpoint({ path: "checkpoint/ship", name: "ship", prompt: "Ship?", context: null });
  const tui = createWorkflowActionProvider(f.deps, f.ctx("tui"));
  const decisions: ("Approve" | "Reject" | undefined)[] = ["Approve", undefined, "Reject"];
  const ui = recordingUi({ review: () => decisions.shift() });
  await tui.run(runTarget("run"), "Review ship", ui);
  await tui.run(runTarget("run"), "Review ship", ui);
  f.deps.answerCheckpoint = async (...args: unknown[]) => { f.calls.push(["answerCheckpoint", ...args]); return false; };
  await tui.run(runTarget("run"), "Review ship", ui);
  assert.deepEqual(ui.reviewed, ["ship", "ship", "ship"]);
  assert.deepEqual(f.calls, [["answerCheckpoint", "run", "ship", true, true], ["answerCheckpoint", "run", "ship", false, true]]);
  assert.deepEqual(ui.notices, [{ message: "Checkpoint is not awaiting a response.", level: "warning" }]);
  f.deps.answerCheckpoint = async () => true;
  const rpc = createWorkflowActionProvider(f.deps, f.ctx("rpc"));
  const rpcUi = recordingUi();
  await rpc.run(runTarget("run"), "Approve ship", rpcUi);
  await rpc.run(runTarget("run"), "Reject ship", rpcUi);
  await rpc.run(runTarget("run"), "Review ship", rpcUi);
  assert.deepEqual(notices(rpcUi), ["Approved checkpoint ship.", "Rejected checkpoint ship.", "Cannot select workflow action: Review ship"]);
});

void test("Delete confirms, refuses a run that is not stopped or that a surviving run depends on", async () => {
  const f = fixture();
  const keep = await createRun(f, "keep", "completed");
  const old = await createRun(f, "old", "completed");
  f.deps.terminalRunStates.set("old", "completed");
  const provider = createWorkflowActionProvider(f.deps, f.ctx("tui"));
  const declined = recordingUi({ confirm: () => false });
  await provider.run(runTarget("old"), "Delete", declined);
  assert.deepEqual(declined.confirms, [{ title: "Delete workflow?", message: "Delete old-name (old) and all owned artifacts? This cannot be undone." }]);
  assert.equal(existsSync(old.directory), true);
  const accepted = recordingUi({ confirm: () => true });
  assert.deepEqual(await provider.run(runTarget("old"), "Delete", accepted), {});
  assert.deepEqual(accepted.notices, [{ message: "Deleted workflow old.", level: "info" }]);
  assert.equal(existsSync(old.directory), false);
  assert.equal(existsSync(keep.directory), true);
  assert.equal(f.deps.terminalRunStates.has("old"), false);
  await provider.run(runTarget("old"), "Delete", accepted);
  assert.deepEqual(notices(accepted).at(-1), "Cannot select workflow action: Delete");

  // A run that left its terminal state after its labels were read.
  const stale = await loadWorkflowRunView(f.deps, f.ctx("tui"), keep);
  await keep.saveState({ ...(await keep.load()).run, state: "running" });
  const refused = recordingUi({ confirm: () => true });
  assert.equal(await runWorkflowRunAction(f.deps, f.ctx("tui"), refused, stale, "Delete"), "dashboard");
  assert.deepEqual(refused.notices, [{ message: "Stop the workflow before deleting it.", level: "warning" }]);
  assert.deepEqual(refused.confirms, []);
  assert.equal(existsSync(keep.directory), true);

  const source = await createRun(f, "source-run", "failed");
  await source.complete("agent/replayable", "kept");
  await createRun(f, "retry-child", "interrupted", { workflowName: "retry", parentRunId: "source-run", retry: { sourceRunId: "source-run", lineageRootRunId: "source-run", completedPaths: ["agent/replayable"], incompletePaths: [], namedWorktrees: [] } });
  const dependent = recordingUi({ confirm: () => true });
  await provider.run(runTarget("source-run"), "Delete", dependent);
  assert.deepEqual(dependent.notices, [{ message: "Cannot delete workflow source-run: surviving workflow retry-child (retry) depends on it.", level: "warning" }]);
  assert.equal(existsSync(source.directory), true);
});

void test("bulk deletes confirm and report deleted and skipped runs", async () => {
  const f = fixture();
  const completed = await createRun(f, "completed-run", "completed");
  const failedA = await createRun(f, "failed-a", "failed");
  const source = await createRun(f, "failed-source", "failed");
  const child = await createRun(f, "interrupted-child", "interrupted", { parentRunId: "failed-source", retry: { sourceRunId: "failed-source", lineageRootRunId: "failed-source", completedPaths: [], incompletePaths: [], namedWorktrees: [] } });
  const provider = createWorkflowActionProvider(f.deps, f.ctx("rpc"));
  const declined = recordingUi({ confirm: () => false });
  await provider.run(runTarget("interrupted-child"), "Delete all failed", declined);
  assert.deepEqual(declined.confirms, [{ title: "Delete failed runs?", message: "Delete all failed workflow runs and their artifacts? This cannot be undone." }]);
  assert.equal(existsSync(failedA.directory), true);
  const ui = recordingUi({ confirm: () => true });
  await provider.run(runTarget("interrupted-child"), "Delete all failed", ui);
  assert.deepEqual(ui.notices, [
    { message: "Skipped failed runs required by surviving workflows: failed-source (needed by interrupted-child).", level: "warning" },
    { message: "Deleted 1 failed workflow run(s).", level: "info" },
  ]);
  assert.equal(existsSync(failedA.directory), false);
  assert.equal(existsSync(source.directory), true);
  await provider.run(runTarget("interrupted-child"), "Delete all completed", ui);
  assert.deepEqual(ui.confirms.at(-1), { title: "Delete completed runs?", message: "Delete all completed workflow runs and their artifacts? This cannot be undone." });
  assert.deepEqual(notices(ui).at(-1), "Deleted 1 completed workflow run(s).");
  assert.equal(existsSync(completed.directory), false);
  assert.equal(existsSync(child.directory), true);
  await provider.run(runTarget("interrupted-child"), "Delete all completed", ui);
  assert.deepEqual(notices(ui).at(-1), "Cannot select workflow action: Delete all completed");
});

void test("Model aliases adds, edits and deletes aliases and confirms an unknown model", async () => {
  const f = fixture();
  await createRun(f, "run", "running");
  const provider = createWorkflowActionProvider(f.deps, f.ctx("tui"));
  const settingsPath = workflowSettingsPath(f.deps.extensionAgentDir);
  const script: Record<string, (string | undefined)[]> = {
    menu: ["Add alias", "Edit fast", "Add alias", "Delete fast", "Back"],
    target: ["openai/gpt", "Manual model ID", "Manual model ID"],
    input: ["fast", "private/model:high", "portable", "private/other"],
  };
  const ui = recordingUi({
    select: (title) => (title.startsWith("Model aliases") ? script.menu : script.target)?.shift(),
    input: () => script.input?.shift(),
    confirm: (title) => title !== "Save unknown model?" || script.input?.length === 0,
  });
  assert.deepEqual(await provider.run(runTarget("run"), "Model aliases", ui), {});
  assert.deepEqual(ui.selects.map(({ title }) => title.split("\n")[0]), ["Model aliases", "Model alias target", "Model aliases", "Model alias target", "Model aliases", "Model alias target", "Model aliases", "Model aliases"]);
  assert.deepEqual(ui.selects[1]?.options, ["openai/gpt", "Manual model ID", "Back"]);
  assert.deepEqual(ui.selects[2], { title: "Model aliases\nfast = openai/gpt", options: ["Add alias", "Edit fast", "Delete fast", "Back"] });
  assert.deepEqual(ui.inputs.map(({ title }) => title), ["Alias name", "Manual model ID", "Alias name", "Manual model ID"]);
  assert.deepEqual(ui.confirms, [
    { title: "Save unknown model?", message: "Save this target for cross-machine portability?" },
    { title: "Save unknown model?", message: "Save this target for cross-machine portability?" },
    { title: "Delete model alias?", message: "Delete fast? Future workflow resumes using this alias may fail." },
  ]);
  assert.deepEqual(ui.notices, [
    { message: `Saved model aliases to ${settingsPath}.`, level: "info" },
    { message: "Warning: private/model:high is not currently available in Pi.", level: "warning" },
    { message: "Warning: private/other is not currently available in Pi.", level: "warning" },
    { message: `Saved model aliases to ${settingsPath}.`, level: "info" },
    { message: `Saved model aliases to ${settingsPath}.`, level: "info" },
  ]);
  const saved = JSON.parse(readFileSync(settingsPath, "utf8")) as { modelAliases?: Record<string, string> };
  assert.deepEqual(saved.modelAliases, { portable: "private/other" });
});

void test("a label no longer offered is reported and does nothing", async () => {
  const f = fixture();
  await createRun(f, "done", "completed");
  const provider = createWorkflowActionProvider(f.deps, f.ctx("tui"));
  const ui = recordingUi({ confirm: () => true });
  assert.deepEqual(await provider.run(runTarget("done"), "Pause", ui), {});
  assert.deepEqual(await provider.run(runTarget("done"), "Refresh", ui), {});
  assert.deepEqual(await provider.run(runTarget("missing"), "Delete", ui), {});
  assert.deepEqual(await provider.run({ kind: "subagent", id: "done" }, "Stop", ui), {});
  assert.deepEqual(ui.notices, [
    { message: "Cannot select workflow action: Pause", level: "warning" },
    { message: "Cannot select workflow action: Refresh", level: "warning" },
    { message: "Cannot select workflow action: Delete", level: "warning" },
    { message: "Cannot select workflow action: Stop", level: "warning" },
  ]);
  assert.deepEqual(ui.confirms, []);
  assert.deepEqual(f.calls, []);
});

void test("Open diff in editor opens the worktree's diff as a .diff artifact, or says there are no changes; it is not offered once the worktree is gone", async () => {
  const { f, path } = await agentFixture();
  const provider = createWorkflowActionProvider(f.deps, f.ctx("tui"));
  const target: AgentsActionTarget = { kind: "workflow-agent", runId: "agents", agentId: "agent-1" };
  const ui = recordingUi();
  await provider.run(target, "Open diff in editor", ui);
  assert.equal(ui.opened.length, 0);
  assert.deepEqual(notices(ui), ["No changes since the worktree was created."]);
  writeFileSync(join(path, "tracked.txt"), "tracked\nchanged\n");
  await provider.run(target, "Open diff in editor", ui);
  assert.equal(ui.opened.length, 1);
  const opened = ui.opened[0];
  assert.ok(opened);
  assert.equal(opened.artifact.extension, ".diff");
  assert.match(opened.artifact.content, /\+changed/);
  assert.equal(labels(await provider.actions({ kind: "workflow-agent", runId: "agents", agentId: "plain" })).includes("Open diff in editor"), false);
  rmSync(path, { recursive: true, force: true });
  assert.equal(labels(await provider.actions(target)).includes("Open diff in editor"), false);
});

void test("Open diff in editor on a menu built earlier says when the worktree was removed or its diff cannot be read", async () => {
  const { f, store, path } = await agentFixture();
  const view = await loadWorkflowRunView(f.deps, f.ctx("tui"), store);
  const agent = view.run.agents.find((candidate) => candidate.id === "agent-1");
  assert.ok(agent);
  const reference = view.worktrees[0];
  assert.ok(reference);
  const broken = recordingUi();
  await runAgentAction(f.deps, broken, { ...view, worktrees: [{ ...reference, base: "0".repeat(40) }] }, agent, "Open diff in editor");
  assert.equal(broken.opened.length, 0);
  assert.equal(notices(broken).length, 1);
  assert.match(notices(broken)[0] ?? "", /^Cannot read the worktree diff: /);
  rmSync(path, { recursive: true, force: true });
  const gone = recordingUi();
  await runAgentAction(f.deps, gone, view, agent, "Open diff in editor");
  assert.equal(gone.opened.length, 0);
  assert.deepEqual(notices(gone), ["The worktree was removed."]);
});

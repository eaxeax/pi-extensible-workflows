import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after } from "node:test";
import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import type { ActionUi, AgentsActionTarget } from "../src/agents-actions-contract.js";
import { formatWorkflowRuntime, PLAIN_WORKFLOW_PROGRESS_STYLES, registerWorkflowExtension, resetWorkflowRegistry, type AgentAttemptSummary, type PreparedAgentSession } from "../src/index.js";
import { getSubagentsHandle } from "../src/subagent-actions-handle.js";
import { createSubagentActionProvider, createSubagentPresenter } from "../subagents/src/actions.js";
import type { SubagentAttemptActionData, SubagentManager, SubagentManagerContext } from "../subagents/src/contracts.js";
import { registerSubagentsExtension } from "../subagents/src/index.js";

const SESSION = "session-1";
const NOW = 61_000;
const homes: string[] = [];
after(() => { for (const home of homes) rmSync(home, { recursive: true, force: true }); });

/** A storage directory with one request.json per labelled run, as the manager writes them. */
function storage(requests: Readonly<Record<string, Readonly<Record<string, unknown>>>>): string {
  const home = mkdtempSync(join(tmpdir(), "pi-extensible-workflows-subagent-actions-"));
  homes.push(home);
  const directory = join(home, "subagents");
  for (const [id, request] of Object.entries(requests)) {
    mkdirSync(join(directory, id), { recursive: true });
    writeFileSync(join(directory, id, "request.json"), JSON.stringify(request));
  }
  return directory;
}

/** A command context whose ui fails the test: providers ask the person only through the ActionUi they are given. */
function commandContext(cwd: string, mode: "tui" | "rpc" = "tui"): ExtensionCommandContext {
  const refuse = (): never => { throw new Error("providers never call ctx.ui"); };
  return { cwd, mode, hasUI: true, sessionManager: { getSessionId: () => SESSION }, isProjectTrusted: () => true, ui: { notify: refuse, confirm: refuse, select: refuse, input: refuse, custom: refuse, setWorkingMessage: refuse, setStatus: refuse } } as unknown as ExtensionCommandContext;
}

type Call = readonly [string, ...unknown[]];
/** Records every ActionUi call in order; the answers are fixed per test. */
function recordingUi(answers: { readonly confirm?: boolean; readonly editText?: string; readonly select?: string } = {}): ActionUi & { readonly calls: Call[] } {
  const calls: Call[] = [];
  return {
    calls,
    notify(message, level) { calls.push(["notify", message, level]); },
    async confirm(title, message) { calls.push(["confirm", title, message]); return answers.confirm ?? false; },
    async select(title, options) { calls.push(["select", title, options]); return answers.select; },
    async input(title, placeholder) { calls.push(["input", title, placeholder]); return undefined; },
    async editText(title) { calls.push(["editText", title]); return answers.editText; },
    async reviewCheckpoint(checkpoint) { calls.push(["reviewCheckpoint", checkpoint]); return undefined; },
    async openArtifact(artifact, label) { calls.push(["openArtifact", artifact, label]); },
    status(text) { calls.push(["status", text]); },
    setWorkingMessage(message) { calls.push(["setWorkingMessage", message]); },
  };
}

const ATTEMPT: AgentAttemptSummary = { attempt: 1, transport: "fixture", setup: { hookNames: [], model: { provider: "fixture", model: "model" }, tools: ["read"], cwd: "/repo" }, accounting: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 } };
const PREPARED = { cwd: "/repo", model: { provider: "fixture", model: "model" }, tools: ["read"], sessionLabel: "scout", systemPrompt: "SYSTEM" } as unknown as PreparedAgentSession;

type ManagerCall = readonly [string, unknown, SubagentManagerContext];
/**
 * The session's runs: run-a running (label scout, a worktree, a live system prompt), run-b completed (label scout, a
 * result), run-c failed (no request file), and a run of another session the provider never lists.
 */
function fixture(options: { readonly delete?: boolean; readonly retry?: unknown; readonly failDelete?: string; readonly clipboardError?: string } = {}) {
  const directory = storage({ "run-a": { prompt: "PROMPT A", label: "scout", mode: "background" }, "run-b": { prompt: "PROMPT B", label: "scout", mode: "background" } });
  const statuses = new Map<string, Record<string, unknown>>([
    ["run-a", { id: "run-a", sessionId: SESSION, state: "running", startedAt: 1_000, attempts: 1, attemptDetails: [ATTEMPT], worktree: { path: "/repo/worktree-a", branch: "subagent/run-a" } }],
    ["run-b", { id: "run-b", sessionId: SESSION, state: "completed", startedAt: 1_000, finishedAt: 2_000, value: { answer: 42 } }],
    ["run-c", { id: "run-c", sessionId: SESSION, state: "failed", startedAt: 1_000, finishedAt: 3_000, error: { code: "AGENT_FAILED", message: "boom" } }],
    ["run-other", { id: "run-other", sessionId: "session-2", state: "completed", startedAt: 1_000, finishedAt: 2_000 }],
  ]);
  const calls: ManagerCall[] = [];
  const copied: string[] = [];
  const known = (id: string): Record<string, unknown> => {
    const status = statuses.get(id);
    if (status === undefined) throw new Error(`Unknown subagent ${id}`);
    return status;
  };
  const manager: SubagentManager = {
    async run() { throw new Error("unexpected run"); },
    async inspect(request) {
      if (request.id === undefined) return [...statuses.values()];
      return known(request.id);
    },
    async steer(request, context) { calls.push(["steer", request, context]); return { id: request.id, accepted: true }; },
    async stop(request, context) { calls.push(["stop", request, context]); statuses.set(request.id, { ...known(request.id), state: "stopped", finishedAt: 4_000 }); return {}; },
    async retry(request, context) { calls.push(["retry", request, context]); return options.retry; },
    ...(options.delete === false ? {} : {
      async delete(request: { readonly id: string }, context: SubagentManagerContext) {
        calls.push(["delete", request, context]);
        if (request.id === options.failDelete) throw new Error("locked");
        statuses.delete(request.id);
        return {};
      },
    }),
    getAttemptActionData(id): SubagentAttemptActionData | undefined { return id === "run-a" && statuses.get(id)?.state === "running" ? { attempt: ATTEMPT, prepared: PREPARED, signal: new AbortController().signal } : undefined; },
  };
  const clipboard = async (value: string): Promise<void> => {
    if (options.clipboardError !== undefined) throw new Error(options.clipboardError);
    copied.push(value);
  };
  const context = commandContext(directory);
  return { directory, statuses, calls, copied, manager, context, provider: createSubagentActionProvider({ manager, storageDirectory: directory, clipboard }, context) };
}
const subagent = (id: string): AgentsActionTarget => ({ kind: "subagent", id });
const GROUP: AgentsActionTarget = { kind: "subagents" };
const IN_PLACE = new Set(["Copy branch", "Copy worktree path", "Open prompt in editor", "Open system prompt in editor", "Open result in editor", "Copy run path", "Copy agent ID"]);
/** The menu as the provider gives it: each label with its inPlace mark. */
function marked(labels: readonly string[]) { return labels.map((label) => IN_PLACE.has(label) ? { label, inPlace: true } : { label }); }

void test("offers each subagent today's /subagents labels for its state, without View transcript and Back, and marks the in-place ones", async () => {
  const { provider } = fixture();
  assert.deepEqual(await provider.actions(subagent("run-a")), marked(["Copy branch", "Copy worktree path", "Open prompt in editor", "Open system prompt in editor", "Steer", "Stop", "Copy run path", "Copy agent ID"]));
  assert.deepEqual(await provider.actions(subagent("run-b")), marked(["Open prompt in editor", "Open result in editor", "Delete", "Copy run path", "Copy agent ID"]));
  assert.deepEqual(await provider.actions(subagent("run-c")), marked(["Retry", "Delete", "Copy run path", "Copy agent ID"]));
  assert.deepEqual(await provider.actions(GROUP), marked(["Delete all completed", "Delete all failed"]), "the bulk deletions belong to the group only");
  assert.deepEqual(await provider.actions({ kind: "run", runId: "run-a" }), []);
  assert.deepEqual(await provider.actions({ kind: "workflow-agent", runId: "run-a", agentId: "run-a" }), []);
});

void test("offers no deletion without manager.delete, and the group then has no labels", async () => {
  const { provider } = fixture({ delete: false });
  assert.deepEqual(await provider.actions(subagent("run-b")), marked(["Open prompt in editor", "Open result in editor", "Copy run path", "Copy agent ID"]));
  assert.deepEqual(await provider.actions(subagent("run-c")), marked(["Retry", "Copy run path", "Copy agent ID"]));
  assert.deepEqual(await provider.actions(GROUP), []);
});

void test("copies the agent ID, run path, branch and worktree path with today's notices, and reports a failed copy", async () => {
  const { provider, copied, directory } = fixture();
  for (const [label, value, notice] of [
    ["Copy agent ID", "run-a", "Copied agent ID."],
    ["Copy run path", join(directory, "run-a"), "Copied run path."],
    ["Copy branch", "subagent/run-a", "Copied branch."],
    ["Copy worktree path", "/repo/worktree-a", "Copied worktree path."],
  ] as const) {
    const ui = recordingUi();
    assert.deepEqual(await provider.run(subagent("run-a"), label, ui), {});
    assert.equal(copied.at(-1), value);
    assert.deepEqual(ui.calls, [["notify", notice, "info"]]);
  }
  const failing = fixture({ clipboardError: "no clipboard" });
  const ui = recordingUi();
  assert.deepEqual(await failing.provider.run(subagent("run-a"), "Copy agent ID", ui), {});
  assert.deepEqual(ui.calls, [["notify", "Cannot copy agent id: no clipboard", "warning"]]);
});

void test("deletes a settled subagent only after ui.confirm accepts today's question", async () => {
  const declined = fixture();
  const no = recordingUi({ confirm: false });
  assert.deepEqual(await declined.provider.run(subagent("run-b"), "Delete", no), {});
  assert.deepEqual(no.calls, [["confirm", "Delete subagent?", "Delete scout (run-b) and its record? This cannot be undone."]]);
  assert.deepEqual(declined.calls, []);

  const accepted = fixture();
  const yes = recordingUi({ confirm: true });
  assert.deepEqual(await accepted.provider.run(subagent("run-b"), "Delete", yes), {});
  assert.deepEqual(yes.calls, [["confirm", "Delete subagent?", "Delete scout (run-b) and its record? This cannot be undone."], ["notify", "Deleted subagent run-b.", "info"]]);
  assert.deepEqual(accepted.calls.map(([name, request]) => [name, request]), [["delete", { id: "run-b" }]]);
  assert.equal(accepted.calls[0]?.[2].extensionContext, accepted.context);
});

void test("stops a running subagent only after ui.confirm accepts today's question", async () => {
  const declined = fixture();
  const no = recordingUi({ confirm: false });
  assert.deepEqual(await declined.provider.run(subagent("run-a"), "Stop", no), {});
  assert.deepEqual(no.calls, [["confirm", "Stop subagent?", "Stop subagent scout (run-a)? This cannot be undone."]]);
  assert.deepEqual(declined.calls, []);

  const accepted = fixture();
  const yes = recordingUi({ confirm: true });
  assert.deepEqual(await accepted.provider.run(subagent("run-a"), "Stop", yes), {});
  assert.deepEqual(yes.calls, [["confirm", "Stop subagent?", "Stop subagent scout (run-a)? This cannot be undone."], ["notify", "Stopped subagent run-a.", "info"]]);
  assert.deepEqual(accepted.calls.map(([name, request]) => [name, request]), [["stop", { id: "run-a" }]]);
  assert.deepEqual(await accepted.provider.actions(subagent("run-a")), marked(["Copy branch", "Copy worktree path", "Open prompt in editor", "Retry", "Delete", "Copy run path", "Copy agent ID"]), "a stopped run is offered Retry and Delete");
});

void test("deletes every completed or failed run of the session from the group after ui.confirm", async () => {
  const declined = fixture();
  const no = recordingUi({ confirm: false });
  assert.deepEqual(await declined.provider.run(GROUP, "Delete all completed", no), {});
  assert.deepEqual(no.calls, [["confirm", "Delete completed runs?", "Delete all completed subagent runs and their records? This cannot be undone."]]);
  assert.deepEqual(declined.calls, []);

  const completed = fixture();
  const yes = recordingUi({ confirm: true });
  assert.deepEqual(await completed.provider.run(GROUP, "Delete all completed", yes), {});
  assert.deepEqual(yes.calls, [["confirm", "Delete completed runs?", "Delete all completed subagent runs and their records? This cannot be undone."], ["notify", "Deleted 1 completed subagent run(s).", "info"]]);
  assert.deepEqual(completed.calls.map(([name, request]) => [name, request]), [["delete", { id: "run-b" }]], "a run of another session is never deleted");
  assert.deepEqual(await completed.provider.actions(GROUP), marked(["Delete all failed"]));

  const failed = fixture({ failDelete: "run-c" });
  const skipped = recordingUi({ confirm: true });
  assert.deepEqual(await failed.provider.run(GROUP, "Delete all failed", skipped), {});
  assert.deepEqual(skipped.calls, [["confirm", "Delete failed runs?", "Delete all failed subagent runs and their records? This cannot be undone."], ["notify", "Skipped failed runs: run-c (locked).", "warning"]]);
});

void test("Retry selects the new run, and an invalid retry result is reported, not thrown", async () => {
  const { provider, calls } = fixture({ retry: { id: "run-d", state: "running" } });
  const ui = recordingUi();
  assert.deepEqual(await provider.run(subagent("run-c"), "Retry", ui), { select: "subagent:run-d" });
  assert.deepEqual(ui.calls, [["notify", "Retried subagent run-c as run-d.", "info"]]);
  assert.deepEqual(calls.map(([name, request]) => [name, request]), [["retry", { id: "run-c" }]]);
  assert.equal(calls[0]?.[2].waitForForeground, false, "a foreground run is retried in the background");

  const invalid = fixture({ retry: { id: "run-c", state: "failed" } });
  const warned = recordingUi();
  assert.deepEqual(await invalid.provider.run(subagent("run-c"), "Retry", warned), {});
  assert.deepEqual(warned.calls, [["notify", "Cannot retry: Retry returned an invalid subagent result", "warning"]]);
});

void test("Steer asks through editText: a cancel sends nothing, a message steers the running subagent", async () => {
  const cancelled = fixture();
  const ui = recordingUi();
  assert.deepEqual(await cancelled.provider.run(subagent("run-a"), "Steer", ui), {});
  assert.deepEqual(ui.calls, [["editText", "Steer subagent"]]);
  assert.deepEqual(cancelled.calls, []);

  const sent = fixture();
  const message = recordingUi({ editText: "check the docs too" });
  assert.deepEqual(await sent.provider.run(subagent("run-a"), "Steer", message), {});
  assert.deepEqual(message.calls, [["editText", "Steer subagent"], ["notify", "Steered subagent run-a.", "info"]]);
  assert.deepEqual(sent.calls.map(([name, request]) => [name, request]), [["steer", { id: "run-a", message: "check the docs too" }]]);
});

void test("opens the prompt, the live system prompt and the result through ui.openArtifact", async () => {
  const { provider } = fixture();
  const ui = recordingUi();
  await provider.run(subagent("run-a"), "Open prompt in editor", ui);
  await provider.run(subagent("run-a"), "Open system prompt in editor", ui);
  await provider.run(subagent("run-b"), "Open result in editor", ui);
  assert.deepEqual(ui.calls, [
    ["openArtifact", { extension: ".md", content: "PROMPT A" }, "agent prompt"],
    ["openArtifact", { extension: ".md", content: "SYSTEM" }, "agent system prompt"],
    ["openArtifact", { extension: ".json", content: '{\n  "answer": 42\n}\n' }, "agent result"],
  ]);
});

void test("a label the subagent is no longer offered is reported and does nothing", async () => {
  const { provider, calls } = fixture();
  const ui = recordingUi({ confirm: true });
  await provider.run(subagent("run-b"), "Stop", ui);
  await provider.run(subagent("run-a"), "View transcript", ui);
  await provider.run(GROUP, "Delete", ui);
  await provider.run(subagent("run-b"), "Delete all completed", ui);
  await provider.run({ kind: "run", runId: "run-a" }, "Pause", ui);
  await provider.run(subagent("run-missing"), "Copy agent ID", ui);
  assert.deepEqual(ui.calls, [
    ["notify", "Cannot stop: Action Stop is no longer available", "warning"],
    ["notify", "Cannot view transcript: Action View transcript is no longer available", "warning"],
    ["notify", "Cannot delete: Action Delete is no longer available", "warning"],
    ["notify", "Cannot delete all completed: Action Delete all completed is no longer available", "warning"],
    ["notify", "Cannot pause: Action Pause is no longer available", "warning"],
    ["notify", "Cannot copy agent id: Unknown subagent run-missing", "warning"],
  ]);
  assert.deepEqual(calls, []);
});

void test("runs a registered standalone action with a ui built from the ActionUi", async (t) => {
  resetWorkflowRegistry();
  t.after(() => { resetWorkflowRegistry(); });
  const seen: string[] = [];
  registerWorkflowExtension({ version: "1.0.0", headline: "Standalone action fixture", agentAttemptActions: {
    fixture: {
      label: "Fixture action",
      visible() { return false; },
      run() {},
      visibleStandalone(context) { return context.agent.name === "scout" && context.attempt.attempt === 1; },
      async runStandalone(context) {
        seen.push(`${context.agent.id} ${context.agent.name}`);
        const accepted = await context.ui.confirm("Proceed?", "Run the fixture action.");
        context.ui.notify(accepted ? "accepted" : "declined");
        context.ui.setWorkingMessage?.("working");
        await context.ui.select("Pick one", ["x", "y"]);
      },
    },
  } });
  const { provider } = fixture();
  assert.deepEqual((await provider.actions(subagent("run-a")))[0], { label: "Fixture action" });
  assert.deepEqual((await provider.actions(subagent("run-b"))).map(({ label }) => label).includes("Fixture action"), false, "run-b has no attempt to act on");
  const ui = recordingUi({ confirm: true, select: "y" });
  assert.deepEqual(await provider.run(subagent("run-a"), "Fixture action", ui), {});
  assert.deepEqual(seen, ["run-a scout"]);
  assert.deepEqual(ui.calls, [["confirm", "Proceed?", "Run the fixture action."], ["notify", "accepted", "info"], ["setWorkingMessage", "working"], ["select", "Pick one", ["x", "y"]]]);
});

void test("the presenter names subagents as the /subagents list does and gives their detail rows", async () => {
  const { manager, directory, context, statuses } = fixture();
  mkdirSync(join(directory, "run-red"));
  writeFileSync(join(directory, "run-red", "request.json"), JSON.stringify({ prompt: "red", label: "red\u001b[31m!", mode: "background" }));
  statuses.set("run-red", { id: "run-red", sessionId: SESSION, state: "completed", startedAt: 1_000, finishedAt: 2_000 });
  const presenter = createSubagentPresenter({ manager, storageDirectory: directory }, context);
  const described = await presenter.describe(["run-a", "run-b", "run-c", "run-red", "run-missing"]);
  assert.deepEqual([...described].map(([id, { name }]) => [id, name]), [["run-a", "scout run-a"], ["run-b", "scout run-b"], ["run-c", "run-c"], ["run-red", "red!"]], "a repeated label carries the short ID; an unreadable id is left out");
  assert.deepEqual(described.get("run-a")?.details(PLAIN_WORKFLOW_PROGRESS_STYLES, NOW), ["Selected subagent: scout", "ID: run-a", "State: running", "Model: fixture/model", "Tools: read", `Duration: ${formatWorkflowRuntime(NOW - 1_000)}`]);
  assert.deepEqual(described.get("run-c")?.details(PLAIN_WORKFLOW_PROGRESS_STYLES, NOW), ["Selected subagent: run-c", "ID: run-c", "State: failed", "Tools: (none)", "Duration: 2s", "Error: AGENT_FAILED: boom"]);
  assert.equal((await presenter.describe(["run-b"])).get("run-b")?.name, "scout", "a label used once is the name");
});

void test("publishes the subagents handle on start and clears it on shutdown", async () => {
  const { manager, directory, copied } = fixture();
  let shutdown: (() => Promise<void>) | undefined;
  const pi = {
    registerTool() {},
    registerCommand() {},
    on(name: string, handler: () => Promise<void>) { if (name === "session_shutdown") shutdown = handler; },
  } as unknown as Parameters<typeof registerSubagentsExtension>[0];
  registerSubagentsExtension(pi, { manager, managerDependencies: { storageDir: directory }, clipboard: async (value) => { copied.push(value); } });
  const handle = getSubagentsHandle();
  assert.ok(handle);
  const context = commandContext(directory);
  const ui = recordingUi();
  await handle.actions(context).run(subagent("run-b"), "Copy run path", ui);
  assert.deepEqual(copied, [join(directory, "run-b")], "the handle's provider uses the extension's storage and clipboard");
  assert.equal((await handle.presenter(context).describe(["run-b"])).get("run-b")?.name, "scout");
  assert.ok(shutdown);
  await shutdown();
  assert.equal(getSubagentsHandle(), undefined);
});

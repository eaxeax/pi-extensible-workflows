import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after, type TestContext } from "node:test";
import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";
import type { AgentsActionProvider } from "../src/agents-actions-contract.js";
import { runAgentsWorkspace } from "../src/agents-command.js";
import type { SessionAgentsSource, SessionTreeNode } from "../src/agents-workspace-contract.js";
import { openAgentsWorkspace } from "../src/agents-workspace.js";
import type { WorkflowRunRecord } from "../src/host-runtime.js";
import { createLaunchSnapshot, DEFAULT_SETTINGS, PLAIN_WORKFLOW_PROGRESS_STYLES, registerWorkflowExtension, resetWorkflowRegistry, RunStore, type AgentAttemptAction, type AgentAttemptActionUi, type AgentAttemptSummary, type AgentRecord, type HardTerminalRunState, type LaunchSnapshot, type PersistedRun, type PreparedAgentSession, type RunState } from "../src/index.js";
import { createPiActionUi } from "../src/pi-action-ui.js";
import { createSessionAgentsSource } from "../src/session-agents.js";
import { HARD_TERMINAL_RUN_STATES } from "../src/types.js";
import { workflowSettingsPath } from "../src/validation.js";
import { agentActionOptions, createWorkflowActionProvider, loadWorkflowRunView, type WorkflowActionDependencies } from "../src/workflow-actions.js";
import { actionOptions, createSubagentActionProvider, createSubagentPresenter, inspectEntry } from "../subagents/src/actions.js";
import type { SubagentAttemptActionData, SubagentManager, SubagentManagerContext } from "../subagents/src/contracts.js";
import { escapes, FakeSource, FakeView, fakePi, KEY, timers, type FakePi, type PendingCustom } from "./agents-workspace-harness.js";

/**
 * Parity of the /agents workspace with the former /workflow and /subagents TUI dashboards: every
 * action they offered through runAgentsWorkspace on the real workspace, the real
 * session source scoped as /workflow and /subagents will open it, the real providers and Pi's ActionUi adapter, over a fake Pi
 * that shows one custom component at a time (agents-workspace-harness.ts). Each case checks the dialogs Pi showed with their
 * titles and messages, the notices in Pi and in the status row of the workspace that opens again, and the outcome.
 */

const SESSION = "session";
const homes: string[] = [];
after(() => { for (const home of homes) rmSync(home, { recursive: true, force: true }); });
function temporary(name: string): string {
  const directory = mkdtempSync(join(tmpdir(), `pi-extensible-workflows-agents-actions-${name}-`));
  homes.push(directory);
  return directory;
}
async function until(condition: () => boolean, what: string | (() => string)): Promise<void> {
  for (let wait = 0; wait < 2000 && !condition(); wait += 1) await new Promise((resolve) => { setTimeout(resolve, 5); });
  assert.ok(condition(), typeof what === "string" ? what : what());
}

/** The command: the action loop over the real workspace, as /workflow and /subagents open it, with what it showed and asked. */
interface Command {
  readonly pi: FakePi;
  readonly done: Promise<void>;
  /** reportBlocked around each confirmation: "blocked <title>", then "unblocked". */
  readonly blocked: string[];
  /** The agents whose transcript the workspace opened, by key, in order. */
  readonly opened: string[];
}
interface CommandOptions {
  readonly columns?: number;
  readonly rows?: number;
  readonly initialKey?: string;
  readonly editorCommand?: () => string | undefined;
}
/** Runs the loop until the case ends; then aborts the command, closes what Pi still shows and waits (bounded) for the command to end. */
function command(t: TestContext, cwd: string, options: CommandOptions, wiring: { readonly source: (ctx: ExtensionCommandContext) => SessionAgentsSource; readonly providers: (ctx: ExtensionCommandContext) => readonly AgentsActionProvider[]; readonly hasContent: (nodes: readonly SessionTreeNode[]) => boolean; readonly onEmpty: (ctx: ExtensionCommandContext) => void }): Command {
  const controller = new AbortController();
  const pi = fakePi({ columns: options.columns, rows: options.rows, signal: controller.signal, context: { cwd, mode: "tui", hasUI: true, sessionManager: { getSessionId: () => SESSION }, isProjectTrusted: () => false } });
  const blocked: string[] = [];
  const opened: string[] = [];
  const editorCommand = options.editorCommand ?? (() => undefined);
  const ctx = pi.ctx;
  const done = runAgentsWorkspace(ctx, {
    open: openAgentsWorkspace,
    options: {
      agents: wiring.source(ctx),
      openSource: (agent) => { opened.push(agent.key); return new FakeSource(agent.key); },
      createView: ({ ui, cwd: agentCwd }) => new FakeView(opened.at(-1) ?? "", ui, agentCwd),
      editorCommand,
    },
    providers: wiring.providers(ctx),
    ...(options.initialKey === undefined ? {} : { initialKey: options.initialKey }),
    actionUi: (onNotify) => createPiActionUi(ctx, { reportBlocked: (active, label) => { blocked.push(active ? `blocked ${label ?? ""}` : "unblocked"); }, editorCommand, onNotify }),
    hasContent: wiring.hasContent,
    onEmpty: () => { wiring.onEmpty(ctx); },
  });
  // A case that failed half way must not leave its loop holding the workspace for the next case.
  t.after(async () => {
    controller.abort();
    // Pi closes what it shows when the session ends; an action waiting on it then ends too.
    for (const custom of [...pi.customs]) custom.close();
    const ended = await Promise.race([done.then(() => true, () => true), new Promise<boolean>((resolve) => { setTimeout(() => { resolve(false); }, 2000); })]);
    assert.ok(ended, `the command ended after the case; Pi saw:\n${pi.events.join("\n")}`);
  });
  return { pi, done, blocked, opened };
}

const WORKSPACE_PLACEHOLDER = "opening agents…";
/** The workspace is Pi's custom component and reads the terminal: not stepped aside, not in its external editor. */
function workspaceOpen(pi: FakePi): boolean { return pi.terminal.input !== undefined && pi.customs.some(({ component }) => component.render(40)[0] === WORKSPACE_PLACEHOLDER); }
/** The title row without the session totals the workspace right-aligns after two or more spaces. */
function titleOf(pi: FakePi): string { return (pi.screen()[0] ?? "").replace(/ {2,}\S.*$/, "").trimEnd(); }
/** Waits until the workspace is open, listed, with `title` in its title row. */
async function shown(pi: FakePi, title: RegExp): Promise<void> {
  await until(() => workspaceOpen(pi) && title.test(titleOf(pi)), () => `the workspace open on ${String(title)}; it shows:\n${workspaceOpen(pi) ? pi.screen().join("\n") : "nothing"}\nPi saw:\n${pi.events.join("\n")}`);
}
/** The status row under the right pane, without the sidebar. */
function statusRow(pi: FakePi): string { return (pi.screen().at(-2) ?? "").replace(/^.*│/, "").trim(); }
/** The status row shows `notices`, joined as the workspace joins them and cut at the pane's width. */
function statusShows(pi: FakePi, notices: readonly string[]): void {
  const row = statusRow(pi);
  const expected = notices.join(" · ");
  assert.ok(row === expected || (row.endsWith("…") && expected.startsWith(row.slice(0, -1))), `status row ${JSON.stringify(row)} for ${JSON.stringify(expected)}`);
}
/** The sidebar rows of the nodes (no rules, no empty rows). */
function sidebarRows(pi: FakePi): string[] {
  return pi.screen().slice(1, -1).map((line) => line.includes("│") ? line.slice(0, line.indexOf("│")).trimEnd() : "").filter((line) => line && !/^─+$/.test(line));
}

const MENU_HEADING = /─ (Run actions|Agent actions|Subagent actions|Subagents) ─/;
/** The open action menu cut out of the screen: heading, rows, closing rule; [] while none is open. */
function menu(pi: FakePi): string[] {
  const lines = pi.screen();
  const top = lines.findIndex((line) => MENU_HEADING.test(line));
  if (top < 0) return [];
  const columns = pi.terminal.columns;
  const width = Math.min(Math.max(Math.floor(columns / 2), 32), columns - 2);
  const column = (lines[top] ?? "").search(MENU_HEADING);
  const block: string[] = [];
  for (const line of lines.slice(top)) {
    const cell = line.slice(column, column + width).trimEnd();
    block.push(cell);
    if (block.length > 1 && /^─+$/.test(cell)) break;
  }
  return block;
}
/** The menu's heading text and its rows without the closing rule. */
function menuRows(pi: FakePi): string[] {
  const block = menu(pi);
  return block.length === 0 ? [] : [(block[0] ?? "").replace(/─/g, "").trim(), ...block.slice(1, -1)];
}
/** The open menu sits clear of the title row and the hint row: its heading from row 1, its closing rule by row rows - 2. */
function menuClear(pi: FakePi): void {
  const lines = pi.screen();
  const block = menu(pi);
  const top = lines.findIndex((line) => MENU_HEADING.test(line));
  const bottom = top + block.length - 1;
  assert.ok(top >= 1 && /^─+$/.test(block.at(-1) ?? "") && bottom <= lines.length - 2, `the menu (rows ${String(top)} to ${String(bottom)}) clear of the title and the hint:\n${lines.join("\n")}`);
}
/** a on the selected node: the menu once its labels came. */
async function menuOf(pi: FakePi, key = "a"): Promise<string[]> {
  pi.send(key);
  await until(() => { const rows = menuRows(pi); return rows.length > 1 && rows[1] !== "loading…"; }, () => `the menu's labels:\n${pi.screen().join("\n")}`);
  return menuRows(pi);
}
function labelsOf(rows: readonly string[]): string[] { return rows.slice(1).map((row) => row.replace(/^(→ | {2})/, "")); }
/** Opens the menu of the selected node and runs `label`. */
async function choose(pi: FakePi, label: string): Promise<void> {
  const labels = labelsOf(await menuOf(pi));
  const index = labels.indexOf(label);
  assert.ok(index >= 0, `${label} offered: ${labels.join(", ")}`);
  pi.send(...Array.from({ length: index }, () => KEY.down), KEY.enter);
}
/** Runs a label that needs Pi's dialogs: what Pi saw from the workspace closing ("done") to it opening again on `title` ("custom"). */
async function stepAside(pi: FakePi, label: string, title: RegExp): Promise<string[]> {
  const mark = pi.events.length;
  await choose(pi, label);
  assert.equal(pi.events[mark], "done", "the workspace left before the action ran");
  await shown(pi, title);
  return pi.events.slice(mark);
}
/** The custom component an action shows once the workspace stepped aside. */
async function piCustom(pi: FakePi): Promise<PendingCustom> {
  await until(() => pi.customs.length === 1 && !workspaceOpen(pi), () => `Pi's custom component; Pi saw:\n${pi.events.join("\n")}`);
  const custom = pi.customs[0];
  assert.ok(custom);
  return custom;
}
function press(custom: PendingCustom, ...keys: string[]): void { for (const key of keys) custom.component.handleInput?.(key); }
/** Waits until the workspace takes keys again, an in-place action settled: a opens the menu, esc closes it. Ends the notices. */
async function idle(pi: FakePi): Promise<void> {
  await until(() => {
    if (!workspaceOpen(pi)) return false;
    if (menu(pi).length === 0) pi.send("a");
    return menu(pi).length > 0;
  }, "the workspace takes keys again");
  pi.send(KEY.escape);
}
/** The workspace's refresh tick: it lists the session again and shows `title`. */
async function refresh(t: TestContext, pi: FakePi, title: RegExp): Promise<void> {
  t.mock.timers.tick(1000);
  await shown(pi, title);
}
/** Selects the visible node whose title matches, from the top of the sidebar. */
function select(pi: FakePi, title: RegExp): void {
  for (let step = 0; step < 30; step += 1) pi.send(KEY.up);
  for (let step = 0; step < 30 && !title.test(titleOf(pi)); step += 1) pi.send(KEY.down);
  assert.match(titleOf(pi), title);
}
/** Leaves the workspace and checks that no dialog came over a pending custom and nothing escaped. */
async function finish(c: Command, escaped: readonly unknown[]): Promise<void> {
  await until(() => workspaceOpen(c.pi), "the workspace open to leave it");
  c.pi.send(KEY.ctrlC);
  await c.done;
  assert.deepEqual(c.pi.violations, [], "no dialog over a pending custom component");
  assert.deepEqual(escaped, []);
}

const EDITOR_SCRIPT = `import { readFileSync, renameSync, writeFileSync } from "node:fs";
const [opened, code, file] = process.argv.slice(2);
writeFileSync(opened + ".part", readFileSync(file, "utf8"));
renameSync(opened + ".part", opened);
process.exit(Number(code));
`;
/** An external editor that copies the artifact it gets to `opened(round)` and exits with `code`; `missing` names one that cannot start. */
interface ExternalEditor { command(round: number, code: number): string; opened(round: number): string; readonly missing: string }
function externalEditor(): ExternalEditor {
  const directory = temporary("editor");
  const script = join(directory, "editor.mjs");
  writeFileSync(script, EDITOR_SCRIPT);
  const opened = (round: number): string => join(directory, `opened-${String(round)}`);
  return { command: (round, code) => `${process.execPath} ${script} ${opened(round)} ${String(code)}`, opened, missing: join(directory, "missing-editor") };
}
/**
 * Every editor label of `labels` ([node title, label, artifact]) in place, with an editor that exits with code 3, one that cannot
 * start and none configured: the dashboards' notice for each in the status row, and nothing asked of Pi.
 */
async function editorFailures(pi: FakePi, external: ExternalEditor, use: (command: string | undefined) => void, labels: readonly (readonly [RegExp, string, string])[]): Promise<void> {
  const mark = pi.events.length;
  for (const [title, label, artifact] of labels) {
    for (const [command, failure] of [[external.command(99, 3), "external editor exited with code 3"], [external.missing, "external editor could not be started"], [undefined, "no external editor is configured"]] as const) {
      select(pi, title);
      use(command);
      await choose(pi, label);
      const notice = `Cannot open ${artifact}: ${failure}.`;
      await until(() => workspaceOpen(pi) && statusRow(pi) === notice, () => `${label}: ${JSON.stringify(notice)} in the status row, not ${JSON.stringify(workspaceOpen(pi) ? statusRow(pi) : "")}`);
    }
  }
  assert.deepEqual(pi.events.slice(mark), [], "in place: Pi was asked nothing");
}

void test("the fake Pi shows one custom component at a time, as Pi: a dialog or another custom over a pending one throws and is noted", async () => {
  const pi = fakePi();
  let close = (): void => undefined;
  const shownCustom = pi.ctx.ui.custom<undefined>((_tui, _theme, _keybindings, done) => { close = () => { done(undefined); }; return { render: () => [], invalidate() {} }; });
  assert.throws(() => pi.ctx.ui.confirm("Delete workflow?", "Delete it?"), /would replace a pending custom component/);
  assert.throws(() => pi.ctx.ui.select("Resume wf", ["Foreground"]), /would replace a pending custom component/);
  assert.throws(() => pi.ctx.ui.input("Budget patch (JSON)"), /would replace a pending custom component/);
  assert.throws(() => pi.ctx.ui.custom(() => ({ render: () => [], invalidate() {} })), /would replace a pending custom component/);
  assert.deepEqual(pi.violations, ["confirm Delete workflow? | Delete it?", "select Resume wf | Foreground", "input Budget patch (JSON) | ", "custom"]);
  close();
  await shownCustom;
  pi.answers.confirm = () => true;
  assert.equal(await pi.ctx.ui.confirm("Delete workflow?", "Delete it?"), true, "once it closed, Pi's dialog shows");
  assert.equal(pi.violations.length, 4);
});

// ---------------------------------------------------------------- /workflow

interface WorkflowFixture { readonly home: string; readonly cwd: string; readonly deps: WorkflowActionDependencies; readonly copied: string[]; readonly calls: unknown[][] }
function workflowFixture(overrides: Partial<WorkflowActionDependencies> = {}): WorkflowFixture {
  const home = temporary("workflow");
  const cwd = join(home, "project");
  mkdirSync(cwd, { recursive: true });
  const copied: string[] = [];
  const calls: unknown[][] = [];
  const deps: WorkflowActionDependencies = {
    home,
    clipboard: async (value: string) => { copied.push(value); },
    extensionAgentDir: join(home, "agent"),
    runs: new Map<string, WorkflowRunRecord>(),
    terminalRunStates: new Map<string, HardTerminalRunState>(),
    hardTerminalRunStates: HARD_TERMINAL_RUN_STATES,
    answerCheckpoint: async (...args: unknown[]) => { calls.push(["answerCheckpoint", ...args]); return true; },
    recovery: { answerBudgetDecision: async (runId: string, proposalId: string, approved: boolean, ...rest: unknown[]) => { calls.push(["answerBudgetDecision", runId, proposalId, approved, ...rest]); return proposalId.startsWith("missing") ? undefined : { approved }; } } as unknown as WorkflowActionDependencies["recovery"],
    stopWorkflowRun: async (runId: string) => { calls.push(["stopWorkflowRun", runId]); return { runId, state: "stopped", stopped: true }; },
    moveForegroundToBackground: async (runId: string) => { calls.push(["moveForegroundToBackground", runId]); return { runId, state: "running" as const, detached: true as const }; },
    isForegroundAttached: () => false,
    liveAgents: { get: () => undefined, overlay: (run: PersistedRun) => run },
    registry: { agentAttemptActions: () => ({}) } as unknown as WorkflowActionDependencies["registry"],
    projectTrusted: () => false,
    resumeHostContext: () => ({ model: undefined, modelRegistry: { getAvailable: () => [{ provider: "openai", id: "gpt" }] } }) as unknown as ReturnType<WorkflowActionDependencies["resumeHostContext"]>,
    resumeSelectedWorkflow: async (...args: unknown[]) => { calls.push(["resumeSelectedWorkflow", ...args]); return { workflowName: "wf", state: "running" as const, attached: false }; },
    ...overrides,
  };
  return { home, cwd, deps, copied, calls };
}
function launch(options: { readonly phases?: readonly string[]; readonly script?: string } = {}): Readonly<LaunchSnapshot> {
  return createLaunchSnapshot({ script: options.script ?? "return true;", args: null, metadata: { name: "wf" }, settings: DEFAULT_SETTINGS, models: ["openai/gpt"], tools: [], agentConfigurations: {}, schemas: [], ...(options.phases === undefined ? {} : { phases: [...options.phases] }) });
}
async function createRun(f: WorkflowFixture, id: string, state: RunState, extra: Partial<PersistedRun> = {}, snapshot = launch()): Promise<RunStore> {
  const store = new RunStore(f.cwd, SESSION, id, f.home);
  await store.create({ id, workflowName: `${id}-name`, cwd: f.cwd, sessionId: SESSION, state, agents: [], agentSessions: [], ...extra }, snapshot);
  return store;
}
async function setState(store: RunStore, state: RunState): Promise<void> { await store.saveState({ ...(await store.load()).run, state }); }
/** The run's live record with the lifecycle Pause and Cancel pause drive; a pause leaves it `onPause`. */
function liveRun(f: WorkflowFixture, store: RunStore, onPause: "pausing" | "paused" = "pausing"): { state: string } {
  const lifecycle = { state: "running", async pause() { lifecycle.state = onPause; }, async resume() { lifecycle.state = "running"; } };
  f.deps.runs.set(store.runId, { store, metadata: { name: `${store.runId}-name` }, lifecycle, budget: { usage: { tokens: 0, costUsd: 0, durationMs: 0, agentLaunches: 0 } }, abortController: new AbortController() } as unknown as WorkflowRunRecord);
  return lifecycle;
}
const ATTEMPT: AgentAttemptSummary = { attempt: 1, transport: "local", session: { transport: "local", sessionId: "native", locator: { sessionFile: "/sessions/native.jsonl" } }, setup: { hookNames: [], model: { provider: "openai", model: "gpt" }, tools: [], cwd: "/repo" }, accounting: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 } };
function agentRecord(id: string, extra: Partial<AgentRecord> = {}): AgentRecord {
  return { id, name: id, path: id, state: "completed", model: { provider: "openai", model: "gpt" }, tools: [], attempts: 1, attemptDetails: [ATTEMPT], ...extra };
}
/** /workflow's workspace: its runs, the workflow provider, Pi's ActionUi. */
function workflows(t: TestContext, f: WorkflowFixture, options: CommandOptions = {}): Command {
  return command(t, f.cwd, options, {
    source: (ctx) => createSessionAgentsSource(ctx, { home: f.home, overlayRun: (run) => f.deps.liveAgents.overlay(run), liveAgent: () => undefined, subagents: () => undefined }, "workflows"),
    providers: (ctx) => [createWorkflowActionProvider(f.deps, ctx)],
    hasContent: (nodes) => nodes.length > 0,
    // /workflow shows its picker then (part 2); no case here deletes the last run.
    onEmpty: () => undefined,
  });
}
const STOP = "status workflow-stop -";

void test("/workflow: every node of a run offers the dashboard's run actions in the TUI, then Model aliases and the bulk deletes; an agent its actions; esc closes the menu as Back did", async (t) => {
  timers(t);
  const escaped = escapes(t);
  const startedAt = Date.now();
  const f = workflowFixture({ liveAgents: { get: () => undefined, overlay: (run) => run.id === "build" ? { ...run, activeShellsByPhase: [{ phaseIndex: 0, active: 1, startedAt }] } : run } });
  const build = await createRun(f, "build", "running", { agents: [agentRecord("api", { state: "running", structuralPath: ["p", "a"], prompt: "PROMPT" })], phase: "plan", phaseHistory: [{ phase: "plan", afterAgent: 0 }] }, launch({ phases: ["plan"] }));
  await createRun(f, "done", "completed");
  await createRun(f, "broken", "failed");
  const c = workflows(t, f, { initialKey: "run:build" });
  await shown(c.pi, /^build-name build running$/);
  // What the /workflow TUI dashboard offered on this run (its actions, then Back) and on its agent (then Back).
  const view = await loadWorkflowRunView(f.deps, c.pi.ctx, build);
  const dashboardRun = [...view.actions.keys()];
  const api = view.run.agents[0];
  assert.ok(api);
  const dashboardAgent = agentActionOptions(f.deps, c.pi.ctx, view, api);
  assert.deepEqual(dashboardRun, ["Pause", "Stop", "Open script in editor", "Copy run path", "Copy run ID"]);
  assert.deepEqual(dashboardAgent, ["Open prompt in editor", "Copy agent ID", "Back"]);
  const nodes = (await createSessionAgentsSource(c.pi.ctx, { home: f.home, overlayRun: (run) => f.deps.liveAgents.overlay(run), liveAgent: () => undefined, subagents: () => undefined }, "workflows").list()).filter((node) => node.key.startsWith("run:build"));
  assert.deepEqual(nodes.map(({ kind }) => kind), ["run", "phase", "shell", "operation", "operation", "agent"], "a run header, a phase, a shell, operation scopes and an agent");
  for (const [index, node] of nodes.entries()) {
    if (index > 0) c.pi.send(KEY.down);
    if (node.agent) assert.match(titleOf(c.pi), /^#1\/1 api running/);
    else assert.equal(titleOf(c.pi), node.title(PLAIN_WORKFLOW_PROGRESS_STYLES));
    const offered = node.agent ? dashboardAgent.filter((label) => label !== "Back") : [...dashboardRun, "Model aliases", "Delete all completed", "Delete all failed"];
    assert.deepEqual(await menuOf(c.pi), [node.agent ? "Agent actions" : "Run actions", ...offered.map((label, row) => `${row === 0 ? "→" : " "} ${label}`)], node.agent ? "the agent's actions without Back" : `the run's actions on its ${node.kind}, then Model aliases and the bulk deletes`);
    c.pi.send(KEY.escape);
    assert.deepEqual(menu(c.pi), [], "esc closes the menu, as Back did");
  }
  assert.deepEqual(c.opened, ["run:build:api"], "selecting the agent shows its transcript");
  c.pi.send("d");
  assert.match(c.pi.screen()[1] ?? "", /│ State: running\s*$/, "d shows /workflow's agent details");
  // enter on the run header opens its menu, as the dashboard's enter on the root did.
  select(c.pi, /^build-name build running$/);
  assert.equal(labelsOf(await menuOf(c.pi, KEY.enter))[0], "Pause");
  c.pi.send(KEY.escape);
  assert.deepEqual(c.pi.events, ["custom"], "no action ran: Pi saw only the workspace");
  await finish(c, escaped);
});

void test("/workflow: Pause, Cancel pause and Move to background run with Pi back and notify there and in the status row of the workspace, open again on the run; a label gone meanwhile is reported", async (t) => {
  timers(t);
  const escaped = escapes(t);
  const f = workflowFixture({ isForegroundAttached: (runId) => runId === "build" });
  const build = await createRun(f, "build", "running");
  const lifecycle = liveRun(f, build);
  liveRun(f, await createRun(f, "quick", "running"), "paused");
  const c = workflows(t, f, { initialKey: "run:build" });
  await shown(c.pi, /^build-name build running$/);
  assert.deepEqual(labelsOf(await menuOf(c.pi)), ["Pause", "Move to background", "Stop", "Open script in editor", "Copy run path", "Copy run ID", "Model aliases"]);
  c.pi.send(KEY.escape);

  assert.deepEqual(await stepAside(c.pi, "Pause", /^build-name build running$/), ["done", "notify info: Pausing workflow build; it pauses once the active operation finishes.", STOP, "custom"]);
  assert.equal(lifecycle.state, "pausing");
  statusShows(c.pi, ["Pausing workflow build; it pauses once the active operation finishes."]);

  // The open menu reads its labels again on every refresh and keeps the selected one, as the dashboard's menu did.
  await menuOf(c.pi);
  c.pi.send(KEY.down, KEY.down);
  assert.equal(menuRows(c.pi)[3], "→ Stop");
  await setState(build, "pausing");
  await refresh(t, c.pi, /^build-name build pausing$/);
  await until(() => menuRows(c.pi)[1] === "  Cancel pause", () => `the refresh read the labels again:\n${menuRows(c.pi).join("\n")}`);
  assert.deepEqual(menuRows(c.pi).slice(0, 4), ["Run actions", "  Cancel pause", "  Move to background", "→ Stop"], "Stop still selected");
  c.pi.send(KEY.escape);
  assert.deepEqual(await stepAside(c.pi, "Cancel pause", /^build-name build pausing$/), ["done", "notify info: Cancelled the pending pause of workflow build.", STOP, "custom"]);
  assert.equal(lifecycle.state, "running");
  statusShows(c.pi, ["Cancelled the pending pause of workflow build."]);

  await setState(build, "running");
  assert.deepEqual(await stepAside(c.pi, "Move to background", /^build-name build running$/), ["done", "notify info: Moved workflow build to background.", STOP, "custom"]);
  assert.deepEqual(f.calls, [["moveForegroundToBackground", "build"]]);
  statusShows(c.pi, ["Moved workflow build to background."]);

  select(c.pi, /^quick-name quick running$/);
  assert.deepEqual(await stepAside(c.pi, "Pause", /^quick-name quick running$/), ["done", "notify info: Paused workflow quick.", STOP, "custom"], "a pause that takes effect at once");

  // The run finished while its menu was open: the label is checked again before it runs.
  select(c.pi, /^build-name build running$/);
  await menuOf(c.pi);
  await setState(build, "completed");
  const mark = c.pi.events.length;
  c.pi.send(KEY.enter);
  await shown(c.pi, /^build-name build completed$/);
  assert.deepEqual(c.pi.events.slice(mark), ["done", "notify warning: Pause is no longer available.", "custom"], "nothing ran, so no status to clear");
  statusShows(c.pi, ["Pause is no longer available."]);
  assert.equal(lifecycle.state, "running", "nothing paused");
  await finish(c, escaped);
});

void test("/workflow: Resume asks the mode as the dashboard did; Foreground keeps Pi's screen until the run settles or reports it running; Background, Cancel, a failure and an attached failure", async (t) => {
  timers(t);
  const escaped = escapes(t);
  const f = workflowFixture();
  await createRun(f, "paused", "paused");
  await createRun(f, "inter", "interrupted");
  let release = (): void => undefined;
  const results: (() => Promise<{ workflowName: string; state: "running" | "completed" | "awaiting_approval"; attached: boolean; value?: string }>)[] = [
    async () => ({ workflowName: "paused-name", state: "running", attached: false }),
    async () => { await new Promise<void>((resolve) => { release = resolve; }); return { workflowName: "paused-name", state: "completed", attached: false, value: "done" }; },
    async () => { throw new Error("resume exploded"); },
    async () => { throw Object.assign(new Error("attached failure"), { workflowResumeAttached: true }); },
    async () => ({ workflowName: "paused-name", state: "running", attached: false }),
  ];
  const resumes: unknown[][] = [];
  f.deps.resumeSelectedWorkflow = async (runId, foreground, context, patch) => { resumes.push([runId, foreground, context, patch]); const next = results.shift(); assert.ok(next); return next(); };
  const modes = ["Cancel", "Background", "Foreground", "Background", "Foreground", "Foreground"];
  const c = workflows(t, f, { initialKey: "run:paused" });
  c.pi.answers.select = (title) => title.startsWith("Resume ") ? modes.shift() : undefined;
  await shown(c.pi, /^paused-name paused paused$/);
  const mode = "select Resume paused-name | Foreground, Background, Cancel";

  assert.deepEqual(await stepAside(c.pi, "Resume", /^paused-name paused/), ["done", mode, STOP, "custom"], "Cancel resumes nothing");
  assert.equal(statusRow(c.pi), "");
  assert.deepEqual(await stepAside(c.pi, "Resume", /^paused-name paused/), ["done", mode, "notify info: Resumed workflow paused-name in background.", STOP, "custom"]);
  statusShows(c.pi, ["Resumed workflow paused-name in background."]);

  const mark = c.pi.events.length;
  await choose(c.pi, "Resume");
  await until(() => resumes.length === 2, "the Foreground resume started");
  await new Promise((resolve) => { setTimeout(resolve, 30); });
  assert.deepEqual(c.pi.events.slice(mark), ["done", mode], "Pi's screen stays while the run goes on: no workspace, no notice");
  assert.equal(c.pi.customs.length, 0);
  assert.equal(c.pi.parent.at(-1), "renderNow:false", "Pi's TUI is back");
  release();
  await shown(c.pi, /^paused-name paused/);
  assert.deepEqual(c.pi.events.slice(mark), ["done", mode, "notify info: Workflow paused-name completed: \"done\"", STOP, "custom"], "the workspace opens once the run settled");
  statusShows(c.pi, ["Workflow paused-name completed: \"done\""]);

  const failed = await stepAside(c.pi, "Resume", /^paused-name paused/);
  assert.equal(failed.length, 5);
  assert.match(failed[2] ?? "", /^notify warning: Cannot resume workflow paused: [\s\S]*resume exploded/);
  assert.match(statusRow(c.pi), /^Cannot resume workflow paused: /);
  assert.deepEqual(await stepAside(c.pi, "Resume", /^paused-name paused/), ["done", mode, STOP, "custom"], "an attached failure stays silent");
  assert.equal(statusRow(c.pi), "");
  assert.deepEqual(await stepAside(c.pi, "Resume", /^paused-name paused/), ["done", mode, "notify info: Resumed workflow paused-name in foreground.", STOP, "custom"], "a Foreground resume that returns while the run goes on");
  statusShows(c.pi, ["Resumed workflow paused-name in foreground."]);
  assert.deepEqual(resumes.map(([runId, foreground, context, patch]) => [runId, foreground, context === c.pi.ctx, patch]), [["paused", false, true, undefined], ["paused", true, true, undefined], ["paused", false, true, undefined], ["paused", true, true, undefined], ["paused", true, true, undefined]], "with the command's context");

  select(c.pi, /^inter-name inter interrupted$/);
  assert.equal(labelsOf(await menuOf(c.pi))[0], "Resume", "an interrupted run resumes too");
  c.pi.send(KEY.escape);
  await finish(c, escaped);
});

void test("/workflow: a run out of budget offers Resume unchanged, Adjust budget with its patch, its parse error and a cancelled patch, and approves or rejects a budget proposal", async (t) => {
  timers(t);
  const escaped = escapes(t);
  const f = workflowFixture();
  const exhausted = await createRun(f, "spent", "budget_exhausted");
  for (const proposalId of ["approve-1234567890", "reject-12345678901", "missing-123456789"]) await exhausted.requestWorkflowDecision({ kind: "budget", proposalId, runId: "spent", consumed: { tokens: 1, costUsd: 0, durationMs: 0, agentLaunches: 0 }, previous: { tokens: { hard: 1 } }, proposed: { tokens: { hard: 2 } }, budgetVersion: 1 });
  const results: { workflowName: string; state: "running" | "awaiting_approval"; attached: boolean }[] = [{ workflowName: "spent-name", state: "awaiting_approval", attached: false }, { workflowName: "spent-name", state: "running", attached: false }];
  const resumes: unknown[][] = [];
  f.deps.resumeSelectedWorkflow = async (runId, foreground, _context, patch) => { resumes.push([runId, foreground, patch]); const next = results.shift(); assert.ok(next); return next; };
  const c = workflows(t, f, { initialKey: "run:spent" });
  const modes = ["Foreground", "Background", "Background", "Background"];
  const patches: (string | undefined)[] = ["{not json", undefined, "{\"tokens\":{\"hard\":3}}"];
  c.pi.answers.select = () => modes.shift();
  c.pi.answers.input = () => patches.shift();
  const title = /^spent-name spent budget_exhausted$/;
  await shown(c.pi, title);
  assert.deepEqual(labelsOf(await menuOf(c.pi)), ["Resume unchanged", "Adjust budget", "Approve budget approve-", "Reject budget approve-", "Approve budget reject-1", "Reject budget reject-1", "Approve budget missing-", "Reject budget missing-", "Stop", "Open script in editor", "Copy run path", "Copy run ID", "Model aliases"]);
  c.pi.send(KEY.escape);
  const mode = "select Resume spent-name | Foreground, Background, Cancel";
  const input = "input Budget patch (JSON) | {\"tokens\":{\"hard\":null}}";

  assert.deepEqual(await stepAside(c.pi, "Resume unchanged", title), ["done", mode, "notify warning: Budget adjustment for spent-name is awaiting approval.", STOP, "custom"]);
  statusShows(c.pi, ["Budget adjustment for spent-name is awaiting approval."]);
  const unparsable = await stepAside(c.pi, "Adjust budget", title);
  assert.deepEqual([unparsable.slice(0, 3), unparsable.slice(4)], [["done", mode, input], [STOP, "custom"]]);
  assert.match(unparsable[3] ?? "", /^notify warning: Cannot parse budget patch: /);
  assert.match(statusRow(c.pi), /^Cannot parse budget patch: /);
  assert.deepEqual(await stepAside(c.pi, "Adjust budget", title), ["done", mode, input, STOP, "custom"], "a cancelled patch resumes nothing, silently");
  assert.equal(statusRow(c.pi), "");
  assert.deepEqual(await stepAside(c.pi, "Adjust budget", title), ["done", mode, input, "notify info: Resumed workflow spent-name in background.", STOP, "custom"]);
  assert.deepEqual(resumes, [["spent", true, undefined], ["spent", false, { tokens: { hard: 3 } }]], "a patch that cannot be parsed resumes nothing");

  assert.deepEqual(await stepAside(c.pi, "Approve budget approve-", title), ["done", "notify info: Budget adjustment approve-1234567890 approved.", STOP, "custom"]);
  assert.deepEqual(await stepAside(c.pi, "Reject budget reject-1", title), ["done", "notify info: Budget adjustment reject-12345678901 rejected.", STOP, "custom"]);
  statusShows(c.pi, ["Budget adjustment reject-12345678901 rejected."]);
  assert.deepEqual(await stepAside(c.pi, "Approve budget missing-", title), ["done", "notify warning: Budget proposal is not pending.", STOP, "custom"]);
  const decisions = f.calls.filter(([name]) => name === "answerBudgetDecision");
  assert.deepEqual(decisions.map((call) => call.slice(1, 5)), [["spent", "approve-1234567890", true, true], ["spent", "reject-12345678901", false, true], ["spent", "missing-123456789", true, true]]);
  assert.ok(decisions.every((call) => call[5] === c.pi.ctx && call[6] === undefined && call[7] === false), "with the command's context, without waiting for the run");
  await finish(c, escaped);
});

void test("/workflow: Stop confirms with Pi's dialog and reportBlocked, shows its progress in Pi's status and clears it before the workspace opens again on the stopped run; a decline and a failure", async (t) => {
  timers(t);
  const escaped = escapes(t);
  const f = workflowFixture();
  const build = await createRun(f, "build", "running");
  liveRun(f, build);
  liveRun(f, await createRun(f, "stuck", "running"));
  f.deps.stopWorkflowRun = async (runId) => {
    f.calls.push(["stopWorkflowRun", runId]);
    if (runId === "stuck") throw new Error("cleanup failed");
    await setState(build, "stopped");
    return { runId, state: "stopped", stopped: true };
  };
  const c = workflows(t, f, { initialKey: "run:build" });
  await shown(c.pi, /^build-name build running$/);
  const confirm = "confirm Stop workflow? | Stop workflow build-name (build)? This cannot be undone.";

  assert.deepEqual(await stepAside(c.pi, "Stop", /^build-name build running$/), ["done", confirm, STOP, "custom"], "declined: nothing stops");
  assert.deepEqual(c.blocked, ["blocked Stop workflow?", "unblocked"]);
  assert.deepEqual(f.calls, []);

  c.pi.answers.confirm = () => true;
  assert.deepEqual(await stepAside(c.pi, "Stop", /^build-name build stopped$/), ["done", confirm, "status workflow-stop Stopping workflow build-name...", "status workflow-stop Workflow build stopped.", "notify info: Stopped workflow build.", STOP, "custom"], "the status set, then cleared before the workspace is back");
  statusShows(c.pi, ["Stopped workflow build."]);
  assert.deepEqual(f.calls, [["stopWorkflowRun", "build"]]);
  assert.equal(labelsOf(await menuOf(c.pi)).includes("Stop"), false, "a stopped run offers no Stop");
  c.pi.send(KEY.escape);

  select(c.pi, /^stuck-name stuck running$/);
  assert.deepEqual(await stepAside(c.pi, "Stop", /^stuck-name stuck running$/), ["done", "confirm Stop workflow? | Stop workflow stuck-name (stuck)? This cannot be undone.", "status workflow-stop Stopping workflow stuck-name...", "status workflow-stop Could not stop workflow stuck: cleanup failed", "notify warning: Cannot stop for stuck: cleanup failed", STOP, "custom"]);
  statusShows(c.pi, ["Cannot stop for stuck: cleanup failed"]);
  assert.deepEqual(c.blocked, ["blocked Stop workflow?", "unblocked", "blocked Stop workflow?", "unblocked", "blocked Stop workflow?", "unblocked"]);
  await finish(c, escaped);
});

void test("/workflow: Review shows the checkpoint in Pi's bordered overlay at every height, answers Approve or Reject, does nothing on esc and warns when it is no longer awaited", async (t) => {
  timers(t);
  const escaped = escapes(t);
  const f = workflowFixture();
  const waiting = await createRun(f, "waiting", "awaiting_input");
  await waiting.awaitCheckpoint({ path: "checkpoint/ship", name: "ship", prompt: "Ship it?", context: null });
  const c = workflows(t, f, { initialKey: "run:waiting" });
  const title = /^waiting-name waiting awaiting_input$/;
  await shown(c.pi, title);
  assert.deepEqual(labelsOf(await menuOf(c.pi)), ["Stop", "Review ship", "Open script in editor", "Copy run path", "Copy run ID", "Model aliases"]);
  c.pi.send(KEY.escape);

  let mark = c.pi.events.length;
  await choose(c.pi, "Review ship");
  const review = await piCustom(c.pi);
  assert.deepEqual(review.options, { overlay: true, overlayOptions: { anchor: "top-left", width: "100%", maxHeight: "100%", margin: { top: 1 } } });
  const frame = (rows: number): string[] => { c.pi.terminal.rows = rows; return review.component.render(60).map((line) => line.trimEnd()); };
  const compact = frame(5);
  assert.equal(compact.length, 5);
  assert.deepEqual(compact.slice(1, 4), ["Name: ship", "Prompt:", "[Approve]  Reject   Cancel"], "below 4 rows inside the border the options share a row");
  assert.deepEqual(frame(7).slice(1, -1), ["Checkpoint review", "Name: ship", "→ Approve", "  Reject", "  Cancel"], "the title from 5 rows");
  const tall = frame(10);
  assert.deepEqual(tall.slice(1, -2), ["Checkpoint review", "Name: ship", "Prompt:", "", "→ Approve", "  Reject", "  Cancel"]);
  assert.match(tall.at(-2) ?? "", /↑\/k\/↓\/j\/pgup\/pgdn scroll · enter select · esc cancel$/, "the hint from 8 rows");
  assert.match(tall[0] ?? "", /^─{60}$/);
  c.pi.terminal.rows = 20;
  press(review, KEY.down, KEY.enter);
  await shown(c.pi, title);
  assert.deepEqual(c.pi.events.slice(mark), ["done", "custom", "done", STOP, "custom"], "the overlay only once the workspace left; the workspace only once it closed");
  assert.deepEqual(f.calls, [["answerCheckpoint", "waiting", "ship", false, true]], "Reject");
  assert.equal(statusRow(c.pi), "");

  mark = c.pi.events.length;
  await choose(c.pi, "Review ship");
  press(await piCustom(c.pi), KEY.escape);
  await shown(c.pi, title);
  assert.deepEqual(c.pi.events.slice(mark), ["done", "custom", "done", STOP, "custom"]);
  assert.equal(f.calls.length, 1, "esc answers nothing");

  f.deps.answerCheckpoint = async (...args: unknown[]) => { f.calls.push(["answerCheckpoint", ...args]); return false; };
  mark = c.pi.events.length;
  await choose(c.pi, "Review ship");
  press(await piCustom(c.pi), KEY.enter);
  await shown(c.pi, title);
  assert.deepEqual(c.pi.events.slice(mark), ["done", "custom", "done", "notify warning: Checkpoint is not awaiting a response.", STOP, "custom"]);
  assert.deepEqual(f.calls.at(-1), ["answerCheckpoint", "waiting", "ship", true, true], "Approve");
  statusShows(c.pi, ["Checkpoint is not awaiting a response."]);
  await finish(c, escaped);
});

void test("/workflow: Copy run path, Copy run ID and Open script in editor run inside the workspace: copies, the external editor's notices and a missing script show in its status row, Pi is never asked", async (t) => {
  timers(t);
  const escaped = escapes(t);
  const external = externalEditor();
  let editor: string | undefined;
  const f = workflowFixture();
  const build = await createRun(f, "build", "running", {}, launch({ script: "// SCRIPT\nreturn 1;" }));
  const c = workflows(t, f, { initialKey: "run:build", editorCommand: () => editor });
  await shown(c.pi, /^build-name build running$/);
  const mark = c.pi.events.length;
  const inPlace = async (label: string, notice: string): Promise<void> => {
    await choose(c.pi, label);
    await until(() => workspaceOpen(c.pi) && statusRow(c.pi) === notice, () => `${label}: ${JSON.stringify(notice)} in the status row, not ${JSON.stringify(workspaceOpen(c.pi) ? statusRow(c.pi) : "")}`);
  };
  await inPlace("Copy run path", "Copied run path.");
  await inPlace("Copy run ID", "Copied run ID.");
  assert.deepEqual(f.copied, [build.directory, "build"]);

  editor = external.command(0, 0);
  await choose(c.pi, "Open script in editor");
  await until(() => existsSync(external.opened(0)), "the editor started");
  assert.equal(readFileSync(external.opened(0), "utf8"), readFileSync(join(build.directory, "workflow.js"), "utf8"));
  assert.match(readFileSync(external.opened(0), "utf8"), /SCRIPT/);
  await idle(c.pi);
  await editorFailures(c.pi, external, (command) => { editor = command; }, [[/^build-name build running$/, "Open script in editor", "workflow script"]]);
  assert.deepEqual(c.pi.events.slice(mark), [], "in place: the workspace never left and Pi was asked nothing");
  assert.deepEqual(c.pi.parent, ["stop:true"], "Pi's TUI stayed stopped while the editor ran");

  f.deps.clipboard = async () => { throw new Error("no clipboard"); };
  await inPlace("Copy run ID", "Failed to copy run ID: no clipboard");
  // The script went missing: Open script in editor reports it and starts no editor.
  rmSync(join(build.directory, "workflow.js"));
  editor = external.command(1, 0);
  await choose(c.pi, "Open script in editor");
  await until(() => workspaceOpen(c.pi) && statusRow(c.pi).startsWith("Cannot open workflow script: ENOENT"), () => `the missing script in the status row, not ${JSON.stringify(workspaceOpen(c.pi) ? statusRow(c.pi) : "")}`);
  assert.equal(existsSync(external.opened(1)), false, "no editor started");
  assert.deepEqual(c.pi.events.slice(mark), [], "Pi was asked nothing");
  await finish(c, escaped);
});

void test("/workflow: Delete confirms with Pi's dialog, deletes and opens the workspace on the node now at the run's row; it refuses a run a survivor depends on or that is no longer stopped, and reports one that went away", async (t) => {
  timers(t);
  const escaped = escapes(t);
  const f = workflowFixture();
  await createRun(f, "keep", "completed");
  const old = await createRun(f, "old", "completed");
  f.deps.terminalRunStates.set("old", "completed");
  const source = await createRun(f, "source", "failed");
  await source.complete("agent/replayable", "kept");
  await createRun(f, "retry-child", "interrupted", { workflowName: "retry", parentRunId: "source", retry: { sourceRunId: "source", lineageRootRunId: "source", completedPaths: ["agent/replayable"], incompletePaths: [], namedWorktrees: [] } });
  const flip = await createRun(f, "flip", "completed");
  const gone = await createRun(f, "gone", "completed");
  const c = workflows(t, f, { initialKey: "run:old" });
  await shown(c.pi, /^old-name old completed$/);
  const confirm = "confirm Delete workflow? | Delete old-name (old) and all owned artifacts? This cannot be undone.";

  assert.deepEqual(await stepAside(c.pi, "Delete", /^old-name old completed$/), ["done", confirm, STOP, "custom"], "declined");
  assert.deepEqual(c.blocked, ["blocked Delete workflow?", "unblocked"]);
  assert.equal(existsSync(old.directory), true);

  const before = sidebarRows(c.pi);
  const row = before.findIndex((line) => line.startsWith("→"));
  assert.ok(row >= 0 && row < before.length - 1, `the run is not the last row:\n${before.join("\n")}`);
  const next = `→${(before[row + 1] ?? "").slice(1)}`;
  c.pi.answers.confirm = () => true;
  const events = await stepAside(c.pi, "Delete", /./);
  assert.deepEqual(events, ["done", confirm, "notify info: Deleted workflow old.", STOP, "custom"]);
  assert.equal(existsSync(old.directory), false);
  assert.equal(f.deps.terminalRunStates.has("old"), false);
  await until(() => sidebarRows(c.pi)[row] === next, () => `the node now at the run's row is selected:\n${sidebarRows(c.pi).join("\n")}`);
  assert.equal(sidebarRows(c.pi).length, before.length - 1);
  statusShows(c.pi, ["Deleted workflow old."]);

  select(c.pi, /^source-name source failed$/);
  assert.deepEqual(await stepAside(c.pi, "Delete", /^source-name source failed$/), ["done", "confirm Delete workflow? | Delete source-name (source) and all owned artifacts? This cannot be undone.", "notify warning: Cannot delete workflow source: surviving workflow retry-child (retry) depends on it.", STOP, "custom"]);
  assert.equal(existsSync(source.directory), true);

  // The run was resumed after Delete was chosen and before it ran.
  select(c.pi, /^flip-name flip completed$/);
  c.pi.answers.confirm = async () => { await setState(flip, "running"); return true; };
  assert.deepEqual(await stepAside(c.pi, "Delete", /^flip-name flip running$/), ["done", "confirm Delete workflow? | Delete flip-name (flip) and all owned artifacts? This cannot be undone.", "notify warning: Stop the workflow before deleting it.", STOP, "custom"]);
  assert.equal(existsSync(flip.directory), true);

  // Another Pi deleted the run after Delete was confirmed and before its lock: reported, and the workspace opens on a node still there.
  select(c.pi, /^gone-name gone completed$/);
  c.pi.answers.confirm = async () => { await gone.delete(true); return true; };
  assert.deepEqual(await stepAside(c.pi, "Delete", /./), ["done", "confirm Delete workflow? | Delete gone-name (gone) and all owned artifacts? This cannot be undone.", "notify warning: Workflow gone is no longer available.", STOP, "custom"]);
  statusShows(c.pi, ["Workflow gone is no longer available."]);
  assert.equal(sidebarRows(c.pi).some((line) => line.includes("gone-name")), false);
  await finish(c, escaped);
});

void test("/workflow: Model aliases runs with Pi's dialogs: add, edit, delete, a manual model, an unknown model confirmed or not, with the dashboard's titles and notices", async (t) => {
  timers(t);
  const escaped = escapes(t);
  const f = workflowFixture();
  await createRun(f, "run", "running");
  const settingsPath = workflowSettingsPath(f.deps.extensionAgentDir);
  const c = workflows(t, f, { initialKey: "run:run" });
  const script: Record<"menu" | "target" | "input", (string | undefined)[]> = { menu: ["Add alias", "Edit fast", "Add alias", "Delete fast", "Back"], target: ["openai/gpt", "Manual model ID", "Manual model ID"], input: ["fast", "private/model:high", "portable", "private/other"] };
  c.pi.answers.select = (title) => (title.startsWith("Model aliases") ? script.menu : script.target).shift();
  c.pi.answers.input = () => script.input.shift();
  c.pi.answers.confirm = (title) => title !== "Save unknown model?" || script.input.length === 0;
  await shown(c.pi, /^run-name run running$/);
  const saved = `notify info: Saved model aliases to ${settingsPath}.`;
  const unknown = "confirm Save unknown model? | Save this target for cross-machine portability?";
  assert.deepEqual(await stepAside(c.pi, "Model aliases", /^run-name run running$/), [
    "done",
    "select Model aliases\n(none) | Add alias, Back",
    "input Alias name | reviewer-model",
    "select Model alias target | openai/gpt, Manual model ID, Back",
    saved,
    "select Model aliases\nfast = openai/gpt | Add alias, Edit fast, Delete fast, Back",
    "select Model alias target | openai/gpt, fast, Manual model ID, Back",
    "input Manual model ID | provider/model[:thinking] or alias[:thinking]",
    "notify warning: Warning: private/model:high is not currently available in Pi.",
    unknown,
    "select Model aliases\nfast = openai/gpt | Add alias, Edit fast, Delete fast, Back",
    "input Alias name | reviewer-model",
    "select Model alias target | openai/gpt, fast, Manual model ID, Back",
    "input Manual model ID | provider/model[:thinking] or alias[:thinking]",
    "notify warning: Warning: private/other is not currently available in Pi.",
    unknown,
    saved,
    "select Model aliases\nfast = openai/gpt\nportable = private/other | Add alias, Edit fast, Edit portable, Delete fast, Delete portable, Back",
    "confirm Delete model alias? | Delete fast? Future workflow resumes using this alias may fail.",
    saved,
    "select Model aliases\nportable = private/other | Add alias, Edit portable, Delete portable, Back",
    STOP,
    "custom",
  ]);
  const settings = JSON.parse(readFileSync(settingsPath, "utf8")) as { modelAliases?: Record<string, string> };
  assert.deepEqual(settings.modelAliases, { portable: "private/other" });
  statusShows(c.pi, [`Saved model aliases to ${settingsPath}.`, "Warning: private/model:high is not currently available in Pi.", "Warning: private/other is not currently available in Pi.", `Saved model aliases to ${settingsPath}.`, `Saved model aliases to ${settingsPath}.`]);
  await finish(c, escaped);
});

void test("/workflow: Delete all completed and Delete all failed confirm with Pi's dialog, skip runs a survivor needs, report what they deleted and a failure", async (t) => {
  timers(t);
  const escaped = escapes(t);
  const f = workflowFixture();
  const completed = await createRun(f, "done", "completed");
  const failedA = await createRun(f, "failed-a", "failed");
  const source = await createRun(f, "source", "failed");
  const child = await createRun(f, "child", "interrupted", { parentRunId: "source", retry: { sourceRunId: "source", lineageRootRunId: "source", completedPaths: [], incompletePaths: [], namedWorktrees: [] } });
  const c = workflows(t, f, { initialKey: "run:child" });
  const title = /^child-name child interrupted$/;
  await shown(c.pi, title);
  const confirmFailed = "confirm Delete failed runs? | Delete all failed workflow runs and their artifacts? This cannot be undone.";

  assert.deepEqual(await stepAside(c.pi, "Delete all failed", title), ["done", confirmFailed, STOP, "custom"], "declined");
  assert.equal(existsSync(failedA.directory), true);
  c.pi.answers.confirm = () => true;
  assert.deepEqual(await stepAside(c.pi, "Delete all failed", title), ["done", confirmFailed, "notify warning: Skipped failed runs required by surviving workflows: source (needed by child).", "notify info: Deleted 1 failed workflow run(s).", STOP, "custom"]);
  assert.equal(existsSync(failedA.directory), false);
  assert.equal(existsSync(source.directory), true);
  statusShows(c.pi, ["Skipped failed runs required by surviving workflows: source (needed by child).", "Deleted 1 failed workflow run(s)."]);

  f.deps.coordinateRunMutation = async () => { throw new Error("runs locked"); };
  const confirmCompleted = "confirm Delete completed runs? | Delete all completed workflow runs and their artifacts? This cannot be undone.";
  assert.deepEqual(await stepAside(c.pi, "Delete all completed", title), ["done", confirmCompleted, "notify warning: Cannot delete completed runs: runs locked", STOP, "custom"]);
  assert.equal(existsSync(completed.directory), true);
  f.deps.coordinateRunMutation = (task) => task();
  assert.deepEqual(await stepAside(c.pi, "Delete all completed", title), ["done", confirmCompleted, "notify info: Deleted 1 completed workflow run(s).", STOP, "custom"]);
  assert.equal(existsSync(completed.directory), false);
  assert.equal(existsSync(child.directory), true);
  assert.deepEqual(labelsOf(await menuOf(c.pi)).slice(-2), ["Model aliases", "Delete all failed"], "no completed run left to delete");
  c.pi.send(KEY.escape);
  assert.deepEqual(c.blocked, ["blocked Delete failed runs?", "unblocked", "blocked Delete failed runs?", "unblocked", "blocked Delete completed runs?", "unblocked", "blocked Delete completed runs?", "unblocked"]);
  await finish(c, escaped);
});

void test("/workflow: a registered agent action runs with Pi's dialogs and working message once the workspace stepped aside, and its failure is reported", async (t) => {
  timers(t);
  const escaped = escapes(t);
  const contexts: string[] = [];
  const actions: Record<string, AgentAttemptAction> = {
    inspect: { label: "Inspect attempt", visible: () => true, run: async (context) => {
      contexts.push(`${context.run.id}/${context.agent.id}/${String(context.attempt.attempt)}`);
      assert.equal(await context.ui.confirm("Sure?", "Really?"), true);
      assert.equal(await context.ui.select("Pick", ["a", "b"]), "b");
      assert.equal(await context.ui.input("Name", "hint"), "typed");
      context.ui.setWorkingMessage?.("working");
      context.ui.notify("from action");
    } },
    broken: { label: "Broken action", visible: () => true, run: () => { throw new Error("action exploded"); } },
  };
  const f = workflowFixture({ registry: { agentAttemptActions: () => actions } as unknown as WorkflowActionDependencies["registry"] });
  await createRun(f, "agents", "completed", { agents: [agentRecord("agent-1")] });
  const c = workflows(t, f, { initialKey: "run:agents:agent-1" });
  c.pi.answers = { confirm: () => true, select: (_title, options) => options.at(-1), input: () => "typed" };
  const title = /^#1\/1 agent-1 completed/;
  await shown(c.pi, title);
  assert.deepEqual(labelsOf(await menuOf(c.pi)), ["Inspect attempt", "Broken action", "Copy agent ID"]);
  c.pi.send(KEY.escape);
  assert.deepEqual(await stepAside(c.pi, "Inspect attempt", title), ["done", "confirm Sure? | Really?", "select Pick | a, b", "input Name | hint", "working working", "notify info: from action", STOP, "custom"]);
  assert.deepEqual(contexts, ["agents/agent-1/1"]);
  statusShows(c.pi, ["from action"]);
  assert.deepEqual(await stepAside(c.pi, "Broken action", title), ["done", "notify error: Agent attempt action failed: action exploded", STOP, "custom"]);
  statusShows(c.pi, ["Agent attempt action failed: action exploded"]);
  await finish(c, escaped);
});

void test("/workflow: an agent's copies and its prompt, system prompt and result editors run inside the workspace", async (t) => {
  timers(t);
  const escaped = escapes(t);
  const external = externalEditor();
  let round = 0;
  let editor: string | undefined;
  const f = workflowFixture();
  execFileSync("git", ["init", "-q", f.cwd]);
  execFileSync("git", ["-C", f.cwd, "config", "user.name", "test"]);
  execFileSync("git", ["-C", f.cwd, "config", "user.email", "test@example.com"]);
  writeFileSync(join(f.cwd, "tracked.txt"), "tracked\n");
  execFileSync("git", ["-C", f.cwd, "add", "."]);
  execFileSync("git", ["-C", f.cwd, "commit", "-qm", "initial"]);
  const store = new RunStore(f.cwd, SESSION, "agents", f.home);
  await store.create({ id: "agents", workflowName: "agents-name", cwd: f.cwd, sessionId: SESSION, state: "completed", agents: [agentRecord("agent-1", { prompt: "PROMPT", systemPrompt: "SYSTEM", resultPath: "agent/result", worktreeOwner: "owner" })], agentSessions: [] }, launch());
  await store.complete("agent/result", { answer: 42 });
  const { branch, path } = await store.worktree("owner");
  const c = workflows(t, f, { initialKey: "run:agents:agent-1", editorCommand: () => editor });
  const title = /^#1\/1 agent-1 completed/;
  await shown(c.pi, title);
  const mark = c.pi.events.length;
  assert.deepEqual(labelsOf(await menuOf(c.pi)), ["Copy branch", "Copy worktree path", "Open prompt in editor", "Open system prompt in editor", "Open result in editor", "Copy agent ID"]);
  c.pi.send(KEY.escape);
  for (const [label, notice] of [["Copy branch", "Copied branch."], ["Copy worktree path", "Copied worktree path."], ["Copy agent ID", "Copied agent ID."]] as const) {
    await choose(c.pi, label);
    await until(() => statusRow(c.pi) === notice, `${notice} in the status row`);
  }
  assert.deepEqual(f.copied, [branch, path, "agent-1"]);
  for (const [label, content] of [["Open prompt in editor", "PROMPT"], ["Open system prompt in editor", "SYSTEM"], ["Open result in editor", "{\n  \"answer\": 42\n}\n"]] as const) {
    editor = external.command(round, 0);
    await choose(c.pi, label);
    await until(() => existsSync(external.opened(round)), `${label} started the editor`);
    assert.equal(readFileSync(external.opened(round), "utf8"), content);
    await idle(c.pi);
    round += 1;
  }
  assert.deepEqual(c.pi.events.slice(mark), [], "in place: Pi was asked nothing");
  await editorFailures(c.pi, external, (command) => { editor = command; }, [[title, "Open prompt in editor", "agent prompt"], [title, "Open system prompt in editor", "agent system prompt"], [title, "Open result in editor", "agent result"]]);
  await finish(c, escaped);
});

void test("/workflow: the menu fits at 120, 70 and 40 columns; below 80 columns a acts on the selected node without the sidebar, in place and stepping aside", async (t) => {
  timers(t);
  const escaped = escapes(t);
  for (const columns of [120, 70, 40]) {
    const f = workflowFixture();
    const build = await createRun(f, "build", "running");
    const lifecycle = liveRun(f, build);
    await createRun(f, "done", "completed");
    const c = workflows(t, f, { columns, rows: 12, initialKey: "run:build" });
    await shown(c.pi, /^build-name build running$/);
    const fits = (): void => {
      const lines = c.pi.screen();
      assert.equal(lines.length, 12);
      assert.ok(lines.every((line) => visibleWidth(line) <= columns), `${String(columns)} columns:\n${lines.join("\n")}`);
    };
    assert.equal(c.pi.screen().some((line) => line.includes("done-name")), columns >= 80, "the sidebar shows from 80 columns");
    const rows = await menuOf(c.pi);
    fits();
    assert.deepEqual(rows, ["Run actions", "→ Pause", "  Stop", "  Open script in editor", "  Copy run path", "  Copy run ID", "  Model aliases", "  Delete all completed"], `${String(columns)} columns`);
    menuClear(c.pi);
    c.pi.send(KEY.up);
    assert.equal(menuRows(c.pi).at(-1), "→ Delete all completed", "↑ wraps to the last label, in view");
    menuClear(c.pi);
    c.pi.send(KEY.escape);
    await choose(c.pi, "Copy run ID");
    await until(() => statusRow(c.pi) === "Copied run ID.", "the copy's notice");
    fits();
    assert.deepEqual(await stepAside(c.pi, "Pause", /^build-name build running$/), ["done", "notify info: Pausing workflow build; it pauses once the active operation finishes.", STOP, "custom"]);
    assert.equal(lifecycle.state, "pausing");
    statusShows(c.pi, ["Pausing workflow build; it pauses once the active operation finishes."]);
    fits();
    await finish(c, escaped);
  }
});

// ---------------------------------------------------------------- /subagents

const SUBAGENT_ATTEMPT: AgentAttemptSummary = { attempt: 1, transport: "fixture", setup: { hookNames: [], model: { provider: "fixture", model: "model" }, tools: ["read"], cwd: "/repo" }, accounting: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 } };
const PREPARED = { cwd: "/repo", model: { provider: "fixture", model: "model" }, tools: ["read"], sessionLabel: "scout", systemPrompt: "SYSTEM" } as unknown as PreparedAgentSession;
interface SubagentFixture {
  readonly cwd: string;
  readonly storageDirectory: string;
  readonly statuses: Map<string, Record<string, unknown>>;
  readonly calls: (readonly [string, unknown])[];
  readonly copied: string[];
  readonly manager: SubagentManager;
  clipboard: (value: string) => Promise<void>;
  /** What the next retry returns; it adds run-d to the session when it names it. */
  retry: unknown;
  /** The manager context of each retry, in order. */
  readonly retryContexts: Readonly<SubagentManagerContext>[];
  /** Called before each inspection of one subagent, with its id. */
  onInspect: ((id: string) => void) | undefined;
}
/**
 * The session's subagents as /subagents lists them: run-a running (label scout, a worktree, a live system prompt), run-c failed
 * (no request file), run-b completed (label scout, a result); a run of another session is never listed. `unreadable` ids are
 * listed but cannot be inspected; `failDelete` cannot be deleted; `only` keeps those ids alone.
 */
function subagentFixture(options: { readonly unreadable?: readonly string[]; readonly failDelete?: string; readonly only?: readonly string[] } = {}): SubagentFixture {
  const home = temporary("subagents");
  const cwd = join(home, "project");
  mkdirSync(cwd);
  const storageDirectory = join(home, "subagents");
  for (const [id, request] of Object.entries({ "run-a": { prompt: "PROMPT A", label: "scout", mode: "background" }, "run-b": { prompt: "PROMPT B", label: "scout", mode: "background" } })) {
    mkdirSync(join(storageDirectory, id), { recursive: true });
    writeFileSync(join(storageDirectory, id, "request.json"), JSON.stringify(request));
  }
  const statuses = new Map<string, Record<string, unknown>>([
    ["run-a", { id: "run-a", sessionId: SESSION, state: "running", startedAt: 1_000, attempts: 1, attemptDetails: [SUBAGENT_ATTEMPT], worktree: { path: "/repo/worktree-a", branch: "subagent/run-a" } }],
    ["run-b", { id: "run-b", sessionId: SESSION, state: "completed", startedAt: 1_000, finishedAt: 2_000, value: { answer: 42 } }],
    ["run-c", { id: "run-c", sessionId: SESSION, state: "failed", startedAt: 1_000, finishedAt: 3_000, error: { code: "AGENT_FAILED", message: "boom" } }],
    ["run-other", { id: "run-other", sessionId: "session-2", state: "completed", startedAt: 1_000, finishedAt: 2_000 }],
    ...(options.unreadable ?? []).map((id): [string, Record<string, unknown>] => [id, { id, sessionId: SESSION, state: "completed", startedAt: 1_000, finishedAt: 1_500 }]),
  ]);
  if (options.only) for (const id of [...statuses.keys()]) if (!options.only.includes(id)) statuses.delete(id);
  const known = (id: string): Record<string, unknown> => {
    const status = statuses.get(id);
    if (status === undefined) throw new Error(`Unknown subagent ${id}`);
    return status;
  };
  const fixture: SubagentFixture = {
    cwd, storageDirectory, statuses, calls: [], copied: [], retryContexts: [], onInspect: undefined,
    clipboard: async (value) => { fixture.copied.push(value); },
    retry: { id: "run-d", state: "running" },
    manager: {
      async run() { throw new Error("unexpected run"); },
      async inspect(request) {
        if (request.id === undefined) return [...statuses.values()];
        fixture.onInspect?.(request.id);
        if (options.unreadable?.includes(request.id)) throw new Error(`inspection of ${request.id} failed`);
        return known(request.id);
      },
      async steer(request) { fixture.calls.push(["steer", request]); return { id: request.id, accepted: true }; },
      async stop(request) { fixture.calls.push(["stop", request]); statuses.set(request.id, { ...known(request.id), state: "stopped", finishedAt: 4_000 }); return {}; },
      async retry(request, context) {
        fixture.calls.push(["retry", request]);
        fixture.retryContexts.push(context);
        const result = fixture.retry;
        if (typeof result === "object" && result !== null && "id" in result && result.id === "run-d") statuses.set("run-d", { id: "run-d", sessionId: SESSION, state: "running", startedAt: 5_000, attempts: 1 });
        return result;
      },
      async delete(request) {
        fixture.calls.push(["delete", request]);
        if (request.id === options.failDelete) throw new Error("locked");
        statuses.delete(request.id);
        return {};
      },
      getAttemptActionData(id): SubagentAttemptActionData | undefined { return id === "run-a" && statuses.get(id)?.state === "running" ? { attempt: SUBAGENT_ATTEMPT, prepared: PREPARED, signal: new AbortController().signal } : undefined; },
    },
  };
  return fixture;
}
/** /subagents' workspace: its subagents with the presenter's names and details, the subagent provider, Pi's ActionUi. */
function subagents(t: TestContext, s: SubagentFixture, options: CommandOptions = {}): Command {
  return command(t, s.cwd, options, {
    source: (ctx) => createSessionAgentsSource(ctx, { home: undefined, overlayRun: (run) => run, liveAgent: () => undefined, subagents: () => s.manager, subagentPresenter: () => createSubagentPresenter({ manager: s.manager, storageDirectory: s.storageDirectory }, ctx) }, "subagents"),
    providers: (ctx) => [createSubagentActionProvider({ manager: s.manager, storageDirectory: s.storageDirectory, clipboard: (value) => s.clipboard(value) }, ctx)],
    hasContent: (nodes) => nodes.some((node) => node.agent !== undefined),
    onEmpty: (ctx) => { ctx.ui.notify("No durable subagent runs in this session.", "info"); },
  });
}
const LISTING_UI: AgentAttemptActionUi = { notify() {}, confirm: async () => false, select: async () => undefined, input: async () => undefined };
/**
 * The labels the /subagents dashboard offered on the subagent `id`, with Back. The dashboard also offered
 * Delete all completed and Delete all failed on every subagent; in the workspace they moved to the Subagents group (approved UX).
 */
async function dashboardLabels(s: SubagentFixture, ctx: ExtensionCommandContext, id: string): Promise<string[]> {
  return actionOptions(s.manager, await inspectEntry(s.manager, s.storageDirectory, id, ctx), ctx, LISTING_UI);
}

void test("/subagents: a subagent offers the dashboard's actions and its bulk deletions, which moved to the group; selecting shows the transcript, d the detail rows; an inspection that fails is shown in the menu", async (t) => {
  timers(t);
  const escaped = escapes(t);
  const s = subagentFixture({ unreadable: ["run-x"] });
  const c = subagents(t, s);
  await shown(c.pi, /^#1\/4 scout run-a running model$/);
  assert.deepEqual(sidebarRows(c.pi), ["  ▾ Subagents  1 running · 1 failed · 2 c…", "→   • scout run-a · ⠦", "    • run-c · ✗", "    • scout run-b · ✓", "    • run-x · ✓"]);
  assert.deepEqual(c.opened, ["subagent:run-a"], "the selected subagent's transcript");
  const dashboard = async (id: string): Promise<string[]> => (await dashboardLabels(s, c.pi.ctx, id)).filter((label) => label !== "Back");
  for (const [id, title] of [["run-a", /^#1\/4 scout run-a/], ["run-c", /^#2\/4 run-c/], ["run-b", /^#3\/4 scout run-b/]] as const) {
    select(c.pi, title);
    assert.deepEqual(await menuOf(c.pi), ["Subagent actions", ...(await dashboard(id)).map((label, row) => `${row === 0 ? "→" : " "} ${label}`)], id);
    c.pi.send(KEY.escape);
    assert.deepEqual(menu(c.pi), [], "esc closes the menu, as Back did");
  }
  assert.deepEqual(await dashboard("run-a"), ["Copy branch", "Copy worktree path", "Open prompt in editor", "Open system prompt in editor", "Steer", "Stop", "Copy run path", "Copy agent ID"]);
  select(c.pi, /^Subagents running$/);
  assert.deepEqual(await menuOf(c.pi, KEY.enter), ["Subagents", "→ Delete all completed", "  Delete all failed"], "enter on the group opens its menu");
  c.pi.send(KEY.escape);
  select(c.pi, /^#4\/4 run-x/);
  assert.deepEqual(await menuOf(c.pi), ["Subagent actions", "actions unavailable: inspection of run-x failed"]);
  c.pi.send(KEY.escape);
  select(c.pi, /^#2\/4 run-c/);
  assert.equal((c.pi.screen().at(-1) ?? "").trimEnd(), "←→/space fold · [ ] agent · a menu · d details · tab focus · ctrl+shift+f search · s sidebar · ctrl+o tools · esc back", "the hint with the actions and an agent with details");
  c.pi.send("d");
  const pane = c.pi.screen().slice(1, 7).map((line) => line.replace(/^.*│ /, "").trimEnd());
  assert.deepEqual(pane, ["Selected subagent: run-c", "ID: run-c", "State: failed", "Tools: (none)", "Duration: 2s", "Error: AGENT_FAILED: boom"], "d shows the /subagents detail rows");
  c.pi.send("d");
  assert.equal(c.opened.at(-1), "subagent:run-c");
  assert.equal(c.pi.screen().some((line) => line.includes("Selected subagent: run-c")), false, "d again shows the transcript");
  assert.deepEqual(c.pi.events, ["custom"]);
  await finish(c, escaped);
});

void test("/subagents: copies and the prompt, system prompt and result editors run inside the workspace with their notices in its status row", async (t) => {
  timers(t);
  const escaped = escapes(t);
  const external = externalEditor();
  let round = 0;
  let editor: string | undefined;
  const s = subagentFixture();
  const c = subagents(t, s, { editorCommand: () => editor });
  await shown(c.pi, /^#1\/3 scout run-a running/);
  const mark = c.pi.events.length;
  for (const [label, notice] of [["Copy branch", "Copied branch."], ["Copy worktree path", "Copied worktree path."], ["Copy run path", "Copied run path."], ["Copy agent ID", "Copied agent ID."]] as const) {
    await choose(c.pi, label);
    await until(() => statusRow(c.pi) === notice, `${notice} in the status row`);
  }
  assert.deepEqual(s.copied, ["subagent/run-a", "/repo/worktree-a", join(s.storageDirectory, "run-a"), "run-a"]);
  for (const [title, label, content] of [[/^#1\/3 scout run-a/, "Open prompt in editor", "PROMPT A"], [/^#1\/3 scout run-a/, "Open system prompt in editor", "SYSTEM"], [/^#3\/3 scout run-b/, "Open result in editor", "{\n  \"answer\": 42\n}\n"]] as const) {
    select(c.pi, title);
    editor = external.command(round, 0);
    await choose(c.pi, label);
    await until(() => existsSync(external.opened(round)), `${label} started the editor`);
    assert.equal(readFileSync(external.opened(round), "utf8"), content);
    await idle(c.pi);
    round += 1;
  }
  assert.deepEqual(c.pi.events.slice(mark), [], "in place: Pi was asked nothing");
  await editorFailures(c.pi, external, (command) => { editor = command; }, [[/^#1\/3 scout run-a/, "Open prompt in editor", "agent prompt"], [/^#1\/3 scout run-a/, "Open system prompt in editor", "agent system prompt"], [/^#3\/3 scout run-b/, "Open result in editor", "agent result"]]);
  s.clipboard = async () => { throw new Error("no clipboard"); };
  await choose(c.pi, "Copy agent ID");
  await until(() => statusRow(c.pi) === "Cannot copy agent id: no clipboard", "the failed copy in the status row");
  await finish(c, escaped);
});

void test("/subagents: Steer opens Pi's editor once the workspace stepped aside: a message steers, esc sends nothing, a run that stopped meanwhile is reported", async (t) => {
  timers(t);
  const escaped = escapes(t);
  const s = subagentFixture();
  const c = subagents(t, s);
  const title = /^#1\/3 scout run-a running/;
  await shown(c.pi, title);

  let mark = c.pi.events.length;
  await choose(c.pi, "Steer");
  const editor = await piCustom(c.pi);
  assert.equal(editor.options, undefined, "Pi's editor in place of its own input, not an overlay");
  press(editor, ...Array.from("check the docs"));
  const lines = editor.component.render(60);
  assert.equal(lines[0], "Steer subagent");
  assert.ok(lines.some((line) => line.includes("check the docs")));
  assert.equal(lines.at(-1), "enter submit · esc cancel");
  press(editor, KEY.enter);
  await shown(c.pi, title);
  assert.deepEqual(c.pi.events.slice(mark), ["done", "custom", "done", "notify info: Steered subagent run-a.", STOP, "custom"]);
  assert.deepEqual(s.calls, [["steer", { id: "run-a", message: "check the docs" }]]);
  statusShows(c.pi, ["Steered subagent run-a."]);

  mark = c.pi.events.length;
  await choose(c.pi, "Steer");
  press(await piCustom(c.pi), "x", KEY.escape);
  await shown(c.pi, title);
  assert.deepEqual(c.pi.events.slice(mark), ["done", "custom", "done", STOP, "custom"]);
  assert.equal(s.calls.length, 1, "esc steers nothing");

  mark = c.pi.events.length;
  await choose(c.pi, "Steer");
  const late = await piCustom(c.pi);
  s.statuses.set("run-a", { ...s.statuses.get("run-a"), state: "stopped", finishedAt: 4_000 });
  press(late, "y", KEY.enter);
  await shown(c.pi, /scout run-a stopped/);
  assert.deepEqual(c.pi.events.slice(mark), ["done", "custom", "done", "notify warning: Cannot steer: Subagent run-a is no longer running", STOP, "custom"]);
  assert.equal(s.calls.length, 1);
  await finish(c, escaped);
});

void test("/subagents: Stop confirms with Pi's dialog, checks again that the run is still running and stops; Retry checks again that the run is retryable, retries in background and selects the new run; an invalid retry result is reported", async (t) => {
  timers(t);
  const escaped = escapes(t);
  const s = subagentFixture();
  const c = subagents(t, s);
  await shown(c.pi, /^#1\/3 scout run-a running/);
  const confirm = "confirm Stop subagent? | Stop subagent scout (run-a)? This cannot be undone.";
  assert.deepEqual(await stepAside(c.pi, "Stop", /^#1\/3 scout run-a running/), ["done", confirm, STOP, "custom"], "declined");
  assert.deepEqual(s.calls, []);

  // The run stopped on its own while Pi's confirmation was open.
  const running = s.statuses.get("run-a");
  assert.ok(running);
  c.pi.answers.confirm = () => { s.statuses.set("run-a", { ...running, state: "stopped", finishedAt: 4_000 }); return true; };
  assert.deepEqual(await stepAside(c.pi, "Stop", /^#1\/3 scout run-a stopped/), ["done", confirm, "notify warning: Cannot stop: Subagent run-a is no longer running", STOP, "custom"], "checked again after the confirmation");
  assert.deepEqual(s.calls, [], "nothing stopped");
  statusShows(c.pi, ["Cannot stop: Subagent run-a is no longer running"]);

  s.statuses.set("run-a", running);
  c.pi.answers.confirm = () => true;
  assert.deepEqual(await stepAside(c.pi, "Stop", /^#1\/3 scout run-a stopped/), ["done", confirm, "notify info: Stopped subagent run-a.", STOP, "custom"], "the stopped run stays selected");
  assert.deepEqual(s.calls, [["stop", { id: "run-a" }]]);
  statusShows(c.pi, ["Stopped subagent run-a."]);
  assert.deepEqual(c.blocked, ["blocked Stop subagent?", "unblocked", "blocked Stop subagent?", "unblocked", "blocked Stop subagent?", "unblocked"]);

  select(c.pi, /^#2\/3 run-c failed/);
  assert.deepEqual(await stepAside(c.pi, "Retry", /^#1\/4 run-d running/), ["done", "notify info: Retried subagent run-c as run-d.", STOP, "custom"], "the workspace opens on the new run");
  statusShows(c.pi, ["Retried subagent run-c as run-d."]);
  assert.deepEqual(s.calls, [["stop", { id: "run-a" }], ["retry", { id: "run-c" }]]);
  s.retry = { id: "run-c", state: "failed" };
  select(c.pi, /^#3\/4 run-c failed/);
  assert.deepEqual(await stepAside(c.pi, "Retry", /^#3\/4 run-c failed/), ["done", "notify warning: Cannot retry: Retry returned an invalid subagent result", STOP, "custom"]);
  assert.deepEqual(s.retryContexts.map((context) => [context.waitForForeground, context.extensionContext === c.pi.ctx]), [[false, true], [false, true]], "in background, with the command's context");

  // The run was retried elsewhere after it was chosen: the loop's check, the provider's own and its fresh inspection see it
  // failed, the inspection right before the retry sees it running.
  const labels = labelsOf(await menuOf(c.pi));
  assert.ok(labels.includes("Retry"), labels.join(", "));
  let inspections = 0;
  s.onInspect = (id) => { if (id === "run-c" && (inspections += 1) === 4) s.statuses.set("run-c", { id: "run-c", sessionId: SESSION, state: "running", startedAt: 6_000 }); };
  const mark = c.pi.events.length;
  c.pi.send(...Array.from({ length: labels.indexOf("Retry") }, () => KEY.down), KEY.enter);
  await shown(c.pi, /^#\d\/4 run-c running/);
  s.onInspect = undefined;
  assert.deepEqual(c.pi.events.slice(mark), ["done", "notify warning: Cannot retry: Subagent run-c is no longer retryable", STOP, "custom"]);
  assert.deepEqual(s.calls, [["stop", { id: "run-a" }], ["retry", { id: "run-c" }], ["retry", { id: "run-c" }]], "nothing retried");
  statusShows(c.pi, ["Cannot retry: Subagent run-c is no longer retryable"]);
  await finish(c, escaped);
});

void test("/subagents: Delete confirms with Pi's dialog and opens the workspace on the node now at the subagent's row; deleting the last one closes with the dashboard's notice", async (t) => {
  timers(t);
  const escaped = escapes(t);
  const s = subagentFixture();
  const c = subagents(t, s);
  await shown(c.pi, /^#1\/3 scout run-a running/);
  select(c.pi, /^#2\/3 run-c failed/);
  const confirm = "confirm Delete subagent? | Delete run-c (run-c) and its record? This cannot be undone.";
  // d, the transcript focused and the tools expanded hold while the action steps aside.
  c.pi.send("d", KEY.tab, KEY.ctrlO);
  const frame = c.pi.screen();
  assert.match(frame.at(-1) ?? "", /^↑↓ scroll/);
  assert.ok(frame.some((line) => line.includes("Selected subagent: run-c")));
  assert.deepEqual(await stepAside(c.pi, "Delete", /^#2\/3 run-c failed/), ["done", confirm, STOP, "custom"], "declined");
  assert.deepEqual(c.pi.screen(), frame, "the workspace opens again as it was");
  c.pi.answers.confirm = () => true;
  assert.deepEqual(await stepAside(c.pi, "Delete", /^#2\/2 scout run-b completed/), ["done", confirm, "notify info: Deleted subagent run-c.", STOP, "custom"], "the node now at its row");
  assert.deepEqual(s.calls, [["delete", { id: "run-c" }]]);
  statusShows(c.pi, ["Deleted subagent run-c."]);
  await finish(c, escaped);

  const last = subagentFixture({ only: ["run-b"] });
  const single = subagents(t, last);
  single.pi.answers.confirm = () => true;
  await shown(single.pi, /^#1\/1 scout completed/);
  const mark = single.pi.events.length;
  await choose(single.pi, "Delete");
  await single.done;
  assert.deepEqual(single.pi.events.slice(mark), ["done", "confirm Delete subagent? | Delete scout (run-b) and its record? This cannot be undone.", "notify info: Deleted subagent run-b.", STOP, "notify info: No durable subagent runs in this session."], "nothing left: the command ends with the dashboard's notice");
  assert.deepEqual(single.pi.violations, [], "no dialog over a pending custom component");
  assert.deepEqual(escaped, []);
});

void test("/subagents: without a subagent nothing opens and the dashboard's notice shows; the menu fits at 120, 70 and 40 columns, in place and stepping aside", async (t) => {
  timers(t);
  const escaped = escapes(t);
  const none = subagents(t, subagentFixture({ only: [] }));
  await none.done;
  assert.deepEqual(none.pi.events, ["notify info: No durable subagent runs in this session."]);
  for (const columns of [120, 70, 40]) {
    const c = subagents(t, subagentFixture(), { columns, rows: 12 });
    const title = /^#1\/3 scout run-a running/;
    await shown(c.pi, title);
    const fits = (): void => {
      const lines = c.pi.screen();
      assert.equal(lines.length, 12);
      assert.ok(lines.every((line) => visibleWidth(line) <= columns), `${String(columns)} columns:\n${lines.join("\n")}`);
    };
    assert.equal(c.pi.screen().some((line) => line.includes("Subagents")), columns >= 80, "the sidebar shows from 80 columns");
    assert.deepEqual(labelsOf(await menuOf(c.pi)), ["Copy branch", "Copy worktree path", "Open prompt in editor", "Open system prompt in editor", "Steer", "Stop", "Copy run path", "Copy agent ID"], `${String(columns)} columns`);
    fits();
    menuClear(c.pi);
    c.pi.send(KEY.escape);
    await choose(c.pi, "Copy agent ID");
    await until(() => statusRow(c.pi) === "Copied agent ID.", "the copy's notice");
    fits();
    assert.deepEqual(await stepAside(c.pi, "Stop", title), ["done", "confirm Stop subagent? | Stop subagent scout (run-a)? This cannot be undone.", STOP, "custom"]);
    fits();
    await finish(c, escaped);
  }
});

void test("/subagents: the group's Delete all completed and Delete all failed confirm with Pi's dialog and report what they deleted and skipped", async (t) => {
  timers(t);
  const escaped = escapes(t);
  const s = subagentFixture({ failDelete: "run-c" });
  const c = subagents(t, s);
  await shown(c.pi, /^#1\/3 scout run-a running/);
  select(c.pi, /^Subagents running$/);
  const confirmCompleted = "confirm Delete completed runs? | Delete all completed subagent runs and their records? This cannot be undone.";
  assert.deepEqual(await stepAside(c.pi, "Delete all completed", /^Subagents running$/), ["done", confirmCompleted, STOP, "custom"], "declined");
  c.pi.answers.confirm = () => true;
  assert.deepEqual(await stepAside(c.pi, "Delete all completed", /^Subagents running$/), ["done", confirmCompleted, "notify info: Deleted 1 completed subagent run(s).", STOP, "custom"]);
  assert.deepEqual(s.calls, [["delete", { id: "run-b" }]], "a run of another session is never deleted");
  assert.deepEqual(await stepAside(c.pi, "Delete all failed", /^Subagents running$/), ["done", "confirm Delete failed runs? | Delete all failed subagent runs and their records? This cannot be undone.", "notify warning: Skipped failed runs: run-c (locked).", STOP, "custom"]);
  statusShows(c.pi, ["Skipped failed runs: run-c (locked)."]);
  assert.deepEqual(await menuOf(c.pi), ["Subagents", "→ Delete all failed"], "no completed run left");
  c.pi.send(KEY.escape);
  await finish(c, escaped);
});

void test("/subagents: a registered standalone action runs with Pi's dialogs once the workspace stepped aside", async (t) => {
  timers(t);
  const escaped = escapes(t);
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
        context.ui.setWorkingMessage?.("working");
        context.ui.notify(accepted ? "accepted" : "declined");
      },
    },
  } });
  const s = subagentFixture();
  const c = subagents(t, s);
  c.pi.answers.confirm = () => true;
  const title = /^#1\/3 scout run-a running/;
  await shown(c.pi, title);
  assert.equal(labelsOf(await menuOf(c.pi))[0], "Fixture action");
  c.pi.send(KEY.escape);
  assert.deepEqual(await stepAside(c.pi, "Fixture action", title), ["done", "confirm Proceed? | Run the fixture action.", "working working", "notify info: accepted", STOP, "custom"]);
  assert.deepEqual(seen, ["run-a scout"]);
  statusShows(c.pi, ["accepted"]);
  await finish(c, escaped);
});

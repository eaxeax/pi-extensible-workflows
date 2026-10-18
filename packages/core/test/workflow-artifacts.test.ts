import assert from "node:assert/strict";
import test from "node:test";
import { openArtifactInEditor } from "../src/workflow-artifacts.js";

function fakeTui(): { calls: string[]; tui: { stop(): void; start(): void; requestRender(force?: boolean): void } } {
  const calls: string[] = [];
  return { calls, tui: { stop() { calls.push("stop"); }, start() { calls.push("start"); }, requestRender(force?: boolean) { calls.push(`render ${String(force)}`); } } };
}

void test("openArtifactInEditor reports a missing editor, a failed exit and a failed start, and gives the terminal back", async () => {
  const artifact = { extension: ".md", content: "hello" } as const;
  const notices: string[] = [];
  const notify = (message: string): void => { notices.push(message); };

  const none = fakeTui();
  await openArtifactInEditor(none.tui, undefined, artifact, "agent prompt", notify);
  assert.deepEqual(notices, ["Cannot open agent prompt: no external editor is configured."]);
  assert.deepEqual(none.calls, [], "no editor, no terminal switch");

  notices.length = 0;
  const ok = fakeTui();
  await openArtifactInEditor(ok.tui, "true", artifact, "agent prompt", notify);
  assert.deepEqual(notices, []);
  assert.deepEqual(ok.calls, ["stop", "start", "render true"]);

  const failed = fakeTui();
  await openArtifactInEditor(failed.tui, "false", artifact, "workflow script", notify);
  assert.deepEqual(notices, ["Cannot open workflow script: external editor exited with code 1."]);
  assert.deepEqual(failed.calls, ["stop", "start", "render true"]);

  notices.length = 0;
  await openArtifactInEditor(fakeTui().tui, "/nonexistent/editor-for-test", artifact, "agent result", notify);
  assert.deepEqual(notices, ["Cannot open agent result: external editor could not be started."]);
});

import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { testExtensionApi } from "./support.js";
import workflowExtension, { RunStore } from "../src/index.js";

void test("session shutdown waits for a settled run's terminal delivery before it resolves", async () => {
  const home = mkdtempSync(join(tmpdir(), "pi-extensible-workflows-shutdown-delivery-"));
  const tools: Array<{ name: string; execute: (...args: unknown[]) => Promise<unknown> }> = [];
  const messages: string[] = [];
  let shutdown: (() => Promise<void>) | undefined;
  workflowExtension(testExtensionApi({
    registerTool(tool: (typeof tools)[number]) { tools.push(tool); }, registerCommand() {},
    on(name: string, handler: unknown) { if (name === "session_shutdown") shutdown = handler as typeof shutdown; },
    getThinkingLevel: () => "medium", getActiveTools: () => ["workflow"],
    sendMessage(message: { content: string }) { messages.push(message.content); },
  }), home);
  const workflow = tools.find(({ name }) => name === "workflow");
  assert.ok(workflow && shutdown);
  // The delivery's claim (its state becoming "delivered") is held until released, as a slow write would hold it.
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  let reached!: () => void;
  const atGate = new Promise<void>((resolve) => { reached = resolve; });
  const updateState = Object.getOwnPropertyDescriptor(RunStore.prototype, "updateState")?.value as RunStore["updateState"];
  RunStore.prototype.updateState = function (this: RunStore, update) {
    return updateState.call(this, async (current) => {
      const next = await update(current);
      if (this.cwd === home && next.delivery?.state === "delivered" && current.delivery?.state !== "delivered") { reached(); await gate; }
      return next;
    });
  };
  try {
    await workflow.execute("id", { name: "shutdown-delivery", script: "return true;" }, new AbortController().signal, undefined, { cwd: home, hasUI: false, model: { provider: "openai", id: "gpt" }, sessionManager: { getSessionId: () => "session" } });
    await atGate;
    let resolved = false;
    const closing = shutdown().then(() => { resolved = true; });
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(resolved, false, "shutdown waits while the delivery is still writing");
    release();
    await closing;
    assert.equal(messages.length, 1, "the completion was delivered before shutdown resolved");
    assert.match(messages[0] ?? "", /"state":"completed"/);
  } finally {
    release();
    RunStore.prototype.updateState = updateState;
    rmSync(home, { recursive: true, force: true });
  }
});

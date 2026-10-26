import assert from "node:assert/strict";
import test from "node:test";
import { createExtensionRuntime, ExtensionRunner, ModelRegistry, ModelRuntime, SessionManager } from "@earendil-works/pi-coding-agent";
import { installViewerPresentation, viewerPresentation } from "../src/viewer-presentation.js";

const RUNNERS = Symbol.for("pi-extensible-workflows.viewer-runners");
const registry = new ModelRegistry(await ModelRuntime.create({ modelsPath: null }));
const prototype = ExtensionRunner.prototype as unknown as { createContext: unknown };
function runner(): { readonly runner: ExtensionRunner; readonly sessionManager: SessionManager } {
  const sessionManager = SessionManager.inMemory("/repo", { id: "viewer" });
  return { runner: new ExtensionRunner([], createExtensionRuntime(), "/repo", sessionManager, registry), sessionManager };
}

// First in the file: a later install would find the wrapper already in place.
void test("a Pi whose ExtensionRunner.createContext is missing or read-only gets no wrapper and no record, and a later install still wraps it", () => {
  const original = prototype.createContext;
  prototype.createContext = undefined;
  try {
    installViewerPresentation();
    assert.equal(Reflect.get(globalThis, RUNNERS), undefined, "nothing recorded as installed");
  } finally { prototype.createContext = original; }
  const descriptor = Object.getOwnPropertyDescriptor(prototype, "createContext");
  assert.ok(descriptor);
  Object.defineProperty(prototype, "createContext", { ...descriptor, writable: false });
  try {
    assert.doesNotThrow(() => { installViewerPresentation(); }, "a read-only createContext does not stop the extension loading");
    assert.equal(prototype.createContext, original);
    assert.equal(Reflect.get(globalThis, RUNNERS), undefined);
  } finally { Object.defineProperty(prototype, "createContext", descriptor); }
  Object.defineProperty(prototype, "createContext", { configurable: true, get: () => original, set: () => { throw new Error("read-only"); } });
  try {
    assert.doesNotThrow(() => { installViewerPresentation(); }, "a setter that throws does not stop the extension loading");
    assert.equal(Reflect.get(globalThis, RUNNERS), undefined);
  } finally { Object.defineProperty(prototype, "createContext", descriptor); }
  // A handle of another shape (another release's) is not read, and does not keep this one from installing.
  Reflect.set(globalThis, RUNNERS, "foreign");
  assert.equal(viewerPresentation({ sessionManager: {} }), undefined);
  installViewerPresentation();
  assert.ok(Reflect.get(globalThis, RUNNERS) instanceof WeakMap);
  assert.notEqual(prototype.createContext, original, "wrapped once createContext exists");
  const wrapped = prototype.createContext;
  installViewerPresentation();
  assert.equal(prototype.createContext, wrapped, "a second install does not wrap again");
});

void test("a session's renderers are found once its runner made a context, by the session manager the context reads", () => {
  installViewerPresentation();
  const { runner: shown, sessionManager } = runner();
  assert.equal(viewerPresentation({ sessionManager }), undefined, "no context made yet");
  const context = shown.createContext();
  assert.equal(context.sessionManager, sessionManager);
  const presentation = viewerPresentation(context);
  assert.ok(presentation);
  const fallback = { renderCall: () => ({ render: () => ["built-in"], invalidate() {} }) };
  assert.equal(presentation.toolDefinition("read", fallback), fallback, "no extension tool: the caller's fallback");
  assert.equal(presentation.entryRenderer("card"), undefined);
  assert.equal(presentation.messageRenderer("note"), undefined);
  assert.deepEqual(presentation.markdownTransformers(), []);
  assert.equal(viewerPresentation({ sessionManager: SessionManager.inMemory("/repo", { id: "other" }) }), undefined, "another session's manager");
  assert.equal(viewerPresentation({ sessionManager: undefined }), undefined);
});

void test("tool renderers resolve as Pi's chat resolves them: the runner's resolvers over its registered tool, else the fallback", () => {
  installViewerPresentation();
  const { runner: shown } = runner();
  const registered = { renderCall: () => ({ render: () => ["registered"], invalidate() {} }) };
  const resolved = { renderCall: () => ({ render: () => ["resolved"], invalidate() {} }) };
  const bases: unknown[] = [];
  Object.assign(shown, {
    getToolDefinition: (name: string) => name === "read" ? registered : undefined,
    resolveToolRenderers: (name: string, base: () => unknown) => { const next = base(); bases.push(next); return name === "bash" ? resolved : next; },
  });
  const presentation = viewerPresentation(shown.createContext());
  assert.ok(presentation);
  const fallback = { renderCall: () => ({ render: () => ["built-in"], invalidate() {} }) };
  assert.equal(presentation.toolDefinition("read", fallback), registered);
  assert.equal(presentation.toolDefinition("bash", fallback), resolved);
  assert.deepEqual(bases, [registered, fallback], "a resolver's next() is the registered tool, else the fallback");
  Object.assign(shown, { resolveToolRenderers: undefined });
  assert.equal(presentation.toolDefinition("bash", fallback), fallback, "a Pi without resolvers: the registered tool or the fallback");
});

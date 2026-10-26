import { ExtensionRunner } from "@earendil-works/pi-coding-agent";
import type { ToolRendering, TranscriptPresentation } from "./transcript-components.js";
import { object } from "./utils.js";

/**
 * The renderers of the Pi session a viewer such as /agents runs in, resolved as Pi's chat resolves them
 * (InteractiveMode.getRegisteredToolDefinition): extension tool renderers, then the registered tool, then `fallback`.
 *
 * NOTE: Pi gives extensions no read access to them. Until it does, the session's ExtensionRunner is found by wrapping its
 * createContext, which every context of that session goes through, keyed by the session manager the context reads. A Pi
 * whose runner lacks one of the members read here gives no presentation, and /agents keeps Pi's built-in drawing.
 */
type Runner = {
  getToolDefinition(name: string): ToolRendering;
  resolveToolRenderers?(name: string, base: () => ToolRendering): ToolRendering;
  getEntryRenderer: TranscriptPresentation["entryRenderer"];
  getMessageRenderer: TranscriptPresentation["messageRenderer"];
  getMarkdownTransformers: TranscriptPresentation["markdownTransformers"];
};
/** One wrapper per process: every extension bundle carries its own copy of this module. */
const RUNNERS = Symbol.for("pi-extensible-workflows.viewer-runners");
type Store = typeof globalThis & { [RUNNERS]?: unknown };
/** The runners the installed wrapper records; undefined before it is installed or when the handle is not this shape. */
function recorded(): WeakMap<object, unknown> | undefined {
  const runners = (globalThis as Store)[RUNNERS];
  return runners instanceof WeakMap ? runners : undefined;
}

/** Wraps ExtensionRunner.createContext to remember each session's runner; call it while the extension loads, before session_start. */
export function installViewerPresentation(): void {
  const store = globalThis as Store;
  if (recorded()) return;
  const prototype = ExtensionRunner.prototype as unknown as { createContext?: (...args: unknown[]) => unknown };
  const original = prototype.createContext;
  if (typeof original !== "function") return;
  const runners = new WeakMap<object, unknown>();
  const wrapped = function (this: { readonly sessionManager?: unknown }, ...args: unknown[]): unknown {
    if (object(this.sessionManager)) runners.set(this.sessionManager, this);
    return Reflect.apply(original, this, args);
  };
  // A prototype Pi froze or made read-only, or whose setter throws: no wrapper, and the extension still loads.
  try { if (!Reflect.set(prototype, "createContext", wrapped) || prototype.createContext !== wrapped) return; } catch { return; }
  store[RUNNERS] = runners;
}

/** What the session of `context` draws its records with; undefined when its runner is not known or lacks a member read here. */
export function viewerPresentation(context: { readonly sessionManager: unknown }): TranscriptPresentation | undefined {
  const manager = context.sessionManager;
  const found = object(manager) ? recorded()?.get(manager) : undefined;
  if (!object(found) || typeof found.getToolDefinition !== "function" || typeof found.getEntryRenderer !== "function" || typeof found.getMessageRenderer !== "function" || typeof found.getMarkdownTransformers !== "function") return undefined;
  const runner = found as unknown as Runner;
  return {
    toolDefinition: (name, fallback) => {
      const base = (): ToolRendering => runner.getToolDefinition(name) ?? fallback;
      return typeof runner.resolveToolRenderers === "function" ? runner.resolveToolRenderers(name, base) : base();
    },
    entryRenderer: (customType) => runner.getEntryRenderer(customType),
    messageRenderer: (customType) => runner.getMessageRenderer(customType),
    markdownTransformers: () => runner.getMarkdownTransformers(),
  };
}

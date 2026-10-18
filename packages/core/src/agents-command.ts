import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { errorText } from "./utils.js";
import type { ActionUi, AgentsActionProvider, AgentsActionTarget } from "./agents-actions-contract.js";
import type { AgentsWorkspaceExit, AgentsWorkspaceOptions, OpenAgentsWorkspace, SessionAgentsSource, SessionTreeNode } from "./agents-workspace-contract.js";

/** One loop at a time, across the extension bundles that each load their own copy of this module: a second alternate screen would stay over Pi. */
const LOOP_KEY = Symbol.for("pi-extensible-workflows.agents-workspace-loop");
const globalLoops = globalThis as typeof globalThis & Record<symbol, true | undefined>;

export interface AgentsWorkspaceLoop {
  readonly open: OpenAgentsWorkspace;
  /** What every open of the workspace gets as it is. */
  readonly options: Pick<AgentsWorkspaceOptions, "agents" | "openSource" | "createView" | "pollIntervalMs" | "editorCommand">;
  /** The menus' providers, in menu order; none: the workspace gets no actions, so it has no menu and never steps aside. */
  readonly providers: readonly AgentsActionProvider[];
  /** The node selected at the first open. */
  readonly initialKey?: string;
  /** The ActionUi a step-aside action runs with (Pi's dialogs); `onNotify` gets every notice it shows. */
  readonly actionUi: (onNotify: (message: string, level?: "info" | "warning" | "error") => void) => ActionUi;
  /** Whether a list has something to show; checked before every open. */
  readonly hasContent: (nodes: readonly SessionTreeNode[]) => boolean;
  readonly onEmpty: () => void;
}

/** The source's nodes; undefined when it cannot list them. */
async function listNodes(source: SessionAgentsSource): Promise<readonly SessionTreeNode[] | undefined> {
  try { return await source.list(); } catch { return undefined; }
}
/** The source whose first list() is `nodes`, already listed for the emptiness check; later lists go to the source (a refresh must see changes). */
function seeded(source: SessionAgentsSource, nodes: readonly SessionTreeNode[]): SessionAgentsSource {
  let first: readonly SessionTreeNode[] | undefined = nodes;
  return { list: async () => { const seed = first; first = undefined; return seed ?? source.list(); } };
}
/** Whether `provider` offers `label` for `target` now; a provider that cannot be read offers nothing. */
async function offers(provider: AgentsActionProvider, target: AgentsActionTarget, label: string): Promise<boolean> {
  try { return (await provider.actions(target)).some((action) => action.label === label); } catch { return false; }
}
/** Runs the label with the first provider that offers it now, and clears its status once it settled; the node to select afterwards. */
async function runAction(providers: readonly AgentsActionProvider[], exit: AgentsWorkspaceExit, ui: ActionUi): Promise<string | undefined> {
  for (const provider of providers) {
    if (!await offers(provider, exit.target, exit.label)) continue;
    //NOTE: a provider reports its failures through ui.notify; one that throws ends the command, the status cleared.
    try { return (await provider.run(exit.target, exit.label, ui)).select; } finally { ui.status(undefined); }
  }
  ui.notify(`${exit.label} is no longer available.`, "warning");
  return undefined;
}

/**
 * Opens the workspace, runs the action it stepped aside for with Pi's dialogs, and opens it again as it was, on the node
 * the action selected, with the action's notices; until the user leaves it, the command's signal aborts, or the source has
 * nothing to show (onEmpty). A list that fails still opens the workspace: its title says why. An action that waits (a
 * Foreground resume) keeps Pi's screen until it settles.
 */
export async function runAgentsWorkspace(ctx: ExtensionCommandContext, loop: AgentsWorkspaceLoop): Promise<void> {
  if (globalLoops[LOOP_KEY]) { ctx.ui.notify("The agents workspace is already opening or open.", "info"); return; }
  globalLoops[LOOP_KEY] = true;
  try {
    let reopen: Pick<AgentsWorkspaceOptions, "initialKey" | "state" | "notices"> = loop.initialKey === undefined ? {} : { initialKey: loop.initialKey };
    for (;;) {
      const nodes = await listNodes(loop.options.agents);
      if (nodes !== undefined && !loop.hasContent(nodes)) { loop.onEmpty(); return; }
      const options = nodes === undefined ? loop.options : { ...loop.options, agents: seeded(loop.options.agents, nodes) };
      let exit: AgentsWorkspaceExit | undefined;
      // The same notice at the same level in /agents, /workflow and /subagents.
      try { exit = await loop.open(ctx, { ...options, ...(loop.providers.length > 0 ? { actions: loop.providers } : {}), ...reopen }); }
      catch (error) { ctx.ui.notify(`agents workspace failed: ${errorText(error)}`, "error"); return; }
      if (exit === undefined || ctx.signal?.aborted) return;
      const notices: string[] = [];
      const select = await runAction(loop.providers, exit, loop.actionUi((message) => { notices.push(message); }));
      if (ctx.signal?.aborted) return;
      reopen = { state: exit.state, ...(select === undefined ? {} : { initialKey: select }), ...(notices.length > 0 ? { notices } : {}) };
    }
  } finally { globalLoops[LOOP_KEY] = undefined; }
}

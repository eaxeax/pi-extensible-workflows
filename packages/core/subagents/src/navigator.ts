import { copyToClipboard, getAgentDir, SettingsManager, type ExtensionAPI, type ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { runAgentsWorkspace } from "../../src/agents-command.js";
import { openAgentsWorkspace } from "../../src/agents-workspace.js";
import type { OpenAgentsWorkspace } from "../../src/agents-workspace-contract.js";
import { errorText, formatCost, formatWorkflowRuntime, PLAIN_WORKFLOW_PROGRESS_STYLES, runStateGlyph } from "../../src/index.js";
import { createPiActionUi } from "../../src/pi-action-ui.js";
import { createSessionAgentsSource } from "../../src/session-agents.js";
import { openSessionTranscript } from "../../src/session-transcript.js";
import { createTranscriptView } from "../../src/transcript-components.js";
import { actionOptions, boundedText, BULK_DELETE, bulkDeleteLabels, createSubagentActionProvider, createSubagentPresenter, deleteAll, detailRows, inspectEntry, listNames, loadEntries, performAction, type NavigatorEntry, type SubagentActionUi } from "./actions.js";
import type { SubagentManager } from "./contracts.js";

type RegisterCommand = ExtensionAPI["registerCommand"];

/** The actions' ui over Pi's dialogs, for the picker. */
function navigatorUi(context: ExtensionCommandContext): SubagentActionUi {
  return {
    notify: (message, level) => { context.ui.notify(message, level); },
    confirm: (title, message) => context.ui.confirm(title, message),
    select: (title, options) => context.ui.select(title, [...options]),
    input: (title, placeholder) => context.ui.input(title, placeholder),
    editText: (title) => context.ui.input(title, "Message for the running subagent"),
    //NOTE: the picker offers no editor action: actionOptions offers them in the TUI only, where /subagents opens the workspace.
    openArtifact: async () => {},
    setWorkingMessage: (message) => { context.ui.setWorkingMessage(message); },
  };
}

/** Picker rows in the `/workflow` style. */
function pickerLabels(entries: readonly NavigatorEntry[]): string[] {
  const names = listNames(entries);
  return entries.map(({ status }, index) => {
    const name = names[index] ?? "";
    const model = status.progress?.state?.model;
    const cost = formatCost(status.progress?.accounting.cost);
    const runtime = status.startedAt === undefined ? "" : ` runtime=${formatWorkflowRuntime((status.finishedAt ?? Date.now()) - status.startedAt)}`;
    return `${runStateGlyph(status.state, "⠦")} ${name}  ${status.state}${model ? `  ${boundedText(model.model, 256)}${model.thinking ? `:${model.thinking}` : ""}` : ""}${cost ? ` ${cost}` : ""}${runtime}`;
  });
}

async function showDetail(manager: SubagentManager, storageDirectory: string, entry: NavigatorEntry, context: ExtensionCommandContext, clipboard: (value: string) => Promise<void>): Promise<void> {
  const ui = navigatorUi(context);
  let inspection = await inspectEntry(manager, storageDirectory, entry.status.id, context);
  for (;;) {
    const action = await context.ui.select(detailRows(inspection, PLAIN_WORKFLOW_PROGRESS_STYLES, Date.now()).join("\n"), actionOptions(manager, inspection, context, ui));
    if (!action || action === "Back") return;
    try {
      const outcome = await performAction(manager, storageDirectory, entry.status.id, action, context, ui, clipboard);
      if (outcome === "deleted" || typeof outcome === "object") return;
      inspection = await inspectEntry(manager, storageDirectory, entry.status.id, context);
    } catch (error) {
      context.ui.notify(`Cannot ${action.toLowerCase()}: ${errorText(error)}`, "warning");
    }
  }
}

/**
 * /subagents in the TUI: the agents workspace over this session's subagents with their actions, until the user leaves it or
 * an action leaves none. It needs nothing of the workflow extension, which this one may run without.
 */
function openSubagentsWorkspace(manager: SubagentManager, storageDirectory: string, context: ExtensionCommandContext, clipboard: (value: string) => Promise<void>, open: OpenAgentsWorkspace): Promise<void> {
  const editorCommand = (): string | undefined => SettingsManager.create(context.cwd, getAgentDir(), { projectTrusted: context.isProjectTrusted() }).getExternalEditorCommand();
  const presenter = createSubagentPresenter({ manager, storageDirectory }, context);
  const agents = createSessionAgentsSource(context, { home: undefined, overlayRun: (run) => run, liveAgent: () => undefined, subagents: () => manager, subagentPresenter: () => presenter }, "subagents");
  return runAgentsWorkspace(context, {
    open,
    options: { agents, openSource: (agent) => openSessionTranscript(agent.session), createView: createTranscriptView, editorCommand },
    providers: [createSubagentActionProvider({ manager, storageDirectory, clipboard }, context)],
    actionUi: (onNotify) => createPiActionUi(context, { editorCommand, onNotify }),
    hasContent: (nodes) => nodes.some((node) => node.target?.kind === "subagent"),
    onEmpty: () => { context.ui.notify("No durable subagent runs in this session.", "info"); },
  });
}

async function runNavigator(manager: SubagentManager, storageDirectory: string, args: string, context: ExtensionCommandContext, clipboard: (value: string) => Promise<void>, openWorkspace: OpenAgentsWorkspace): Promise<void> {
  if (args.trim()) {
    context.ui.notify("Subagent slash commands do not accept arguments. Open the picker with /subagents to inspect and control current-session runs.", "warning");
    return;
  }
  for (;;) {
    const entries = await loadEntries(manager, storageDirectory, context);
    if (!entries.length) {
      context.ui.notify("No durable subagent runs in this session.", "info");
      return;
    }
    const labels = pickerLabels(entries);
    if (!context.hasUI) {
      context.ui.notify(labels.join("\n"), "info");
      return;
    }
    if (context.mode === "tui") {
      await openSubagentsWorkspace(manager, storageDirectory, context, clipboard, openWorkspace);
      return;
    }
    const choice = await context.ui.select("Subagents\n", [...labels, "Close", ...bulkDeleteLabels(manager, entries)]);
    if (!choice || choice === "Close") return;
    const bulk = BULK_DELETE[choice];
    if (bulk !== undefined) {
      try { await deleteAll(manager, storageDirectory, context, bulk, navigatorUi(context)); }
      catch (error) { context.ui.notify(`Cannot delete ${bulk} runs: ${errorText(error)}`, "warning"); }
      continue;
    }
    const selected = entries[labels.indexOf(choice)];
    if (!selected) return;
    try {
      await showDetail(manager, storageDirectory, selected, context, clipboard);
    } catch (error) {
      context.ui.notify(`Cannot inspect subagent ${selected.status.id}: ${errorText(error)}`, "warning");
    }
  }
}

export function registerSubagentNavigator(registerCommand: RegisterCommand, manager: SubagentManager, storageDirectory: string, clipboard: (value: string) => Promise<void> = copyToClipboard, openWorkspace: OpenAgentsWorkspace = openAgentsWorkspace): void {
  registerCommand("subagents", {
    description: "Open the durable subagent picker and inspect run status",
    handler: async (args, context) => {
      try {
        await runNavigator(manager, storageDirectory, args, context, clipboard, openWorkspace);
      } catch (error) {
        context.ui.notify(`Cannot inspect subagents: ${errorText(error)}`, "warning");
      }
    },
  });
}

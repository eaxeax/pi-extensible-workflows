const OWNERS_KEY = Symbol.for("pi-extensible-workflows.subagents-in-workflow-widget");
const globalOwners = globalThis as typeof globalThis & Record<symbol, Set<object> | undefined>;

function owners(): Set<object> {
  const found = globalOwners[OWNERS_KEY];
  if (found) return found;
  const created = new Set<object>();
  globalOwners[OWNERS_KEY] = created;
  return created;
}

/**
 * The workflow widget of the core host, another bundle, draws the background subagents while it holds this flag; the subagents
 * extension then leaves its own frame undrawn. Each widget instance claims it with itself as owner, so one instance stopping
 * leaves the flag to another that still runs.
 */
export function claimSubagentsInWorkflowWidget(owner: object): void { owners().add(owner); }
export function releaseSubagentsInWorkflowWidget(owner: object): void { owners().delete(owner); }
export function subagentsInWorkflowWidget(): boolean { return owners().size > 0; }

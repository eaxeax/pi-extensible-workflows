import { execFile } from "node:child_process";
import { stat } from "node:fs/promises";
import type { WorktreeReference } from "./persistence.js";
import { errorText } from "./utils.js";

/** What the worktree of a workflow agent holds against its base: the `git diff --stat` lines and whether files are uncommitted. */
export type WorktreeChanges = { readonly stat: string[]; readonly uncommitted: boolean } | { readonly removed: true } | { readonly error: string };

const GIT_TIMEOUT_MS = 10_000;
const MAX_BUFFER = 64 * 1024 * 1024;

function git(path: string, args: readonly string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile("git", ["-C", path, ...args], { timeout: GIT_TIMEOUT_MS, maxBuffer: MAX_BUFFER, encoding: "utf8" }, (error, stdout, stderr) => {
      if (error) reject(new Error(stderr.trim() || errorText(error)));
      else resolve(stdout);
    });
  });
}
async function exists(path: string): Promise<boolean> { return stat(path).then(() => true, () => false); }

/** The worktree's change summary since its base; a path that no longer exists is `removed`, a failing git is `error`. */
export async function worktreeChanges(reference: Pick<WorktreeReference, "path" | "base">): Promise<WorktreeChanges> {
  if (!await exists(reference.path)) return { removed: true };
  try {
    const [summary, status] = await Promise.all([git(reference.path, ["diff", "--stat", reference.base, "--"]), git(reference.path, ["status", "--porcelain"])]);
    return { stat: summary.split("\n").filter((line) => line.trim() !== ""), uncommitted: status.trim() !== "" };
  } catch (error) { return { error: errorText(error) }; }
}

/** The full `git diff` of the worktree against its base. */
export function worktreeDiff(reference: Pick<WorktreeReference, "path" | "base">): Promise<string> {
  return git(reference.path, ["diff", reference.base, "--"]);
}

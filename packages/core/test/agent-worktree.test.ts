import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after } from "node:test";
import { worktreeChanges, worktreeDiff } from "../src/agent-worktree.js";

const roots: string[] = [];
after(() => { for (const root of roots) rmSync(root, { recursive: true, force: true }); });
const git = (cwd: string, ...args: string[]): string => execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8" }).trim();

function repository(): { path: string; base: string } {
  const path = mkdtempSync(join(tmpdir(), "pi-extensible-workflows-worktree-"));
  roots.push(path);
  git(path, "init", "-q");
  git(path, "config", "user.name", "test");
  git(path, "config", "user.email", "test@example.com");
  writeFileSync(join(path, "a.txt"), "one\n");
  writeFileSync(join(path, "b.txt"), "one\n");
  git(path, "add", ".");
  git(path, "commit", "-qm", "base");
  return { path, base: git(path, "rev-parse", "HEAD") };
}

void test("a committed change shows in the stat and the diff; a clean tree is not uncommitted", async () => {
  const { path, base } = repository();
  writeFileSync(join(path, "a.txt"), "one\ntwo\n");
  git(path, "commit", "-qam", "change");
  const changes = await worktreeChanges({ path, base });
  assert.ok("stat" in changes);
  assert.equal(changes.uncommitted, false);
  assert.match(changes.stat.join("\n"), /a\.txt \| 1 \+/);
  assert.match(await worktreeDiff({ path, base }), /\+two/);
});

void test("an uncommitted change is reported", async () => {
  const { path, base } = repository();
  writeFileSync(join(path, "b.txt"), "one\nthree\n");
  const changes = await worktreeChanges({ path, base });
  assert.ok("stat" in changes);
  assert.equal(changes.uncommitted, true);
  assert.match(changes.stat.join("\n"), /b\.txt/);
  writeFileSync(join(path, "new.txt"), "x\n");
  git(path, "checkout", "--", "b.txt");
  const untracked = await worktreeChanges({ path, base });
  assert.deepEqual(untracked, { stat: [], uncommitted: true });
  assert.equal(await worktreeDiff({ path, base }), "");
});

void test("a path that no longer exists is removed, a failing git is an error", async () => {
  const { path, base } = repository();
  assert.deepEqual(await worktreeChanges({ path: join(path, "gone"), base }), { removed: true });
  const changes = await worktreeChanges({ path, base: "no-such-revision" });
  assert.ok("error" in changes);
  assert.notEqual(changes.error, "");
});

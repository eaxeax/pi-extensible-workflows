import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const starter = path.join(root, "starter");

void test("starter entries import the core through relative sources, not the package itself", () => {
  const files = readdirSync(starter).filter((name) => name.endsWith(".ts"));
  assert.ok(files.length > 0);
  for (const file of files) {
    const text = readFileSync(path.join(starter, file), "utf8");
    // Static `from` imports and dynamic import(), with either quote.
    for (const match of text.matchAll(/\b(?:from\s+|import\s*\(\s*)(["'])([^"']+)\1/g)) {
      assert.ok(!/^pi-extensible-workflows(?:\/|$)/.test(match[2] ?? ""), `${file} imports the package itself: ${match[2] ?? ""}`);
    }
  }
});

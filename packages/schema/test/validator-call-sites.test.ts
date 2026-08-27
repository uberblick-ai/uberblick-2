/**
 * The room-grammar validator has no callers yet, and that is the property this
 * step delivers.
 *
 * `isCanonicalRoom` / `assertCanonicalRoom` are a *closed* grammar sitting
 * beside a deliberately structural `parseRoom`. The hub parses a room name on
 * every authentication, so the moment something outside this package calls the
 * validator, connections start being refused — which is the enforcement change
 * (#222), and it must arrive deliberately, behind its own flag, in its own
 * reviewable diff. A grep is enough to keep that honest, and it fails on the
 * accident rather than on the intent: the step that adds the first caller
 * deletes this test in the same diff.
 *
 * Source text is what is scanned, not a module graph: an import is a string in
 * a file long before it is an edge, and this is exactly the mistake that would
 * be made by hand.
 */

import { readFileSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const schemaRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const repoRoot = resolve(schemaRoot, "../..");

const VALIDATOR = /\b(?:isCanonicalRoom|assertCanonicalRoom)\b/;
const SOURCE = /\.(?:ts|tsx|mts|cts|js|jsx|mjs|cjs)$/;
const SKIP = new Set(["node_modules", "dist", "build", "coverage", ".vite"]);

/** Every source file under `dir`, build outputs and dependencies excluded. */
function sourceFiles(dir: string): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name.startsWith(".") || SKIP.has(entry.name)) continue;
    const path = join(dir, entry.name);
    if (entry.isDirectory()) found.push(...sourceFiles(path));
    else if (entry.isFile() && SOURCE.test(entry.name)) found.push(path);
  }
  return found;
}

describe("the room-grammar validator", () => {
  it("is called from nowhere outside the schema package", () => {
    const roots = readdirSync(join(repoRoot, "packages"), { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && entry.name !== "schema")
      .map((entry) => join(repoRoot, "packages", entry.name));
    roots.push(join(repoRoot, "scripts"));

    const files = roots.flatMap(sourceFiles);
    // A scan that found nothing to scan would pass silently forever.
    expect(files.length).toBeGreaterThan(50);

    const callers = files.filter((file) =>
      VALIDATOR.test(readFileSync(file, "utf8")),
    );
    expect(callers.map((file) => file.slice(repoRoot.length + 1))).toEqual([]);
  });
});

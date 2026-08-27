/**
 * Hocuspocus is pinned to exactly 4.6.0, and this is the check that keeps it
 * there.
 *
 * Keeping the dependency is a decision (#394), and the decision is for one
 * version: the hub's auth boundary and its shutdown path read library
 * internals — the seams characterized in `hocuspocus-seams.test.ts` — so a
 * patch bump has to be a reviewed act rather than something a resolver does on
 * a Tuesday. A range specifier is what would make that silent, which is why a
 * range is what fails here.
 *
 * Three packages, two places to state the pin:
 *
 * - `@hocuspocus/server` and `@hocuspocus/provider` are named by workspace
 *   manifests, so they are pinned there — and in the lockfile's `specifier:`
 *   for each, which is what `--frozen-lockfile` compares against.
 * - `@hocuspocus/common` is named by no manifest of ours: both of the others
 *   depend on it as `^4.6.0`. A workspace override in `pnpm-workspace.yaml` is
 *   the only place that range can be pinned.
 *
 * This reads files rather than resolving modules on purpose: what must not
 * drift is what a fresh `pnpm install` on another machine would resolve, and
 * that lives in the manifests, not in this checkout's `node_modules`.
 */

import { readFileSync } from "node:fs";
import { readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const REPO = fileURLToPath(new URL("../../../", import.meta.url));

/** The one version the decision names. */
const PINNED = "4.6.0";

/** The packages the decision covers. */
const PINNED_PACKAGES = [
  "@hocuspocus/server",
  "@hocuspocus/provider",
  "@hocuspocus/common",
] as const;

function read(path: string): string {
  return readFileSync(`${REPO}${path}`, "utf8");
}

/** Every workspace manifest, plus the root one. */
function manifests(): string[] {
  const packages = readdirSync(`${REPO}packages`, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => `packages/${entry.name}/package.json`);
  return ["package.json", ...packages.sort()];
}

describe("@hocuspocus/* is pinned to an exact version", () => {
  it("names no range in any package.json", () => {
    const ranged: string[] = [];

    for (const path of manifests()) {
      const manifest = JSON.parse(read(path)) as Record<
        string,
        Record<string, string> | undefined
      >;
      for (const field of [
        "dependencies",
        "devDependencies",
        "peerDependencies",
        "optionalDependencies",
      ]) {
        for (const [name, specifier] of Object.entries(manifest[field] ?? {})) {
          if (!name.startsWith("@hocuspocus/")) continue;
          if (specifier !== PINNED) {
            ranged.push(`${path}: "${name}": "${specifier}"`);
          }
        }
      }
    }

    expect(
      ranged,
      `@hocuspocus/* is pinned to exactly ${PINNED} by decision (#394): the ` +
        "hub reads library internals, so a bump is a reviewed act. Pin the " +
        "specifier and re-characterize the seams before changing the version.",
    ).toEqual([]);
  });

  it("pins @hocuspocus/common, which no manifest names, in the workspace overrides", () => {
    const overrides = read("pnpm-workspace.yaml");

    expect(
      overrides,
      "@hocuspocus/common is a transitive dependency of both server and " +
        `provider, each asking for a range. Override it to ${PINNED}.`,
    ).toMatch(
      new RegExp(`^\\s*['"]?@hocuspocus/common['"]?:\\s*${PINNED}\\s*$`, "m"),
    );
  });

  it("resolves to exactly that version everywhere in the lockfile", () => {
    const lock = read("pnpm-lock.yaml");

    // Every `specifier:` a workspace importer states for a Hocuspocus package.
    const lines = lock.split("\n");
    const specifiers: string[] = [];
    for (const [index, line] of lines.entries()) {
      const named = /^\s+'(@hocuspocus\/[^']+)':\s*$/.exec(line);
      if (named === null) continue;
      const specifier = /^\s+specifier:\s*(.+)$/.exec(lines[index + 1] ?? "");
      if (specifier === null) continue;
      specifiers.push(`${named[1]}: ${specifier[1]}`);
    }

    expect(specifiers.length).toBeGreaterThan(0);
    expect(
      specifiers.filter((entry) => !entry.endsWith(`: ${PINNED}`)),
      "the lockfile is what --frozen-lockfile compares against.",
    ).toEqual([]);

    // And no resolution anywhere in the file — direct or transitive — landed
    // on another version.
    const resolved = new Set(
      [...lock.matchAll(/@hocuspocus\/([a-z-]+)@([^'\s(]+)/g)].map(
        (match) => `${match[1]}@${match[2]}`,
      ),
    );
    expect([...resolved].sort()).toEqual(
      PINNED_PACKAGES.map(
        (name) => `${name.replace("@hocuspocus/", "")}@${PINNED}`,
      ).sort(),
    );
  });
});

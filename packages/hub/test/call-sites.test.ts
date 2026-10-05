/**
 * One property the type system cannot state, checked by reading the source:
 * **every production place that mints a token is enumerated.** That the claims
 * are passed at all is a compile-time guarantee — `TokenRequest` makes `typ`,
 * `kid` and `lifetimeSeconds` required — so this checks the one thing the
 * compiler cannot: a *new* minting site outside the tests is a
 * security-relevant addition, and adding one has to be a deliberate edit here
 * rather than a line nobody noticed. Test files and end-to-end specs mint
 * freely and are not listed.
 *
 * That the credential and membership authorities stay hub-only needs no scan:
 * `packages/hub/package.json` exports neither module.
 */

import { readFileSync, readdirSync } from "node:fs";
import { relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const REPO = fileURLToPath(new URL("../../../", import.meta.url));

/** Every non-test TypeScript source file in the workspace, repo-relative and sorted. */
function productionSources(): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(`${REPO}packages`, {
    recursive: true,
    withFileTypes: true,
  })) {
    if (!entry.isFile() || !/\.tsx?$/.test(entry.name)) continue;
    const path = relative(REPO, `${entry.parentPath}${sep}${entry.name}`)
      .split(sep)
      .join("/");
    if (/\/(?:node_modules|dist|test|e2e)\//.test(path)) continue;
    found.push(path);
  }
  return found.sort();
}

/** The module that defines the token functions is not a call site. */
const DEFINITION = "packages/hub/src/token.ts";

function mentioning(needle: string): string[] {
  return productionSources()
    .filter((path) => path !== DEFINITION)
    .filter((path) => readFileSync(`${REPO}${path}`, "utf8").includes(needle));
}

describe("production token minting sites", () => {
  it("are exactly the files these lists name", () => {
    // Root-secret room tokens: the shared local secret (see token.ts).
    expect(mentioning("mintToken(")).toEqual([
      "packages/mcp-server/src/sync.ts",
      "packages/web/scripts/agent-cursor-demo.ts",
      "packages/web/src/collab/rooms.ts",
    ]);
    // Operation-bound request proofs: 60 seconds, stored credential kid.
    expect(mentioning("mintRequestProof(")).toEqual([
      "packages/cli/src/access-management.ts",
      "packages/hub/src/device-login.ts",
    ]);
  });
});

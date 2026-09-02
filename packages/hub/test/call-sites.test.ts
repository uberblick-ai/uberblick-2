/**
 * Two properties the type system cannot state, checked by reading the source.
 *
 * 1. **`deriveCredentialKey` is hub-only.** A client holds neither the root
 *    secret nor the workspace's `keyVersion`, so a client that calls it cannot
 *    work — an instruction to do exactly that survived two rounds of external
 *    review before anybody tried to run it. Nothing outside `packages/hub` may
 *    name it.
 * 2. **Every place that mints a token is enumerated.** That the three claims are
 *    passed at all is a compile-time guarantee — `TokenRequest` makes `typ`,
 *    `kid` and `lifetimeSeconds` required — so this checks the one thing the
 *    compiler cannot: a *new* minting site is a security-relevant addition, and
 *    adding one has to be a deliberate edit here rather than a line nobody
 *    noticed.
 */

import { readFileSync, readdirSync } from "node:fs";
import { relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const REPO = fileURLToPath(new URL("../../../", import.meta.url));

/** Every TypeScript source file in the workspace, repo-relative and sorted. */
function sources(): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(`${REPO}packages`, {
    recursive: true,
    withFileTypes: true,
  })) {
    if (!entry.isFile() || !/\.tsx?$/.test(entry.name)) continue;
    const path = relative(REPO, `${entry.parentPath}${sep}${entry.name}`);
    if (path.includes(`${sep}node_modules${sep}`) || path.includes(`${sep}dist${sep}`)) {
      continue;
    }
    found.push(path.split(sep).join("/"));
  }
  return found.sort();
}

/**
 * The module that defines the token functions, and this file, which quotes
 * their names to look for them. Neither is a call site.
 */
const NOT_A_CALL_SITE = new Set([
  "packages/hub/src/token.ts",
  "packages/hub/test/call-sites.test.ts",
]);

function mentioning(needle: string): string[] {
  return sources()
    .filter((path) => !NOT_A_CALL_SITE.has(path))
    .filter((path) => readFileSync(`${REPO}${path}`, "utf8").includes(needle));
}

describe("deriveCredentialKey is hub-only", () => {
  it("is named nowhere outside packages/hub", () => {
    const outside = mentioning("deriveCredentialKey").filter(
      (path) => !path.startsWith("packages/hub/"),
    );

    expect(
      outside,
      "a client cannot derive a credential key — it has neither the root " +
        "secret nor the keyVersion. Parse the credential and import its bytes.",
    ).toEqual([]);
  });
});

describe("token minting sites", () => {
  /**
   * Every file that calls `mintToken`. Adding one means a new thing in this
   * repository signs its own authority — so it belongs on this list, with the
   * lifetime and `kid` its call site passes reviewed alongside it.
   */
  const EXPECTED = [
    "packages/cli/test/remote.test.ts",
    "packages/hub/test/credential.test.ts",
    "packages/hub/test/helpers.ts",
    "packages/hub/test/token.test.ts",
    // Disposable architecture harness mints one peer token from its fixture secret.
    "packages/mcp-server/spike/shared-owner.ts",
    "packages/mcp-server/src/sync.ts",
    // Wraps the real mint to hold a token call in flight — no minting site of its own.
    "packages/mcp-server/test/attach-bound.test.ts",
    "packages/mcp-server/test/helpers.ts",
    "packages/web/e2e/chrome.spec.ts",
    "packages/web/scripts/agent-cursor-demo.ts",
    "packages/web/src/collab/rooms.ts",
    "packages/web/test/reconnect.test.ts",
    "packages/web/test/token.test.ts",
  ];

  it("are exactly the files this list names", () => {
    expect(mentioning("mintToken(")).toEqual(EXPECTED);
  });
});

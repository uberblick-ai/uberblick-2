import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { PACKAGE_ROOT } from "./helpers.js";

describe("CLI process helpers", () => {
  it("never blocks the event loop in a suite that serves in-process", () => {
    const testDir = join(PACKAGE_ROOT, "test");
    const offenders = readdirSync(testDir)
      .filter((name) => name.endsWith(".test.ts"))
      .filter((name) => {
        const source = readFileSync(join(testDir, name), "utf8");
        const servesInProcess =
          /\b(?:createHub|createServer|WebSocketServer)\s*\(|\.listen\s*\(/.test(
            source,
          );
        const importsBlockingHelper =
          /import\s*\{[^}]*\brunUb\b[^}]*\}\s*from\s*["']\.\/helpers\.js["']/s.test(
            source,
          );
        return servesInProcess && importsBlockingHelper;
      });

    // runUb uses spawnSync, so the child cannot reach a server on this process's
    // blocked event loop. Server-owning suites must use runUbAsync instead.
    expect(offenders).toEqual([]);
  });
});

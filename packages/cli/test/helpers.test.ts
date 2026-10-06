import { appendFileSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, describe, expect, inject, it } from "vitest";
import { resolveProjectBinding, writeProjectBinding } from "../src/project-binding.js";
import { createBoundFixtureParent } from "./binding-fixtures.js";
import { PACKAGE_ROOT, removeTempDirs, sandbox } from "./helpers.js";

afterAll(removeTempDirs);

describe("CLI process helpers", () => {
  it("gives every ordinary fixture its own binding before a reader or writer runs", () => {
    const box = sandbox();
    const path = join(box.cwd, ".uberblick.json");
    const parentPath = join(inject("boundFixtureRoot"), ".uberblick.json");
    const parentBytes = readFileSync(parentPath);
    const selected = resolveProjectBinding({ env: box.env, cwd: box.cwd });
    expect(selected.path).toBe(path);
    expect(selected.binding?.workspaceId).not.toBe(JSON.parse(parentBytes.toString()).workspaceId);
    expect(writeProjectBinding({ workspaceId: "11111111-1111-4111-8111-111111111111", hubUrl: null }, { cwd: box.cwd })).toBe(path);
    expect(readFileSync(parentPath)).toEqual(parentBytes);
  });

  it("fails suite teardown even when a parent edit preserves its JSON meaning", () => {
    const parent = createBoundFixtureParent();
    appendFileSync(join(parent.root, ".uberblick.json"), "\n");
    expect(parent.teardown).toThrow(/changed its parent/);
  });

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

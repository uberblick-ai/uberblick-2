import { spawnSync } from "node:child_process";
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { afterAll, describe, expect, inject, it } from "vitest";
import { resolveProjectBinding, writeProjectBinding } from "../src/project-binding.js";
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

  it.each([false, true])("fails the run only when suite teardown finds changed parent bytes (edit: %s)", (edit) => {
    const box = sandbox();
    const configPath = join(box.cwd, "vitest.config.mjs");
    // Run the suite's real guard without rebuilding the shared CLI bundle while
    // other workers may be spawning it.
    writeFileSync(configPath, `export default ${JSON.stringify({
      root: PACKAGE_ROOT,
      test: {
        include: ["test/fixtures/binding-parent.fixture.ts"],
        globalSetup: [join(PACKAGE_ROOT, "test/binding-fixtures.ts")],
        reporters: ["dot"],
        maxWorkers: 1,
        execArgv: ["--no-experimental-webstorage"],
      },
    })};`);
    const vitestRoot = dirname(createRequire(import.meta.url).resolve("vitest/package.json"));
    const run = spawnSync(process.execPath, [
      join(vitestRoot, "vitest.mjs"), "run", "--config", configPath,
      "-t", edit ? "changes parent bytes" : "leaves parent unchanged",
    ], {
      cwd: PACKAGE_ROOT,
      env: box.env,
      encoding: "utf8",
      timeout: 30_000,
    });
    expect(run.error).toBeUndefined();
    expect(run.signal).toBeNull();
    expect(run.stdout).toContain("1 passed");
    expect(run.status, run.stdout + run.stderr).toBe(edit ? 1 : 0);
    if (edit) expect(run.stderr).toContain("CLI suite changed its parent .uberblick.json");
    else expect(run.stderr).not.toContain("CLI suite changed its parent .uberblick.json");
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

import { existsSync, mkdirSync, readFileSync, readdirSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { acquireInitLock } from "@uberblick/mcp-server/init-lock";
import { resolveStorage } from "@uberblick/mcp-server/storage";
import type { UninstallHost } from "../src/uninstall.js";
import { freePort, sandbox } from "./helpers.js";
import { runInProcess } from "./in-process.js";
import { cleanUp, fixtureBundle, open, openFails, WORKSPACE, REBOUND_WORKSPACE } from "./open-fixtures.js";

afterEach(cleanUp);

function homebrew() {
  return {
    cliDir: "/opt/homebrew/Cellar/uberblick/0.4.11/libexec", installPayload: true,
    capture: () => ({ status: 0, stdout: "/opt/homebrew\n", stderr: "" }),
    run: vi.fn<UninstallHost["run"]>().mockResolvedValue(null),
    isTerminal: false, confirm: vi.fn<UninstallHost["confirm"]>(),
  } satisfies UninstallHost;
}

it("refuses deletion for every external-database open and permits keeping data without waiting for configuration writers", async () => {
  const box = sandbox({ projectBinding: { workspaceId: WORKSPACE, hubUrl: "wss://uninstall.example.test/ws" } });
  const roots = resolveStorage({ env: box.env });
  const env = { UBERBLICK_WEB_DIST: fixtureBundle(box), BROWSER: "none" };
  const firstPath = join(box.cwd, "first.sqlite");
  const secondPath = join(box.cwd, "second.sqlite");
  const first = await open(box, ["--port", String(await freePort())], { ...env, UBERBLICK_DB: firstPath });
  const second = await open(box, ["--port", String(await freePort())], {
    ...env, UBERBLICK_DB: secondPath, UB_WORKSPACE_ID: REBOUND_WORKSPACE, UB_HUB_URL: "wss://uninstall.example.test/ws",
  });
  const fake = homebrew();
  try {
    expect(existsSync(join(roots.dataDir, `${WORKSPACE}.sqlite`))).toBe(false);
    for (const remaining of [2, 1]) {
      const configBefore = readFileSync(join(roots.configDir, "workspaces.json"));
      const refused = await runInProcess(["uninstall", "--yes", "--delete-data"], box, {}, { uninstallHost: fake });
      expect(refused.status, refused.output).toBe(1);
      expect(refused.stderr).toMatch(/stop.*(?:run|ub open).*first|stop that run before/);
      expect(fake.run).not.toHaveBeenCalled();
      expect(readFileSync(join(roots.configDir, "workspaces.json"))).toEqual(configBefore);
      expect(existsSync(firstPath)).toBe(true);
      expect(existsSync(secondPath)).toBe(true);
      if (remaining === 2) expect((await first.interrupt()).status).toBe(0);
    }
    const lock = await acquireInitLock(box.env);
    try {
      const kept = await runInProcess(["uninstall", "--yes"], box, {}, { uninstallHost: fake });
      expect(kept.status, kept.output).toBe(0);
      expect(fake.run).toHaveBeenCalledOnce();
      expect(kept.stdout).toMatch(/data.*kept/i);
    } finally { lock.release(); }
  } finally {
    await first.interrupt();
    expect((await second.interrupt()).status).toBe(0);
  }
  expect(readdirSync(join(roots.configDir, ".open-runs"))).toEqual([]);
  const deleted = await runInProcess(["uninstall", "--yes", "--delete-data"], box, {}, { uninstallHost: fake });
  expect(deleted.status, deleted.output).toBe(0);
  expect(existsSync(roots.configDir)).toBe(false);
  expect(existsSync(firstPath)).toBe(true);
  expect(existsSync(secondPath)).toBe(true);
});

it("releases the open-run lock after startup failure and ignores an abandoned lock file", async () => {
  const box = sandbox({ projectBinding: { workspaceId: WORKSPACE, hubUrl: "wss://uninstall.example.test/ws" } });
  const roots = resolveStorage({ env: box.env });
  const running = await open(box, ["--port", String(await freePort())], {
    UBERBLICK_WEB_DIST: fixtureBundle(box), UBERBLICK_DB: join(box.cwd, "external.sqlite"), BROWSER: "none",
  });
  // A port conflict fails after registration and engine startup.
  const failed = await openFails(box, ["--port", new URL(running.url).port], {
    UBERBLICK_WEB_DIST: fixtureBundle(box), UBERBLICK_DB: join(box.cwd, "other.sqlite"), BROWSER: "none",
    UB_WORKSPACE_ID: REBOUND_WORKSPACE, UB_HUB_URL: "wss://uninstall.example.test/ws",
  });
  expect(failed.status, failed.output).toBe(1);
  expect((await running.interrupt()).status).toBe(0);
  expect(readdirSync(join(roots.configDir, ".open-runs"))).toEqual([]);
  // A crashed run leaves the SQLite name, but no process holds its transaction.
  writeFileSync(join(roots.configDir, ".open-runs", `${WORKSPACE}.serving-lock`), "");
  const fake = homebrew();
  const removed = await runInProcess(["uninstall", "--yes", "--delete-data"], box, {}, { uninstallHost: fake });
  expect(removed.status, removed.output).toBe(0);
  expect(existsSync(roots.configDir)).toBe(false);
  expect(fake.run).toHaveBeenCalledOnce();
});

it.each(["same", "config inside data", "data inside config", "aliased parents"])("deletes %s roots", async shape => {
  const box = sandbox();
  if (shape === "same") box.env.XDG_CONFIG_HOME = box.env.XDG_DATA_HOME;
  if (shape === "config inside data") box.env.XDG_CONFIG_HOME = join(box.dataHome, "uberblick", "nested");
  if (shape === "data inside config") box.env.XDG_DATA_HOME = join(box.configHome, "uberblick", "nested");
  if (shape === "aliased parents") {
    mkdirSync(box.configHome, { recursive: true });
    const alias = join(box.cwd, "config-alias");
    symlinkSync(box.configHome, alias);
    box.env.XDG_DATA_HOME = alias;
  }
  const roots = resolveStorage({ env: box.env });
  for (const root of [roots.dataDir, roots.configDir]) {
    mkdirSync(root, { recursive: true });
    writeFileSync(join(root, "settings"), "disposable");
  }
  const fake = homebrew();
  const result = await runInProcess(["uninstall", "--yes", "--delete-data"], box, {}, { uninstallHost: fake });
  expect(result.status, result.output).toBe(0);
  expect(existsSync(roots.dataDir)).toBe(false);
  expect(existsSync(roots.configDir)).toBe(false);
  expect(fake.run).toHaveBeenCalledOnce();
});

it("refuses a symlinked root before creating a lock and preserves its target", async () => {
  const box = sandbox();
  const roots = resolveStorage({ env: box.env });
  const target = join(box.cwd, "kept-config");
  mkdirSync(target);
  writeFileSync(join(target, "kept"), "outside data");
  mkdirSync(box.configHome, { recursive: true });
  symlinkSync(target, roots.configDir);
  const fake = homebrew();
  const refused = await runInProcess(["uninstall", "--yes", "--delete-data"], box, {}, { uninstallHost: fake });
  expect(refused.status, refused.output).toBe(1);
  expect(refused.stderr).toContain(roots.configDir);
  expect(fake.run).not.toHaveBeenCalled();
  expect(readdirSync(target)).toEqual(["kept"]);
  expect(readFileSync(join(target, "kept"), "utf8")).toBe("outside data");
});

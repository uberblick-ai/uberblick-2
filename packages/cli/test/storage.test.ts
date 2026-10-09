/**
 * Where `ub` puts a user's files, and what it says about it.
 *
 * The layout itself is proved in `@uberblick/hub`'s suite; this one is about
 * the commands: that whoever creates the tree first leaves it owner-only, that
 * `ub status` reports the resolved paths in a stable shape, and that there is
 * no layout question left for `ub doctor` to have an opinion about.
 */

import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { createHub, silentLogger } from "@uberblick/hub";
import { hubDatabasePath } from "@uberblick/hub/config";
import { credentialsPath, resolveConfig, userConfigPath, writeCredentials } from "../src/config.js";
import { doctorReport } from "../src/doctor.js";
import type { StatusReport } from "../src/status.js";
import { renderStatus, statusReport } from "../src/status.js";
import {
  DEAD_HUB_URL,
  REPO_ROOT,
  SECRET_IN_ENV,
  SECRET_ON_FILE,
  removeTempDirs,
  runUbAsync,
  sandbox,
  tracesOf,
} from "./helpers.js";

const WORKSPACE = "0d4a1e7c-2b93-4f18-9a55-6c7e8d1b2f30";
/** A second workspace, for the case where two layers name different ones. */
const PINNED = "7b6e5d4c-3a29-4180-b5c6-1d2e3f405162";

const tempDirs: string[] = [];

afterAll(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
  removeTempDirs();
});

/** A throwaway home, with nothing in it and nothing of the developer's. */
function home(): string {
  const dir = mkdtempSync(join(tmpdir(), "uberblick-cli-storage-"));
  tempDirs.push(dir);
  return dir;
}

/** An environment that resolves against nothing but that home. */
function homeEnv(root: string, extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return { HOME: root, UB_WORKSPACE_ID: WORKSPACE, UB_HUB_URL: "local", ...extra };
}

function configRoot(root: string): string {
  return join(root, ".config", "uberblick");
}

function dataRoot(root: string): string {
  return join(root, ".local", "share", "uberblick");
}

describe("the resolved roots", () => {
  it("are what every path in a resolution comes out of", () => {
    const root = home();
    const env = homeEnv(root);

    expect(userConfigPath(env)).toBe(join(configRoot(root), "config.json"));
    expect(credentialsPath(env)).toBe(join(configRoot(root), "credentials.json"));

    const resolved = resolveConfig({ env, cwd: root });
    expect(resolved.paths.userConfig).toBe(join(configRoot(root), "config.json"));
    expect(resolved.paths.credentials).toBe(
      join(configRoot(root), "credentials.json"),
    );
    expect(resolved.storage.dataDir).toBe(dataRoot(root));
    expect(resolved.warnings).toEqual([]);
    // Resolution creates nothing; the writers do.
    expect(existsSync(configRoot(root))).toBe(false);
  });

  it("writes credentials.json owner-only, in a directory only its owner can enter", () => {
    const root = home();
    const path = writeCredentials(
      { signingSecret: "layout-test-secret" },
      homeEnv(root),
    );

    expect(path).toBe(join(configRoot(root), "credentials.json"));
    expect(statSync(path).mode & 0o777).toBe(0o600);
    // The directory the CLI created for it. Another account being able to
    // enter it is how a file at 0600 stops being the whole answer.
    expect(statSync(configRoot(root)).mode & 0o077).toBe(0);
  });

  it("stays owner-only when the hub is the first writer", async () => {
    // Whoever creates the tree decides what it is: `mkdirSync` applies its mode
    // only to directories it creates, so an `uberblick/` made at the umask by
    // the hub would still be group-readable when `ub workspace create` later writes
    // credentials.json into it with `mode: 0o700`.
    const root = home();
    const env = homeEnv(root);
    const hub = await createHub({
      port: 0,
      databasePath: hubDatabasePath(env),
      authSecret: "storage-ordering-test-secret",
      log: silentLogger,
    });
    await hub.stop();

    expect(statSync(join(dataRoot(root), "hub.sqlite")).mode & 0o777).toBe(0o600);
    expect(statSync(dataRoot(root)).mode & 0o077).toBe(0);

    writeCredentials({ signingSecret: "ordering-secret" }, env);
    expect(statSync(configRoot(root)).mode & 0o077).toBe(0);
  });

  it("stays owner-only when a workspace replica is the first writer", async () => {
    const root = home();
    const env = homeEnv(root, { UB_WORKSPACE_ID: WORKSPACE, UB_HUB_URL: "local" });
    const { report } = await statusReport({ env, cwd: root });

    if (report.workspace === null) throw new Error("expected the explicit binding");

    // 0600 because the replica is the whole corpus. The chmod happens before
    // the WAL exists, so the files SQLite creates beside it inherit the mode.
    expect(statSync(report.storage.workspace).mode & 0o777).toBe(0o600);
    expect(statSync(dataRoot(root)).mode & 0o077).toBe(0);

    writeCredentials({ signingSecret: "ordering-secret" }, env);
    expect(statSync(configRoot(root)).mode & 0o077).toBe(0);
  });
});

describe("`ub status`", () => {
  it("reports a storage object with the resolved paths, and no secret", async () => {
    const box = sandbox({
      credentials: { signingSecret: "storage-test-secret-91af3c" },
      projectBinding: { workspaceId: WORKSPACE, hubUrl: "ws://127.0.0.1:9/dead" },
    });

    // Async, not `runUb`: this suite owns an in-process hub in the ordering
    // test above, and spawnSync would block the event loop it runs on.
    const run = await runUbAsync(["status", "--json"], box);
    expect(run.status).toBe(0);
    const report = JSON.parse(run.stdout);

    expect(report.storage).toEqual({
      // Constant, on every platform — a reader of the JSON still finds the key.
      layout: "xdg",
      config: join(box.configHome, "uberblick", "config.json"),
      data: join(box.dataHome, "uberblick"),
      hub: join(box.dataHome, "uberblick", "hub.sqlite"),
      workspace: join(box.dataHome, "uberblick", `${WORKSPACE}.sqlite`),
    });
    expect(run.output).not.toContain("storage-test-secret-91af3c");
  });

  it("says two signing secrets differ without leaking either, in text and JSON", async () => {
    // The conflict remains in warnings and JSON: the two secrets are distinct and of
    // different lengths, and neither may survive in either stream — not whole,
    // not in four-character fragments, not as a size. See `tracesOf`.
    const box = sandbox({
      credentials: { signingSecret: SECRET_ON_FILE },
      projectBinding: { workspaceId: WORKSPACE, hubUrl: DEAD_HUB_URL },
    });
    const pinned = { HUB_AUTH_TOKEN: SECRET_IN_ENV };

    const text = await runUbAsync(["status"], box, pinned);
    expect(text.status).toBe(0);
    expect(text.stderr).toContain("holds a different signing secret");
    expect(text.stdout).not.toMatch(/shadowed|credential/);
    expect(tracesOf(SECRET_IN_ENV, text.output)).toEqual([]);
    expect(tracesOf(SECRET_ON_FILE, text.output)).toEqual([]);

    const json = await runUbAsync(["status", "--json"], box, pinned);
    expect(json.status).toBe(0);
    const report = JSON.parse(json.stdout) as StatusReport;
    // Which layer lost, and that one is in force. Never a value out of either.
    expect(report.shadowed).toEqual([
      { setting: "credential", layer: "credentials file" },
    ]);
    expect(report.credentialSource).toBe("environment");
    expect(report.credentialPresent).toBe(true);
    expect(tracesOf(SECRET_IN_ENV, json.output)).toEqual([]);
    expect(tracesOf(SECRET_ON_FILE, json.output)).toEqual([]);
  });

  it("shows the complete environment binding instead of merging it with the project", async () => {
    const box = sandbox({ projectBinding: { workspaceId: WORKSPACE, hubUrl: "https://project.example.test" } });
    const selected = await statusReport({
      env: { ...box.env, UB_WORKSPACE_ID: PINNED, UB_HUB_URL: "local" },
      cwd: box.cwd,
    });
    if (selected.report.workspace === null) throw new Error("expected an environment binding");

    expect(selected.report.sources).toEqual({ workspace: "environment", hubUrl: "environment" });
    expect(selected.report.binding).toEqual({ workspaceId: PINNED, hubUrl: null });
    expect(selected.report.projectConfig).toBeNull();
    expect(selected.report.shadowed).toBeUndefined();
    expect(renderStatus(selected.report)).toMatch(/selection\s+environment/);
    expect(renderStatus(selected.report)).toMatch(/hub\s+local \(this computer\)/);
    expect(selected.warnings).toEqual([]);
  });

  it("keeps database and storage paths outside the human overview", async () => {
    const box = sandbox({ projectBinding: { workspaceId: WORKSPACE, hubUrl: null } });
    const run = await runUbAsync(["status"], box);

    expect(run.status).toBe(0);
    expect(run.stdout).not.toMatch(/^storage|^database/m);
    expect(run.stdout).not.toContain(box.dataHome);
  });
});

describe("`ub doctor`", () => {
  it("has no layout check, because there is no layout question", async () => {
    // One layout on every platform: nothing to detect, nothing to refuse, and
    // therefore no check below which the rest would have to be skipped.
    const root = home();
    const { report } = await doctorReport({
      env: homeEnv(root, { UB_WORKSPACE_ID: WORKSPACE, UB_HUB_URL: "local" }),
      cwd: root,
    });

    expect(report.checks.map((one) => one.name)).toEqual([
      "workspace",
      "login",
      "database",
      "hub",
      "clock",
      "local hub",
      "mcp",
    ]);
  });
});

// --- development, which must never open the packaged user's database ---------

describe("the development tasks", () => {
  it("give the hub an explicit checkout-local database", () => {
    // Without this, `mise run hub` and `mise run dev` would open the hub
    // database of whoever is sitting at the machine.
    const mise = readFileSync(join(REPO_ROOT, "mise.toml"), "utf8");
    const setting = /^HUB_DB_PATH = "(.+)"$/m.exec(mise);

    expect(setting?.[1]).toBeDefined();
    expect(setting?.[1]).toContain("{{config_root}}");
    expect(setting?.[1]).toMatch(/\.sqlite$/);
    // In the `[env]` block, so every task in the checkout inherits it, the e2e
    // harness included. (The Docker review container runs `pnpm` directly, with
    // no mise, and needs nothing: no suite there opens a default database.)
    expect(mise.indexOf("HUB_DB_PATH")).toBeGreaterThan(mise.indexOf("[env]"));
    expect(mise.indexOf("HUB_DB_PATH")).toBeLessThan(mise.indexOf("[tasks."));
  });
});

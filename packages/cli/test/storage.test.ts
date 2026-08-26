/**
 * Where `ub` puts a user's files, and what it says about it.
 *
 * The layout itself is proved in `@uberblick/hub`'s suite; this one is about
 * the commands: that `ub status` reports the layout in a stable shape, that a
 * legacy macOS installation is told once and moved never, that two roots is a
 * refusal rather than a guess, and that a Mac install really does write its
 * `credentials.json` into Application Support at mode 0600.
 *
 * The Mac cases resolve in-process with `platform: "darwin"` — the parameter
 * every layer takes for exactly this reason. Spawning `ub` would test the
 * platform the tests happen to run on, and mocking `process.platform` inside
 * the CLI would test the mock.
 */

import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { credentialsPath, resolveConfig, userConfigPath, writeCredentials } from "../src/config.js";
import { doctorReport } from "../src/doctor.js";
import { statusReport } from "../src/status.js";
import { REPO_ROOT, removeTempDirs, runUb, sandbox } from "./helpers.js";

const WORKSPACE = "0d4a1e7c-2b93-4f18-9a55-6c7e8d1b2f30";

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
function macEnv(root: string, extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return { HOME: root, ...extra };
}

function macRoot(root: string): string {
  return join(root, "Library", "Application Support", "Uberblick");
}

function seed(path: string, text = ""): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text, "utf8");
}

// --- a fresh Mac -------------------------------------------------------------

describe("a fresh Mac", () => {
  it("resolves config and credentials into Application Support", () => {
    const root = home();
    const env = macEnv(root);

    expect(userConfigPath(env, "darwin")).toBe(join(macRoot(root), "config.json"));
    expect(credentialsPath(env, "darwin")).toBe(
      join(macRoot(root), "credentials.json"),
    );

    const resolved = resolveConfig({ env, cwd: root, platform: "darwin" });
    expect(resolved.storage.layout).toBe("mac");
    expect(resolved.paths.userConfig).toBe(join(macRoot(root), "config.json"));
    expect(resolved.paths.credentials).toBe(
      join(macRoot(root), "credentials.json"),
    );
    expect(resolved.warnings).toEqual([]);
  });

  it("writes credentials.json owner-only, in a directory only its owner can enter", () => {
    const root = home();
    const path = writeCredentials(
      { signingSecret: "mac-layout-test-secret" },
      macEnv(root),
      "darwin",
    );

    expect(path).toBe(join(macRoot(root), "credentials.json"));
    expect(statSync(path).mode & 0o777).toBe(0o600);
    // The directory the CLI created for it. Another account being able to
    // enter it is how a file at 0600 stops being the whole answer.
    expect(statSync(macRoot(root)).mode & 0o077).toBe(0);
  });

  it("reports the whole layout through `ub status`", async () => {
    const root = home();
    // No signing secret: local-only, so this opens no socket and the report
    // comes back at once.
    const { report } = await statusReport({
      env: macEnv(root, { WORKSPACE_ID: WORKSPACE }),
      cwd: root,
      platform: "darwin",
    });

    expect(report.storage).toEqual({
      layout: "mac",
      config: join(macRoot(root), "config.json"),
      data: join(macRoot(root), "data"),
      hub: join(macRoot(root), "data", "hub.sqlite"),
      workspace: join(macRoot(root), "data", "workspaces", `${WORKSPACE}.sqlite`),
    });
    // The replica really is there: the layout is not just a string in a report.
    expect(report.databasePath).toBe(report.storage.workspace);
    expect(existsSync(report.storage.workspace)).toBe(true);
  });
});

// --- a Mac that already had files --------------------------------------------

describe("a legacy Mac", () => {
  it("stays on the old roots, says so once, and creates nothing new", () => {
    const root = home();
    seed(join(root, ".config", "uberblick", "config.json"), "{}\n");
    seed(join(root, ".local", "share", "uberblick", `${WORKSPACE}.sqlite`));

    const resolved = resolveConfig({
      env: macEnv(root),
      cwd: root,
      platform: "darwin",
    });

    expect(resolved.storage.layout).toBe("legacy-xdg");
    expect(resolved.paths.userConfig).toBe(
      join(root, ".config", "uberblick", "config.json"),
    );
    expect(resolved.paths.credentials).toBe(
      join(root, ".config", "uberblick", "credentials.json"),
    );
    expect(resolved.storage.workspaceDir).toBe(
      join(root, ".local", "share", "uberblick"),
    );

    // One line, naming the command that will move them — and no Application
    // Support directory brought into being by having asked.
    const migration = resolved.warnings.filter((one) =>
      /ub storage migrate/.test(one),
    );
    expect(migration).toHaveLength(1);
    expect(existsSync(join(root, "Library"))).toBe(false);
  });

  it("keeps `ub status` on the old replica, and creates no Mac root", async () => {
    const root = home();
    seed(join(root, ".config", "uberblick", "config.json"), "{}\n");

    const { report, warnings } = await statusReport({
      env: macEnv(root, { WORKSPACE_ID: WORKSPACE }),
      cwd: root,
      platform: "darwin",
    });

    expect(report.storage).toEqual({
      layout: "legacy-xdg",
      config: join(root, ".config", "uberblick", "config.json"),
      data: join(root, ".local", "share", "uberblick"),
      hub: join(root, ".local", "share", "uberblick", "hub.sqlite"),
      workspace: join(root, ".local", "share", "uberblick", `${WORKSPACE}.sqlite`),
    });
    expect(existsSync(report.storage.workspace)).toBe(true);
    expect(existsSync(join(root, "Library"))).toBe(false);
    expect(warnings.filter((one) => /ub storage migrate/.test(one))).toHaveLength(1);
  });

  it("passes `ub doctor`, which names the migration under the check", async () => {
    const root = home();
    seed(join(root, ".config", "uberblick", "credentials.json"), "{}\n");

    const { report } = await doctorReport({
      env: macEnv(root),
      cwd: root,
      platform: "darwin",
    });

    const layout = report.checks.find((one) => one.name === "storage-layout");
    expect(layout?.status).toBe("pass");
    expect(layout?.reason).toContain("legacy-xdg");
    expect(layout?.remedy).toMatch(/ub storage migrate/);
    expect(existsSync(join(root, "Library"))).toBe(false);
  });
});

// --- both roots --------------------------------------------------------------

describe("state in both roots", () => {
  it("fails the storage-layout check, skips the rest, and opens no database", async () => {
    const root = home();
    seed(join(root, ".config", "uberblick", "config.json"), "{}\n");
    seed(join(macRoot(root), "config.json"), "{}\n");

    const { report } = await doctorReport({
      env: macEnv(root, { WORKSPACE_ID: WORKSPACE }),
      cwd: root,
      platform: "darwin",
    });

    expect(report.ok).toBe(false);
    const [first, ...rest] = report.checks;
    expect(first?.name).toBe("storage-layout");
    expect(first?.status).toBe("fail");
    // Both roots named: the person reading this has to know what to reconcile.
    expect(first?.reason).toContain(macRoot(root));
    expect(first?.reason).toContain(join(root, ".config", "uberblick"));
    expect(first?.reason).toContain(join(root, ".local", "share", "uberblick"));
    expect(first?.remedy).toMatch(/ub storage migrate/);

    // Nothing below it ran against a guessed root.
    expect(rest.map((one) => one.name)).toEqual([
      "workspace",
      "credential",
      "database",
      "hub",
      "port",
      "bind",
      "mcp",
    ]);
    for (const check of rest) {
      expect(check.status).toBe("skipped");
    }
    expect(existsSync(join(macRoot(root), "data"))).toBe(false);
    expect(existsSync(join(root, ".local", "share", "uberblick"))).toBe(false);
  });

  it("refuses rather than resolving, for every other command", () => {
    const root = home();
    seed(join(root, ".config", "uberblick", "config.json"), "{}\n");
    seed(join(macRoot(root), "credentials.json"), "{}\n");

    expect(() =>
      resolveConfig({ env: macEnv(root), cwd: root, platform: "darwin" }),
    ).toThrow(/refusing to guess/);
  });
});

// --- the XDG machine every contributor is on ---------------------------------

describe("`ub status` on an XDG machine", () => {
  it("reports a storage object with the resolved paths, and no secret", () => {
    const box = sandbox({
      credentials: { signingSecret: "storage-test-secret-91af3c" },
      userConfig: { workspace: WORKSPACE, hubUrl: "ws://127.0.0.1:9/dead" },
    });

    const run = runUb(["status", "--json"], box);
    expect(run.status).toBe(0);
    const report = JSON.parse(run.stdout);

    expect(report.storage).toEqual({
      layout: "xdg",
      config: join(box.configHome, "uberblick", "config.json"),
      data: join(box.dataHome, "uberblick"),
      hub: join(box.dataHome, "uberblick", "hub.sqlite"),
      workspace: join(box.dataHome, "uberblick", `${WORKSPACE}.sqlite`),
    });
    expect(run.output).not.toContain("storage-test-secret-91af3c");
  });

  it("names the data root once in the human output", () => {
    const box = sandbox({ userConfig: { workspace: WORKSPACE } });
    const run = runUb(["status"], box);

    expect(run.status).toBe(0);
    const named = run.stdout
      .split("\n")
      .filter((line) => line.startsWith("storage"));
    expect(named).toHaveLength(1);
    expect(named[0]).toContain("xdg");
    expect(named[0]).toContain(join(box.dataHome, "uberblick"));
  });
});

// --- development, which must never open the packaged user's database ---------

describe("the development tasks", () => {
  it("give the hub an explicit checkout-local database", () => {
    // Without this, `mise run hub` and `mise run dev` would open the hub
    // database of whoever is sitting at the machine — on a Mac, the one under
    // Application Support that a packaged install uses.
    const mise = readFileSync(join(REPO_ROOT, "mise.toml"), "utf8");
    const setting = /^HUB_DB_PATH = "(.+)"$/m.exec(mise);

    expect(setting?.[1]).toBeDefined();
    expect(setting?.[1]).toContain("{{config_root}}");
    expect(setting?.[1]).toMatch(/\.sqlite$/);
    // In the `[env]` block, so every task in the checkout inherits it — the
    // review image and the e2e harness included.
    expect(mise.indexOf("HUB_DB_PATH")).toBeGreaterThan(mise.indexOf("[env]"));
    expect(mise.indexOf("HUB_DB_PATH")).toBeLessThan(mise.indexOf("[tasks."));
  });
});

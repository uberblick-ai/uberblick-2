/**
 * The storage layout: where a machine's files are, and what may move them.
 *
 * There is one layout, so the contract is a small table — environment in, four
 * paths out — plus the two properties that make "one layout" a fact rather than
 * a claim: it does not consult the platform, and resolving creates nothing.
 *
 * Every case resolves against a throwaway `HOME`. A test that read the
 * developer's real one would be a test of the developer's machine.
 */

import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import { defaultDatabasePath } from "../src/config.js";
import { resolveStorage } from "../src/storage.js";

const PACKAGE_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));

const WORKSPACE = "3f6a1c20-9d84-4b1e-8a77-2c5e9b0d4411";

const tempDirs: string[] = [];

afterAll(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

/** A throwaway home directory, empty until a case seeds it. */
function home(): string {
  const dir = mkdtempSync(join(tmpdir(), "uberblick-storage-"));
  tempDirs.push(dir);
  return dir;
}

interface Case {
  name: string;
  /** `HOME` is added by the runner; this is everything else. */
  env?: NodeJS.ProcessEnv;
  paths: (root: string) => {
    configDir: string;
    dataDir: string;
    hubDatabase: string;
    workspaceDir: string;
  };
}

function xdgUnder(configHome: string, dataHome: string) {
  const dataDir = join(dataHome, "uberblick");
  return {
    configDir: join(configHome, "uberblick"),
    dataDir,
    hubDatabase: join(dataDir, "hub.sqlite"),
    workspaceDir: dataDir,
  };
}

function defaults(root: string) {
  return xdgUnder(join(root, ".config"), join(root, ".local", "share"));
}

const CASES: Case[] = [
  {
    name: "no overrides gives the XDG defaults under HOME",
    paths: defaults,
  },
  {
    name: "an explicit XDG_CONFIG_HOME and XDG_DATA_HOME are honoured",
    env: { XDG_CONFIG_HOME: "/srv/conf", XDG_DATA_HOME: "/srv/data" },
    paths: () => xdgUnder("/srv/conf", "/srv/data"),
  },
  {
    // One variable moves its own half; the other keeps its default. Both are
    // still the same layout — there is no second one to fall back to.
    name: "XDG_CONFIG_HOME alone moves only the config root",
    env: { XDG_CONFIG_HOME: "/srv/conf" },
    paths: (root) => xdgUnder("/srv/conf", join(root, ".local", "share")),
  },
  {
    name: "an empty XDG variable is not an override",
    env: { XDG_CONFIG_HOME: "  " },
    paths: defaults,
  },
  {
    // The XDG spec: a relative value must be ignored. Honouring one would put
    // this machine's files wherever the command was started from.
    name: "a relative XDG_CONFIG_HOME is ignored",
    env: { XDG_CONFIG_HOME: "relative/conf" },
    paths: defaults,
  },
  {
    name: "a relative XDG_DATA_HOME is ignored",
    env: { XDG_DATA_HOME: "./data" },
    paths: defaults,
  },
];

describe("the layout", () => {
  for (const one of CASES) {
    it(one.name, () => {
      const root = home();
      const storage = resolveStorage({ env: { HOME: root, ...one.env } });
      const expected = one.paths(root);

      expect(storage.configDir).toBe(expected.configDir);
      expect(storage.dataDir).toBe(expected.dataDir);
      expect(storage.hubDatabase).toBe(expected.hubDatabase);
      expect(storage.workspaceDir).toBe(expected.workspaceDir);
      expect(join(storage.workspaceDir, `${WORKSPACE}.sqlite`)).toBe(
        join(expected.dataDir, `${WORKSPACE}.sqlite`),
      );
    });
  }

  it("creates nothing: resolution is paths, never directories", () => {
    const root = home();
    resolveStorage({ env: { HOME: root } });
    expect(existsSync(join(root, ".config"))).toBe(false);
    expect(existsSync(join(root, ".local"))).toBe(false);
  });
});

/**
 * The same answer on macOS as on Linux — the whole of "one layout".
 *
 * `resolveStorage` takes no platform, so the only honest way to ask is to run
 * it in a process that *believes* it is on one: a child that redefines
 * `process.platform` before importing the module. A parameter would be a
 * parameter someone could pass differently.
 */
describe("platform independence", () => {
  function resolvedOn(platform: NodeJS.Platform, root: string): string {
    const probe = spawnSync(
      process.execPath,
      [
        "--import",
        "tsx",
        "--eval",
        `Object.defineProperty(process, "platform", { value: ${JSON.stringify(platform)} });\n` +
          `const { resolveStorage } = await import(${JSON.stringify(join(PACKAGE_ROOT, "src", "storage.ts"))});\n` +
          "process.stdout.write(JSON.stringify(resolveStorage()));\n",
        "--input-type=module",
      ],
      {
        cwd: PACKAGE_ROOT,
        env: { PATH: process.env.PATH ?? "", HOME: root },
        encoding: "utf8",
      },
    );
    expect(probe.status, probe.stderr).toBe(0);
    return probe.stdout;
  }

  it("resolves the same paths on darwin and on linux", () => {
    const root = home();
    const onLinux = resolvedOn("linux", root);
    expect(JSON.parse(onLinux)).toEqual(resolveStorage({ env: { HOME: root } }));
    expect(resolvedOn("darwin", root)).toBe(onLinux);
    expect(onLinux).not.toContain("Application Support");
  });
});

// --- the hub's own default ---------------------------------------------------

describe("the hub database", () => {
  it("is the user's", () => {
    const root = home();
    expect(defaultDatabasePath({ env: { HOME: root } })).toBe(
      join(root, ".local", "share", "uberblick", "hub.sqlite"),
    );
  });

  it(
    "does not move when the package does",
    () => {
      // The reason this module exists: a Homebrew or tarball upgrade replaces
      // program files, so a database resolved from the package's own location
      // is a database an upgrade deletes. Proving that means *relocating the
      // package* — a copy of the module under a directory that is not the
      // checkout — and asking the copy where the database is.
      const root = home();
      const relocated = join(root, "opt", "uberblick-1.2.3", "hub");
      mkdirSync(relocated, { recursive: true });
      for (const file of ["config.ts", "storage.ts", "log.ts"]) {
        copyFileSync(join(PACKAGE_ROOT, "src", file), join(relocated, file));
      }
      writeFileSync(
        join(relocated, "probe.ts"),
        'import { defaultDatabasePath } from "./config.js";\n' +
          "process.stdout.write(defaultDatabasePath());\n",
        "utf8",
      );

      const probe = spawnSync(
        process.execPath,
        ["--import", "tsx", join(relocated, "probe.ts")],
        {
          // tsx is resolved from the checkout; the *module under test* is the
          // one that moved, which is the axis this test is about.
          cwd: PACKAGE_ROOT,
          env: { PATH: process.env.PATH ?? "", HOME: root },
          encoding: "utf8",
        },
      );

      expect(probe.status, probe.stderr).toBe(0);
      expect(probe.stdout).toBe(
        join(root, ".local", "share", "uberblick", "hub.sqlite"),
      );
      expect(probe.stdout).not.toContain(relocated);
      expect(probe.stdout).not.toContain(PACKAGE_ROOT);
    },
    30_000,
  );
});

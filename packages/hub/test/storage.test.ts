/**
 * The storage layout: which root a machine's files are in, and who decides.
 *
 * Table-driven, because the whole contract is a table — platform and
 * environment in, four paths out — and because the case that matters most is
 * the one nobody runs day to day: a Mac. `process.platform` is a parameter of
 * {@link resolveStorage} exactly so this suite can resolve as Darwin on the
 * Linux box that runs it, without a mock anywhere near the production code.
 *
 * Every case resolves against a throwaway `HOME`. A test that read the
 * developer's real one would be a test of the developer's machine — and on a
 * Mac, of whether they happen to have `~/.config/uberblick`.
 */

import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import { defaultDatabasePath } from "../src/config.js";
import type { StorageLayout } from "../src/storage.js";
import {
  AmbiguousStorageError,
  MIGRATION_RECEIPT,
  macStorage,
  resolveStorage,
} from "../src/storage.js";

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

function seed(path: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, "", "utf8");
}

function macRoot(root: string): string {
  return join(root, "Library", "Application Support", "Uberblick");
}

function legacyConfig(root: string): string {
  return join(root, ".config", "uberblick");
}

function legacyData(root: string): string {
  return join(root, ".local", "share", "uberblick");
}

describe("the Mac layout", () => {
  it("puts config, credentials and both databases under Application Support", () => {
    const root = home();
    const storage = resolveStorage({ env: { HOME: root }, platform: "darwin" });
    const app = macRoot(root);

    expect(storage.layout).toBe("mac");
    expect(storage.configDir).toBe(app);
    expect(join(storage.configDir, "config.json")).toBe(join(app, "config.json"));
    expect(join(storage.configDir, "credentials.json")).toBe(
      join(app, "credentials.json"),
    );
    expect(storage.dataDir).toBe(join(app, "data"));
    expect(storage.hubDatabase).toBe(join(app, "data", "hub.sqlite"));
    expect(join(storage.workspaceDir, `${WORKSPACE}.sqlite`)).toBe(
      join(app, "data", "workspaces", `${WORKSPACE}.sqlite`),
    );
    expect(storage.warnings).toEqual([]);
  });

  it("creates nothing: resolution is paths, never directories", () => {
    const root = home();
    resolveStorage({ env: { HOME: root }, platform: "darwin" });
    expect(existsSync(join(root, "Library"))).toBe(false);
  });
});

// --- precedence --------------------------------------------------------------

interface Case {
  name: string;
  platform: NodeJS.Platform;
  /** `HOME` is added by the runner; this is everything else. */
  env?: NodeJS.ProcessEnv;
  /** Files to create under the throwaway home before resolving. */
  files?: (root: string) => string[];
  layout: StorageLayout;
  paths: (root: string) => {
    configDir: string;
    dataDir: string;
    hubDatabase: string;
    workspaceDir: string;
  };
  /** A fragment every warning line must contain, or none expected. */
  warns?: RegExp;
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

const CASES: Case[] = [
  {
    name: "Linux with no overrides keeps the XDG defaults",
    platform: "linux",
    layout: "xdg",
    paths: (root) =>
      xdgUnder(join(root, ".config"), join(root, ".local", "share")),
  },
  {
    name: "Linux honours an explicit XDG_CONFIG_HOME and XDG_DATA_HOME",
    platform: "linux",
    env: { XDG_CONFIG_HOME: "/srv/conf", XDG_DATA_HOME: "/srv/data" },
    layout: "xdg",
    paths: () => xdgUnder("/srv/conf", "/srv/data"),
  },
  {
    // The whole layout, not half of it: config in Application Support and
    // databases in /srv would be one installation split across two roots.
    name: "an explicit XDG_CONFIG_HOME takes a Mac off Application Support entirely",
    platform: "darwin",
    env: { XDG_CONFIG_HOME: "/srv/conf" },
    layout: "xdg",
    paths: (root) => xdgUnder("/srv/conf", join(root, ".local", "share")),
  },
  {
    name: "an explicit XDG_DATA_HOME does the same on a Mac",
    platform: "darwin",
    env: { XDG_DATA_HOME: "/srv/data" },
    layout: "xdg",
    paths: (root) => xdgUnder(join(root, ".config"), "/srv/data"),
  },
  {
    name: "an empty XDG variable is not an override",
    platform: "darwin",
    env: { XDG_CONFIG_HOME: "  " },
    layout: "mac",
    paths: (root) => ({
      configDir: macRoot(root),
      dataDir: join(macRoot(root), "data"),
      hubDatabase: join(macRoot(root), "data", "hub.sqlite"),
      workspaceDir: join(macRoot(root), "data", "workspaces"),
    }),
  },
  {
    // The XDG spec: a relative value must be ignored. Honouring one would put
    // this machine's files wherever the command was started from.
    name: "a relative XDG_CONFIG_HOME is ignored, so a Mac stays on the Mac layout",
    platform: "darwin",
    env: { XDG_CONFIG_HOME: "relative/conf" },
    layout: "mac",
    paths: (root) => ({
      configDir: macRoot(root),
      dataDir: join(macRoot(root), "data"),
      hubDatabase: join(macRoot(root), "data", "hub.sqlite"),
      workspaceDir: join(macRoot(root), "data", "workspaces"),
    }),
  },
  {
    name: "a relative XDG_DATA_HOME is ignored, leaving the XDG default",
    platform: "linux",
    env: { XDG_DATA_HOME: "./data" },
    layout: "xdg",
    paths: (root) =>
      xdgUnder(join(root, ".config"), join(root, ".local", "share")),
  },
  {
    name: "a legacy Mac with only config.json keeps the legacy layout",
    platform: "darwin",
    files: (root) => [join(legacyConfig(root), "config.json")],
    layout: "legacy-xdg",
    paths: (root) =>
      xdgUnder(join(root, ".config"), join(root, ".local", "share")),
    warns: /ub storage migrate/,
  },
  {
    name: "a legacy Mac with only credentials.json keeps the legacy layout",
    platform: "darwin",
    files: (root) => [join(legacyConfig(root), "credentials.json")],
    layout: "legacy-xdg",
    paths: (root) =>
      xdgUnder(join(root, ".config"), join(root, ".local", "share")),
    warns: /ub storage migrate/,
  },
  {
    name: "a legacy Mac with only a hub database keeps the legacy layout",
    platform: "darwin",
    files: (root) => [join(legacyData(root), "hub.sqlite")],
    layout: "legacy-xdg",
    paths: (root) =>
      xdgUnder(join(root, ".config"), join(root, ".local", "share")),
    warns: /ub storage migrate/,
  },
  {
    name: "a legacy Mac with only a workspace replica keeps the legacy layout",
    platform: "darwin",
    files: (root) => [join(legacyData(root), `${WORKSPACE}.sqlite`)],
    layout: "legacy-xdg",
    paths: (root) =>
      xdgUnder(join(root, ".config"), join(root, ".local", "share")),
    warns: /ub storage migrate/,
  },
  {
    name: "a legacy Mac with state in both old roots keeps the legacy layout",
    platform: "darwin",
    files: (root) => [
      join(legacyConfig(root), "config.json"),
      join(legacyConfig(root), "credentials.json"),
      join(legacyData(root), "hub.sqlite"),
      join(legacyData(root), `${WORKSPACE}.sqlite`),
    ],
    layout: "legacy-xdg",
    paths: (root) =>
      xdgUnder(join(root, ".config"), join(root, ".local", "share")),
    warns: /ub storage migrate/,
  },
  {
    // Directories with our names in them, holding nothing of ours: a note, a
    // backup, a database that is not a workspace replica. A fresh Mac.
    name: "files that are not ours do not make an old root count",
    platform: "darwin",
    files: (root) => [
      join(legacyConfig(root), "notes.txt"),
      join(legacyConfig(root), "config.json.bak"),
      join(legacyData(root), "scratch.sqlite"),
      join(legacyData(root), "not-a-uuid.sqlite"),
    ],
    layout: "mac",
    paths: (root) => ({
      configDir: macRoot(root),
      dataDir: join(macRoot(root), "data"),
      hubDatabase: join(macRoot(root), "data", "hub.sqlite"),
      workspaceDir: join(macRoot(root), "data", "workspaces"),
    }),
  },
  {
    // Explicit beats detected: someone who set the variables asked for these
    // paths, and does not need to be told about a layout they overrode.
    name: "an explicit XDG_CONFIG_HOME silences the legacy warning",
    platform: "darwin",
    env: { XDG_CONFIG_HOME: "/srv/conf", XDG_DATA_HOME: "/srv/data" },
    files: (root) => [join(legacyConfig(root), "config.json")],
    layout: "xdg",
    paths: () => xdgUnder("/srv/conf", "/srv/data"),
  },
];

describe("layout precedence", () => {
  for (const one of CASES) {
    it(one.name, () => {
      const root = home();
      for (const file of one.files?.(root) ?? []) {
        seed(file);
      }

      const storage = resolveStorage({
        env: { HOME: root, ...one.env },
        platform: one.platform,
      });

      expect(storage.layout).toBe(one.layout);
      const expected = one.paths(root);
      expect(storage.configDir).toBe(expected.configDir);
      expect(storage.dataDir).toBe(expected.dataDir);
      expect(storage.hubDatabase).toBe(expected.hubDatabase);
      expect(storage.workspaceDir).toBe(expected.workspaceDir);

      if (one.warns === undefined) {
        expect(storage.warnings).toEqual([]);
      } else {
        // One warning, however many old files there are: a machine is told
        // where it lives once, not once per file somebody left behind.
        expect(storage.warnings).toHaveLength(1);
        expect(storage.warnings[0]).toMatch(one.warns);
      }
    });
  }
});

// --- the refusal -------------------------------------------------------------

describe("state in both roots", () => {
  it("refuses to guess, and names both roots", () => {
    const root = home();
    seed(join(legacyConfig(root), "config.json"));
    seed(join(macRoot(root), "config.json"));

    let thrown: unknown;
    try {
      resolveStorage({ env: { HOME: root }, platform: "darwin" });
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(AmbiguousStorageError);
    const refusal = thrown as AmbiguousStorageError;
    expect(refusal.message).toContain(macRoot(root));
    expect(refusal.message).toContain(legacyConfig(root));
    expect(refusal.message).toContain(legacyData(root));
    expect(refusal.remedy).toMatch(/ub storage migrate/);
  });

  it("refuses on a legacy database beside a new-root config too", () => {
    const root = home();
    seed(join(legacyData(root), `${WORKSPACE}.sqlite`));
    seed(join(macRoot(root), "data", "hub.sqlite"));
    expect(() => resolveStorage({ env: { HOME: root }, platform: "darwin" })).toThrow(
      AmbiguousStorageError,
    );
  });

  // The one case where two populated roots is an answer rather than a
  // question: `ub storage migrate` copies rather than moves, so the originals
  // are still there on purpose, and the receipt it leaves says which root is
  // live. Without it, every command on a machine that had migrated
  // successfully would refuse to open anything.
  it("takes the Mac root when a completed migration left its receipt there", () => {
    const root = home();
    seed(join(legacyConfig(root), "config.json"));
    seed(join(legacyData(root), `${WORKSPACE}.sqlite`));
    seed(join(macRoot(root), "config.json"));
    seed(join(macRoot(root), MIGRATION_RECEIPT));

    const storage = resolveStorage({ env: { HOME: root }, platform: "darwin" });

    expect(storage.layout).toBe("mac");
    expect(storage.configDir).toBe(macRoot(root));
    expect(storage.workspaceDir).toBe(join(macRoot(root), "data", "workspaces"));
    // Said once, and it names the originals rather than offering to remove
    // them: nothing in uberblick deletes a pre-migration copy.
    expect(storage.warnings).toHaveLength(1);
    expect(storage.warnings[0]).toContain(legacyConfig(root));
    expect(storage.warnings[0]).toContain(legacyData(root));
    expect(storage.warnings[0]).toMatch(/no longer read/);
  });
});

// --- the destination a migration writes into ---------------------------------

describe("the Mac layout as a destination", () => {
  it("is available on a legacy machine, where resolution is still the old pair", () => {
    // `ub storage migrate` has to name the root it is about to create, which is
    // exactly the root resolution is correctly not returning yet.
    const root = home();
    seed(join(legacyConfig(root), "config.json"));
    const env = { HOME: root };

    expect(resolveStorage({ env, platform: "darwin" }).layout).toBe("legacy-xdg");
    expect(macStorage({ env }).configDir).toBe(macRoot(root));
    expect(macStorage({ env }).hubDatabase).toBe(
      join(macRoot(root), "data", "hub.sqlite"),
    );
    // And asking created nothing, like every other path in this module.
    expect(existsSync(join(root, "Library"))).toBe(false);
  });
});

// --- the hub's own default ---------------------------------------------------

describe("the hub database", () => {
  it("is the user's, on both layouts", () => {
    const root = home();
    expect(defaultDatabasePath({ env: { HOME: root }, platform: "linux" })).toBe(
      join(root, ".local", "share", "uberblick", "hub.sqlite"),
    );
    expect(defaultDatabasePath({ env: { HOME: root }, platform: "darwin" })).toBe(
      join(macRoot(root), "data", "hub.sqlite"),
    );
  });

  it(
    "does not move when the package does",
    () => {
      // The reason this issue exists: a Homebrew or tarball upgrade replaces
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
          // Pinned, because the assertion below is the XDG path: left to
          // `process.platform` this would resolve the Mac layout on a Mac and
          // fail there for a reason that has nothing to do with relocation.
          'process.stdout.write(defaultDatabasePath({ platform: "linux" }));\n',
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

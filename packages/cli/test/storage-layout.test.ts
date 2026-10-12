/**
 * The storage layout: where a machine's files are, and what may move them.
 *
 * There is one layout, so the contract is a small table — environment in, four
 * paths out — plus two properties: resolving creates nothing, and the hub
 * database does not move when the package does. (`resolveStorage` takes no
 * platform, so macOS and Linux get the same answer by construction.)
 *
 * Every case resolves against a throwaway `HOME`. A test that read the
 * developer's real one would be a test of the developer's machine.
 */

import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import { build } from "esbuild";
import { defaultHubDatabasePath } from "../src/hub-config.js";
import { resolveStorage } from "@uberblick/mcp-server/storage";

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
    // The XDG spec: a relative value must be ignored. Honouring one would put
    // this machine's files wherever the command was started from.
    name: "a relative XDG_CONFIG_HOME is ignored",
    env: { XDG_CONFIG_HOME: "relative/conf" },
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

// --- the hub's own default ---------------------------------------------------

describe("the hub database", () => {
  it("is the user's", () => {
    const root = home();
    expect(defaultHubDatabasePath({ env: { HOME: root } })).toBe(
      join(root, ".local", "share", "uberblick", "hub.sqlite"),
    );
  });

  it(
    "does not move when the package does",
    async () => {
      // The reason this module exists: a Homebrew or tarball upgrade replaces
      // program files, so a database resolved from the package's own location
      // is a database an upgrade deletes. Proving that means *relocating the
      // package* — a bundle under a directory that is not the checkout — and
      // asking the copy where the database is.
      const root = home();
      const relocated = join(root, "opt", "uberblick-1.2.3", "hub");
      mkdirSync(relocated, { recursive: true });
      await build({
        stdin: {
          contents: 'import { defaultHubDatabasePath } from "./hub-config.js";\n' +
            "process.stdout.write(defaultHubDatabasePath());\n",
          resolveDir: join(PACKAGE_ROOT, "src"),
          loader: "ts",
        },
        bundle: true,
        platform: "node",
        format: "esm",
        outfile: join(relocated, "probe.mjs"),
      });

      const probe = spawnSync(
        process.execPath,
        [join(relocated, "probe.mjs")],
        {
          // The released modules moved; the working directory stays independent.
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

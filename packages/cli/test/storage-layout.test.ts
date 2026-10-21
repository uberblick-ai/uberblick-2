/** Storage guarantees not covered by the command suites. */

import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import { build } from "esbuild";
import { resolveStorage } from "@uberblick/mcp-server/storage";

const PACKAGE_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));

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

it("ignores a relative XDG_CONFIG_HOME", () => {
  const root = home();
  const storage = resolveStorage({ env: { HOME: root, XDG_CONFIG_HOME: "relative/conf" } });
  expect(storage.configDir).toBe(join(root, ".config", "uberblick"));
});

describe("the hub database", () => {
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

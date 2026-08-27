/**
 * `scripts/mise-welcome.sh`, run for real.
 *
 * The script is a convenience, so the properties worth defending are the ones
 * that keep it from becoming a nuisance: it is silent wherever its output would
 * be captured rather than read, it costs nothing — no interpreter, no package
 * manager, no secret manager — and the commands it advertises exist.
 *
 * The interesting branch is the one that needs a terminal, so these tests give
 * it one: `script` allocates a pty the way `serve.test.ts` uses `mkfifo`, as a
 * POSIX utility the suite already assumes.
 */

import { type SpawnSyncReturns, spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { REPO_ROOT } from "./helpers.js";

const WELCOME = join(REPO_ROOT, "scripts", "mise-welcome.sh");

/** Exactly what a contributor sees, and the only copy of it outside the script. */
const EXPECTED = `uberblick

  first time   mise run setup -- --yes
  develop      mise run dev
  check        mise run lint
               mise run typecheck
               mise run test
  all commands mise tasks
`;

/**
 * `script`, resolved once and by absolute path, so a test may hand the script
 * an empty PATH and still have something to run it with.
 */
const SCRIPT_BIN = spawnSync("sh", ["-c", "command -v script"], {
  encoding: "utf8",
}).stdout.trim();

/**
 * Run the welcome script with stdout on a pty. The environment is built from
 * nothing rather than inherited: the Docker review image exports `CI=true`, and
 * inheriting it would turn every "prints the message" assertion into a test
 * that silently passes for the wrong reason.
 */
function onATerminal(env: NodeJS.ProcessEnv = {}): SpawnSyncReturns<string> {
  const args =
    process.platform === "darwin"
      ? ["-q", "/dev/null", "/bin/sh", WELCOME]
      : ["-qec", `/bin/sh '${WELCOME}'`, "/dev/null"];
  const ran = spawnSync(SCRIPT_BIN, args, { encoding: "utf8", env: { PATH: "", ...env } });
  // A pty puts the terminal's carriage returns in the capture; a reader never
  // sees them.
  return { ...ran, stdout: ran.stdout.replaceAll("\r\n", "\n") };
}

describe("the welcome script", () => {
  it("prints the quick-start on a terminal", () => {
    const ran = onATerminal();

    expect(ran.stdout).toBe(EXPECTED);
    expect(ran.status).toBe(0);
  });

  it("runs with node, pnpm and fnox absent from PATH", () => {
    // PATH is empty in `onATerminal`, so this is the whole point of the file
    // stated as an assertion: nothing the script needs is installed.
    for (const tool of ["node", "pnpm", "fnox"]) {
      const found = spawnSync("/bin/sh", ["-c", `command -v ${tool}`], {
        encoding: "utf8",
        env: { PATH: "" },
      });
      expect(found.status, `${tool} resolved under an empty PATH`).not.toBe(0);
    }

    expect(onATerminal().stdout).toBe(EXPECTED);
  });

  it("says nothing when stdout is not a terminal", () => {
    const ran = spawnSync("/bin/sh", [WELCOME], { encoding: "utf8", env: { PATH: "" } });

    expect(ran.stdout).toBe("");
    expect(ran.stderr).toBe("");
    expect(ran.status).toBe(0);
  });

  it.each(["CI=1", "CI=", "MISE_QUIET=1"])("says nothing under %s", (setting) => {
    const [name, value] = setting.split("=");
    const ran = onATerminal({ [name as string]: value as string });

    expect(ran.stdout).toBe("");
    expect(ran.stderr).toBe("");
    expect(ran.status).toBe(0);
  });

  it("advertises only tasks mise.toml defines", () => {
    const config = readFileSync(join(REPO_ROOT, "mise.toml"), "utf8");
    const advertised = [...EXPECTED.matchAll(/\bmise run ([a-z0-9-]+)/g)].map((m) => m[1]);

    expect(advertised.length).toBeGreaterThan(0);
    for (const task of advertised) {
      expect(config, `mise.toml defines no task named ${task}`).toContain(`[tasks.${task}]`);
    }
  });
});

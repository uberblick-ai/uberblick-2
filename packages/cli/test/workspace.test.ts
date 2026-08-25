/**
 * `ub workspace` — the workspace in force, the ones on this machine, and the
 * binding verb.
 *
 * Spawned, like the rest of the CLI suites: what is defended here is what a
 * process leaves behind — an exit code, a stream, and the bytes in
 * `./uberblick.json` — and none of that survives being called as a function.
 *
 * The one property worth more than the rest: `use` replaces a field, it does not
 * replace a file. Everything else its author put in `./uberblick.json` is still
 * there afterwards — and the derived `mise.local.toml`, which the mise tasks
 * actually read, follows the binding without losing the secret in it.
 */

import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import {
  DEAD_HUB_URL,
  removeTempDirs,
  runUb,
  runUbAsync,
  sandbox,
  type Sandbox,
} from "./helpers.js";

afterAll(removeTempDirs);

const WORKSPACE = "4d8e2f11-6a73-4c95-8b20-9e1f5c3a7d64";
const OTHER = "4d8e0000-1111-4222-8333-444455556666";
const UNRELATED = "b7c3d914-5a20-4e6f-8d13-9f04a2c68e75";

/** No `mise` on PATH, so no `mise trust` subprocess in the middle of a test. */
const WITHOUT_MISE = { PATH: "/usr/bin:/bin" };

function localConfigPath(box: Sandbox): string {
  return join(box.cwd, "mise.local.toml");
}

/**
 * A checkout as `ub init` leaves it: a derived `mise.local.toml` carrying a
 * generated signing secret, a workspace, and an endpoint to notice the loss of.
 *
 * Built by running the real `ub init` rather than by hand — what the regeneration
 * has to preserve is what that command actually wrote.
 */
function initialisedCheckout(workspace: string): Sandbox {
  const box = sandbox({ checkout: true, userConfig: { hubUrl: DEAD_HUB_URL } });
  const init = runUb(["init", "--yes", "--no-mcp", "--workspace", workspace], box, WITHOUT_MISE);
  expect(init.status, init.output).toBe(0);
  return box;
}

function localConfig(box: Sandbox): string {
  return readFileSync(localConfigPath(box), "utf8");
}

/** Everything in the derived file except the workspace `use` is there to change. */
function apartFromWorkspace(text: string): string {
  return text
    .split("\n")
    .filter((line) => !line.startsWith("WORKSPACE_ID = "))
    .join("\n");
}

/** A `<uuid>.sqlite` in the data directory: a workspace with a local replica. */
function withDatabase(box: { dataHome: string }, uuid: string): void {
  const dir = join(box.dataHome, "uberblick");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${uuid}.sqlite`), "", "utf8");
}

function directoryFile(box: { cwd: string }): Record<string, unknown> {
  return JSON.parse(readFileSync(join(box.cwd, "uberblick.json"), "utf8"));
}

describe("ub workspace", () => {
  it("names the value and the layer that chose it, for every layer", () => {
    // The same answer `ub status` gives, printed alone — so the two can never
    // disagree about which file is in charge.
    const fromUser = runUb(["workspace"], sandbox({ userConfig: { workspace: WORKSPACE } }));
    expect(fromUser.status).toBe(0);
    expect(fromUser.stdout).toMatch(new RegExp(`workspace\\s+${WORKSPACE} \\(user config\\)`));

    const fromDirectory = runUb(
      ["workspace"],
      sandbox({
        userConfig: { workspace: UNRELATED },
        directoryFile: { workspace: WORKSPACE },
      }),
    );
    expect(fromDirectory.status).toBe(0);
    expect(fromDirectory.stdout).toMatch(
      new RegExp(`workspace\\s+${WORKSPACE} \\(\\./uberblick\\.json\\)`),
    );

    const fromEnvironment = runUb(
      ["workspace"],
      sandbox({ userConfig: { workspace: UNRELATED } }),
      { WORKSPACE_ID: WORKSPACE },
    );
    expect(fromEnvironment.status).toBe(0);
    expect(fromEnvironment.stdout).toMatch(
      new RegExp(`workspace\\s+${WORKSPACE} \\(environment\\)`),
    );
  });

  it("agrees with `ub status` on the value and the origin", () => {
    const box = sandbox({
      userConfig: { workspace: UNRELATED },
      directoryFile: { workspace: `docs-${WORKSPACE}`, hubUrl: DEAD_HUB_URL },
    });
    const report = JSON.parse(runUb(["status", "--json"], box).stdout);
    const shown = runUb(["workspace"], box).stdout;

    expect(report.workspace).toBe(`docs-${WORKSPACE}`);
    expect(report.sources.workspace).toBe("directory file");
    expect(shown).toMatch(new RegExp(`workspace\\s+docs-${WORKSPACE} \\(\\./uberblick\\.json\\)`));
    // The uuid, because the spelling hides it — what you quote to somebody else.
    expect(shown).toMatch(new RegExp(`uuid\\s+${WORKSPACE}`));
  });
});

describe("ub workspace list", () => {
  it("unions the databases on disk with the configured workspace", () => {
    // A workspace whose only trace is its database is still a workspace you can
    // switch back to; a configured one with no database yet is still where you
    // are. Neither may be missing from the list.
    const box = sandbox({ userConfig: { workspace: WORKSPACE } });
    withDatabase(box, UNRELATED);

    const run = runUb(["workspace", "list"], box);
    expect(run.status).toBe(0);
    expect(run.stdout).toMatch(new RegExp(`\\*\\s+${WORKSPACE}`));
    expect(run.stdout).toMatch(new RegExp(`\\n\\s{2}${UNRELATED}`));

    const entries = JSON.parse(runUb(["workspace", "list", "--json"], box).stdout);
    expect(entries).toContainEqual({
      uuid: WORKSPACE,
      active: true,
      databasePath: join(box.dataHome, "uberblick", `${WORKSPACE}.sqlite`),
    });
    expect(entries).toContainEqual({
      uuid: UNRELATED,
      active: false,
      databasePath: join(box.dataHome, "uberblick", `${UNRELATED}.sqlite`),
    });
  });

  it("fails rather than reporting a short list when the data directory cannot be read", () => {
    // A swallowed error would read as "no workspaces here", and `use` resolves
    // prefixes against this — so it would go on to say "no match" about a
    // workspace that is sitting right there.
    const box = sandbox({ userConfig: { workspace: WORKSPACE } });
    mkdirSync(box.dataHome, { recursive: true });
    writeFileSync(join(box.dataHome, "uberblick"), "not a directory", "utf8");

    const run = runUb(["workspace", "list"], box);
    expect(run.status).not.toBe(0);
    expect(run.stderr).toMatch(join(box.dataHome, "uberblick"));
    expect(run.stdout).toBe("");
  });
});

describe("ub workspace use", () => {
  it("creates ./uberblick.json, and `ub status` then names it", () => {
    const box = sandbox();
    const run = runUb(["workspace", "use", WORKSPACE], box);
    expect(run.status).toBe(0);
    expect(directoryFile(box)).toEqual({ workspace: WORKSPACE });

    const report = JSON.parse(runUb(["status", "--json"], box).stdout);
    expect(report.workspace).toBe(WORKSPACE);
    expect(report.sources.workspace).toBe("directory file");
  });

  it("replaces the workspace field and leaves every other one alone", () => {
    const box = sandbox({
      directoryFile: { workspace: UNRELATED, hubUrl: DEAD_HUB_URL, future: { a: 1 } },
    });
    expect(runUb(["workspace", "use", WORKSPACE], box).status).toBe(0);
    expect(directoryFile(box)).toEqual({
      workspace: WORKSPACE,
      hubUrl: DEAD_HUB_URL,
      future: { a: 1 },
    });
  });

  it("stores a decorated id as typed, and shows both forms", () => {
    const box = sandbox();
    const decorated = `docs-${WORKSPACE}`;
    const run = runUb(["workspace", "use", decorated], box);
    expect(run.status).toBe(0);
    expect(directoryFile(box).workspace).toBe(decorated);

    const shown = runUb(["workspace"], box).stdout;
    expect(shown).toMatch(new RegExp(`workspace\\s+${decorated}`));
    expect(shown).toMatch(new RegExp(`uuid\\s+${WORKSPACE}`));
  });

  it("resolves a unique prefix, refuses an ambiguous one, and tells apart the two ways a value can be unusable", () => {
    const box = sandbox({ userConfig: { workspace: WORKSPACE } });
    // All three have a replica here, so the candidate set does not change under
    // the command's own writes — a prefix means the same thing on every run.
    withDatabase(box, WORKSPACE);
    withDatabase(box, OTHER);
    withDatabase(box, UNRELATED);

    // Unique: `b7c` names exactly one of the three.
    expect(runUb(["workspace", "use", "b7c"], box).status).toBe(0);
    expect(directoryFile(box).workspace).toBe(UNRELATED);

    // Ambiguous: both `4d8e…` uuids start with it, and the refusal names them.
    const ambiguous = runUb(["workspace", "use", "4d8e"], box);
    expect(ambiguous.status).toBe(2);
    expect(ambiguous.stderr).toMatch(WORKSPACE);
    expect(ambiguous.stderr).toMatch(OTHER);

    // A prefix of nothing here — the fix is to look at the list, or paste the
    // whole uuid, which is accepted even when this machine has never seen it.
    const noMatch = runUb(["workspace", "use", "ffff"], box);
    expect(noMatch.status).toBe(2);
    expect(noMatch.stderr).toMatch(/no workspace on this machine starts with/);

    // Not a uuid at all — a different mistake, and a different message.
    const notAUuid = runUb(["workspace", "use", "my-notes"], box);
    expect(notAUuid.status).toBe(2);
    expect(notAUuid.stderr).toMatch(/is not a workspace id/);

    // The refusals changed nothing.
    expect(directoryFile(box).workspace).toBe(UNRELATED);
  });

  it("takes a full uuid this machine has never heard of", () => {
    // Being handed a uuid is how you join a workspace; the replica hydrates on
    // next use. Refusing it would make `list` a gate on somebody else's corpus.
    const box = sandbox();
    expect(runUb(["workspace", "use", UNRELATED], box).status).toBe(0);
    expect(directoryFile(box).workspace).toBe(UNRELATED);
  });

  it("--user writes the user config and leaves ./uberblick.json absent", () => {
    const box = sandbox({ userConfig: { workspace: UNRELATED, displayName: "Ben" } });
    const run = runUb(["workspace", "use", "--user", WORKSPACE], box);
    expect(run.status).toBe(0);
    expect(existsSync(join(box.cwd, "uberblick.json"))).toBe(false);

    const config = JSON.parse(
      readFileSync(join(box.configHome, "uberblick", "config.json"), "utf8"),
    );
    expect(config).toEqual({ workspace: WORKSPACE, displayName: "Ben" });
  });

  it("--user refuses a user config that does not parse, rather than replacing it", () => {
    // The write republishes the whole file. Treating an unreadable one as empty
    // would drop the identity and endpoint in it, and the mistake would be
    // invisible: the command would report success.
    const broken = '{ "displayName": "Ben",\n';
    const box = sandbox({ raw: { userConfig: broken } });
    const path = join(box.configHome, "uberblick", "config.json");

    const run = runUb(["workspace", "use", "--user", WORKSPACE], box);
    expect(run.status).not.toBe(0);
    expect(readFileSync(path, "utf8")).toBe(broken);
  });
});

describe("ub workspace use and the derived mise config", () => {
  it("moves the derived WORKSPACE_ID, keeps every other derived value, and names both files", () => {
    // The mise tasks read this file and nothing else, so a binding that stops at
    // `./uberblick.json` leaves `mise run web` and `mise run import-seed` serving
    // the workspace this directory used to be bound to — silently.
    const box = initialisedCheckout(OTHER);
    const before = localConfig(box);
    expect(before).toContain(`WORKSPACE_ID = "${OTHER}"`);

    const run = runUb(["workspace", "use", WORKSPACE], box, WITHOUT_MISE);
    expect(run.status, run.output).toBe(0);

    const after = localConfig(box);
    expect(after).toContain(`WORKSPACE_ID = "${WORKSPACE}"`);
    // Byte for byte apart from that one line: the signing secret above all, but
    // the endpoint and the header the file is recognised by too. Rewriting a
    // file that holds the secret is only acceptable if it cannot lose it.
    expect(apartFromWorkspace(after)).toBe(apartFromWorkspace(before));
    expect(after).toContain(`HUB_URL = "${DEAD_HUB_URL}"`);

    // Both files, because both were written — a report naming one of them is
    // how somebody ends up debugging a task that serves the old workspace.
    expect(run.stdout).toContain(join(box.cwd, "uberblick.json"));
    expect(run.stdout).toContain(localConfigPath(box));
  });

  it("follows resolution rather than the file it wrote: --user under a directory file that outranks it", () => {
    // `--user` binds the machine, and `./uberblick.json` still wins for this
    // checkout. The derived file mirrors what `ub` resolves, so it keeps naming
    // the directory file's workspace — and the precedence warning still fires.
    const box = initialisedCheckout(OTHER);
    writeFileSync(
      join(box.cwd, "uberblick.json"),
      `${JSON.stringify({ workspace: UNRELATED }, null, 2)}\n`,
      "utf8",
    );

    const run = runUb(["workspace", "use", "--user", WORKSPACE], box, WITHOUT_MISE);
    expect(run.status, run.output).toBe(0);
    expect(localConfig(box)).toContain(`WORKSPACE_ID = "${UNRELATED}"`);
    expect(run.stderr).toMatch(/takes precedence over/);
  });

  it("moves the derived file even when the environment outranks the binding", () => {
    // The mise-activated shell: mise exports WORKSPACE_ID *from this very file*,
    // so counting it would make the file its own highest-precedence input — a
    // fixed point at the old workspace, and a switch that can never take. The
    // warning is still owed, because this shell is the one that stays wrong.
    const box = initialisedCheckout(OTHER);
    const run = runUb(["workspace", "use", WORKSPACE], box, {
      ...WITHOUT_MISE,
      WORKSPACE_ID: OTHER,
    });

    expect(run.status, run.output).toBe(0);
    expect(run.stderr).toMatch(/environment sets .*takes precedence over/);
    expect(localConfig(box)).toContain(`WORKSPACE_ID = "${WORKSPACE}"`);
  });

  it("writes no mise config outside a checkout, and creates none in a checkout without one", () => {
    // Creating it is `ub init`'s job: the file carries the signing secret, and a
    // fresh one is untrusted — which takes down every mise task in the directory.
    const outside = sandbox();
    expect(runUb(["workspace", "use", WORKSPACE], outside, WITHOUT_MISE).status).toBe(0);
    expect(existsSync(localConfigPath(outside))).toBe(false);

    const uninitialised = sandbox({ checkout: true });
    const run = runUb(["workspace", "use", WORKSPACE], uninitialised, WITHOUT_MISE);
    expect(run.status, run.output).toBe(0);
    expect(directoryFile(uninitialised).workspace).toBe(WORKSPACE);
    expect(existsSync(localConfigPath(uninitialised))).toBe(false);
    expect(run.stdout).not.toContain("mise config");
  });

  it("holds the init lock across both writes, so neither happens without the other", async () => {
    // The deterministic half of the concurrency contract, held by hand so the
    // timing is a fact rather than a hope: with the lock taken, `use` has not
    // written the binding either — the pair is what the lock covers.
    const box = initialisedCheckout(OTHER);
    const lock = join(box.configHome, "uberblick", ".init.lock");
    mkdirSync(dirname(lock), { recursive: true });
    writeFileSync(lock, "999999\n");

    const running = runUbAsync(["workspace", "use", WORKSPACE], box, WITHOUT_MISE);
    await new Promise((resolve) => setTimeout(resolve, 400));
    expect(existsSync(join(box.cwd, "uberblick.json"))).toBe(false);
    expect(localConfig(box)).toContain(`WORKSPACE_ID = "${OTHER}"`);

    rmSync(lock);
    const run = await running;
    expect(run.status, run.output).toBe(0);
    expect(directoryFile(box).workspace).toBe(WORKSPACE);
    expect(localConfig(box)).toContain(`WORKSPACE_ID = "${WORKSPACE}"`);
    // And the lock it took in turn is not left behind.
    expect(existsSync(lock)).toBe(false);
  });

  it("leaves the binding and the derived file agreeing under concurrent runs", async () => {
    // Two switches at the same moment. Without the lock the writes interleave
    // into a derived file naming one run's workspace over the other's binding —
    // the state where `ub status` and every mise task disagree.
    const orders: Array<[string, string]> = [
      [WORKSPACE, UNRELATED],
      [UNRELATED, WORKSPACE],
    ];
    for (const [first, second] of orders) {
      const box = initialisedCheckout(OTHER);
      const runs = await Promise.all([
        runUbAsync(["workspace", "use", first], box, WITHOUT_MISE),
        runUbAsync(["workspace", "use", second], box, WITHOUT_MISE),
      ]);
      for (const run of runs) {
        expect(run.status, run.output).toBe(0);
      }
      expect(localConfig(box)).toContain(
        `WORKSPACE_ID = "${directoryFile(box).workspace}"`,
      );
    }
  });
});

describe("ub workspace help", () => {
  it("documents the three forms, in both helps", () => {
    const top = runUb(["--help"], sandbox());
    expect(top.stdout).toMatch(/workspace list/);
    expect(top.stdout).toMatch(/workspace use <id>/);

    const help = runUb(["workspace", "--help"], sandbox());
    expect(help.status).toBe(0);
    expect(help.stdout).toMatch(/list \[--json\]/);
    expect(help.stdout).toMatch(/use <id> \[--user\]/);
    expect(help.stdout).toMatch(/<slug>-<uuid>/);
    expect(help.stdout).toMatch(/prefix/);
  });
});

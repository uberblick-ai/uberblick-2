/**
 * `ub workspace` — the workspace in force, the ones on this machine, and the
 * binding verb.
 *
 * Spawned, like the rest of the CLI suites: what is defended here is what a
 * process leaves behind — an exit code, a stream, and the bytes in
 * `config.json` — and none of that survives being called as a function.
 *
 * The one property worth more than the rest: `use` replaces a field, it does not
 * replace a file. The identity and endpoint its author put in `config.json` are
 * still there afterwards.
 */

import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
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

/**
 * A machine as `ub init` leaves it: a signing secret, a workspace, and an
 * endpoint. Built by running the real `ub init` rather than by hand.
 *
 * The credential is part of the fixture rather than something `ub init`
 * generates here: a machine with an endpoint in force is bound to a hub that has
 * its own secret, and `ub init` refuses to invent one for it (#436).
 */
function initialisedMachine(workspace: string): Sandbox {
  const box = sandbox({
    userConfig: { hubUrl: DEAD_HUB_URL },
    credentials: { signingSecret: "test-signing-secret-for-the-workspace-suite" },
  });
  const init = runUb(["init", "--yes", "--no-mcp", "--workspace", workspace], box);
  expect(init.status, init.output).toBe(0);
  return box;
}

/** A `<uuid>.sqlite` in the data directory: a workspace with a local replica. */
function withDatabase(box: { dataHome: string }, uuid: string): void {
  const dir = join(box.dataHome, "uberblick");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${uuid}.sqlite`), "", "utf8");
}

function userConfig(box: { configHome: string }): Record<string, unknown> {
  return JSON.parse(
    readFileSync(join(box.configHome, "uberblick", "config.json"), "utf8"),
  );
}

describe("ub workspace", () => {
  it("names the value and the layer that chose it, for every layer", () => {
    // The same answer `ub status` gives, printed alone — so the two can never
    // disagree about which file is in charge.
    const fromUser = runUb(["workspace"], sandbox({ userConfig: { workspace: WORKSPACE } }));
    expect(fromUser.status).toBe(0);
    expect(fromUser.stdout).toMatch(new RegExp(`workspace\\s+${WORKSPACE} \\(user config\\)`));

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
      userConfig: { workspace: `docs-${WORKSPACE}`, hubUrl: DEAD_HUB_URL },
    });
    const report = JSON.parse(runUb(["status", "--json"], box).stdout);
    const shown = runUb(["workspace"], box).stdout;

    expect(report.workspace).toBe(`docs-${WORKSPACE}`);
    expect(report.sources.workspace).toBe("user config");
    expect(shown).toMatch(new RegExp(`workspace\\s+docs-${WORKSPACE} \\(user config\\)`));
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
  it("writes the user config with no --user, and `ub status` then names it", () => {
    // There is one place a workspace preference lives. A repository that wants
    // its own binds itself by pinning WORKSPACE_ID in its project MCP entry,
    // which arrives as the environment and outranks this.
    const box = sandbox();
    const run = runUb(["workspace", "use", WORKSPACE], box);
    expect(run.status, run.output).toBe(0);
    expect(userConfig(box)).toEqual({ workspace: WORKSPACE });

    const report = JSON.parse(runUb(["status", "--json"], box).stdout);
    expect(report.workspace).toBe(WORKSPACE);
    expect(report.sources.workspace).toBe("user config");
  });

  it("replaces the workspace field and leaves every other one alone", () => {
    const box = sandbox({
      userConfig: {
        workspace: UNRELATED,
        hubUrl: DEAD_HUB_URL,
        displayName: "Ben",
      },
    });
    expect(runUb(["workspace", "use", WORKSPACE], box).status).toBe(0);
    expect(userConfig(box)).toEqual({
      workspace: WORKSPACE,
      hubUrl: DEAD_HUB_URL,
      displayName: "Ben",
    });
  });

  it("stores a decorated id as typed, and shows both forms", () => {
    const box = sandbox();
    const decorated = `docs-${WORKSPACE}`;
    const run = runUb(["workspace", "use", decorated], box);
    expect(run.status).toBe(0);
    expect(userConfig(box).workspace).toBe(decorated);

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
    expect(userConfig(box).workspace).toBe(UNRELATED);

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
    expect(userConfig(box).workspace).toBe(UNRELATED);
  });

  it("takes a full uuid this machine has never heard of", () => {
    // Being handed a uuid is how you join a workspace; the replica hydrates on
    // next use. Refusing it would make `list` a gate on somebody else's corpus.
    const box = sandbox();
    expect(runUb(["workspace", "use", UNRELATED], box).status).toBe(0);
    expect(userConfig(box).workspace).toBe(UNRELATED);
  });

  it("refuses a user config that does not parse, rather than replacing it", () => {
    // The write republishes the whole file. Treating an unreadable one as empty
    // would drop the identity and endpoint in it, and the mistake would be
    // invisible: the command would report success.
    const broken = '{ "displayName": "Ben",\n';
    const box = sandbox({ raw: { userConfig: broken } });
    const path = join(box.configHome, "uberblick", "config.json");

    const run = runUb(["workspace", "use", WORKSPACE], box);
    expect(run.status).not.toBe(0);
    expect(readFileSync(path, "utf8")).toBe(broken);
  });
});

describe("ub workspace use and the init lock", () => {
  it("waits for the lock before writing the binding", async () => {
    // `config.json` is read, merged and republished, and `ub init` does the
    // same to the same file — so the two are serialised. Held by hand here, so
    // the timing is a fact rather than a hope.
    const box = initialisedMachine(OTHER);
    const lock = join(box.configHome, "uberblick", ".init.lock");
    mkdirSync(dirname(lock), { recursive: true });
    writeFileSync(lock, "999999\n");

    const running = runUbAsync(["workspace", "use", WORKSPACE], box);
    await new Promise((resolve) => setTimeout(resolve, 400));
    expect(userConfig(box).workspace).toBe(OTHER);

    rmSync(lock);
    const run = await running;
    expect(run.status, run.output).toBe(0);
    expect(userConfig(box).workspace).toBe(WORKSPACE);
    // And the lock it took in turn is not left behind.
    expect(existsSync(lock)).toBe(false);
  });

  it("leaves one binding under concurrent runs", async () => {
    // Two switches at the same moment: whichever wins, `config.json` is a file
    // one of them wrote whole — never a merge of both.
    for (const [first, second] of [
      [WORKSPACE, UNRELATED],
      [UNRELATED, WORKSPACE],
    ]) {
      const box = initialisedMachine(OTHER);
      const runs = await Promise.all([
        runUbAsync(["workspace", "use", first as string], box),
        runUbAsync(["workspace", "use", second as string], box),
      ]);
      for (const run of runs) {
        expect(run.status, run.output).toBe(0);
      }
      expect([first, second]).toContain(userConfig(box).workspace);
      // The identity `ub init` wrote is still there: `use` replaces a field.
      expect(userConfig(box).hubUrl).toBe(DEAD_HUB_URL);
    }
  });
});

describe("ub workspace help", () => {
  it("keeps the group concise and documents id forms at the accepting command", () => {
    const top = runUb(["--help"], sandbox());
    expect(top.stdout).toMatch(/^  workspace \[command\]/m);
    expect(top.stdout).not.toMatch(/^  workspace (?:list|use)/m);

    const group = runUb(["workspace", "--help"], sandbox());
    expect(group.status).toBe(0);
    expect(group.stdout).toMatch(/list \[--json\]/);
    expect(group.stdout).toMatch(/use <id>/);
    expect(group.stdout).not.toMatch(/<slug>-<uuid>|prefix/);

    const command = runUb(["workspace", "use", "--help"], sandbox());
    expect(command.status).toBe(0);
    expect(command.stdout).toMatch(/<slug>-<uuid>/);
    expect(command.stdout).toMatch(/prefix/);
  });
});

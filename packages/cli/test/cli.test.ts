/**
 * What the `ub` process does: exit codes, which stream output lands on, and the
 * one thing it must never print.
 *
 * These spawn the real binary. A CLI's contract is its process behaviour, and a
 * function call would not catch a diagnostic written to the wrong stream — which
 * in the `ub mcp serve` path is a corrupted protocol session.
 */

import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { DEAD_HUB_URL, removeTempDirs, runUb, sandbox } from "./helpers.js";

afterAll(removeTempDirs);

/** The workspace these sandboxes are configured for. Ids are uuids. */
const WORKSPACE = "4d8e2f11-6a73-4c95-8b20-9e1f5c3a7d64";

describe("ub", () => {
  it("prints the subcommands with no arguments, and exits 0", () => {
    const run = runUb([], sandbox());
    expect(run.status).toBe(0);
    expect(run.stdout).toMatch(/status/);
    expect(run.stderr).toBe("");
    // `mcp serve` is machine-wired by `ub mcp install`, so it stays out of help.
    expect(run.stdout).not.toMatch(/mcp serve/);
  });

  it("prints the same list to stderr for an unknown subcommand, and fails", () => {
    const run = runUb(["bogus"], sandbox());
    expect(run.status).not.toBe(0);
    expect(run.stdout).toBe("");
    expect(run.stderr).toMatch(/unknown command "bogus"/);
    expect(run.stderr).toMatch(/status/);
  });

  it("reports its version", () => {
    const run = runUb(["--version"], sandbox());
    expect(run.status).toBe(0);
    expect(run.stdout.trim()).toMatch(/^\d+\.\d+\.\d+/);
  });
});

describe("ub status", () => {
  it("reports the defaults for everything a workspace does not decide", () => {
    // Absent configuration is a default for the endpoint and the credential:
    // nothing here requires `ub init` to have set those.
    const run = runUb(["status"], sandbox({ userConfig: { workspace: WORKSPACE } }));
    expect(run.status).toBe(0);
    expect(run.stdout).toMatch(WORKSPACE);
    expect(run.stdout).toMatch(/ws:\/\/localhost:1234/);
  });

  it("fails with no workspace anywhere, and names `ub init`", () => {
    // The one value with no default. A guessed workspace would open a corpus
    // nobody chose, so the answer is the command that creates one.
    const run = runUb(["status"], sandbox());
    expect(run.status).not.toBe(0);
    expect(run.stdout).toBe("");
    expect(run.stderr).toMatch(/WORKSPACE_ID/);
    expect(run.stderr).toMatch(/ub init/);
  });

  it("shows a decorated workspace as typed, and the uuid it resolves to", () => {
    // The slug is display; the uuid is what rooms, the token claim and the
    // database are keyed by — and what you quote to somebody else.
    const decorated = `uberblick-${WORKSPACE}`;
    const box = sandbox({ userConfig: { workspace: decorated, hubUrl: DEAD_HUB_URL } });

    const human = runUb(["status"], box);
    expect(human.status).toBe(0);
    expect(human.stdout).toMatch(new RegExp(`workspace\\s+${decorated}`));
    expect(human.stdout).toMatch(new RegExp(`uuid\\s+${WORKSPACE}`));

    const report = JSON.parse(runUb(["status", "--json"], box).stdout);
    expect(report.workspace).toBe(decorated);
    expect(report.workspaceUuid).toBe(WORKSPACE);
    // Both spellings key one database, or the corpus would have two replicas.
    expect(report.databasePath).toBe(
      join(box.dataHome, "uberblick", `${WORKSPACE}.sqlite`),
    );
    expect(report.rooms[0].room).toBe(`${WORKSPACE}/_directory`);
  });

  it("emits one parseable object with --json, and nothing else on stdout", () => {
    const box = sandbox({
      userConfig: { workspace: WORKSPACE, hubUrl: DEAD_HUB_URL },
    });
    const run = runUb(["status", "--json"], box);
    expect(run.status).toBe(0);

    const report = JSON.parse(run.stdout);
    expect(report.workspace).toBe(WORKSPACE);
    expect(report.workspaceUuid).toBe(WORKSPACE);
    expect(report.hubUrl).toBe(DEAD_HUB_URL);
    expect(report.sources).toEqual({
      workspace: "user config",
      hubUrl: "user config",
    });
    expect(report.databasePath).toBe(
      join(box.dataHome, "uberblick", `${WORKSPACE}.sqlite`),
    );
    expect(report.credentialPresent).toBe(false);
    expect(report.credentialSource).toBeNull();
    expect(report.hub.status).toBe("disabled");
    expect(report.version).toMatch(/^\d+\.\d+\.\d+/);
    // Sync state per attached room. The directory doc exists from boot.
    expect(Array.isArray(report.rooms)).toBe(true);
    expect(report.rooms[0].room).toBe(`${WORKSPACE}/_directory`);
    expect(report.rooms[0]).toHaveProperty("synced");
    // The rooms behind `unsyncedChanges`, not just the count: durable local work
    // the hub has not acknowledged is the one thing this report must not hide.
    expect(Array.isArray(report.pendingRooms)).toBe(true);
    expect(report.pendingRooms.length).toBe(report.unsyncedChanges);
  });

  it("lists every configuration layer, marking the one in force", () => {
    // The environment outranks the files by design, so the report has to say
    // what it outranked and not only what it chose (#454). Both values here
    // disagree, which is also the case where two secrets must stay unprintable.
    const shadowed = "1f0c6d3b-5e42-4a17-9d88-6b2e04c7a591";
    const envSecret = "cli-test-env-secret-4b81aa";
    const fileSecret = "cli-test-file-secret-c07d13";
    const box = sandbox({
      userConfig: { workspace: shadowed, hubUrl: DEAD_HUB_URL },
      credentials: { signingSecret: fileSecret },
    });
    const pinned = { WORKSPACE_ID: WORKSPACE, HUB_AUTH_TOKEN: envSecret };

    const json = runUb(["status", "--json"], box, pinned);
    expect(json.status).toBe(0);
    const report = JSON.parse(json.stdout);
    // The winner is still reported the way it always was.
    expect(report.sources.workspace).toBe("environment");
    expect(report.credentialSource).toBe("environment");
    expect(report.layers).toEqual({
      workspace: [
        {
          source: "environment",
          state: "present",
          value: WORKSPACE,
          winner: true,
        },
        {
          source: "user config",
          state: "present",
          value: shadowed,
          winner: false,
        },
      ],
      credential: [
        { source: "environment", state: "present", winner: true },
        { source: "credentials file", state: "present", winner: false },
      ],
    });
    // Both disagreements reach stderr through the warnings every surface
    // already prints, leaving stdout one parseable object.
    expect(json.stderr).toMatch(/different workspaces are configured/);
    expect(json.stderr).toContain(shadowed);
    expect(json.stderr).toMatch(/HUB_AUTH_TOKEN .* differ/);

    const human = runUb(["status"], box, pinned);
    expect(human.status).toBe(0);
    expect(human.stdout).toMatch(
      new RegExp(`environment\\s+${WORKSPACE}\\s+\\(in force\\)`),
    );
    expect(human.stdout).toMatch(new RegExp(`user config\\s+${shadowed}`));
    expect(human.stdout).toMatch(/credentials file\s+configured/);

    // Neither secret is on either stream of either run, in any form.
    for (const run of [json, human]) {
      for (const secret of [envSecret, fileSecret]) {
        expect(run.output).not.toContain(secret);
      }
    }
  });

  it("reports a configured credential without printing it", () => {
    const secret = "cli-test-signing-secret-3f9a1c";
    const box = sandbox({
      credentials: { signingSecret: secret },
      // A dead hub, so this test never touches a hub the developer is running.
      userConfig: { workspace: WORKSPACE, hubUrl: DEAD_HUB_URL },
    });

    const human = runUb(["status"], box);
    expect(human.status).toBe(0);
    expect(human.stdout).toMatch(/credential\s+configured \(credentials file\)/);

    const json = runUb(["status", "--json"], box);
    const report = JSON.parse(json.stdout);
    expect(report.credentialPresent).toBe(true);
    expect(report.credentialSource).toBe("credentials file");
    // The hub URL is reported even when the connection fails; that is the point.
    expect(report.hubUrl).toBe(DEAD_HUB_URL);

    // A failing invocation, with the same credential configured.
    const failing = runUb(["bogus"], box);
    expect(failing.status).not.toBe(0);

    // The secret appears on neither stream of any of them.
    for (const run of [human, json, failing]) {
      expect(run.output).not.toContain(secret);
    }
  });

  it("refuses an exposed credentials file, and says so on stderr", () => {
    const secret = "cli-test-signing-secret-9d2e07";
    const box = sandbox({
      credentials: { signingSecret: secret },
      userConfig: { workspace: WORKSPACE, hubUrl: DEAD_HUB_URL },
      // A file every user on the machine can read: the secret must go unused.
      credentialsMode: 0o644,
    });

    const run = runUb(["status", "--json"], box);
    expect(run.status).toBe(0);
    const report = JSON.parse(run.stdout);
    // Local-only, exactly as if no credential had been configured at all.
    expect(report.credentialPresent).toBe(false);
    expect(report.credentialSource).toBeNull();
    expect(report.hub.status).toBe("disabled");
    // The refusal and its fix are on stderr, and the secret is on neither stream.
    expect(run.stderr).toMatch(/refusing/);
    expect(run.stderr).toMatch(/chmod 600/);
    expect(run.output).not.toContain(secret);
  });

  it("never quotes a malformed configuration file back", () => {
    // A bare secret pasted into credentials.json: the parser's message would be
    // the secret itself, so it is not printed.
    const secret = "cli-test-signing-secret-2e6f41";
    const box = sandbox({
      raw: { credentials: `${secret}\n` },
      userConfig: { workspace: WORKSPACE, hubUrl: DEAD_HUB_URL },
    });

    const run = runUb(["status", "--json"], box);
    expect(run.status).toBe(0);
    expect(JSON.parse(run.stdout).credentialPresent).toBe(false);
    expect(run.stderr).toMatch(/credentials\.json: invalid JSON/);
    expect(run.output).not.toContain(secret);

    // And the same for `config.json`, where a pasted secret is the very mistake
    // `ub` warns about — a file that does not parse never gets that far, so the
    // parser message must not carry it out either.
    const misplaced = "cli-test-misplaced-secret-a70c93";
    const broken = sandbox({ raw: { userConfig: `${misplaced}\n` } });
    const second = runUb(["status", "--json"], broken, {
      WORKSPACE_ID: WORKSPACE,
      HUB_URL: DEAD_HUB_URL,
    });
    expect(second.status).toBe(0);
    expect(second.stderr).toMatch(/config\.json: invalid JSON/);
    expect(second.output).not.toContain(misplaced);
  });

  it("fails with the offending file named when a workspace is not an id", () => {
    const secret = "cli-test-signing-secret-71b4de";
    const box = sandbox({
      credentials: { signingSecret: secret },
      userConfig: { workspace: "../escape" },
    });

    const run = runUb(["status"], box);
    expect(run.status).not.toBe(0);
    expect(run.stderr).toMatch(/config\.json/);
    expect(run.output).not.toContain(secret);
  });
});

describe("ub mcp", () => {
  it("rejects anything but `install` and `serve`", () => {
    const run = runUb(["mcp", "bogus"], sandbox());
    expect(run.status).not.toBe(0);
    expect(run.stdout).toBe("");
    expect(run.stderr).toMatch(/install/);
    expect(run.stderr).toMatch(/serve/);
  });
});

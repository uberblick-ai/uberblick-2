/**
 * What the `ub` process does: exit codes, which stream output lands on, and the
 * one thing it must never print.
 *
 * These spawn the real binary. A CLI's contract is its process behaviour, and a
 * function call would not catch a diagnostic written to the wrong stream — which
 * in the `ub mcp serve` path is a corrupted protocol session.
 */

import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { DEAD_HUB_URL, removeTempDirs, runUb, sandbox, unboundSandbox } from "./helpers.js";

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
  it("reports an explicitly local-only workspace", () => {
    const run = runUb(["status"], sandbox({ projectBinding: { workspaceId: WORKSPACE, hubUrl: null } }));
    expect(run.status).toBe(0);
    expect(run.stdout).toMatch(WORKSPACE);
    expect(run.stdout).toBe(
      `workspace   ${WORKSPACE}\n` +
      "hub         local, this computer only\n" +
      "account     none needed for a local workspace\n" +
      "problems    none\n",
    );
  });

  it.each([false, true])("gives the no-binding hint on stderr with JSON=%s", (json) => {
    // The one value with no default. A guessed workspace would open a corpus
    // nobody chose, so the answer is the command that creates one.
    const run = runUb(json ? ["status", "--json"] : ["status"], unboundSandbox());
    expect(run.status).toBe(1);
    expect(run.stdout).toBe("");
    expect(run.stderr).toBe(
      "no .uberblick.json here or in any parent directory\n" +
      "  → ub workspace create <name>, or ub workspace use <link|id>\n",
    );
  });

  it("exits 1 with its error instead of an overview when the status read fails", () => {
    const box = sandbox({ projectBinding: { workspaceId: WORKSPACE, hubUrl: null } });
    const database = join(box.cwd, "broken.sqlite");
    writeFileSync(database, "this is not a SQLite database");

    const run = runUb(["status"], box, { UBERBLICK_DB: database });
    expect(run.status).toBe(1);
    expect(run.stdout).toBe("");
    expect(run.stderr).toMatch(/database/);
  });

  it("reports the canonical workspace id and uses the same replica for decorated ids", () => {
    // The slug is display; the uuid is what rooms, the token claim and the
    // database are keyed by — and what you quote to somebody else.
    const decorated = `uberblick-${WORKSPACE}`;
    const box = sandbox({ projectBinding: { workspaceId: decorated, hubUrl: DEAD_HUB_URL } });

    const human = runUb(["status"], box);
    expect(human.status).toBe(0);
    expect(human.stdout).toContain(`workspace   ${WORKSPACE}\n`);
    expect(human.stdout).not.toMatch(/^uuid\s/m);

    const report = JSON.parse(runUb(["status", "--json"], box).stdout);
    expect(report.workspace).toEqual({ id: WORKSPACE, name: null });
    // Both spellings key one database, or the corpus would have two replicas.
    expect(existsSync(join(box.dataHome, "uberblick", `${WORKSPACE}.sqlite`))).toBe(true);
  });

  it("emits one parseable object with --json, and nothing else on stdout", () => {
    const box = sandbox({
      projectBinding: { workspaceId: WORKSPACE, hubUrl: DEAD_HUB_URL },
    });
    const run = runUb(["status", "--json"], box);
    expect(run.status).toBe(0);

    const report = JSON.parse(run.stdout);
    expect(Object.keys(report)).toEqual([
      "workspace", "hub", "account", "connection", "pending", "lastSync", "problems",
    ]);
    expect(report.workspace).toEqual({ id: WORKSPACE, name: null });
    expect(report.hub).toBe("http://127.0.0.1:1");
    expect(report.account).toBeNull();
    expect(report.connection).toEqual({ state: "failed", cause: null, detail: null });
    expect(report.pending).toEqual({ count: expect.any(Number) });
    expect(report.lastSync).toBeNull();
    expect(report.problems).toEqual([{ name: "sync-disabled", fix: "ub doctor for details" }]);
  });

  it("reports a failed hub without printing the signing secret", () => {
    const secret = "cli-test-signing-secret-3f9a1c";
    const box = sandbox({
      credentials: { signingSecret: secret },
      // A dead hub, so this test never touches a hub the developer is running.
      projectBinding: { workspaceId: WORKSPACE, hubUrl: DEAD_HUB_URL },
    });

    const human = runUb(["status"], box);
    expect(human.status).toBe(0);
    expect(human.stdout).not.toMatch(/credential/);

    const json = runUb(["status", "--json"], box);
    const report = JSON.parse(json.stdout);
    expect(report.account).toBeNull();
    expect(report.connection.state).toBe("failed");
    // The hub URL is reported even when the connection fails; that is the point.
    expect(report.hub).toBe("http://127.0.0.1:1");

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
      projectBinding: { workspaceId: WORKSPACE, hubUrl: DEAD_HUB_URL },
      // A file every user on the machine can read: the secret must go unused.
      credentialsMode: 0o644,
    });

    const run = runUb(["status", "--json"], box);
    expect(run.status).toBe(0);
    const report = JSON.parse(run.stdout);
    // The hub remains visible while the exposed credential goes unused.
    expect(report.account).toBeNull();
    expect(report.connection).toEqual({ state: "failed", cause: null, detail: null });
    expect(report.problems).toEqual([{ name: "sync-disabled", fix: "ub doctor for details" }]);
    // The refusal and its fix are on stderr, and the secret is on neither stream.
    expect(run.stderr).toMatch(/refusing/);
    expect(run.stderr).toMatch(/secret may have leaked/);
    expect(run.output).not.toContain(secret);
  });

  it("never quotes a malformed configuration file back", () => {
    // A bare secret pasted into credentials.json: the parser's message would be
    // the secret itself, so it is not printed.
    const secret = "cli-test-signing-secret-2e6f41";
    const box = sandbox({
      raw: { credentials: `${secret}\n` },
      projectBinding: { workspaceId: WORKSPACE, hubUrl: DEAD_HUB_URL },
    });

    const run = runUb(["status", "--json"], box);
    expect(run.status).toBe(0);
    expect(JSON.parse(run.stdout).problems).toEqual([{ name: "sync-disabled", fix: "ub doctor for details" }]);
    expect(run.stderr).toMatch(/credentials\.json: invalid JSON/);
    expect(run.output).not.toContain(secret);

    // And the same for `config.json`, where a pasted secret is the very mistake
    // `ub` warns about — a file that does not parse never gets that far, so the
    // parser message must not carry it out either.
    const misplaced = "cli-test-misplaced-secret-a70c93";
    const broken = sandbox({ raw: { userConfig: `${misplaced}\n` } });
    const second = runUb(["status", "--json"], broken, {
      UB_WORKSPACE_ID: WORKSPACE,
      UB_HUB_URL: DEAD_HUB_URL,
    });
    expect(second.status).toBe(0);
    expect(second.stderr).toMatch(/config\.json: invalid JSON/);
    expect(second.output).not.toContain(misplaced);
  });

  it("fails with the offending file named when a workspace is not an id", () => {
    const secret = "cli-test-signing-secret-71b4de";
    const box = sandbox({
      credentials: { signingSecret: secret },
      projectBinding: { workspaceId: "../escape", hubUrl: null },
    });

    const run = runUb(["status"], box);
    expect(run.status).not.toBe(0);
    expect(run.stderr).toMatch(/\.uberblick\.json/);
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

/**
 * What the `ub` process does: exit codes, which stream output lands on, and the
 * one thing it must never print.
 *
 * These spawn the real binary. A CLI's contract is its process behaviour, and a
 * function call would not catch a diagnostic written to the wrong stream — which
 * in the `ub mcp serve` path is a corrupted protocol session.
 */

import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { DEAD_HUB_URL, SECRET_IN_ENV, SECRET_ON_FILE, removeTempDirs, runUb, sandbox, tracesOf } from "./helpers.js";

afterAll(removeTempDirs);

/** The workspace these sandboxes are configured for. Ids are uuids. */
const WORKSPACE = "4d8e2f11-6a73-4c95-8b20-9e1f5c3a7d64";

describe("ub", () => {
  it("reports its version", () => {
    const run = runUb(["--version"], sandbox());
    expect(run.status).toBe(0);
    expect(run.stdout.trim()).toMatch(/^\d+\.\d+\.\d+/);
  });
});

describe("ub status", () => {
  it.each(["Caller.Run_1570-1", "invalid/session"])("ignores serve's UB_AGENT_SESSION=%s", (value) => {
    const box = sandbox({ projectBinding: { workspaceId: WORKSPACE, hubUrl: null } });
    const run = runUb(["status", "--json"], box, { UB_AGENT_SESSION: value });
    expect(run.status).toBe(0);
    expect(JSON.parse(run.stdout).workspace.id).toBe(WORKSPACE);
    expect(run.stderr).not.toContain("UB_AGENT_SESSION");
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

  it("prints one JSON object on stdout and no secret on either stream", () => {
    // Each case is a secret `ub` must read past: two disagreeing signing
    // secrets, a credentials file others can read, and files that do not parse.
    const binding = { workspaceId: WORKSPACE, hubUrl: DEAD_HUB_URL };
    const disagreeing = { box: sandbox({ projectBinding: binding, credentials: { signingSecret: SECRET_ON_FILE } }),
      env: { HUB_AUTH_TOKEN: SECRET_IN_ENV }, stderr: /holds a different signing secret/, problem: "hub-unreachable" };
    const cases = [
      disagreeing,
      { box: sandbox({ projectBinding: binding, credentials: { signingSecret: SECRET_ON_FILE }, credentialsMode: 0o644 }),
        env: {}, stderr: /refusing .*secret may have leaked/, problem: "sync-disabled" },
      { box: sandbox({ projectBinding: binding, raw: { credentials: `${SECRET_ON_FILE}\n` } }),
        env: {}, stderr: /credentials\.json: invalid JSON/, problem: "sync-disabled" },
      { box: sandbox({ raw: { userConfig: `${SECRET_IN_ENV}\n` } }),
        env: { UB_WORKSPACE_ID: WORKSPACE, UB_HUB_URL: DEAD_HUB_URL }, stderr: /config\.json: invalid JSON/, problem: "sync-disabled" },
    ];
    const runs = cases.map(({ box, env, stderr, problem }) => {
      const run = runUb(["status", "--json"], box, env);
      expect(run.status, run.output).toBe(0);
      const report = JSON.parse(run.stdout);
      expect(Object.keys(report)).toEqual([
        "workspace", "hub", "version", "account", "chosenBy", "storedIn", "connection", "pending", "lastSync", "recentDevices", "problems",
      ]);
      expect(report.problems.map(({ name }: { name: string }) => name)).toEqual([problem]);
      expect(run.stderr).toMatch(stderr);
      return run;
    });
    const text = runUb(["status"], disagreeing.box, disagreeing.env);
    expect(text.status, text.output).toBe(0);
    expect(text.stderr).toMatch(disagreeing.stderr);
    expect(text.stdout).not.toMatch(/shadowed|credential/);
    for (const run of [...runs, text]) {
      expect(tracesOf(SECRET_IN_ENV, run.output)).toEqual([]);
      expect(tracesOf(SECRET_ON_FILE, run.output)).toEqual([]);
    }
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

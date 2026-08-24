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
  it("succeeds with no configuration anywhere, reporting the defaults", () => {
    // Absent configuration is a default, never an error: nothing here requires
    // `ub init` to have run.
    const run = runUb(["status"], sandbox());
    expect(run.status).toBe(0);
    expect(run.stdout).toMatch(/main/);
    expect(run.stdout).toMatch(/ws:\/\/localhost:1234/);
  });

  it("emits one parseable object with --json, and nothing else on stdout", () => {
    const box = sandbox({ userConfig: { hubUrl: DEAD_HUB_URL } });
    const run = runUb(["status", "--json"], box);
    expect(run.status).toBe(0);

    const report = JSON.parse(run.stdout);
    expect(report.workspace).toBe("main");
    expect(report.hubUrl).toBe(DEAD_HUB_URL);
    expect(report.sources).toEqual({
      workspace: "default",
      hubUrl: "user config",
    });
    expect(report.databasePath).toBe(
      join(box.dataHome, "uberblick", "main.sqlite"),
    );
    expect(report.credentialPresent).toBe(false);
    expect(report.credentialSource).toBeNull();
    expect(report.hub.status).toBe("disabled");
    expect(report.version).toMatch(/^\d+\.\d+\.\d+/);
    // Sync state per attached room. The directory doc exists from boot.
    expect(Array.isArray(report.rooms)).toBe(true);
    expect(report.rooms[0].room).toBe("main/_directory");
    expect(report.rooms[0]).toHaveProperty("synced");
  });

  it("reports a configured credential without printing it", () => {
    const secret = "cli-test-signing-secret-3f9a1c";
    const box = sandbox({
      credentials: { signingSecret: secret },
      // A dead hub, so this test never touches a hub the developer is running.
      userConfig: { hubUrl: DEAD_HUB_URL },
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
      userConfig: { hubUrl: DEAD_HUB_URL },
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

  it("fails with the offending file named when a workspace is not a segment", () => {
    const secret = "cli-test-signing-secret-71b4de";
    const box = sandbox({
      credentials: { signingSecret: secret },
      directoryFile: { workspace: "../escape" },
    });

    const run = runUb(["status"], box);
    expect(run.status).not.toBe(0);
    expect(run.stderr).toMatch(/uberblick\.json/);
    expect(run.output).not.toContain(secret);
  });
});

describe("ub mcp", () => {
  it("rejects anything but `serve`", () => {
    const run = runUb(["mcp", "bogus"], sandbox());
    expect(run.status).not.toBe(0);
    expect(run.stdout).toBe("");
    expect(run.stderr).toMatch(/serve/);
  });
});

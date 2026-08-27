/**
 * The `--json` contract, across every command that offers it.
 *
 * One suite rather than three, because this is one promise: a recognized
 * `--json` run puts **exactly one JSON value on stdout and nothing else**,
 * whether it answers or fails, and the exit status says which — 0 fine, 1 the
 * command could not do it, 2 the invocation was refused. A script that has to
 * scrape stderr to find out that `ub status --json` failed does not have a
 * machine-readable mode.
 *
 * These spawn the real binary: which stream a byte lands on and what the
 * process exits with are the contract, and neither is observable from a
 * function call.
 */

import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";
import { afterAll, describe, expect, it } from "vitest";
import { DEAD_HUB_URL, type Sandbox, UB_BIN, removeTempDirs, runUb, sandbox } from "./helpers.js";

afterAll(removeTempDirs);

const WORKSPACE = "4d8e2f11-6a73-4c95-8b20-9e1f5c3a7d64";

/** Every command that offers `--json`, and the name it reports itself under. */
const JSON_COMMANDS = [
  { name: "ub status", argv: ["status"] },
  { name: "ub doctor", argv: ["doctor"] },
  { name: "ub workspace list", argv: ["workspace", "list"] },
];

/**
 * Parse stdout as the whole of a JSON document.
 *
 * `JSON.parse` is the assertion: it refuses trailing content, so a second value
 * or a stray prose line fails here rather than somewhere subtler downstream.
 */
function soleJsonValue(stdout: string): Record<string, unknown> {
  return JSON.parse(stdout) as Record<string, unknown>;
}

/** A sandbox whose data directory is a regular file — nothing can be read from it. */
function unreadableStorage(): Sandbox {
  const box = sandbox({ userConfig: { workspace: WORKSPACE, hubUrl: DEAD_HUB_URL } });
  writeFileSync(box.dataHome, "not a directory\n", "utf8");
  return box;
}

/**
 * Run `ub` with its reader hung up before it can write a byte.
 *
 * Destroying this end of the pipe is what `| head -1` does once it has what it
 * wanted, and it is the case a CLI has to survive silently: there is nobody left
 * to read a diagnostic, so printing one only vandalises the caller's terminal.
 */
function runWithClosedStdout(args: string[], box: Sandbox): Promise<{ status: number | null; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [UB_BIN, ...args], {
      cwd: box.cwd,
      env: box.env,
      timeout: 25_000,
    });
    child.stdout.destroy();
    let stderr = "";
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });
    child.on("error", reject);
    child.on("close", (status) => resolve({ status, stderr }));
  });
}

describe("--json output", () => {
  it("answers `ub status` and `ub workspace list` with one JSON value and exit 0", () => {
    const box = sandbox({ userConfig: { workspace: WORKSPACE, hubUrl: DEAD_HUB_URL } });

    for (const argv of [["status"], ["workspace", "list"]]) {
      const run = runUb([...argv, "--json"], box);
      expect(run.status).toBe(0);
      // No `error` key on a payload that worked: that key is the discriminator
      // a caller tells the two apart by.
      const parsed = soleJsonValue(run.stdout);
      expect(parsed).not.toHaveProperty("error");
    }
  });

  it("reports a failed `ub doctor` check as a report, not as a failure", () => {
    // Exit 1 with `ok: false` is `ub doctor` answering the question it was
    // asked. Dressing that up as a failure envelope would lose the checks — the
    // whole of what the caller wanted.
    const run = runUb(["doctor", "--json"], sandbox());

    expect(run.status).toBe(1);
    const report = soleJsonValue(run.stdout);
    expect(report.ok).toBe(false);
    expect(report).not.toHaveProperty("error");
  });

  it("lets `--help` win over `--json`, on stdout, at exit 0", () => {
    // Settled policy, and the one documented hole in "a `--json` run prints
    // JSON": somebody reaching for help is not running the command, so what
    // comes back is that path's help rather than the command's result.
    const box = sandbox({ userConfig: { workspace: WORKSPACE, hubUrl: DEAD_HUB_URL } });

    for (const { argv } of JSON_COMMANDS) {
      const run = runUb([...argv, "--json", "--help"], box);
      expect(run.status).toBe(0);
      expect(run.stdout).toMatch(/^usage: ub /);
      expect(run.stderr).toBe("");
    }
  });

  it("carries warnings on stderr while stdout stays one JSON value", () => {
    // An unparseable config file is a warning, not a failure: the run still has
    // an answer, and the answer must not have a warning line glued to the front
    // of it.
    const box = sandbox({ raw: { userConfig: "{ not json" } });
    const run = runUb(["status", "--json"], box, { WORKSPACE_ID: WORKSPACE, HUB_URL: DEAD_HUB_URL });

    expect(run.status).toBe(0);
    expect(run.stderr).toMatch(/warning: ignoring .*invalid JSON/);
    expect(soleJsonValue(run.stdout).workspace).toBe(WORKSPACE);
  });
});

describe("--json failures", () => {
  it.each(JSON_COMMANDS)("refuses a bad flag to $name as JSON, exit 2", ({ name, argv }) => {
    const box = sandbox({ userConfig: { workspace: WORKSPACE, hubUrl: DEAD_HUB_URL } });
    const run = runUb([...argv, "--json", "--bogus"], box);

    expect(run.status).toBe(2);
    const { error } = soleJsonValue(run.stdout) as { error: Record<string, unknown> };
    expect(error.code).toBe("invalid_arguments");
    expect(error.category).toBe("usage");
    expect(error.command).toBe(name);
    expect(error.message).toMatch(/--bogus/);
    // The four documented fields and no fifth: a `stack` or a `cause` is how an
    // exception's incidentals — a stack frame, a query, a value nobody vetted —
    // would ride out to a caller.
    expect(Object.keys(error).sort()).toEqual(["category", "code", "command", "message"]);

    // `--json=true` is the same refusal by another road: a boolean option with a
    // value, which the parser rejects — and the caller who wrote it plainly
    // asked for JSON, so the rejection cannot come back as prose.
    const valued = runUb([...argv, "--json=true"], box);
    expect(valued.status).toBe(2);
    const refused = soleJsonValue(valued.stdout) as { error: Record<string, unknown> };
    expect(refused.error.code).toBe("invalid_arguments");
    expect(refused.error.command).toBe(name);
  });

  it.each([
    { name: "ub status", argv: ["status"] },
    { name: "ub workspace list", argv: ["workspace", "list"] },
  ])("reports $name unable to run as JSON, exit 1", ({ name, argv }) => {
    const run = runUb([...argv, "--json"], unreadableStorage());

    expect(run.status).toBe(1);
    const { error } = soleJsonValue(run.stdout) as { error: Record<string, unknown> };
    expect(error.code).toBe("command_failed");
    expect(error.category).toBe("operational");
    expect(error.command).toBe(name);
    expect(Object.keys(error).sort()).toEqual(["category", "code", "command", "message"]);
  });

  it("never carries the signing secret into the envelope", () => {
    const secret = "s3cret-signing-key-never-printed";
    const box = sandbox({ credentials: { signingSecret: secret } });
    writeFileSync(box.dataHome, "not a directory\n", "utf8");

    const run = runUb(["status", "--json"], box, { WORKSPACE_ID: WORKSPACE, HUB_URL: DEAD_HUB_URL });

    expect(run.status).toBe(1);
    expect(soleJsonValue(run.stdout)).toHaveProperty("error");
    expect(run.output).not.toContain(secret);
  });

  it("keeps the human mode prose, on stderr, with stdout empty", () => {
    const box = sandbox({ userConfig: { workspace: WORKSPACE, hubUrl: DEAD_HUB_URL } });

    const usage = runUb(["status", "--bogus"], box);
    expect(usage.status).toBe(2);
    expect(usage.stdout).toBe("");
    expect(usage.stderr).toMatch(/^ub status: .*--bogus/);

    const operational = runUb(["status"], unreadableStorage());
    expect(operational.status).toBe(1);
    expect(operational.stdout).toBe("");
    expect(operational.stderr).toMatch(/^ub status: /m);
  });
});

describe("a reader that hangs up", () => {
  it.each(JSON_COMMANDS)("lets $name exit quietly rather than crash", async ({ argv }) => {
    const box = sandbox({ userConfig: { workspace: WORKSPACE, hubUrl: DEAD_HUB_URL } });
    const run = await runWithClosedStdout([...argv, "--json"], box);

    // The exit status still reports what `ub` did — `status` and `workspace
    // list` succeeded, `doctor` failed a check — never what its reader did.
    expect(run.status).toBe(argv[0] === "doctor" ? 1 : 0);
    // No unhandled EPIPE: a stack trace over the caller's terminal, for a pipe
    // the caller closed on purpose.
    expect(run.stderr).not.toMatch(/EPIPE|Unhandled 'error' event/);
  });
});

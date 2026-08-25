/**
 * What `ub mcp install` promises about somebody else's file.
 *
 * The contracts under test are the ones a user would be hurt by if they broke:
 * an unrelated server in the same file survives untouched, a second run changes
 * nothing, an entry this command did not write is never replaced without being
 * asked, a replacement is recoverable from a backup, and a file that cannot be
 * read is left exactly as it was. Nothing here prompts — every one of these runs
 * with no terminal attached, which is the point of the flags.
 *
 * The vendor CLIs are stubbed rather than invoked. What `ub` owes is the right
 * delegation — the right program, with the right arguments — and asserting that
 * against a real `claude` would make the suite depend on the machine it runs on.
 */

import { chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { REPO_ROOT, type Sandbox, removeTempDirs, runUb, sandbox } from "./helpers.js";

afterAll(removeTempDirs);

/** A PATH with nothing on it, so every vendor CLI lookup fails with ENOENT. */
const NO_VENDOR = { PATH: "/nonexistent-for-tests" };

/** Where a stub records the arguments it was called with. */
const RECORD = "UB_TEST_VENDOR_RECORD";

/**
 * A directory holding one executable that records its arguments and succeeds —
 * a vendor CLI that is installed, without being the vendor's real one.
 */
function stubVendor(box: Sandbox, program: string): { path: string; record: string } {
  const dir = join(box.cwd, "..", `stub-${program}`);
  mkdirSync(dir, { recursive: true });
  const path = join(dir, program);
  writeFileSync(path, `#!/bin/sh\nprintf '%s\\n' "$@" > "$${RECORD}"\n`, "utf8");
  chmodSync(path, 0o755);
  return { path: dir, record: join(dir, "record") };
}

function read(path: string): string {
  return readFileSync(path, "utf8");
}

/** The backups this command left beside a file, by their full paths. */
function backupsOf(dir: string, name: string): string[] {
  return readdirSync(dir)
    .filter((entry) => entry.startsWith(`${name}.`) && entry.endsWith(".bak"))
    .map((entry) => join(dir, entry));
}

describe("ub mcp install --print", () => {
  it("writes a snippet for the named target and touches no file", () => {
    const box = sandbox();

    const claude = runUb(["mcp", "install", "claude", "--project", "--print"], box);
    expect(claude.status).toBe(0);
    const parsed = JSON.parse(claude.stdout);
    expect(parsed.mcpServers.uberblick).toEqual({
      type: "stdio",
      command: "ub",
      args: ["mcp", "serve"],
    });
    expect(existsSync(join(box.cwd, ".mcp.json"))).toBe(false);

    // Codex's file is TOML, so the snippet has to be TOML — a JSON snippet
    // would be a valid-looking answer that silently does not work.
    const codex = runUb(["mcp", "install", "codex", "--user", "--print"], box);
    expect(codex.status).toBe(0);
    expect(codex.stdout).toBe(
      '[mcp_servers.uberblick]\ncommand = "ub"\nargs = ["mcp", "serve"]\n',
    );
  });

  it("names the targets, and points an unlisted client at --print", () => {
    const run = runUb(["mcp", "install", "emacs"], sandbox());
    expect(run.status).toBe(2);
    expect(run.stdout).toBe("");
    expect(run.stderr).toMatch(/claude, codex, cursor/);
    expect(run.stderr).toMatch(/--print/);
  });
});

describe("ub mcp install (JSON targets)", () => {
  it("creates a config where there is none, registering `ub mcp serve`", () => {
    const box = sandbox();
    const run = runUb(["mcp", "install", "claude", "--project"], box, NO_VENDOR);
    expect(run.status).toBe(0);

    const path = join(box.cwd, ".mcp.json");
    expect(JSON.parse(read(path)).mcpServers.uberblick).toEqual({
      type: "stdio",
      command: "ub",
      args: ["mcp", "serve"],
    });
    // No environment, ever: configuration is resolved by `ub`, not pinned here.
    expect(read(path)).not.toMatch(/"env"/);
  });

  it("leaves an unrelated server byte-for-byte, and is a no-op the second time", () => {
    const box = sandbox();
    const path = join(box.cwd, ".mcp.json");
    const unrelated = `      "command": "other-server",\n      "args": ["--port", "7"]`;
    writeFileSync(
      path,
      `{\n  "note": "hand written",\n  "mcpServers": {\n    "other": {\n${unrelated}\n    }\n  }\n}\n`,
      "utf8",
    );

    const first = runUb(["mcp", "install", "cursor", "--project"], box, NO_VENDOR);
    expect(first.status).toBe(0);

    // Cursor's project file is its own, so the seeded one must be untouched and
    // the new one must exist beside it.
    expect(read(path)).toContain(unrelated);

    // And the same seeded shape as a Claude project file, which IS the file
    // being edited: the unrelated entry survives the rewrite.
    const claude = runUb(["mcp", "install", "claude", "--project"], box, NO_VENDOR);
    expect(claude.status).toBe(0);
    const after = read(path);
    const doc = JSON.parse(after);
    expect(doc.note).toBe("hand written");
    expect(doc.mcpServers.other).toEqual({
      command: "other-server",
      args: ["--port", "7"],
    });
    expect(doc.mcpServers.uberblick.command).toBe("ub");
    // Key order is preserved, so the unrelated server is still written first.
    expect(after.indexOf('"other"')).toBeLessThan(after.indexOf('"uberblick"'));

    // The edit that added us backed the file up first; the no-op must not.
    const backups = backupsOf(box.cwd, ".mcp.json");
    expect(backups).toHaveLength(1);

    const second = runUb(["mcp", "install", "claude", "--project"], box, NO_VENDOR);
    expect(second.status).toBe(0);
    expect(second.stdout).toMatch(/already installed/);
    expect(read(path)).toBe(after);
    expect(backupsOf(box.cwd, ".mcp.json")).toEqual(backups);
  });

  it("recognises what the vendor's own CLI writes as already installed", () => {
    // `claude mcp add` writes `type` and an empty `env`; `ub` writes neither.
    // Equality is about what the client will run, so this must not be a clash
    // between the two ways of installing the very same server.
    const box = sandbox();
    const path = join(box.cwd, ".mcp.json");
    writeFileSync(
      path,
      `${JSON.stringify(
        {
          mcpServers: {
            uberblick: {
              type: "stdio",
              command: "ub",
              args: ["mcp", "serve"],
              env: {},
            },
          },
        },
        null,
        2,
      )}\n`,
      "utf8",
    );
    const before = read(path);

    const run = runUb(["mcp", "install", "claude", "--project"], box, NO_VENDOR);
    expect(run.status).toBe(0);
    expect(run.stdout).toMatch(/already installed/);
    expect(read(path)).toBe(before);
  });

  it("refuses a different uberblick entry, and replaces it only with --force", () => {
    const box = sandbox();
    const path = join(box.cwd, ".mcp.json");
    const before = `${JSON.stringify(
      { mcpServers: { uberblick: { command: "somebody-elses", args: ["serve"] } } },
      null,
      2,
    )}\n`;
    writeFileSync(path, before, "utf8");

    const refused = runUb(["mcp", "install", "claude", "--project"], box, NO_VENDOR);
    expect(refused.status).toBe(1);
    expect(refused.stdout).toBe("");
    // Both sides of the decision, so the answer does not need a second command.
    expect(refused.stderr).toMatch(/somebody-elses/);
    expect(refused.stderr).toMatch(/proposed/);
    expect(refused.stderr).toMatch(/--force/);
    expect(read(path)).toBe(before);

    const forced = runUb(
      ["mcp", "install", "claude", "--project", "--force"],
      box,
      NO_VENDOR,
    );
    expect(forced.status).toBe(0);
    expect(JSON.parse(read(path)).mcpServers.uberblick.command).toBe("ub");

    // The replaced file is recoverable, and the backup is the bytes that were
    // there — not a re-serialisation of them.
    const backups = backupsOf(box.cwd, ".mcp.json");
    expect(backups).toHaveLength(1);
    expect(read(backups[0] as string)).toBe(before);
    expect(forced.stdout).toContain(backups[0] as string);
  });

  it("names an unreadable file, fails, and does not write to it", () => {
    const box = sandbox();
    const path = join(box.cwd, ".mcp.json");
    const before = "{ this is not json\n";
    writeFileSync(path, before, "utf8");

    const run = runUb(["mcp", "install", "claude", "--project"], box, NO_VENDOR);
    expect(run.status).not.toBe(0);
    expect(run.stdout).toBe("");
    expect(run.stderr).toContain(path);
    expect(read(path)).toBe(before);
    expect(backupsOf(box.cwd, ".mcp.json")).toEqual([]);
  });
});

describe("ub mcp install codex", () => {
  /** A Codex config with settings around the table this command edits. */
  const seeded = 'model = "gpt-5"\n\n[sandbox]\nmode = "workspace-write"\n';

  function codexHome(box: Sandbox): { home: string; path: string } {
    const home = join(box.cwd, "codex-home");
    mkdirSync(home, { recursive: true });
    return { home, path: join(home, "config.toml") };
  }

  it("appends its table and leaves every other setting byte-for-byte", () => {
    const box = sandbox();
    const { home, path } = codexHome(box);
    writeFileSync(path, seeded, "utf8");

    const env = { ...NO_VENDOR, CODEX_HOME: home };
    const run = runUb(["mcp", "install", "codex", "--user"], box, env);
    expect(run.status).toBe(0);
    expect(run.stdout).toContain(path);

    const after = read(path);
    // The user's own settings are the original bytes, still at the front.
    expect(after.startsWith(seeded)).toBe(true);
    expect(after).toContain(
      '[mcp_servers.uberblick]\ncommand = "ub"\nargs = ["mcp", "serve"]\n',
    );

    const second = runUb(["mcp", "install", "codex", "--user"], box, env);
    expect(second.status).toBe(0);
    expect(second.stdout).toMatch(/already installed/);
    expect(read(path)).toBe(after);
  });

  it("replaces its own table in place, keeping the tables after it", () => {
    const box = sandbox();
    const { home, path } = codexHome(box);
    const before =
      'model = "gpt-5"\n\n' +
      '[mcp_servers.uberblick]\ncommand = "somebody-elses"\nargs = []\n\n' +
      '[sandbox]\nmode = "workspace-write"\n';
    writeFileSync(path, before, "utf8");
    const env = { ...NO_VENDOR, CODEX_HOME: home };

    const refused = runUb(["mcp", "install", "codex", "--user"], box, env);
    expect(refused.status).toBe(1);
    expect(refused.stderr).toMatch(/somebody-elses/);
    expect(read(path)).toBe(before);

    const forced = runUb(["mcp", "install", "codex", "--user", "--force"], box, env);
    expect(forced.status).toBe(0);
    const after = read(path);
    expect(after).toContain('command = "ub"');
    expect(after).not.toContain("somebody-elses");
    // The table that followed ours is still there, and still after it.
    expect(after).toContain('[sandbox]\nmode = "workspace-write"\n');
    expect(after.indexOf("[mcp_servers.uberblick]")).toBeLessThan(
      after.indexOf("[sandbox]"),
    );
    expect(after.startsWith('model = "gpt-5"\n')).toBe(true);

    const backups = backupsOf(home, "config.toml");
    expect(backups).toHaveLength(1);
    expect(read(backups[0] as string)).toBe(before);
  });

  it("refuses a config whose shape it cannot edit without guessing", () => {
    // An inline `uberblick` under [mcp_servers] cannot be spliced as a table:
    // appending one would give Codex a duplicate key and take down its whole
    // configuration, so this is a refusal rather than a repair.
    const box = sandbox();
    const { home, path } = codexHome(box);
    const before = '[mcp_servers]\nuberblick = { command = "ub" }\n';
    writeFileSync(path, before, "utf8");

    const run = runUb(
      ["mcp", "install", "codex", "--user", "--force"],
      box,
      { ...NO_VENDOR, CODEX_HOME: home },
    );
    expect(run.status).not.toBe(0);
    expect(run.stderr).toContain(path);
    expect(read(path)).toBe(before);
  });
});

describe("ub mcp install, and the vendor's own CLI", () => {
  it("delegates to it when it is installed, and says that it did", () => {
    const box = sandbox();
    const stub = stubVendor(box, "claude");

    const run = runUb(["mcp", "install", "claude", "--project"], box, {
      PATH: stub.path,
      [RECORD]: stub.record,
    });
    expect(run.status).toBe(0);
    expect(run.stdout).toMatch(/via\s+claude mcp add/);

    // The exact delegation: the vendor's documented syntax, with `--`
    // separating its own flags from the command it is being told to run.
    expect(read(stub.record).trimEnd().split("\n")).toEqual([
      "mcp",
      "add",
      "uberblick",
      "--scope",
      "project",
      "--",
      "ub",
      "mcp",
      "serve",
    ]);
    // The vendor writes the file; `ub` must not also write one behind its back.
    expect(existsSync(join(box.cwd, ".mcp.json"))).toBe(false);
  });

  it("falls back to editing the file when it is not installed, and says so", () => {
    const box = sandbox();
    const run = runUb(["mcp", "install", "claude", "--project"], box, NO_VENDOR);
    expect(run.status).toBe(0);

    // The path is matched loosely because the child resolves its working
    // directory, and the sandbox lives under a symlinked temporary directory.
    const path = join(box.cwd, ".mcp.json");
    expect(run.stdout).toMatch(/via\s+edited \S*\.mcp\.json/);
    expect(existsSync(path)).toBe(true);
  });
});

describe("the checkout's own .mcp.json", () => {
  it("is what this command generates, rather than hand-maintained", () => {
    // The one file in the repository this command owns. It does not run
    // `ub mcp serve` — a fresh checkout has no installed `ub` — so it is
    // generated with the `--` override, and this asserts that the bytes
    // committed are the bytes the command produces for that same command.
    const committed = read(join(REPO_ROOT, ".mcp.json"));
    const entry = JSON.parse(committed).mcpServers.uberblick;

    const box = sandbox();
    const run = runUb(
      [
        "mcp",
        "install",
        "claude",
        "--project",
        "--",
        entry.command,
        ...entry.args,
      ],
      box,
      NO_VENDOR,
    );
    expect(run.status).toBe(0);
    expect(read(join(box.cwd, ".mcp.json"))).toBe(committed);
  });
});

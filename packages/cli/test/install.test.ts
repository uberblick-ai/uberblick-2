/**
 * What `ub mcp install` promises about somebody else's file.
 *
 * The contracts under test are the ones a user would be hurt by if they broke:
 * an unrelated server in the same file survives untouched — *byte for byte*, not
 * merely in value — a second run changes nothing, an entry this command did not
 * write is never replaced without being asked, a replacement is recoverable from
 * a backup, a file that cannot be read is left exactly as it was, and no value
 * out of a config file is ever echoed onto a terminal. Nothing here prompts:
 * every one of these runs with no terminal attached, which is the point of the
 * flags.
 *
 * The vendor CLIs are stubbed rather than invoked. What `ub` owes is the right
 * delegation — the right program, with the right arguments — and asserting that
 * against a real `claude` would make the suite depend on the machine it runs on.
 */

import {
  chmodSync,
  closeSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { afterAll, describe, expect, it } from "vitest";
import { openConfig, publish, verifyUnchanged } from "../src/install.js";
import {
  REPO_ROOT,
  type Sandbox,
  UB_BIN,
  removeTempDirs,
  runUb,
  sandbox,
} from "./helpers.js";

afterAll(removeTempDirs);

/** A PATH with nothing on it, so every vendor CLI lookup fails with ENOENT. */
const NO_VENDOR = { PATH: "/nonexistent-for-tests" };

/** Where a stub records the arguments it was called with. */
const RECORD = "UB_TEST_VENDOR_RECORD";

/**
 * A value that must never reach a terminal. Config files are where people keep
 * tokens, and every path that reports on one has to be safe for that.
 */
const SECRET = "tok-must-never-be-printed-4a1f";

/**
 * The same, short.
 *
 * V8's JSON parse errors quote a *window* of about ten characters around the
 * offending byte, so a long token would be truncated inside the message and a
 * test looking for the whole of it would pass while a fragment leaked. This one
 * fits in the window, which is what makes the assertion real.
 */
const SHORT_SECRET = "tok-4a1f";

function stubVendor(
  box: Sandbox,
  program: string,
  /** Appended after the stub records its arguments. */
  body = "",
): { path: string; record: string } {
  const dir = join(box.cwd, "..", `stub-${program}`);
  mkdirSync(dir, { recursive: true });
  const path = join(dir, program);
  writeFileSync(
    path,
    `#!/bin/sh\nprintf '%s\\n' "$@" > "$${RECORD}"\n${body}`,
    "utf8",
  );
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

/**
 * The one contiguous run of bytes `after` adds to `before`, or null when the
 * difference is not a single insertion.
 *
 * This is "every other byte survived" written as something a test can check.
 * Comparing parsed values instead would pass for a file that had been reflowed,
 * re-escaped and stripped of its blank lines — which is exactly the failure this
 * is here to catch.
 */
function soleInsertion(before: string, after: string): string | null {
  if (after.length <= before.length) {
    return null;
  }
  let head = 0;
  while (head < before.length && before[head] === after[head]) {
    head += 1;
  }
  let tail = 0;
  while (
    tail < before.length - head &&
    before[before.length - 1 - tail] === after[after.length - 1 - tail]
  ) {
    tail += 1;
  }
  return head + tail === before.length ? after.slice(head, after.length - tail) : null;
}

/** The single span that differs between two texts, as {removed, added}. */
function soleChange(
  before: string,
  after: string,
): { removed: string; added: string } {
  const shortest = Math.min(before.length, after.length);
  let head = 0;
  while (head < shortest && before[head] === after[head]) {
    head += 1;
  }
  let tail = 0;
  while (
    tail < shortest - head &&
    before[before.length - 1 - tail] === after[after.length - 1 - tail]
  ) {
    tail += 1;
  }
  return {
    removed: before.slice(head, before.length - tail),
    added: after.slice(head, after.length - tail),
  };
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

  it("answers for a client it does not know, and writes nothing", () => {
    // `--print` is the documented answer for any client not on the list, so it
    // has to work *without* a known target rather than rejecting the name.
    const box = sandbox();
    const run = runUb(["mcp", "install", "zed", "--print"], box);
    expect(run.status).toBe(0);
    expect(JSON.parse(run.stdout).mcpServers.uberblick).toEqual({
      type: "stdio",
      command: "ub",
      args: ["mcp", "serve"],
    });
    expect(run.stderr).toMatch(/not a client/);
    expect(existsSync(join(box.cwd, ".mcp.json"))).toBe(false);
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

  it("adds its member and changes no other byte of the file", () => {
    // Deliberately not the shape this command would have written: a compact
    // nested object, a non-ASCII escape, an odd blank line, a key after
    // mcpServers. Re-serialising would quietly normalise every one of them.
    const box = sandbox();
    const path = join(box.cwd, ".mcp.json");
    const before =
      '{\n  "note": "kept \\u00e9 verbatim",\n' +
      '  "mcpServers": {"other":{"command":"other-server","args":["--port","7"]}},\n' +
      "\n" +
      '  "trailing": [1, 2, 3]\n}\n';
    writeFileSync(path, before, "utf8");

    const run = runUb(["mcp", "install", "claude", "--project"], box, NO_VENDOR);
    expect(run.status).toBe(0);

    const after = read(path);
    const inserted = soleInsertion(before, after);
    // One contiguous insertion, and it is ours. Everything else is the original
    // bytes, in their original places.
    expect(inserted).not.toBeNull();
    expect(inserted).toContain('"uberblick"');
    expect(inserted).toContain('"mcp"');
    // It matched the compact style of the object it went into.
    expect(inserted).not.toContain("\n");
    expect(JSON.parse(after).mcpServers.uberblick.command).toBe("ub");
  });

  it("leaves an unrelated server byte-for-byte, and is a no-op the second time", () => {
    const box = sandbox();
    const path = join(box.cwd, ".mcp.json");
    const before =
      '{\n  "note": "hand written",\n  "mcpServers": {\n    "other": {\n' +
      '      "command": "other-server",\n      "args": ["--port", "7"]\n' +
      "    }\n  }\n}\n";
    writeFileSync(path, before, "utf8");

    const first = runUb(["mcp", "install", "claude", "--project"], box, NO_VENDOR);
    expect(first.status).toBe(0);

    const after = read(path);
    const inserted = soleInsertion(before, after);
    expect(inserted).not.toBeNull();
    expect(inserted).toContain('"uberblick"');
    // The unrelated server is untouched, and still written first.
    expect(after).toContain('      "command": "other-server",\n      "args": ["--port", "7"]');
    expect(after.indexOf('"other"')).toBeLessThan(after.indexOf('"uberblick"'));
    expect(JSON.parse(after).note).toBe("hand written");

    // The edit that added us backed the file up first; the no-op must not.
    const backups = backupsOf(box.cwd, ".mcp.json");
    expect(backups).toHaveLength(1);
    expect(read(backups[0] as string)).toBe(before);

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

  it("refuses a different uberblick entry, and replaces only its own bytes with --force", () => {
    const box = sandbox();
    const path = join(box.cwd, ".mcp.json");
    const before =
      '{\n  "mcpServers": {\n    "other": {"command": "other-server"},\n' +
      '    "uberblick": {\n      "command": "somebody-elses",\n' +
      '      "args": ["serve"]\n    }\n  }\n}\n';
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

    const after = read(path);
    const change = soleChange(before, after);
    // Only the old entry went, and only the new one arrived: the unrelated
    // server is nowhere near the span that changed.
    expect(change.removed).toContain("somebody-elses");
    expect(change.removed).not.toContain("other-server");
    expect(change.added).not.toContain("other-server");
    expect(after).toContain('"other": {"command": "other-server"}');
    expect(JSON.parse(after).mcpServers.uberblick.command).toBe("ub");

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

  it("refuses a file whose duplicate keys hide which entry is real", () => {
    // Duplicate keys are not valid JSON, but every parser takes them: this one
    // keeps the *last*, and a scan of the text finds the *first*. Editing one
    // while reporting on the other, with the client reading a third answer, is
    // not something to do quietly.
    for (const before of [
      '{\n  "mcpServers": {"other": {"command": "a"}},\n' +
        '  "mcpServers": {"uberblick": {"command": "somebody-elses"}}\n}\n',
      '{\n  "mcpServers": {\n    "uberblick": {"command": "first"},\n' +
        '    "uberblick": {"command": "second"}\n  }\n}\n',
    ]) {
      const box = sandbox();
      const path = join(box.cwd, ".mcp.json");
      writeFileSync(path, before, "utf8");

      const run = runUb(
        ["mcp", "install", "claude", "--project", "--force"],
        box,
        NO_VENDOR,
      );
      expect(run.status, before).not.toBe(0);
      expect(run.stderr).toContain(path);
      expect(run.stderr).toMatch(/more than once/);
      expect(read(path)).toBe(before);
      expect(backupsOf(box.cwd, ".mcp.json")).toEqual([]);
    }
  });

  it("refuses duplicate fields inside its own entry", () => {
    // The nastiest shape of the duplicate-key problem: everything *around* the
    // entry is unambiguous, and the entry parses here to exactly what `ub`
    // installs — so without this check the answer is a confident "already
    // installed" while a first-key parser spawns `somebody-elses`.
    const box = sandbox();
    const path = join(box.cwd, ".mcp.json");
    const before =
      '{\n  "mcpServers": {\n    "uberblick": {\n' +
      '      "command": "somebody-elses",\n      "command": "ub",\n' +
      '      "args": ["mcp", "serve"]\n    }\n  }\n}\n';
    writeFileSync(path, before, "utf8");

    const run = runUb(["mcp", "install", "claude", "--project"], box, NO_VENDOR);
    expect(run.status).not.toBe(0);
    expect(run.stdout).toBe("");
    expect(run.stderr).toContain(path);
    expect(run.stderr).toMatch(/"command" more than once/);
    expect(read(path)).toBe(before);
    expect(backupsOf(box.cwd, ".mcp.json")).toEqual([]);
  });

  it("refuses a symlink rather than writing through it", () => {
    const box = sandbox();
    const target = join(box.cwd, "elsewhere.json");
    writeFileSync(target, "{}\n", "utf8");
    symlinkSync(target, join(box.cwd, ".mcp.json"));

    const run = runUb(["mcp", "install", "claude", "--project"], box, NO_VENDOR);
    expect(run.status).toBe(1);
    expect(run.stderr).toMatch(/symbolic link/);
    // The thing it pointed at never received anything.
    expect(read(target)).toBe("{}\n");
  });
});

describe("ub mcp install, and what it will not print", () => {
  it("does not quote a malformed file back, only its path", () => {
    const box = sandbox();
    const path = join(box.cwd, ".mcp.json");
    // Broken JSON with a credential right where the parser will stumble: Node's
    // own message quotes the fragment it choked on, so it must not be relayed.
    writeFileSync(
      path,
      `{"mcpServers":{"uberblick":{"command":${SHORT_SECRET}}}}\n`,
      "utf8",
    );

    const run = runUb(["mcp", "install", "claude", "--project"], box, NO_VENDOR);
    expect(run.status).not.toBe(0);
    expect(run.stderr).toContain(path);
    expect(run.stderr).toMatch(/not valid JSON/);
    expect(run.output).not.toContain(SHORT_SECRET);
  });

  it("masks the values of a conflicting entry, keeping its shape", () => {
    const box = sandbox();
    const path = join(box.cwd, ".mcp.json");
    writeFileSync(
      path,
      `${JSON.stringify(
        {
          mcpServers: {
            uberblick: {
              command: "somebody-elses",
              args: ["serve"],
              env: { API_TOKEN: SECRET },
            },
          },
        },
        null,
        2,
      )}\n`,
      "utf8",
    );

    const run = runUb(["mcp", "install", "claude", "--project"], box, NO_VENDOR);
    expect(run.status).toBe(1);
    // Enough to compare against the proposal…
    expect(run.stderr).toContain("somebody-elses");
    // …including which variables are set, but never what they are set to.
    expect(run.stderr).toContain("API_TOKEN");
    expect(run.output).not.toContain(SECRET);
  });

  it("strips comments out of a Codex conflict report", () => {
    // A trailing `# …` is as good a place to leave a token as any, and both the
    // header and the one value this report is allowed to show can carry one.
    const box = sandbox();
    const home = join(box.cwd, "codex-home");
    mkdirSync(home, { recursive: true });
    const path = join(home, "config.toml");
    writeFileSync(
      path,
      `[mcp_servers.uberblick] # ${SECRET}\n` +
        `command = "somebody-elses" # ${SECRET}\n` +
        `args = [] # ${SECRET}\n`,
      "utf8",
    );

    const run = runUb(["mcp", "install", "codex", "--user"], box, {
      ...NO_VENDOR,
      CODEX_HOME: home,
    });
    expect(run.status).toBe(1);
    // Still comparable: the header and the command survive…
    expect(run.stderr).toContain("[mcp_servers.uberblick]");
    expect(run.stderr).toContain('command = "somebody-elses"');
    // …with nothing of the comments that rode along with them.
    expect(run.output).not.toContain(SECRET);
    expect(run.output).not.toContain("#");
  });

  it("masks a value whose string was never closed", () => {
    // An unterminated quote swallows the rest of the line, `#` included, so the
    // scanner cannot say where the value ended or whether a comment followed.
    // Not being able to bound it is exactly the reason not to print it.
    const box = sandbox();
    const home = join(box.cwd, "codex-home");
    mkdirSync(home, { recursive: true });
    const path = join(home, "config.toml");
    writeFileSync(
      path,
      `[mcp_servers.uberblick]\ncommand = "somebody-elses # ${SECRET}\nargs = []\n`,
      "utf8",
    );

    const run = runUb(["mcp", "install", "codex", "--user"], box, {
      ...NO_VENDOR,
      CODEX_HOME: home,
    });
    expect(run.status).toBe(1);
    expect(run.stderr).toContain("command = …");
    expect(run.output).not.toContain(SECRET);
  });

  it("masks the values in a conflicting Codex env table too", () => {
    const box = sandbox();
    const home = join(box.cwd, "codex-home");
    mkdirSync(home, { recursive: true });
    const path = join(home, "config.toml");
    writeFileSync(
      path,
      '[mcp_servers.uberblick]\ncommand = "somebody-elses"\nargs = []\n\n' +
        `[mcp_servers.uberblick.env]\nAPI_TOKEN = "${SECRET}"\n`,
      "utf8",
    );

    const run = runUb(["mcp", "install", "codex", "--user"], box, {
      ...NO_VENDOR,
      CODEX_HOME: home,
    });
    expect(run.status).toBe(1);
    expect(run.stderr).toContain("somebody-elses");
    expect(run.stderr).toContain("API_TOKEN");
    expect(run.output).not.toContain(SECRET);
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

  function env(home: string): NodeJS.ProcessEnv {
    return { ...NO_VENDOR, CODEX_HOME: home };
  }

  it("appends its table and leaves every other setting byte-for-byte", () => {
    const box = sandbox();
    const { home, path } = codexHome(box);
    writeFileSync(path, seeded, "utf8");

    const run = runUb(["mcp", "install", "codex", "--user"], box, env(home));
    expect(run.status).toBe(0);
    expect(run.stdout).toContain(path);

    const after = read(path);
    // The user's own settings are the original bytes, still at the front.
    expect(after.startsWith(seeded)).toBe(true);
    expect(after).toContain(
      '[mcp_servers.uberblick]\ncommand = "ub"\nargs = ["mcp", "serve"]\n',
    );

    const second = runUb(["mcp", "install", "codex", "--user"], box, env(home));
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

    const refused = runUb(["mcp", "install", "codex", "--user"], box, env(home));
    expect(refused.status).toBe(1);
    expect(refused.stderr).toMatch(/somebody-elses/);
    expect(read(path)).toBe(before);

    const forced = runUb(
      ["mcp", "install", "codex", "--user", "--force"],
      box,
      env(home),
    );
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

  it("finds its table even with a comment after the header", () => {
    // Missing this header would append a second [mcp_servers.uberblick] — a
    // duplicate table, which is not valid TOML, reported as a success.
    const box = sandbox();
    const { home, path } = codexHome(box);
    const before =
      '[mcp_servers.uberblick] # added by hand\ncommand = "somebody-elses"\nargs = []\n';
    writeFileSync(path, before, "utf8");

    const refused = runUb(["mcp", "install", "codex", "--user"], box, env(home));
    expect(refused.status).toBe(1);
    expect(refused.stderr).toMatch(/somebody-elses/);
    expect(read(path)).toBe(before);

    const forced = runUb(
      ["mcp", "install", "codex", "--user", "--force"],
      box,
      env(home),
    );
    expect(forced.status).toBe(0);
    const after = read(path);
    expect(after.match(/\[mcp_servers\.uberblick\]/g)).toHaveLength(1);
    expect(after).toContain('command = "ub"');
  });

  it("does not mistake a differently-named server for its own", () => {
    // `[mcp_servers."uber blick"]` is a *different* key. Flattening the quotes
    // away would make --force delete somebody else's server.
    const box = sandbox();
    const { home, path } = codexHome(box);
    const before =
      '[mcp_servers."uber blick"]\ncommand = "somebody-elses"\nargs = []\n';
    writeFileSync(path, before, "utf8");

    const run = runUb(
      ["mcp", "install", "codex", "--user", "--force"],
      box,
      env(home),
    );
    expect(run.status).toBe(0);
    const after = read(path);
    expect(after.startsWith(before)).toBe(true);
    expect(after).toContain("somebody-elses");
    expect(after).toContain('[mcp_servers.uberblick]\ncommand = "ub"');
  });

  it("is not fooled by a bracket inside a multi-line array", () => {
    const box = sandbox();
    const { home, path } = codexHome(box);
    const before =
      '[sandbox]\nwritable_roots = [\n  ["/tmp", "rw"],\n]\n\n' +
      '[mcp_servers.uberblick]\ncommand = "somebody-elses"\nargs = []\n';
    writeFileSync(path, before, "utf8");

    const run = runUb(
      ["mcp", "install", "codex", "--user", "--force"],
      box,
      env(home),
    );
    expect(run.status).toBe(0);
    const after = read(path);
    // The array survived intact, and our table — found past it — was replaced
    // rather than appended a second time.
    expect(after).toContain('writable_roots = [\n  ["/tmp", "rw"],\n]');
    expect(after.match(/\[mcp_servers\.uberblick\]/g)).toHaveLength(1);
    expect(after).toContain('command = "ub"');
    expect(after).not.toContain("somebody-elses");
  });

  it("bounds a multi-line string that contains an escaped quote run", () => {
    // `\"""` inside a basic string is one escaped quote and two literal ones,
    // not a terminator. Ending the string there turns the real terminator into
    // an *opener*, which swallows every line after it — the table header
    // included — and the table is then appended a second time.
    const box = sandbox();
    const { home, path } = codexHome(box);
    const before =
      'notice = """\nhe said \\""" loudly\n"""\n\n' +
      '[mcp_servers.uberblick]\ncommand = "somebody-elses"\nargs = []\n';
    writeFileSync(path, before, "utf8");

    const refused = runUb(["mcp", "install", "codex", "--user"], box, env(home));
    expect(refused.status).toBe(1);
    expect(refused.stderr).toMatch(/somebody-elses/);
    expect(read(path)).toBe(before);

    const forced = runUb(
      ["mcp", "install", "codex", "--user", "--force"],
      box,
      env(home),
    );
    expect(forced.status).toBe(0);
    const after = read(path);
    // Replaced in place, not appended: exactly one table, and the string that
    // confused the scanner is still there byte for byte.
    expect(after.match(/\[mcp_servers\.uberblick\]/g)).toHaveLength(1);
    expect(after).toContain('notice = """\nhe said \\""" loudly\n"""');
    expect(after).toContain('command = "ub"');
    expect(after).not.toContain("somebody-elses");
  });

  it("refuses a config whose shape it cannot edit without guessing", () => {
    // Three ways of defining the same thing that cannot be spliced as a table:
    // appending one would give Codex a duplicate key and take down its whole
    // configuration, so each is a refusal rather than a repair.
    for (const before of [
      '[mcp_servers]\nuberblick = { command = "ub" }\n',
      'mcp_servers.uberblick.command = "somebody-elses"\n',
      'mcp_servers = { uberblick = { command = "ub" } }\n',
    ]) {
      const box = sandbox();
      const { home, path } = codexHome(box);
      writeFileSync(path, before, "utf8");

      const run = runUb(
        ["mcp", "install", "codex", "--user", "--force"],
        box,
        env(home),
      );
      expect(run.status, before).not.toBe(0);
      expect(run.stderr).toContain(path);
      // And it says how to proceed by hand rather than just refusing.
      expect(run.stderr).toMatch(/--print/);
      expect(read(path)).toBe(before);
    }
  });
});

describe("the file it read is the file it writes", () => {
  it("refuses when the config changed underneath it", () => {
    // The window between reading a config and replacing it is where a backup
    // ends up holding a version that was already gone. It is not reachable from
    // outside a single run, so the check itself is what gets held to account.
    const box = sandbox();
    const path = join(box.cwd, ".mcp.json");
    writeFileSync(path, '{"mcpServers":{}}\n', "utf8");

    const opened = openConfig(path);
    expect(opened.kind).toBe("open");
    if (opened.kind !== "open") {
      return;
    }
    try {
      // Unchanged: no complaint.
      expect(() => verifyUnchanged(path, opened.config)).not.toThrow();

      // Somebody else rewrites it.
      writeFileSync(path, '{"mcpServers":{"other":{"command":"x"}}}\n', "utf8");
      expect(() => verifyUnchanged(path, opened.config)).toThrow(/changed while/);
    } finally {
      closeSync(opened.config.fd);
    }
  });

  it("does not clobber a replace that lands after the decision was made", () => {
    // The window that matters: everything between reading the config and the
    // rename that replaces it — backing up, rendering, staging. An editor's own
    // atomic save takes milliseconds and fits inside it comfortably, so the
    // check has to sit after the staging write rather than before the backup.
    const box = sandbox();
    const path = join(box.cwd, ".mcp.json");
    writeFileSync(path, '{"mcpServers":{}}\n', "utf8");

    const opened = openConfig(path);
    expect(opened.kind).toBe("open");
    if (opened.kind !== "open") {
      return;
    }
    try {
      const landed = '{"mcpServers":{"someone-else":{"command":"x"}}}\n';
      writeFileSync(path, landed, "utf8");

      expect(() => publish(path, '{"clobbered":true}\n', opened.config)).toThrow(
        /changed while/,
      );
      // Their save survived, and nothing of ours was left lying beside it.
      expect(read(path)).toBe(landed);
      expect(
        readdirSync(box.cwd).filter((entry) => entry.includes(".tmp")),
      ).toEqual([]);
    } finally {
      closeSync(opened.config.fd);
    }
  });

  it("refuses when the name was pointed at a different file", () => {
    const box = sandbox();
    const path = join(box.cwd, ".mcp.json");
    writeFileSync(path, '{"mcpServers":{}}\n', "utf8");

    const opened = openConfig(path);
    expect(opened.kind).toBe("open");
    if (opened.kind !== "open") {
      return;
    }
    try {
      // Same bytes, different inode: a swap the size and mtime would not show.
      const other = join(box.cwd, "other.json");
      writeFileSync(other, '{"mcpServers":{}}\n', "utf8");
      renameSync(other, path);

      expect(() => verifyUnchanged(path, opened.config)).toThrow(/changed while/);
    } finally {
      closeSync(opened.config.fd);
    }
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

  it("reports that it failed without repeating what it said", () => {
    // A client's own diagnostics quote the config it just read, so relaying
    // them would walk straight past the masking every other report here does.
    const box = sandbox();
    const stub = stubVendor(
      box,
      "claude",
      `echo "conflict in config: API_TOKEN=${SECRET}" >&2\necho "${SECRET}"\nexit 1\n`,
    );

    const run = runUb(["mcp", "install", "claude", "--project"], box, {
      PATH: stub.path,
      [RECORD]: stub.record,
    });
    expect(run.status).toBe(1);
    expect(run.output).not.toContain(SECRET);
    // Enough to act on: which program, how it ended, and where to look.
    expect(run.stderr).toMatch(/claude mcp add/);
    expect(run.stderr).toMatch(/exited 1/);
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
  /**
   * The spawn the committed file has to carry, stated here independently.
   *
   * This is the whole point of the test: with the expectation written out, the
   * committed file and the generator have to agree with *it*, so changing
   * either one alone fails. Reading the arguments out of the file and feeding
   * them back in would only ever prove the generator agrees with itself.
   */
  const CHECKOUT_SPAWN = [
    "mise",
    "exec",
    "--",
    "fnox",
    "exec",
    "--if-missing",
    "warn",
    "--",
    "pnpm",
    "--silent",
    "--filter",
    "@uberblick/mcp-server",
    "start",
  ];

  it("is what this command generates, rather than hand-maintained", () => {
    // It does not run `ub mcp serve` — a fresh checkout has no installed `ub`,
    // and the owner's secret only reaches it through `fnox exec` — so it is
    // generated with the `--` override instead.
    const committed = read(join(REPO_ROOT, ".mcp.json"));
    const entry = JSON.parse(committed).mcpServers.uberblick;
    expect([entry.command, ...entry.args]).toEqual(CHECKOUT_SPAWN);

    const box = sandbox();
    const run = runUb(
      ["mcp", "install", "claude", "--project", "--", ...CHECKOUT_SPAWN],
      box,
      NO_VENDOR,
    );
    expect(run.status).toBe(0);
    expect(read(join(box.cwd, ".mcp.json"))).toBe(committed);
  });
});

/**
 * `--workspace` — the one thing an entry is allowed to pin.
 *
 * The ids are the ones `workspace.test.ts` resolves against, so both commands
 * are held to the same fixtures: two share a prefix, one does not.
 */
describe("ub mcp install --workspace", () => {
  const WORKSPACE = "4d8e2f11-6a73-4c95-8b20-9e1f5c3a7d64";
  const OTHER = "4d8e0000-1111-4222-8333-444455556666";
  const UNRELATED = "b7c3d914-5a20-4e6f-8d13-9f04a2c68e75";

  /** A `<uuid>.sqlite` in the data directory: a workspace with a local replica. */
  function withDatabase(box: Sandbox, uuid: string): void {
    const dir = join(box.dataHome, "uberblick");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, `${uuid}.sqlite`), "", "utf8");
  }

  /** The entry every install has always written. */
  const UNPINNED = { type: "stdio", command: "ub", args: ["mcp", "serve"] };

  function servers(box: Sandbox): Record<string, unknown> {
    return JSON.parse(read(join(box.cwd, ".mcp.json"))).mcpServers;
  }

  function install(box: Sandbox, ...flags: string[]) {
    return runUb(["mcp", "install", "claude", "--project", ...flags], box, NO_VENDOR);
  }

  it("adds a named, pinned entry beside the primary one, and says what the pin costs", () => {
    const box = sandbox();
    expect(install(box).status).toBe(0);
    const before = read(join(box.cwd, ".mcp.json"));

    const run = install(box, "--workspace", WORKSPACE, "--name", "ablauf");
    expect(run.status).toBe(0);

    // The whole file, before and after: one entry arrived, and the primary is
    // exactly what it was — in value here, and byte for byte below.
    expect(JSON.parse(before).mcpServers).toEqual({ uberblick: UNPINNED });
    expect(servers(box)).toEqual({
      uberblick: UNPINNED,
      "uberblick-ablauf": { ...UNPINNED, env: { WORKSPACE_ID: WORKSPACE } },
    });
    expect(soleInsertion(before, read(join(box.cwd, ".mcp.json")))).not.toBeNull();

    // The pin is the one thing `ub` will not re-resolve at spawn, so the report
    // says so rather than leaving it to be discovered.
    expect(run.stdout).toContain("uberblick-ablauf");
    expect(run.stdout).toContain(`This entry is pinned to ${WORKSPACE}`);
    expect(run.stdout).toContain("does not follow `ub workspace use`");
  });

  it("writes today's unpinned entry byte-for-byte when nothing is pinned", () => {
    // Written out rather than generated: the flag must not have moved a single
    // byte of what every install without it has always produced.
    const box = sandbox();
    expect(install(box).status).toBe(0);
    expect(read(join(box.cwd, ".mcp.json"))).toBe(
      '{\n  "mcpServers": {\n    "uberblick": {\n      "type": "stdio",\n' +
        '      "command": "ub",\n      "args": [\n        "mcp",\n        "serve"\n' +
        "      ]\n    }\n  }\n}\n",
    );
  });

  it("stores a decorated id as typed, and resolves a prefix to the id it names", () => {
    const box = sandbox();
    withDatabase(box, WORKSPACE);
    withDatabase(box, OTHER);
    withDatabase(box, UNRELATED);

    // Decoration is kept whole — the slug is what makes a config readable, and
    // it is the name the entry takes when nobody says otherwise.
    const decorated = `ablauf-${WORKSPACE}`;
    expect(install(box, "--workspace", decorated).status).toBe(0);
    expect(servers(box)["uberblick-ablauf"]).toEqual({
      ...UNPINNED,
      env: { WORKSPACE_ID: decorated },
    });

    // A prefix is a way of typing an id, not an id: it is resolved, and a bare
    // uuid has no slug to name the entry with, so its first group stands in.
    expect(install(box, "--workspace", "b7c").status).toBe(0);
    expect(servers(box)[`uberblick-${UNRELATED.slice(0, 8)}`]).toEqual({
      ...UNPINNED,
      env: { WORKSPACE_ID: UNRELATED },
    });
  });

  it("refuses an unusable id with `ub workspace use`'s own messages, and writes nothing", () => {
    const box = sandbox();
    withDatabase(box, WORKSPACE);
    withDatabase(box, OTHER);

    // Ambiguous: both `4d8e…` uuids start with it, and the refusal names them.
    const ambiguous = install(box, "--workspace", "4d8e");
    expect(ambiguous.status).toBe(2);
    expect(ambiguous.stderr).toMatch(WORKSPACE);
    expect(ambiguous.stderr).toMatch(OTHER);

    const noMatch = install(box, "--workspace", "ffff");
    expect(noMatch.status).toBe(2);
    expect(noMatch.stderr).toMatch(/no workspace on this machine starts with/);

    const notAUuid = install(box, "--workspace", "my-notes");
    expect(notAUuid.status).toBe(2);
    expect(notAUuid.stderr).toMatch(/is not a workspace id/);

    // A name with nothing to pin would be a second entry running the same
    // unpinned command under a second name, which is not a thing to install.
    const unpinned = install(box, "--name", "ablauf");
    expect(unpinned.status).toBe(2);
    expect(unpinned.stderr).toMatch(/needs a --workspace/);

    expect(existsSync(join(box.cwd, ".mcp.json"))).toBe(false);
  });

  it("refuses somebody else's entry under the pinned name, and --force replaces only that one", () => {
    const box = sandbox();
    const path = join(box.cwd, ".mcp.json");
    const before =
      '{\n  "mcpServers": {\n' +
      '    "uberblick": {"command": "ub", "args": ["mcp", "serve"]},\n' +
      '    "uberblick-ablauf": {\n      "command": "somebody-elses",\n' +
      '      "args": ["serve"]\n    }\n  }\n}\n';
    writeFileSync(path, before, "utf8");

    const refused = install(box, "--workspace", WORKSPACE, "--name", "ablauf");
    expect(refused.status).toBe(1);
    // Named as the entry that is in the way, with both sides of the decision.
    expect(refused.stderr).toContain('"uberblick-ablauf"');
    expect(refused.stderr).toContain("somebody-elses");
    expect(refused.stderr).toMatch(/proposed/);
    expect(refused.stderr).toMatch(/--force/);
    expect(read(path)).toBe(before);

    const forced = install(box, "--workspace", WORKSPACE, "--name", "ablauf", "--force");
    expect(forced.status).toBe(0);
    const change = soleChange(before, read(path));
    expect(change.removed).toContain("somebody-elses");
    // The primary entry is nowhere near the span that changed.
    expect(change.removed).not.toContain('"command": "ub"');
    expect(read(path)).toContain('"uberblick": {"command": "ub", "args": ["mcp", "serve"]}');
  });

  it("does not repin an entry to another workspace without being asked", () => {
    // Same name, different workspace: the pin is the entry's whole reason to
    // exist, so moving it quietly would hand a session another corpus under a
    // name it already trusts.
    const box = sandbox();
    expect(install(box, "--workspace", WORKSPACE, "--name", "ablauf").status).toBe(0);
    const before = read(join(box.cwd, ".mcp.json"));

    const repin = install(box, "--workspace", UNRELATED, "--name", "ablauf");
    expect(repin.status).toBe(1);
    expect(repin.stderr).toMatch(/--force/);
    expect(read(join(box.cwd, ".mcp.json"))).toBe(before);
  });
});

describe("two entries, side by side", () => {
  const PRIMARY = "1e9b7a30-52c4-4d6f-8a13-c7b204e5f981";
  const PINNED = "8f21c604-3b7d-4a15-9c62-0d5e8b3f7a29";

  /** The environment a spawn wants: strings only, no undefined values. */
  function stringEnv(env: NodeJS.ProcessEnv): Record<string, string> {
    const result: Record<string, string> = {};
    for (const [key, value] of Object.entries(env)) {
      if (value !== undefined) {
        result[key] = value;
      }
    }
    return result;
  }

  interface Registered {
    command: string;
    args: string[];
    env?: Record<string, string>;
  }

  /** A session spawned exactly as the entry in the config says to spawn it. */
  async function open(entry: Registered, box: Sandbox): Promise<Client> {
    const client = new Client({ name: "uberblick-install-tests", version: "0.0.0" });
    await client.connect(
      new StdioClientTransport({
        command: entry.command,
        args: entry.args,
        cwd: box.cwd,
        env: stringEnv({ ...box.env, ...entry.env }),
      }),
    );
    return client;
  }

  /** One tool call, as the JSON the tool answered with. */
  async function call<T>(
    client: Client,
    name: string,
    args: Record<string, unknown>,
  ): Promise<T> {
    const result = await client.callTool({ name, arguments: args });
    const content = result.content as { text: string }[];
    return JSON.parse((content[0] as { text: string }).text) as T;
  }

  interface Listing {
    workspace: string;
    docs: { title: string }[];
  }

  it("serve disjoint corpora out of one data directory", async () => {
    const box = sandbox({ userConfig: { workspace: PRIMARY } });
    // Both entries have to spawn *this* checkout's `ub`, which is not on any
    // PATH, so both are installed through the `--` override. Everything else —
    // the names, the pin, the file — is what `ub mcp install` decided.
    const spawnLine = [process.execPath, UB_BIN, "mcp", "serve"];
    expect(
      runUb(["mcp", "install", "claude", "--project", "--", ...spawnLine], box, NO_VENDOR)
        .status,
    ).toBe(0);
    expect(
      runUb(
        [
          "mcp",
          "install",
          "claude",
          "--project",
          "--workspace",
          PINNED,
          "--name",
          "other",
          "--",
          ...spawnLine,
        ],
        box,
        NO_VENDOR,
      ).status,
    ).toBe(0);

    const registered = JSON.parse(read(join(box.cwd, ".mcp.json"))).mcpServers;
    const primary = await open(registered.uberblick, box);
    const pinned = await open(registered["uberblick-other"], box);
    try {
      const description = "A test document.";
      await call(primary, "create_doc", {
        title: "only in the primary",
        description,
      });
      await call(pinned, "create_doc", {
        title: "only in the pinned one",
        description,
      });

      const here = await call<Listing>(primary, "list_docs", {});
      const there = await call<Listing>(pinned, "list_docs", {});

      // Two workspaces, two corpora: the pinned entry ignores the workspace the
      // directory configures, and neither can see the other's document.
      expect(here.workspace).toBe(PRIMARY);
      expect(there.workspace).toBe(PINNED);
      expect(here.docs.map((doc) => doc.title)).toEqual(["only in the primary"]);
      expect(there.docs.map((doc) => doc.title)).toEqual(["only in the pinned one"]);
    } finally {
      await primary.close();
      await pinned.close();
    }
  });
});

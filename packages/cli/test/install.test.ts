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
import { afterAll, describe, expect, it } from "vitest";
import { openConfig, verifyUnchanged } from "../src/install.js";
import { REPO_ROOT, type Sandbox, removeTempDirs, runUb, sandbox } from "./helpers.js";

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

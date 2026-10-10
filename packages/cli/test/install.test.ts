/**
 * What `ub mcp install` promises.
 *
 * It edits no configuration file. Claude Code and Codex are wired up by running
 * their own `mcp add`; every other client gets a snippet and the path to paste
 * it into. So the contracts under test are the ones that are left: the right
 * delegation — the right program, the right arguments, the right configuration
 * directory — an entry somebody else wrote is never replaced and never quoted
 * back, a second run is a no-op, and no credential of this machine's ever
 * reaches a stream. Nothing here prompts: every one of these runs with no
 * terminal attached, which is the point of the flags.
 *
 * The vendor CLIs are stubbed rather than invoked. What `ub` owes is the right
 * delegation, and asserting that against a real `claude` would make the suite
 * depend on the machine it runs on.
 */

import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { afterAll, describe, expect, it } from "vitest";
import { doctorEntry } from "../src/mcp-config.js";
import {
  type Sandbox,
  type SandboxFiles,
  UB_BIN,
  removeTempDirs,
  runUb,
  sandbox as boundSandbox,
  unboundSandbox,
} from "./helpers.js";

afterAll(removeTempDirs);

/** A PATH with nothing on it, so every vendor CLI lookup fails with ENOENT. */
const NO_VENDOR = { PATH: "/nonexistent-for-tests" };

/** Where a stub records the arguments it was called with. */
const RECORD = "UB_TEST_VENDOR_RECORD";

/**
 * The variables a stub reports on — and it reports presence only, never a
 * value. A vendor child inherits nearly the whole environment, so a stub that
 * dumped it would write this machine's real secrets into a temp file merely to
 * prove that six of them are absent. `RECORD` leads the list as the positive
 * control: it is always set, so a recording of nothing but `absent` cannot
 * pass for an answer.
 */
const REPORTED = [
  RECORD,
  "HUB_AUTH_TOKEN",
  "HUB_URL",
  "UB_WORKSPACE_ID",
  "UB_HUB_URL",
  "HUB_DB_PATH",
  "UBERBLICK_DB",
  "WORKSPACE_ID",
  "WORKSPACES",
  "CODEX_HOME",
];

/**
 * A value that must never reach a terminal. Config files are where people keep
 * tokens, and every path that reports on one has to be safe for that.
 */
const SECRET = "tok-must-never-be-printed-4a1f";

const WORKSPACE = "4d8e2f11-6a73-4c95-8b20-9e1f5c3a7d64";
const LOCAL_BINDING_ENV = { UB_HUB_URL: "local", UB_WORKSPACE_ID: WORKSPACE };

/** These installer cases start with a deliberately selected project binding. */
function sandbox(files: SandboxFiles = {}): Sandbox {
  return boundSandbox({
    ...files,
    projectBinding: { workspaceId: WORKSPACE, hubUrl: null },
  });
}


interface Stub {
  /** Prepend to PATH, and the environment that points the stub at its record. */
  env: NodeJS.ProcessEnv;
  /** The arguments the stub was called with, one per line. */
  record: string;
  /** `CODEX_HOME` as the stub saw it. */
  home: string;
  /** `NAME=present` or `NAME=absent`, one line per reported variable. */
  environment: string;
}

function stubVendor(box: Sandbox, program: string, body = ""): Stub {
  const dir = join(box.cwd, "..", `stub-${program}`);
  mkdirSync(dir, { recursive: true });
  const path = join(dir, program);
  const record = join(dir, "record");
  // One `${NAME+present}` per reported variable rather than a dump of the
  // environment: sh has no indirect expansion, and nothing here may write a
  // value anyway. PATH is the stub's own directory alone, so only builtins run.
  const report = REPORTED.map(
    (name) =>
      `seen=\${${name}+present}\nprintf '${name}=%s\\n' "\${seen:-absent}"`,
  ).join("\n");
  writeFileSync(
    path,
    `#!/bin/sh\nprintf '%s\\n' "$@" > "$${RECORD}"\n` +
      `printf '%s\\n' "$CODEX_HOME" > "$${RECORD}.home"\n` +
      `{\n${report}\n} > "$${RECORD}.env"\n${body}`,
    "utf8",
  );
  chmodSync(path, 0o755);
  return {
    env: { PATH: dir, [RECORD]: record },
    record,
    home: `${record}.home`,
    environment: `${record}.env`,
  };
}

function read(path: string): string {
  return readFileSync(path, "utf8");
}

/** A Codex configuration directory of this sandbox's own, never the machine's. */
function codexHome(box: Sandbox, at = join(box.cwd, "codex-home")): string {
  mkdirSync(at, { recursive: true });
  return at;
}

/** The whole stdout contract for a registration that falls back to pasting. */
function entrySnippet(program: string): string {
  return program === "codex"
    ? '[mcp_servers.uberblick]\ncommand = "ub"\nargs = ["mcp", "serve"]\n'
    : `${JSON.stringify({ mcpServers: {
      uberblick: { type: "stdio", command: "ub", args: ["mcp", "serve"] },
    } }, null, 2)}\n`;
}

describe("ub mcp install --print", () => {
  it("prints a snippet for the named target and touches no file", () => {
    const box = sandbox();

    const claude = runUb(["mcp", "install", "claude", "--project", "--print"], box);
    expect(claude.status).toBe(0);
    expect(JSON.parse(claude.stdout).mcpServers.uberblick).toEqual({
      type: "stdio",
      command: "ub",
      args: ["mcp", "serve"],
    });
    expect(claude.stderr).toContain(join(box.cwd, ".mcp.json"));
    expect(existsSync(join(box.cwd, ".mcp.json"))).toBe(false);

    // Codex's file is TOML, so the snippet has to be TOML — a JSON snippet
    // would be a valid-looking answer that silently does not work.
    const codex = runUb(["mcp", "install", "codex", "--user", "--print"], box, {
      CODEX_HOME: codexHome(box),
    });
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

describe("ub mcp install, and the vendor's own CLI", () => {
  /**
   * The exact delegation, per target and scope.
   *
   * Written out rather than generated: these argument lists are the vendors'
   * documented syntax as their installed CLIs actually take it. Every scope
   * registers the same plain entry, without recording the installing shell.
   */
  const CELLS: {
    what: string;
    program: string;
    argv: string[];
    expected: string[];
    file: (box: Sandbox, home: string) => string;
  }[] = [
    {
      what: "claude, project",
      program: "claude",
      argv: ["mcp", "install", "claude", "--project"],
      file: (box) => join(box.cwd, ".mcp.json"),
      expected: [
        "mcp",
        "add",
        "uberblick",
        "--scope",
        "project",
        "--",
        "ub",
        "mcp",
        "serve",
      ],
    },
    {
      what: "claude, user",
      program: "claude",
      argv: ["mcp", "install", "claude", "--user"],
      file: (box) => join(box.env.HOME as string, ".claude.json"),
      expected: ["mcp", "add", "uberblick", "--scope", "user", "--", "ub", "mcp", "serve"],
    },
    {
      what: "codex, project",
      program: "codex",
      argv: ["mcp", "install", "codex", "--project"],
      file: (box) => join(box.cwd, ".codex", "config.toml"),
      expected: [
        "mcp",
        "add",
        "uberblick",
        "--",
        "ub",
        "mcp",
        "serve",
      ],
    },
    {
      what: "codex, user",
      program: "codex",
      argv: ["mcp", "install", "codex", "--user"],
      file: (_box, home) => join(home, "config.toml"),
      expected: ["mcp", "add", "uberblick", "--", "ub", "mcp", "serve"],
    },
  ];

  it.each(CELLS)("delegates $what", ({ program, argv, expected }) => {
    const box = sandbox();
    const stub = stubVendor(box, program);
    const run = runUb(argv, box, {
      ...stub.env,
      CODEX_HOME: codexHome(box),
      UB_WORKSPACE_ID: "invalid-ambient-workspace",
      UB_HUB_URL: "invalid-ambient-hub",
      WORKSPACE_ID: WORKSPACE,
      HUB_URL: "wss://legacy.example.test/ws",
    });

    expect(run.status, run.output).toBe(0);
    expect(run.stdout).toMatch(new RegExp(`ran\\s+${program} mcp add`));
    expect(run.output).not.toMatch(/pin/i);
    expect(read(stub.record).trimEnd().split("\n")).toEqual(expected);
    // The vendor writes the file; `ub` must not also write one behind its back.
    expect(existsSync(join(box.cwd, ".mcp.json"))).toBe(false);
  });

  it("points codex at the configuration directory the scope means", () => {
    // `codex mcp add` has no scope flag: which file it writes *is* CODEX_HOME,
    // so project scope has to hand it the checkout's own directory — the same
    // one this command then reports and probes.
    const box = sandbox();
    const stub = stubVendor(box, "codex");
    const run = runUb(["mcp", "install", "codex", "--project"], box, {
      ...stub.env,
      CODEX_HOME: codexHome(box),
    });

    expect(run.status, run.output).toBe(0);
    expect(realpathSync(read(stub.home).trim())).toBe(
      realpathSync(join(box.cwd, ".codex")),
    );
    expect(run.stdout).toContain(join(".codex", "config.toml"));
  });

  it("reports the command, target, project file and restart after registration", () => {
    const box = sandbox();
    const stub = stubVendor(box, "claude");
    const run = runUb(
      ["mcp", "install", "claude", "--project"],
      box,
      stub.env,
    );

    expect(run.status, run.output).toBe(0);
    expect(run.stdout).toMatch(/^ran\s+claude mcp add uberblick --scope project -- ub mcp serve$/m);
    expect(run.stdout).toContain(join(box.cwd, ".mcp.json"));
    expect(run.stdout).toMatch(/^workspace\s+follows /m);
    expect(run.stdout).toContain(join(box.cwd, ".uberblick.json"));
    expect(run.stdout).toMatch(/restart running agents.*pick.*up/i);
    expect(run.output).not.toMatch(/pin/i);
  });

  it.each(CELLS)("prints the entry for a failed $what without repeating its output", ({ program, argv, file }) => {
    // A client's own diagnostics quote the config it just read, so relaying
    // them would walk straight past everything this command refuses to print.
    const box = sandbox();
    const home = codexHome(box);
    const stub = stubVendor(
      box,
      program,
      `echo "conflict in config: API_TOKEN=${SECRET}" >&2\necho "${SECRET}"\nexit 1\n`,
    );

    const run = runUb(argv, box, { ...stub.env, CODEX_HOME: home });
    expect(run.status).toBe(1);
    expect(run.stdout).toBe(entrySnippet(program));
    expect(run.output).not.toContain(SECRET);
    // Enough to act on: which program, how it ended, and where to look.
    expect(run.stderr).toContain(`${program} mcp add`);
    expect(run.stderr).toMatch(/exited 1/);
    expect(run.stderr).toContain(file(box, home));
    expect(existsSync(file(box, home))).toBe(false);
    expect(existsSync(join(box.cwd, ".codex"))).toBe(false);
  });

  it.each(["claude", "codex"])("prints the entry when %s mcp add is killed by a signal", (program) => {
    const box = sandbox();
    const stub = stubVendor(
      box,
      program,
      `echo "${SECRET}" >&2\necho "${SECRET}"\nkill -TERM $$\n`,
    );
    const run = runUb(["mcp", "install", program, "--project"], box, stub.env);

    expect(run.status).toBe(1);
    expect(run.stdout).toBe(entrySnippet(program));
    expect(run.output).not.toContain(SECRET);
    expect(run.stderr).toContain(`${program} mcp add`);
    expect(run.stderr).toMatch(/killed by SIGTERM/);
    expect(run.stderr).toContain(program === "codex"
      ? join(box.cwd, ".codex", "config.toml")
      : join(box.cwd, ".mcp.json"));
    expect(existsSync(join(box.cwd, ".codex"))).toBe(false);
  });

  it.each(["claude", "codex"])("prints the entry when %s mcp add cannot start", (program) => {
    const box = sandbox();
    const stub = stubVendor(box, program);
    // A non-executable file on PATH is distinct from a missing program.
    chmodSync(join(stub.env.PATH as string, program), 0o644);
    const run = runUb(["mcp", "install", program, "--project"], box, stub.env);

    expect(run.status).toBe(1);
    expect(run.stdout).toBe(entrySnippet(program));
    expect(run.stderr).toContain(`${program} mcp add`);
    expect(run.stderr).toMatch(/could not be started \(EACCES\)/);
    expect(run.stderr).toContain(program === "codex"
      ? join(box.cwd, ".codex", "config.toml")
      : join(box.cwd, ".mcp.json"));
    expect(existsSync(stub.record)).toBe(false);
    expect(existsSync(join(box.cwd, ".codex"))).toBe(false);
  });

  it("hands the vendor no variable of uberblick's own", () => {
    // `ub` is habitually run with a signing secret and an endpoint exported —
    // that is exactly what `fnox exec` does — and a child inherits whatever it
    // is handed. A vendor CLI has no use for either, and a client that records
    // its environment would be keeping this machine's credential in its own
    // format. No workspace selectors belong in either argv or the environment.
    const box = sandbox();
    const stub = stubVendor(box, "claude");
    const ours: NodeJS.ProcessEnv = {
      HUB_AUTH_TOKEN: SECRET,
      HUB_URL: "wss://hub.example.ts.net",
      HUB_DB_PATH: "/tmp/hub.sqlite",
      UBERBLICK_DB: "/tmp/uberblick.sqlite",
      WORKSPACE_ID: WORKSPACE,
      ...LOCAL_BINDING_ENV,
      WORKSPACES: "one,two",
    };

    const run = runUb(["mcp", "install", "claude", "--project"], box, {
      ...stub.env,
      ...ours,
    });

    expect(run.status, run.output).toBe(0);
    // The stub reports presence, not values, so this file is safe to write on
    // a real machine. `RECORD` is the positive control: it is always set, so
    // the absences below are about what was stripped, not about an empty
    // recording.
    const received = read(stub.environment);
    expect(received).toMatch(new RegExp(`^${RECORD}=present$`, "m"));
    for (const name of Object.keys(ours)) {
      expect(received, name).toMatch(new RegExp(`^${name}=absent$`, "m"));
    }
    expect(received).not.toContain(SECRET);
  });

  it.each(CELLS)("prints the entry for missing $what and leaves nothing behind", ({ program, argv, file }) => {
    const box = sandbox();
    const home = codexHome(box);
    const run = runUb(argv, box, { ...NO_VENDOR, CODEX_HOME: home });
    expect(run.status).toBe(1);
    expect(run.stdout).toBe(entrySnippet(program));
    expect(run.stderr).toContain(`\`${program}\` is not installed`);
    expect(run.stderr).toContain(file(box, home));
    expect(existsSync(file(box, home))).toBe(false);

    // Codex refuses a CODEX_HOME that is not there, so project scope creates
    // one — and a run that ended in a snippet must not leave it in a checkout.
    expect(existsSync(join(box.cwd, ".codex"))).toBe(false);
  });

  it.each(["missing", "failed"])("leaves a `.codex` it did not create when the vendor is %s", (ending) => {
    // "Writes nothing" has to include taking nothing away. An empty `.codex` a
    // checkout already had is still somebody's state — and whether this run is
    // the one that made the directory is the only thing that decides it.
    const box = sandbox();
    const dir = join(box.cwd, ".codex");
    mkdirSync(dir, { recursive: true });

    const env = ending === "missing" ? NO_VENDOR : stubVendor(box, "codex", "exit 1\n").env;
    const run = runUb(["mcp", "install", "codex", "--project"], box, env);
    expect(run.status, run.output).toBe(1);
    expect(run.stdout).toBe(entrySnippet("codex"));
    expect(existsSync(dir)).toBe(true);
  });
});

describe("ub mcp install, and what is registered already", () => {
  it.each([undefined, {}])("recognises a plain entry with env %j and runs nothing", (env) => {
    // Claude's vendor-generated plain entry can include an empty env object.
    const box = sandbox();
    const path = join(box.cwd, ".mcp.json");
    const before = `${JSON.stringify(
      {
        mcpServers: {
          uberblick: { type: "stdio", command: "ub", args: ["mcp", "serve"], env },
        },
      },
      null,
      2,
    )}\n`;
    writeFileSync(path, before, "utf8");
    const stub = stubVendor(box, "claude");

    const run = runUb(["mcp", "install", "claude", "--project"], box, {
      ...stub.env,
      UB_WORKSPACE_ID: "invalid-ambient-workspace",
      UB_HUB_URL: "invalid-ambient-hub",
    });
    expect(run.status).toBe(0);
    expect(run.stdout).toMatch(/already installed/);
    expect(run.stdout).toMatch(/^client\s+claude \(project\)$/m);
    expect(run.stdout).toMatch(/^workspace\s+follows /m);
    expect(run.stdout).toContain(join(box.cwd, ".uberblick.json"));
    expect(run.stdout).not.toMatch(/^ran\s+/m);
    expect(run.output).not.toMatch(/pin/i);
    expect(read(path)).toBe(before);
    // Not "it exited 0": the vendor was never asked, so a duplicate add cannot
    // fail and a foreign entry cannot be clobbered by one.
    expect(existsSync(stub.record)).toBe(false);
  });

  it.each([
    {
      what: "the vendor header beside multiline and large-integer settings",
      before: 'model = "gpt-5"\n' + entrySnippet("codex") +
        '[other]\ninstructions = """\nUnrelated multiline setting.\n"""\n' +
        'large_integer = 9007199254740993\n',
    },
    {
      what: "a spaced header with quoted and escaped keys",
      before: '[ "mcp_servers" . "\\u0075berblick" ] # plain entry\n' +
        'args = [\'mcp\', \'serve\',]\ncommand = "ub"\n',
    },
    {
      what: "an inline server with empty inline env",
      before: '[mcp_servers]\nuberblick = { command = "ub", ' +
        'args = ["mcp", "serve"], env = {} }\n',
    },
    {
      what: "a root inline server table",
      before: 'mcp_servers = { uberblick = { command = "ub", args = ["mcp", "serve"] } }\n',
    },
    {
      what: "dotted server keys",
      before: 'mcp_servers."uberblick".command = "ub"\n' +
        'mcp_servers.uberblick.args = ["mcp", "serve"]\n',
    },
    { what: "empty inline env", before: entrySnippet("codex") + 'env = {}\n' },
    {
      what: "an empty env subtable separated by another table",
      before: entrySnippet("codex") + '[other]\nenabled = true\n[mcp_servers.uberblick.env]\n',
    },
  ])("recognises the plain Codex entry from $what and runs nothing", ({ before }) => {
    const box = sandbox();
    const home = codexHome(box);
    const path = join(home, "config.toml");
    writeFileSync(path, before, "utf8");
    expect(doctorEntry({ path, format: "toml" })).toEqual({ status: "entry", env: {} });
    const stub = stubVendor(box, "codex");

    const run = runUb(
      ["mcp", "install", "codex", "--user"],
      box,
      { ...stub.env, CODEX_HOME: home },
    );
    expect(run.status, run.output).toBe(0);
    expect(run.stdout).toMatch(/already installed/);
    expect(run.stdout).toMatch(/workspace\s+follows .*nearest \.uberblick\.json.*each project/i);
    expect(run.stdout).not.toMatch(/^ran\s+/m);
    expect(run.output).not.toMatch(/pin/i);
    expect(read(path)).toBe(before);
    expect(existsSync(stub.record)).toBe(false);
  });

  it("protects a differing Codex entry under a quoted and spaced header", () => {
    // Alternate TOML spelling must not hide somebody else's command or env
    // from the protection against a duplicate add replacing their entry.
    const box = sandbox();
    const home = codexHome(box);
    const path = join(home, "config.toml");
    const before =
      '[ mcp_servers."uberblick" ] # theirs\ncommand = "somebody-elses"\n' +
      `args = ["serve"]\n\n[mcp_servers."uberblick".env]\nAPI_TOKEN = "${SECRET}"\n`;
    writeFileSync(path, before, "utf8");
    const stub = stubVendor(box, "codex");

    const run = runUb(["mcp", "install", "codex", "--user"], box, {
      ...stub.env,
      CODEX_HOME: home,
    });
    expect(run.status).toBe(1);
    expect(run.stderr).toMatch(/something other than this/);
    expect(run.output).not.toContain(SECRET);
    expect(run.output).not.toContain("somebody-elses");
    expect(read(path)).toBe(before);
    expect(existsSync(stub.record)).toBe(false);
  });

  /**
   * Differing entries without a server header. TOML spells one key several
   * ways, and each of these defines `mcp_servers.uberblick` —
   * so reading any of them as "nothing there" would point `codex mcp add` at
   * somebody's entry and let its duplicate add replace it.
   */
  const UNHEADED = [
    {
      what: "an inline table under `[mcp_servers]`",
      before:
        '[mcp_servers]\nuberblick = { command = "somebody-elses", args = ["serve"], ' +
        `env = { API_TOKEN = "${SECRET}" } }\n`,
    },
    {
      what: "dotted keys at the root",
      before:
        'model = "gpt-5"\nmcp_servers.uberblick.command = "somebody-elses"\n' +
        `mcp_servers.uberblick.args = ["serve"]\nmcp_servers.uberblick.env.API_TOKEN = "${SECRET}"\n`,
    },
    {
      what: "a bare `env` sub-table",
      before: `[mcp_servers.uberblick.env]\nAPI_TOKEN = "${SECRET}"\n`,
    },
  ];

  it.each(UNHEADED)("refuses $what", ({ before }) => {
    const box = sandbox();
    const home = codexHome(box);
    const path = join(home, "config.toml");
    writeFileSync(path, before, "utf8");
    const stub = stubVendor(box, "codex");

    const run = runUb(["mcp", "install", "codex", "--user"], box, {
      ...stub.env,
      CODEX_HOME: home,
    });
    expect(run.status).toBe(1);
    expect(run.stderr).toMatch(/something other than this/);
    expect(run.output).not.toContain(SECRET);
    expect(read(path)).toBe(before);
    expect(existsSync(stub.record)).toBe(false);
  });

  it.each([
    { what: "another command", text: entrySnippet("codex").replace('command = "ub"', `command = "${SECRET}"`) },
    { what: "other arguments", text: entrySnippet("codex").replace('["mcp", "serve"]', `["${SECRET}"]`) },
    { what: "a binding env override", text: entrySnippet("codex") + `env = { UB_WORKSPACE_ID = "${WORKSPACE}" }\n` },
    { what: "an inline env variable", text: entrySnippet("codex") + `env = { API_TOKEN = "${SECRET}" }\n` },
    { what: "a dotted env variable", text: entrySnippet("codex") + `env.API_TOKEN = "${SECRET}"\n` },
    { what: "an unknown key", text: entrySnippet("codex") + `cwd = "${SECRET}"\n` },
    { what: "a JSON-only type key", text: entrySnippet("codex") + 'type = "stdio"\n' },
    ...[`"${SECRET}"`, `["${SECRET}"]`, "1", "true", "1979-05-27", "07:32:00"].map((value) => ({
      what: `non-table env ${value}`, text: entrySnippet("codex") + `env = ${value}\n`,
    })),
    ...[`"${SECRET}"`, "[]", "1979-05-27", "07:32:00"].map((value) => ({
      what: `non-table server ${value}`, text: `[mcp_servers]\nuberblick = ${value}\n`,
    })),
  ])("protects Codex config with $what", ({ text }) => {
    const box = sandbox();
    const home = codexHome(box);
    const path = join(home, "config.toml");
    const before = `private_token = "${SECRET}"\n${text}`;
    writeFileSync(path, before);
    const stub = stubVendor(box, "codex");
    const run = runUb(["mcp", "install", "codex", "--user"], box, { ...stub.env, CODEX_HOME: home });
    expect(run.status, run.output).toBe(1);
    expect(run.stderr).toMatch(/something other than this/);
    expect(run.stdout).toBe(entrySnippet("codex"));
    expect(run.output).not.toContain(SECRET);
    expect(run.output).not.toContain("private_token");
    expect(read(path)).toBe(before);
    expect(existsSync(stub.record)).toBe(false);
  });

  it.each([
    { what: "malformed config with no entry", text: `token = "unterminated ${SECRET}\n` },
    { what: "a plain entry followed by malformed settings", text: entrySnippet("codex") + `[other]\nunparseable ${SECRET}\n` },
    { what: "duplicate server tables", text: entrySnippet("codex") + `[mcp_servers.uberblick]\ncommand = "${SECRET}"\n` },
    { what: "duplicate server keys", text: entrySnippet("codex") + `command = "${SECRET}"\n` },
    ...[`"${SECRET}"`, "[]", "1979-05-27", "07:32:00"].map((value) => ({
      what: `non-table mcp_servers ${value}`, text: `mcp_servers = ${value}\n`,
    })),
  ])("refuses unusable Codex config with $what without quoting it", ({ text }) => {
    const box = sandbox();
    const home = codexHome(box);
    const path = join(home, "config.toml");
    const before = `private_token = "${SECRET}"\n${text}`;
    writeFileSync(path, before);
    expect(doctorEntry({ path, format: "toml" })).toEqual({ status: "unusable" });
    const stub = stubVendor(box, "codex");
    const run = runUb(["mcp", "install", "codex", "--user"], box, { ...stub.env, CODEX_HOME: home });
    expect(run.status, run.output).toBe(1);
    expect(run.stderr).toContain(path);
    expect(run.stderr).toMatch(/could not be read/);
    expect(run.stdout).toBe(entrySnippet("codex"));
    expect(run.output).not.toContain(SECRET);
    expect(run.output).not.toContain("private_token");
    expect(read(path)).toBe(before);
    expect(existsSync(stub.record)).toBe(false);
  });

  it("adds Codex's absent entry despite an apparent header inside unrelated multiline settings", () => {
    const box = sandbox();
    const home = codexHome(box);
    const path = join(home, "config.toml");
    const before = 'large_integer = 9007199254740993\n[other]\ninstructions = """\n' +
      `[mcp_servers.uberblick]\ncommand = "${SECRET}"\n"""\n`;
    writeFileSync(path, before);
    expect(doctorEntry({ path, format: "toml" })).toEqual({ status: "absent" });
    const stub = stubVendor(box, "codex");
    const run = runUb(["mcp", "install", "codex", "--user"], box, { ...stub.env, CODEX_HOME: home });
    expect(run.status, run.output).toBe(0);
    expect(read(stub.record).trimEnd().split("\n")).toEqual([
      "mcp", "add", "uberblick", "--", "ub", "mcp", "serve",
    ]);
    expect(run.output).not.toContain(SECRET);
    expect(read(path)).toBe(before);
  });

  it("refuses an entry it did not write, prints the snippet, and quotes nothing", () => {
    const box = sandbox();
    const path = join(box.cwd, ".mcp.json");
    const before = `${JSON.stringify(
      {
        mcpServers: {
          other: { command: "other-server" },
          uberblick: {
            command: "somebody-elses",
            args: ["serve"],
            env: { API_TOKEN: SECRET },
          },
        },
      },
      null,
      2,
    )}\n`;
    writeFileSync(path, before, "utf8");
    const stub = stubVendor(box, "claude");

    const run = runUb(["mcp", "install", "claude", "--project"], box, stub.env);
    expect(run.status).toBe(1);
    expect(run.stderr).toContain(path);
    expect(run.stderr).toMatch(
      /already registers "uberblick" as something other than this/,
    );
    // The way out is the snippet, and nothing out of their file comes with it:
    // not the command it runs, and certainly not what it sets.
    expect(JSON.parse(run.stdout).mcpServers.uberblick.command).toBe("ub");
    expect(run.output).not.toContain(SECRET);
    expect(run.output).not.toContain("somebody-elses");
    // Byte-identical afterwards, and the vendor was never given the chance.
    expect(read(path)).toBe(before);
    expect(existsSync(stub.record)).toBe(false);
  });

  it("refuses a target file it cannot read, rather than delegating over it", () => {
    // Reading this as "absent" would mean "go ahead" — and going ahead points
    // `claude mcp add` at a file this could not read, which it loads and
    // rewrites. Nothing of it comes back out, not even a parser's complaint.
    const box = sandbox();
    const path = join(box.cwd, ".mcp.json");
    const before = `{ "mcpServers": { "uberblick": { "token": "${SECRET}"\n`;
    writeFileSync(path, before, "utf8");
    const stub = stubVendor(box, "claude");

    const run = runUb(["mcp", "install", "claude", "--project"], box, stub.env);
    expect(run.status).toBe(1);
    expect(run.stderr).toContain(path);
    expect(run.stderr).toMatch(/could not be read/);
    expect(run.output).not.toContain(SECRET);
    // The way out is the same snippet, and the file is untouched.
    expect(JSON.parse(run.stdout).mcpServers.uberblick.command).toBe("ub");
    expect(read(path)).toBe(before);
    expect(existsSync(stub.record)).toBe(false);
  });

  it("does not call an entry ours when its `env` is not an environment", () => {
    // `null`, `[]`, `""`, a number: all of them have no entries to compare, and
    // an entry whose environment this cannot read is not one it understands.
    const box = sandbox();
    const path = join(box.cwd, ".mcp.json");
    const before = `${JSON.stringify(
      {
        mcpServers: {
          uberblick: { command: "ub", args: ["mcp", "serve"], env: null },
        },
      },
      null,
      2,
    )}\n`;
    writeFileSync(path, before, "utf8");
    const stub = stubVendor(box, "claude");

    const run = runUb(["mcp", "install", "claude", "--project"], box, stub.env);
    expect(run.status).toBe(1);
    expect(run.stderr).toMatch(/something other than this/);
    expect(read(path)).toBe(before);
    expect(existsSync(stub.record)).toBe(false);
  });
});

describe("ub mcp install cursor", () => {
  it("prints the snippet and the file to paste it into, and writes nothing", () => {
    // Cursor ships no `mcp add`, so there is nothing to delegate to — and a
    // client `ub` cannot drive is told about rather than written to.
    const box = sandbox();
    const run = runUb(["mcp", "install", "cursor", "--project"], box);

    expect(run.status).toBe(0);
    expect(run.stderr).toContain(join(box.cwd, ".cursor", "mcp.json"));
    expect(JSON.parse(run.stdout).mcpServers.uberblick).toEqual({
      type: "stdio",
      command: "ub",
      args: ["mcp", "serve"],
    });
    expect(existsSync(join(box.cwd, ".cursor"))).toBe(false);
  });

  it("recognises an existing plain entry with empty env without running anything", () => {
    const box = sandbox();
    const dir = join(box.cwd, ".cursor");
    mkdirSync(dir, { recursive: true });
    const path = join(dir, "mcp.json");
    const before = JSON.stringify({ mcpServers: {
      uberblick: { command: "ub", args: ["mcp", "serve"], env: {} },
    } });
    writeFileSync(path, before);
    const run = runUb(["mcp", "install", "cursor", "--project"], box);

    expect(run.status, run.output).toBe(0);
    expect(run.stdout).toMatch(/already installed/);
    expect(run.stdout).toContain(path);
    expect(run.stdout).toMatch(/^workspace\s+follows /m);
    expect(run.stdout).toContain(join(box.cwd, ".uberblick.json"));
    expect(run.stdout).not.toMatch(/^ran\s+/m);
    expect(read(path)).toBe(before);
  });

  it("protects an existing entry with nonempty env and prints the plain snippet", () => {
    const box = sandbox();
    const dir = join(box.cwd, ".cursor");
    mkdirSync(dir, { recursive: true });
    const path = join(dir, "mcp.json");
    const before = JSON.stringify({ mcpServers: {
      uberblick: { command: "ub", args: ["mcp", "serve"], env: LOCAL_BINDING_ENV },
    } });
    writeFileSync(path, before);
    const run = runUb(["mcp", "install", "cursor", "--project"], box);

    expect(run.status).toBe(1);
    expect(run.stderr).toContain(path);
    expect(run.stderr).toMatch(/something other than this/);
    expect(JSON.parse(run.stdout)).toEqual({ mcpServers: {
      uberblick: { type: "stdio", command: "ub", args: ["mcp", "serve"] },
    } });
    expect(read(path)).toBe(before);
  });
});

describe("ub mcp install rejects removed arguments", () => {
  const REMOVED = [
    ["codex", "--workspace", WORKSPACE],
    ["codex", "--hub", "local"],
    ["codex", "--label", "research"],
    ["codex", "--workspace"],
    ["codex", "--hub"],
    ["codex", "--label"],
    ["codex", "--"],
    ["codex", "--", "ub", "mcp", "serve"],
    ["--print", "--"],
    ["--print", "--", "foo"],
  ];

  it.each(REMOVED)("refuses %j before running a client or writing anything", (...args) => {
    const box = sandbox();
    const stub = stubVendor(box, "codex");
    const bindingPath = join(box.cwd, ".uberblick.json");
    const bindingBefore = read(bindingPath);
    const root = join(box.cwd, "..");
    const filesBefore = readdirSync(root, { recursive: true }).sort();

    const run = runUb(["mcp", "install", ...args], box, stub.env);

    expect(run.status, run.output).toBe(2);
    expect(run.stdout).toBe("");
    expect(run.stderr).not.toBe("");
    expect(existsSync(stub.record)).toBe(false);
    expect(readdirSync(root, { recursive: true }).sort()).toEqual(filesBefore);
    expect(read(bindingPath)).toBe(bindingBefore);
    expect(existsSync(join(box.cwd, ".codex"))).toBe(false);
  });
});

describe("binding-independent MCP registration", () => {
  const OTHER = "5cb9a7a5-3cc0-4cdb-bd20-fd348fbf1311";
  const AMBIENT: NodeJS.ProcessEnv[] = [
    {},
    { UB_WORKSPACE_ID: OTHER },
    { UB_HUB_URL: "https://shell.example.test" },
    { UB_WORKSPACE_ID: OTHER, UB_HUB_URL: "invalid-hub" },
    { UB_WORKSPACE_ID: "", UB_HUB_URL: "" },
    { WORKSPACE_ID: OTHER, HUB_URL: "https://legacy.example.test", WORKSPACES: "one,two" },
  ];

  it.each(AMBIENT)("prints only the plain entry with shell selectors %j", (env) => {
    const box = sandbox({ credentials: { signingSecret: SECRET } });
    const bindingPath = join(box.cwd, ".uberblick.json");
    const before = read(bindingPath);
    for (const target of ["claude", "cursor", "codex"]) {
      const run = runUb(["mcp", "install", target, "--print"], box, env);
      expect(run.status, run.output).toBe(0);
      if (target === "codex") {
        expect(run.stdout).toBe('[mcp_servers.uberblick]\ncommand = "ub"\nargs = ["mcp", "serve"]\n');
      } else {
        expect(JSON.parse(run.stdout)).toEqual({ mcpServers: {
          uberblick: { type: "stdio", command: "ub", args: ["mcp", "serve"] },
        } });
      }
      expect(run.output).not.toContain(SECRET);
      expect(run.output).not.toContain(OTHER);
      expect(run.output).not.toMatch(/UB_WORKSPACE_ID|UB_HUB_URL|WORKSPACE_ID|HUB_URL|pin/i);
    }
    expect(read(bindingPath)).toBe(before);
  });

  it.each(["project", "user"])("registers %s scope without creating a binding", (scope) => {
    // A legacy machine default is neither needed nor adopted by installation.
    const box = unboundSandbox({ userConfig: {
      workspace: WORKSPACE, hubUrl: "wss://old-hub.example.test/ws",
    } });
    const configPath = join(box.configHome, "uberblick", "config.json");
    const before = read(configPath);
    const stub = stubVendor(box, "claude");
    const run = runUb(["mcp", "install", "claude", `--${scope}`], box, stub.env);

    expect(run.status, run.output).toBe(0);
    expect(read(stub.record).trimEnd().split("\n")).toEqual([
      "mcp", "add", "uberblick", "--scope", scope, "--", "ub", "mcp", "serve",
    ]);
    expect(existsSync(join(box.cwd, ".uberblick.json"))).toBe(false);
    expect(read(configPath)).toBe(before);
    expect(run.stdout).toMatch(/^ran\s+claude mcp add/m);
    expect(run.stdout).toMatch(/restart running agents.*pick.*up/i);
    if (scope === "project") {
      expect(run.stdout).toContain(join(box.cwd, ".mcp.json"));
      expect(run.stderr).toMatch(/agents cannot start/i);
      expect(run.stderr).toContain("ub workspace create <name>");
      expect(run.stderr).toContain("ub workspace use <link|id>");
    } else {
      expect(run.stdout).toContain(join(box.env.HOME as string, ".claude.json"));
      expect(run.stdout).toMatch(/workspace\s+follows .*nearest \.uberblick\.json.*each project/i);
      expect(run.stderr).toBe("");
    }
    expect(run.output).not.toMatch(/pin/i);
  });

  it.each(["{ not json", '{"workspaceId":"invalid","hubUrl":null}'])(
    "registers project scope without changing an invalid binding %s", (raw) => {
      const box = unboundSandbox({ raw: { projectBinding: raw } });
      const stub = stubVendor(box, "claude");
      const path = join(box.cwd, ".uberblick.json");
      const run = runUb(["mcp", "install", "claude"], box, stub.env);
      expect(run.status, run.output).toBe(0);
      expect(existsSync(stub.record)).toBe(true);
      expect(run.stdout).toContain(join(box.cwd, ".mcp.json"));
      expect(run.stderr).toMatch(/agents cannot start/i);
      expect(run.stderr).toContain("ub workspace create <name>");
      expect(run.stderr).toContain("ub workspace use <link|id>");
      expect(read(path)).toBe(raw);
    },
  );

  it("follows the nearest ancestor file while targeting the current directory", () => {
    const box = sandbox();
    const path = join(box.cwd, ".uberblick.json");
    const before = read(path);
    const nested = join(box.cwd, "src", "feature");
    mkdirSync(nested, { recursive: true });
    const stub = stubVendor(box, "claude");
    const run = runUb(["mcp", "install", "claude"], { ...box, cwd: nested }, {
      ...stub.env, UB_WORKSPACE_ID: OTHER, UB_HUB_URL: "invalid-ambient-hub",
    });

    expect(run.status, run.output).toBe(0);
    expect(run.stdout).toContain(join(nested, ".mcp.json"));
    expect(run.stdout).toMatch(/^workspace\s+follows /m);
    expect(run.stdout).toContain(path);
    expect(run.stdout).not.toContain(OTHER);
    expect(run.stdout).not.toContain("invalid-ambient-hub");
    expect(run.stderr).toBe("");
    expect(read(path)).toBe(before);
    expect(existsSync(join(nested, ".uberblick.json"))).toBe(false);
  });

  it.each([
    LOCAL_BINDING_ENV,
    { UB_WORKSPACE_ID: OTHER },
    { UB_WORKSPACE_ID: OTHER, UB_HUB_URL: "wss://manual.example.test/ws" },
    { WORKSPACE_ID: WORKSPACE },
    { API_TOKEN: SECRET },
  ])("protects an existing entry with nonempty env %j", (env) => {
    const box = sandbox();
    const path = join(box.cwd, ".mcp.json");
    const before = JSON.stringify({ mcpServers: {
      uberblick: { command: "ub", args: ["mcp", "serve"], env },
      "uberblick-older-label": { command: "ub", args: ["mcp", "serve"], env: LOCAL_BINDING_ENV },
    } });
    writeFileSync(path, before);
    const stub = stubVendor(box, "claude");
    const run = runUb(["mcp", "install", "claude"], box, stub.env);
    expect(run.status).toBe(1);
    expect(run.stderr).toMatch(/something other than this/);
    expect(JSON.parse(run.stdout)).toEqual({ mcpServers: {
      uberblick: { type: "stdio", command: "ub", args: ["mcp", "serve"] },
    } });
    expect(run.output).not.toContain(SECRET);
    expect(read(path)).toBe(before);
    expect(existsSync(stub.record)).toBe(false);
  });

  it("protects an older pinned Codex entry", () => {
    const box = sandbox();
    const home = codexHome(box);
    const path = join(home, "config.toml");
    const before = '[mcp_servers.uberblick]\ncommand = "ub"\nargs = ["mcp", "serve"]\n' +
      `\n[mcp_servers.uberblick.env]\nUB_HUB_URL = "local"\nUB_WORKSPACE_ID = "${WORKSPACE}"\n`;
    writeFileSync(path, before);
    const stub = stubVendor(box, "codex");
    const run = runUb(["mcp", "install", "codex", "--user"], box, { ...stub.env, CODEX_HOME: home });
    expect(run.status).toBe(1);
    expect(run.stderr).toMatch(/something other than this/);
    expect(run.stdout).toBe('[mcp_servers.uberblick]\ncommand = "ub"\nargs = ["mcp", "serve"]\n');
    expect(read(path)).toBe(before);
    expect(existsSync(stub.record)).toBe(false);
  });

  it("leaves separately named older entries alone while registering uberblick", () => {
    const box = sandbox();
    const path = join(box.cwd, ".mcp.json");
    const before = JSON.stringify({ mcpServers: {
      "uberblick-older-label": { command: "ub", args: ["mcp", "serve"], env: LOCAL_BINDING_ENV },
    } });
    writeFileSync(path, before);
    const stub = stubVendor(box, "claude");
    const run = runUb(["mcp", "install", "claude"], box, stub.env);
    expect(run.status, run.output).toBe(0);
    expect(read(stub.record).trimEnd().split("\n")).toEqual([
      "mcp", "add", "uberblick", "--scope", "project", "--", "ub", "mcp", "serve",
    ]);
    expect(read(path)).toBe(before);
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

  /** A session spawned from a manually written MCP entry. */
  async function open(entry: Registered, box: Sandbox): Promise<Client> {
    const client = new Client({ name: "uberblick-install-tests", version: "0.0.0" });
    await client.connect(
      new StdioClientTransport({
        command: entry.command,
        args: entry.args,
        cwd: box.cwd,
        env: stringEnv({ ...box.env, ...entry.env }),
        stderr: "ignore",
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
    const box = sandbox();
    writeFileSync(join(box.cwd, ".uberblick.json"), JSON.stringify({ workspaceId: PRIMARY, hubUrl: null }));
    // A plain entry follows the project, while a hand-written entry's env
    // still selects another workspace. Use this checkout's launcher explicitly
    // because the test fixture does not have `ub` on PATH.
    const plain: Registered = { command: process.execPath, args: [UB_BIN, "mcp", "serve"] };
    const primary = await open(plain, box);
    const pinned = await open({
      ...plain, env: { UB_WORKSPACE_ID: PINNED, UB_HUB_URL: "local" },
    }, box);
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

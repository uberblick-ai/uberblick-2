/**
 * What `ub mcp install` promises.
 *
 * It edits no configuration file. Claude Code and Codex are wired up by running
 * their own `mcp add`; every other client needs `--print` for a generic snippet.
 * So the contracts under test are the ones that are left: the right
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
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { INSTALL_HELP } from "../src/install.js";
import { type Sandbox, type SandboxFiles, removeTempDirs, sandbox as boundSandbox, unboundSandbox } from "./helpers.js";
import { runInProcess } from "./in-process.js";

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
// Whole words: output names temporary paths, and one like uberblick-cli-5SjPIn
// contains the letters without mentioning a pin.
const PIN = /\bpin(?:s|ned|ning)?\b/i;

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
  /** The working directory the vendor ran in. */
  cwd: string;
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
      `pwd -P > "$${RECORD}.cwd"\n` +
      `{\n${report}\n} > "$${RECORD}.env"\n${body}`,
    "utf8",
  );
  chmodSync(path, 0o755);
  return {
    env: { PATH: dir, [RECORD]: record },
    record,
    home: `${record}.home`,
    cwd: `${record}.cwd`,
    environment: `${record}.env`,
  };
}

function read(path: string): string {
  return readFileSync(path, "utf8");
}

function subfolder(box: Sandbox): Sandbox {
  const cwd = join(box.cwd, "src", "feature");
  mkdirSync(cwd, { recursive: true });
  return { ...box, cwd };
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
      uberblick: { command: "ub", args: ["mcp", "serve"] },
    } }, null, 2)}\n`;
}

describe("ub mcp install --print", () => {
  it("prints a snippet for the named target and touches no file", async () => {
    const box = sandbox();

    const claude = await runInProcess(["mcp", "install", "claude", "--print"], box);
    expect(claude.status).toBe(0);
    expect(claude.stdout).toBe(entrySnippet("claude"));
    expect(claude.stderr).toContain(join(box.cwd, ".mcp.json"));
    expect(existsSync(join(box.cwd, ".mcp.json"))).toBe(false);

    // Codex's file is TOML, so the snippet has to be TOML — a JSON snippet
    // would be a valid-looking answer that silently does not work.
    const codex = await runInProcess(["mcp", "install", "codex", "--user", "--print"], box, {
      CODEX_HOME: codexHome(box),
    });
    expect(codex.status).toBe(0);
    expect(codex.stdout).toBe(
      '[mcp_servers.uberblick]\ncommand = "ub"\nargs = ["mcp", "serve"]\n',
    );
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
      argv: ["mcp", "install", "claude"],
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
      argv: ["mcp", "install", "codex"],
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

  it.each(CELLS)("delegates $what", async ({ program, argv, expected }) => {
    const box = sandbox();
    const nested = subfolder(box);
    const stub = stubVendor(box, program);
    const run = await runInProcess(argv, nested, {
      ...stub.env,
      CODEX_HOME: codexHome(box),
      UB_WORKSPACE_ID: "invalid-ambient-workspace",
      UB_HUB_URL: "invalid-ambient-hub",
      WORKSPACE_ID: WORKSPACE,
      HUB_URL: "wss://legacy.example.test/ws",
    });

    expect(run.status, run.output).toBe(0);
    expect(run.stdout).toMatch(new RegExp(`ran\\s+${program} mcp add`));
    expect(run.output).not.toMatch(PIN);
    expect(read(stub.record).trimEnd().split("\n")).toEqual(expected);
    expect(read(stub.cwd).trim()).toBe(argv.includes("--user") ? nested.cwd : box.cwd);
    // The vendor writes the file; `ub` must not also write one behind its back.
    expect(existsSync(join(box.cwd, ".mcp.json"))).toBe(false);
  });

  it("reports the command, target, project file and restart after registration", async () => {
    const box = sandbox();
    const stub = stubVendor(box, "claude");
    const run = await runInProcess(
      ["mcp", "install", "claude"],
      box,
      stub.env,
    );

    expect(run.status, run.output).toBe(0);
    expect(run.stdout).toMatch(/^ran\s+claude mcp add uberblick --scope project -- ub mcp serve$/m);
    expect(run.stdout).toContain(join(box.cwd, ".mcp.json"));
    expect(run.stdout).toMatch(/^workspace\s+follows /m);
    expect(run.stdout).toContain(join(box.cwd, ".uberblick.json"));
    expect(run.stdout).toMatch(/restart running agents.*pick.*up/i);
    expect(run.output).not.toMatch(PIN);
  });

  it.each(CELLS.filter(({ argv }) => !argv.includes("--user")))("prints the entry for a failed $what without repeating its output", async ({ program, argv, file }) => {
    // A client's own diagnostics quote the config it just read, so relaying
    // them would walk straight past everything this command refuses to print.
    const box = sandbox();
    const nested = subfolder(box);
    const home = codexHome(box);
    const stub = stubVendor(
      box,
      program,
      `echo "conflict in config: API_TOKEN=${SECRET}" >&2\necho "${SECRET}"\nexit 1\n`,
    );

    const run = await runInProcess(argv, nested, { ...stub.env, CODEX_HOME: home });
    expect(run.status).toBe(1);
    expect(run.stdout).toBe(entrySnippet(program));
    expect(run.output).not.toContain(SECRET);
    // Enough to act on: which program, how it ended, and where to look.
    expect(run.stderr).toContain(`${program} mcp add`);
    expect(run.stderr).toMatch(/exited 1/);
    expect(run.stderr).toContain(file(box, home));
    expect(existsSync(file(box, home))).toBe(false);
    expect(existsSync(join(box.cwd, ".codex"))).toBe(false);
    expect(existsSync(join(nested.cwd, ".codex"))).toBe(false);
    expect(existsSync(join(nested.cwd, ".mcp.json"))).toBe(false);
  });

  it.each(["claude", "codex"])("prints the entry when %s mcp add is killed by a signal", async (program) => {
    const box = sandbox();
    const stub = stubVendor(
      box,
      program,
      `echo "${SECRET}" >&2\necho "${SECRET}"\nkill -TERM $$\n`,
    );
    const run = await runInProcess(["mcp", "install", program], box, stub.env);

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

  it.each(["claude", "codex"])("prints the entry when %s mcp add cannot start", async (program) => {
    const box = sandbox();
    const stub = stubVendor(box, program);
    // A non-executable file on PATH is distinct from a missing program.
    chmodSync(join(stub.env.PATH as string, program), 0o644);
    const run = await runInProcess(["mcp", "install", program], box, stub.env);

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

  it("hands the vendor no variable of uberblick's own", async () => {
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

    const run = await runInProcess(["mcp", "install", "claude"], box, {
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

  it.each(CELLS.filter(({ argv }) => !argv.includes("--user")))("prints the entry for missing $what and leaves nothing behind", async ({ program, argv, file }) => {
    const box = sandbox();
    const nested = subfolder(box);
    const home = codexHome(box);
    const run = await runInProcess(argv, nested, { ...NO_VENDOR, CODEX_HOME: home });
    expect(run.status).toBe(1);
    expect(run.stdout).toBe(entrySnippet(program));
    expect(run.stderr).toContain(`\`${program}\` is not installed`);
    expect(run.stderr).toContain(file(box, home));
    expect(existsSync(file(box, home))).toBe(false);

    // Codex refuses a CODEX_HOME that is not there, so project scope creates
    // one — and a run that ended in a snippet must not leave it in a checkout.
    expect(existsSync(join(box.cwd, ".codex"))).toBe(false);
    expect(existsSync(join(nested.cwd, ".codex"))).toBe(false);
    expect(existsSync(join(nested.cwd, ".mcp.json"))).toBe(false);
  });

  it.each(["missing", "failed"])("leaves a `.codex` it did not create when the vendor is %s", async (ending) => {
    // "Writes nothing" has to include taking nothing away. An empty `.codex` a
    // checkout already had is still somebody's state — and whether this run is
    // the one that made the directory is the only thing that decides it.
    const box = sandbox();
    const nested = subfolder(box);
    const dir = join(box.cwd, ".codex");
    mkdirSync(dir, { recursive: true });

    const env = ending === "missing" ? NO_VENDOR : stubVendor(box, "codex", "exit 1\n").env;
    const run = await runInProcess(["mcp", "install", "codex"], nested, env);
    expect(run.status, run.output).toBe(1);
    expect(run.stdout).toBe(entrySnippet("codex"));
    expect(existsSync(dir)).toBe(true);
    expect(existsSync(join(nested.cwd, ".codex"))).toBe(false);
  });
});

describe("ub mcp install, and what is registered already", () => {
  it.each([undefined, {}])("recognises a plain entry with env %j and runs nothing", async (env) => {
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

    const run = await runInProcess(["mcp", "install", "claude"], box, {
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
    expect(run.output).not.toMatch(PIN);
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
      what: "an inline server with empty inline env",
      before: '[mcp_servers]\nuberblick = { command = "ub", ' +
        'args = ["mcp", "serve"], env = {} }\n',
    },
    {
      what: "an empty env subtable separated by another table",
      before: entrySnippet("codex") + '[other]\nenabled = true\n[mcp_servers.uberblick.env]\n',
    },
  ])("recognises the plain Codex entry from $what and runs nothing", async ({ before }) => {
    const box = sandbox();
    const home = codexHome(box);
    const path = join(home, "config.toml");
    writeFileSync(path, before, "utf8");
    const stub = stubVendor(box, "codex");

    const run = await runInProcess(
      ["mcp", "install", "codex", "--user"],
      box,
      { ...stub.env, CODEX_HOME: home },
    );
    expect(run.status, run.output).toBe(0);
    expect(run.stdout).toMatch(/already installed/);
    expect(run.stdout).toMatch(/workspace\s+follows .*nearest \.uberblick\.json.*each project/i);
    expect(run.stdout).not.toMatch(/^ran\s+/m);
    expect(run.output).not.toMatch(PIN);
    expect(read(path)).toBe(before);
    expect(existsSync(stub.record)).toBe(false);
  });

  it("protects a differing Codex entry under a quoted and spaced header", async () => {
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

    const run = await runInProcess(["mcp", "install", "codex", "--user"], box, {
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

  it("refuses a differing Codex entry without a server header", async () => {
    const box = sandbox();
    const home = codexHome(box);
    const path = join(home, "config.toml");
    const before = '[mcp_servers]\nuberblick = { command = "somebody-elses", args = ["serve"], ' +
      `env = { API_TOKEN = "${SECRET}" } }\n`;
    writeFileSync(path, before, "utf8");
    const stub = stubVendor(box, "codex");

    const run = await runInProcess(["mcp", "install", "codex", "--user"], box, {
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
    { what: "an unknown key", text: entrySnippet("codex") + `cwd = "${SECRET}"\n` },
    { what: "a non-table env", text: entrySnippet("codex") + "env = 1979-05-27\n" },
    { what: "a JSON-only type key", text: entrySnippet("codex") + 'type = "stdio"\n' },
    { what: "a non-table server", text: "[mcp_servers]\nuberblick = 1979-05-27\n" },
  ])("protects Codex config with $what", async ({ text }) => {
    const box = sandbox();
    const home = codexHome(box);
    const path = join(home, "config.toml");
    const before = `private_token = "${SECRET}"\n${text}`;
    writeFileSync(path, before);
    const stub = stubVendor(box, "codex");
    const run = await runInProcess(["mcp", "install", "codex", "--user"], box, { ...stub.env, CODEX_HOME: home });
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
    { what: "non-table mcp_servers", text: `mcp_servers = "${SECRET}"\n` },
  ])("refuses unusable Codex config with $what without quoting it", async ({ text }) => {
    const box = sandbox();
    const home = codexHome(box);
    const path = join(home, "config.toml");
    const before = `private_token = "${SECRET}"\n${text}`;
    writeFileSync(path, before);
    const stub = stubVendor(box, "codex");
    const run = await runInProcess(["mcp", "install", "codex", "--user"], box, { ...stub.env, CODEX_HOME: home });
    expect(run.status, run.output).toBe(1);
    expect(run.stderr).toContain(path);
    expect(run.stderr).toMatch(/could not be read/);
    expect(run.stdout).toBe(entrySnippet("codex"));
    expect(run.output).not.toContain(SECRET);
    expect(run.output).not.toContain("private_token");
    expect(read(path)).toBe(before);
    expect(existsSync(stub.record)).toBe(false);
  });

  it("adds Codex's absent entry despite an apparent header inside unrelated multiline settings", async () => {
    const box = sandbox();
    const home = codexHome(box);
    const path = join(home, "config.toml");
    const before = 'large_integer = 9007199254740993\n[other]\ninstructions = """\n' +
      `[mcp_servers.uberblick]\ncommand = "${SECRET}"\n"""\n`;
    writeFileSync(path, before);
    const stub = stubVendor(box, "codex");
    const run = await runInProcess(["mcp", "install", "codex", "--user"], box, { ...stub.env, CODEX_HOME: home });
    expect(run.status, run.output).toBe(0);
    expect(read(stub.record).trimEnd().split("\n")).toEqual([
      "mcp", "add", "uberblick", "--", "ub", "mcp", "serve",
    ]);
    expect(run.output).not.toContain(SECRET);
    expect(read(path)).toBe(before);
  });

  it("refuses an entry it did not write, prints the snippet, and quotes nothing", async () => {
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

    const run = await runInProcess(["mcp", "install", "claude"], box, stub.env);
    expect(run.status).toBe(1);
    expect(run.stderr).toContain(path);
    expect(run.stderr).toMatch(
      /already registers "uberblick" as something other than this/,
    );
    // The way out is the snippet, and nothing out of their file comes with it:
    // not the command it runs, and certainly not what it sets.
    expect(run.stdout).toBe(entrySnippet("claude"));
    expect(run.output).not.toContain(SECRET);
    expect(run.output).not.toContain("somebody-elses");
    // Byte-identical afterwards, and the vendor was never given the chance.
    expect(read(path)).toBe(before);
    expect(existsSync(stub.record)).toBe(false);
  });

  it("refuses a target file it cannot read, rather than delegating over it", async () => {
    // Reading this as "absent" would mean "go ahead" — and going ahead points
    // `claude mcp add` at a file this could not read, which it loads and
    // rewrites. Nothing of it comes back out, not even a parser's complaint.
    const box = sandbox();
    const path = join(box.cwd, ".mcp.json");
    const before = `{ "mcpServers": { "uberblick": { "token": "${SECRET}"\n`;
    writeFileSync(path, before, "utf8");
    const stub = stubVendor(box, "claude");

    const run = await runInProcess(["mcp", "install", "claude"], box, stub.env);
    expect(run.status).toBe(1);
    expect(run.stderr).toContain(path);
    expect(run.stderr).toMatch(/could not be read/);
    expect(run.output).not.toContain(SECRET);
    // The way out is the same snippet, and the file is untouched.
    expect(run.stdout).toBe(entrySnippet("claude"));
    expect(read(path)).toBe(before);
    expect(existsSync(stub.record)).toBe(false);
  });

  it("does not call an entry ours when its `env` is not an environment", async () => {
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

    const run = await runInProcess(["mcp", "install", "claude"], box, stub.env);
    expect(run.status).toBe(1);
    expect(run.stderr).toMatch(/something other than this/);
    expect(read(path)).toBe(before);
    expect(existsSync(stub.record)).toBe(false);
  });
});

describe("ub mcp install cursor", () => {
  it("rejects an unknown client before running it or writing anything", async () => {
    const box = sandbox();
    const claude = stubVendor(box, "claude");
    const codex = stubVendor(box, "codex");
    const cursor = stubVendor(box, "cursor");
    const bindingPath = join(box.cwd, ".uberblick.json");
    const bindingBefore = read(bindingPath);
    const root = join(box.cwd, "..");
    const filesBefore = readdirSync(root, { recursive: true }).sort();

    const run = await runInProcess(["mcp", "install", "cursor"], box, {
      ...claude.env,
      PATH: [claude.env.PATH, codex.env.PATH, cursor.env.PATH].join(":"),
    });

    expect(run.status, run.output).toBe(2);
    expect(run.stdout).toBe("");
    expect(run.stderr).toBe(
      'ub mcp install: unknown client "cursor" — expected one of claude, codex. ' +
        `Add --print for the snippet to paste into any other client\n\n${INSTALL_HELP}`,
    );
    // Whichever stub is invoked, all share the same recording destination.
    expect(existsSync(claude.record)).toBe(false);
    expect(readdirSync(root, { recursive: true }).sort()).toEqual(filesBefore);
    expect(read(bindingPath)).toBe(bindingBefore);
  });

  it("prints a generic entry without consulting any client config", async () => {
    const box = sandbox();
    const home = box.env.HOME as string;
    const paths = [
      join(box.cwd, ".mcp.json"),
      join(home, ".claude.json"),
      join(box.cwd, ".cursor", "mcp.json"),
      join(home, ".cursor", "mcp.json"),
    ];
    mkdirSync(join(box.cwd, ".cursor"), { recursive: true });
    mkdirSync(join(home, ".cursor"), { recursive: true });
    const before = `{ malformed config ${SECRET}`;
    for (const path of paths) writeFileSync(path, before);
    const stub = stubVendor(box, "cursor");
    const root = join(box.cwd, "..");
    const filesBefore = readdirSync(root, { recursive: true }).sort();

    const cursor = await runInProcess(["mcp", "install", "cursor", "--print"], box, stub.env);

    expect(cursor.status, cursor.output).toBe(0);
    expect(cursor.stdout).toBe(entrySnippet("cursor"));
    expect(cursor.stderr).toContain('"cursor" is not a client `ub` knows');
    expect(cursor.stderr).toContain("there is no file of ours to name");
    expect(cursor.output).not.toContain(SECRET);
    for (const path of paths) {
      expect(cursor.output).not.toContain(path);
      expect(read(path)).toBe(before);
    }
    expect(existsSync(stub.record)).toBe(false);
    expect(readdirSync(root, { recursive: true }).sort()).toEqual(filesBefore);
  });
});

describe("ub mcp install requires a client", () => {
  it("refuses options without a client", async () => {
    const box = sandbox();
    const stub = stubVendor(box, "claude");
    const bindingPath = join(box.cwd, ".uberblick.json");
    const bindingBefore = read(bindingPath);
    const root = join(box.cwd, "..");
    const filesBefore = readdirSync(root, { recursive: true }).sort();

    const run = await runInProcess(["mcp", "install", "--user", "--print"], box, stub.env);

    expect(run.status, run.output).toBe(2);
    expect(run.stdout).toBe("");
    expect(run.stderr).toBe(`ub mcp install: missing client\n\n${INSTALL_HELP}`);
    expect(existsSync(stub.record)).toBe(false);
    expect(readdirSync(root, { recursive: true }).sort()).toEqual(filesBefore);
    expect(read(bindingPath)).toBe(bindingBefore);
  });
});

describe("ub mcp install rejects unexpected arguments", () => {
  it.each([["codex", "--"], ["codex", "--bogus"]])("refuses %j before running a client or writing anything", async (...args) => {
    const box = sandbox();
    const stub = stubVendor(box, "codex");
    const bindingPath = join(box.cwd, ".uberblick.json");
    const bindingBefore = read(bindingPath);
    const root = join(box.cwd, "..");
    const filesBefore = readdirSync(root, { recursive: true }).sort();

    const run = await runInProcess(["mcp", "install", ...args], box, stub.env);

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

  it("prints only the plain entry despite shell selectors", async () => {
    const env = {
      UB_WORKSPACE_ID: OTHER,
      UB_HUB_URL: "invalid-hub",
      WORKSPACE_ID: OTHER,
      HUB_URL: "https://legacy.example.test",
      WORKSPACES: "one,two",
    };
    const box = sandbox({ credentials: { signingSecret: SECRET } });
    const nested = subfolder(box);
    const bindingPath = join(box.cwd, ".uberblick.json");
    const before = read(bindingPath);
    for (const target of ["claude", "codex"]) {
      const run = await runInProcess(["mcp", "install", target, "--print"], nested, env);
      expect(run.status, run.output).toBe(0);
      if (target === "codex") {
        expect(run.stdout).toBe('[mcp_servers.uberblick]\ncommand = "ub"\nargs = ["mcp", "serve"]\n');
      } else {
        expect(JSON.parse(run.stdout)).toEqual({ mcpServers: {
          uberblick: { command: "ub", args: ["mcp", "serve"] },
        } });
      }
      expect(run.output).not.toContain(SECRET);
      expect(run.output).not.toContain(OTHER);
      expect(run.output).not.toMatch(/UB_WORKSPACE_ID|UB_HUB_URL|WORKSPACE_ID|HUB_URL/i);
      expect(run.output).not.toMatch(PIN);
      expect(run.stderr).toContain(target === "codex"
        ? join(box.cwd, ".codex", "config.toml")
        : join(box.cwd, ".mcp.json"));
    }
    expect(read(bindingPath)).toBe(before);
    expect(readdirSync(nested.cwd)).toEqual([]);
    expect(existsSync(join(box.cwd, ".codex"))).toBe(false);
  });

  it.each(["project", "user"])("registers %s scope without creating a binding", async (scope) => {
    // A legacy machine default is neither needed nor adopted by installation.
    const box = unboundSandbox({ userConfig: {
      workspace: WORKSPACE, hubUrl: "wss://old-hub.example.test/ws",
    } });
    const configPath = join(box.configHome, "uberblick", "config.json");
    const before = read(configPath);
    const stub = stubVendor(box, "claude");
    const run = await runInProcess(["mcp", "install", "claude", ...(scope === "user" ? ["--user"] : [])], box, stub.env);

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
    expect(run.output).not.toMatch(PIN);
  });

  it("registers project scope without changing an invalid binding", async () => {
    const raw = "{ not json";
    const box = unboundSandbox({ raw: { projectBinding: raw } });
    const stub = stubVendor(box, "claude");
    const path = join(box.cwd, ".uberblick.json");
    const run = await runInProcess(["mcp", "install", "claude"], box, stub.env);
    expect(run.status, run.output).toBe(0);
    expect(existsSync(stub.record)).toBe(true);
    expect(run.stdout).toContain(join(box.cwd, ".mcp.json"));
    expect(run.stderr).toMatch(/agents cannot start/i);
    expect(run.stderr).toContain("ub workspace create <name>");
    expect(run.stderr).toContain("ub workspace use <link|id>");
    expect(read(path)).toBe(raw);
  });

  it.each(["claude", "codex"])("registers %s beside the nearest valid ancestor binding", async (program) => {
    const box = sandbox();
    const path = join(box.cwd, ".uberblick.json");
    const before = read(path);
    const nested = subfolder(box);
    const file = program === "codex"
      ? join(box.cwd, ".codex", "config.toml") : join(box.cwd, ".mcp.json");
    const destination = program === "codex" ? '"$CODEX_HOME/config.toml"' : ".mcp.json";
    const stub = stubVendor(box, program,
      `printf '%s\\n' '${entrySnippet(program).trimEnd()}' > ${destination}\n`);
    const run = await runInProcess(["mcp", "install", program], nested, {
      ...stub.env, UB_WORKSPACE_ID: OTHER, UB_HUB_URL: "invalid-ambient-hub",
    });

    expect(run.status, run.output).toBe(0);
    expect(run.stdout).toContain(`file        ${file}\n`);
    expect(read(file)).toBe(entrySnippet(program));
    expect(read(stub.cwd).trim()).toBe(box.cwd);
    if (program === "codex") expect(read(stub.home).trim()).toBe(join(box.cwd, ".codex"));
    expect(run.stdout).toMatch(/^workspace\s+follows /m);
    expect(run.stdout).toContain(path);
    expect(run.stdout).not.toContain(OTHER);
    expect(run.stdout).not.toContain("invalid-ambient-hub");
    expect(run.stderr).toBe("");
    expect(read(path)).toBe(before);
    expect(readdirSync(nested.cwd)).toEqual([]);
  });

  it.each(["plain", "foreign", "malformed", "unreadable"])(
    "checks a %s config at the binding root before running any client", async (held) => {
      for (const program of ["claude", "codex"]) {
        const box = sandbox();
        const nested = subfolder(box);
        const file = program === "codex"
          ? join(codexHome(box, join(box.cwd, ".codex")), "config.toml")
          : join(box.cwd, ".mcp.json");
        const before = held === "plain" ? entrySnippet(program)
          : held === "foreign" ? entrySnippet(program).replace('"ub"', '"other-command"')
          : `invalid config ${SECRET}`;
        if (held === "unreadable") mkdirSync(file);
        else writeFileSync(file, before);
        const stub = stubVendor(box, program);
        const run = await runInProcess(["mcp", "install", program], nested, stub.env);

        expect(run.status, run.output).toBe(held === "plain" ? 0 : 1);
        expect(run.output).toContain(file);
        expect(run.output).not.toContain(SECRET);
        if (held === "plain") expect(run.stdout).toMatch(/^already installed/m);
        else expect(run.stderr).toContain(held === "foreign" ? "something other than this" : "could not be read");
        expect(existsSync(stub.record)).toBe(false);
        if (held === "unreadable") expect(readdirSync(file)).toEqual([]);
        else expect(read(file)).toBe(before);
        expect(readdirSync(nested.cwd)).toEqual([]);
      }
    },
  );

  it("registers in the current subfolder without a binding", async () => {
    for (const program of ["claude", "codex"]) {
      const box = unboundSandbox();
      const nested = subfolder(box);
      const stub = stubVendor(box, program);
      const run = await runInProcess(["mcp", "install", program], nested, {
        ...stub.env, ...LOCAL_BINDING_ENV,
      });
      const file = program === "codex"
        ? join(nested.cwd, ".codex", "config.toml") : join(nested.cwd, ".mcp.json");

      expect(run.status, run.output).toBe(0);
      expect(run.stdout).toContain(`file        ${file}\n`);
      expect(read(stub.cwd).trim()).toBe(nested.cwd);
      if (program === "codex") expect(read(stub.home).trim()).toBe(join(nested.cwd, ".codex"));
      expect(run.stderr).toMatch(/agents cannot start/i);
      expect(run.stderr).toContain("ub workspace create <name>");
      expect(run.stderr).toContain("ub workspace use <link|id>");
      expect(existsSync(join(nested.cwd, ".uberblick.json"))).toBe(false);
      expect(existsSync(join(box.cwd, ".codex"))).toBe(false);
      expect(existsSync(join(box.cwd, ".mcp.json"))).toBe(false);
    }
  });

  it("protects an existing entry with nonempty env", async () => {
    const env = { API_TOKEN: SECRET };
    const box = sandbox();
    const path = join(box.cwd, ".mcp.json");
    const before = JSON.stringify({ mcpServers: {
      uberblick: { command: "ub", args: ["mcp", "serve"], env },
      "uberblick-older-label": { command: "ub", args: ["mcp", "serve"], env: LOCAL_BINDING_ENV },
    } });
    writeFileSync(path, before);
    const stub = stubVendor(box, "claude");
    const run = await runInProcess(["mcp", "install", "claude"], box, stub.env);
    expect(run.status).toBe(1);
    expect(run.stderr).toMatch(/something other than this/);
    expect(JSON.parse(run.stdout)).toEqual({ mcpServers: {
      uberblick: { command: "ub", args: ["mcp", "serve"] },
    } });
    expect(run.output).not.toContain(SECRET);
    expect(read(path)).toBe(before);
    expect(existsSync(stub.record)).toBe(false);
  });

  it("protects an older pinned Codex entry", async () => {
    const box = sandbox();
    const home = codexHome(box);
    const path = join(home, "config.toml");
    const before = '[mcp_servers.uberblick]\ncommand = "ub"\nargs = ["mcp", "serve"]\n' +
      `\n[mcp_servers.uberblick.env]\nUB_HUB_URL = "local"\nUB_WORKSPACE_ID = "${WORKSPACE}"\n`;
    writeFileSync(path, before);
    const stub = stubVendor(box, "codex");
    const run = await runInProcess(["mcp", "install", "codex", "--user"], box, { ...stub.env, CODEX_HOME: home });
    expect(run.status).toBe(1);
    expect(run.stderr).toMatch(/something other than this/);
    expect(run.stdout).toBe('[mcp_servers.uberblick]\ncommand = "ub"\nargs = ["mcp", "serve"]\n');
    expect(read(path)).toBe(before);
    expect(existsSync(stub.record)).toBe(false);
  });

  it("leaves separately named older entries alone while registering uberblick", async () => {
    const box = sandbox();
    const path = join(box.cwd, ".mcp.json");
    const before = JSON.stringify({ mcpServers: {
      "uberblick-older-label": { command: "ub", args: ["mcp", "serve"], env: LOCAL_BINDING_ENV },
    } });
    writeFileSync(path, before);
    const stub = stubVendor(box, "claude");
    const run = await runInProcess(["mcp", "install", "claude"], box, stub.env);
    expect(run.status, run.output).toBe(0);
    expect(read(stub.record).trimEnd().split("\n")).toEqual([
      "mcp", "add", "uberblick", "--scope", "project", "--", "ub", "mcp", "serve",
    ]);
    expect(read(path)).toBe(before);
  });
});

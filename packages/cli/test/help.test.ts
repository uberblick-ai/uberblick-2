/**
 * Contextual help as a contract of the whole `ub` surface.
 *
 * The manifest below is the point of this suite: every human-facing command
 * path is listed once, and a new path that ships without help fails here rather
 * than being discovered by somebody who typed `--help` and got exit 2. What is
 * asserted about each is the same three things — both spellings exit 0, the
 * help lands on stdout, and the option names come from the parser the command
 * actually uses rather than from a copy that can go stale.
 *
 * The other half is what help must *not* do: it is answered before validation,
 * before a missing operand is noticed, and before anything is written,
 * connected to, prompted for, or read out of somebody's MCP client config.
 *
 * **Which half spawns.** What the dispatcher decides — exit code, which stream
 * the text lands on, which text — is a function of argv, so those cases call
 * {@link dispatch} and cost nothing. What survives only across a process
 * boundary keeps its spawn: that a run in a real directory left every byte of
 * it untouched, and the one case that reads an MCP client config off disk.
 */

import { createHash } from "node:crypto";
import { readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { HELP, MCP_HELP, runCli } from "../src/cli.js";
import {
  AUTH_HELP,
  AUTH_LOGIN_HELP,
  AUTH_LOGOUT_HELP,
  AUTH_LOGOUT_OPTIONS,
  AUTH_STATUS_HELP,
} from "../src/auth.js";
import { DOCTOR_HELP, DOCTOR_OPTIONS } from "../src/doctor.js";
import { INSTALL_HELP, INSTALL_OPTIONS } from "../src/install.js";
import { OPEN_HELP, OPEN_OPTIONS } from "../src/open.js";
import { WORKSPACE_CREATE_HELP } from "../src/workspace-create.js";
import { WORKSPACE_STATUS_HELP } from "../src/workspace-status.js";
import {
  WORKSPACE_MEMBER_HELP,
  WORKSPACE_MEMBER_SUBCOMMAND_HELP,
  WORKSPACE_MEMBER_ADD_OPTIONS,
  WORKSPACE_MEMBER_LIST_OPTIONS,
} from "../src/workspace-member.js";
import { WORKSPACE_PROMOTE_HELP } from "../src/workspace-promote.js";
import { STATUS_HELP, STATUS_OPTIONS } from "../src/status.js";
import { UPDATE_HELP } from "../src/update.js";
import {
  WORKSPACE_HELP,
  WORKSPACE_LIST_HELP,
  WORKSPACE_LIST_OPTIONS,
  WORKSPACE_USE_HELP,
  WORKSPACE_USE_OPTIONS,
} from "../src/workspace.js";
import type { Run, Sandbox } from "./helpers.js";
import { DEAD_HUB_URL, PACKAGE_ROOT, removeTempDirs, runUb, sandbox, unboundSandbox } from "./helpers.js";

afterAll(removeTempDirs);

const WORKSPACE = "4d8e2f11-6a73-4c95-8b20-9e1f5c3a7d64";

/** The live CLI: ub mcp Basic Usage output, without its shell prompt. */
const MCP_BASIC_USAGE = `usage: ub mcp [command]

commands:
  install <client>   # Register Uberblick with an agent's MCP client: claude or codex

options for install:
  --user             # Register for every project of this user, not just this directory
  --print            # Print the entry to paste, and run nothing
`;

/**
 * One `ub` invocation through the dispatcher, without a process.
 *
 * `runCli` takes the {@link Io} the process entry point hands it, so "which
 * stream did this land on" is answerable here — the property these cases are
 * about — and the exit code is its return value. What is *not* answerable here
 * is anything the process owns, which is why the cases below that assert an
 * untouched sandbox still spawn.
 */
async function dispatch(argv: string[]): Promise<Run> {
  let stdout = "";
  let stderr = "";
  const status = await runCli(argv, {
    out: (text) => {
      stdout += text;
    },
    err: (text) => {
      stderr += text;
    },
  });
  return { status, stdout, stderr, output: `${stdout}${stderr}` };
}

it("prints ub open's Basic Usage in the house help layout", async () => {
  const help = await dispatch(["open", "--help"]);
  expect(help.status).toBe(0);
  expect(help.stdout).toBe(`usage: ub open [options]

Serve the web app for this project's workspace, with a hub behind it, and open the browser. Runs until Ctrl-C.

options:
  --no-browser      Print the address instead of opening a browser
  --port <n>        Port for the web app (default 13379)
  -h, --help        show this help

BROWSER in the environment names the command used to open the URL; BROWSER=none
suppresses it, like --no-browser.
`);
  expect(help.stderr).toBe("");
});

it.each([
  ["--browser"],
  ["--no-browser", "--browser"],
  ["--browser", "--no-browser"],
  ["--port", "13380", "--browser"],
])("rejects the hidden browser option: %j", async (...args) => {
  const refused = await dispatch(["open", ...args]);
  expect(refused.status).toBe(2);
  expect(refused.stdout).toBe("");
  expect(refused.stderr).toContain("ub open: Unknown option '--browser'");
  expect(refused.stderr).toContain(`\n\n${OPEN_HELP}`);
});

it.each(["0", "65536", "1.5", "invalid"])("refuses invalid explicit web port %s", async (port) => {
  const refused = await dispatch(["open", "--port", port]);
  expect(refused.status).toBe(2);
  expect(refused.stdout).toBe("");
  expect(refused.stderr).toContain("--port must be an integer in 1..65535");
});

/** As much of a `parseArgs` option map as this suite reads. */
type Options = Readonly<
  Record<string, { readonly type: string; readonly short?: string }>
>;

interface Path {
  /** What a person types after `ub`. */
  argv: string[];
  help: string;
  /** The parser surface the help is checked against. */
  options: Options;
  /** For a group: the child commands its help has to list. */
  children?: string[];
}

/**
 * Every human-facing path. Hidden machine entries — `ub mcp serve` — are
 * deliberately absent: they are not part of this contract, and the test below
 * proves `ub mcp --help` does not advertise them either.
 */
const ROOT_PATH: Path = { argv: [], help: HELP, options: {} };

const PATHS: Path[] = [
  ROOT_PATH,
  { argv: ["update"], help: UPDATE_HELP, options: {} },
  { argv: ["open"], help: OPEN_HELP, options: OPEN_OPTIONS },
  { argv: ["status"], help: STATUS_HELP, options: STATUS_OPTIONS },
  { argv: ["doctor"], help: DOCTOR_HELP, options: DOCTOR_OPTIONS },
  {
    argv: ["workspace"],
    help: WORKSPACE_HELP,
    options: {},
    children: ["status", "create", "promote", "member", "list", "use"],
  },
  { argv: ["workspace", "status"], help: WORKSPACE_STATUS_HELP, options: {} },
  { argv: ["workspace", "list"], help: WORKSPACE_LIST_HELP, options: WORKSPACE_LIST_OPTIONS },
  { argv: ["workspace", "use"], help: WORKSPACE_USE_HELP, options: WORKSPACE_USE_OPTIONS },
  { argv: ["workspace", "create"], help: WORKSPACE_CREATE_HELP, options: {} },
  { argv: ["workspace", "promote"], help: WORKSPACE_PROMOTE_HELP, options: {} },
  {
    argv: ["workspace", "member"],
    help: WORKSPACE_MEMBER_HELP,
    options: {},
    children: ["add", "list", "role", "remove"],
  },
  { argv: ["workspace", "member", "add"], help: WORKSPACE_MEMBER_SUBCOMMAND_HELP.add, options: WORKSPACE_MEMBER_ADD_OPTIONS },
  { argv: ["workspace", "member", "list"], help: WORKSPACE_MEMBER_SUBCOMMAND_HELP.list, options: WORKSPACE_MEMBER_LIST_OPTIONS },
  { argv: ["workspace", "member", "role"], help: WORKSPACE_MEMBER_SUBCOMMAND_HELP.role, options: {} },
  { argv: ["workspace", "member", "remove"], help: WORKSPACE_MEMBER_SUBCOMMAND_HELP.remove, options: {} },
  { argv: ["auth"], help: AUTH_HELP, options: {}, children: ["login", "status", "logout"] },
  { argv: ["auth", "login"], help: AUTH_LOGIN_HELP, options: {} },
  { argv: ["auth", "status"], help: AUTH_STATUS_HELP, options: {} },
  { argv: ["auth", "logout"], help: AUTH_LOGOUT_HELP, options: AUTH_LOGOUT_OPTIONS },
  { argv: ["mcp"], help: MCP_HELP, options: {}, children: ["install"] },
  { argv: ["mcp", "install"], help: INSTALL_HELP, options: INSTALL_OPTIONS },
];

ROOT_PATH.children = PATHS.flatMap(({ argv }) => (argv.length === 1 ? argv : []));

/**
 * Where the dispatch actually happens, so the manifest can be checked against
 * it: the variable each dispatcher switches on, and the path its cases hang off.
 */
const DISPATCHERS = [
  { file: "cli.ts", group: [], variable: "command" },
  { file: "cli.ts", group: ["mcp"], variable: "subcommand" },
  { file: "workspace.ts", group: ["workspace"], variable: "sub" },
  { file: "workspace-member.ts", group: ["workspace", "member"], variable: "command" },
  { file: "auth.ts", group: ["auth"], variable: "sub" },
];

/** Not commands: the hidden machine entry, the help words, the version flags. */
const HIDDEN = ["serve", "help", "--help", "-h", "--version", "-v"];

/** Command names and description columns from one contextual catalog. */
function commandRows(help: string, catalogOnly = false): Array<{ command: string; descriptionColumn: number }> {
  const catalog = help.match(catalogOnly
    ? /\ncommands:\n((?: {2}.+\n)+)$/
    : /\ncommands:\n((?: {2}.+\n)+)\noptions(?: for install)?:\n/);
  expect(catalog, "command help contains its complete catalog").not.toBeNull();

  return (catalog?.[1] ?? "")
    .split("\n")
    .filter((line) => /^ {2}\S/.test(line))
    .map((line) => {
      const row = line.match(/^ {2}(.+?) {2,}(\S.*)$/);
      expect(row, `aligned command row: ${line}`).not.toBeNull();
      const usage = row?.[1] ?? "";
      const description = row?.[2] ?? "";
      return {
        command: usage.split(" ")[0] ?? "",
        descriptionColumn: line.length - description.length,
      };
    });
}

/**
 * Everything under the sandbox root, so "it wrote nothing" is checkable.
 *
 * Contents and not just names: half of what these commands would do is
 * rewriting a file that is already there — a config, a credential — and a
 * listing alone cannot see an overwrite.
 */
function tree(box: Sandbox): string[] {
  const root = dirname(box.cwd);
  return readdirSync(root, { recursive: true, encoding: "utf8" })
    .map((entry) => {
      const path = join(root, entry);
      if (!statSync(path).isFile()) return entry;
      return `${entry} ${createHash("sha256").update(readFileSync(path)).digest("hex")}`;
    })
    .sort();
}

describe("removed ub init", () => {
  it.each([[], ["--help"], ["-h"], ["--yes"], ["https://hub.example.invalid", "--name", "Ada"]].map(args => ({ args })))(
    "rejects every former invocation without writing: %j",
    ({ args }) => {
      const box = sandbox({ checkout: true });
      const before = tree(box);
      const run = runUb(["init", ...args], box);
      expect(run.status).toBe(2);
      expect(run.stdout).toBe("");
      expect(run.stderr).toBe(`ub: unknown command "init"\n\n${HELP}`);
      expect(HELP).not.toMatch(/^ {2}init\b/m);
      expect(tree(box)).toEqual(before);
    },
  );
});

describe("every human-facing command path", () => {
  for (const path of PATHS) {
    const name = ["ub", ...path.argv].join(" ");
    const isAuthGroup = path.argv.length === 1 && path.argv[0] === "auth";
    const isMcpGroup = path.argv.length === 1 && path.argv[0] === "mcp";

    it(`answers --help and -h on \`${name}\``, async () => {
      for (const flag of ["--help", "-h"]) {
        const run = await dispatch([...path.argv, flag]);
        expect(run.status, `${name} ${flag}`).toBe(0);
        expect(run.stdout, `${name} ${flag}`).toBe(path.help);
        expect(run.stderr, `${name} ${flag}`).toBe("");
      }
    });

    it(`documents \`${name}\` — usage, options, and what it is for`, () => {
      // Against the parser, not against a list kept by hand: an option added to
      // the command and not to its help fails here. `allowNegative` options are
      // documented by whichever spelling a person types.
      expect(path.help).toMatch(/usage: ub/);
      for (const [option, spec] of Object.entries(path.options)) {
        expect(
          path.help.includes(`--${option}`) || path.help.includes(`--no-${option}`),
          `${name} help documents --${option}`,
        ).toBe(true);
        if (spec.short !== undefined) {
          expect(path.help, `${name} help documents -${spec.short}`).toContain(
            `-${spec.short}`,
          );
        }
      }
      if (!isAuthGroup && !isMcpGroup) {
        expect(path.help, `${name} help documents -h, --help`).toContain("-h, --help");
      }
      if (path.children !== undefined) {
        const rows = commandRows(path.help, isAuthGroup);
        expect(
          rows.map(({ command }) => command).filter((command) => command !== "(none)"),
          `${name} help lists each immediate command once`,
        ).toEqual(path.children);
        expect(
          new Set(rows.map(({ descriptionColumn }) => descriptionColumn)).size,
          `${name} command descriptions share one column`,
        ).toBe(1);
      }
    });
  }

  it("lists every command the dispatchers actually accept", () => {
    // The manifest above is written by hand, so this reads the dispatchers
    // themselves — the same trick the option maps play. A command wired into
    // `runCli` or into a group and given no help fails here rather than
    // shipping.
    const listed = new Set(PATHS.map((path) => path.argv.join(" ")));
    for (const { file, group, variable } of DISPATCHERS) {
      const source = readFileSync(join(PACKAGE_ROOT, "src", file), "utf8");
      for (const [, command] of source.matchAll(
        // \b, or `command` would match inside `subcommand`.
        new RegExp(`\\b${variable} === "([^"]+)"`, "g"),
      )) {
        // `serve` is hidden by design; the help words are not commands.
        if (command === undefined || HIDDEN.includes(command)) continue;
        const path = [...group, command].join(" ");
        expect(listed, `the manifest lists \`ub ${path}\``).toContain(path);
      }
    }
  });

  it("keeps workspace id forms in the help of the accepting command", () => {
    expect(WORKSPACE_USE_HELP).toMatch(/<slug>-<uuid>.*prefix/s);
  });

  it("prints doctor's corpus Basic Usage in the house layout and gives the same purpose at the root", async () => {
    const expected = `usage: ub doctor [--json]

Check this project's Uberblick setup and name the fix for each problem.

options:
  --json            The same checks as JSON on stdout, for scripts
  -h, --help        show this help
`;
    const run = await dispatch(["doctor", "--help"]);
    expect(run.stdout).toBe(expected);
    expect(HELP).toMatch(/doctor \[--json\] {2,}check this project's Uberblick setup and name the fix\n {2,}for each problem/);
    for (const help of [run.stdout, HELP]) expect(help).not.toMatch(/the local stack|known failure modes/);
  });

  it("explains link use's verification scope and its limits in help", () => {
    const help = WORKSPACE_USE_HELP.replace(/\s+/g, " ");
    expect(help).toContain("hub acknowledged the writes, then a fresh client read the full directory back");
    expect(help).toContain("compared every document's directory entry");
    expect(help).toContain("Every archived document's content is read back, plus one live document's content");
    expect(help).toContain("does not establish that the hub flushed the writes to disk or that other clients have converged");
  });

  it("uses the same semantic operand name at every help level and in usage errors", async () => {
    expect(MCP_HELP).toContain("install <client>");
    expect(INSTALL_HELP).toMatch(/usage: ub mcp install <client>/);
    expect(INSTALL_HELP).toMatch(/\noperands:\n {2}client\s/);
    expect(INSTALL_HELP).not.toMatch(/default (?:client|claude|codex|cursor)/);

    const unknownClient = await dispatch(["mcp", "install", "not-a-client"]);
    expect(unknownClient.status).toBe(2);
    expect(unknownClient.stderr).toMatch(/unknown client/);

    expect(WORKSPACE_HELP).toContain("use <link|id>");
    expect(WORKSPACE_USE_HELP).toMatch(/usage: ub workspace use <link\|id>/);
    const missingTarget = await dispatch(["workspace", "use"]);
    expect(missingTarget.status).toBe(2);
    expect(missingTarget.stdout).toBe("");
    expect(missingTarget.stderr).toContain("expected exactly one workspace link or id");
  });

  it("removes join from the command surface", async () => {
    expect(WORKSPACE_HELP).not.toMatch(/\bjoin\b/);
    const removed = await dispatch(["workspace", "join"]);
    expect(removed.status).toBe(2);
    expect(removed.stdout).toBe("");
    expect(removed.stderr).toContain("unknown command");
  });

  it.each([{ argv: ["env"] }, { argv: ["env", "--", process.execPath, "-e", "process.exit(99)"] }])(
    "refuses the removed wrapper through generic unknown-command handling: %j",
    async ({ argv }) => {
      expect(HELP).not.toMatch(/^ {2}env\b/m);
      const removed = await dispatch(argv);
      expect(removed.status).toBe(2);
      expect(removed.stdout).toBe("");
      expect(removed.stderr).toBe(`ub: unknown command "env"\n\n${HELP}`);
    },
  );

  it("prints auth's complete command catalog with no options block", async () => {
    const expected = `usage: ub auth [command]

commands:
  login [hub]      # Sign in to a hub with GitHub
  status [hub]     # Show who this computer is signed in as, and what it can reach
  logout [hub]     # Sign this computer out of a hub; --all-devices signs out all of yours
`;
    for (const args of [[], ["--help"], ["-h"]]) {
      const run = await dispatch(["auth", ...args]);
      expect(run.status).toBe(0);
      expect(run.stdout).toBe(expected);
      expect(run.stderr).toBe("");
    }
    expect(HELP).toMatch(/^ {2}auth \[command\] {2,}/m);
    const unknown = await dispatch(["auth", "bogus"]);
    expect(unknown.status).toBe(2);
    expect(unknown.stdout).toBe("");
    expect(unknown.stderr).toContain(expected);
  });

  it("explains fresh-hub claiming in login help without changing the project binding", async () => {
    const run = await dispatch(["auth", "login", "--help"]);
    expect(run.status).toBe(0);
    const help = run.stdout.replace(/\s+/g, " ");
    expect(help).toMatch(/first GitHub account.*approval.*claims.*default workspace.*administrator/);
    expect(help).toMatch(/(?:never changes|stays unchanged).*binding|binding.*(?:never changes|stays unchanged)/);
  });

  it("describes login approval and status's local view", async () => {
    const login = await dispatch(["auth", "login", "--help"]);
    const loginHelp = login.stdout.replace(/\s+/g, " ");
    expect(loginHelp).toMatch(/bare host.*http\(s\).*ws\(s\)/);
    expect(loginHelp).toMatch(/hub selected by this project's binding/);
    expect(loginHelp).toMatch(/browser on any machine|any browser/);
    expect(loginHelp).toMatch(/opens automatically/);
    expect(loginHelp).toContain("BROWSER");
    expect(loginHelp).toContain("SSH");
    expect(loginHelp).toMatch(/Approve only a code you just started/i);

    const status = await dispatch(["auth", "status", "--help"]);
    const statusHelp = status.stdout.replace(/\s+/g, " ");
    expect(statusHelp).toMatch(/only.*stored.*this computer|only this computer's stored login/i);
    expect(statusHelp).toMatch(/ub status.*whether the hub accepts.*login/);
    for (const help of [loginHelp, statusHelp]) {
      expect(help).not.toMatch(/Other stored hubs|Other hubs|binding stays unchanged|Stored login for|GitHub username recorded at sign-in|ub open/);
    }
  });

  it("describes device revocation in auth, logout and replacement-login help", async () => {
    const group = await dispatch(["auth", "--help"]);
    expect(group.stdout).toContain("--all-devices");
    expect(group.stdout).toMatch(/logout.*Sign this computer out/);

    const logout = await dispatch(["auth", "logout", "--help"]);
    const help = logout.stdout.replace(/\s+/g, " ");
    expect(help).toContain("--all-devices");
    expect(help).toMatch(/revok.*this computer/i);
    expect(help).toMatch(/this computer last/i);
    expect(help).toMatch(/keeps? (?:the |any )?(?:local )?login/i);
    expect(help).toContain("ub auth logout --all-devices");
    expect(help).not.toMatch(/logout never revokes|No network is used/i);

    const login = await dispatch(["auth", "login", "--help"]);
    expect(login.stdout.replace(/\s+/g, " ")).toMatch(/revok.*(?:replaced|previous) device/i);
    expect(login.stdout.replace(/\s+/g, " ")).toMatch(/revocation is not confirmed.*login still succeeds.*previous device is not revoked/i);
    expect(login.stdout).not.toContain("does not revoke the previous device");
  });

  it("prints mcp's exact Basic Usage for the bare group and each help spelling", async () => {
    for (const args of [[], ["help"], ["--help"], ["-h"]]) {
      const run = await dispatch(["mcp", ...args]);
      expect(run.status).toBe(0);
      expect(run.stdout).toBe(MCP_BASIC_USAGE);
      expect(run.stderr).toBe("");
    }
    const root = await dispatch(["--help"]);
    expect(root.stdout.split("\n")).toContain("  mcp [command]          register uberblick with an MCP client");
  });

  it("refuses unknown mcp commands with the same help and no hidden command", async () => {
    for (const args of [[], ["--help"]]) {
      const run = await dispatch(["mcp", "bogus", ...args]);
      expect(run.status).toBe(2);
      expect(run.stdout).toBe("");
      expect(run.stderr).toBe(`ub mcp: unknown command "bogus"\n\n${MCP_BASIC_USAGE}`);
      expect(run.stderr).not.toContain("serve");
    }
  });

  it("keeps the hidden `mcp serve` out of the group help it is dispatched by", async () => {
    const run = await dispatch(["mcp", "--help"]);
    expect(run.status).toBe(0);
    expect(run.stdout).toMatch(/install/);
    expect(run.stdout).not.toMatch(/serve/);

    // And it keeps its own rules: no help on stdout, which is the transport.
    // `serveCommand` refuses the argument before it resolves anything, so this
    // starts no server here either.
    const serve = await dispatch(["mcp", "serve", "--help"]);
    expect(serve.status).toBe(2);
    expect(serve.stdout).toBe("");
    expect(serve.stderr).toMatch(/unexpected argument/);
  });
});

describe("help before the work", () => {
  // Two properties, one run each, because the second implies the first: help is
  // answered before validation — a missing operand, a contradiction, a bad
  // value is exactly what somebody reaching for help is likely to have — and it
  // runs none of the command. The list covers the representative mutating and
  // networked paths: a write, an SSH round trip, a hub connection, and the one
  // command that reads somebody's MCP client config. An empty stderr is the
  // other half of the proof, since every one of these announces its warnings
  // and its failures there.
  const inert: string[][] = [
    ["open", "--port", "0", "-h"],
    ["workspace", "use", "ws://example.invalid:1234", "-h"],
    ["auth", "login", "--help"],
    ["auth", "logout", "--all-devices", "--help"],
    ["mcp", "install", "claude", "--help"],
  ];
  for (const argv of inert) {
    it(`answers \`ub ${argv.join(" ")}\` with help, and runs none of it`, () => {
      const box = sandbox({
        checkout: true,
        userConfig: { workspace: WORKSPACE, hubUrl: DEAD_HUB_URL },
      });
      const before = tree(box);

      const run = runUb(argv, box);

      expect(run.status).toBe(0);
      expect(run.stderr).toBe("");
      expect(run.stdout).toMatch(/^usage: ub/);
      expect(tree(box)).toEqual(before);
    });
  }
});

describe("bare command groups", () => {
  const groups = PATHS.filter(path => path.children !== undefined);
  for (const binding of ["none", "local", "hub", "malformed"] as const) {
    it(`prints each group's help without acting with ${binding} binding`, () => {
      const box = binding === "none" ? unboundSandbox() : sandbox({
        projectBinding: { workspaceId: WORKSPACE, hubUrl: binding === "hub" ? DEAD_HUB_URL : null },
        ...(binding === "malformed" ? { raw: { projectBinding: "{" } } : {}),
      });
      const preload = join(box.cwd, "inert.mjs");
      writeFileSync(preload, `
import fs from "node:fs";
import net from "node:net";
import childProcess from "node:child_process";
import sqlite from "node:sqlite";
import { syncBuiltinESMExports } from "node:module";
const fail = () => { throw new Error("bare group must not act"); };
const open = fs.openSync;
fs.openSync = (path, ...args) => {
  if (/\\.uberblick\\.json$|(?:config|credentials)\\.json$|\\.sqlite/.test(String(path))) fail();
  return open(path, ...args);
};
fs.writeFileSync = fail;
net.Socket.prototype.connect = fail;
childProcess.spawn = fail;
childProcess.spawnSync = fail;
sqlite.DatabaseSync = fail;
globalThis.fetch = fail;
syncBuiltinESMExports();
`);
      const before = tree(box);
      for (const group of groups) {
        const invocations = group.argv[0] === "mcp"
          ? [group.argv, ...["help", "--help", "-h"].map(flag => [...group.argv, flag])]
          : [group.argv];
        for (const argv of invocations) {
          const run = runUb(argv, box, { NODE_OPTIONS: `--import=${preload}` });
          expect(run.status, run.output).toBe(0);
          expect(run.stdout).toBe(group.help);
          expect(run.stderr).toBe("");
        }
      }
      expect(tree(box)).toEqual(before);
      expect(WORKSPACE_HELP).not.toContain("(none)");
    });
  }
});

describe("what is not a request for help", () => {
  it("refuses install's bare `--` even when followed by `--help`", () => {
    // `--help` after a separator is an operand. Install rejects the removed
    // command passthrough before it can register anything.
    const run = runUb(
      ["mcp", "install", "claude", "--print", "--", "ub", "mcp", "serve", "--help"],
      sandbox(),
    );
    expect(run.status).toBe(2);
    expect(run.stdout).toBe("");
    expect(run.stderr).toContain("--");
  });

  it("omits removed install options from the parser and help", () => {
    for (const option of ["project", "workspace", "hub", "label"]) {
      expect(INSTALL_OPTIONS).not.toHaveProperty(option);
      expect(INSTALL_HELP).not.toContain(`--${option}`);
    }
    expect(INSTALL_HELP).not.toContain("-- <command>");
    expect(INSTALL_HELP).not.toContain("uberblick-<label>");
  });

  it("still refuses an unknown subcommand, `--help` after it or not", async () => {
    // A group answers for itself only when its own one argument is the
    // question. `ub workspace bogus --help` is a typo, not a request, and every
    // level says so the same way — the top level always has.
    for (const group of [[], ["workspace"], ["mcp"]]) {
      const argv = [...group, "bogus", "--help"];
      const run = await dispatch(argv);
      expect(run.status, argv.join(" ")).toBe(2);
      expect(run.stdout, argv.join(" ")).toBe("");
      expect(run.stderr, argv.join(" ")).toMatch(/bogus/);
    }
  });

  it("still refuses an unknown option, on stderr, with exit 2", async () => {
    for (const argv of [["status", "--bogus"], ["mcp", "install", "--bogus"]]) {
      const run = await dispatch(argv);
      expect(run.status, argv.join(" ")).toBe(2);
      expect(run.stdout, argv.join(" ")).toBe("");
      expect(run.stderr, argv.join(" ")).toMatch(/bogus/);
    }
  });
});


it("refuses the removed command group", async () => {
  const result = await dispatch(["remote", "join"]);
  expect(result.status).toBe(2);
  expect(result.stderr).toContain('unknown command "remote"');
});

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
import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { HELP, MCP_HELP, runCli } from "../src/cli.js";
import { DOCTOR_HELP, DOCTOR_OPTIONS } from "../src/doctor.js";
import { ENV_HELP } from "../src/env.js";
import { INIT_HELP, INIT_OPTIONS } from "../src/init.js";
import { INSTALL_HELP, INSTALL_OPTIONS } from "../src/install.js";
import { OPEN_HELP, OPEN_OPTIONS } from "../src/open.js";
import {
  REMOTE_INIT_HELP,
  REMOTE_INIT_OPTIONS,
  REMOTE_UPDATE_HELP,
  REMOTE_UPDATE_OPTIONS,
} from "../src/remote-init.js";
import {
  REMOTE_BRIDGE_OPTIONS,
  REMOTE_HELP,
  REMOTE_JOIN_HELP,
} from "../src/remote.js";
import { STATUS_HELP, STATUS_OPTIONS } from "../src/status.js";
import {
  WORKSPACE_HELP,
  WORKSPACE_LIST_HELP,
  WORKSPACE_LIST_OPTIONS,
  WORKSPACE_USE_HELP,
} from "../src/workspace.js";
import type { Run, Sandbox } from "./helpers.js";
import { DEAD_HUB_URL, PACKAGE_ROOT, removeTempDirs, runUb, sandbox } from "./helpers.js";

afterAll(removeTempDirs);

const WORKSPACE = "4d8e2f11-6a73-4c95-8b20-9e1f5c3a7d64";

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
const PATHS: Path[] = [
  {
    argv: [],
    help: HELP,
    options: {},
    children: ["init", "open", "status", "doctor", "workspace", "remote", "mcp", "env"],
  },
  { argv: ["init"], help: INIT_HELP, options: INIT_OPTIONS },
  { argv: ["open"], help: OPEN_HELP, options: OPEN_OPTIONS },
  { argv: ["status"], help: STATUS_HELP, options: STATUS_OPTIONS },
  { argv: ["doctor"], help: DOCTOR_HELP, options: DOCTOR_OPTIONS },
  {
    argv: ["workspace"],
    help: WORKSPACE_HELP,
    options: {},
    children: ["list", "use"],
  },
  { argv: ["workspace", "list"], help: WORKSPACE_LIST_HELP, options: WORKSPACE_LIST_OPTIONS },
  { argv: ["workspace", "use"], help: WORKSPACE_USE_HELP, options: {} },
  {
    argv: ["remote"],
    help: REMOTE_HELP,
    options: {},
    children: ["init", "update", "join"],
  },
  { argv: ["remote", "init"], help: REMOTE_INIT_HELP, options: REMOTE_INIT_OPTIONS },
  { argv: ["remote", "update"], help: REMOTE_UPDATE_HELP, options: REMOTE_UPDATE_OPTIONS },
  { argv: ["remote", "join"], help: REMOTE_JOIN_HELP, options: REMOTE_BRIDGE_OPTIONS },
  { argv: ["env"], help: ENV_HELP, options: {} },
  { argv: ["mcp"], help: MCP_HELP, options: {}, children: ["install"] },
  { argv: ["mcp", "install"], help: INSTALL_HELP, options: INSTALL_OPTIONS },
];

/**
 * Where the dispatch actually happens, so the manifest can be checked against
 * it: the variable each dispatcher switches on, and the path its cases hang off.
 */
const DISPATCHERS = [
  { file: "cli.ts", group: [], variable: "command" },
  { file: "cli.ts", group: ["mcp"], variable: "subcommand" },
  { file: "workspace.ts", group: ["workspace"], variable: "sub" },
  { file: "remote.ts", group: ["remote"], variable: "sub" },
];

/** Not commands: the hidden machine entry, the help words, the version flags. */
const HIDDEN = ["serve", "help", "--help", "-h", "--version", "-v"];

/** Command names and description columns from one contextual catalog. */
function commandRows(help: string): Array<{ command: string; descriptionColumn: number }> {
  const catalog = help.match(/\ncommands:\n((?: {2}.+\n)+)\noptions:\n/);
  expect(catalog, "command help contains only its catalog before its own options").not.toBeNull();

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

describe("ub init --help", () => {
  // The regression this issue is named for: top-level help advertised the
  // option and `ub init` answered `Unknown option '--help'`.
  for (const flag of ["--help", "-h"]) {
    it(`answers ${flag} with the init options, and writes nothing`, () => {
      const box = sandbox({ checkout: true });
      const before = tree(box);

      const run = runUb(["init", flag], box);

      expect(run.status).toBe(0);
      expect(run.stderr).toBe("");
      expect(run.stdout).toBe(INIT_HELP);
      expect(run.stdout).toMatch(/^usage: ub init/);
      for (const option of Object.keys(INIT_OPTIONS)) {
        expect(run.stdout).toContain(`--${option}`);
      }
      // No config, no credential, no workspace, no starter documents: asking
      // what a command does must never be the same as running it.
      expect(tree(box)).toEqual(before);
    });
  }
});

describe("every human-facing command path", () => {
  for (const path of PATHS) {
    const name = ["ub", ...path.argv].join(" ");

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
      expect(path.help, `${name} help documents -h, --help`).toContain("-h, --help");
      if (path.children !== undefined) {
        const rows = commandRows(path.help);
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
    ["init", "--yes", "--help"],
    ["init", "--mcp", "--no-mcp", "--help"],
    ["open", "--port", "0", "-h"],
    ["status", "--help"],
    ["doctor", "-h"],
    ["workspace", "use", "--help"],
    ["workspace", "use", WORKSPACE, "--help"],
    ["remote", "init", "--help"],
    ["remote", "update", "uberblick@example.invalid", "--help"],
    ["remote", "join", "ws://example.invalid:1234", "-h"],
    ["env", "--help"],
    ["mcp", "install", "zed", "--help"],
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

describe("what is not a request for help", () => {
  it("leaves `--help` after `ub mcp install`'s bare `--` in the command being registered", () => {
    // Only the first `--` is ours. Everything after it is the command that gets
    // written into a client config, verbatim — `--help` included.
    const run = runUb(
      ["mcp", "install", "claude", "--print", "--", "ub", "mcp", "serve", "--help"],
      sandbox(),
    );
    expect(run.status).toBe(0);
    expect(run.stdout).not.toBe(INSTALL_HELP);
    expect(run.stdout).toContain('"--help"');
  });

  it("still refuses an unknown subcommand, `--help` after it or not", async () => {
    // A group answers for itself only when its own one argument is the
    // question. `ub workspace bogus --help` is a typo, not a request, and every
    // level says so the same way — the top level always has.
    for (const group of [[], ["workspace"], ["remote"], ["mcp"]]) {
      const argv = [...group, "bogus", "--help"];
      const run = await dispatch(argv);
      expect(run.status, argv.join(" ")).toBe(2);
      expect(run.stdout, argv.join(" ")).toBe("");
      expect(run.stderr, argv.join(" ")).toMatch(/bogus/);
    }
  });

  it("still refuses an unknown option, on stderr, with exit 2", async () => {
    for (const argv of [["init", "--bogus"], ["status", "--bogus"], ["mcp", "install", "--bogus"]]) {
      const run = await dispatch(argv);
      expect(run.status, argv.join(" ")).toBe(2);
      expect(run.stdout, argv.join(" ")).toBe("");
      expect(run.stderr, argv.join(" ")).toMatch(/bogus/);
    }
  });
});

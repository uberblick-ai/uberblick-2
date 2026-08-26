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
 */

import { readdirSync } from "node:fs";
import { dirname } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { HELP, MCP_HELP } from "../src/cli.js";
import { DOCTOR_HELP, DOCTOR_OPTIONS } from "../src/doctor.js";
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
  REMOTE_PROMOTE_HELP,
  REMOTE_SET_HELP,
} from "../src/remote.js";
import { STATUS_HELP, STATUS_OPTIONS } from "../src/status.js";
import {
  WORKSPACE_HELP,
  WORKSPACE_LIST_HELP,
  WORKSPACE_LIST_OPTIONS,
  WORKSPACE_USE_HELP,
  WORKSPACE_USE_OPTIONS,
} from "../src/workspace.js";
import type { Sandbox } from "./helpers.js";
import { DEAD_HUB_URL, removeTempDirs, runUb, sandbox } from "./helpers.js";

afterAll(removeTempDirs);

const WORKSPACE = "4d8e2f11-6a73-4c95-8b20-9e1f5c3a7d64";

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
  { argv: [], help: HELP, options: {}, children: ["init", "open", "status", "doctor"] },
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
  { argv: ["workspace", "use"], help: WORKSPACE_USE_HELP, options: WORKSPACE_USE_OPTIONS },
  {
    argv: ["remote"],
    help: REMOTE_HELP,
    options: {},
    children: ["init", "update", "set", "promote", "join"],
  },
  { argv: ["remote", "init"], help: REMOTE_INIT_HELP, options: REMOTE_INIT_OPTIONS },
  { argv: ["remote", "update"], help: REMOTE_UPDATE_HELP, options: REMOTE_UPDATE_OPTIONS },
  { argv: ["remote", "set"], help: REMOTE_SET_HELP, options: {} },
  { argv: ["remote", "promote"], help: REMOTE_PROMOTE_HELP, options: REMOTE_BRIDGE_OPTIONS },
  { argv: ["remote", "join"], help: REMOTE_JOIN_HELP, options: REMOTE_BRIDGE_OPTIONS },
  { argv: ["mcp"], help: MCP_HELP, options: {}, children: ["install"] },
  { argv: ["mcp", "install"], help: INSTALL_HELP, options: INSTALL_OPTIONS },
];

/** Everything under the sandbox root, so "it wrote nothing" is checkable. */
function tree(box: Sandbox): string[] {
  const root = dirname(box.cwd);
  return readdirSync(root, { recursive: true, encoding: "utf8" }).sort();
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

    it(`answers --help and -h on \`${name}\``, () => {
      for (const flag of ["--help", "-h"]) {
        const run = runUb([...path.argv, flag], sandbox());
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
      // More than a usage line: every path says what it is for.
      expect(path.help.trim().split("\n").length).toBeGreaterThan(3);
      for (const child of path.children ?? []) {
        expect(path.help, `${name} help lists ${child}`).toContain(child);
      }
    });
  }

  it("keeps the hidden `mcp serve` out of the group help it is dispatched by", () => {
    const run = runUb(["mcp", "--help"], sandbox());
    expect(run.status).toBe(0);
    expect(run.stdout).toMatch(/install/);
    expect(run.stdout).not.toMatch(/serve/);

    // And it keeps its own rules: no help on stdout, which is the transport.
    const serve = runUb(["mcp", "serve", "--help"], sandbox());
    expect(serve.status).toBe(2);
    expect(serve.stdout).toBe("");
    expect(serve.stderr).toMatch(/unexpected argument/);
  });
});

describe("help before the work", () => {
  // A missing operand or a contradiction is what somebody reaching for help is
  // most likely to have; answering it with a usage error would be answering the
  // wrong question.
  const overruled: string[][] = [
    ["workspace", "use", "--help"],
    ["remote", "set", "--help"],
    ["remote", "promote", "-h"],
    ["remote", "init", "--help"],
    ["init", "--mcp", "--no-mcp", "--help"],
    ["mcp", "install", "zed", "--help"],
    ["open", "--port", "0", "-h"],
  ];
  for (const argv of overruled) {
    it(`answers \`ub ${argv.join(" ")}\` with help rather than a usage error`, () => {
      const run = runUb(argv, sandbox());
      expect(run.status).toBe(0);
      expect(run.stderr).toBe("");
      expect(run.stdout).toMatch(/^usage: ub/);
    });
  }

  // The representative mutating and networked paths: a write, an SSH round
  // trip, a hub connection, and the one command that reads somebody's MCP
  // client config. An empty stderr is the second half of the proof — every one
  // of these announces its warnings and its failures there.
  const inert: string[][] = [
    ["init", "--yes", "--help"],
    ["workspace", "use", WORKSPACE, "--help"],
    ["remote", "set", "ws://example.invalid:1234", "--help"],
    ["remote", "promote", "ws://example.invalid:1234", "--help"],
    ["remote", "join", "ws://example.invalid:1234", "-h"],
    ["remote", "update", "uberblick@example.invalid", "--help"],
    ["mcp", "install", "claude", "--help"],
    ["status", "--help"],
    ["doctor", "-h"],
  ];
  for (const argv of inert) {
    it(`runs none of \`ub ${argv.join(" ")}\` — no write, no connection`, () => {
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

  it("still refuses an unknown option, on stderr, with exit 2", () => {
    for (const argv of [["init", "--bogus"], ["status", "--bogus"], ["mcp", "install", "--bogus"]]) {
      const run = runUb(argv, sandbox());
      expect(run.status, argv.join(" ")).toBe(2);
      expect(run.stdout, argv.join(" ")).toBe("");
      expect(run.stderr, argv.join(" ")).toMatch(/bogus/);
    }
  });
});

/**
 * Contextual help as a contract of the whole `ub` surface.
 *
 * The declared command tree supplies every human-facing path, its help and
 * parser options. Both help spellings exit 0 on stdout, and the option names
 * are checked against the parser surface rather than a copy that can go stale.
 *
 * The other half is what help must *not* do: it is answered before validation,
 * before a missing operand is noticed, and before anything is written,
 * connected to, prompted for, or read out of somebody's MCP client config.
 *
 * Dispatcher cases check streams and help selection; representative spawned
 * cases prove that real files stay untouched.
 */

import { createHash } from "node:crypto";
import { readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { COMMAND_TREE, MCP_HELP, runCli } from "../src/cli.js";
import type { Command } from "../src/command.js";
import { OPEN_HELP } from "../src/open.js";
import { WORKSPACE_HELP } from "../src/workspace.js";
import type { Run, Sandbox } from "./helpers.js";
import { DEAD_HUB_URL, removeTempDirs, runUb, sandbox } from "./helpers.js";

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

it("rejects the hidden browser option", async () => {
  const refused = await dispatch(["open", "--browser"]);
  expect(refused.status).toBe(2);
  expect(refused.stdout).toBe("");
  expect(refused.stderr).toContain("Unknown option '--browser'");
  expect(refused.stderr).toContain(OPEN_HELP);
});

it("refuses an invalid explicit web port", async () => {
  const refused = await dispatch(["open", "--port", "0"]);
  expect(refused.status).toBe(2);
  expect(refused.stdout).toBe("");
  expect(refused.stderr).toContain("--port must be an integer in 1..65535");
});

/** As much of a `parseArgs` option map as this suite reads. */
type Options = Readonly<
  Record<string, { readonly type: string; readonly short?: string | undefined }>
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
function humanPaths(entry: Command): Path[] {
  if ("hidden" in entry && entry.hidden) return [];
  const path = { argv: [...entry.path], help: entry.help };
  if (!("children" in entry)) return [{ ...path, options: entry.options }];
  return [
    {
      ...path,
      options: {},
      children: entry.children
        .filter(child => !("hidden" in child && child.hidden))
        .map(child => child.path.at(-1) as string),
    },
    ...entry.children.flatMap(humanPaths),
  ];
}

const PATHS = humanPaths(COMMAND_TREE);

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
  }

  for (const path of PATHS) {
    const name = ["ub", ...path.argv].join(" ");
    const isAuthGroup = path.argv.length === 1 && path.argv[0] === "auth";
    const isMcpGroup = path.argv.length === 1 && path.argv[0] === "mcp";

    it(`documents the structure of \`${name}\``, () => {
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

  it("refuses unknown mcp commands with the same help and no hidden command", async () => {
    for (const args of [[], ["--help"]]) {
      const run = await dispatch(["mcp", "bogus", ...args]);
      expect(run.status).toBe(2);
      expect(run.stdout).toBe("");
      expect(run.stderr).toBe(`ub mcp: unknown command "bogus"\n\n${MCP_HELP}`);
      expect(run.stderr).not.toContain("serve");
    }
  });

  it("keeps the hidden `mcp serve` out of the group help it is dispatched by", async () => {
    const run = await dispatch(["mcp", "--help"]);
    expect(run.status).toBe(0);
    expect(run.stdout).not.toMatch(/serve/);

    // And it keeps its own rules: no help on stdout, which is the transport.
    // The dispatcher refuses the argument before resolving anything, so this
    // starts no server here either.
    const serve = await dispatch(["mcp", "serve", "--help"]);
    expect(serve.status).toBe(2);
    expect(serve.stdout).toBe("");
    expect(serve.stderr).toBe('ub mcp serve: unexpected argument "--help"\n');
  });
});

describe("help before the work", () => {
  for (const path of PATHS.filter(path => path.children === undefined)) {
    it(`answers help before parsing on \`ub ${path.argv.join(" ")}\``, async () => {
      for (const flag of ["--help", "-h"]) {
        const run = await dispatch([...path.argv, "--bogus", flag, "extra"]);
        expect(run.status).toBe(0);
        expect(run.stdout).toBe(path.help);
        expect(run.stderr).toBe("");
      }
    });
  }

  it.each([
    ["workspace", "use", "-h", "ws://example.invalid:1234"],
    ["mcp", "install", "claude", "--help"],
  ])("answers help before validation and leaves files untouched: %j", (...argv) => {
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
});

describe("bare command groups", () => {
  it("prints every group's own help for a bare group and each help command slot", async () => {
    for (const group of PATHS.filter(path => path.children !== undefined)) {
      for (const command of [[], ["help"], ["--help"], ["-h"]]) {
        const run = await dispatch([...group.argv, ...command]);
        expect(run.status, [...group.argv, ...command].join(" ")).toBe(0);
        expect(run.stdout).toBe(group.help);
        expect(run.stderr).toBe("");
      }
    }
  });

  it("acts on nothing, even with a malformed binding", () => {
    const box = sandbox({ raw: { projectBinding: "{" } });
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
    const run = runUb(["workspace"], box, { NODE_OPTIONS: `--import=${preload}` });
    expect(run.status, run.output).toBe(0);
    expect(run.stdout).toBe(WORKSPACE_HELP);
    expect(run.stderr).toBe("");
    expect(tree(box)).toEqual(before);
  });
});

describe("what is not a request for help", () => {
  it("reports an unknown client and a missing workspace target as usage errors", async () => {
    const unknownClient = await dispatch(["mcp", "install", "not-a-client"]);
    expect(unknownClient.status).toBe(2);
    expect(unknownClient.stdout).toBe("");
    expect(unknownClient.stderr).toMatch(/unknown client/);

    const missingTarget = await dispatch(["workspace", "use"]);
    expect(missingTarget.status).toBe(2);
    expect(missingTarget.stdout).toBe("");
    expect(missingTarget.stderr).toContain("expected exactly one workspace link or id");
    expect(missingTarget.stderr).toMatch(/^usage: ub workspace use /m);
  });

  it("stops searching for help at --", async () => {
    for (const path of PATHS.filter(path => path.argv[0] === "auth" || path.argv[0] === "data")
      .filter(path => path.children === undefined)) {
      for (const flag of ["--help", "-h"]) {
        const run = await dispatch([...path.argv, "--", flag, "extra", "third"]);
        expect(run.status, path.argv.join(" ")).toBe(2);
        expect(run.stdout).toBe("");
        expect(run.stderr).toContain(`\n\n${path.help}`);
      }
    }
    const box = sandbox();
    const before = tree(box);
    const run = runUb(["mcp", "install", "claude", "--print", "--", "--help"], box);
    expect(run.status).toBe(2);
    expect(run.stdout).toBe("");
    expect(run.stderr).toContain('"--"');
    expect(tree(box)).toEqual(before);
  });

  it("refuses unknown subcommands with an error and the group's usage", async () => {
    for (const group of PATHS.filter(path => path.children !== undefined)) {
      const prefix = ["ub", ...group.argv].join(" ");
      const error = `${prefix}: unknown command${group.argv[0] === "auth" ? "" : ' "bogus"'}`;
      for (const args of [[], ["--help"], ["-h"]]) {
        const run = await dispatch([...group.argv, "bogus", ...args]);
        expect(run.status).toBe(2);
        expect(run.stdout).toBe("");
        expect(run.stderr).toBe(`${error}\n\n${group.help}`);
      }
    }
    const box = sandbox();
    const before = tree(box);
    const run = runUb(["workspace", "bogus"], box);
    expect(run.status).toBe(2);
    expect(run.stdout).toBe("");
    expect(run.stderr).toBe(`ub workspace: unknown command "bogus"\n\n${WORKSPACE_HELP}`);
    expect(tree(box)).toEqual(before);
  });

  it("refuses unknown options with an error and usage, without writing", async () => {
    for (const path of PATHS.filter(path => path.children === undefined)) {
      const prefix = ["ub", ...(path.argv[0] === "data" ? ["data"] : path.argv)].join(" ");
      const run = await dispatch([...path.argv, "--bogus"]);
      expect(run.status).toBe(2);
      expect(run.stdout).toBe("");
      expect(run.stderr).toMatch(new RegExp(`^${prefix}: `));
      expect(run.stderr.endsWith(`\n\n${path.help}`)).toBe(true);
      if (path.argv[0] === "auth") {
        expect(run.stderr).toBe(`${prefix}: unknown option\n\n${path.help}`);
      } else if (path.argv[0] !== "update") {
        expect(run.stderr).toContain("Unknown option '--bogus'");
      }
    }
    const box = sandbox();
    const before = tree(box);
    const run = runUb(["open", "--bogus"], box);
    expect(run.status).toBe(2);
    expect(run.stdout).toBe("");
    expect(run.stderr).toContain("Unknown option '--bogus'");
    expect(run.stderr).toContain(`\n\n${OPEN_HELP}`);
    expect(tree(box)).toEqual(before);
  });
});

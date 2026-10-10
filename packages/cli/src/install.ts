/**
 * `ub mcp install <client>` — register uberblick with an MCP client.
 *
 * Every entry is a plain `ub mcp serve`, following the project's binding when
 * the client starts it. Install needs no workspace selection. Credentials stay
 * in the private user store; they never enter the MCP configuration.
 *
 * **This command does not edit config files.** Claude Code ships `claude mcp
 * add` and Codex ships `codex mcp add`, so those are run, and the vendor writes
 * its own file. A client `ub` has never heard of gets the snippet to paste and
 * its own MCP configuration as the destination, because there is no
 * path to invent for a client nobody has described. Editing somebody else's
 * JSON or TOML in place bought one thing, an untouched file, at the price of a
 * parser per format; delegating and printing buy the same thing outright.
 *
 * **What it refuses.** Before running a vendor CLI it reads the target file for
 * one answer only (`presence`): an entry that is already ours is a no-op, an
 * entry that is somebody else's is left alone and the snippet is printed
 * instead, a file that is there and cannot be read is refused by path — nothing
 * is delegated to a vendor CLI over a file whose contents nobody here knows —
 * and anything else is added. There is no `--force`, no backup and no
 * rewrite — the file this command does not write is the file it cannot damage.
 * Nothing here prompts, so the whole command runs unattended.
 */

import { spawnSync } from "node:child_process";
import { mkdirSync, rmdirSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { findProjectConfig, PROJECT_CONFIG_FILE, resolveProjectBinding } from "./project-binding.js";
import { takeHelp } from "./help.js";
import type { Io } from "./io.js";
import { processIo } from "./io.js";
import type { Entry, Scope, TargetFile, TargetName } from "./mcp-config.js";
import {
  DEFAULT_ENTRY,
  TARGETS,
  codexHome,
  presence,
  snippet,
  targetFile,
} from "./mcp-config.js";

interface Flags {
  target: TargetName | null;
  /**
   * A client this command does not know, named anyway. Only reachable with
   * `--print`, which is the answer for one: it gets the generic stdio snippet.
   */
  unlisted: string | null;
  scope: Scope;
  print: boolean;
}

/** Exported so the help below can be checked against the parser it describes. */
export const INSTALL_OPTIONS = {
  project: { type: "boolean", default: false },
  user: { type: "boolean", default: false },
  print: { type: "boolean", default: false },
} as const;

export const INSTALL_HELP = `usage: ub mcp install <client> [options]

Register uberblick with an MCP client using a plain \`ub mcp serve\` entry.
Agents follow the nearest .uberblick.json in the project where they start.
Install needs no workspace selection. Credentials stay in the private user
store and are never copied into an MCP entry.

Claude Code and Codex are wired up by running their own \`mcp add\` command, so
the vendor writes its own file. A client \`ub\` does not know gets the snippet,
to paste into that client's own MCP configuration. This command edits no config
file, and never replaces an entry it did not register.

operands:
  client            one of: ${TARGETS.join(", ")}.
                    Any other name needs --print, which gives the generic stdio
                    snippet to paste into that client's own config.

options:
  --project         this directory's config (the default)
  --user            the per-user config
  --print           print the snippet to paste, and run nothing
  -h, --help        show this help

A second run reports \`already installed\`. An entry somebody else wrote under the
name \`uberblick\` is never replaced: it is reported, the snippet is printed, and
the file is left exactly as it was.
`;

function parseFlags(argv: string[]): Flags | null {
  if (argv.includes("--")) {
    throw new Error("unexpected argument \"--\"");
  }
  const { values, positionals } = parseArgs({
    args: argv,
    options: INSTALL_OPTIONS,
    allowPositionals: true,
  });

  if (positionals.length > 1) {
    throw new Error(`unexpected argument ${JSON.stringify(positionals[1])}`);
  }
  const named = positionals[0];
  if (named === undefined) return null;
  const known = TARGETS.includes(named as TargetName);
  if (!known && values.print !== true) {
    throw new Error(
      `unknown client ${JSON.stringify(named)} — expected one of ${TARGETS.join(", ")}. ` +
        "Add --print for the snippet to paste into any other client",
    );
  }
  if (values.project === true && values.user === true) {
    throw new Error("--project and --user contradict each other");
  }

  return {
    target: known ? (named as TargetName) : null,
    unlisted: known ? null : named,
    // Project scope is the default because it is the one that travels with the
    // work; the report always names the absolute file, so it is never a guess.
    scope: values.user === true ? "user" : "project",
    print: values.print === true,
  };
}

/** The command as somebody would type it, for the report. */
function commandLine(entry: Entry): string {
  return [entry.command, ...entry.args].join(" ");
}

/** Describe the entry's future selection, independently of this shell's overrides. */
function workspaceReport(scope: Scope, cwd: string, io: Io): string {
  if (scope === "user") {
    return field("workspace", "follows the nearest .uberblick.json of each project");
  }
  let path = join(cwd, PROJECT_CONFIG_FILE);
  let selected = false;
  try {
    path = findProjectConfig(cwd) ?? path;
    selected = resolveProjectBinding({ cwd, env: {} }).binding !== null;
  } catch {
    // A missing or invalid binding does not prevent registration. Do not repeat
    // its contents or a parser diagnostic: only workspace selection is needed.
  }
  if (!selected) {
    io.err("ub mcp install: agents cannot start until a workspace is selected. " +
      "Run `ub workspace create <name>` or `ub workspace use <link|id>`.\n");
  }
  return field("workspace", `follows ${path}`);
}

function field(name: string, value: string): string {
  return `${name.padEnd(12)}${value}\n`;
}

// --- the vendor CLIs --------------------------------------------------------

interface Vendor {
  program: string;
  args: string[];
  /** What the program needs in its environment to write *this* run's file. */
  env: NodeJS.ProcessEnv;
}

/** The vendor's own installer for this target and scope. */
function vendorCli(
  target: TargetName,
  scope: Scope,
  entry: Entry,
  cwd: string,
): Vendor {
  const command = [entry.command, ...entry.args];
  if (target === "claude") {
    return {
      program: "claude",
      args: [
        "mcp",
        "add",
        entry.name,
        "--scope",
        scope,
        "--",
        ...command,
      ],
      env: {},
    };
  }
  return {
    program: "codex",
    args: [
      "mcp",
      "add",
      entry.name,
      "--",
      ...command,
    ],
    // `codex mcp add` has no scope flag; the scope *is* which configuration
    // directory it is pointed at, and `targetFile` resolves the same one — so
    // both agree on the file by construction rather than by coincidence.
    env: scope === "project" ? { CODEX_HOME: codexHome(cwd) } : {},
  };
}

/** A variable `ub` resolves its own configuration from — see `config.ts`. */
function isOurs(name: string): boolean {
  return (
    name.startsWith("HUB_") ||
    name === "UB_WORKSPACE_ID" ||
    name === "UB_HUB_URL" ||
    name.startsWith("UBERBLICK_") ||
    name === "WORKSPACE_ID" ||
    name === "WORKSPACES"
  );
}

/**
 * The environment a vendor CLI is handed: this process's, minus uberblick's own.
 *
 * `ub` is habitually run with a signing secret and an endpoint exported — that
 * is what `fnox exec` does — and a child inherits whatever it is given. No
 * vendor CLI has any use for either, and a client that logs its environment, or
 * records it into a session file, would be carrying this machine's credential
 * into somebody else's format. The only thing added is the vendor's own
 * {@link Vendor.env}, which is `CODEX_HOME` saying which file codex writes.
 */
function vendorEnv(vendor: Vendor): NodeJS.ProcessEnv {
  const inherited: NodeJS.ProcessEnv = {};
  for (const [name, value] of Object.entries(process.env)) {
    if (!isOurs(name)) inherited[name] = value;
  }
  return { ...inherited, ...vendor.env };
}

type VendorRun =
  | { kind: "ok" }
  /** The program is not installed — the caller prints the snippet instead. */
  | { kind: "absent" }
  | { kind: "failed"; because: string };

/**
 * Run a vendor's installer, and learn nothing from it but whether it worked.
 *
 * Its output is discarded rather than captured, because a client's own
 * diagnostics quote the config it just read — `claude mcp add` naming a
 * conflicting server, a loader complaining about a value it could not parse —
 * and relaying that would hand back exactly what this command refuses to print.
 * The same rule as everywhere else here: when in doubt, omit. What is left is
 * enough to act on — which program ran and how it exited — and the caller says
 * how to see the rest, which is to run the vendor's command yourself.
 */
function runVendor(vendor: Vendor): VendorRun {
  const result = spawnSync(vendor.program, vendor.args, {
    stdio: "ignore",
    env: vendorEnv(vendor),
  });
  if (result.error !== undefined) {
    const code = (result.error as NodeJS.ErrnoException).code;
    return code === "ENOENT"
      ? { kind: "absent" }
      : { kind: "failed", because: `it could not be started (${code ?? "unknown"})` };
  }
  if (result.status === 0) {
    return { kind: "ok" };
  }
  return {
    kind: "failed",
    because:
      result.status === null
        ? `it was killed by ${result.signal ?? "a signal"}`
        : `it exited ${result.status}`,
  };
}

// --- the command ------------------------------------------------------------

/** Print the entry and its destination without claiming registration. */
function printSnippet(
  io: Io,
  file: TargetFile,
  entry: Entry,
  because: string,
): number {
  io.err(`ub mcp install: ${because} — paste this into ${file.path}\n`);
  io.out(snippet(file.format, entry));
  return 0;
}

export async function installCommand(
  argv: string[],
  io: Io = processIo,
): Promise<number> {
  if (takeHelp(argv, io, INSTALL_HELP)) return 0;

  let flags: Flags | null;
  try {
    flags = parseFlags(argv);
  } catch (error) {
    io.err(
      `ub mcp install: ${error instanceof Error ? error.message : String(error)}\n`,
    );
    return 2;
  }
  if (flags === null) {
    io.err(`ub mcp install: missing client\n\n${INSTALL_HELP}`);
    return 2;
  }

  const entry = DEFAULT_ENTRY;

  // A client this command does not know is exactly what `--print` is for, and
  // it is answered before anything looks at the filesystem: there is no file of
  // ours to look at.
  if (flags.target === null) {
    io.err(
      `ub mcp install: ${JSON.stringify(flags.unlisted)} is not a client \`ub\` ` +
        "knows, so there is no file of ours to name — paste this generic stdio " +
        "form into that client's own MCP configuration\n",
    );
    io.out(snippet("json", entry));
    return 0;
  }

  const cwd = process.cwd();
  const file = targetFile(flags.target, flags.scope, cwd);
  const where = `${flags.target} (${flags.scope})`;

  if (flags.print) {
    return printSnippet(io, file, entry, "--print runs nothing");
  }

  const vendor = vendorCli(flags.target, flags.scope, entry, cwd);
  const installed = presence(file, entry);
  if (installed === "ours") {
    let report = "already installed\n\n";
    report += field("client", where);
    report += field("file", file.path);
    report += field("command", commandLine(entry));
    report += workspaceReport(flags.scope, cwd, io);
    report += "\nNothing was run or written.\n";
    io.out(report);
    return 0;
  }
  if (installed === "unusable") {
    // Not "absent, so go ahead": delegating would point a vendor CLI at a file
    // this could not read, and `claude mcp add` rewrites the file it loads.
    // Reported by path with nothing of it quoted — a file that will not parse
    // is still a config file, which is where people keep tokens.
    io.err(
      `ub mcp install: ${file.path} is there and could not be read, so nothing ` +
        "was run against it and nothing was written. This is what uberblick " +
        "would have registered; repair or move that file, or paste this in by " +
        "hand\n",
    );
    io.out(snippet(file.format, entry));
    return 1;
  }
  if (installed === "foreign") {
    // Every differing entry, including a manually configured environment,
    // belongs to the caller and must be preserved.
    io.err(
      `ub mcp install: ${file.path} already registers "${entry.name}" as ` +
        "something other than this, so it was left alone. Nothing was " +
        "written — this is what uberblick would have registered; replace that " +
        "entry by hand, or remove it and run this again\n",
    );
    io.out(snippet(file.format, entry));
    return 1;
  }

  // `codex mcp add` refuses outright when the directory `CODEX_HOME` names is
  // not there, and for `--project` that directory is the checkout's own — so it
  // is created. `mkdirSync` answers with the path it made and with `undefined`
  // when there was nothing to make, which is the only honest way to know whose
  // directory this is: a `.codex` the checkout already had is somebody's state,
  // empty or not, and is never removed.
  const codexProject = flags.target === "codex" && flags.scope === "project";
  const made =
    codexProject && mkdirSync(codexHome(cwd), { recursive: true }) !== undefined;
  let registered = false;
  try {
    const ran = runVendor(vendor);
    if (ran.kind === "absent") {
      printSnippet(io, file, entry, `\`${vendor.program}\` is not installed`);
      return 1;
    }
    if (ran.kind === "failed") {
      io.err(
        `ub mcp install: \`${vendor.program} mcp add\` failed — ${ran.because}. ` +
          "Its output is not repeated here because a client's diagnostics can " +
          `quote the config; run \`${vendor.program} mcp add\` yourself to see it\n`,
      );
      printSnippet(io, file, entry, "the client did not register the entry");
      return 1;
    }

    registered = true;
    let report = `uberblick registered with ${flags.target}\n\n`;
    report += field("client", where);
    report += field("file", file.path);
    report += field("command", commandLine(entry));
    report += field("ran", `${vendor.program} ${vendor.args.join(" ")}`);
    report += workspaceReport(flags.scope, cwd, io);
    report += "\nRestart running agents to pick this up.\n";
    io.out(report);
    return 0;
  } finally {
    // Every ending but a registration — the vendor missing, the vendor
    // refusing, a throw — leaves the checkout as this run found it. `rmdirSync`
    // refuses a directory with anything in it, which is the check that codex
    // did not write a config there after all.
    if (made && !registered) {
      try {
        rmdirSync(codexHome(cwd));
      } catch {
        // Something is in it. Leaving it is the whole intent.
      }
    }
  }
}

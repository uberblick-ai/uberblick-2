import { spawnSync } from "node:child_process";
import { mkdirSync, rmdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { parseArgs } from "node:util";
import { findProjectConfig, PROJECT_CONFIG_FILE, resolveProjectBinding } from "@uberblick/mcp-server/project-binding";
import { takeHelp } from "./help.js";
import type { Io } from "./io.js";
import { processIo } from "./io.js";
import { field } from "./strings.js";
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
  unlisted: string | null;
  scope: Scope;
  print: boolean;
}

/** Exported so the help below can be checked against the parser it describes. */
export const INSTALL_OPTIONS = {
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
  return {
    target: known ? (named as TargetName) : null,
    unlisted: known ? null : named,
    scope: values.user === true ? "user" : "project",
    print: values.print === true,
  };
}

function commandLine(entry: Entry): string {
  return [entry.command, ...entry.args].join(" ");
}

interface ProjectContext {
  root: string;
  path: string;
  selected: boolean;
  bindingProblem?: string;
}

/** Use identical binding validation for target and report, excluding shell overrides. */
function projectContext(cwd: string): ProjectContext {
  let path = join(cwd, PROJECT_CONFIG_FILE);
  let selected = false;
  let bindingProblem: string | undefined;
  try {
    path = findProjectConfig(cwd) ?? path;
    const resolved = resolveProjectBinding({ cwd, env: {} });
    selected = resolved.binding !== null;
    bindingProblem = resolved.bindingProblem;
  } catch {
    // Binding contents and parser diagnostics may contain private values.
  }
  return { root: selected ? dirname(path) : cwd, path, selected,
    ...(bindingProblem === undefined ? {} : { bindingProblem }),
  };
}

function workspaceReport(project: ProjectContext | null, io: Io): string {
  if (project === null) {
    return field("workspace", "follows the nearest .uberblick.json of each project");
  }
  if (!project.selected) {
    io.err("ub mcp install: agents cannot start until a workspace is selected. " +
      "Run `ub workspace create <name>` or `ub workspace use <link|id>`.\n");
  }
  return field("workspace", `follows ${project.path}`);
}

interface Vendor {
  program: string;
  args: string[];
  /** What the program needs in its environment to write *this* run's file. */
  env: NodeJS.ProcessEnv;
}

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
    // Codex has no scope flag; share targetFile's project directory via CODEX_HOME.
    env: scope === "project" ? { CODEX_HOME: codexHome(cwd) } : {},
  };
}

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
 * Strip Uberblick configuration and credentials before invoking a vendor that
 * may record its environment. Add only the vendor's target-directory override.
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
  | { kind: "absent" }
  | { kind: "failed"; because: string };

/**
 * Run unattended and discard vendor output: diagnostics can quote private
 * config values. Report only the program and its exit result.
 */
function runVendor(vendor: Vendor, cwd: string): VendorRun {
  const result = spawnSync(vendor.program, vendor.args, {
    cwd,
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

  // Unknown clients have no known config path; answer before filesystem reads.
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
  const project = flags.scope === "project" ? projectContext(cwd) : null;
  if (project?.bindingProblem !== undefined) io.err(`ub mcp install: ${project.bindingProblem}\n`);
  const root = project?.root ?? cwd;
  const file = targetFile(flags.target, flags.scope, root);
  const where = `${flags.target} (${flags.scope})`;

  if (flags.print) {
    return printSnippet(io, file, entry, "--print runs nothing");
  }

  const vendor = vendorCli(flags.target, flags.scope, entry, root);
  const installed = presence(file, entry);
  if (installed === "ours") {
    let report = "already installed\n\n";
    report += field("client", where);
    report += field("file", file.path);
    report += field("command", commandLine(entry));
    report += workspaceReport(project, io);
    report += "\nNothing was run or written.\n";
    io.out(report);
    return 0;
  }
  if (installed === "unusable") {
    // An unreadable config is not empty; never delegate a write over it.
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
    io.err(
      `ub mcp install: ${file.path} already registers "${entry.name}" as ` +
        "something other than this, so it was left alone. Nothing was " +
        "written — this is what uberblick would have registered; replace that " +
        "entry by hand, or remove it and run this again\n",
    );
    io.out(snippet(file.format, entry));
    return 1;
  }

  // Codex requires CODEX_HOME to exist. Only a directory this mkdir created is
  // ours to remove on failure; a pre-existing empty directory is caller state.
  const codexProject = flags.target === "codex" && flags.scope === "project";
  const made =
    codexProject && mkdirSync(codexHome(root), { recursive: true }) !== undefined;
  let registered = false;
  try {
    const ran = runVendor(vendor, root);
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
    report += workspaceReport(project, io);
    report += "\nRestart running agents to pick this up.\n";
    io.out(report);
    return 0;
  } finally {
    // Remove only our empty failed-install directory; rmdir preserves vendor writes.
    if (made && !registered) {
      try {
        rmdirSync(codexHome(root));
      } catch {
        // Preserve anything the vendor wrote despite reporting failure.
      }
    }
  }
}

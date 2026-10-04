/**
 * `ub mcp install [client]` — register uberblick with an MCP client.
 *
 * Every entry pins the selected workspace and hub together. The selection comes
 * from the shared project/environment resolver unless `--workspace` and `--hub`
 * explicitly replace the complete binding. Credentials stay in the private
 * user store; they never enter the committable MCP configuration.
 *
 * `--label` gives a binding its own `uberblick-<label>` entry, so independent
 * processes in one agent session can work with different workspaces or hubs.
 * Later changes to the project binding do not redirect installed entries.
 *
 * **This command does not edit config files.** Claude Code ships `claude mcp
 * add` and Codex ships `codex mcp add` — including the environment flags a
 * binding needs — so those are run, and the vendor writes its own
 * file. Cursor ships no such subcommand, so it gets the snippet to paste and
 * the path to paste it into; a client `ub` has never heard of gets the same
 * snippet and its own MCP configuration as the destination, because there is no
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
import { parseArgs } from "node:util";
import { requireBinding, resolveConfig } from "./config.js";
import { takeHelp } from "./help.js";
import type { Io } from "./io.js";
import { processIo } from "./io.js";
import type { Entry, Scope, TargetFile, TargetName } from "./mcp-config.js";
import {
  DEFAULT_ENTRY,
  SERVER_NAME,
  TARGETS,
  codexHome,
  presence,
  snippet,
  targetFile,
} from "./mcp-config.js";
import type { WorkspaceEntry } from "./workspace.js";
import { listWorkspaces, resolveWorkspaceId } from "./workspace.js";

/** The default when `ub mcp install` is run with no target named. */
const DEFAULT_TARGET: TargetName = "claude";

interface Flags {
  target: TargetName;
  /**
   * A client this command does not know, named anyway. Only reachable with
   * `--print`, which is the answer for one: it gets the generic stdio snippet.
   */
  unlisted: string | null;
  scope: Scope;
  print: boolean;
  /** The workspace to pin the entry to, as it was typed. */
  workspace: string | null;
  /** The hub paired with an explicit workspace, or "local". */
  hub: string | null;
  /** A separately named entry to pin instead of the primary one. */
  label: string | null;
  /** The command to install, when `-- …` overrode it. */
  entry: Entry;
}

/**
 * A label that is a plain key in both formats a client config can be.
 *
 * The entry name is `uberblick-<label>`, and that name is a JSON member and a
 * TOML table header. Keeping it to the bare-key alphabet is what lets both be
 * written without quoting rules, and it keeps the name typeable — it is what
 * the agent session will call the toolset.
 */
const LABEL = /^[A-Za-z0-9][A-Za-z0-9_-]*$/;

/**
 * Everything after a bare `--` is the command to install, verbatim.
 *
 * It is taken before `parseArgs` sees it because the override is frequently a
 * command with `--` in it of its own — a wrapper such as
 * `fnox exec -- ub mcp serve` — and only the first separator is ours.
 */
function splitOverride(argv: string[]): {
  flags: string[];
  override: string[] | null;
} {
  const cut = argv.indexOf("--");
  return cut === -1
    ? { flags: argv, override: null }
    : { flags: argv.slice(0, cut), override: argv.slice(cut + 1) };
}

/** Exported so the help below can be checked against the parser it describes. */
export const INSTALL_OPTIONS = {
  project: { type: "boolean", default: false },
  user: { type: "boolean", default: false },
  print: { type: "boolean", default: false },
  workspace: { type: "string" },
  hub: { type: "string" },
  label: { type: "string" },
} as const;

export const INSTALL_HELP = `usage: ub mcp install [client] [options] [-- <command>]

Register uberblick with an MCP client using \`ub mcp serve\`. The entry pins
UB_WORKSPACE_ID and UB_HUB_URL from the selected project/environment binding.
Use --workspace and --hub together to select a different pair. Credentials stay
in the private user store and are never copied into an MCP entry.

Claude Code and Codex are wired up by running their own \`mcp add\` command, so
the vendor writes its own file. Cursor gets the snippet to paste and the path to
paste it into; a client \`ub\` does not know gets the same snippet, to paste into
that client's own MCP configuration. This command edits no config file, and
never replaces an entry it did not register.

operands:
  client            one of: ${TARGETS.join(", ")} (default ${DEFAULT_TARGET}).
                    Any other name needs --print, which gives the generic stdio
                    snippet to paste into that client's own config.

options:
  --project         this directory's config (the default)
  --user            the per-user config
  --print           print the snippet to paste, and run nothing
  --workspace <id>  select a workspace UUID or a unique local UUID prefix;
                    requires --hub
  --hub <url|local> select the matching hub, or local-only; requires --workspace
  --label <label>   name this entry "uberblick-<label>" instead of "uberblick",
                    allowing several independent bindings in one project
  -h, --help        show this help
  -- <command>      register this command instead of uberblick's own. Only the
                    first \`--\` is ours; everything after it is passed through
                    verbatim, including further \`--\` and \`--help\`.

A second run reports \`already installed\`. An entry somebody else wrote under the
name \`uberblick\` is never replaced: it is reported, the snippet is printed, and
the file is left exactly as it was.
`;

function parseFlags(argv: string[]): Flags {
  const { flags, override } = splitOverride(argv);
  const { values, positionals } = parseArgs({
    args: flags,
    options: INSTALL_OPTIONS,
    allowPositionals: true,
  });

  if (positionals.length > 1) {
    throw new Error(`unexpected argument ${JSON.stringify(positionals[1])}`);
  }
  const named = positionals[0];
  const known = named !== undefined && TARGETS.includes(named as TargetName);
  if (named !== undefined && !known && values.print !== true) {
    throw new Error(
      `unknown client ${JSON.stringify(named)} — expected one of ${TARGETS.join(", ")}. ` +
        "Add --print for the snippet to paste into any other client",
    );
  }
  if (values.project === true && values.user === true) {
    throw new Error("--project and --user contradict each other");
  }
  if (override !== null && override.length === 0) {
    throw new Error("`--` must be followed by the command to install");
  }
  const label = values.label ?? null;
  if ((values.workspace === undefined) !== (values.hub === undefined)) {
    throw new Error("--workspace and --hub must be supplied together");
  }
  if (label !== null && !LABEL.test(label)) {
    throw new Error(
      `--label ${JSON.stringify(label)} cannot be part of an entry name — ` +
        'letters, digits, "-" and "_", starting with a letter or a digit',
    );
  }

  return {
    target: known ? (named as TargetName) : DEFAULT_TARGET,
    unlisted: known || named === undefined ? null : (named as string),
    // Project scope is the default because it is the one that travels with the
    // work; the report always names the absolute file, so it is never a guess.
    scope: values.user === true ? "user" : "project",
    print: values.print === true,
    workspace: values.workspace ?? null,
    hub: values.hub ?? null,
    label,
    entry:
      override === null
        ? DEFAULT_ENTRY
        : {
            name: SERVER_NAME,
            command: override[0] as string,
            args: override.slice(1),
          },
  };
}

/** The command as somebody would type it, for the report. */
function commandLine(entry: Entry): string {
  return [entry.command, ...entry.args].join(" ");
}

/** A complete binding, fixed for this MCP entry until explicitly replaced. */
function pinnedTo(entry: Entry, id: string, hub: string, label: string | null): Entry {
  return {
    ...entry,
    name: label === null ? entry.name : `${entry.name}-${label}`,
    // Sorted like the TOML emitted by Codex's vendor command.
    env: { UB_HUB_URL: hub, UB_WORKSPACE_ID: id },
  };
}

function pinReport(entry: Entry): { fields: string; note: string } {
  const id = entry.env?.UB_WORKSPACE_ID;
  const hub = entry.env?.UB_HUB_URL;
  if (id === undefined || hub === undefined) return { fields: "", note: "" };
  return {
    fields: field("entry", entry.name) + field("workspace", id) + field("hub", hub),
    note: "\nThis entry is pinned; later project selection changes do not redirect it.\n",
  };
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

/**
 * The vendor's own installer for this target and scope, when there is one.
 *
 * A pinned entry goes through the same command: both vendors take the variable
 * as a flag (`claude … -e KEY=value`, `codex … --env KEY=VALUE`), measured
 * against the installed CLIs rather than assumed. Cursor 1.1.3 has no `mcp`
 * subcommand at all, so it has no entry here and gets the snippet.
 */
function vendorCli(
  target: TargetName,
  scope: Scope,
  entry: Entry,
  cwd: string,
): Vendor | null {
  const command = [entry.command, ...entry.args];
  const pinned = Object.entries(entry.env ?? {});
  if (target === "claude") {
    return {
      program: "claude",
      args: [
        "mcp",
        "add",
        entry.name,
        "--scope",
        scope,
        ...pinned.flatMap(([key, value]) => ["-e", `${key}=${value}`]),
        "--",
        ...command,
      ],
      env: {},
    };
  }
  if (target === "codex") {
    return {
      program: "codex",
      args: [
        "mcp",
        "add",
        entry.name,
        ...pinned.flatMap(([key, value]) => ["--env", `${key}=${value}`]),
        "--",
        ...command,
      ],
      // `codex mcp add` has no scope flag; the scope *is* which configuration
      // directory it is pointed at, and `targetFile` resolves the same one — so
      // both agree on the file by construction rather than by coincidence.
      env: scope === "project" ? { CODEX_HOME: codexHome(cwd) } : {},
    };
  }
  return null;
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
 * into somebody else's format. What the pin needs travels in argv (`-e`,
 * `--env`), never here; the only thing added is the vendor's own
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

/** The snippet and where it goes: the answer whenever nothing can run. */
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
  // Before the override is split off, and `takeHelp` stops at the same bare
  // `--`: `ub mcp install -- … --help` registers a command, it does not ask a
  // question.
  if (takeHelp(argv, io, INSTALL_HELP)) return 0;

  let flags: Flags;
  try {
    flags = parseFlags(argv);
  } catch (error) {
    io.err(
      `ub mcp install: ${error instanceof Error ? error.message : String(error)}\n`,
    );
    return 2;
  }

  // Resolve the complete pair before touching a vendor's files. Explicit flags
  // replace the environment pair as a unit, never fill in a missing half.
  let entry: Entry;
  try {
    let env = process.env;
    if (flags.workspace !== null && flags.hub !== null) {
      let known: WorkspaceEntry[] = [];
      // Full UUIDs need no current binding or local replica. Prefixes still use
      // the same local inventory and ambiguity rules as `workspace use`.
      if ("error" in resolveWorkspaceId(flags.workspace, known)) {
        known = listWorkspaces().entries;
      }
      const selected = resolveWorkspaceId(flags.workspace, known);
      if ("error" in selected) throw new Error(selected.error);
      env = { ...process.env, UB_WORKSPACE_ID: selected.id, UB_HUB_URL: flags.hub };
    }
    const selected = requireBinding(resolveConfig({ env }));
    entry = pinnedTo(
      flags.entry, selected.workspaceId, selected.hubUrl ?? "local", flags.label,
    );
  } catch (error) {
    io.err(`ub mcp install: ${error instanceof Error ? error.message : String(error)}\n`);
    return 2;
  }

  // A client this command does not know is exactly what `--print` is for, and
  // it is answered before anything looks at the filesystem: there is no file of
  // ours to look at.
  if (flags.unlisted !== null) {
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
  if (vendor === null) {
    return printSnippet(
      io,
      file,
      entry,
      `${flags.target} has no command that registers an MCP server`,
    );
  }

  const pin = pinReport(entry);
  const installed = presence(file, entry);
  if (installed === "ours") {
    let report = "already installed\n\n";
    report += field("client", where);
    report += field("file", file.path);
    report += field("command", commandLine(entry));
    report += pin.fields;
    io.out(report + pin.note);
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
    // "something other than this" rather than "somebody else's": an entry
    // pinned to a different workspace is ours and is still not the one being
    // installed, and the answer is the same either way.
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
      return printSnippet(io, file, entry, `\`${vendor.program}\` is not installed`);
    }
    if (ran.kind === "failed") {
      io.err(
        `ub mcp install: \`${vendor.program} mcp add\` failed — ${ran.because}. ` +
          "Its output is not repeated here because a client's diagnostics can " +
          `quote the config; run \`${vendor.program} mcp add\` yourself to see it\n`,
      );
      return 1;
    }

    registered = true;
    let report = `uberblick registered with ${flags.target}\n\n`;
    report += field("client", where);
    report += field("file", file.path);
    report += field("command", commandLine(entry));
    report += pin.fields;
    report += field("via", `${vendor.program} mcp add`);
    report += pin.note;
    report += "\nRestart the client, or reload its MCP servers, to pick this up.\n";
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

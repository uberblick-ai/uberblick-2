/**
 * `ub mcp install [target]` — register uberblick with an MCP client.
 *
 * The thing being installed is always the same line, `ub mcp serve`, with no
 * arguments and no environment. Which workspace, which hub and which credential
 * apply is resolved by `ub` itself (see `config.ts`); a client config that
 * pinned any of them would be a second copy of configuration that already has an
 * owner, and it would go stale the first time somebody ran `ub init`.
 *
 * **Two ways to write, and the vendor's own comes first.** Claude Code ships
 * `claude mcp add`, and Codex ships `codex mcp add` for its global config, so
 * those are used where they apply: the vendor knows its own file, and one of
 * those files — `~/.claude.json` — is a large, live document this command would
 * rather not rewrite. Cursor ships no such subcommand, and `codex mcp add` has
 * no flag for project scope, so those are written here. When a vendor CLI is not
 * installed the file path is taken instead, and the report names which one ran.
 *
 * **What it refuses.** Deciding what is already there is always done by reading
 * the file, whichever path does the writing. An entry that is already ours is a
 * no-op; an entry that is somebody else's is reported next to what would replace
 * it and left alone unless `--force` says otherwise; a file that cannot be
 * edited without guessing is named and left untouched. Nothing here prompts, so
 * the whole command runs unattended.
 */

import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, readFileSync, statSync } from "node:fs";
import { dirname } from "node:path";
import { parseArgs } from "node:util";
import type { Io } from "./io.js";
import { processIo } from "./io.js";
import type { Entry, Scope, TargetName } from "./mcp-config.js";
import {
  DEFAULT_ENTRY,
  SERVER_NAME,
  TARGETS,
  UnusableConfig,
  inspect,
  snippet,
  targetFile,
  withEntry,
} from "./mcp-config.js";
import { classify, publishStaged, writeTempBeside } from "./safe-write.js";

/** The default when `ub mcp install` is run with no target named. */
const DEFAULT_TARGET: TargetName = "claude";

interface Flags {
  target: TargetName;
  scope: Scope;
  print: boolean;
  force: boolean;
  /** The command to install, when `-- …` overrode it. */
  entry: Entry;
}

/**
 * Everything after a bare `--` is the command to install, verbatim.
 *
 * It is taken before `parseArgs` sees it because the override is frequently a
 * command with `--` in it of its own — the checkout's own `.mcp.json` runs
 * `mise exec -- fnox exec -- pnpm …` — and only the first separator is ours.
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

function parseFlags(argv: string[]): Flags {
  const { flags, override } = splitOverride(argv);
  const { values, positionals } = parseArgs({
    args: flags,
    options: {
      project: { type: "boolean", default: false },
      user: { type: "boolean", default: false },
      print: { type: "boolean", default: false },
      force: { type: "boolean", default: false },
    },
    allowPositionals: true,
  });

  if (positionals.length > 1) {
    throw new Error(`unexpected argument ${JSON.stringify(positionals[1])}`);
  }
  const named = positionals[0];
  if (named !== undefined && !TARGETS.includes(named as TargetName)) {
    throw new Error(
      `unknown target ${JSON.stringify(named)} — expected one of ${TARGETS.join(", ")}. ` +
        "For any other client, `--print` emits the snippet to paste",
    );
  }
  if (values.project === true && values.user === true) {
    throw new Error("--project and --user contradict each other");
  }
  if (override !== null && override.length === 0) {
    throw new Error("`--` must be followed by the command to install");
  }

  return {
    target: (named as TargetName | undefined) ?? DEFAULT_TARGET,
    // Project scope is the default because it is the one that travels with the
    // work; the report always names the absolute file, so it is never a guess.
    scope: values.user === true ? "user" : "project",
    print: values.print === true,
    force: values.force === true,
    entry:
      override === null
        ? DEFAULT_ENTRY
        : { command: override[0] as string, args: override.slice(1) },
  };
}

/** The command as somebody would type it, for the report. */
function commandLine(entry: Entry): string {
  return [entry.command, ...entry.args].join(" ");
}

// --- the vendor CLIs --------------------------------------------------------

interface Vendor {
  program: string;
  add: string[];
  remove: string[];
}

/**
 * The vendor's own installer for this target and scope, when there is one.
 *
 * Codex is deliberately global-only: `codex mcp add` has no scope flag, so for
 * `--project` — the `.codex/config.toml` a trusted project may carry — using it
 * would write the wrong file. Cursor has MCP subcommands but no `add`.
 */
function vendorCli(
  target: TargetName,
  scope: Scope,
  entry: Entry,
): Vendor | null {
  const command = [entry.command, ...entry.args];
  if (target === "claude") {
    const at = ["--scope", scope];
    return {
      program: "claude",
      add: ["mcp", "add", SERVER_NAME, ...at, "--", ...command],
      remove: ["mcp", "remove", SERVER_NAME, ...at],
    };
  }
  if (target === "codex" && scope === "user") {
    return {
      program: "codex",
      add: ["mcp", "add", SERVER_NAME, "--", ...command],
      remove: ["mcp", "remove", SERVER_NAME],
    };
  }
  return null;
}

type VendorRun =
  | { kind: "ok" }
  /** The program is not installed — the caller falls back to editing the file. */
  | { kind: "absent" }
  | { kind: "failed"; detail: string };

function runVendor(program: string, args: string[]): VendorRun {
  const result = spawnSync(program, args, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (result.error !== undefined) {
    return (result.error as NodeJS.ErrnoException).code === "ENOENT"
      ? { kind: "absent" }
      : { kind: "failed", detail: result.error.message };
  }
  if (result.status === 0) {
    return { kind: "ok" };
  }
  const said = `${result.stderr ?? ""}${result.stdout ?? ""}`.trim();
  return {
    kind: "failed",
    detail: said === "" ? `it exited ${result.status}` : said,
  };
}

// --- writing ----------------------------------------------------------------

/** `<file>.<timestamp>.bak`, beside the file, in the sortable compact form. */
function backupPath(path: string): string {
  const stamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z");
  return `${path}.${stamp}.bak`;
}

/**
 * Publish `contents` at `path` atomically.
 *
 * An existing file keeps the mode it had: `~/.claude.json` and a project's
 * committed `.mcp.json` are not this command's files to tighten or loosen. A new
 * one keeps the owner-only mode `safe-write` stages with, which is the right
 * default for a per-user config on a shared machine — and for a `.mcp.json` that
 * later gets committed the mode is not what travels anyway.
 */
function publish(path: string, contents: string, replacing: boolean): void {
  const staged = writeTempBeside(path, contents);
  if (replacing) {
    chmodSync(staged, statSync(path).mode & 0o777);
  }
  if (!publishStaged(staged, path, replacing ? "regular" : "absent")) {
    throw new Error(`${path} appeared while it was being written — run again`);
  }
}

/** Copy the current file aside before anything changes it. */
function backUp(path: string, text: string): string {
  const backup = backupPath(path);
  const staged = writeTempBeside(backup, text);
  chmodSync(staged, statSync(path).mode & 0o777);
  if (!publishStaged(staged, backup, "absent")) {
    throw new Error(`a backup already exists at ${backup} — run again`);
  }
  return backup;
}

function field(name: string, value: string): string {
  return `${name.padEnd(12)}${value}\n`;
}

// --- the command ------------------------------------------------------------

export async function installCommand(
  argv: string[],
  io: Io = processIo,
): Promise<number> {
  let flags: Flags;
  try {
    flags = parseFlags(argv);
  } catch (error) {
    io.err(
      `ub mcp install: ${error instanceof Error ? error.message : String(error)}\n`,
    );
    return 2;
  }

  const file = targetFile(flags.target, flags.scope, process.cwd());
  const where = `${flags.target} (${flags.scope})`;

  // `--print` is the answer for a client this command does not know, so it is
  // decided before anything touches the filesystem.
  if (flags.print) {
    io.err(`ub mcp install: ${where} reads ${file.path}\n`);
    io.out(snippet(file.format, flags.entry));
    return 0;
  }

  const found = classify(file.path);
  if (found.kind === "refused") {
    io.err(
      `ub mcp install: refusing to write ${file.path}: ${found.because}. ` +
        "Move it aside and run again\n",
    );
    return 1;
  }

  const exists = found.kind === "regular";
  let text: string | null = null;
  if (exists) {
    try {
      text = readFileSync(file.path, "utf8");
    } catch (error) {
      io.err(
        `ub mcp install: ${file.path} could not be read (${
          (error as NodeJS.ErrnoException).code ?? "unknown"
        })\n`,
      );
      return 1;
    }
  }

  let existing: string | null = null;
  let matches = false;
  if (text !== null) {
    try {
      const state = inspect(file.format, text, flags.entry);
      existing = state.existing;
      matches = state.matches;
    } catch (error) {
      if (!(error instanceof UnusableConfig)) {
        throw error;
      }
      // Named, non-zero, and not written to. There is no safe repair for a file
      // whose shape this command cannot read.
      io.err(`ub mcp install: ${file.path} was left alone: ${error.message}\n`);
      return 1;
    }
  }

  if (matches) {
    let report = `already installed\n\n`;
    report += field("target", where);
    report += field("file", file.path);
    report += field("command", commandLine(flags.entry));
    io.out(report);
    return 0;
  }

  if (existing !== null && !flags.force) {
    io.err(
      `ub mcp install: ${file.path} already registers "${SERVER_NAME}" as ` +
        "something else, so it was left alone.\n\n" +
        `existing\n${existing}\n\n` +
        `proposed\n${snippet(file.format, flags.entry).trimEnd()}\n\n` +
        "Re-run with --force to replace it. The file is backed up first.\n",
    );
    return 1;
  }

  // --- everything that writes ---------------------------------------------

  let backup: string | null = null;
  let via: string;
  try {
    if (text !== null) {
      backup = backUp(file.path, text);
    }

    const vendor = vendorCli(flags.target, flags.scope, flags.entry);
    let ran: VendorRun = { kind: "absent" };
    if (vendor !== null) {
      // A vendor CLI that will not overwrite has to be told to remove first;
      // the file was copied aside a moment ago, so this is recoverable.
      ran =
        existing === null
          ? { kind: "ok" }
          : runVendor(vendor.program, vendor.remove);
      if (ran.kind === "ok") {
        ran = runVendor(vendor.program, vendor.add);
      }
      if (ran.kind === "failed") {
        io.err(
          `ub mcp install: \`${vendor.program} mcp add\` failed: ${ran.detail}\n` +
            (backup === null ? "" : `The previous file is at ${backup}\n`),
        );
        return 1;
      }
    }

    if (ran.kind === "ok" && vendor !== null) {
      via = `${vendor.program} mcp add`;
    } else {
      // Either there is no vendor CLI for this target and scope, or it is not
      // installed. Same fallback, and the report says which file was edited.
      mkdirSync(dirname(file.path), { recursive: true });
      publish(file.path, withEntry(file.format, text, flags.entry), text !== null);
      via = `edited ${file.path}`;
    }
  } catch (error) {
    io.err(
      `ub mcp install: ${error instanceof Error ? error.message : String(error)}\n` +
        (backup === null ? "" : `The previous file is at ${backup}\n`),
    );
    return 1;
  }

  let report = `uberblick registered with ${flags.target}\n\n`;
  report += field("target", where);
  report += field("file", file.path);
  report += field("command", commandLine(flags.entry));
  report += field("via", via);
  if (backup !== null) {
    report += field("backup", backup);
  }
  report += "\nRestart the client, or reload its MCP servers, to pick this up.\n";
  io.out(report);
  return 0;
}

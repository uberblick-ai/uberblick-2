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
 *
 * **One file, start to finish.** The config is opened once, without following
 * symlinks, and that descriptor stays open until the write is done. Everything
 * after — what is already installed, what the backup holds, what gets published
 * — is decided from the bytes read through it. Reading by name, then writing by
 * name some milliseconds later, is how a backup ends up holding a version that
 * was already replaced, and how a symlink dropped in between the two ends up
 * receiving the write.
 *
 * The file's identity is therefore checked twice: once before the backup, so the
 * copy is of what was actually read, and once *after* the replacement has been
 * staged, immediately before the rename that publishes it. The second one is the
 * one that matters — an editor saving over the file takes milliseconds, and
 * backing up, rendering and staging is more than enough time for one to land.
 * What is left is the instant between that check and the rename itself, which no
 * amount of care inside one process closes.
 */

import { spawnSync } from "node:child_process";
import type { BigIntStats } from "node:fs";
import {
  chmodSync,
  closeSync,
  constants,
  fstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  statSync,
} from "node:fs";
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
import {
  describeFsError,
  isSymlinkRefusal,
  publishStaged,
  removeQuietly,
  writeTempBeside,
} from "./safe-write.js";

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
  const known = named !== undefined && TARGETS.includes(named as TargetName);
  if (named !== undefined && !known && values.print !== true) {
    throw new Error(
      `unknown target ${JSON.stringify(named)} — expected one of ${TARGETS.join(", ")}. ` +
        "Add --print for the snippet to paste into any other client",
    );
  }
  if (values.project === true && values.user === true) {
    throw new Error("--project and --user contradict each other");
  }
  if (override !== null && override.length === 0) {
    throw new Error("`--` must be followed by the command to install");
  }

  return {
    target: known ? (named as TargetName) : DEFAULT_TARGET,
    unlisted: known || named === undefined ? null : (named as string),
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

// --- the file, held open ----------------------------------------------------

/**
 * A config file, open, with everything needed to tell later whether it is still
 * the same file holding the same bytes.
 */
export interface OpenConfig {
  fd: number;
  dev: bigint;
  ino: bigint;
  size: bigint;
  mtimeNs: bigint;
  ctimeNs: bigint;
  mode: bigint;
  text: string;
}

export type Opened =
  | { kind: "absent" }
  | { kind: "open"; config: OpenConfig }
  | { kind: "refused"; because: string };

/**
 * Open the config without following symlinks, and read it through that same
 * descriptor — so what gets inspected is an inode, not a name somebody could
 * point somewhere else a moment later.
 *
 * Exported for the tests: the window this and {@link verifyUnchanged} close is
 * not reachable from outside a single run, so the only way to hold them to their
 * contract is to call them.
 */
export function openConfig(path: string): Opened {
  let fd: number;
  try {
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return { kind: "absent" };
    }
    if (isSymlinkRefusal(error)) {
      return { kind: "refused", because: "it is a symbolic link" };
    }
    return { kind: "refused", because: describeFsError(error) };
  }
  try {
    const stat = fstatSync(fd, { bigint: true });
    if (!stat.isFile()) {
      closeSync(fd);
      return { kind: "refused", because: "it is not a regular file" };
    }
    return {
      kind: "open",
      config: {
        fd,
        dev: stat.dev,
        ino: stat.ino,
        size: stat.size,
        mtimeNs: stat.mtimeNs,
        ctimeNs: stat.ctimeNs,
        mode: stat.mode,
        text: readFileSync(fd, "utf8"),
      },
    };
  } catch (error) {
    closeSync(fd);
    return { kind: "refused", because: describeFsError(error) };
  }
}

/**
 * Refuse unless the name still leads to the inode that was read, and that inode
 * still holds what it held. Called immediately before the first write.
 */
export function verifyUnchanged(path: string, config: OpenConfig): void {
  const changed = `${path} changed while it was being installed into — run again`;
  let named: BigIntStats;
  try {
    named = statSync(path, { bigint: true });
  } catch {
    throw new Error(changed);
  }
  const now = fstatSync(config.fd, { bigint: true });
  if (
    named.dev !== config.dev ||
    named.ino !== config.ino ||
    now.size !== config.size ||
    now.mtimeNs !== config.mtimeNs ||
    now.ctimeNs !== config.ctimeNs
  ) {
    throw new Error(changed);
  }
}

// --- writing ----------------------------------------------------------------

/** `<file>.<timestamp>.bak`, beside the file, in the sortable compact form. */
function backupPath(path: string): string {
  const stamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z");
  return `${path}.${stamp}.bak`;
}

/**
 * Move a staged file into place, and make sure it never survives a failure.
 *
 * `writeTempBeside` returns a complete file under a name only this call knows;
 * anything that goes wrong between there and publication would otherwise leave
 * it on disk with nobody aware of it.
 */
function stageInto(
  path: string,
  contents: string,
  onto: "absent" | "regular",
  mode: number | null,
  verify: (() => void) | null = null,
): boolean {
  const staged = writeTempBeside(path, contents);
  let published = false;
  try {
    if (mode !== null) {
      chmodSync(staged, mode);
    }
    // The last look, with the replacement already staged on disk: from here to
    // the rename is the residual window, and it is a few instructions wide.
    // Checking any earlier would leave the backup, the render and the staging
    // write inside it — long enough for an editor's own atomic replace to land
    // and be clobbered.
    verify?.();
    published = publishStaged(staged, path, onto);
  } finally {
    // A successful publication consumed the name; every other path leaves it.
    if (!published) {
      removeQuietly(staged);
    }
  }
  return published;
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
export function publish(
  path: string,
  contents: string,
  existing: OpenConfig | null,
): void {
  const onto = existing === null ? "absent" : "regular";
  const mode = existing === null ? null : Number(existing.mode & 0o777n);
  const verify = existing === null ? null : () => verifyUnchanged(path, existing);
  if (!stageInto(path, contents, onto, mode, verify)) {
    throw new Error(`${path} appeared while it was being written — run again`);
  }
}

/** Copy the bytes that were read aside, before anything replaces them. */
function backUp(path: string, config: OpenConfig): string {
  const backup = backupPath(path);
  if (!stageInto(backup, config.text, "absent", Number(config.mode & 0o777n))) {
    throw new Error(`a backup already exists at ${backup} — run again`);
  }
  return backup;
}

function field(name: string, value: string): string {
  return `${name.padEnd(12)}${value}\n`;
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

  // A client this command does not know is exactly what `--print` is for, and
  // it is answered before anything looks at the filesystem: there is no file of
  // ours to look at.
  if (flags.unlisted !== null) {
    io.err(
      `ub mcp install: ${JSON.stringify(flags.unlisted)} is not a client \`ub\` ` +
        "knows — this is the generic stdio form to paste into its own config\n",
    );
    io.out(snippet("json", flags.entry));
    return 0;
  }

  const file = targetFile(flags.target, flags.scope, process.cwd());
  const where = `${flags.target} (${flags.scope})`;

  if (flags.print) {
    io.err(`ub mcp install: ${where} reads ${file.path}\n`);
    io.out(snippet(file.format, flags.entry));
    return 0;
  }

  const opened = openConfig(file.path);
  if (opened.kind === "refused") {
    io.err(
      `ub mcp install: refusing to write ${file.path}: ${opened.because}. ` +
        "Move it aside and run again\n",
    );
    return 1;
  }
  const existingFile = opened.kind === "open" ? opened.config : null;

  try {
    let existing: string | null = null;
    let matches = false;
    if (existingFile !== null) {
      try {
        const state = inspect(file.format, existingFile.text, flags.entry);
        existing = state.existing;
        matches = state.matches;
      } catch (error) {
        if (!(error instanceof UnusableConfig)) {
          throw error;
        }
        // Named, non-zero, and not written to. There is no safe repair for a
        // file whose shape this command cannot read.
        io.err(
          `ub mcp install: ${file.path} was left alone: ${error.message}. ` +
            `\`ub mcp install ${flags.target} --print\` writes the snippet to ` +
            "add by hand\n",
        );
        return 1;
      }
    }

    if (matches) {
      let report = "already installed\n\n";
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
          "Values other than the command are hidden. Re-run with --force to " +
          "replace it; the file is backed up first.\n",
      );
      return 1;
    }

    // --- everything that writes ---------------------------------------------

    let backup: string | null = null;
    let via: string;
    try {
      if (existingFile !== null) {
        // The last look before the first write: still the same file, still
        // holding the bytes every decision above was made from.
        verifyUnchanged(file.path, existingFile);
        backup = backUp(file.path, existingFile);
      }

      const vendor = vendorCli(flags.target, flags.scope, flags.entry);
      let ran: VendorRun = { kind: "absent" };
      if (vendor !== null) {
        if (existingFile !== null) {
          // The vendor does its own writing, so the closest this can get is
          // here: the backup is still current as of this instant.
          verifyUnchanged(file.path, existingFile);
        }
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
        publish(
          file.path,
          withEntry(file.format, existingFile?.text ?? null, flags.entry),
          existingFile,
        );
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
  } finally {
    if (existingFile !== null) {
      closeSync(existingFile.fd);
    }
  }
}

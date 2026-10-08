/**
 * `ub update` — update the Homebrew copy this `ub` runs from.
 *
 * **Which copy is decided by where `ub`'s own files live, never by the working
 * directory.** A Homebrew `ub` typed inside a checkout updates Homebrew's copy,
 * because that is the copy the person just ran; the alternative — updating
 * whatever tree they happen to be standing in — is the surprise this command
 * exists to avoid.
 *
 * Homebrew runs the two commands README documents, and nothing else. This
 * command does not re-prove that Homebrew replaces the installed version;
 * `.github/workflows/homebrew-formula.yml` owns that. A source checkout is
 * refused without running any commands or changing any files: contributors
 * update it with `git pull`, then `mise run setup`.
 */

import { spawn, spawnSync } from "node:child_process";
import { realpathSync } from "node:fs";
import { dirname, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { findCheckoutRoot } from "./checkout.js";
import { takeHelp } from "./help.js";
import { isInstallPayload } from "./installation.js";
import type { Io } from "./io.js";

/** The tap README documents, and the only one this command upgrades from. */
const FORMULA = "uberblick-ai/tap/uberblick";

/** The two a terminal or a supervisor sends; see {@link processHost}'s `run`. */
const SIGNALS: readonly NodeJS.Signals[] = ["SIGINT", "SIGTERM"];

export const UPDATE_HELP = `usage: ub update

Update a Homebrew installation: \`brew update\`, then
\`brew upgrade ${FORMULA}\`. Which copy that is comes from where
\`ub\`'s own files live, never from the current directory.

A source checkout is not updated. Run \`git pull\`, then \`mise run setup\`
to update it instead. \`ub update\` leaves the checkout unchanged.

options:
  -h, --help        show this help
`;

/** What the running CLI is installed as. */
export type Installation =
  | { kind: "homebrew" }
  | { kind: "checkout"; root: string }
  | { kind: "unknown" };

/**
 * Everything this command does outside its own process.
 *
 * Injected because the one thing that cannot be faked is `import.meta.url`: the
 * suite spawns the real `ub`, whose own files are in this checkout, so a test
 * that pointed a fixture at it would be testing the repository it runs in.
 */
export interface UpdateHost {
  /** Where the running CLI's own files live. */
  cliDir: string;
  /** Whether those files came from a versioned install payload. */
  installPayload: boolean;
  /** Read Homebrew's installation prefix. */
  capture(command: string, args: readonly string[]): CaptureResult;
  /** Run a command to completion; `null` when it exited 0, else why not. */
  run(command: string, args: readonly string[], cwd?: string): Promise<string | null>;
}

export interface CaptureResult {
  /** Null when the command could not be run at all. */
  status: number | null;
  stdout: string;
  stderr: string;
}

function named(command: string, args: readonly string[]): string {
  return `\`${[command, ...args].join(" ")}\``;
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** The real world, used by everything except the tests. */
export function processHost(): UpdateHost {
  return {
    cliDir: dirname(fileURLToPath(import.meta.url)),
    installPayload: isInstallPayload(),
    capture(command, args) {
      const result = spawnSync(command, args, { encoding: "utf8" });
      return {
        status: result.error === undefined ? result.status : null,
        stdout: result.stdout ?? "",
        stderr: result.error === undefined ? (result.stderr ?? "") : message(result.error),
      };
    },
    run(command, args, cwd) {
      const label = named(command, args);
      return new Promise((done) => {
        // Both streams to stderr: stdout carries this command's own result, and
        // a reader of it must not have to sift Homebrew's log out first.
        const child = spawn(command, args, { cwd, stdio: ["ignore", 2, 2] });

        // Pass terminal and supervisor signals to Homebrew, then wait for it
        // to exit. The listener suppresses Node's immediate default exit so
        // the command does not leave its child running behind it.
        const forward = SIGNALS.map((signal) => {
          const stop = (): void => {
            child.kill(signal);
          };
          process.on(signal, stop);
          return { signal, stop };
        });
        const finish = (result: string | null): void => {
          for (const { signal, stop } of forward) process.off(signal, stop);
          done(result);
        };

        child.on("error", (error) => finish(`${label} could not be run (${message(error)})`));
        child.on("close", (status, signal) =>
          finish(
            status === 0
              ? null
              : signal !== null
                ? `${label} was killed by ${signal}`
                : `${label} exited ${status ?? 1}`,
          ),
        );
      });
    },
  };
}

/** Whether `child` is `parent` or lies inside it, both taken as real paths. */
function within(parent: string, child: string): boolean {
  const real = (path: string): string => {
    try {
      return realpathSync(path);
    } catch {
      return path;
    }
  };
  const root = real(parent);
  const inner = real(child);
  return inner === root || inner.startsWith(root.endsWith(sep) ? root : `${root}${sep}`);
}

/**
 * Whether this copy is Homebrew-owned, a source checkout, or neither.
 *
 * A payload is Homebrew's only when it lies under the prefix Homebrew itself
 * reports — asked, rather than assumed from `/opt/homebrew`, because the prefix
 * is the installer's choice. That is what separates the tree the formula
 * installed from the same archive unpacked somewhere by hand, which
 * `brew upgrade` would not replace.
 */
export function classify(host: UpdateHost): Installation {
  // A versioned payload stays a payload wherever somebody unpacked it: only a
  // Homebrew-owned one can be updated, and an ancestor checkout is not the copy
  // this process is running from.
  if (host.installPayload) {
    return withinHomebrew(host) ? { kind: "homebrew" } : { kind: "unknown" };
  }
  const root = findCheckoutRoot(host.cliDir);
  if (root !== null) return { kind: "checkout", root };
  return { kind: "unknown" };
}

function withinHomebrew(host: UpdateHost): boolean {
  const prefix = host.capture("brew", ["--prefix"]);
  if (prefix.status !== 0) return false;
  const dir = prefix.stdout.trim();
  return dir !== "" && within(dir, host.cliDir);
}

const UNSUPPORTED =
  "ub update: this `ub` is neither a Homebrew installation nor a checkout of " +
  "the uberblick repository. `ub update` only updates Homebrew installations, " +
  `installed with \`brew install ${FORMULA}\`. Nothing has changed.\n`;

/** Run one `ub update`. Never throws for a failure a person can act on. */
export async function updateCommand(
  argv: string[],
  io: Io,
  host: UpdateHost = processHost(),
): Promise<number> {
  if (takeHelp(argv, io, UPDATE_HELP)) return 0;
  if (argv.length > 0) {
    io.err(`ub update: expected no arguments, got ${JSON.stringify(argv[0])}\n\n${UPDATE_HELP}`);
    return 2;
  }

  const installation = classify(host);
  if (installation.kind === "homebrew") return await updateHomebrew(io, host);
  if (installation.kind === "checkout") {
    io.err(
      "ub update: this `ub` runs from a source checkout. Run `git pull`, then " +
        "`mise run setup` to update it. Nothing has changed.\n",
    );
    return 1;
  }
  io.err(UNSUPPORTED);
  return 1;
}

async function updateHomebrew(io: Io, host: UpdateHost): Promise<number> {
  for (const args of [["update"], ["upgrade", FORMULA]]) {
    const failure = await host.run("brew", args);
    if (failure !== null) {
      io.err(`ub update: ${failure}.\n`);
      return 1;
    }
  }
  io.out("Homebrew has finished. `ub --version` prints the version now installed.\n");
  return 0;
}

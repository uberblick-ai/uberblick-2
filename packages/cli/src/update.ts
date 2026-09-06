/**
 * `ub update` — update the copy of uberblick this `ub` runs from.
 *
 * **Which copy is decided by where `ub`'s own files live, never by the working
 * directory.** A Homebrew `ub` typed inside a checkout updates Homebrew's copy,
 * because that is the copy the person just ran; the alternative — updating
 * whatever tree they happen to be standing in — is the surprise this command
 * exists to avoid.
 *
 * Exactly two installation kinds are supported, and everything else is refused
 * with both of them named:
 *
 * - **Homebrew.** The two commands README documents, and nothing else. This
 *   command does not re-prove that Homebrew replaces the installed version;
 *   `.github/workflows/homebrew-formula.yml` owns that.
 * - **A checkout on `main`.** Fetch, `merge --ff-only`, then refresh the two
 *   generated outputs a checkout needs to be runnable at the new head —
 *   `node_modules` and `packages/web/dist` — through the documented tasks.
 *
 * **Git decides whether the fast-forward is safe, and this command does not
 * second-guess it** (owner decision, 2026-09-05, on #846). There is no
 * cleanliness pre-check: divergence, and uncommitted changes an incoming commit
 * would overwrite, surface as git's own refusal, reported as-is, with the
 * checkout untouched. A `main` carrying unpushed commits already contains
 * `origin/main`, so it fast-forwards trivially and goes on to the refresh —
 * refusing it would need exactly the classifier the decision rejected.
 * Uncommitted changes git does not have to touch survive, untracked files are
 * never even looked at, and nothing here stashes, discards, rebases or
 * switches.
 *
 * **The refresh always runs, and records nothing.** A checkout already at
 * `origin/main` still installs and rebuilds before this reports success, which
 * is what makes a run after a failed one a repair rather than a false "up to
 * date". Remembering which commit last built would be the other way to get
 * that, and a second piece of state to go wrong.
 *
 * Both `ub open` and this write `packages/web/dist`, and Vite empties that
 * directory before it writes it, so the rebuild happens under the lock
 * {@link buildLockPath} names (#512).
 */

import { spawn, spawnSync } from "node:child_process";
import { realpathSync } from "node:fs";
import { dirname, join, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { buildLockPath } from "./build-lock.js";
import { findCheckoutRoot } from "./checkout.js";
import { takeHelp } from "./help.js";
import { type InitLock, acquireInitLock, LockWaitTimeoutError } from "./init-lock.js";
import { isInstallPayload } from "./installation.js";
import type { Io } from "./io.js";

/** The tap README documents, and the only one this command upgrades from. */
const FORMULA = "uberblick-ai/tap/uberblick";

/** Long enough to outlast a real Vite build, the same bound `ub open` waits. */
const BUILD_WAIT_MS = 10 * 60_000;

/** The two a terminal or a supervisor sends; see {@link processHost}'s `run`. */
const SIGNALS: readonly NodeJS.Signals[] = ["SIGINT", "SIGTERM"];

export const UPDATE_HELP = `usage: ub update

Update the copy of uberblick this \`ub\` runs from. Which copy that is comes from
where \`ub\`'s own files live, never from the current directory, and exactly two
kinds are updated:

  a Homebrew installation   Homebrew updates it: \`brew update\`, then
                            \`brew upgrade ${FORMULA}\`
  a checkout on \`main\`      fast-forwarded to origin/main, then its
                            dependencies and web app refreshed to match

A checkout on any other branch is not updated, and nothing is ever stashed,
discarded, rebased or switched: git decides whether the fast-forward is safe,
and when it refuses, its own reason is what you see and the checkout is left
exactly as it was.

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
  /** Read a command's answer, for the two questions that have one. */
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
        // a reader of it must not have to sift a build log out first.
        const child = spawn(command, args, { cwd, stdio: ["ignore", 2, 2] });

        // **A signal is passed on, never obeyed by leaving.** Node's default
        // action for SIGINT is to exit at once, and Ctrl-C during the web build
        // would then strand the lock this run holds — every later `ub update`
        // waiting ten minutes on a dead holder. A listener suppresses that
        // exit; the child is told to stop and this waits for it, so the
        // `finally` around the lock still runs. A child that survives the
        // signal keeps the lock, which is the point: releasing it while
        // something can still write `dist` is the hazard the lock exists for.
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
 * Which of the two supported installations this is, or neither.
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
  "the uberblick repository, and those are the two it knows how to update. " +
  `A Homebrew installation comes from \`brew install ${FORMULA}\`; a checkout ` +
  "updates only on `main`. Nothing has changed.\n";

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
  if (installation.kind === "checkout") return await updateCheckout(installation.root, io, host);
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

async function updateCheckout(root: string, io: Io, host: UpdateHost): Promise<number> {
  const branch = host.capture("git", ["-C", root, "branch", "--show-current"]);
  if (branch.status !== 0) {
    io.err(
      `ub update: could not read the branch of the checkout at ${root}: ` +
        `${branch.stderr.trim() || "git said nothing"}. Nothing has changed.\n`,
    );
    return 1;
  }
  const current = branch.stdout.trim();
  if (current !== "main") {
    io.err(
      `ub update: the checkout at ${root} is on ` +
        `${current === "" ? "a detached HEAD" : `\`${current}\``}, and only \`main\` is ` +
        "updated. Nothing has changed.\n",
    );
    return 1;
  }

  // No cleanliness pre-check: git is the authority on whether this is safe, and
  // its refusal is the message. `--ff-only` never rewrites and never merges.
  //
  // `--no-autostash` because `merge.autostash = true` is a configuration a
  // person may already have, and under it `--ff-only` stops refusing: it
  // stashes the tracked changes the incoming commits overwrite, advances HEAD,
  // and applies the stash back — leaving conflict markers in those files and
  // still exiting 0, so this command would go on to build and report success.
  // The owner's decision is that git decides *whether the fast-forward
  // happens*, not that it may rewrite somebody's uncommitted work to make one
  // happen; turning the setting off here is what keeps the refusal a refusal
  // without adding the cleanliness classifier the decision rejected.
  for (const args of [
    ["-C", root, "fetch", "origin", "main"],
    ["-C", root, "merge", "--ff-only", "--no-autostash", "origin/main"],
  ]) {
    const failure = await host.run("git", args);
    if (failure !== null) {
      io.err(`ub update: ${failure}, so the checkout is unchanged.\n`);
      return 1;
    }
  }

  const failure = await refresh(root, io, host);
  if (failure !== null) {
    io.err(
      `ub update: ${failure}. The checkout is at the commit git left it at; ` +
        "run `ub update` again to retry that step.\n",
    );
    return 1;
  }
  // "includes", not "is at": a `main` carrying unpushed commits already
  // contains `origin/main`, fast-forwards trivially and refreshes, and saying
  // it now equals `origin/main` would be a claim this command did not make true.
  io.out(
    `The checkout at ${root} now includes origin/main, with its dependencies ` +
      "and web app refreshed.\n",
  );
  return 0;
}

/**
 * Bring the two generated outputs back in step with the head just checked out.
 *
 * Always both, never conditionally: what makes a retry repair a half-finished
 * update is that nothing here remembers having succeeded.
 */
async function refresh(root: string, io: Io, host: UpdateHost): Promise<string | null> {
  const install = await host.run("mise", ["run", "install"], root);
  if (install !== null) return install;

  const dist = join(root, "packages", "web", "dist");
  const path = buildLockPath(dist);
  let lock: InitLock;
  try {
    lock = await acquireInitLock(process.env, {
      path,
      waitMs: BUILD_WAIT_MS,
      onWait: () => io.err("ub update: another build of the web app is running — waiting for it\n"),
    });
  } catch (error) {
    if (error instanceof LockWaitTimeoutError) {
      // Its own message names `ub init`; the wait is what was reused, not the text.
      return (
        `another build of the web app has held ${path} for more than ` +
        `${BUILD_WAIT_MS / 60_000} minutes — if nothing is building, remove that file`
      );
    }
    return `could not take the web-build lock at ${path} (${message(error)})`;
  }
  try {
    return await host.run("mise", ["run", "build-web"], root);
  } finally {
    lock.release();
  }
}

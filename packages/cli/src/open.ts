/**
 * `ub open` — the web UI, in the foreground.
 *
 * It serves the built web app over loopback, makes sure a hub is available,
 * opens the browser, and stays in the foreground until Ctrl-C. That is the
 * whole lifecycle model: no daemon, no `ub hub start|stop`, no log files.
 *
 * This is the counterpart to `mise run dev`, not a replacement. `dev` is Vite
 * with HMR for somebody editing web code; `ub open` is the product for somebody
 * using it, and it needs no decrypted secret and no toolchain once a bundle
 * exists.
 *
 * Four decisions are load-bearing:
 *
 * 1. **It starts a hub only when it has to.** A hub answering at the configured
 *    endpoint — a remote one after `ub workspace join`, or one somebody started
 *    with `mise run hub` — is used as it is, and Ctrl-C leaves it running. Only
 *    a *local* endpoint with nothing answering gets a hub of our own, started
 *    in this process with {@link createHub} so that stopping it is the same
 *    flush-then-close the hub's own `main.ts` performs.
 *
 * 2. **It reconciles the two halves of the port configuration**, which is the
 *    asymmetry `ub doctor` explains: the hub binds `HUB_HOST`:`PORT`, while
 *    every client dials the configured endpoint. A hub started here
 *    exists to answer the bundle this command is serving, so it binds the
 *    endpoint the bundle will dial. A `PORT` that disagrees is a warning naming
 *    both, never a silent bind of a socket nobody will connect to.
 *
 * 3. **It serves #91's configuration document** at {@link CONFIG_PATH}, with
 *    the local browser endpoint, frozen workspace, independent browser key and
 *    upstream endpoint, with
 *    `Cache-Control: no-store` on it, matched *ahead* of the SPA fallback. That
 *    document is what lets one prebuilt bundle target any hub; the fallback
 *    answering it with the app's own HTML is precisely the production failure
 *    #91 exists to remove. A serving run freezes its binding at startup so the
 *    browser and silent replica cannot split identities; later binding changes
 *    add `rebound: true` until restart. Unbound serving retains
 *    #449's per-request resolution because it owns no replica identity.
 *
 * 4. **It never serves a blank page.** With no bundle and no toolchain it exits
 *    non-zero naming what is missing, rather than opening a browser onto 404s.
 *    A bundle that is *there* but stale is that blank page with extra steps: one
 *    built before a `SYNC_PROTOCOL_VERSION` bump sends a pre-envelope auth
 *    message, the hub refuses it as an unparseable one, and the page sits at
 *    `syncing…` and `0 docs` with nothing naming the cause (#452). So the build
 *    stamps the protocol it speaks into {@link BUILD_STAMP}, this command
 *    compares it to its own before it starts anything, and a bundle that
 *    differs — or carries no stamp, which is what one built before the stamp
 *    looks like — never gets served. What happens to it instead follows who
 *    owns it (#475): the checkout's own default bundle is rebuilt, because the
 *    CLI has just proved it obsolete and the fix is one documented task; a
 *    bundle `UBERBLICK_WEB_DIST` named is the caller's artifact and is refused
 *    with both versions and the rebuild named. Two local builds are what that
 *    compares: whether the *hub* speaks it too is still settled at connect,
 *    where it always was.
 *
 * The *missing*-bundle build shells out to pnpm rather than to
 * `mise run build-web`: tasks are the documented way for *contributors* to run
 * things, and this is a program running a first build for somebody who was
 * never told about them. A rebuild is the other case — nothing is missing, a
 * checkout's bundle went stale — so it runs the task, in the checkout. Both of
 * them write the one directory, so both run under one lock and never at the
 * same time as each other (#512) — {@link ensureBundle} says how.
 *
 * **What a build is handed** (#426, #512): this command's resolved
 * configuration with `HUB_AUTH_TOKEN` taken out of it, on both paths, by
 * {@link buildEnvironment}. Nothing here puts a signing secret into a build,
 * because the bundle carries no authentication material. The served document
 * now carries only a loopback browser key. This describes this command, not
 * everything downstream of it: `mise run build-web` is
 * `fnox exec … -- ub env -- pnpm …`, so the task puts a decrypted secret back
 * into its own child, which is the task's business and unchanged by this. What
 * keeps it out of the artifact either way is `packages/web/vite.config.ts`,
 * whose `define` is a three-key allowlist — `packages/web/test/bundle-secret.test.ts`
 * is what proves it. `ub open` binds loopback, so the document reaches this
 * machine only.
 */

import { spawn } from "node:child_process";
import { createReadStream, readFileSync, statSync } from "node:fs";
import type { IncomingMessage, Server, ServerResponse } from "node:http";
import { createServer } from "node:http";
import { dirname, extname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import type { Hub, LocalBrowserServer } from "@uberblick/hub";
import {
  createHub,
  createLocalBrowserServer,
  importRootSecret,
  resolveHubConfig,
  verifyToken,
} from "@uberblick/hub";
import {
  SYNC_PROTOCOL_VERSION,
  isProtocolVersion,
  readAuthEnvelope,
} from "@uberblick/hub/protocol";
import { clampToken } from "@uberblick/hub/token";
import { isLoopbackHost } from "@uberblick/hub/remote-url";
import {
  DIRECTORY_SUFFIX,
  SIDEBAR_SUFFIX,
  parseRoom,
} from "@uberblick/schema";
import {
  DEFAULT_HUB_URL,
  ServingReplicaHeldError,
  collectServingSyncStatus,
  createMcpEngine,
  usesDeviceLogin,
  type ServingSyncStatus,
  type UberblickMcpEngine,
} from "@uberblick/mcp-server";
import { buildLockPath } from "./build-lock.js";
import { budget, resolveMcpConfig } from "./budget.js";
import { openBrowser } from "./browser.js";
import { localBrowserKey } from "./browser-key.js";
import { resolveConfig, requireBinding } from "./config.js";
import { takeHelp } from "./help.js";
import { isInstallPayload } from "./installation.js";
import type { InitLock } from "./init-lock.js";
import { acquireInitLock, tryAcquireInitLock, tryAcquireLock } from "./init-lock.js";
import type { Io } from "./io.js";
import { processIo } from "./io.js";
import { readAccessAction, requestAccess, type AccessBinding } from "./open-access.js";
import { rememberWorkspaceBinding } from "./workspace-registry.js";
import {
  endpointOf,
  hubBind,
  isLocalHost,
  probeHubState,
  probePort,
} from "./probes.js";

/**
 * Where the client looks for its runtime configuration (#91).
 *
 * Contract, not detail: `packages/web/src/config.ts`, the Caddy configuration
 * and this command all have to agree on the path and on the shape.
 */
export const CONFIG_PATH = "/uberblick-config.json";

/**
 * The port the web app is served on, unless `--port` says otherwise.
 *
 * Keep a stable origin for browser settings, on a port distinct from Vite's
 * defaults. An occupied port is an error, never a reason to choose another.
 */
export const DEFAULT_WEB_PORT = 13379;

/** Loopback, per the issue: reaching this from another machine is #75's job. */
export const WEB_HOST = "127.0.0.1";

const packageRoot = dirname(dirname(fileURLToPath(import.meta.url)));

/** `packages/web/dist`, resolved from this module rather than from the cwd. */
const DEFAULT_BUNDLE = join(packageRoot, "..", "web", "dist");

/** The web package, so "there is a toolchain here" is a question about files. */
const WEB_PACKAGE = join(packageRoot, "..", "web");

export const OPEN_HELP = `usage: ub open [options]

Serve the web app, make sure a hub is available, and open the browser. Runs in
the foreground; Ctrl-C stops everything it started.

options:
  --no-browser      print the URL instead of opening a browser
  --port <n>        port to serve the web app on (default ${DEFAULT_WEB_PORT})
  -h, --help        show this help

BROWSER in the environment names the command used to open the URL; BROWSER=none
suppresses it, like --no-browser.
`;

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function trimmed(value: string | undefined): string | null {
  const text = value?.trim();
  return text === undefined || text === "" ? null : text;
}

/**
 * The half of the foreground a build has to obey: whether a signal has arrived,
 * and a promise that resolves when one does.
 *
 * A parameter rather than a module-level reader, because the build steps below
 * are exported and driven directly by their tests, and a stop that cannot be
 * supplied is a stop that cannot be tested.
 */
export interface Stop {
  /** True once a signal has arrived. Checked between startup steps. */
  interrupted: () => boolean;
  /** Resolves on the first SIGINT or SIGTERM. */
  signalled: Promise<void>;
}

// --- the bundle --------------------------------------------------------------

/**
 * `ours` is the ownership question, and it is answered by whether
 * `UBERBLICK_WEB_DIST` was supplied — never by where the directory turns out to
 * be. A bundle a caller named is an artifact that caller maintains, even when it
 * resolves to the default directory; only the default this command picked for
 * itself is one it may rebuild.
 */
export type BundleAction =
  /** A built bundle is there; serve it. */
  | { action: "serve"; dir: string; ours: boolean; installed: boolean }
  /** No bundle, but a web package to build one from — if pnpm is there. */
  | { action: "build"; dir: string; ours: boolean; installed: boolean }
  /** Neither, and `reason` says which half is missing. */
  | { action: "missing"; dir: string; ours: boolean; reason: string; installed: boolean };

function isFile(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

/**
 * Which of the three bundle situations this machine is in.
 *
 * `UBERBLICK_WEB_DIST` names a bundle directly — the seam the tests use, and
 * the one a distributed artifact (#90) will use when the bundle no longer sits
 * inside a checkout. An override is taken at its word: a named directory with
 * no `index.html` in it is a mistake to report, not a reason to build something
 * somewhere else and serve that instead.
 */
export function bundlePlan(env: NodeJS.ProcessEnv = process.env): BundleAction {
  const override = trimmed(env.UBERBLICK_WEB_DIST);
  const dir = override === null ? resolve(DEFAULT_BUNDLE) : resolve(override);
  const installed = override === null && isInstallPayload();
  const ours = override === null && !installed;

  if (isFile(join(dir, "index.html"))) {
    return { action: "serve", dir, ours, installed };
  }
  if (override !== null) {
    return {
      action: "missing",
      dir,
      ours,
      installed,
      reason: `UBERBLICK_WEB_DIST names ${dir}, which holds no index.html`,
    };
  }
  if (installed) {
    return {
      action: "missing",
      dir,
      ours,
      installed,
      reason: `the installed web app at ${dir} holds no index.html`,
    };
  }
  if (!isFile(join(WEB_PACKAGE, "package.json"))) {
    return {
      action: "missing",
      dir,
      ours,
      installed,
      reason: `there is no built web app at ${dir}, and no web package beside this one to build from`,
    };
  }
  return { action: "build", dir, ours, installed };
}

/**
 * Whether a command is runnable, asked by running it.
 *
 * Only ever asked when there is no bundle: a check that spawns a process has no
 * business running on the path where nothing needs building.
 */
function hasCommand(command: string): Promise<boolean> {
  return new Promise((done) => {
    const child = spawn(command, ["--version"], { stdio: "ignore" });
    child.on("error", () => done(false));
    child.on("close", (code) => done(code === 0));
  });
}

/**
 * The environment both builds get: this command's resolved configuration with
 * the signing secret taken out. See the module comment for what that does and
 * does not promise.
 */
function buildEnvironment(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const child = { ...env };
  delete child.HUB_AUTH_TOKEN;
  return child;
}

/**
 * Run one build to completion, and say why it produced no bundle — or `null`
 * when it exited cleanly.
 *
 * **Never abandoned, not even on Ctrl-C.** The signal is passed on so a build
 * that has not noticed it stops promptly, but this waits for the child either
 * way: returning while a build is still writing `dist` would release the lock
 * around it, which is the one thing that lock exists to prevent.
 *
 * How the child ended is reported, never interpreted. Whether a dead build was
 * *this command* stopping is `stop.interrupted()`'s answer and nothing else's:
 * a supervisor or another tool can kill a build too, and `ub open` failing to
 * produce a bundle is an operational failure that exits 1, as the CLI's exit
 * classes say.
 */
function runBuild(
  command: string,
  args: string[],
  cwd: string,
  env: NodeJS.ProcessEnv,
  stop: Stop,
): Promise<string | null> {
  const named = `\`${[command, ...args].join(" ")}\``;
  return new Promise((done) => {
    const child = spawn(command, args, {
      cwd,
      env: buildEnvironment(env),
      // Both of the build's streams to stderr: stdout is where this command
      // prints the URL, and a caller reading it must not have to sift a build
      // log out of it first.
      stdio: ["ignore", 2, 2],
    });
    void stop.signalled.then(() => child.kill("SIGTERM"));
    child.on("error", (error) => done(`${named} could not be run (${message(error)})`));
    child.on("close", (status, signal) =>
      done(
        status === 0
          ? null
          : signal !== null
            ? `${named} was killed by ${signal}`
            : `${named} exited ${status ?? 1}`,
      ),
    );
  });
}

/**
 * The file the web build stamps its sync protocol version into.
 *
 * Contract, shared with `packages/web/vite.config.ts`, which emits it: this
 * name and the `syncProtocolVersion` in it.
 */
const BUILD_STAMP = "uberblick-build.json";

/**
 * The protocol version a bundle says it speaks, or `null` when it says nothing
 * this command can believe.
 *
 * One answer for every unreadable case — no stamp, unreadable file, not JSON,
 * not an object, no usable version — because a bundle is refused the same way
 * for all of them, and because a stale bundle is far more often one from before
 * the stamp existed than one with a broken stamp. Never throws: an unparseable
 * file is a refusal to print, not a stack trace.
 */
function stampedProtocol(dir: string): number | null {
  try {
    const stamp: unknown = JSON.parse(readFileSync(join(dir, BUILD_STAMP), "utf8"));
    const version = (stamp as { syncProtocolVersion?: unknown } | null)?.syncProtocolVersion;
    return isProtocolVersion(version) ? version : null;
  } catch {
    return null;
  }
}

/** What a bundle's stamp says, in a sentence: a version, or nothing at all. */
function speaks(stamped: number | null): string {
  return stamped === null
    ? "carries no sync protocol stamp"
    : `speaks sync protocol ${stamped}`;
}

/**
 * Why a bundle *somebody else supplied* is not being served, and what makes it
 * servable.
 *
 * Both rebuilds are named because their audiences are different, and it is the
 * same split the builds below make: `pnpm` is the one a user of `ub` can run,
 * while `mise run build-web` is the documented task for a checkout — and since
 * #426 that task wants no age key either (`fnox exec --if-missing warn`), so
 * what it really needs is mise and a `ub` on PATH.
 */
function staleBundle(dir: string, stamped: number | null, installed: boolean): string {
  if (installed) {
    return (
      `ub open: the installed web app at ${dir} ${speaks(stamped)}, and this uberblick speaks ` +
      `${SYNC_PROTOCOL_VERSION} — it could not sync, so it is not being served. ` +
      "Reinstall Uberblick; an installation never rebuilds or changes its packaged web app at run time.\n"
    );
  }
  return (
    `ub open: the web app at ${dir} ${speaks(stamped)}, and this uberblick speaks ` +
    `${SYNC_PROTOCOL_VERSION} — it could not sync, so it is not being served. ` +
    "Rebuild it with `pnpm --filter @uberblick/web build`, or with " +
    "`mise run build-web` from a checkout.\n"
  );
}

/** The checkout `build-web` is a task of: two levels up from `packages/cli`. */
const CHECKOUT_ROOT = dirname(dirname(packageRoot));

/**
 * How long a second `ub open` waits for the build the first one is running.
 *
 * A fresh decision, not the init lock's two seconds: that one covers a handful
 * of file writes, so anything approaching it is a dead process. This one waits
 * for a Vite build, which #475 made minutes wide, so it has to outlast a real
 * one. Bounded all the same — there is no takeover of a lock a crashed build
 * left behind, and a foreground command that waits forever on one is worse than
 * one that says which file to remove.
 *
 * Deliberately outside {@link budget}'s test ceiling, for the reason
 * `WAIT_TIMEOUT_MS` is: that ceiling shortens terminal probes, where expiry is a
 * permitted answer. This waits for a live sibling doing real work, and a
 * multi-minute build is not a deadline a test may shrink to milliseconds and
 * still be testing anything.
 */
const BUILD_WAIT_MS = 10 * 60_000;

/** Long enough not to spin, short enough that Ctrl-C still feels immediate. */
const BUILD_RETRY_MS = 50;

function sleep(ms: number): Promise<void> {
  return new Promise((done) => setTimeout(done, ms));
}

/**
 * Take the build lock, or say why this run has not got it.
 *
 * Its own loop rather than {@link acquireInitLock}: the bound is different, the
 * message names a build rather than an `ub init`, and above all this one is
 * interruptible — a run waiting minutes for somebody else's build must still
 * answer Ctrl-C, which a wait that can only end in a lock or a thrown timeout
 * cannot do.
 */
async function takeBuildLock(
  dir: string,
  io: Io,
  stop: Stop,
): Promise<InitLock | "interrupted" | "gave-up"> {
  const path = buildLockPath(dir);
  const deadline = Date.now() + BUILD_WAIT_MS;
  let announced = false;

  for (;;) {
    const lock = tryAcquireLock(path);
    if (lock !== null) {
      return lock;
    }
    if (stop.interrupted()) {
      return "interrupted";
    }
    if (Date.now() >= deadline) {
      io.err(
        "ub open: another `ub open` or `ub update` has been building the web app " +
          `for more than ${BUILD_WAIT_MS / 60_000} minutes. If nothing is building, ` +
          `remove ${path} and run \`ub open\` again.\n`,
      );
      return "gave-up";
    }
    if (!announced) {
      announced = true;
      io.err(
        "ub open: another `ub open` or `ub update` is building the web app — waiting for it\n",
      );
    }
    await sleep(BUILD_RETRY_MS);
  }
}

/** What {@link ensureBundle} found, or made, of the bundle it was asked about. */
export type BundleOutcome =
  /** There is a bundle at `plan.dir` that speaks this command's protocol. */
  | "servable"
  /** There is not, and the reason is already on stderr. */
  | "refused"
  /** A signal arrived; the caller stops quietly, as it does everywhere else. */
  | "interrupted";

/**
 * Make sure the bundle about to be served exists and speaks this command's
 * protocol, building it when it does not and the bundle is ours (#475).
 *
 * Ours means `UBERBLICK_WEB_DIST` named nothing, so the bundle is the checkout's
 * own — the normal contributor path, where the CLI has just proved the bundle
 * obsolete or absent and the recovery is one build away. Making the user run it
 * by hand is a step this command can take itself. A *supplied* bundle is refused
 * exactly as before: it is the caller's artifact, and rebuilding somebody else's
 * deployed bundle behind their back is not this command's business.
 *
 * **One build at a time, machine-wide (#512).** Vite empties its output
 * directory before it writes it, so two `ub open` runs building at once leave
 * one of them serving a directory the other is clearing. Both of the builds
 * below produce that one directory, so both happen under {@link buildLockPath},
 * which is named after the directory itself: a second run waits, then re-reads
 * the stamp and builds only if the first left no servable bundle behind. Two
 * runs of one checkout are excluded however their *configuration* differs, and
 * two checkouts never wait on each other; {@link buildLockPath} states the one
 * thing they do have to agree about.
 *
 * Either way a bundle that cannot sync is never served, and the refusal happens
 * before any hub is started or any database file exists.
 */
export async function ensureBundle(
  plan: BundleAction,
  env: NodeJS.ProcessEnv,
  io: Io,
  stop: Stop,
): Promise<BundleOutcome> {
  const stamped = stampedProtocol(plan.dir);
  // The stamp alone would be enough if nothing else were writing this directory,
  // and this one read is the only one taken outside the lock: Vite emits the
  // stamp from `generateBundle` with nothing ordering it last, so another run's
  // half-written `dist` can carry a current stamp and no `index.html` yet.
  // {@link buildBundle}'s pre-build read is paired the same way, because a build
  // killed between those two writes leaves that state behind with nobody left to
  // finish it; its read *after* a build needs no pairing, because that build
  // exited 0 and so wrote both files. On a `serve` plan nothing runs between
  // those two reads, so the later one is the earlier one over again — which is
  // why it answers `servable` only when a build actually ran. A *supplied*
  // bundle missing its `index.html` never reaches this at all:
  // {@link bundlePlan} answers `missing` for it, and {@link openCommand} stops
  // there with the reason.
  if (stamped === SYNC_PROTOCOL_VERSION && isFile(join(plan.dir, "index.html"))) {
    return "servable";
  }
  if (!plan.ours) {
    io.err(staleBundle(plan.dir, stamped, plan.installed));
    return "refused";
  }

  const lock = await takeBuildLock(plan.dir, io, stop);
  if (lock === "interrupted") {
    return "interrupted";
  }
  if (lock === "gave-up") {
    return "refused";
  }
  try {
    return await buildBundle(plan, env, io, stop);
  } finally {
    lock.release();
  }
}

/**
 * The two builds, with the lock held throughout and the stamp re-read first.
 *
 * The re-read is what makes a waiter cheap: whoever held the lock was building
 * this same directory, and a run that waited for them has nothing left to do.
 *
 * Which command runs is the plan's, unchanged (#504): the *missing*-bundle case
 * spawns pnpm, because it is a first build for somebody who was never told about
 * tasks, and the *stale* case runs the documented task in the checkout. A pnpm
 * build that lands a bundle stamped with some other protocol still falls through
 * to the task, exactly as it did when these were two functions.
 */
async function buildBundle(
  plan: BundleAction,
  env: NodeJS.ProcessEnv,
  io: Io,
  stop: Stop,
): Promise<BundleOutcome> {
  if (stampedProtocol(plan.dir) === SYNC_PROTOCOL_VERSION && isFile(join(plan.dir, "index.html"))) {
    return "servable";
  }

  if (plan.action === "build") {
    io.err(
      "ub open: no built web app yet — building it now with pnpm; this takes a moment\n",
    );
    const failure = await runBuild(
      "pnpm",
      ["--filter", "@uberblick/web", "build"],
      dirname(packageRoot),
      env,
      stop,
    );
    if (stop.interrupted()) {
      return "interrupted";
    }
    if (failure !== null) {
      io.err(`ub open: the web build failed, so there is nothing to serve: ${failure}\n`);
      return "refused";
    }
  }

  const built = stampedProtocol(plan.dir);
  if (built === SYNC_PROTOCOL_VERSION && plan.action === "build") {
    return "servable";
  }

  const why =
    built === SYNC_PROTOCOL_VERSION
      ? `is a sync protocol ${built} stamp with no bundle behind it, left by a ` +
        "build that never finished"
      : `${speaks(built)}, and this uberblick speaks ${SYNC_PROTOCOL_VERSION}`;
  io.err(
    `ub open: the web app at ${plan.dir} ${why} — rebuilding it with ` +
      "`mise run build-web`; this takes a moment\n",
  );
  const failure = await runBuild("mise", ["run", "build-web"], CHECKOUT_ROOT, env, stop);
  if (stop.interrupted()) {
    return "interrupted";
  }
  const rebuilt = failure === null ? stampedProtocol(plan.dir) : null;
  if (rebuilt === SYNC_PROTOCOL_VERSION) {
    return "servable";
  }
  io.err(
    `ub open: the stale web app was not rebuilt: ${failure ?? `the rebuilt web app ${speaks(rebuilt)}`}. ` +
      `Run \`mise run build-web\` in ${CHECKOUT_ROOT} and read what it says, or ` +
      "point UBERBLICK_WEB_DIST at a bundle that speaks sync protocol " +
      `${SYNC_PROTOCOL_VERSION}.\n`,
  );
  return "refused";
}

// --- the served files --------------------------------------------------------

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".map": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
  ".txt": "text/plain; charset=utf-8",
};

/**
 * The file a request path names, or `index.html`.
 *
 * The fallback is Caddy's `try_files {path} /index.html` and is here for the
 * same reason: deep links (#68) are client-side routes with no file behind
 * them. It is also why {@link CONFIG_PATH} is answered *before* this function
 * is ever reached — an absent configuration document served as the app's own
 * HTML is the failure #91 was written against.
 *
 * Anything that escapes the bundle directory — `..`, an absolute path, a
 * percent-encoded traversal, a NUL — falls back rather than being served.
 */
function fileFor(root: string, pathname: string): string {
  const fallback = join(root, "index.html");
  let decoded: string;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    return fallback;
  }
  if (decoded.includes("\0")) {
    return fallback;
  }
  const candidate = resolve(root, `.${decoded}`);
  if (candidate !== root && !candidate.startsWith(root + sep)) {
    return fallback;
  }
  return isFile(candidate) ? candidate : fallback;
}

/**
 * The configuration document, byte for byte.
 *
 * One key was #91's contract, `workspaces` is #189's second and `hubAuthToken`
 * is #426's third; all three are read by `packages/web/src/config.ts` and
 * anything else is ignored. The workspace is the spelling that is configured,
 * decoration and all — the client parses the uuid out of it, and the slug is
 * what makes the switcher readable.
 *
 * Serialization only. {@link configSource} supplies live direct-serving
 * values; {@link servingConfigSource} supplies a frozen local/upstream pair and
 * the live `rebound` diagnostic. Only the loopback browser key may be served;
 * an unbound process has no key to give the page.
 */
export function configDocument(
  hubUrl: string,
  workspace: string | null,
  hubAuthToken: string,
  serving?: { remoteHubUrl: string; rebound: boolean },
): string {
  return JSON.stringify({
    hubUrl,
    workspaces: workspace === null ? [] : [workspace],
    hubAuthToken,
    ...(serving === undefined
      ? {}
      : {
          remoteHubUrl: serving.remoteHubUrl,
          ...(serving.rebound ? { rebound: true } : {}),
        }),
  });
}

interface Binding {
  hubUrl: string;
  workspace: string | null;
  hubAuthToken: string;
  hubAdmission: string | null;
  deviceAdmission: boolean;
}

function bindingOf(resolved: ReturnType<typeof resolveConfig>): Binding {
  const hubUrl = trimmed(resolved.env.HUB_URL) ?? DEFAULT_HUB_URL;
  const deviceAdmission = usesDeviceLogin(hubUrl, resolved.env);
  return {
    hubUrl,
    workspace: trimmed(resolved.env.WORKSPACE_ID),
    hubAuthToken: deviceAdmission ? "" : trimmed(resolved.env.HUB_AUTH_TOKEN) ?? "",
    hubAdmission: trimmed(resolved.env.HUB_ADMISSION),
    deviceAdmission,
  };
}

function sameBinding(left: Binding, right: Binding): boolean {
  return (
    left.hubUrl === right.hubUrl &&
    left.workspace === right.workspace &&
    left.hubAdmission === right.hubAdmission &&
    // A login changes live device authority, not the served binding. Local
    // secret rotations still require restart while using local admission.
    (left.deviceAdmission || right.deviceAdmission || left.hubAuthToken === right.hubAuthToken)
  );
}

/**
 * This machine's configuration, as the document, right now.
 *
 * **Resolved against the environment this process started in**, never against
 * an earlier resolution's output. {@link resolveConfig} returns an *environment*
 * with what it resolved written over the process's own, so a `WORKSPACE_ID` or
 * `HUB_AUTH_TOKEN` that came from a file arrives back looking exactly like an
 * environment pin. Feeding that back in would freeze the first resolution's
 * file values into apparent permanent overrides, and no later `ub workspace join`
 * would ever be seen again — the refresh would resolve, and resolve the same
 * answer forever. Passing the original environment keeps the precedence honest:
 * a genuine pin still wins every time, and a file value stays a file value.
 */
function currentConfigDocument(env: NodeJS.ProcessEnv): string {
  const resolved = resolveConfig({ env });
  return resolvedConfigDocument(resolved);
}

function resolvedConfigDocument(resolved: ReturnType<typeof resolveConfig>): string {
  const binding = bindingOf(resolved);
  return configDocument(binding.hubUrl, null, "");
}

/**
 * The per-request source of the unbound configuration document. It refreshes
 * the hub endpoint and publishes no workspace or browser key.
 *
 * `ub init`, `ub workspace join` and `ub workspace use` publish configuration
 * files as separate atomic writes, holding `.init.lock` across the publication.
 * Each file is therefore whole whenever it is read. This source uses the same
 * lock so its resolution sees a completed configuration publication.
 *
 * So each refresh tries to take the same lock without waiting. While a writer
 * holds it, the last accepted document is served immediately. When the reader
 * gets it, no writer can complete a lock acquire/write/release cycle between
 * observations: the lock stays held across both file reads.
 *
 * Only an *active* write falls back like that. A completed removal, or a
 * `credentials.json` refused for its mode, resolves normally and is served
 * normally — {@link resolveConfig}'s own semantics, not a persistent cache of
 * the old configuration.
 */
function configSource(env: NodeJS.ProcessEnv, initial: string): () => string {
  let accepted = initial;
  return () => {
    const lock = tryAcquireInitLock(env);
    if (lock === null) {
      return accepted;
    }
    try {
      accepted = currentConfigDocument(env);
      return accepted;
    } finally {
      lock.release();
    }
  };
}

/**
 * The frozen local-serving document, plus one live fact: whether this machine
 * has since been rebound and `ub open` must be restarted.
 */
function servingConfigSource(
  env: NodeJS.ProcessEnv,
  startup: ReturnType<typeof resolveConfig>,
  localHubUrl: string,
  browserKey: string,
): () => string {
  const binding = bindingOf(startup);
  let accepted = configDocument(
    localHubUrl,
    binding.workspace,
    browserKey,
    { remoteHubUrl: binding.hubUrl, rebound: false },
  );
  return () => {
    const lock = tryAcquireInitLock(env);
    if (lock === null) return accepted;
    try {
      const current = bindingOf(resolveConfig({ env }));
      accepted = configDocument(
        localHubUrl,
        binding.workspace,
        browserKey,
        { remoteHubUrl: binding.hubUrl, rebound: !sameBinding(binding, current) },
      );
      return accepted;
    } finally {
      lock.release();
    }
  };
}

/** Resolve the startup binding and its first served document as one snapshot. */
async function initialConfig(env: NodeJS.ProcessEnv): Promise<{
  resolved: ReturnType<typeof resolveConfig>;
  document: string;
}> {
  const lock = await acquireInitLock(env);
  try {
    const resolved = resolveConfig({ env });
    return { resolved, document: resolvedConfigDocument(resolved) };
  } finally {
    lock.release();
  }
}

function respond(
  request: IncomingMessage,
  response: ServerResponse,
  status: number,
  headers: Record<string, string>,
  body: string,
): void {
  response.writeHead(status, headers);
  response.end(request.method === "HEAD" ? undefined : body);
}

const API_PREFIX = "/api/";
const SEARCH_PATH = "/api/search";
const STATUS_PATH = "/api/status";
const ACCESS_PATH = "/api/access";
const SEARCH_LIMIT = 100;
const TOKEN_QUERY_PARAMS = ["token", "access_token", "auth", "authToken"];

type ApiAuthenticator = (authMessage: string) => Promise<boolean>;
type ApiStatus = () => ServingSyncStatus;

async function createApiAuthenticator(
  browserKey: string,
  workspaceId: string,
): Promise<ApiAuthenticator> {
  const key = await importRootSecret(browserKey);
  return async (authMessage) => {
    const envelope = readAuthEnvelope(authMessage);
    if (
      envelope === null ||
      envelope.protocolVersion !== SYNC_PROTOCOL_VERSION
    ) {
      return false;
    }
    const claims = await verifyToken(key, envelope.token);
    return !(
      claims === null ||
      claims.workspace !== workspaceId ||
      clampToken(claims, Math.floor(Date.now() / 1_000)) !== null
    );
  };
}

function apiResponse(
  request: IncomingMessage,
  response: ServerResponse,
  status: number,
  body: object,
  headers: Record<string, string> = {},
): void {
  respond(
    request,
    response,
    status,
    {
      "content-type": "application/json",
      "cache-control": "no-store",
      ...headers,
    },
    `${JSON.stringify(body)}\n`,
  );
}

/** Refuse DNS-rebound requests before routing can reveal content or credentials. */
function acceptRequestHost(
  expectedHost: string,
  request: IncomingMessage,
  response: ServerResponse,
): boolean {
  if (request.headers.host === expectedHost) return true;
  respond(
    request,
    response,
    421,
    { "content-type": "text/plain", "cache-control": "no-store" },
    "misdirected request\n",
  );
  return false;
}

function bearerToken(request: IncomingMessage): string | null {
  const authorization = request.headers.authorization;
  if (typeof authorization !== "string" || !authorization.startsWith("Bearer ")) {
    return null;
  }
  const token = authorization.slice("Bearer ".length);
  return token === "" ? null : token;
}

async function serveApiRequest(
  request: IncomingMessage,
  response: ServerResponse,
  target: URL,
  authenticate: ApiAuthenticator,
  engine: UberblickMcpEngine,
  status: ApiStatus,
  accessBinding: AccessBinding,
  expectedOrigin: string,
): Promise<void> {
  const queriedToken = TOKEN_QUERY_PARAMS.some((name) =>
    target.searchParams.has(name),
  );
  const authMessage = bearerToken(request);
  if (
    queriedToken ||
    authMessage === null ||
    !(await authenticate(authMessage))
  ) {
    apiResponse(request, response, 401, { error: "unauthorized" });
    return;
  }

  if (target.pathname === ACCESS_PATH) {
    if (request.headers.origin !== expectedOrigin) {
      apiResponse(request, response, 403, { status: "origin-refused" });
      return;
    }
    if (request.method !== "POST") {
      apiResponse(request, response, 405, { error: "method_not_allowed" }, { allow: "POST" });
      return;
    }
    const action = await readAccessAction(request);
    if (action === null) {
      apiResponse(request, response, 400, { status: "invalid-request" }, { connection: "close" });
      request.resume();
      return;
    }
    const aborted = new AbortController();
    const abort = () => { if (!response.writableFinished) aborted.abort(); };
    request.once("aborted", abort);
    response.once("close", abort);
    try {
      const result = await requestAccess(accessBinding, action, aborted.signal);
      apiResponse(request, response, result.status, result.body);
    } finally {
      request.off("aborted", abort);
      response.off("close", abort);
    }
    return;
  }

  if (request.method !== "GET") {
    apiResponse(
      request,
      response,
      405,
      { error: "method_not_allowed" },
      { allow: "GET" },
    );
    return;
  }
  if (target.pathname === STATUS_PATH) {
    apiResponse(request, response, 200, status());
    return;
  }
  if (target.pathname !== SEARCH_PATH) {
    apiResponse(request, response, 404, { error: "not_found" });
    return;
  }

  const query = target.searchParams.get("q");
  if (query === null) {
    apiResponse(request, response, 400, { error: "query_required" });
    return;
  }
  if (
    engine.health.status === "quarantined" ||
    engine.refreshStatus.status === "failed"
  ) {
    apiResponse(request, response, 503, { error: "replica_unavailable" });
    return;
  }

  try {
    const matches = engine.store.search(query, SEARCH_LIMIT + 1);
    apiResponse(request, response, 200, {
      hits: matches.slice(0, SEARCH_LIMIT).map(({ uuid }) => ({ uuid })),
      limit: SEARCH_LIMIT,
      capped: matches.length > SEARCH_LIMIT,
    });
  } catch {
    apiResponse(request, response, 500, { error: "search_failed" });
  }
}

function serveBoundRequest(
  expectedHost: string,
  root: string,
  document: () => string,
  authenticate: ApiAuthenticator,
  engine: UberblickMcpEngine,
  status: ApiStatus,
  accessBinding: AccessBinding,
  expectedOrigin: string,
  request: IncomingMessage,
  response: ServerResponse,
): void {
  if (!acceptRequestHost(expectedHost, request, response)) return;
  const target = new URL(request.url ?? "/", "http://localhost");
  if (!target.pathname.startsWith(API_PREFIX)) {
    serveBundleRequest(root, document, request, response);
    return;
  }
  void serveApiRequest(
    request,
    response,
    target,
    authenticate,
    engine,
    status,
    accessBinding,
    expectedOrigin,
  ).catch(() => {
    if (!response.headersSent) {
      apiResponse(request, response, 500, { error: "internal_error" });
    }
  });
}

function serveBundleRequest(
  root: string,
  document: () => string,
  request: IncomingMessage,
  response: ServerResponse,
): void {
    if (request.method !== "GET" && request.method !== "HEAD") {
      respond(request, response, 405, { allow: "GET, HEAD" }, "");
      return;
    }
    const pathname = new URL(request.url ?? "/", "http://localhost").pathname;

    if (pathname === CONFIG_PATH) {
      respond(
        request,
        response,
        200,
        {
          "content-type": "application/json",
          // Load-bearing: a cached copy keeps a retargeted client dialling the
          // hub it was pointed at last time, which is the whole failure #91
          // exists to remove.
          "cache-control": "no-store",
        },
        document(),
      );
      return;
    }

    const file = fileFor(root, pathname);
    const headers = {
      "content-type": MIME[extname(file).toLowerCase()] ?? "application/octet-stream",
      // The bundle's filenames are content-hashed by Vite, but index.html is
      // not, and a stale one points at assets that are gone.
      "cache-control": "no-cache",
    };
    if (request.method === "HEAD") {
      respond(request, response, 200, headers, "");
      return;
    }
    const stream = createReadStream(file);
    stream.on("error", () => {
      respond(request, response, 404, { "content-type": "text/plain" }, "not found\n");
    });
    stream.on("open", () => {
      response.writeHead(200, headers);
      stream.pipe(response);
    });
}

function serveBundle(
  expectedHost: string,
  root: string,
  document: () => string,
): Server {
  return createServer((request, response) => {
    if (!acceptRequestHost(expectedHost, request, response)) return;
    serveBundleRequest(root, document, request, response);
  });
}

/** Bind, with a bind failure as a rejection rather than an uncaught error. */
function listen(server: Server, host: string, port: number): Promise<void> {
  return new Promise((done, failed) => {
    server.once("error", failed);
    server.listen({ host, port, exclusive: true }, () => {
      server.off("error", failed);
      done();
    });
  });
}

/** Who holds the web port, as far as one probe of it could establish. */
export type PortHolder = "ub-open" | "foreign" | "unidentified";

/**
 * Who holds the web port — another `ub open`, something else entirely, or
 * nobody this probe could name.
 *
 * The first two want different advice (`--port` versus "stop that process"),
 * and the only honest way to tell them apart is to ask the thing on the port
 * for the document only this command serves. What separates them is a
 * **complete** answer, read to its end within the budget: one that is this
 * command's configuration document is another `ub open`, and any other complete
 * answer — a refusal, a different document, a body that is not JSON at all — is
 * another process.
 *
 * Anything short of a complete answer identifies nobody, and that is a third
 * result rather than either of the first two. A healthy `ub open` that answered
 * too late lands there, and reading its expiry as a stranger is what sent a user
 * to stop their own process (#600). Guessing the other way round is no better:
 * a stranger that accepts the connection and never answers looks exactly the
 * same from here.
 */
export async function whoHoldsPort(port: number): Promise<PortHolder> {
  let body: string;
  let ok: boolean;
  try {
    const response = await fetch(`http://${WEB_HOST}:${port}${CONFIG_PATH}`, {
      cache: "no-store",
      signal: AbortSignal.timeout(budget(1_000)),
    });
    // Before the status, because a refusal only counts as an answer once its
    // body is in hand: headers followed by a body that never arrives is the
    // unidentified case, whatever the status line claimed.
    body = await response.text();
    ok = response.ok;
  } catch {
    return "unidentified";
  }
  if (!ok) return "foreign";
  try {
    const parsed: unknown = JSON.parse(body);
    const hubUrl = (parsed as { hubUrl?: unknown } | null)?.hubUrl;
    return typeof hubUrl === "string" ? "ub-open" : "foreign";
  } catch {
    return "foreign";
  }
}

/** What to say about a taken web port, given who — if anyone — answered on it. */
function portTakenMessage(port: number, holder: PortHolder): string {
  if (holder === "ub-open") {
    return (
      `ub open: port ${port} is already serving an uberblick web app — ` +
      "that is another `ub open`; use --port to run a second one\n"
    );
  }
  if (holder === "foreign") {
    return (
      `ub open: port ${port} is in use by another process — ` +
      "stop it, or serve the web app elsewhere with --port\n"
    );
  }
  // Names no holder, because none was established — so the only advice here is
  // the one that is safe whichever it turns out to be.
  return (
    `ub open: port ${port} is in use, and its holder did not answer in time to ` +
    "say what it is — serve the web app elsewhere with --port\n"
  );
}

// --- the hub -----------------------------------------------------------------

interface HubDecision {
  /** The hub this command started, and is therefore responsible for stopping. */
  started: Hub | null;
  /** One line for the banner: what happened about the hub, and why. */
  note: string;
}

/**
 * Why no hub may be started for this endpoint, or null when one may.
 *
 * {@link createHub} starts a plain websocket listener on one address and one
 * port, and the configuration document tells the bundle to dial `hubUrl` — so
 * an endpoint the started hub would not actually answer has to be a refusal,
 * never a hub announced as running that nothing can reach. Ruled out: any
 * scheme but `ws:` (there is no TLS here, so `wss://` would be dialled and
 * never answered), an endpoint with no explicit port (the scheme's default
 * 80/443 is not a port anybody asked a hub to bind), port 0 (ephemeral — the
 * bundle would be told to dial 0), and a non-loopback host per
 * {@link isLoopbackHost}.
 */
export function whyNotStartable(hubUrl: string, parsed: URL): string | null {
  const preamble = `nothing answers ${hubUrl}, and no hub can be started for it: `;
  if (parsed.protocol !== "ws:") {
    return (
      `${preamble}a hub started here speaks plain ws:// on loopback, so it would ` +
      `never answer ${parsed.protocol}// — start one yourself, or configure a ` +
      "ws:// endpoint"
    );
  }
  if (parsed.port === "" || Number(parsed.port) === 0) {
    return (
      `${preamble}it names no port to bind, and a hub started here binds exactly ` +
      "the port the web app dials rather than guessing one"
    );
  }
  const host = parsed.hostname.replace(/^\[|\]$/g, "");
  if (!isLoopbackHost(host)) {
    return (
      `${preamble}\`ub open\` binds loopback only, and ${host} is not a loopback ` +
      "address. This command starts only loopback hubs; reaching a hub from " +
      "another machine is the remote deployment's job (" +
      "REMOTE.md)"
    );
  }
  return null;
}

/**
 * Make a hub available at the resolved endpoint, or explain why there is none.
 *
 * Reachability is a real client — {@link probeHubState} mints a token and reads the
 * workspace's directory room — so "already answering" means a client would
 * actually connect, not that something accepted a TCP connection. Without a
 * workspace or a signing secret there is no such client to be, and the port is
 * the only question that can be asked.
 */
async function ensureHub(
  resolved: NodeJS.ProcessEnv,
  hubUrl: string,
  io: Io,
): Promise<HubDecision> {
  const endpoint = endpointOf(hubUrl);
  if (endpoint === null) {
    throw new Error(
      `the configured endpoint ${JSON.stringify(hubUrl)} is not a websocket ` +
        "endpoint — it has to be a ws:// or wss:// URL",
    );
  }
  // It parses, because `endpointOf` just parsed it too — but this keeps the
  // scheme and whether a port was written down, which is what decides below
  // whether a hub may be started for it.
  const parsed = new URL(hubUrl);
  if (!isLocalHost(endpoint.host)) {
    return { started: null, note: `${hubUrl} (remote — nothing started here)` };
  }

  if (usesDeviceLogin(hubUrl, resolved)) {
    const workspace = trimmed(resolved.WORKSPACE_ID);
    const probe = workspace === null ? null : await probeHubState(resolveMcpConfig(resolved), hubUrl);
    const state = probe?.status === "hub-down" || probe?.status === "connecting"
      ? "hub unreachable" : probe?.reason ?? "device-authenticated hub";
    return { started: null, note: `${hubUrl} (${state}; nothing started here)` };
  }

  const secret = trimmed(resolved.HUB_AUTH_TOKEN);
  const workspace = trimmed(resolved.WORKSPACE_ID);

  if (secret === null) {
    // A hub with no secret would verify no tokens and accept anything, which is
    // why the hub itself refuses to start without one. Nothing to start, then —
    // and saying so is what keeps this apart from a hub that is merely down.
    return {
      started: null,
      note:
        `${hubUrl} (not started: no signing secret, so a hub here would accept ` +
        "anything — `ub init` writes a local development one)",
    };
  }

  if (workspace !== null) {
    const probe = await probeHubState(resolveMcpConfig(resolved), hubUrl);
    if (probe.status === "connected") {
      return { started: null, note: `${hubUrl} (already running — left alone)` };
    }
    if (probe.status === "auth-failed" || probe.status === "update-required") {
      // Refused authority proves the endpoint is occupied, not permission to
      // replace its hub. Device refusal keeps its sign-in recovery wording.
      return { started: null, note: `${hubUrl} (${probe.reason ?? "credential refused"}; nothing started here)` };
    }
  } else {
    // No workspace, so no client to be, so no way to ask whether the thing on
    // that port is a hub. A port somebody else holds is one to leave alone
    // rather than to fight over: the app is served either way.
    const port = await probePort(endpoint.host, endpoint.port);
    if (port.state !== "free") {
      return { started: null, note: `${hubUrl} (already taken — left alone)` };
    }
  }

  // Asked only now, and only about starting: an endpoint a hub already answers
  // is used whatever it looks like, and only one nobody answers has to be one
  // this command could actually stand a hub up on.
  const refusal = whyNotStartable(hubUrl, parsed);
  if (refusal !== null) {
    throw new Error(refusal);
  }

  // The hub binds HUB_HOST:PORT and never reads the endpoint, so the two are
  // only ever in step because somebody kept them there. A hub started here exists to
  // answer the bundle this command serves, so the endpoint wins — and a PORT
  // that disagrees is said out loud rather than silently obeyed.
  const bind = hubBind(resolved);
  if (bind.raw !== null && bind.port !== endpoint.port) {
    io.err(
      `ub: warning: PORT is ${JSON.stringify(bind.raw)} but the configured endpoint dials port ` +
        `${endpoint.port}; the hub started here binds ${endpoint.port}, because ` +
        "that is what the web app dials. `ub doctor` explains the two settings.\n",
    );
  }

  let hub: Hub;
  try {
    // `endpoint.host` is loopback — {@link whyNotStartable} has already refused
    // everything else — so this binds the address the web app dials and no
    // other interface.
    hub = await createHub(
      resolveHubConfig({
        ...resolved,
        PORT: String(endpoint.port),
        HUB_HOST: endpoint.host,
      }),
    );
  } catch (error) {
    // Nothing that answers this machine's credential is there — the probe just
    // said so — and the port is taken anyway. Which of the several things it
    // could be is `ub doctor`'s local hub check, so the message points there rather
    // than guessing.
    if ((error as NodeJS.ErrnoException).code === "EADDRINUSE") {
      throw new Error(
        `nothing at ${hubUrl} answered this machine's credential, and its port ` +
          "is held by something else, so no hub could be started for it — " +
          "`ub doctor` says what holds it",
      );
    }
    throw error;
  }
  return { started: hub, note: `${hubUrl} (started here — Ctrl-C stops it)` };
}

// --- the command -------------------------------------------------------------

interface Options {
  port: number;
  browser: boolean;
}

/** Exported so the help above can be checked against the parser it describes. */
export const OPEN_OPTIONS = {
  browser: { type: "boolean" },
  port: { type: "string" },
} as const;

function parseOptions(argv: string[]): Options {
  const { values, positionals } = parseArgs({
    args: argv,
    options: OPEN_OPTIONS,
    allowNegative: true,
    allowPositionals: true,
  });
  if (positionals.length > 0) {
    throw new Error(`unexpected argument ${JSON.stringify(positionals[0])}`);
  }
  const raw = values.port;
  let port = DEFAULT_WEB_PORT;
  if (raw !== undefined) {
    port = Number(raw);
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
      throw new Error(`--port must be an integer in 1..65535, got ${JSON.stringify(raw)}`);
    }
  }
  return { port, browser: values.browser ?? true };
}

/** What this command started, and is therefore responsible for stopping. */
interface Owned {
  hub: Hub | null;
  server: Server | null;
  localServer: LocalBrowserServer | null;
  engine: UberblickMcpEngine | null;
  engineMonitor: EngineMonitor | null;
  stopEngineRefresh: (() => void) | null;
}

interface EngineMonitor {
  readonly failed: Promise<string>;
  failure(): string | null;
  stop(): void;
}

function monitorEngine(engine: UberblickMcpEngine): EngineMonitor {
  let failure: string | null = null;
  let wake!: (message: string) => void;
  const failed = new Promise<string>((resolve) => {
    wake = resolve;
  });
  const inspect = (): void => {
    if (failure !== null) return;
    const health = engine.health;
    const refresh = engine.refreshStatus;
    if (health.status === "quarantined") {
      failure = `local replica quarantined in ${health.room}: ${health.message}`;
    } else if (refresh.status === "failed") {
      failure = `local replica refresh failed: ${refresh.message}`;
    }
    if (failure !== null) wake(failure);
  };
  // Prime the pre-banner failure check; the interval has not fired yet.
  inspect();
  const timer = setInterval(inspect, 1_000);
  return {
    failed,
    failure: () => failure,
    stop: () => clearInterval(timer),
  };
}

interface Foreground extends Stop {
  /** Stop everything started so far, drop the handlers, and return `code`. */
  shutdown: (code: number) => Promise<number>;
}

/**
 * Take the foreground **before** anything is started.
 *
 * The ordering is the whole point. Node's default SIGINT kills the process
 * outright, so a handler installed only once the command is fully up leaves a
 * window — between the hub binding its socket and the web server binding its
 * own — in which Ctrl-C takes the hub down without its flush, which is the one
 * step the hub's durability contract is made of. Handlers first, then start
 * things and register them here as they come up; a signal at any point tears
 * down exactly what exists.
 */
function takeForeground(owned: Owned, io: Io): Foreground {
  let seen = false;
  let wake!: () => void;
  const signalled = new Promise<void>((done) => {
    wake = done;
  });
  const onSignal = (): void => {
    seen = true;
    wake();
  };
  process.on("SIGINT", onSignal);
  process.on("SIGTERM", onSignal);

  const shutdown = async (code: number): Promise<number> => {
    process.off("SIGINT", onSignal);
    process.off("SIGTERM", onSignal);

    owned.engineMonitor?.stop();
    owned.stopEngineRefresh?.();
    owned.stopEngineRefresh = null;
    let result = code;

    if (owned.localServer !== null) {
      try {
        await owned.localServer.stop();
      } catch (error) {
        io.err(`ub open: the browser server did not shut down cleanly: ${message(error)}\n`);
        result = 1;
      }
    }

    const server = owned.server;
    if (server !== null) {
      // `close()` refuses new connections and drops idle ones;
      // `closeAllConnections` is what stops a request already in flight from
      // holding the port — and the whole point of a foreground command is that
      // Ctrl-C ends it now, not when a browser finishes downloading a chunk.
      await new Promise<void>((done) => {
        server.close(() => done());
        server.closeAllConnections();
      });
    }
    if (owned.engine !== null) {
      try {
        await owned.engine.close();
      } catch (error) {
        io.err(`ub open: the local replica did not shut down cleanly: ${message(error)}\n`);
        result = 1;
      }
    }
    if (owned.hub !== null) {
      try {
        // Flushes before it closes — the hub's own durability contract, which
        // no exit path here may skip.
        await owned.hub.stop();
      } catch (error) {
        io.err(`ub open: the hub did not shut down cleanly: ${message(error)}\n`);
        result = 1;
      }
    }
    return result;
  };

  return { interrupted: () => seen, signalled, shutdown };
}

export async function openCommand(
  argv: string[],
  io: Io = processIo,
): Promise<number> {
  if (takeHelp(argv, io, OPEN_HELP)) return 0;

  let options: Options;
  try {
    options = parseOptions(argv);
  } catch (error) {
    io.err(`ub open: ${message(error)}\n\n${OPEN_HELP}`);
    return 2;
  }

  // Kept, not just used: rebound detection (and the direct-serving fallback)
  // re-resolves from this original environment. Resolving from the output of a
  // prior resolution would turn file values into permanent pins.
  const startupEnv: NodeJS.ProcessEnv = { ...process.env };
  const initial = await initialConfig(startupEnv);
  const resolved = initial.resolved;
  const projectBinding = requireBinding(resolved);
  for (const warning of resolved.warnings) {
    io.err(`ub: warning: ${warning}\n`);
  }
  // The default lives in the MCP server's configuration, which is where every
  // other client reads it from; restating it here would be a second address.
  // Written back into the environment so a build started below bakes the same
  // endpoint into the bundle's fallback that the served document names.
  const hubUrl = trimmed(resolved.env.HUB_URL) ?? DEFAULT_HUB_URL;
  const env: NodeJS.ProcessEnv = { ...resolved.env, HUB_URL: hubUrl };

  const owned: Owned = {
    hub: null,
    server: null,
    localServer: null,
    engine: null,
    engineMonitor: null,
    stopEngineRefresh: null,
  };
  const foreground = takeForeground(owned, io);
  let hubNote = "";

  const plan = bundlePlan(env);
  const missing =
    plan.action === "missing"
      ? plan.reason
      : plan.action === "build" && !(await hasCommand("pnpm"))
        ? `there is no built web app at ${plan.dir}, and pnpm — which builds it — is not on PATH`
        : null;
  if (missing !== null) {
    const recovery =
      plan.action === "missing" && plan.installed === true
        ? "Reinstall Uberblick; an installation never builds or changes its packaged web app at run time."
        : "Point UBERBLICK_WEB_DIST at a built bundle, or build one from a checkout — the README says how.";
    io.err(`ub open: ${missing}. ${recovery}\n`);
    return await foreground.shutdown(1);
  }
  // Every build this command runs happens in here, under one lock, and it
  // judges the bundle that will actually be served: one that was already there,
  // or the one it just produced. Before `ensureHub`, because a refusal must
  // start no hub and create no database file.
  const bundle = await ensureBundle(plan, env, io, foreground);
  if (bundle === "refused") {
    return await foreground.shutdown(1);
  }
  if (bundle === "interrupted" || foreground.interrupted()) {
    return await foreground.shutdown(0);
  }

  try {
    const decided = await ensureHub(env, hubUrl, io);
    owned.hub = decided.started;
    hubNote = decided.note;
  } catch (error) {
    io.err(`ub open: ${message(error)}\n`);
    return await foreground.shutdown(1);
  }
  if (foreground.interrupted()) {
    return await foreground.shutdown(0);
  }

  const workspace = trimmed(env.WORKSPACE_ID);
  const servedUrl = new URL(`http://${WEB_HOST}:${options.port}/`);
  const expectedHost = servedUrl.host;
  const localHubUrl = `ws://${WEB_HOST}:${options.port}`;
  try {
    const mcpConfig = workspace === null ? null : resolveMcpConfig(env);
    if (mcpConfig !== null) {
      const engine = await createMcpEngine(mcpConfig, { serving: true });
      owned.engine = engine;
      owned.engineMonitor = monitorEngine(engine);
      const browserKey = localBrowserKey(mcpConfig.workspaceId, startupEnv);
      const authenticateApi = await createApiAuthenticator(
        browserKey,
        mcpConfig.workspaceId,
      );
      const document = servingConfigSource(
        startupEnv,
        initial.resolved,
        localHubUrl,
        browserKey,
      );
      const observedServedRooms = new Set<string>();
      let collectingServedRooms: Set<string> | null = null;
      let localServer: LocalBrowserServer | null = null;
      const status = (): ServingSyncStatus => {
        if (localServer !== null) {
          const current = new Set<string>();
          collectingServedRooms = current;
          try {
            // `refresh` synchronously walks the Hocuspocus document map. The
            // read callback below therefore gives this endpoint exactly the
            // rooms the in-process server currently has loaded, including the
            // directory and sidebar rooms.
            localServer.refresh();
          } finally {
            collectingServedRooms = null;
          }
          observedServedRooms.clear();
          for (const room of current) observedServedRooms.add(room);
        }
        return collectServingSyncStatus(engine, observedServedRooms);
      };
      localServer = await createLocalBrowserServer({
        port: options.port,
        workspaceId: mcpConfig.workspaceId,
        browserKey,
        expectedOrigin: servedUrl.origin,
        readRoom: (room, afterSeq) => {
          (collectingServedRooms ?? observedServedRooms).add(room);
          return engine.store.readSince(room, afterSeq);
        },
        appendUpdate: (room, payload) => {
          const health = engine.health;
          if (health.status === "quarantined") {
            throw new Error(
              `local replica quarantined in ${health.room}: ${health.message}`,
            );
          }
          const refresh = engine.refreshStatus;
          if (refresh.status === "failed") {
            throw new Error(`local replica refresh failed: ${refresh.message}`);
          }
          engine.store.appendUpdate(room, payload, "local");
        },
        awarenessForRoom: (room) => {
          const { uuid } = parseRoom(room);
          if (uuid === DIRECTORY_SUFFIX) return engine.replicas.directory().awareness;
          if (uuid === SIDEBAR_SUFFIX) return engine.replicas.sidebar().awareness;
          return engine.replicas.replica(uuid).awareness;
        },
        onRequest: (request, response) => {
          serveBoundRequest(
            expectedHost,
            plan.dir,
            document,
            authenticateApi,
            engine,
            status,
            { workspaceId: mcpConfig.workspaceId, hubUrl: projectBinding.hubUrl, env: startupEnv },
            servedUrl.origin,
            request,
            response,
          );
        },
      });
      owned.localServer = localServer;
      owned.stopEngineRefresh = engine.onRefresh(() => localServer.refresh());
    } else {
      // An unbound run serves only the bundle: there is no workspace or key.
      const server = serveBundle(
        expectedHost,
        plan.dir,
        configSource(startupEnv, initial.document),
      );
      await listen(server, WEB_HOST, options.port);
      owned.server = server;
    }
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (error instanceof ServingReplicaHeldError) {
      io.err(
        `ub open: another \`ub open\` is already serving this store: ${message(error)}\n`,
      );
    } else if (code === "EADDRINUSE") {
      io.err(portTakenMessage(options.port, await whoHoldsPort(options.port)));
    } else {
      io.err(`ub open: could not serve on port ${options.port}: ${message(error)}\n`);
    }
    return await foreground.shutdown(1);
  }

  if (foreground.interrupted()) {
    return await foreground.shutdown(0);
  }

  const earlyFailure = owned.engineMonitor?.failure() ?? null;
  if (earlyFailure !== null) {
    io.err(`ub open: ${earlyFailure}\n`);
    return await foreground.shutdown(1);
  }

  try {
    await rememberWorkspaceBinding(projectBinding, startupEnv);
  } catch (error) {
    io.err(`ub open: could not record this workspace: ${message(error)}\n`);
    return await foreground.shutdown(1);
  }

  const url = servedUrl.href;
  let banner = `uberblick is at ${url}\n\n`;
  banner += `  hub        ${hubNote}\n`;
  banner += `  workspace  ${workspace ?? "none configured — run `ub init`"}\n`;
  banner += `  bundle     ${plan.dir}\n\n`;
  banner += "Ctrl-C to stop.\n";
  io.out(banner);

  if (options.browser) {
    openBrowser(url, env, io);
  }

  let exitCode = 0;
  if (owned.engineMonitor === null) {
    await foreground.signalled;
  } else {
    const failure = await Promise.race([
      foreground.signalled.then(() => null),
      owned.engineMonitor.failed,
    ]);
    if (failure !== null) {
      io.err(`ub open: ${failure}\n`);
      exitCode = 1;
    }
  }

  // Ctrl-C stops what this command started, and only that: a hub somebody else
  // was already running was never registered as owned, so it is still there.
  return await foreground.shutdown(exitCode);
}

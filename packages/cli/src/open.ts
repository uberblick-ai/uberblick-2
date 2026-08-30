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
 *    endpoint — a remote one after `ub remote join`, or one somebody started
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
 *    the resolved endpoint, workspace and signing secret in it and
 *    `Cache-Control: no-store` on it, matched *ahead* of the SPA fallback. That
 *    document is what lets one prebuilt bundle target any hub; the fallback
 *    answering it with the app's own HTML is precisely the production failure
 *    #91 exists to remove. It is resolved **per request**, not once at startup
 *    (#449): after `ub remote join` or `ub workspace use` changes this machine's
 *    binding, a reload sees the change instead of the values this process
 *    happened to start with. An already-open page is not retargeted — nothing
 *    here reaches into a running client — so the freshness this buys is a
 *    reload's, which is the step that used to require restarting `ub open`.
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
 * because the bundle has needed none since the secret moved into the document
 * this command serves. That is a statement about *this* command and not about
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
import { isIPv4 } from "node:net";
import { dirname, extname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import type { Hub } from "@uberblick/hub";
import { createHub, resolveHubConfig } from "@uberblick/hub";
import { SYNC_PROTOCOL_VERSION, isProtocolVersion } from "@uberblick/hub/protocol";
import { DEFAULT_HUB_URL, resolveMcpConfig } from "@uberblick/mcp-server";
import { resolveConfig } from "./config.js";
import { takeHelp } from "./help.js";
import type { InitLock } from "./init-lock.js";
import { acquireInitLock, buildLockPath, tryAcquireInitLock } from "./init-lock.js";
import type { Io } from "./io.js";
import { processIo } from "./io.js";
import {
  endpointOf,
  hubBind,
  isLocalHost,
  probeHub,
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
 * Vite's `preview` port rather than its `dev` port (5173): serving an already
 * built bundle is exactly what preview does, and a distinct number means
 * `mise run dev` and `ub open` can both be running without either wondering
 * which one the browser is looking at.
 */
export const DEFAULT_WEB_PORT = 4173;

/** Loopback, per the issue: reaching this from another machine is #75's job. */
const WEB_HOST = "127.0.0.1";

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
  | { action: "serve"; dir: string; ours: boolean }
  /** No bundle, but a web package to build one from — if pnpm is there. */
  | { action: "build"; dir: string; ours: boolean }
  /** Neither, and `reason` says which half is missing. */
  | { action: "missing"; dir: string; ours: boolean; reason: string };

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
  const ours = override === null;

  if (isFile(join(dir, "index.html"))) {
    return { action: "serve", dir, ours };
  }
  if (override !== null) {
    return {
      action: "missing",
      dir,
      ours,
      reason: `UBERBLICK_WEB_DIST names ${dir}, which holds no index.html`,
    };
  }
  if (!isFile(join(WEB_PACKAGE, "package.json"))) {
    return {
      action: "missing",
      dir,
      ours,
      reason: `there is no built web app at ${dir}, and no web package beside this one to build from`,
    };
  }
  return { action: "build", dir, ours };
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

/** How a build ended: with a reason it did not work, and whether it was stopped. */
interface BuildEnd {
  /** Why the build produced no bundle, or null when it exited cleanly. */
  failure: string | null;
  /** True when a signal this command also answers to ended it. */
  stopped: boolean;
}

/**
 * Run one build to completion.
 *
 * **Never abandoned, not even on Ctrl-C.** The signal is passed on so a build
 * that has not noticed it stops promptly, but this waits for the child either
 * way: returning while a build is still writing `dist` would release the lock
 * around it, which is the one thing that lock exists to prevent.
 *
 * A child ended by SIGINT or SIGTERM is this command stopping rather than a
 * build failing, whichever of the two callbacks the event loop runs first — a
 * foreground Ctrl-C reaches the whole process group, so the build and this
 * process get it at the same instant.
 */
function runBuild(
  command: string,
  args: string[],
  cwd: string,
  env: NodeJS.ProcessEnv,
  stop: Stop,
): Promise<BuildEnd> {
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
    child.on("error", (error) =>
      done({ failure: `${named} could not be run (${message(error)})`, stopped: false }),
    );
    child.on("close", (status, signal) =>
      done({
        failure:
          status === 0
            ? null
            : signal !== null
              ? `${named} was killed by ${signal}`
              : `${named} exited ${status ?? 1}`,
        stopped: signal === "SIGINT" || signal === "SIGTERM",
      }),
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
function staleBundle(dir: string, stamped: number | null): string {
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
  env: NodeJS.ProcessEnv,
  io: Io,
  stop: Stop,
): Promise<InitLock | "interrupted" | "gave-up"> {
  const path = buildLockPath(env);
  const deadline = Date.now() + BUILD_WAIT_MS;
  let announced = false;

  for (;;) {
    const lock = tryAcquireInitLock(env, { path });
    if (lock !== null) {
      return lock;
    }
    if (stop.interrupted()) {
      return "interrupted";
    }
    if (Date.now() >= deadline) {
      io.err(
        "ub open: another `ub open` has been building the web app for more than " +
          `${BUILD_WAIT_MS / 60_000} minutes. If nothing is building, remove ` +
          `${path} and run \`ub open\` again.\n`,
      );
      return "gave-up";
    }
    if (!announced) {
      announced = true;
      io.err("ub open: another `ub open` is building the web app — waiting for it\n");
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
 * below produce that one directory, so both happen under {@link buildLockPath}:
 * a second run waits, then re-reads the stamp and builds only if the first left
 * no servable bundle behind. The lock is this machine's rather than this
 * checkout's — nothing is written into a checkout — so two checkouts building at
 * once take turns, which costs a wait nobody will notice and which no
 * correctness rests on.
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
  if (stamped === SYNC_PROTOCOL_VERSION) {
    return "servable";
  }
  if (!plan.ours) {
    io.err(staleBundle(plan.dir, stamped));
    return "refused";
  }

  const lock = await takeBuildLock(env, io, stop);
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
  if (stampedProtocol(plan.dir) === SYNC_PROTOCOL_VERSION) {
    return "servable";
  }

  if (plan.action === "build") {
    io.err(
      "ub open: no built web app yet — building it now with pnpm; this takes a moment\n",
    );
    const end = await runBuild(
      "pnpm",
      ["--filter", "@uberblick/web", "build"],
      dirname(packageRoot),
      env,
      stop,
    );
    if (end.stopped || stop.interrupted()) {
      return "interrupted";
    }
    if (end.failure !== null) {
      io.err(`ub open: the web build failed, so there is nothing to serve: ${end.failure}\n`);
      return "refused";
    }
  }

  const built = stampedProtocol(plan.dir);
  if (built === SYNC_PROTOCOL_VERSION) {
    return "servable";
  }

  io.err(
    `ub open: the web app at ${plan.dir} ${speaks(built)}, and this uberblick ` +
      `speaks ${SYNC_PROTOCOL_VERSION} — rebuilding it with \`mise run build-web\`; ` +
      "this takes a moment\n",
  );
  const end = await runBuild("mise", ["run", "build-web"], CHECKOUT_ROOT, env, stop);
  if (end.stopped || stop.interrupted()) {
    return "interrupted";
  }
  const rebuilt = end.failure === null ? stampedProtocol(plan.dir) : null;
  if (rebuilt === SYNC_PROTOCOL_VERSION) {
    return "servable";
  }
  io.err(
    `ub open: the stale web app was not rebuilt: ${end.failure ?? `the rebuilt web app ${speaks(rebuilt)}`}. ` +
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
 * Serialization only. What goes *into* it is resolved per request by
 * {@link configSource}. Empty secret when there is none — the client then says
 * it cannot authenticate rather than pretending it can.
 */
export function configDocument(
  hubUrl: string,
  workspace: string | null,
  hubAuthToken: string,
): string {
  return JSON.stringify({
    hubUrl,
    workspaces: workspace === null ? [] : [workspace],
    hubAuthToken,
  });
}

/**
 * This machine's configuration, as the document, right now.
 *
 * **Resolved against the environment this process started in**, never against
 * an earlier resolution's output. {@link resolveConfig} returns an *environment*
 * with what it resolved written over the process's own, so a `WORKSPACE_ID` or
 * `HUB_AUTH_TOKEN` that came from a file arrives back looking exactly like an
 * environment pin. Feeding that back in would freeze the first resolution's
 * file values into apparent permanent overrides, and no later `ub remote join`
 * would ever be seen again — the refresh would resolve, and resolve the same
 * answer forever. Passing the original environment keeps the precedence honest:
 * a genuine pin still wins every time, and a file value stays a file value.
 */
function currentConfigDocument(env: NodeJS.ProcessEnv): string {
  const resolved = resolveConfig({ env });
  return resolvedConfigDocument(resolved);
}

function resolvedConfigDocument(resolved: ReturnType<typeof resolveConfig>): string {
  return configDocument(
    trimmed(resolved.env.HUB_URL) ?? DEFAULT_HUB_URL,
    trimmed(resolved.env.WORKSPACE_ID),
    trimmed(resolved.env.HUB_AUTH_TOKEN) ?? "",
  );
}

/**
 * The per-request source of the configuration document, with the one guarantee
 * a reader of two files needs: it never serves a torn pair.
 *
 * `ub init`, `ub remote join` and `ub workspace use` publish `credentials.json`
 * and `config.json` as separate atomic writes, holding `.init.lock` across both.
 * Each file is therefore whole whenever it is read, but the *pair* is only
 * consistent outside that window — a read interleaved with the write can pick up
 * the new secret beside the old endpoint, which is a document that authenticates
 * against a hub nobody configured.
 *
 * So each refresh tries to take the same lock without waiting. While a writer
 * holds it, the last accepted document is served immediately. When the reader
 * gets it, no writer can complete a lock acquire/write/release cycle between
 * observations: the lock stays held across both file reads.
 *
 * Only an *active* write falls back like that. A completed removal, or a
 * `credentials.json` refused for its mode, resolves normally and is served
 * normally — {@link resolveConfig}'s own semantics, not a cache pretending a
 * deleted secret is still there.
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

function serveBundle(root: string, document: () => string): Server {
  return createServer((request, response) => {
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

/**
 * Who holds the web port — another `ub open`, or something else entirely.
 *
 * The two want different advice (`--port` versus "stop that process"), and the
 * only honest way to tell them apart is to ask the thing on the port for the
 * document only this command serves.
 */
async function whoHoldsPort(port: number): Promise<"ub-open" | "foreign"> {
  try {
    const response = await fetch(`http://${WEB_HOST}:${port}${CONFIG_PATH}`, {
      cache: "no-store",
      signal: AbortSignal.timeout(1_000),
    });
    if (!response.ok) {
      return "foreign";
    }
    const body: unknown = await response.json();
    const hubUrl = (body as { hubUrl?: unknown } | null)?.hubUrl;
    return typeof hubUrl === "string" ? "ub-open" : "foreign";
  } catch {
    return "foreign";
  }
}

// --- the hub -----------------------------------------------------------------

interface HubDecision {
  /** The hub this command started, and is therefore responsible for stopping. */
  started: Hub | null;
  /** One line for the banner: what happened about the hub, and why. */
  note: string;
}

/**
 * Addresses a hub started *here* may bind: loopback, and nothing else.
 *
 * Deliberately narrower than {@link isLocalHost}, which also admits the
 * wildcards `0.0.0.0` and `::` — those are addresses to *listen* on, and a hub
 * bound to one is on every interface. The hub's only credential is a single
 * shared signing secret, so that would hand the whole network a hub which
 * trusts anyone holding it. Offering a hub beyond this machine is the remote
 * deployment's job (`ub remote init`, REMOTE.md), and `ub open` is not it.
 * Probing such an endpoint for a hub somebody else started stays fine: this
 * governs only what this command starts.
 *
 * **A literal, or one of two exact names — never a prefix.** `/^127\./` also
 * matches the *DNS name* `127.attacker.example`, whose resolution somebody else
 * controls: the string looks like loopback, the socket binds wherever that name
 * resolves, and the shared-secret hub is off loopback again by another door. So
 * the only things accepted here are an actual IPv4 literal in 127.0.0.0/8
 * (`isIPv4` rejects every name, so the `127.` test is then genuinely a first
 * octet), the IPv6 loopback literal, and the name `localhost` — which resolves
 * to loopback by definition rather than by lookup.
 */
function isLoopbackHost(host: string): boolean {
  if (host === "localhost" || host === "::1" || host === "[::1]") {
    return true;
  }
  return isIPv4(host) && host.startsWith("127.");
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
function whyNotStartable(hubUrl: string, parsed: URL): string | null {
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
      "address. A hub's only credential is one shared signing secret, so binding " +
      "it there would offer that hub to every interface — reaching a hub from " +
      "another machine is the remote deployment's job (`ub remote init`, and " +
      "REMOTE.md)"
    );
  }
  return null;
}

/**
 * Make a hub available at the resolved endpoint, or explain why there is none.
 *
 * Reachability is a real client — {@link probeHub} mints a token and reads the
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
    if ((await probeHub(resolveMcpConfig(resolved), hubUrl)) === "connected") {
      return { started: null, note: `${hubUrl} (already running — left alone)` };
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
    // could be is `ub doctor`'s bind check, so the message points there rather
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

// --- the browser -------------------------------------------------------------

/** The command that opens a URL on this platform, or null when asked not to. */
function browserCommand(
  url: string,
  env: NodeJS.ProcessEnv,
): { command: string; args: string[] } | null {
  const configured = trimmed(env.BROWSER);
  if (configured === "none") {
    return null;
  }
  if (configured !== null) {
    return { command: configured, args: [url] };
  }
  if (process.platform === "darwin") {
    return { command: "open", args: [url] };
  }
  if (process.platform === "win32") {
    return { command: "cmd", args: ["/c", "start", "", url] };
  }
  return { command: "xdg-open", args: [url] };
}

/**
 * Hand the URL to a browser, and carry on regardless.
 *
 * A machine with no `xdg-open` is a headless one, and the URL is already on
 * stdout — failing the command over it would be refusing to serve because
 * nobody could be shown the door.
 */
function openBrowser(url: string, env: NodeJS.ProcessEnv, io: Io): void {
  const opener = browserCommand(url, env);
  if (opener === null) {
    return;
  }
  const child = spawn(opener.command, opener.args, {
    stdio: "ignore",
    detached: true,
  });
  child.on("error", (error) => {
    io.err(`ub: warning: could not open a browser (${message(error)})\n`);
  });
  child.unref();
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
    if (owned.hub !== null) {
      try {
        // Flushes before it closes — the hub's own durability contract, which
        // no exit path here may skip.
        await owned.hub.stop();
      } catch (error) {
        io.err(`ub open: the hub did not shut down cleanly: ${message(error)}\n`);
        return 1;
      }
    }
    return code;
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

  // Kept, not just used: the configuration document is re-resolved from this
  // same environment on every request, and resolving from anything downstream of
  // a resolution would turn file values into permanent pins — see
  // {@link currentConfigDocument}.
  const startupEnv: NodeJS.ProcessEnv = { ...process.env };
  const initial = await initialConfig(startupEnv);
  const resolved = initial.resolved;
  for (const warning of resolved.warnings) {
    io.err(`ub: warning: ${warning}\n`);
  }
  // The default lives in the MCP server's configuration, which is where every
  // other client reads it from; restating it here would be a second address.
  // Written back into the environment so a build started below bakes the same
  // endpoint into the bundle's fallback that the served document names.
  const hubUrl = trimmed(resolved.env.HUB_URL) ?? DEFAULT_HUB_URL;
  const env: NodeJS.ProcessEnv = { ...resolved.env, HUB_URL: hubUrl };

  const owned: Owned = { hub: null, server: null };
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
    io.err(
      `ub open: ${missing}. Point UBERBLICK_WEB_DIST at a built bundle, or ` +
        "build one from a checkout — the README says how.\n",
    );
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
  // `workspace` is for the banner, which reports what this command started
  // with; the document is resolved afresh for whoever asks for it.
  const server = serveBundle(plan.dir, configSource(startupEnv, initial.document));
  try {
    await listen(server, WEB_HOST, options.port);
    owned.server = server;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "EADDRINUSE") {
      const holder = await whoHoldsPort(options.port);
      io.err(
        holder === "ub-open"
          ? `ub open: port ${options.port} is already serving an uberblick web app — ` +
            `that is another \`ub open\`; use --port to run a second one\n`
          : `ub open: port ${options.port} is in use by another process — ` +
            "stop it, or serve the web app elsewhere with --port\n",
      );
    } else {
      io.err(`ub open: could not serve on port ${options.port}: ${message(error)}\n`);
    }
    return await foreground.shutdown(1);
  }

  const url = `http://${WEB_HOST}:${options.port}/`;
  let banner = `uberblick is at ${url}\n\n`;
  banner += `  hub        ${hubNote}\n`;
  banner += `  workspace  ${workspace ?? "none configured — run `ub init`"}\n`;
  banner += `  bundle     ${plan.dir}\n\n`;
  banner += "Ctrl-C to stop.\n";
  io.out(banner);

  if (options.browser) {
    openBrowser(url, env, io);
  }

  await foreground.signalled;

  // Ctrl-C stops what this command started, and only that: a hub somebody else
  // was already running was never registered as owned, so it is still there.
  return await foreground.shutdown(0);
}

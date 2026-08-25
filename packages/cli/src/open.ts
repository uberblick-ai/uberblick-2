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
 * 1. **It starts a hub only when it has to.** A hub answering at the resolved
 *    `HUB_URL` — a remote one after `ub remote set`, or one somebody started
 *    with `mise run hub` — is used as it is, and Ctrl-C leaves it running. Only
 *    a *local* endpoint with nothing answering gets a hub of our own, started
 *    in this process with {@link createHub} so that stopping it is the same
 *    flush-then-close the hub's own `main.ts` performs.
 *
 * 2. **It reconciles the two halves of the port configuration**, which is the
 *    asymmetry `ub doctor` explains: the hub binds `HUB_HOST`:`PORT` and never
 *    reads `HUB_URL`, while every client dials `HUB_URL`. A hub started here
 *    exists to answer the bundle this command is serving, so it binds the
 *    endpoint the bundle will dial. A `PORT` that disagrees is a warning naming
 *    both, never a silent bind of a socket nobody will connect to.
 *
 * 3. **It serves #91's configuration document** at {@link CONFIG_PATH}, with
 *    the resolved endpoint and workspace in it and `Cache-Control: no-store` on
 *    it, matched *ahead* of the SPA fallback. That document is what lets one
 *    prebuilt bundle target any hub; the fallback answering it with the app's
 *    own HTML is precisely the production failure #91 exists to remove.
 *
 * 4. **It never serves a blank page.** With no bundle and no toolchain it exits
 *    non-zero naming what is missing, rather than opening a browser onto 404s.
 *
 * The build shells out to pnpm rather than to `mise run build-web`: that task
 * wraps the build in `fnox exec --if-missing error`, and a user of `ub` has no
 * age key. Tasks are the documented way for *contributors* to run things; this
 * is a program running a build for somebody who was never told about either.
 *
 * ============================ LOUD WARNING ============================
 * A bundle built here embeds `HUB_AUTH_TOKEN`, exactly as `mise run build-web`
 * does. That is PRIVATE-SPIKE-ONLY: anything served to a browser is public.
 * `ub open` binds loopback, so the bundle reaches this machine only; serving it
 * to a network is #75's job and #84 removes the secret from the bundle.
 * =====================================================================
 */

import { spawn } from "node:child_process";
import { createReadStream, statSync } from "node:fs";
import type { IncomingMessage, Server, ServerResponse } from "node:http";
import { createServer } from "node:http";
import { dirname, extname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import type { Hub } from "@uberblick/hub";
import { createHub, resolveHubConfig } from "@uberblick/hub";
import { DEFAULT_HUB_URL, resolveMcpConfig } from "@uberblick/mcp-server";
import { resolveConfig } from "./config.js";
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

// --- the bundle --------------------------------------------------------------

export type BundleAction =
  /** A built bundle is there; serve it. */
  | { action: "serve"; dir: string }
  /** No bundle, but a web package to build one from — if pnpm is there. */
  | { action: "build"; dir: string }
  /** Neither, and `reason` says which half is missing. */
  | { action: "missing"; dir: string; reason: string };

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

  if (isFile(join(dir, "index.html"))) {
    return { action: "serve", dir };
  }
  if (override !== null) {
    return {
      action: "missing",
      dir,
      reason: `UBERBLICK_WEB_DIST names ${dir}, which holds no index.html`,
    };
  }
  if (!isFile(join(WEB_PACKAGE, "package.json"))) {
    return {
      action: "missing",
      dir,
      reason: `there is no built web app at ${dir}, and no web package beside this one to build from`,
    };
  }
  return { action: "build", dir };
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

/** Run the web build, resolving false when it did not produce a bundle. */
async function buildBundle(
  env: NodeJS.ProcessEnv,
  io: Io,
): Promise<boolean> {
  io.err(
    "ub open: no built web app yet — building it now with pnpm; this takes a moment\n",
  );
  const code = await new Promise<number>((done) => {
    const child = spawn("pnpm", ["--filter", "@uberblick/web", "build"], {
      cwd: dirname(packageRoot),
      env,
      // Both of the build's streams to stderr: stdout is where this command
      // prints the URL, and a caller reading it must not have to sift a build
      // log out of it first.
      stdio: ["ignore", 2, 2],
    });
    child.on("error", () => done(-1));
    child.on("close", (status) => done(status ?? 1));
  });
  return code === 0;
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
 * One key was #91's contract and `workspaces` is #189's second; both are read
 * by `packages/web/src/config.ts` and anything else is ignored. The workspace
 * is the spelling that is configured, decoration and all — the client parses
 * the uuid out of it, and the slug is what makes the switcher readable.
 */
export function configDocument(
  hubUrl: string,
  workspace: string | null,
): string {
  return JSON.stringify({
    hubUrl,
    workspaces: workspace === null ? [] : [workspace],
  });
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

function serveBundle(root: string, document: string): Server {
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
        document,
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
      `HUB_URL is ${JSON.stringify(hubUrl)}, which is not a websocket endpoint — ` +
        "set it to a ws:// or wss:// URL",
    );
  }
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

  // The hub binds HUB_HOST:PORT and never reads HUB_URL, so the two are only
  // ever in step because somebody kept them there. A hub started here exists to
  // answer the bundle this command serves, so the endpoint wins — and a PORT
  // that disagrees is said out loud rather than silently obeyed.
  const bind = hubBind(resolved);
  if (bind.raw !== null && bind.port !== endpoint.port) {
    io.err(
      `ub: warning: PORT is ${JSON.stringify(bind.raw)} but HUB_URL dials port ` +
        `${endpoint.port}; the hub started here binds ${endpoint.port}, because ` +
        "that is what the web app dials. `ub doctor` explains the two settings.\n",
    );
  }

  let hub: Hub;
  try {
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
  help: boolean;
}

function parseOptions(argv: string[]): Options {
  const { values, positionals } = parseArgs({
    args: argv,
    options: {
      browser: { type: "boolean" },
      port: { type: "string" },
      help: { type: "boolean", short: "h" },
    },
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
  return { port, browser: values.browser ?? true, help: values.help ?? false };
}

/** Wait for the signal that ends the foreground, then stop listening for it. */
function untilInterrupted(): Promise<void> {
  return new Promise((done) => {
    const stop = (): void => {
      process.off("SIGINT", stop);
      process.off("SIGTERM", stop);
      done();
    };
    process.on("SIGINT", stop);
    process.on("SIGTERM", stop);
  });
}

export async function openCommand(
  argv: string[],
  io: Io = processIo,
): Promise<number> {
  let options: Options;
  try {
    options = parseOptions(argv);
  } catch (error) {
    io.err(`ub open: ${message(error)}\n\n${OPEN_HELP}`);
    return 2;
  }
  if (options.help) {
    io.out(OPEN_HELP);
    return 0;
  }

  const resolved = resolveConfig();
  for (const warning of resolved.warnings) {
    io.err(`ub: warning: ${warning}\n`);
  }
  // The default lives in the MCP server's configuration, which is where every
  // other client reads it from; restating it here would be a second address.
  // Written back into the environment so a build started below bakes the same
  // endpoint into the bundle's fallback that the served document names.
  const hubUrl = trimmed(resolved.env.HUB_URL) ?? DEFAULT_HUB_URL;
  const env: NodeJS.ProcessEnv = { ...resolved.env, HUB_URL: hubUrl };

  const plan = bundlePlan(env);
  const missing =
    plan.action === "missing"
      ? plan.reason
      : plan.action === "build" && !(await hasCommand("pnpm"))
        ? `there is no built web app at ${plan.dir}, and pnpm — which builds it — is not on PATH`
        : null;
  if (missing !== null) {
    io.err(
      `ub open: ${missing}. Build one with \`mise run build-web\` in a checkout, ` +
        "or point UBERBLICK_WEB_DIST at a bundle.\n",
    );
    return 1;
  }
  if (plan.action === "build" && !(await buildBundle(env, io))) {
    io.err("ub open: the web build failed, so there is nothing to serve\n");
    return 1;
  }

  let decision: HubDecision;
  try {
    decision = await ensureHub(env, hubUrl, io);
  } catch (error) {
    io.err(`ub open: ${message(error)}\n`);
    return 1;
  }

  const workspace = trimmed(env.WORKSPACE_ID);
  const server = serveBundle(plan.dir, configDocument(hubUrl, workspace));
  try {
    await listen(server, WEB_HOST, options.port);
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
    await decision.started?.stop().catch(() => {});
    return 1;
  }

  const url = `http://${WEB_HOST}:${options.port}/`;
  let banner = `uberblick is at ${url}\n\n`;
  banner += `  hub        ${decision.note}\n`;
  banner += `  workspace  ${workspace ?? "none configured — run `ub init`"}\n`;
  banner += `  bundle     ${plan.dir}\n\n`;
  banner += "Ctrl-C to stop.\n";
  io.out(banner);

  if (options.browser) {
    openBrowser(url, env, io);
  }

  await untilInterrupted();

  // Ctrl-C stops what this command started, and only that. `close()` refuses new
  // connections and drops idle ones; `closeAllConnections` is what stops a
  // request already in flight from holding the port — and the whole point of a
  // foreground command is that Ctrl-C ends it now, not when a browser finishes
  // downloading a chunk.
  await new Promise<void>((done) => {
    server.close(() => done());
    server.closeAllConnections();
  });
  if (decision.started !== null) {
    try {
      // Flushes before it closes — the hub's own durability contract, which a
      // Ctrl-C must not skip.
      await decision.started.stop();
    } catch (error) {
      io.err(`ub open: the hub did not shut down cleanly: ${message(error)}\n`);
      return 1;
    }
  }
  return 0;
}

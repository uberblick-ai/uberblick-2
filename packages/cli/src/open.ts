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
import { isIPv4 } from "node:net";
import { dirname, extname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import type { Hub } from "@uberblick/hub";
import { createHub, resolveHubConfig } from "@uberblick/hub";
import { DEFAULT_HUB_URL, resolveMcpConfig } from "@uberblick/mcp-server";
import { resolveConfig } from "./config.js";
import { takeHelp } from "./help.js";
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

interface Foreground {
  /** True once a signal has arrived. Checked between startup steps. */
  interrupted: () => boolean;
  /** Resolves on the first SIGINT or SIGTERM. */
  signalled: Promise<void>;
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
  if (plan.action === "build" && !(await buildBundle(env, io))) {
    io.err("ub open: the web build failed, so there is nothing to serve\n");
    return await foreground.shutdown(1);
  }
  if (foreground.interrupted()) {
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
  const server = serveBundle(plan.dir, configDocument(hubUrl, workspace));
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

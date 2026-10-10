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
 *    endpoint — a remote one after `ub workspace use`, or one somebody started
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
 *    the local browser endpoint, frozen startup binding and recorded machine
 *    destinations, with independent browser keys and upstream endpoints and
 *    `Cache-Control: no-store` on it, matched *ahead* of the SPA fallback. That
 *    document is what lets one prebuilt bundle target any hub; the fallback
 *    answering it with the app's own HTML is precisely the production failure
 *    #91 exists to remove. A serving run freezes its binding at startup so the
 *    browser and silent replicas cannot split identities; later binding changes
 *    add `rebound: true` until restart. Unbound serving retains
 *    #449's per-request resolution because it owns no replica identity.
 *
 * 4. **It never serves a blank page.** With no bundle it exits 1 naming what
 *    is missing, rather than opening a browser onto 404s.
 *    A bundle that is *there* but stale is that blank page with extra steps: one
 *    built before a `SYNC_PROTOCOL_VERSION` bump sends a pre-envelope auth
 *    message, the hub refuses it as an unparseable one, and the page sits at
 *    `syncing…` and `0 docs` with nothing naming the cause (#452). So the build
 *    stamps the protocol it speaks into {@link BUILD_STAMP}, this command
 *    compares it to its own before it starts anything, and a bundle that
 *    differs — or carries no stamp, which is what one built before the stamp
 *    looks like — never gets served. A checkout's default bundle is refused
 *    with `mise run build-web` as the next step; a bundle `UBERBLICK_WEB_DIST`
 *    named is refused with both versions and the rebuild named. It compares
 *    the CLI and bundle protocols; whether the *hub* speaks it too is still
 *    settled at connect, where it always was.
 *
 * This command never builds or changes a bundle. Contributors build through
 * `mise run build-web`; installations serve their packaged web app. Bundle
 * refusals happen before a hub starts or a database file is created.
 */

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
import { budget, resolveMcpConfig } from "./budget.js";
import { openBrowser } from "./browser.js";
import { ensureLocalSigningSecret, readCredentials, resolveConfig, requireBinding } from "./config.js";
import { takeHelp } from "./help.js";
import { isInstallPayload } from "./installation.js";
import { acquireInitLock, tryAcquireInitLock } from "./init-lock.js";
import type { Io } from "./io.js";
import { processIo } from "./io.js";
import { readAccessAction, requestAccess, type AccessBinding } from "./open-access.js";
import { requestAccount } from "./open-account.js";
import { BrowserReplicas, BrowserReplicaUnavailable, browserWorkspaces, type ServedWorkspace } from "./open-workspaces.js";
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

/** The default bundle, an installed payload, or a caller-supplied artifact. */
type BundleSource = "default" | "installed" | "override";

export type BundleAction =
  | { action: "serve"; dir: string; source: BundleSource }
  | { action: "missing"; dir: string; source: BundleSource; reason: string };

function isFile(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

/**
 * Find the prebuilt bundle, independently of the working directory.
 * An override is the caller's artifact, even when it names the default path.
 */
export function bundlePlan(env: NodeJS.ProcessEnv = process.env): BundleAction {
  const override = trimmed(env.UBERBLICK_WEB_DIST);
  const dir = override === null ? resolve(DEFAULT_BUNDLE) : resolve(override);
  const source = override !== null ? "override" : isInstallPayload() ? "installed" : "default";

  if (isFile(join(dir, "index.html"))) {
    return { action: "serve", dir, source };
  }
  const reason = source === "override"
    ? `UBERBLICK_WEB_DIST names ${dir}, which holds no index.html`
    : source === "installed"
      ? `the installed web app at ${dir} holds no index.html`
      : `there is no built web app at ${dir}`;
  return { action: "missing", dir, source, reason };
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

/** Why a bundle cannot sync, and the recovery for the copy being served. */
function staleBundle(dir: string, stamped: number | null, source: BundleSource): string {
  if (source === "installed") {
    return (
      `ub open: the installed web app at ${dir} ${speaks(stamped)}, and this uberblick speaks ` +
      `${SYNC_PROTOCOL_VERSION} — it could not sync, so it is not being served. ` +
      "Reinstall Uberblick; an installation never rebuilds or changes its packaged web app at run time.\n"
    );
  }
  const recovery = source === "default"
    ? "Rebuild it with `mise run build-web` from the checkout.\n"
    : "Rebuild it with `pnpm --filter @uberblick/web build`, or with " +
      "`mise run build-web` from a checkout.\n";
  return (
    `ub open: the web app at ${dir} ${speaks(stamped)}, and this uberblick speaks ` +
    `${SYNC_PROTOCOL_VERSION} — it could not sync, so it is not being served. ` + recovery
  );
}

/**
 * Check the bundle without changing it. Every refusal precedes hub and
 * database startup; building is the contributor's explicit mise task.
 */
export function ensureBundle(plan: BundleAction, io: Io): "servable" | "refused" {
  if (plan.action === "missing" || !isFile(join(plan.dir, "index.html"))) {
    const reason = plan.action === "missing"
      ? plan.reason
      : `the web app at ${plan.dir} holds no index.html`;
    const recovery = plan.source === "installed"
      ? "Reinstall Uberblick; an installation never builds or changes its packaged web app at run time."
      : plan.source === "default"
        ? "Run `mise run build-web` from the checkout."
        : "Point UBERBLICK_WEB_DIST at a built bundle, or build one from a checkout — CONTRIBUTING.md's Updating section links the build instructions.";
    io.err(`ub open: ${reason}. ${recovery}\n`);
    return "refused";
  }
  const stamped = stampedProtocol(plan.dir);
  if (stamped === SYNC_PROTOCOL_VERSION) return "servable";
  io.err(staleBundle(plan.dir, stamped, plan.source));
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
 * The legacy endpoint/key describe the startup workspace. Local serving also
 * publishes an exact UUID-to-browser-key/upstream map for the offered replicas.
 * Workspace strings preserve the startup spelling; bare UUIDs key admission.
 *
 * Serialization only. {@link configSource} supplies live direct-serving
 * values; {@link servingConfigSource} supplies frozen local/upstream pairs and
 * the live `rebound` diagnostic. Only the loopback browser key may be served;
 * an unbound process has no key to give the page.
 */
export function configDocument(
  hubUrl: string,
  workspace: string | null,
  hubAuthToken: string,
  serving?: {
    remoteHubUrl: string;
    rebound: boolean;
    workspaces?: readonly string[];
    servedWorkspaces?: Record<string, { browserKey: string; remoteHubUrl: string | null; name: string | null }>;
  },
): string {
  return JSON.stringify({
    hubUrl,
    workspaces: serving?.workspaces ?? (workspace === null ? [] : [workspace]),
    hubAuthToken,
    ...(serving === undefined
      ? {}
      : {
          remoteHubUrl: serving.remoteHubUrl,
          ...(serving.rebound ? { rebound: true } : {}),
          ...(serving.servedWorkspaces === undefined ? {} : { servedWorkspaces: serving.servedWorkspaces }),
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
 * file values into apparent permanent overrides, and no later `ub workspace use`
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
 * `ub workspace create`, `ub workspace use` and `ub open` publish configuration
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
 * The frozen local-serving destinations, plus one live fact: whether this machine
 * has since been rebound and `ub open` must be restarted.
 */
function servingConfigSource(
  env: NodeJS.ProcessEnv,
  startup: ReturnType<typeof resolveConfig>,
  localHubUrl: string,
  workspaces: ReadonlyMap<string, ServedWorkspace>,
): () => string {
  const binding = bindingOf(startup);
  const startupId = workspaces.keys().next().value;
  const destinations = {
    workspaces: [...workspaces.values()].map(entry => entry.workspace),
    servedWorkspaces: Object.fromEntries([...workspaces].map(([id, entry]) => [id, {
      browserKey: entry.browserKey,
      name: entry.name,
      // The startup replica retains ensureHub's loopback behavior. Explicit
      // local-only secondaries have no upstream to name or start.
      remoteHubUrl: id === startupId ? binding.hubUrl : entry.binding.hubUrl,
    }])),
  };
  const browserKey = workspaces.values().next().value?.browserKey ?? "";
  let accepted = configDocument(
    localHubUrl,
    binding.workspace,
    browserKey,
    { remoteHubUrl: binding.hubUrl, rebound: false, ...destinations },
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
        { remoteHubUrl: binding.hubUrl, rebound: !sameBinding(binding, current), ...destinations },
      );
      return accepted;
    } finally {
      lock.release();
    }
  };
}

/** Resolve the startup binding and its first served document as one snapshot. */
async function initialConfig(env: NodeJS.ProcessEnv, ensureSecret = false): Promise<{
  resolved: ReturnType<typeof resolveConfig>;
  document: string;
  secretCreated: string | null;
}> {
  const lock = await acquireInitLock(env, { command: "ub open" });
  try {
    let resolved = resolveConfig({ env });
    let secretCreated: string | null = null;
    if (ensureSecret) {
      const hubUrl = trimmed(resolved.env.HUB_URL) ?? DEFAULT_HUB_URL;
      const endpoint = endpointOf(hubUrl);
      // A device-authenticated deployment stays external even on localhost.
      // A secret is useful only for an endpoint this command can start here.
      if (endpoint !== null && isLocalHost(endpoint.host) &&
          !usesDeviceLogin(hubUrl, resolved.env) &&
          whyNotStartable(hubUrl, new URL(hubUrl)) === null &&
          trimmed(resolved.env.HUB_AUTH_TOKEN) === null) {
        // Refuse an exposed store before looking for an existing local hub;
        // repairing its permissions would keep a possibly leaked secret.
        if (readCredentials(env).exposed) ensureLocalSigningSecret(env);
        // An occupied endpoint belongs to a hub or another process that this
        // command will leave alone. It needs none of our new credentials.
        if ((await probePort(endpoint.host, endpoint.port)).state === "free") {
          const secret = ensureLocalSigningSecret(env);
          if (secret.created) secretCreated = secret.path;
          resolved = resolveConfig({ env });
        }
      }
    }
    return { resolved, document: resolvedConfigDocument(resolved), secretCreated };
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

// SPIKE ONLY (spikes/embeds): the strictest policy worth starting from, plus
// the embed providers' frame-src. Violations show what the app really needs.
const SPIKE_CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self'",
  "img-src 'self' data:",
  "font-src 'self'",
  "connect-src 'self'",
  "frame-src https://embed.figma.com https://www.figma.com https://www.youtube-nocookie.com https://www.loom.com",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self'",
].join("; ");

const API_PREFIX = "/api/";
const SEARCH_PATH = "/api/search";
const STATUS_PATH = "/api/status";
const ACCESS_PATH = "/api/access";
const ACCOUNT_PATH = "/api/account";
const SEARCH_LIMIT = 100;
const TOKEN_QUERY_PARAMS = ["token", "access_token", "auth", "authToken"];

type ApiAuthenticator = (authMessage: string) => Promise<string | null>;
type ApiStatus = () => ServingSyncStatus;

async function createApiAuthenticator(
  workspaces: ReadonlyMap<string, ServedWorkspace>,
): Promise<ApiAuthenticator> {
  const keys = new Map(await Promise.all([...workspaces].map(async ([id, workspace]) => [id, await importRootSecret(workspace.browserKey)] as const)));
  return async (authMessage) => {
    const envelope = readAuthEnvelope(authMessage);
    if (
      envelope === null ||
      envelope.protocolVersion !== SYNC_PROTOCOL_VERSION
    ) {
      return null;
    }
    // Reuse the bounded token verifier. A valid signature alone is insufficient:
    // each key admits only its own workspace, including on the HTTP boundary.
    for (const [workspaceId, key] of keys) {
      const claims = await verifyToken(key, envelope.token);
      if (claims !== null && claims.workspace === workspaceId &&
        clampToken(claims, Math.floor(Date.now() / 1_000)) === null) return workspaceId;
    }
    return null;
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
  replicas: BrowserReplicas,
  statusForWorkspace: (workspace: string) => ServingSyncStatus,
  env: NodeJS.ProcessEnv,
  expectedOrigin: string,
): Promise<void> {
  const queriedToken = TOKEN_QUERY_PARAMS.some((name) =>
    target.searchParams.has(name),
  );
  const authMessage = bearerToken(request);
  const workspaceId = queriedToken || authMessage === null ? null : await authenticate(authMessage);
  if (
    workspaceId === null ||
    (target.searchParams.has("workspace") && target.searchParams.get("workspace") !== workspaceId)
  ) {
    apiResponse(request, response, 401, { error: "unauthorized" });
    return;
  }

  const workspace = replicas.workspaces.get(workspaceId);
  if (workspace === undefined) {
    apiResponse(request, response, 401, { error: "unauthorized" });
    return;
  }
  let engine: UberblickMcpEngine;
  try { engine = await replicas.prepare(workspaceId); }
  catch (error) {
    apiResponse(request, response, 503, {
      error: "replica_unavailable",
      reason: error instanceof BrowserReplicaUnavailable ? error.reason : "replica-failed",
    });
    return;
  }
  const status: ApiStatus = () => statusForWorkspace(workspaceId);
  const accessBinding: AccessBinding = { workspaceId, hubUrl: workspace.binding.hubUrl, env };

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
  if (target.pathname === ACCOUNT_PATH) {
    const aborted = new AbortController();
    const abort = () => { if (!response.writableFinished) aborted.abort(); };
    request.once("aborted", abort);
    response.once("close", abort);
    try {
      apiResponse(request, response, 200, await requestAccount(accessBinding, () => status().notSharedReason, aborted.signal));
    } finally {
      request.off("aborted", abort);
      response.off("close", abort);
    }
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
  replicas: BrowserReplicas,
  status: (workspace: string) => ServingSyncStatus,
  env: NodeJS.ProcessEnv,
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
    replicas,
    status,
    env,
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
      // SPIKE ONLY (spikes/embeds, never merged): a strict report-only policy
      // to list what the current app would need from a real CSP.
      "content-security-policy-report-only": SPIKE_CSP,
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
        "anything — run `ub workspace create <name>` or `ub open` with a free local hub port)",
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
  replicas: BrowserReplicas | null;
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

    owned.engineMonitor?.stop();
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
    if (owned.replicas !== null || owned.engine !== null) {
      try {
        if (owned.replicas !== null) await owned.replicas.close();
        else await owned.engine?.close();
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
  let initial = await initialConfig(startupEnv);
  let projectBinding = requireBinding(initial.resolved);
  for (const warning of initial.resolved.warnings) {
    io.err(`ub: warning: ${warning}\n`);
  }
  // The default lives in the MCP server's configuration, which is where every
  // other client reads it from; restating it here would be a second address.
  let hubUrl = trimmed(initial.resolved.env.HUB_URL) ?? DEFAULT_HUB_URL;
  let env: NodeJS.ProcessEnv = { ...initial.resolved.env, HUB_URL: hubUrl };

  const owned: Owned = {
    hub: null,
    server: null,
    localServer: null,
    engine: null,
    engineMonitor: null,
    replicas: null,
  };
  const foreground = takeForeground(owned, io);
  let hubNote = "";

  const plan = bundlePlan(env);
  // Before ensureHub: a bundle refusal starts no hub and creates no database.
  const bundle = ensureBundle(plan, io);
  if (bundle === "refused") {
    return await foreground.shutdown(1);
  }
  if (foreground.interrupted()) {
    return await foreground.shutdown(0);
  }

  try {
    initial = await initialConfig(startupEnv, true);
    projectBinding = requireBinding(initial.resolved);
    hubUrl = trimmed(initial.resolved.env.HUB_URL) ?? DEFAULT_HUB_URL;
    env = { ...initial.resolved.env, HUB_URL: hubUrl };
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
      const workspaces = browserWorkspaces(projectBinding, mcpConfig, startupEnv,
        message => io.err(`ub: warning: ${message}\n`));
      const authenticateApi = await createApiAuthenticator(workspaces);
      const document = servingConfigSource(
        startupEnv,
        initial.resolved,
        localHubUrl,
        workspaces,
      );
      const observedServedRooms = new Set<string>();
      let collectingServedRooms: Set<string> | null = null;
      let localServer: LocalBrowserServer | null = null;
      const replicas = new BrowserReplicas(workspaces, engine, workspaceId => localServer?.refresh(workspaceId));
      owned.replicas = replicas;
      const status = (workspaceId: string): ServingSyncStatus => {
        if (localServer !== null) {
          const current = new Set<string>();
          collectingServedRooms = current;
          try {
            // `refresh` synchronously walks this workspace's loaded rooms. The
            // read callback below therefore gives this endpoint exactly the
            // rooms the in-process server currently has loaded, including the
            // directory and sidebar rooms.
            localServer.refresh(workspaceId);
          } finally {
            collectingServedRooms = null;
          }
          observedServedRooms.clear();
          for (const room of current) observedServedRooms.add(room);
        }
        return collectServingSyncStatus(replicas.read(workspaceId), [...observedServedRooms].filter(room => parseRoom(room).workspaceId === workspaceId));
      };
      const engineForRoom = (room: string): UberblickMcpEngine => replicas.read(parseRoom(room).workspaceId);
      localServer = await createLocalBrowserServer({
        port: options.port,
        workspaces: new Map([...workspaces].map(([id, entry]) => [id, entry.browserKey])),
        expectedOrigin: servedUrl.origin,
        prepareRoom: async room => { await replicas.prepare(parseRoom(room).workspaceId); },
        readRoom: (room, afterSeq) => {
          (collectingServedRooms ?? observedServedRooms).add(room);
          return engineForRoom(room).store.readSince(room, afterSeq);
        },
        appendUpdate: (room, payload) => {
          engineForRoom(room).store.appendUpdate(room, payload, "local");
        },
        awarenessForRoom: (room) => {
          const engine = engineForRoom(room);
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
            replicas,
            status,
            startupEnv,
            servedUrl.origin,
            request,
            response,
          );
        },
      });
      owned.localServer = localServer;
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
  if (initial.secretCreated !== null) banner += `  secret     created ${initial.secretCreated} (0600)\n`;
  banner += `  hub        ${hubNote}\n`;
  banner += `  workspace  ${workspace ?? "none configured — run `ub workspace create <name>`"}\n\n`;
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

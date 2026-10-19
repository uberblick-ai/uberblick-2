import { execFile } from "node:child_process";
import { createReadStream, readFileSync, statSync } from "node:fs";
import type { IncomingMessage, Server, ServerResponse } from "node:http";
import { createServer } from "node:http";
import { userInfo } from "node:os";
import { dirname, extname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs, promisify } from "node:util";
import { createHub, silentLogger, type Hub } from "@uberblick/hub";
import { createLocalBrowserServer, type LocalBrowserServer } from "./local-browser-server.js";
import { importRootSecret, verifyToken } from "@uberblick/schema/token";
import { resolveHubConfig } from "./hub-config.js";
import {
  SYNC_PROTOCOL_VERSION,
  isProtocolVersion,
  readAuthEnvelope,
} from "@uberblick/schema/protocol";
import { clampToken } from "@uberblick/schema/token";
import { WEB_CONTENT_SECURITY_POLICY } from "@uberblick/schema/web-policy";
import { hubTransportProblem, isLoopbackHost } from "@uberblick/mcp-server/remote-url";
import { readDeviceLogin } from "@uberblick/mcp-server/device-login";
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
  readWorkspaceName,
  usesDeviceLogin,
  withLoggingDisabled,
  type ServingSyncStatus,
  type HubState,
  type UberblickMcpEngine,
} from "@uberblick/mcp-server";
import { budget, resolveMcpConfig } from "./budget.js";
import { openBrowser } from "./browser.js";
import { trimmed } from "./strings.js";
import { ensureLocalSigningSecret, readCredentials, resolveConfig, requireBinding } from "./config.js";
import { takeHelp } from "./help.js";
import { isInstallPayload } from "./installation.js";
import { acquireInitLock, tryAcquireInitLock } from "./init-lock.js";
import type { Io } from "./io.js";
import { processIo } from "./io.js";
import { readAccessAction, requestAccess, type AccessBinding } from "./open-access.js";
import { createBrowserAccess, hasSession, serveSessionRequest, type BrowserAccess } from "./open-session.js";
import { requestAccount, requestDeviceLogin } from "./open-account.js";
import { monitorOpenHub, waitForOpenHubState } from "./open-hub-output.js";
import { openBanner } from "./open-output.js";
import { requestRecentDevices } from "./recent-devices.js";
import { BrowserReplicas, BrowserReplicaUnavailable, browserWorkspaces, type ServedWorkspace } from "./open-workspaces.js";
import { assertWorkspaceBinding, rememberWorkspaceBindings } from "./workspace-registry.js";
import { displayWorkspaceHub } from "./workspace-use-output.js";
import {
  endpointOf,
  hubBind,
  isLocalHost,
  probeHubState,
  probePort,
} from "./probes.js";

/**
 * Runtime configuration lets one prebuilt bundle target any hub.
 * The web client, Caddy and this server must agree on the path and shape.
 */
const CONFIG_PATH = "/uberblick-config.json";

/**
 * Keep a stable origin for browser settings, distinct from Vite's defaults.
 * An occupied port is an error; never choose another automatically.
 */
export const DEFAULT_WEB_PORT = 13379;

export const WEB_HOST = "127.0.0.1";

const packageRoot = dirname(dirname(fileURLToPath(import.meta.url)));

// Resolve the default bundle from this module, independently of the cwd.
const DEFAULT_BUNDLE = join(packageRoot, "..", "web", "dist");

export const OPEN_HELP = `usage: ub open [options]

Serve the web app for this project's workspace, with a hub behind it, and open the browser. Runs until Ctrl-C.

options:
  --no-browser      Print the address instead of opening a browser
  --port <n>        Port for the web app (default ${DEFAULT_WEB_PORT})
  --verbose         Also print hub, sync and startup details for debugging
  -h, --help        show this help

BROWSER in the environment names the command used to open the URL; BROWSER=none
suppresses it, like --no-browser.
`;

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

const runFile = promisify(execFile);

/** Optional git configuration must never keep the web app from serving. */
async function defaultPresenceName(env: NodeJS.ProcessEnv): Promise<string> {
  try {
    const { stdout } = await runFile("git", ["config", "user.name"], {
      cwd: process.cwd(),
      env,
      encoding: "utf8",
      maxBuffer: Number.POSITIVE_INFINITY,
      timeout: 1_000,
      killSignal: "SIGKILL",
    });
    const name = trimmed(stdout);
    if (name !== null) return name;
  } catch {
    // Missing git, an unset name, failed configuration and a stalled lookup
    // all use the same OS identity without a prompt or startup refusal.
  }
  return userInfo().username;
}

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
 * Keep this filename and its syncProtocolVersion field aligned with the
 * stamp emitted by packages/web/vite.config.ts.
 */
const BUILD_STAMP = "uberblick-build.json";

/**
 * Missing, unreadable or malformed stamps all yield null for a normal
 * refusal rather than a stack trace.
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

function speaks(stamped: number | null): string {
  return stamped === null
    ? "carries no sync protocol stamp"
    : `speaks sync protocol ${stamped}`;
}

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
 * Refuse before hub/database startup without changing the bundle. Compare
 * CLI and bundle protocols here; the hub's protocol is checked at connection.
 * Caller bundles name both versions and a rebuild; installed copies reinstall.
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
  ".webmanifest": "application/manifest+json",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
  ".txt": "text/plain; charset=utf-8",
};

/**
 * SPA deep links fall back to index.html, as in Caddy's try_files rule.
 * Answer CONFIG_PATH first so configuration never receives the HTML fallback.
 * Traversal, absolute paths, malformed escaping and NULs also fall back.
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
 * The endpoint describes startup; the UUID map gives each offered replica its
 * upstream. Preserve workspace spelling but admit by bare UUID. The document is
 * public and carries no key: a page with a session asks for room tokens.
 * configSource refreshes unbound values; servingConfigSource freezes destinations
 * and updates only rebound, keeping browser and replica identities aligned.
 */
function configDocument(
  hubUrl: string,
  workspace: string | null,
  hubAuthToken: string,
  serving?: {
    remoteHubUrl: string;
    rebound: boolean;
    workspaces?: readonly string[];
    servedWorkspaces?: Record<string, { remoteHubUrl: string | null; name: string | null }>;
  },
  defaultPresenceName?: string,
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
    ...(defaultPresenceName === undefined ? {} : { defaultPresenceName }),
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
 * Re-resolve from the original environment: feeding resolved file values back
 * would turn them into permanent environment pins and hide binding changes.
 */
function currentConfigDocument(env: NodeJS.ProcessEnv, defaultPresenceName: string): string {
  const resolved = resolveConfig({ env });
  return resolvedConfigDocument(resolved, defaultPresenceName);
}

function resolvedConfigDocument(resolved: ReturnType<typeof resolveConfig>, defaultPresenceName?: string): string {
  const binding = bindingOf(resolved);
  return configDocument(binding.hubUrl, null, "", undefined, defaultPresenceName);
}

/**
 * Unbound requests refresh only the endpoint, without a workspace or browser key.
 * Hold the writers' init lock across both atomic-file reads for one publication.
 * Serve the last accepted value without waiting only while a writer holds it;
 * completed removals and permission refusals resolve normally, without stale cache.
 */
function configSource(env: NodeJS.ProcessEnv, initial: string, defaultPresenceName: string): () => string {
  let accepted = initial;
  return () => {
    const lock = tryAcquireInitLock(env);
    if (lock === null) {
      return accepted;
    }
    try {
      accepted = currentConfigDocument(env, defaultPresenceName);
      return accepted;
    } finally {
      lock.release();
    }
  };
}

/**
 * Freeze startup destinations; a later binding change sets rebound until restart.
 */
function servingConfigSource(
  env: NodeJS.ProcessEnv,
  startup: ReturnType<typeof resolveConfig>,
  localHubUrl: string,
  workspaces: ReadonlyMap<string, ServedWorkspace>,
  defaultPresenceName: string,
): () => string {
  const binding = bindingOf(startup);
  const startupId = workspaces.keys().next().value;
  const destinations = {
    workspaces: [...workspaces.values()].map(entry => entry.workspace),
    servedWorkspaces: Object.fromEntries([...workspaces].map(([id, entry]) => [id, {
      name: entry.name,
      // The startup replica retains ensureHub's loopback behavior. Explicit
      // local-only secondaries have no upstream to name or start.
      remoteHubUrl: id === startupId ? binding.hubUrl : entry.binding.hubUrl,
    }])),
  };
  let accepted = configDocument(
    localHubUrl,
    binding.workspace,
    "",
    { remoteHubUrl: binding.hubUrl, rebound: false, ...destinations },
    defaultPresenceName,
  );
  return () => {
    const lock = tryAcquireInitLock(env);
    if (lock === null) return accepted;
    try {
      const current = bindingOf(resolveConfig({ env }));
      accepted = configDocument(
        localHubUrl,
        binding.workspace,
        "",
        { remoteHubUrl: binding.hubUrl, rebound: !sameBinding(binding, current), ...destinations },
        defaultPresenceName,
      );
      return accepted;
    } finally {
      lock.release();
    }
  };
}

/** Resolve the startup binding and its first served document as one snapshot. */
async function initialConfig(env: NodeJS.ProcessEnv, ensureSecret = false, defaultPresenceName?: string): Promise<{
  resolved: ReturnType<typeof resolveConfig>;
  document: string;
  secretCreated: string | null;
}> {
  const lock = await acquireInitLock(env, { command: "ub open" });
  try {
    let resolved = resolveConfig({ env });
    const binding = requireBinding(resolved);
    assertWorkspaceBinding(binding, resolved.env, resolved.paths.projectConfig ?? "environment");
    let secretCreated: string | null = null;
    if (ensureSecret) {
      rememberWorkspaceBindings([binding], resolved.env);
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
    return { resolved, document: resolvedConfigDocument(resolved, defaultPresenceName), secretCreated };
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
const ACCOUNT_PATH = "/api/account";
const DEVICE_LOGIN_PATH = "/api/device-login";
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
  document: () => string,
  access: BrowserAccess,
): Promise<void> {
  const reply = (status: number, body: object, headers?: Record<string, string>) =>
    apiResponse(request, response, status, body, headers);
  if (await serveSessionRequest(access, request, target.pathname, expectedOrigin, reply)) return;
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
  // A room token alone is not enough: every API call also names the page's session.
  if (!hasSession(access, request)) {
    apiResponse(request, response, 401, { error: "session_required" });
    return;
  }
  if (target.pathname === DEVICE_LOGIN_PATH) {
    if (request.method !== "GET") {
      apiResponse(request, response, 405, { error: "method_not_allowed" }, { allow: "GET" });
      return;
    }
    const rebound = replicas.workspaces.keys().next().value === workspaceId &&
      JSON.parse(document()).rebound === true;
    apiResponse(request, response, 200, requestDeviceLogin({ workspaceId, hubUrl: workspace.binding.hubUrl, env }, rebound));
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
    apiResponse(request, response, 200, {
      hits: engine.store.searchUuids(query).map((uuid) => ({ uuid })),
      capped: false,
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
  access: BrowserAccess,
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
    document,
    access,
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
          // Cached configuration would keep a retargeted client on its old hub.
          "cache-control": "no-store",
        },
        document(),
      );
      return;
    }

    const file = fileFor(root, pathname);
    const contentType = MIME[extname(file).toLowerCase()] ?? "application/octet-stream";
    const headers = {
      "content-type": contentType,
      // The bundle's filenames are content-hashed by Vite, but index.html is
      // not, and a stale one points at assets that are gone.
      "cache-control": "no-cache",
      ...(contentType === MIME[".html"] ? {
        "content-security-policy": WEB_CONTENT_SECURITY_POLICY,
      } : {}),
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

/** Reject bind failures instead of letting an unhandled error escape. */
function listen(server: Server, host: string, port: number): Promise<void> {
  return new Promise((done, failed) => {
    server.once("error", failed);
    server.listen({ host, port, exclusive: true }, () => {
      server.off("error", failed);
      done();
    });
  });
}

export type PortHolder = "ub-open" | "foreign" | "unidentified";

/**
 * Classify only a complete answer within budget: our configuration is ub-open;
 * refusals, other documents and invalid JSON are foreign. An incomplete or
 * expired response is unidentified, even if a healthy ub open answered late.
 * Never advise stopping a holder that the probe could not identify.
 */
export async function whoHoldsPort(port: number): Promise<PortHolder> {
  let body: string;
  let ok: boolean;
  try {
    const response = await fetch(`http://${WEB_HOST}:${port}${CONFIG_PATH}`, {
      cache: "no-store",
      signal: AbortSignal.timeout(budget(1_000)),
    });
    // Read the body before classifying status; headers alone identify nobody.
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
  // An unidentified holder gets advice safe for either kind of process.
  return (
    `ub open: port ${port} is in use, and its holder did not answer in time to ` +
    "say what it is — serve the web app elsewhere with --port\n"
  );
}

interface HubDecision {
  /** The hub this command started, and is therefore responsible for stopping. */
  started: Hub | null;
  note: string;
  showNote?: boolean;
  deviceHub?: boolean;
}

/**
 * A started hub must answer exactly what the bundle dials: plain ws on
 * loopback with an explicit nonzero port. No TLS, default-port guess or
 * ephemeral-port substitution is available here.
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
 * Hub reachability requires authenticated directory-room access, not just TCP.
 * Without a workspace or signing secret, only port occupancy can be probed.
 */
async function ensureHub(
  resolved: NodeJS.ProcessEnv,
  hubUrl: string,
  io: Io,
  verbose: boolean,
): Promise<HubDecision> {
  const endpoint = endpointOf(hubUrl);
  if (endpoint === null) {
    throw new Error(
      `the configured endpoint ${JSON.stringify(hubUrl)} is not a websocket ` +
        "endpoint — it has to be a ws:// or wss:// URL",
    );
  }
  // Preserve the scheme and explicit port for the startup eligibility check.
  const parsed = new URL(hubUrl);
  const transport = hubTransportProblem(hubUrl, resolved);
  if (transport !== null) {
    return { started: null, note: `${transport.reason}; ${transport.fix}`, showNote: true };
  }
  const workspace = trimmed(resolved.WORKSPACE_ID);
  const displayHub = isLocalHost(endpoint.host) ? hubUrl : displayWorkspaceHub(hubUrl);
  const signInRequired = workspace !== null && readDeviceLogin(hubUrl, workspace, resolved).status === "sign-in-required";
  if (usesDeviceLogin(hubUrl, resolved) && signInRequired) {
    return { started: null, note: `${displayHub} (not signed in, changes stay here)` };
  }
  if (!isLocalHost(endpoint.host)) {
    return { started: null, note: `${displayHub} (remote, nothing started here)` };
  }

  if (usesDeviceLogin(hubUrl, resolved)) {
    // The serving replica supplies the bounded authenticated reading below.
    return { started: null, note: `${hubUrl} (device-authenticated hub; nothing started here)`, deviceHub: true };
  }

  const secret = trimmed(resolved.HUB_AUTH_TOKEN);

  if (secret === null) {
    // Refuse startup without a signing secret; absence is distinct from downtime.
    return {
      started: null,
      showNote: true,
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
      if (probe.authRecovery === "sign-in-required" && signInRequired) {
        return { started: null, note: `${displayHub} (not signed in, changes stay here)`, deviceHub: true };
      }
      return { started: null, note: `${hubUrl} (${probe.reason ?? "credential refused"}; nothing started here)`, showNote: true,
        deviceHub: probe.authRecovery !== undefined };
    }
  } else {
    // Without a workspace, leave any occupied port alone and still serve the app.
    const port = await probePort(endpoint.host, endpoint.port);
    if (port.state !== "free") {
      return { started: null, note: `${hubUrl} (already taken — left alone)` };
    }
  }

  // Startup restrictions do not apply to a hub already answering the endpoint.
  const refusal = whyNotStartable(hubUrl, parsed);
  if (refusal !== null) {
    throw new Error(refusal);
  }

  // The hub reads HUB_HOST:PORT, not HUB_URL. Bind the dialled endpoint and
  // warn on a conflicting PORT rather than silently starting an unreachable hub.
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
    // whyNotStartable has fenced this exact dialled address to loopback.
    hub = await createHub(
      { ...resolveHubConfig({
        ...resolved,
        PORT: String(endpoint.port),
        HUB_HOST: endpoint.host,
      }), ...(!verbose ? { log: silentLogger } : {}) },
    );
  } catch (error) {
    // An occupied port after a failed auth probe has no identified holder;
    // point to doctor's local hub check rather than guessing.
    if ((error as NodeJS.ErrnoException).code === "EADDRINUSE") {
      throw new Error(
        `nothing at ${hubUrl} answered this machine's credential, and its port ` +
          "is held by something else, so no hub could be started for it — " +
          "`ub doctor` says what holds it",
      );
    }
    throw error;
  }
  return { started: hub, note: `${hubUrl} (started here)` };
}

interface Options {
  port: number;
  browser: boolean;
  verbose: boolean;
}

export const OPEN_OPTIONS = {
  "no-browser": { type: "boolean" },
  port: { type: "string" },
  verbose: { type: "boolean" },
} as const;

function parseOptions(argv: string[]): Options {
  const { values, positionals } = parseArgs({
    args: argv,
    options: OPEN_OPTIONS,
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
  return { port, browser: !values["no-browser"], verbose: values.verbose ?? false };
}

/** What this command started, and is therefore responsible for stopping. */
interface Owned {
  hub: Hub | null;
  server: Server | null;
  localServer: LocalBrowserServer | null;
  engine: UberblickMcpEngine | null;
  engineMonitor: EngineMonitor | null;
  replicas: BrowserReplicas | null;
  hubMonitor: { stop(): void } | null;
}

interface EngineMonitor {
  readonly failed: Promise<string>;
  failure(): string | null;
  stop(): void;
}

function openHubSource(engine: UberblickMcpEngine, hubUrl: string, env: NodeJS.ProcessEnv, deviceHub: boolean) {
  if (hubTransportProblem(hubUrl, env) !== null) return null;
  const sync = engine.replicas.sync;
  return {
    state: (): HubState => {
      const state = sync.state();
      if (state.authRecovery !== undefined) deviceHub = true;
      // A missing local login cannot establish whether the hub is reachable.
      if ((state.status === "connecting" || state.status === "hub-down") && missingHubLogin(hubUrl, env, deviceHub)) {
        return { ...state, status: "auth-failed", authRecovery: "sign-in-required" };
      }
      return state;
    },
    onStateChange: (listener: () => void) => sync.onStateChange(listener),
    deviceAuthenticated: () => deviceHub,
  };
}

function missingHubLogin(hubUrl: string, env: NodeJS.ProcessEnv, deviceHub: boolean): boolean {
  if (hubTransportProblem(hubUrl, env) !== null) return false;
  const workspace = trimmed(env.WORKSPACE_ID);
  return workspace !== null && deviceHub &&
    readDeviceLogin(hubUrl, workspace, env).status === "sign-in-required";
}

/** Both readings share the startup connection budget, including response bodies. */
async function openStartupReadings(
  sync: ReturnType<typeof openHubSource>,
  connectTimeoutMs: number,
  binding: AccessBinding,
) {
  return await Promise.all([
    sync === null ? null : waitForOpenHubState(sync, connectTimeoutMs),
    sync === null || !sync.deviceAuthenticated() || connectTimeoutMs <= 0 ? null
      : requestRecentDevices(binding, AbortSignal.timeout(Math.floor(connectTimeoutMs))).then(reading => reading?.devices ?? null),
  ]);
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
    failure: () => { inspect(); return failure; },
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
 * Install signal handlers before startup so Ctrl-C cannot skip a hub flush
 * between socket binds. Register owned resources as they start for partial teardown.
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
    owned.hubMonitor?.stop();
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
      // close refuses new/idle connections; closeAllConnections prevents an
      // in-flight download from holding the port after Ctrl-C.
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
        // Every exit path must flush the owned hub before closing it.
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

  const serve = () => serveOpen(options, io);
  return options.verbose ? serve() : withLoggingDisabled(serve);
}

// biome-ignore lint/complexity/noExcessiveLinesPerFunction: This startup lifecycle predates the length limit.
async function serveOpen(options: Options, io: Io): Promise<number> {
  // Retain the original environment for refreshes; resolved file values are not pins.
  const startupEnv: NodeJS.ProcessEnv = { ...process.env };
  let initial = await initialConfig(startupEnv);
  let projectBinding = requireBinding(initial.resolved);
  for (const warning of initial.resolved.warnings) {
    io.err(`ub: warning: ${warning}\n`);
  }
  // Share the MCP client's default endpoint rather than defining another.
  let hubUrl = trimmed(initial.resolved.env.HUB_URL) ?? DEFAULT_HUB_URL;
  let env: NodeJS.ProcessEnv = { ...initial.resolved.env, HUB_URL: hubUrl };

  const owned: Owned = {
    hub: null,
    server: null,
    localServer: null,
    engine: null,
    engineMonitor: null,
    replicas: null,
    hubMonitor: null,
  };
  const foreground = takeForeground(owned, io);
  let hubNote = "";
  let showHubNote = false;
  let hubDeviceAuthenticated = false;

  const plan = bundlePlan(env);
  // Before ensureHub: a bundle refusal starts no hub and creates no database.
  const bundle = ensureBundle(plan, io);
  if (bundle === "refused") {
    return await foreground.shutdown(1);
  }
  // Freeze the cwd's default for this run, just as the served binding is frozen.
  const presenceName = await defaultPresenceName(startupEnv);
  if (foreground.interrupted()) {
    return await foreground.shutdown(0);
  }

  try {
    initial = await initialConfig(startupEnv, true, presenceName);
    projectBinding = requireBinding(initial.resolved);
    hubUrl = trimmed(initial.resolved.env.HUB_URL) ?? DEFAULT_HUB_URL;
    env = { ...initial.resolved.env, HUB_URL: hubUrl };
    const decided = await ensureHub(env, hubUrl, io, options.verbose);
    owned.hub = decided.started;
    hubNote = decided.note;
    showHubNote = decided.showNote ?? false;
    hubDeviceAuthenticated = decided.deviceHub ?? usesDeviceLogin(hubUrl, env);
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
  let access: BrowserAccess | null = null;
  try {
    const mcpConfig = workspace === null ? null : resolveMcpConfig(env);
    if (mcpConfig !== null) {
      const engine = await createMcpEngine(mcpConfig, { serving: true });
      owned.engine = engine;
      owned.engineMonitor = monitorEngine(engine);
      const workspaces = browserWorkspaces(projectBinding, mcpConfig, startupEnv,
        message => io.err(`ub: warning: ${message}\n`));
      const authenticateApi = await createApiAuthenticator(workspaces);
      access = await createBrowserAccess(new Map([...workspaces].map(([id, entry]) => [id, entry.browserKey])), startupEnv);
      const browserAccess = access;
      const document = servingConfigSource(
        startupEnv,
        initial.resolved,
        localHubUrl,
        workspaces,
        presenceName,
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
            // Synchronous refresh/read callbacks collect exactly this workspace's
            // loaded rooms, including directory and sidebar, for this status cut.
            localServer.refresh(workspaceId);
          } finally {
            collectingServedRooms = null;
          }
          observedServedRooms.clear();
          for (const room of current) observedServedRooms.add(room);
        }
        return collectServingSyncStatus(replicas.read(workspaceId), [...observedServedRooms].filter(room => parseRoom(room).workspaceId === workspaceId));
      };
      const engineForRoom = (room: string): UberblickMcpEngine => {
        const { workspaceId, uuid } = parseRoom(room);
        const engine = replicas.read(workspaceId);
        engine.replicas.assertNotDeleted(uuid);
        return engine;
      };
      localServer = await createLocalBrowserServer({
        ...(!options.verbose ? { log: silentLogger } : {}),
        port: options.port,
        workspaces: new Map([...workspaces].map(([id, entry]) => [id, entry.browserKey])),
        expectedOrigin: servedUrl.origin,
        prepareRoom: async room => {
          await replicas.prepare(parseRoom(room).workspaceId);
          engineForRoom(room);
        },
        assertRoomAvailable: room => { engineForRoom(room); },
        readRoom: (room, afterSeq) => {
          (collectingServedRooms ?? observedServedRooms).add(room);
          return engineForRoom(room).store.readSince(room, afterSeq);
        },
        takeSettingsResetNotice: (room, seq) => engineForRoom(room).store.takeSettingsResetNotice(seq),
        appendUpdate: (room, payload, settingsResetSeq) => {
          engineForRoom(room).store.appendUpdate(room, payload, "local", settingsResetSeq);
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
            browserAccess,
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
        configSource(startupEnv, initial.document, presenceName),
      );
      await listen(server, WEB_HOST, options.port);
      owned.server = server;
    }
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (error instanceof ServingReplicaHeldError) {
      io.err(
        `ub open: workspace ${readWorkspaceName(error.databasePath, projectBinding.workspaceId) ?? projectBinding.workspaceId} ` +
        `is already open in another \`ub open\` (process ${error.holder.pid}). Stop that one first, or keep using it.\n`,
      );
      if (options.verbose) io.err(`ub open: another \`ub open\` is already serving this store: ${message(error)}\n`);
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

  // The fragment never reaches a server; the page trades it once for a session.
  const url = access === null ? servedUrl.href : `${servedUrl.href}#launch=${access.launch.value}`;
  const sync = owned.engine === null ? null : openHubSource(owned.engine, hubUrl, env, hubDeviceAuthenticated);
  const connectTimeoutMs = owned.engine?.replicas.config.connectTimeoutMs ?? 0;
  const [hubState, recentDevices] = await openStartupReadings(sync, connectTimeoutMs, { ...projectBinding, env });
  if (foreground.interrupted()) return await foreground.shutdown(0);
  const earlyFailure = owned.engineMonitor?.failure() ?? null;
  if (earlyFailure !== null) {
    io.err(`ub open: ${earlyFailure}\n`);
    return await foreground.shutdown(1);
  }
  const deviceHub = sync?.deviceAuthenticated() ?? hubDeviceAuthenticated;
  const transport = hubTransportProblem(hubUrl, env);
  const hubSignInRequired = missingHubLogin(hubUrl, env, deviceHub);
  const unreachable = !hubSignInRequired && hubState?.status === "hub-down";
  io.out(openBanner({
    url, verbose: options.verbose, secretCreated: initial.secretCreated,
    binding: projectBinding, databasePath: owned.engine?.replicas.config.databasePath,
    hubNote, signInRequired: hubSignInRequired, showHubNote,
    deviceHub, hubUrl, hubState, recentDevices, transportProblem: transport,
  }));
  if (sync !== null) {
    owned.hubMonitor = monitorOpenHub(sync, displayWorkspaceHub(hubUrl), text => io.err(text), {
      unreachableAtStart: unreachable,
      notSignedInAtStart: hubSignInRequired,
    });
  }

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

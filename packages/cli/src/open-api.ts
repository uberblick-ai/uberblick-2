import type { IncomingMessage, ServerResponse } from "node:http";
import { getDocumentRevision, listDocumentRevisions, RevisionClientError, type ServingSyncStatus, type UberblickMcpEngine } from "@uberblick/mcp-server";
import { isDocId } from "@uberblick/schema";
import { SYNC_PROTOCOL_VERSION, readAuthEnvelope } from "@uberblick/schema/protocol";
import { clampToken, importRootSecret, verifyToken } from "@uberblick/schema/token";
import * as Y from "yjs";
import { readAccessAction, requestAccess, type AccessBinding } from "./open-access.js";
import { requestAccount, requestDeviceLogin } from "./open-account.js";
import { serveRevisionMutation } from "./open-revisions.js";
import { serveBundleRequest } from "./open-bundle.js";
import { respond } from "./open-response.js";
import { hasSession, serveSessionRequest, type BrowserAccess } from "./open-session.js";
import { BrowserReplicaUnavailable, type BrowserReplicas, type ServedWorkspace } from "./open-workspaces.js";

const API_PREFIX = "/api/";
const SEARCH_PATH = "/api/search";
const REVISIONS_PATH = "/api/revisions";
const STATUS_PATH = "/api/status";
const ACCESS_PATH = "/api/access";
const ACCOUNT_PATH = "/api/account";
const DEVICE_LOGIN_PATH = "/api/device-login";
const TOKEN_QUERY_PARAMS = ["token", "access_token", "auth", "authToken"];

type ApiAuthenticator = (authMessage: string) => Promise<string | null>;
type ApiStatus = () => ServingSyncStatus;

export async function createApiAuthenticator(
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

interface ApiRequestContext {
  request: IncomingMessage;
  response: ServerResponse;
  target: URL;
  authenticate: ApiAuthenticator;
  replicas: BrowserReplicas;
  statusForWorkspace: (workspace: string) => ServingSyncStatus;
  env: NodeJS.ProcessEnv;
  expectedOrigin: string;
  document: () => string;
  access: BrowserAccess;
}

interface BoundRequestContext extends Omit<ApiRequestContext, "target"> {
  expectedHost: string;
  root: string;
}

async function serveRevisions(
  engine: UberblickMcpEngine,
  target: URL,
  reply: (status: number, body: object) => void,
): Promise<void> {
  const uuid = target.searchParams.get("uuid");
  if (uuid === null || !isDocId(uuid)) {
    reply(400, { error: "invalid_document" });
    return;
  }
  const revision = target.searchParams.get("revision");
  if (revision !== null && (revision.length === 0 || revision.length > 256)) {
    reply(400, { error: "invalid_revision" });
    return;
  }
  try {
    if (revision === null) {
      reply(200, { revisions: await listDocumentRevisions(engine.replicas, uuid, { includeNames: true }) });
    } else {
      const snapshot = await getDocumentRevision(engine.replicas, uuid, revision);
      try {
        reply(200, { state: Buffer.from(Y.encodeStateAsUpdate(snapshot)).toString("base64") });
      } finally { snapshot.destroy(); }
    }
  } catch (error) {
    if (!(error instanceof RevisionClientError)) throw error;
    reply(503, { error: "history_unavailable", reason: error.code });
  }
}

async function serveApiRequest(context: ApiRequestContext): Promise<void> {
  const { request, response, target, authenticate, replicas, statusForWorkspace,
    env, expectedOrigin, document, access } = context;
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

  if (target.pathname === REVISIONS_PATH && request.method === "POST") {
    if (request.headers.origin !== expectedOrigin) {
      apiResponse(request, response, 403, { status: "origin-refused" });
      return;
    }
    await serveRevisionMutation(engine, request, reply);
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
  if (target.pathname === REVISIONS_PATH) {
    await serveRevisions(engine, target, reply);
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

export function serveBoundRequest(context: BoundRequestContext): void {
  const { expectedHost, root, document, request, response } = context;
  if (!acceptRequestHost(expectedHost, request, response)) return;
  const target = new URL(request.url ?? "/", "http://localhost");
  if (!target.pathname.startsWith(API_PREFIX)) {
    serveBundleRequest(root, document, request, response);
    return;
  }
  void serveApiRequest({ ...context, target }).catch(() => {
    if (!response.headersSent) {
      apiResponse(request, response, 500, { error: "internal_error" });
    }
  });
}

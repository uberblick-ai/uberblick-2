import { createHash, randomUUID } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { join } from "node:path";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { isUuid } from "@uberblick/schema";
import type { CredentialProvider } from "./credential-provider.js";
import { resolveMcpConfig } from "./config.js";
import { type McpHostGrant, type McpHostTokenCheck, unavailableTokenCheck } from "./host-token-check.js";
import { log } from "./log.js";
import { handleProtectedResourceMetadata, replyMcpUnauthorized } from "./oauth-discovery.js";
import { createMcpRuntime, type UberblickMcpRuntime, type UberblickMcpSession } from "./server.js";
import { ServerShuttingDownError } from "./server-work.js";
import { SHUTDOWN_TIMEOUT_MS } from "./shutdown.js";

export interface McpHostConfig {
  issuer: string | undefined;
  allowedOrigins: readonly string[];
  hubUrl: string;
  databaseDirectory: string;
}

export interface McpHostDependencies {
  checkToken?: McpHostTokenCheck;
  credentialsForGrant?: (grant: McpHostGrant) => Promise<{
    credentialProvider: CredentialProvider;
    agentName: string;
  }>;
}

interface HostSession {
  grantId: string;
  workspace: string;
  session: UberblickMcpSession;
  transport: StreamableHTTPServerTransport;
  closed: boolean;
  closing?: Promise<void>;
}

function reply(response: ServerResponse, status: number): void {
  response.writeHead(status, { "Cache-Control": "no-store" });
  response.end();
}

/** Compose HTTP admission with the same runtime and session tools as stdio. */
export function createMcpHost(config: McpHostConfig, dependencies: McpHostDependencies = {}) {
  const checkToken = dependencies.checkToken ?? unavailableTokenCheck;
  // known limit: no capacity limits or idle eviction; revisit when host limits land.
  const runtimes = new Map<string, Promise<UberblickMcpRuntime>>();
  const sessions = new Map<string, HostSession>();
  const allSessions = new Set<HostSession>();
  let stopping = false;
  let closing: Promise<void> | undefined;

  function closeSession(record: HostSession): Promise<void> {
    if (record.closing !== undefined) return record.closing;
    record.closed = true;
    record.closing = record.session.close().finally(() => {
      if (record.transport.sessionId !== undefined) sessions.delete(record.transport.sessionId);
      allSessions.delete(record);
    });
    return record.closing;
  }

  function runtimeFor(grant: McpHostGrant): Promise<UberblickMcpRuntime> {
    const existing = runtimes.get(grant.grantId);
    if (existing !== undefined) return existing;
    const opening = Promise.resolve().then(async () => {
      if (stopping) throw new ServerShuttingDownError();
      const credentials = await dependencies.credentialsForGrant?.(grant);
      if (stopping) throw new ServerShuttingDownError();
      if (credentials === undefined) throw new Error("Grant credentials are unavailable");
      const grantPath = createHash("sha256").update(grant.grantId).digest("hex");
      const runtimeConfig = resolveMcpConfig({
        WORKSPACE_ID: grant.workspace,
        HUB_URL: config.hubUrl,
        UBERBLICK_DB: join(config.databaseDirectory, grantPath, `${grant.workspace}.sqlite`),
      });
      return createMcpRuntime(runtimeConfig, credentials);
    });
    runtimes.set(grant.grantId, opening);
    void opening.catch(() => { if (runtimes.get(grant.grantId) === opening) runtimes.delete(grant.grantId); });
    return opening;
  }

  async function handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    if (handleProtectedResourceMetadata(config.issuer, request, response)) return;
    // Inspect the raw path: URL normalization must not turn a decorated id into a route.
    const path = (request.url ?? "").split("?", 1)[0] ?? "";
    const workspace = path.startsWith("/mcp/") ? path.slice(5) : "";
    if (workspace.length !== 36 || !isUuid(workspace)) return reply(response, 404);
    const origin = request.headers.origin;
    if (origin !== undefined && !config.allowedOrigins.includes(origin)) return reply(response, 403);
    // known limit: no CORS preflight or response headers; revisit when browser MCP access is authorized.
    if (request.method !== "POST" && request.method !== "GET" && request.method !== "DELETE") {
      response.writeHead(405, { Allow: "POST, GET, DELETE" });
      response.end();
      return;
    }
    const authorization = request.headers.authorization;
    const token = authorization?.match(/^Bearer ([A-Za-z0-9\-._~+/]+=*)$/i)?.[1];
    if (token === undefined) return replyMcpUnauthorized(response, config.issuer, workspace);
    const answer = await checkToken(token);
    if (answer.status === "unavailable") return reply(response, 503);
    if (answer.status === "negative" || answer.workspace !== workspace) {
      return replyMcpUnauthorized(response, config.issuer, workspace);
    }
    if (stopping) return reply(response, 503);
    const id = request.headers["mcp-session-id"];
    if (id !== undefined) {
      const record = typeof id === "string" ? sessions.get(id) : undefined;
      if (record === undefined || record.closed || record.grantId !== answer.grantId || record.workspace !== workspace) {
        return reply(response, 404);
      }
      await record.transport.handleRequest(request, response);
      return;
    }
    if (request.method !== "POST") return reply(response, 400);
    await initializeSession(answer, request, response);
  }

  async function initializeSession(grant: McpHostGrant, request: IncomingMessage, response: ServerResponse): Promise<void> {
    const runtime = await runtimeFor(grant);
    if (stopping) return reply(response, 503);
    const session = runtime.openSession();
    const record: HostSession = {
      grantId: grant.grantId, workspace: grant.workspace, session, closed: false,
      transport: new StreamableHTTPServerTransport({
        sessionIdGenerator: randomUUID,
        onsessioninitialized(id) { if (!record.closed) sessions.set(id, record); },
        onsessionclosed() { return closeSession(record); },
      }),
    };
    allSessions.add(record);
    record.transport.onclose = () => { void closeSession(record); };
    try {
      // SDK HTTP callback accessors include undefined; its Transport uses optional properties.
      await session.connect(record.transport as Transport);
      if (record.closed) return reply(response, 503);
      await record.transport.handleRequest(request, response);
    } finally {
      if (record.transport.sessionId === undefined) await closeSession(record);
    }
  }

  const server = createServer((request, response) => {
    void handle(request, response).catch(() => {
      // Provider or checker errors may include a token; never log their raw cause.
      log.error("MCP host request failed");
      if (!response.headersSent) reply(response, 503);
      else response.end();
    });
  });

  return {
    server,
    close(deadline = performance.now() + SHUTDOWN_TIMEOUT_MS): Promise<void> {
      if (closing !== undefined) return closing;
      stopping = true;
      const drained = [...allSessions].map(closeSession);
      const listenerClosed = server.listening
        ? new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
        : Promise.resolve();
      closing = Promise.resolve().then(async () => {
        await Promise.all(drained);
        const opened = await Promise.allSettled([...runtimes.values()]);
        await Promise.all(opened.map(result => result.status === "fulfilled" ? result.value.close(deadline) : undefined));
        server.closeAllConnections();
        await listenerClosed;
      });
      return closing;
    },
  };
}

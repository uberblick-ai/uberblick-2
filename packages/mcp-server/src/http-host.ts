import { randomUUID } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { finished } from "node:stream/promises";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { MCP_SOCKET_TIMEOUT_MS } from "@uberblick/hub/mcp-channel";
import { isUuid } from "@uberblick/schema";
import type { CredentialProvider } from "./credential-provider.js";
import type { HostFreeSpace, McpHostLimits } from "./host-capacity.js";
import { HostRuntimes, HostFullError, type HostRuntime } from "./host-runtimes.js";
import { readHostPost } from "./host-request.js";
import { hubTokenCheck, type McpHostGrant, type McpHostTokenCheck } from "./host-token-check.js";
import { log } from "./log.js";
import { handleProtectedResourceMetadata, replyMcpUnauthorized } from "./oauth-discovery.js";
import type { UberblickMcpRuntime, UberblickMcpSession } from "./server.js";
import { SHUTDOWN_TIMEOUT_MS } from "./shutdown.js";

export interface McpHostConfig {
  issuer: string | undefined;
  allowedOrigins: readonly string[];
  hubUrl: string;
  databaseDirectory: string;
  hubMcpSocket?: string | undefined;
  limits?: Partial<McpHostLimits>;
}

export interface McpHostDependencies {
  checkToken?: McpHostTokenCheck;
  now?: () => number;
  freeSpace?: HostFreeSpace;
  credentialsForGrant?: (grant: McpHostGrant) => Promise<{
    credentialProvider: CredentialProvider;
    agentName: string;
  }>;
}

export interface HostSession {
  grantId: string;
  workspace: string;
  session: UberblickMcpSession;
  transport: StreamableHTTPServerTransport;
  closed: boolean;
  closing?: Promise<void>;
  streams: Set<() => void>;
  runtime: HostRuntime;
  lastActivity: number;
  requests: number;
}

// Leave room for the hub's absolute reply deadline inside the stream's 30-second bound.
const STREAM_CHECK_INTERVAL_MS = 30_000 - MCP_SOCKET_TIMEOUT_MS;

function reply(response: ServerResponse, status: number): void {
  response.writeHead(status, { "Cache-Control": "no-store", ...(status === 503 ? { "Retry-After": "1" } : {}) });
  response.end();
}

function watchStream(record: HostSession, response: ServerResponse, token: string, checkedAt: number, checkToken: McpHostTokenCheck): void {
  let stopped = false;
  let pollTimer: ReturnType<typeof setTimeout>;
  let deadlineTimer: ReturnType<typeof setTimeout> | undefined;
  const stop = (): void => {
    stopped = true;
    clearTimeout(pollTimer);
    clearTimeout(deadlineTimer);
    record.streams.delete(stop);
  };
  const close = (): void => {
    if (stopped || response.writableEnded || response.destroyed) return;
    stop();
    record.transport.closeStandaloneSSEStream();
  };
  const schedule = (startedAt: number): void => {
    pollTimer = setTimeout(poll, Math.max(0, startedAt + STREAM_CHECK_INTERVAL_MS - performance.now()));
    pollTimer.unref();
  };
  const poll = (): void => {
    if (stopped) return;
    // The SDK's request promise lasts for the stream; refused GETs finish without becoming a stream.
    if (!response.headersSent || response.statusCode !== 200) {
      stop();
      return;
    }
    schedule(performance.now());
    deadlineTimer = setTimeout(close, MCP_SOCKET_TIMEOUT_MS);
    deadlineTimer.unref();
    void Promise.resolve().then(() => checkToken(token)).then(answer => {
      if (stopped || response.writableEnded || response.destroyed) return;
      clearTimeout(deadlineTimer);
      if (answer.status !== "positive" || answer.workspace !== record.workspace || answer.grantId !== record.grantId) close();
    }, close);
  };
  record.streams.add(stop);
  response.once("close", stop);
  response.once("finish", stop);
  schedule(checkedAt);
}

/** Compose HTTP admission with the same runtime and session tools as stdio. */
export function createMcpHost(config: McpHostConfig, dependencies: McpHostDependencies = {}) {
  const checkToken = dependencies.checkToken ?? hubTokenCheck(config.hubMcpSocket);
  const sessions = new Map<string, HostSession>();
  const allSessions = new Set<HostSession>();
  let openingSessions = 0;
  let calls = 0;
  let stopping = false;
  let closing: Promise<void> | undefined;
  const runtimes = new HostRuntimes(config, dependencies, closeSession, () => stopping);
  const { now, limits } = runtimes;
  const sweepIdle = () => runtimes.sweepIdle();

  function closeSession(record: HostSession): Promise<void> {
    if (record.closing !== undefined) return record.closing;
    // known limit: clients without session restart lose access after idle close; revisit when client acceptance covers reconnect.
    record.closed = true;
    for (const stop of record.streams) stop();
    record.closing = record.session.close().finally(() => {
      if (record.transport.sessionId !== undefined) sessions.delete(record.transport.sessionId);
      allSessions.delete(record);
      record.runtime.sessions.delete(record);
    });
    return record.closing;
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
    const checkedAt = performance.now();
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
      await handleSession(record, request, response, token, checkedAt);
      return;
    }
    if (request.method !== "POST") return reply(response, 400);
    await initializePost(answer, request, response);
  }

  async function initializePost(grant: McpHostGrant, request: IncomingMessage, response: ServerResponse): Promise<void> {
    const parsed = await readHostPost(request);
    if ("status" in parsed) return reply(response, parsed.status);
    await sweepIdle();
    if (stopping || calls + parsed.calls > limits.maxCalls || allSessions.size + openingSessions >= limits.maxSessions) {
      return reply(response, 503);
    }
    calls += parsed.calls;
    openingSessions += 1;
    try {
      await initializeSession(grant, request, response, parsed.body);
    } finally {
      calls -= parsed.calls;
    }
  }

  async function handleSession(record: HostSession, request: IncomingMessage, response: ServerResponse, token: string, checkedAt: number): Promise<void> {
    if (request.method === "GET") {
      watchStream(record, response, token, checkedAt, checkToken);
      await record.transport.handleRequest(request, response);
      return;
    }
    record.lastActivity = now();
    runtimes.touch(record.runtime);
    record.requests += 1;
    try {
      if (request.method === "POST") await post(record, request, response);
      else await record.transport.handleRequest(request, response);
    } finally {
      record.requests -= 1;
    }
  }

  async function post(record: HostSession, request: IncomingMessage, response: ServerResponse): Promise<void> {
    const parsed = await readHostPost(request);
    if ("status" in parsed) return reply(response, parsed.status);
    if (record.closed) return reply(response, 404);
    if (stopping || calls + parsed.calls > limits.maxCalls) return reply(response, 503);
    calls += parsed.calls;
    try {
      await record.transport.handleRequest(request, response, parsed.body);
      // The SDK's stream reader can close before the HTTP response finishes.
      await finished(response, { cleanup: true }).catch(() => {});
    } finally {
      // A disconnected response can finish before the admitted tool does.
      if (!response.writableFinished) await record.session.drain();
      calls -= parsed.calls;
    }
  }

  async function initializeSession(grant: McpHostGrant, request: IncomingMessage, response: ServerResponse, body: unknown): Promise<void> {
    let owner: HostRuntime;
    let runtime: UberblickMcpRuntime;
    try {
      owner = runtimes.runtimeFor(grant);
      owner.admissions += 1;
      try { runtime = await owner.opening; }
      finally { owner.admissions -= 1; }
    } finally {
      openingSessions -= 1;
    }
    if (stopping) return reply(response, 503);
    runtimes.touch(owner);
    const session = runtime.openSession();
    const record: HostSession = {
      grantId: grant.grantId, workspace: grant.workspace, session, closed: false, streams: new Set(),
      runtime: owner, lastActivity: now(), requests: 1,
      transport: new StreamableHTTPServerTransport({
        sessionIdGenerator: randomUUID,
        onsessioninitialized(id) { if (!record.closed) sessions.set(id, record); },
        onsessionclosed() { return closeSession(record); },
      }),
    };
    allSessions.add(record);
    owner.sessions.add(record);
    record.transport.onclose = () => { void closeSession(record); };
    try {
      // SDK HTTP callback accessors include undefined; its Transport uses optional properties.
      await session.connect(record.transport as Transport);
      if (record.closed) return reply(response, 503);
      await record.transport.handleRequest(request, response, body);
    } finally {
      await session.drain();
      record.requests -= 1;
      if (record.transport.sessionId === undefined) await closeSession(record);
    }
  }

  const server = createServer((request, response) => {
    void handle(request, response).catch(error => {
      // Provider or checker errors may include a token; never log their raw cause.
      if (!(error instanceof HostFullError)) log.error("MCP host request failed");
      if (!response.headersSent) reply(response, 503);
      else response.end();
    });
  });

  const idleTimer = setInterval(() => {
    void sweepIdle().catch(() => log.error("MCP host idle sweep failed"));
  }, 1000);
  idleTimer.unref();

  return {
    server,
    sweepIdle,
    close(deadline = performance.now() + SHUTDOWN_TIMEOUT_MS): Promise<void> {
      if (closing !== undefined) return closing;
      stopping = true;
      clearInterval(idleTimer);
      const drained = [...allSessions].map(closeSession);
      const listenerClosed = server.listening
        ? new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
        : Promise.resolve();
      closing = Promise.resolve().then(async () => {
        await Promise.all(drained);
        await runtimes.close(deadline);
        server.closeAllConnections();
        await listenerClosed;
      });
      return closing;
    },
  };
}

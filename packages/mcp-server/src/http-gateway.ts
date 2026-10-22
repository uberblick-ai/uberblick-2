/**
 * SPIKE (#2144): serve the MCP tools over Streamable HTTP from one shared
 * replica set. Each client session gets its own McpServer, guidance briefing
 * and work tracker; the replicas, mirror and hub connection are shared.
 * Throwaway code: no sign-in beyond a static bearer, no per-person identity.
 */

import { randomUUID } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import type { McpConfig } from "./config.js";
import { GuidanceBriefing } from "./briefing.js";
import { registerGuidanceResources } from "./guidance.js";
import { registerHelpResources } from "./help-resources.js";
import { STARTUP_ORIENTATION } from "./help-topics.js";
import { agentDisplayName } from "./server.js";
import { ServerWork } from "./server-work.js";
import { seedTagCatalogOnce } from "./tag-catalog.js";
import { registerTools } from "./tools.js";
import { mcpVersion } from "./version.js";
import { openWorkspaceReplicas, type WorkspaceReplicaSet } from "./workspace-replicas.js";

export interface HttpGatewayOptions {
  config: McpConfig;
  /** Static bearer for the spike; a real gateway takes hub-issued OAuth tokens. */
  bearer: string;
  port?: number;
  host?: string;
}

interface Session {
  readonly server: McpServer;
  readonly transport: StreamableHTTPServerTransport;
  readonly work: ServerWork;
  readonly briefing: GuidanceBriefing;
  clientName: string;
}

export interface HttpGateway {
  readonly url: string;
  readonly workspace: WorkspaceReplicaSet;
  readonly sessions: ReadonlyMap<string, Session>;
  close(): Promise<void>;
}

export async function startHttpGateway(options: HttpGatewayOptions): Promise<HttpGateway> {
  const workspace = openWorkspaceReplicas(options.config, { publishOwnPresence: true });
  const { replicas } = workspace;
  await seedTagCatalogOnce(replicas);
  const sessions = new Map<string, Session>();

  function openSession(): Session {
    const server = new McpServer(
      { name: "uberblick", title: "Uberblick", websiteUrl: "https://github.com/uberblick-ai/uberblick-2", version: mcpVersion() },
      { instructions: STARTUP_ORIENTATION },
    );
    const briefing = new GuidanceBriefing(replicas);
    const work = new ServerWork();
    const help = registerTools(server, replicas, briefing, work);
    registerHelpResources(server, help, work);
    registerGuidanceResources(server, replicas, briefing, work);
    const transport: StreamableHTTPServerTransport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
      onsessioninitialized: (id) => { sessions.set(id, session); },
    });
    const session: Session = { server, transport, work, briefing, clientName: "agent" };
    server.server.oninitialized = () => {
      session.clientName = agentDisplayName(server.server.getClientVersion());
      // The display name lives on the shared replicas: the last session to
      // initialize labels every session's cursor. A finding, not a fix.
      replicas.setAgentName(session.clientName);
    };
    transport.onclose = () => {
      if (transport.sessionId !== undefined) sessions.delete(transport.sessionId);
    };
    return session;
  }

  async function readJson(request: IncomingMessage): Promise<unknown> {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(chunk as Buffer);
    const text = Buffer.concat(chunks).toString("utf8");
    return text === "" ? undefined : JSON.parse(text);
  }

  async function handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const path = (request.url ?? "").split("?")[0];
    if (path !== "/mcp") {
      response.writeHead(404).end();
      return;
    }
    if (request.headers.authorization !== `Bearer ${options.bearer}`) {
      response.writeHead(401, {
        "Content-Type": "application/json",
        "WWW-Authenticate": 'Bearer resource_metadata="/.well-known/oauth-protected-resource/mcp"',
      }).end(JSON.stringify({ error: "unauthorized" }));
      return;
    }
    const sessionId = request.headers["mcp-session-id"];
    const existing = typeof sessionId === "string" ? sessions.get(sessionId) : undefined;
    if (request.method === "POST") {
      const body = await readJson(request);
      if (existing !== undefined) {
        await existing.transport.handleRequest(request, response, body);
        return;
      }
      if (sessionId === undefined && isInitializeRequest(body)) {
        const session = openSession();
        // The SDK transport types its optional callbacks loosely under exactOptionalPropertyTypes.
        await session.server.connect(session.transport as Transport);
        await session.transport.handleRequest(request, response, body);
        return;
      }
      response.writeHead(400, { "Content-Type": "application/json" })
        .end(JSON.stringify({ jsonrpc: "2.0", error: { code: -32000, message: "Unknown or missing session" }, id: null }));
      return;
    }
    if ((request.method === "GET" || request.method === "DELETE") && existing !== undefined) {
      await existing.transport.handleRequest(request, response);
      return;
    }
    response.writeHead(405, { Allow: "POST" }).end();
  }

  const http: Server = createServer((request, response) => {
    handle(request, response).catch((error: unknown) => {
      if (!response.headersSent) response.writeHead(500).end(String(error));
    });
  });
  await new Promise<void>((resolve) => http.listen(options.port ?? 0, options.host ?? "127.0.0.1", resolve));
  const address = http.address();
  const port = typeof address === "object" && address !== null ? address.port : 0;

  return {
    url: `http://${options.host ?? "127.0.0.1"}:${port}/mcp`,
    workspace,
    sessions,
    async close() {
      for (const session of sessions.values()) {
        await session.server.close().catch(() => {});
        await session.work.drain();
      }
      sessions.clear();
      await new Promise<void>((resolve) => http.close(() => resolve()));
      await replicas.waitForPendingChanges(performance.now() + 3_000);
      await workspace.close();
    },
  };
}

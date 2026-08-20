/**
 * The MCP server, assembled.
 *
 * A factory, not a process: it opens the store, builds the replicas, registers
 * the tools and hands back something a transport can be attached to. `main.ts`
 * owns the process — signals, stdio, exit codes — which is what makes this
 * usable from tests over an in-memory transport.
 *
 * Nothing here awaits the hub. The store is opened, the log is replayed, and
 * the server is ready to serve; the hub connection happens in the background
 * and its absence changes no tool's answer except `sync_status`.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { McpConfig } from "./config.js";
import { log } from "./log.js";
import { Replicas } from "./replica.js";
import { MirrorStore } from "./store.js";
import { registerTools } from "./tools.js";

export interface UberblickMcpServer {
  readonly server: McpServer;
  readonly replicas: Replicas;
  readonly store: MirrorStore;
  /** Attach a transport and start serving. */
  connect(transport: Transport): Promise<void>;
  /** Release the hub connection, the replicas and the database handle. */
  close(): Promise<void>;
}

export function createMcpServer(config: McpConfig): UberblickMcpServer {
  const store = new MirrorStore(config.databasePath);
  const replicas = new Replicas(config, store);

  const server = new McpServer(
    { name: "uberblick", version: "0.0.0" },
    {
      instructions:
        "uberblick documents are CRDT-backed and edited concurrently by humans and agents. " +
        "Read with get_doc, which returns a `rev` per block, and write one block at a time with " +
        "edit_block, passing the old_text and rev you read. There is no whole-document write. " +
        "Discovery is list_docs and search; links and backlinks are by document UUID.",
    },
  );

  // Awareness identity: the web UI renders this name over the agent's cursor,
  // so it should say which client is writing. Known only after `initialize`.
  server.server.oninitialized = () => {
    const client = server.server.getClientVersion();
    replicas.setAgentName(`Claude · ${client?.name ?? "mcp client"}`);
  };

  registerTools(server, replicas);

  let closed = false;

  return {
    server,
    replicas,
    store,
    async connect(transport: Transport) {
      await server.connect(transport);
      log.info("serving", {
        workspace: config.workspaceId,
        database: config.databasePath,
        hub: replicas.sync.enabled ? config.hubUrl : "disabled",
        session: config.sessionId,
      });
    },
    async close() {
      if (closed) {
        return;
      }
      closed = true;
      replicas.destroy();
      await server.close().catch((error: unknown) => {
        log.warn("closing the MCP server failed", error);
      });
      store.close();
    },
  };
}

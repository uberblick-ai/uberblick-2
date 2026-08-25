/**
 * The MCP server, assembled.
 *
 * A factory, not a process: it opens the store, builds the replicas, registers
 * the tools and hands back something a transport can be attached to. `main.ts`
 * owns the process — signals, stdio, exit codes — which is what makes this
 * usable from tests over an in-memory transport.
 *
 * Nothing here awaits the hub. The store is opened, the log is replayed, the
 * sidebar's one-time seed runs, and the server is ready to serve; the hub
 * connection happens in the background and its absence changes no tool's answer
 * except `sync_status`.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { McpConfig } from "./config.js";
import { log } from "./log.js";
import { Replicas } from "./replica.js";
import { seedSidebarOnce } from "./sidebar-tools.js";
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

/**
 * @param store The SQLite mirror. Defaults to one opened at
 * `config.databasePath`; injectable so a test can drive persistence failures
 * through the real code path.
 */
export function createMcpServer(
  config: McpConfig,
  store: MirrorStore = new MirrorStore(config.databasePath),
): UberblickMcpServer {
  const replicas = new Replicas(config, store);

  // The one-time migration out of tag-derived navigation, before any tool can
  // read the sidebar — and here rather than inside a tool, because a read must
  // not write. It is guarded by a flag in the sidebar doc, so it runs once per
  // workspace and not once per start, and it never throws: a refused append is
  // already the replica set's sticky persistence failure. See ./sidebar-tools.ts.
  seedSidebarOnce(replicas);

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

  // Awareness identity: the web UI renders this name over the agent's cursor
  // and it becomes the default annotation author, so it must say which client
  // is actually writing — Claude Code, Codex, or anything else that speaks MCP.
  // The client tells us at `initialize`; we do not guess a vendor.
  server.server.oninitialized = () => {
    const client = server.server.getClientVersion();
    replicas.setAgentName(client?.title ?? client?.name ?? "agent");
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

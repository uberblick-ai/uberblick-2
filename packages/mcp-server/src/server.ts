/**
 * The MCP server, assembled.
 *
 * A factory, not a process: it opens the store, builds the replicas, registers
 * the tools and hands back something a transport can be attached to. `main.ts`
 * owns the process — signals, stdio, exit codes — which is what makes this
 * usable from tests over an in-memory transport.
 *
 * Building the server awaits nothing: the store is opened, the log is replayed,
 * and the hub connection happens in the background, where its absence changes no
 * tool's answer except `sync_status`. `connect` awaits one thing before it
 * serves — the sidebar's one-time migration, which settles first so it decides
 * from the whole workspace rather than from this machine's log alone. That wait
 * is bounded and does not exist when no hub is configured.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { McpConfig } from "./config.js";
import { FAILURE_INSTRUCTIONS } from "./failures.js";
import { log } from "./log.js";
import { Replicas } from "./replica.js";
import { seedSidebarOnce } from "./sidebar-tools.js";
import { MirrorStore } from "./store.js";
import { registerTools } from "./tools.js";

/**
 * The name to publish beside this session's caret, from what the client said
 * about itself at `initialize`.
 *
 * Precedence, and why (#304): `title` is the human-readable name of *this
 * session* — "Uberblick Coordinator Agent" — and is what a reader wants over
 * the caret; `name` is the client or executable behind it — "Codex",
 * "claude-code" — which still says who wrote. `agent` is a defensive last
 * resort: a protocol-compliant client always sends `name`.
 *
 * Blank is not an answer. A client that sends `title: ""` (or spaces) has said
 * nothing, and falling through to its name is the difference between a labelled
 * caret and a bare line over somebody's prose.
 */
export function agentDisplayName(
  client: { name?: string | undefined; title?: string | undefined } | undefined,
): string {
  return client?.title?.trim() || client?.name?.trim() || "agent";
}

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
  store: MirrorStore = new MirrorStore(config.databasePath, config.workspaceId),
): UberblickMcpServer {
  const replicas = new Replicas(config, store);

  const server = new McpServer(
    { name: "uberblick", version: "0.0.0" },
    {
      // The failure contract lives here, once, rather than on every tool
      // description: it is the same contract for every tool, and a client
      // reads `instructions` once per session instead of paying for it in every
      // `tools/list`. Each tool description still names the shape it answers
      // with — see `failureContract` in ./failures.ts.
      instructions:
        "uberblick documents are CRDT-backed and edited concurrently by humans and agents. " +
        "Read with get_doc, which returns a `rev` per block, and write one block at a time with " +
        "edit_block, passing the old_text and rev you read. There is no whole-document write. " +
        "Discovery is list_docs and search; links and backlinks are by document UUID.\n\n" +
        FAILURE_INSTRUCTIONS,
    },
  );

  // Awareness identity: the web UI renders this name over the agent's cursor
  // and it becomes the default annotation author, so it must say which client
  // is actually writing — Claude Code, Codex, or anything else that speaks MCP.
  // The client tells us at `initialize`; we do not guess a vendor. See
  // {@link agentDisplayName} for which of the two fields wins.
  server.server.oninitialized = () => {
    replicas.setAgentName(agentDisplayName(server.server.getClientVersion()));
  };

  registerTools(server, replicas);

  let closed = false;

  return {
    server,
    replicas,
    store,
    async connect(transport: Transport) {
      // The one-time migration out of tag-derived navigation, before the
      // transport is attached so no tool can read a sidebar it has not decided
      // about yet — and here rather than inside a tool, because a read must not
      // write. It settles first (bounded; instant with no hub), is guarded by a
      // flag in the sidebar doc so it runs once per workspace rather than once
      // per start, and never throws: a refused append is already the replica
      // set's sticky persistence failure. See ./sidebar-tools.ts.
      await seedSidebarOnce(replicas);
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

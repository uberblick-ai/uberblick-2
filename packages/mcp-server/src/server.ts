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
 * tool's answer except `sync_status`. `connect` settles and seeds the synced tag
 * catalog before serving, using the same once-only schema transition as the web.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { McpConfig } from "./config.js";
import { FAILURE_INSTRUCTIONS } from "./failures.js";
import { GuidanceBriefing, GUIDANCE_INSTRUCTIONS, registerGuidanceResources } from "./guidance.js";
import { log } from "./log.js";
import { Replicas } from "./replica.js";
import { MirrorStore } from "./store.js";
import { ServerWork } from "./server-work.js";
import { seedTagCatalogOnce } from "./tag-catalog.js";
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
  /** Close transport, drain admitted work, then release replicas and the store. */
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
  const briefing = new GuidanceBriefing(replicas);
  const work = new ServerWork();

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
        "get_doc summarizes structured data without schemas or records; use get_data for bounded deliberate reads " +
        "and update_data for validated collection batches.\n\n" +
        GUIDANCE_INSTRUCTIONS + "\n\n" + FAILURE_INSTRUCTIONS,
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

  registerTools(server, replicas, briefing, work);
  registerGuidanceResources(server, replicas, briefing, work);

  let closed = false;
  let closing: Promise<void> | null = null;

  return {
    server,
    replicas,
    store,
    async connect(transport: Transport) {
      // Seed before attaching the transport: list_tags can therefore state a
      // complete catalog, and a read never has to materialise missing examples.
      if (closed) return;
      await work.run(async () => {
        await seedTagCatalogOnce(replicas);
        if (closed) return;
        // SDK connect attaches its transport synchronously before its first
        // await. A racing close therefore sees and closes that transport.
        await server.connect(transport);
        if (closed) return;
        log.info("serving", {
          workspace: config.workspaceId,
          database: config.databasePath,
          hub: replicas.sync.enabled ? config.hubUrl : "disabled",
          session: config.sessionId,
        });
      });
    },
    close() {
      if (closing !== null) return closing;
      closed = true;
      work.stop();
      closing = (async () => {
        await server.close().catch((error: unknown) => {
          log.warn("closing the MCP server failed", error);
        });
        // SDK close aborts requests and drops replies but does not await
        // handlers. Their local writes still need the live replica and log.
        await work.drain();
        replicas.destroy();
        await replicas.sync.waitForDeviceWork();
        store.close();
      })();
      return closing;
    },
  };
}

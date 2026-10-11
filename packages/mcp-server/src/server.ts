/**
 * Assemble synchronously from the local log; hub synchronization stays in the
 * background. Transport startup settles and seeds tags before admitting calls.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { McpConfig } from "./config.js";
import { GuidanceBriefing, registerGuidanceResources } from "./guidance.js";
import { registerHelpResources } from "./help-resources.js";
import { STARTUP_ORIENTATION } from "./help-topics.js";
import { log } from "./log.js";
import { Replicas } from "./replica.js";
import { MirrorStore } from "./store.js";
import { ServerWork } from "./server-work.js";
import { seedTagCatalogOnce } from "./tag-catalog.js";
import { registerTools } from "./tools.js";
import { mcpVersion } from "./version.js";

/**
 * Prefer the initialized session's human-readable title, then its client name.
 * Blank fields fall through so the caret always has a label.
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
    {
      name: "uberblick",
      title: "Uberblick",
      websiteUrl: "https://github.com/uberblick-ai/uberblick-2",
      version: mcpVersion(),
    },
    {
      instructions: STARTUP_ORIENTATION,
    },
  );

  // Use the initialized client's identity for cursors and default comment authors.
  server.server.oninitialized = () => {
    replicas.setAgentName(agentDisplayName(server.server.getClientVersion()));
  };

  const help = registerTools(server, replicas, briefing, work);
  registerHelpResources(server, help, work);
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
      // Assign the shared promise before transport onclose callbacks can
      // reenter close(). Admission has already stopped synchronously.
      closing = Promise.resolve().then(async () => {
        await server.close().catch((error: unknown) => {
          log.warn("closing the MCP server failed", error);
        });
        // SDK close aborts requests and drops replies but does not await
        // handlers. Their local writes still need the live replica and log.
        await work.drain();
        replicas.destroy();
        await replicas.sync.waitForDeviceWork();
        store.close();
      });
      return closing;
    },
  };
}

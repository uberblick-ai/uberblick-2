/**
 * Assemble synchronously from the local log; hub synchronization stays in the
 * background. Transport startup settles and seeds tags before admitting calls.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { McpConfig } from "./config.js";
import type { CredentialProvider } from "./credential-provider.js";
import { registerHelpResources } from "./help-resources.js";
import { log } from "./log.js";
import type { Replicas } from "./replica.js";
import type { MirrorStore } from "./store.js";
import { ServerShuttingDownError, ServerWork } from "./server-work.js";
import { SHUTDOWN_CLOSE_RESERVE_MS, SHUTDOWN_TIMEOUT_MS } from "./shutdown.js";
import { seedTagCatalogOnce } from "./tag-catalog.js";
import { startupInstructions } from "./startup-instructions.js";
import { registerTools } from "./tools.js";
import { mcpVersion } from "./version.js";
import { openWorkspaceReplicas } from "./workspace-replicas.js";
import { startHistoryRefresher } from "./history-refresher.js";

/**
 * Prefer the initialized session's human-readable title, then its client name.
 * Blank fields fall through so the caret always has a label.
 */
export function agentDisplayName(
  client: { name?: string | undefined; title?: string | undefined } | undefined,
): string {
  return client?.title?.trim() || client?.name?.trim() || "agent";
}

export function mcpSurfaceName(
  client: { name?: string | undefined; title?: string | undefined } | undefined,
): string {
  return client?.title?.trim() || client?.name?.trim() || "unknown MCP client";
}

export interface UberblickMcpSession {
  readonly server: McpServer;
  readonly replicas: Replicas;
  readonly store: MirrorStore;
  /** Attach a transport and start serving. */
  connect(transport: Transport): Promise<void>;
  /** Close this session's transport and drain its admitted work. */
  close(): Promise<void>;
}

export interface UberblickMcpServer extends Omit<UberblickMcpSession, "close"> {
  /** Drain admitted work and await hub acknowledgement before releasing replicas. */
  close(deadline?: number): Promise<void>;
}

export interface McpRuntimeOptions {
  /** Adopt and close this mirror; omitted opens `config.databasePath`. */
  store?: MirrorStore;
  /** Supply only this runtime's credential; omitted uses the local login store. */
  credentialProvider?: CredentialProvider;
  /** Fix the name on this runtime's cursors and MCP update surface. */
  agentName?: string;
}

export interface UberblickMcpRuntime {
  readonly replicas: Replicas;
  readonly store: MirrorStore;
  /** Capture startup instructions and register tools for a new independent session. */
  openSession(): UberblickMcpSession;
  /** Close every session, drain admitted work, then release the shared replicas. */
  close(deadline?: number): Promise<void>;
}

/** Open replicas and a shared identity without attaching an MCP transport. */
export function createMcpRuntime(
  config: McpConfig,
  options: McpRuntimeOptions = {},
): UberblickMcpRuntime {
  return openRuntime(config, options, false);
}

function openRuntime(
  config: McpConfig,
  options: McpRuntimeOptions,
  initializedClientIdentity: boolean,
): UberblickMcpRuntime {
  const workspace = openWorkspaceReplicas(config, {
    ...(options.store === undefined ? {} : { store: options.store }),
    ...(options.credentialProvider === undefined ? {} : { credentialProvider: options.credentialProvider }),
  });
  const { store, replicas } = workspace;
  replicas.setAgentName(agentDisplayName({ name: options.agentName }));
  replicas.setWriteSurface({ kind: "mcp", name: options.agentName === undefined
    ? "unknown MCP client"
    : agentDisplayName({ name: options.agentName }) });
  const history = startHistoryRefresher(replicas);
  const sessions = new Set<UberblickMcpSession>();
  let seeding: Promise<void> | null = null;
  let closed = false;
  let closing: Promise<void> | null = null;

  return {
    replicas,
    store,
    openSession() {
      if (closed) throw new ServerShuttingDownError();
      const session = openSession(config, replicas, store, {
        seed() {
          seeding ??= seedTagCatalogOnce(replicas);
          return seeding;
        },
        initializedClientIdentity,
        released(session) {
          sessions.delete(session);
        },
      });
      sessions.add(session);
      return session;
    },
    close(deadline = performance.now() + SHUTDOWN_TIMEOUT_MS) {
      if (closing !== null) return closing;
      closed = true;
      const historyClosed = history.close();
      // Every session stops admission synchronously, before any transport closes.
      const draining = [...sessions].map((session) => session.close());
      closing = Promise.resolve().then(async () => {
        await Promise.all(draining);
        const pending = await replicas.waitForPendingChanges(deadline - SHUTDOWN_CLOSE_RESERVE_MS);
        if (!store.isRemoved() && !store.isDetached() && replicas.sync.enabled && replicas.config.localWorkspace !== true && pending > 0) {
          log.warn(`${pending} changes are still only local; they sync the next time Uberblick on this machine reaches the hub.`);
        }
        await historyClosed;
        await workspace.close();
      });
      return closing;
    },
  };
}

function openSession(
  config: McpConfig,
  replicas: Replicas,
  store: MirrorStore,
  runtime: {
    seed(): Promise<void>;
    initializedClientIdentity: boolean;
    released(session: UberblickMcpSession): void;
  },
): UberblickMcpSession {
  const work = new ServerWork();
  const server = new McpServer(
    {
      name: "uberblick",
      title: "Uberblick",
      websiteUrl: "https://github.com/uberblick-ai/uberblick-2",
      version: mcpVersion(),
    },
    { instructions: startupInstructions(replicas) },
  );
  if (runtime.initializedClientIdentity) {
    server.server.oninitialized = () => {
      replicas.setAgentName(agentDisplayName(server.server.getClientVersion()));
      replicas.setWriteSurface({ kind: "mcp", name: mcpSurfaceName(server.server.getClientVersion()) });
    };
  }
  const help = registerTools(server, replicas, work);
  registerHelpResources(server, help, work);
  let closed = false;
  let closing: Promise<void> | null = null;

  const session: UberblickMcpSession = {
    server,
    replicas,
    store,
    async connect(transport) {
      if (closed) return;
      await work.run(async () => {
        // A runtime seeds once before any session attaches its transport.
        await runtime.seed();
        if (closed) return;
        // SDK connect attaches synchronously before awaiting transport startup.
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
      // Publish the promise before transport callbacks can reenter close().
      closing = Promise.resolve().then(async () => {
        await server.close().catch((error: unknown) => {
          log.warn("closing the MCP server failed", error);
        });
        // SDK close drops replies without awaiting handlers and their writes.
        await work.drain();
        runtime.released(session);
      });
      return closing;
    },
  };
  return session;
}

/** Compose the local stdio runtime with its sole initialized-client session. */
export function createMcpServer(
  config: McpConfig,
  injectedStore?: MirrorStore,
): UberblickMcpServer {
  const runtime = openRuntime(config, injectedStore === undefined ? {} : { store: injectedStore }, true);
  const session = runtime.openSession();
  return {
    ...session,
    close(deadline) {
      return runtime.close(deadline);
    },
  };
}

/**
 * Reserve stdout for MCP frames; diagnostics go to stderr through ./log.ts.
 */

import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { resolveAgentSession, resolveMcpConfig } from "./config.js";
import { log } from "./log.js";
import { createMcpServer } from "./server.js";
import { closeWithDeadline } from "./shutdown.js";
import { assertWorkspaceBinding, readWorkspaceHub } from "./workspace-registry.js";
import { captureWorkspaceDetachGeneration, WorkspaceDetachedError } from "./workspace-generation.js";
import { MirrorStore } from "./store.js";

function openStdioServer(config: ReturnType<typeof resolveMcpConfig>) {
  // Public `ub mcp serve` registers its selection before starting this process.
  // Internal callers may intentionally open an unregistered test or replica.
  if (readWorkspaceHub(config.workspaceId) === undefined) return createMcpServer(config);
  const binding = { workspaceId: config.workspaceId,
    hubUrl: config.localWorkspace === true ? null : config.hubUrl };
  const generation = captureWorkspaceDetachGeneration(config.databasePath);
  assertWorkspaceBinding(binding, process.env, "MCP startup");
  const store = new MirrorStore(config.databasePath, config.workspaceId);
  try {
    if (captureWorkspaceDetachGeneration(config.databasePath) !== generation) throw new WorkspaceDetachedError();
    assertWorkspaceBinding(binding, process.env, "MCP startup");
    return createMcpServer(config, store);
  } catch (error) { store.close(); throw error; }
}

async function main(): Promise<void> {
  const config = resolveMcpConfig(process.env, resolveAgentSession(process.env.UB_AGENT_SESSION));
  const instance = openStdioServer(config);

  let shuttingDown = false;
  const shutdown = (signal: string): void => {
    if (shuttingDown) {
      return;
    }
    shuttingDown = true;
    log.info("shutting down", { signal });
    void closeWithDeadline((deadline) => instance.close(deadline)).then(
      () => process.exit(0),
      (error: unknown) => {
        log.error("shutdown failed", error);
        process.exit(1);
      },
    );
  };

  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
  // An MCP client closes stdin to say it is done with the server. Redirected
  // non-pipe inputs report EOF as `end` without necessarily reporting `close`.
  process.stdin.on("end", () => shutdown("stdin-end"));
  process.stdin.on("close", () => shutdown("stdin-close"));

  await instance.connect(new StdioServerTransport());
}

main().catch((error: unknown) => {
  log.error("failed to start", error);
  process.exit(1);
});

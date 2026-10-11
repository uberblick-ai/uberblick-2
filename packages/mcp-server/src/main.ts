/**
 * Reserve stdout for MCP frames; diagnostics go to stderr through ./log.ts.
 */

import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { resolveAgentSession, resolveMcpConfig } from "./config.js";
import { log } from "./log.js";
import { createMcpServer } from "./server.js";
import { closeWithDeadline } from "./shutdown.js";

async function main(): Promise<void> {
  const config = resolveMcpConfig(process.env, resolveAgentSession(process.env.UB_AGENT_SESSION));
  const instance = createMcpServer(config);

  let shuttingDown = false;
  const shutdown = (signal: string): void => {
    if (shuttingDown) {
      return;
    }
    shuttingDown = true;
    log.info("shutting down", { signal });
    void closeWithDeadline(() => instance.close()).then(
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

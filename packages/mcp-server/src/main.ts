/**
 * @uberblick/mcp-server — MCP stdio server.
 *
 * Offline-first Y.Doc replicas over a local SQLite mirror, exposing the v0 tool
 * set. The append-only update log is the authoritative local replica: the
 * server starts and serves every tool with the hub unreachable, writes apply
 * locally and return before the hub acknowledges them, and sync happens in the
 * background.
 *
 * stdout is the JSON-RPC transport for this process: it carries MCP frames and
 * nothing else. Every diagnostic goes to stderr through ./log.ts.
 */

import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { resolveMcpConfig } from "./config.js";
import { log } from "./log.js";
import { createMcpServer } from "./server.js";
import { closeWithDeadline } from "./shutdown.js";

async function main(): Promise<void> {
  const config = resolveMcpConfig();
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

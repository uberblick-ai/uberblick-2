/**
 * @uberblick/mcp-server — MCP stdio server.
 *
 * Holds Y.Doc replicas synced from the hub over @hocuspocus/provider,
 * mirrors them into a local SQLite index (FTS5, tags, backlinks), and
 * exposes block-scoped MCP tools. Agent edits are always block-scoped:
 * there is deliberately no whole-document replace tool.
 *
 * Scaffold placeholder — no tools are registered yet.
 */

import { log } from "./log.js";

function main(): void {
  // stdout is the JSON-RPC transport for this process: it carries MCP frames
  // and nothing else. All diagnostics go to stderr via ./log.ts.
  log.info("scaffold placeholder, not implemented yet");
}

main();

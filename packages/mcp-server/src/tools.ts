/**
 * Register operations through the shared adapter for result validation and
 * failure serialization. Use schema helpers for document reads and writes so
 * content stays within the web editor's supported palette.
 * Prose writes target one block and data writes validated collections; there
 * is no whole-document write or Markdown import. Permanent deletion requires archive first.
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Replicas } from "./replica.js";
import type { ServerWork } from "./server-work.js";
import { HelpCatalog } from "./help.js";
import { captureTool } from "./help-resources.js";
import { guarded } from "./tool-adapter.js";
import { tools } from "./tool-table.js";
import { createToolContext } from "./tools/context.js";

export function registerTools(
  server: McpServer,
  replicas: Replicas,
  work: ServerWork,
): HelpCatalog {
  const help = new HelpCatalog();
  const context = createToolContext(replicas, work, help);
  for (const tool of tools) {
    const registered = server.registerTool(tool.name, {
      title: tool.title,
      description: tool.description,
      inputSchema: tool.input,
      outputSchema: tool.output,
      annotations: tool.annotations,
    }, guarded(tool, context));
    captureTool(help, tool, registered);
  }
  return help;
}

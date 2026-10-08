import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { outputSchemas } from "../outputs.js";
import type { ToolContext } from "../tools/context.js";
import { ARCHIVED_IS_READ_ONLY, DECISION_EDGES, SYNCED_IS_ACKNOWLEDGED } from "../tools/descriptions.js";

import { guarded } from "../tool-adapter.js";
import { inputSchema, setLinksOperation } from "../tools/set-links.js";

export function registerSetLinks(server: McpServer, context: ToolContext): void {
  const { toolContract } = context;
  server.registerTool("set_links", {
    title: "Set a document's outbound links",
    description:
      "Replace the document's curated outbound link set. Values are target document UUIDs — never paths, never titles. " +
      DECISION_EDGES +
      " " +
      "The backlinks index follows immediately.\n\n" +
      ARCHIVED_IS_READ_ONLY +
      "\n\n" +
      SYNCED_IS_ACKNOWLEDGED +
      toolContract("set_links"),
    outputSchema: outputSchemas.set_links,
    inputSchema,
  }, guarded("set_links", context, setLinksOperation));
}

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { failureContract } from "../failures.js";
import { outputSchemas } from "../outputs.js";
import type { ToolContext } from "../tools/context.js";

import { guarded } from "../tool-adapter.js";
import { inputSchema, backlinksOperation } from "../tools/backlinks.js";

export function registerBacklinks(server: McpServer, context: ToolContext): void {
  server.registerTool("backlinks", {
    title: "Documents linking here",
    description:
      "Documents that reference this one, by UUID and never by path or title. The answer is the union of two " +
      "kinds of edge, which it does not distinguish: the curated doc-level `links` set_links owns, and every " +
      "inline reference in a prose block or table cell — written by link_range, an `inline` run, or a " +
      "table cell's inline markdown. A citation needs no `links` entry to appear here.\n\n" +
      "Each one carries its `description` — null where it has none — so a citing document can be judged without " +
      "opening it." +
      failureContract("backlinks"),
    outputSchema: outputSchemas.backlinks,
    inputSchema,
  }, guarded("backlinks", context, backlinksOperation));
}

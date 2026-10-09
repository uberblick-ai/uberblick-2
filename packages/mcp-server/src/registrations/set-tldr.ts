import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { MAX_TLDR_LENGTH } from "@uberblick/schema";
import { outputSchemas } from "../outputs.js";
import type { ToolContext } from "../tools/context.js";
import { ARCHIVED_IS_READ_ONLY, DECIDED_IS_READ_ONLY, SYNCED_IS_ACKNOWLEDGED } from "../tools/descriptions.js";

import { guarded } from "../tool-adapter.js";
import { inputSchema, setTldrOperation } from "../tools/set-tldr.js";

export function registerSetTldr(server: McpServer, context: ToolContext): void {
  const { toolContract } = context;
  server.registerTool("set_tldr", {
    title: "Set or clear a document's TL;DR",
    description:
      "Replace the person-facing TL;DR wholesale with one or two sentences of plain English, or pass null to " +
      "clear it. It is independent of the agent-facing description: writing either leaves the other untouched. " +
      "The value lives in document metadata; decision stubs also cache it as the decision line for discovery. " +
      "Ordinary document stubs, search and Markdown do not carry it.\n\n" +
      "An empty or whitespace-only string is refused rather than treated as a clear, and an overlong value is " +
      `refused rather than truncated. The shared limit is ${MAX_TLDR_LENGTH} characters.\n\n` +
      DECIDED_IS_READ_ONLY +
      "\n\n" +
      ARCHIVED_IS_READ_ONLY +
      "\n\n" +
      SYNCED_IS_ACKNOWLEDGED +
      toolContract("set_tldr"),
    outputSchema: outputSchemas.set_tldr,
    inputSchema,
  }, guarded("set_tldr", context, setTldrOperation));
}

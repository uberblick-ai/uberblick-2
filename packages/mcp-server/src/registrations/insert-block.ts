import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { BLOCK_TYPES } from "@uberblick/schema";
import { outputSchemas } from "../outputs.js";
import type { ToolContext } from "../tools/context.js";
import { ARCHIVED_IS_READ_ONLY, DECIDED_IS_READ_ONLY, SYNCED_IS_ACKNOWLEDGED, TLDR_AFTER_CONTENT_CHANGE } from "../tools/descriptions.js";

import { guarded } from "../tool-adapter.js";
import { inputSchema, insertBlockOperation } from "../tools/insert-block.js";

export function registerInsertBlock(server: McpServer, context: ToolContext): void {
  const { toolContract } = context;
  server.registerTool("insert_block", {
    title: "Insert a block",
    description:
      "Insert one block after `after_block_id`, or at the top of the document when it is omitted. " +
      `Block types are the closed set the schema owns — ${BLOCK_TYPES.join(", ")} — which is the editor's ` +
      "whole palette too. A list is a run of adjacent list-item blocks. A table's `text` must be exactly one " +
      "GFM table, or `invalid_table` refuses the write; its rows and cells are stored structurally. Alignment " +
      "markers are accepted but not stored. Inline markdown stores cell formatting and escaped punctuation stays " +
      "literal. Document-link targets must be known to this replica's directory, otherwise " +
      "`doclink_target_not_known_locally` refuses before any write. A terminal's text is " +
      "a transcript in which a line beginning `$ ` is a command " +
      "typed out and every other line is output shown whole — the format has no escape, so an output line " +
      "that itself begins `$ ` cannot be written. Every block has one text an agent can edit.\n\n" +
      DECIDED_IS_READ_ONLY +
      "\n\n" +
      ARCHIVED_IS_READ_ONLY +
      "\n\n" +
      SYNCED_IS_ACKNOWLEDGED +
      "\n\n" +
      TLDR_AFTER_CONTENT_CHANGE +
      toolContract("insert_block"),
    outputSchema: outputSchemas.insert_block,
    inputSchema,
  }, guarded("insert_block", context, insertBlockOperation));
}

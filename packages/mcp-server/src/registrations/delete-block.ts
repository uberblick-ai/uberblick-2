import type { ToolRegistrar } from "../help-resources.js";
import { outputSchemas } from "../outputs.js";
import type { ToolContext } from "../tools/context.js";
import { ARCHIVED_IS_READ_ONLY, DECIDED_IS_READ_ONLY, SYNCED_IS_ACKNOWLEDGED, TLDR_AFTER_CONTENT_CHANGE } from "../tools/descriptions.js";

import { guarded } from "../tool-adapter.js";
import { inputSchema, deleteBlockOperation } from "../tools/delete-block.js";

export function registerDeleteBlock(server: ToolRegistrar, context: ToolContext): void {
  const { toolContract } = context;
  server.registerTool("delete_block", {
    title: "Delete a block",
    description:
      "Delete one block. Deleting is never how a block changes type — use insert_block plus edit_block only for new content, " +
      "and never delete-and-reinsert to re-type, which churns the block id and orphans its annotations.\n\n" +
      DECIDED_IS_READ_ONLY +
      "\n\n" +
      ARCHIVED_IS_READ_ONLY +
      "\n\n" +
      SYNCED_IS_ACKNOWLEDGED +
      "\n\n" +
      TLDR_AFTER_CONTENT_CHANGE +
      toolContract("delete_block"),
    outputSchema: outputSchemas.delete_block,
    inputSchema,
  }, guarded("delete_block", context, deleteBlockOperation));
}

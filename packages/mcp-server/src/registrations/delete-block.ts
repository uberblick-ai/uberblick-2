import type { ToolRegistrar } from "../help-resources.js";
import { helpPointer } from "../help.js";
import { outputSchemas } from "../outputs.js";
import type { ToolContext } from "../tools/context.js";
import { guarded } from "../tool-adapter.js";
import { inputSchema, deleteBlockOperation } from "../tools/delete-block.js";

export function registerDeleteBlock(server: ToolRegistrar, context: ToolContext): void {
  server.registerTool("delete_block", {
    title: "Delete a block",
    description:
      "Delete one block. Deleting is never how a block changes type — use insert_block plus edit_block only for " +
      "new content, and never delete-and-reinsert to re-type, which churns the block id and orphans its " +
      "annotations." +
      helpPointer("delete_block"),
    outputSchema: outputSchemas.delete_block,
    inputSchema,
  }, guarded("delete_block", context, deleteBlockOperation));
}

import type { ToolRegistrar } from "../help-resources.js";
import { helpPointer } from "../help.js";
import { outputSchemas } from "../outputs.js";
import type { ToolContext } from "../tools/context.js";
import { guarded } from "../tool-adapter.js";
import { inputSchema, editBlockOperation } from "../tools/edit-block.js";

export function registerEditBlock(server: ToolRegistrar, context: ToolContext): void {
  server.registerTool("edit_block", {
    title: "Edit one block",
    description:
      "Replace one block's text by diff-and-splice, preserving concurrent edits elsewhere. Assert old_text and " +
      "preferably rev from get_doc. A stale rev returns stale_block; current rev with wrong text returns " +
      "old_text_mismatch, while mismatch without rev is stale_block. Both carry currentText/currentRev to " +
      "re-diff. Assertions check this replica at call time, without distributed compare-and-swap. For prose, " +
      "use plain text. Marks anchor to positions: edit only strictly inside unmarked text; for changed ranges " +
      "touching formatting, use delete_block plus insert_block and verify with export_markdown. For tables, " +
      "old/new text must each be one GFM table or invalid_table refuses. Only a no-op or one positional cell " +
      "change at unchanged dimensions works without table_mapping; structural/multi-cell edits require it. " +
      "Invalid mappings refuse with invalid_table_mapping; stale assertions take precedence. Newly added " +
      "document targets must be known locally. Read edit_block help for mapping invariants and formatting " +
      "limits before editing tables." +
      helpPointer("edit_block"),
    outputSchema: outputSchemas.edit_block,
    inputSchema,
  }, guarded("edit_block", context, editBlockOperation));
}

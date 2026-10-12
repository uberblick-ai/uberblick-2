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
      "Splice changed block text, preserving edits elsewhere. Assert old_text and " +
      "preferably rev from get_doc. A stale rev returns stale_block; current rev with wrong text returns " +
      "old_text_mismatch; without rev, mismatch is stale_block. Both carry currentText/currentRev. " +
      "Assertions are local, without distributed compare-and-swap. For prose, " +
      "use plain text. Marks anchor to positions: edit only strictly inside unmarked text; for changed ranges " +
      "touching formatting, use delete_block plus insert_block and verify with export_markdown. For tables, " +
      "old/new text must each be one GFM table or invalid_table refuses. Only a no-op or one positional cell " +
      "change at same dimensions works without table_mapping; structural/multi-cell edits require it. " +
      "Invalid mappings: invalid_table_mapping; stale assertions take precedence. Newly added document targets " +
      "must be known locally. Cards use inline Markdown prose and repeated button: [Text](destination) lines " +
      "after footer in authored order. Nonempty plain labels link to https or exact claude://code/new, " +
      "claude-cli://open or codex://new, with " +
      "optional ?query. One style (outline/filled) and color (neutral/blue/green/violet) may follow in either " +
      "order, default outline neutral; output writes style before color and omits defaults. Invalid cards " +
      "return invalid_card. Unchanged parts, buttons and anchors survive; rev includes formatting and " +
      "each button's text, destination, appearance and order." +
      helpPointer("edit_block"),
    outputSchema: outputSchemas.edit_block,
    inputSchema,
  }, guarded("edit_block", context, editBlockOperation));
}

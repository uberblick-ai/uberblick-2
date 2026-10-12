import type { ToolRegistrar } from "../help-resources.js";
import { helpPointer } from "../help.js";
import { outputSchemas } from "../outputs.js";
import type { ToolContext } from "../tools/context.js";
import { guarded } from "../tool-adapter.js";
import { inputSchema, insertBlockOperation } from "../tools/insert-block.js";

export function registerInsertBlock(server: ToolRegistrar, context: ToolContext): void {
  server.registerTool("insert_block", {
    title: "Insert a block",
    description:
      "Insert one block after after_block_id, or at the top when omitted. Types cover the editor's closed block " +
      "palette; lists use adjacent list-item blocks. Table text must be exactly one GFM table or invalid_table " +
      "refuses; it stores parsed cells and inline formatting. Card text omits its :::card and ::: delimiter lines: " +
      "label, title, footer and optional button keys at most once, a required nonempty title, then a blank line " +
      "and optional prose body. Prose holds inline Markdown. The button is [Text](destination): nonempty plain " +
      "text and an https URL or claude://code/new, claude-cli://open or codex://new, alone or with ?query. " +
      "Invalid buttons, unknown, duplicate or non-key headers refuse with invalid_card. " +
      "Document-link targets must be known in this " +
      "replica's directory or doclink_target_not_known_locally refuses before writing. Other block text is " +
      "plain or literal source. Terminal lines starting with a dollar sign and space are demonstrated commands; " +
      "other lines are output. Chart text is a JSON mapping for a line chart or data table over this document's " +
      "collection; invalid mappings show a problem. Use update_data for view records." +
      helpPointer("insert_block"),
    outputSchema: outputSchemas.insert_block,
    inputSchema,
  }, guarded("insert_block", context, insertBlockOperation));
}

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
      "Splice block text, preserving edits elsewhere. Assert old_text and preferably rev from get_doc; " +
      "stale_block or old_text_mismatch returns currentText/currentRev. Assertions are replica-local. " +
      "Edit prose strictly inside unmarked text; replace marked spans with delete_block/insert_block " +
      "and verify export_markdown. Tables require GFM old/new text and table_mapping for " +
      "structural/multi-cell edits. Cards take :::card content: inline-Markdown prose, repeated button: " +
      "[Text](destination) lines after footer in authored order. New buttons need nonempty plain labels " +
      "linking to https or exact claude://code/new, claude-cli://open, codex://new, optionally with " +
      "?query. Style outline/filled and color neutral/blue/green/violet default to outline neutral; " +
      "output writes style before color and omits defaults. invalid_card refuses bad input; unchanged " +
      "parts, buttons and anchors survive. Rev includes each button's text, destination, appearance and " +
      "order. Figma takes :::figma content: url, optional plain title and height 240–960, blank line " +
      "and marked caption. Accepted Figma view URLs retain only the path and node-id, " +
      "starting-point-node-id, version-id on www.figma.com. invalid_figma refuses without writing. " +
      "Changed headers update their fields; unchanged caption marks/anchors survive. Figma rev includes " +
      "caption formatting. Card/Figma conversions and table_mapping are refused; new document targets " +
      "must be known locally." +
      helpPointer("edit_block"),
    outputSchema: outputSchemas.edit_block,
    inputSchema,
  }, guarded("edit_block", context, editBlockOperation));
}

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
      "Replace one block by diff-and-splice, preserving concurrent edits elsewhere. Assert old_text and " +
      "preferably rev from get_doc: stale_block or old_text_mismatch returns currentText/currentRev for a " +
      "fresh diff; assertions are replica-local. Prose uses plain text; edit strictly inside unmarked text, " +
      "or replace marked spans with delete_block/insert_block and verify export_markdown. Tables require " +
      "GFM old/new text and table_mapping for structural or multi-cell changes; read help for refusals and " +
      "mapping rules. Cards parse :::card content and preserve unchanged parts, buttons, marks and anchors; " +
      "invalid_card refuses malformed input. Figma parses content between :::figma and :::; url, optional " +
      "plain title and height 240–960, then a blank line and inline-Markdown caption. It accepts HTTPS Figma " +
      "design/file/proto/board/slides/community-file links and keeps only the view's path, node-id, " +
      "starting-point-node-id and version-id on www.figma.com. invalid_figma refuses invalid keys, URL or " +
      "height without writing. Changed headers update only their fields; unchanged caption marks and anchors " +
      "survive. Figma rev includes caption formatting; get_doc supplies derived fields. Card/Figma conversions " +
      "and table_mapping are refused; new caption document targets must be known locally." +
      helpPointer("edit_block"),
    outputSchema: outputSchemas.edit_block,
    inputSchema,
  }, guarded("edit_block", context, editBlockOperation));
}

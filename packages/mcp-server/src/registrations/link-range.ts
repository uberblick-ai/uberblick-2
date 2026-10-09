import type { ToolRegistrar } from "../help-resources.js";
import { helpPointer } from "../help.js";
import { outputSchemas } from "../outputs.js";
import type { ToolContext } from "../tools/context.js";
import { guarded } from "../tool-adapter.js";
import { inputSchema, linkRangeOperation } from "../tools/link-range.js";

export function registerLinkRange(server: ToolRegistrar, context: ToolContext): void {
  server.registerTool("link_range", {
    title: "Link a range of a block to another document",
    description:
      "Mark selected prose text as a document reference without changing its characters or rev. start/end are " +
      "character offsets measured against the required rev; stale_block returns currentText/currentRev for " +
      "remeasurement. Indices clamp to text and swap if reversed; empty ranges refuse. Existing document " +
      "references are retargeted; external links and code, mermaid, table, terminal or chart source blocks " +
      "refuse. doc_id must be known to this replica's directory or doclink_target_not_known_locally refuses " +
      "before writing; archived targets are accepted. The answer includes the target title, but the label stays " +
      "the selected text and does not follow renames. Backlinks update without changing curated meta.links." +
      helpPointer("link_range"),
    outputSchema: outputSchemas.link_range,
    inputSchema,
  }, guarded("link_range", context, linkRangeOperation));
}

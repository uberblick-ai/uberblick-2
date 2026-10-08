import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { outputSchemas } from "../outputs.js";
import type { ToolContext } from "../tools/context.js";
import { ARCHIVED_IS_READ_ONLY, DECIDED_IS_READ_ONLY, SYNCED_IS_ACKNOWLEDGED } from "../tools/descriptions.js";

import { guarded } from "../tool-adapter.js";
import { inputSchema, linkRangeOperation } from "../tools/link-range.js";

export function registerLinkRange(server: McpServer, context: ToolContext): void {
  const { toolContract } = context;
  server.registerTool("link_range", {
    title: "Link a range of a block to another document",
    description:
      "Turn a range of a block's text into an inline reference to another document. The range's own characters " +
      "are the label — this tool writes a mark and never a character, so the block's `text` and `rev` come back " +
      "exactly as get_doc gave them. `annotate` anchors a comment to a range the same way; this is that " +
      "operation with a document uuid instead of a thread.\n\n" +
      "`start` and `end` are character offsets into the block's text, and `rev` is REQUIRED: offsets mean " +
      "nothing without the text they were measured against. A stale `rev` refuses with `stale_block`, carrying " +
      "`currentText` and `currentRev` to re-measure against. Indices are clamped to the text and swapped if " +
      "reversed; a range that clamps to nothing is refused.\n\n" +
      "A range that is already a reference is RETARGETED. A range that is already an external link is refused — " +
      "one range cannot be both — and so is a code, mermaid, table, terminal or chart block, which holds source text. " +
      "The answer carries the target's current `title` for information; the label in the document is the text " +
      "you linked, and it does not follow a later rename.\n\n" +
      "The target must be a document this replica's directory knows, or the call refuses with " +
      "`doclink_target_not_known_locally` and writes nothing. An archived target is accepted.\n\n" +
      "The edge shows up in backlinks without touching `meta.links`, which stays the curated doc-level list " +
      "set_links owns.\n\n" +
      DECIDED_IS_READ_ONLY +
      "\n\n" +
      ARCHIVED_IS_READ_ONLY +
      "\n\n" +
      SYNCED_IS_ACKNOWLEDGED +
      toolContract("link_range"),
    outputSchema: outputSchemas.link_range,
    inputSchema,
  }, guarded("link_range", context, linkRangeOperation));
}

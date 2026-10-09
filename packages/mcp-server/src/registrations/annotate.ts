import type { ToolRegistrar } from "../help-resources.js";
import { helpPointer } from "../help.js";
import { outputSchemas } from "../outputs.js";
import type { ToolContext } from "../tools/context.js";
import { guarded } from "../tool-adapter.js";
import { inputSchema, annotateOperation } from "../tools/annotate.js";

export function registerAnnotate(server: ToolRegistrar, context: ToolContext): void {
  server.registerTool("annotate", {
    title: "Annotate a range, or reply to and resolve a thread",
    description:
      "Open an anchored comment thread on block_id/start/end, or reply with thread_id and no range fields. text " +
      "and author belong to both modes; only replies accept resolved to resolve or reopen in the same update. " +
      "Mixing modes or incomplete ranges refuses at the input boundary. For tables, row/column are zero-based " +
      "GFM projection indices including header row 0. Offsets count displayed cell characters, including stored " +
      "edge whitespace: remove exactly the GFM padding before decoding inline syntax. Returned coordinates " +
      "follow moved cells; orphaned ranges are null and orphaned threads still accept replies. Missing, invalid " +
      "or non-table coordinates refuse with annotation_cell; empty/overlapping ranges refuse with " +
      "annotation_range. Offsets are clamped to text." +
      helpPointer("annotate"),
    outputSchema: outputSchemas.annotate,
    inputSchema,
  }, guarded("annotate", context, annotateOperation));
}

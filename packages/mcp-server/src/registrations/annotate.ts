import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { outputSchemas } from "../outputs.js";
import type { ToolContext } from "../tools/context.js";
import { ARCHIVED_IS_READ_ONLY, SYNCED_IS_ACKNOWLEDGED } from "../tools/descriptions.js";

const ANNOTATE_SHAPES =
  "Two shapes, and a call is exactly one of them: open a thread with `block_id`, `start` and `end` — all three, " +
  "none of them optional — plus `row` and `column` for a table cell, or reply to one with `thread_id` and no range fields at all. Mixing them, or leaving a " +
  "range half-stated, is refused at the input boundary before anything is written, rather than resolved by " +
  "ignoring whichever fields do not fit. `text` and `author` belong to both. A reply may also carry `resolved`: " +
  "true resolves the thread and false reopens it in the same document update as the reply; a new thread cannot " +
  "carry that field.";

import { guarded } from "../tool-adapter.js";
import { inputSchema, annotateOperation } from "../tools/annotate.js";

export function registerAnnotate(server: McpServer, context: ToolContext): void {
  const { toolContract } = context;
  server.registerTool("annotate", {
    title: "Annotate a range, or reply to and resolve a thread",
    description:
      "Open an annotation thread over a range of a block's text, or — with `thread_id` — add a comment to an existing thread and optionally resolve or reopen it. " +
      "The range is anchored by a formatting mark on the text itself, so it survives edits, splits and re-types.\n\n" +
      "For a table, supply `row` and `column`: zero-based GFM projection indices with the header as row 0, " +
      "the same indices as `table_mapping`. `start` and `end` count the cell's displayed characters, without " +
      "inline Markdown syntax or escapes, including stored cell-edge whitespace. Canonical GFM `text` preserves " +
      "that whitespace and adds one padding space on either side: remove exactly that padding before decoding " +
      "the cell's inline syntax, rather than trimming it. Offsets are clamped to the cell's text. The returned " +
      "range adds `row` and `column`, recomputed as cells move; it is null when orphaned. Coordinates on a " +
      "non-table block, missing coordinates or a cell outside the projection refuse with `annotation_cell` " +
      "before anything is written. Empty and overlapping ranges refuse with `annotation_range`. " +
      "Orphaned legacy table threads stay orphaned and accept replies, resolution and reopening.\n\n" +
      ANNOTATE_SHAPES +
      "\n\n" +
      ARCHIVED_IS_READ_ONLY +
      "\n\n" +
      SYNCED_IS_ACKNOWLEDGED +
      toolContract("annotate"),
    outputSchema: outputSchemas.annotate,
    inputSchema,
  }, guarded("annotate", context, annotateOperation));
}

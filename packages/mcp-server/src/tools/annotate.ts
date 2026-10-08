import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { addComment, createAnnotation, setAnnotationResolved } from "@uberblick/schema";
import { z } from "zod";
import { ToolError, guarded } from "../failures.js";
import { strictInput } from "../inputs.js";
import { outputSchemas } from "../outputs.js";
import type { ToolMode } from "../inputs.js";
import type { ToolContext } from "./context.js";
import { ARCHIVED_IS_READ_ONLY, SYNCED_IS_ACKNOWLEDGED } from "./descriptions.js";
import { json } from "./helpers.js";
import { uuidArg } from "./schemas.js";

/**
 * `annotate`'s two shapes, stated once for the boundary and for `tools/list`.
 *
 * The fields are not independently optional: a reply names a thread, opening
 * one names a block and a range, and a call carrying both says two things at
 * once. A reply may also resolve or reopen its thread; opening one cannot.
 * The shape is selected on `thread_id` rather than on an added `action` field,
 * so every call an agent already writes stays valid.
 */
const ANNOTATE_MODES: readonly ToolMode[] = [
  {
    title: "A reply (`thread_id`)",
    when: { field: "thread_id", present: true },
    forbids: ["block_id", "start", "end", "row", "column"],
  },
  {
    title: "Opening a thread over a range",
    when: { field: "thread_id", present: false },
    requires: ["block_id", "start", "end"],
    forbids: ["resolved"],
  },
];

/** What `annotate` says about its two shapes, in the words an agent reads. */
const ANNOTATE_SHAPES =
  "Two shapes, and a call is exactly one of them: open a thread with `block_id`, `start` and `end` — all three, " +
  "none of them optional — plus `row` and `column` for a table cell, or reply to one with `thread_id` and no range fields at all. Mixing them, or leaving a " +
  "range half-stated, is refused at the input boundary before anything is written, rather than resolved by " +
  "ignoring whichever fields do not fit. `text` and `author` belong to both. A reply may also carry `resolved`: " +
  "true resolves the thread and false reopens it in the same document update as the reply; a new thread cannot " +
  "carry that field.";

export function registerAnnotate(server: McpServer, context: ToolContext): void {
  const {
    toolContract,
    replicas,
    briefing,
    requireWritableDoc,
    annotationJson,
    durability,
  } = context;

  server.registerTool(
    "annotate",
    {
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
      inputSchema: strictInput(
        {
          uuid: uuidArg,
          text: z.string().min(1).describe("The comment body."),
          thread_id: z
            .string()
            .min(1)
            .optional()
            .describe("Comment on this existing thread instead of opening a new one."),
          block_id: z.string().min(1).optional().describe("The block to annotate. New thread only."),
          start: z.number().int().min(0).optional().describe("Range start, in characters. New thread only."),
          end: z.number().int().min(0).optional().describe("Range end, exclusive. New thread only."),
          row: z.number().int().min(0).optional().describe("Table cell row in the zero-based GFM projection, header 0. New thread only."),
          column: z.number().int().min(0).optional().describe("Table cell column in the zero-based GFM projection. New thread only."),
          resolved: z
            .boolean()
            .optional()
            .describe("With thread_id, true resolves the thread and false reopens it."),
          author: z.string().min(1).optional(),
        },
        ANNOTATE_MODES,
      ),
    },
    guarded("annotate", async ({ uuid, text, thread_id, block_id, start, end, row, column, resolved, author }) => {
      await replicas.settle();
      briefing.require();
      const replica = requireWritableDoc(uuid);
      const who = author ?? replicas.name;

      if (thread_id !== undefined) {
        // Both schema helpers transact; this outer transaction folds a reply
        // plus its resolution into one Yjs update and therefore one durable
        // append, while keeping their independently reusable schema contracts.
        const updated = replica.doc.transact(() => {
          const added = addComment(replica.doc, thread_id, who, text);
          return added !== null && resolved !== undefined
            ? setAnnotationResolved(replica.doc, thread_id, resolved)
            : added;
        });
        if (updated === null) {
          throw new ToolError(
            "thread_not_found",
            `No annotation thread ${thread_id} in document ${uuid}`,
            { uuid, threadId: thread_id },
          );
        }
        return json({
          uuid,
          annotation: annotationJson(replica, updated),
          ...durability(replica),
        });
      }

      // No `thread_id` is the other shape, and the input boundary refused the
      // call unless all three range fields came with it — see
      // {@link ANNOTATE_MODES}. The assertions stand in for what TypeScript
      // cannot read off fields the object declares once for both shapes.
      if ((row === undefined) !== (column === undefined)) {
        throw new ToolError("annotation_cell", "Table cell coordinates require both row and column", { blockId: block_id, reason: "missing" });
      }
      const created = createAnnotation(
        replica.doc,
        block_id as string,
        start as number,
        end as number,
        who,
        text,
        row === undefined || column === undefined ? undefined : { row, column },
      );
      return json({
        uuid,
        annotation: annotationJson(replica, created),
        ...durability(replica),
      });
    }),
  );
}

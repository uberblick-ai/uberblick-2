import { addComment, createAnnotation, setAnnotationResolved } from "@uberblick/schema";
import { z } from "zod";
import { ToolError } from "../failures.js";
import { strictInput } from "../inputs.js";
import type { ToolMode } from "../inputs.js";
import { uuidArg } from "./schemas.js";
import { documentOperation } from "./operation.js";

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

export const inputSchema = strictInput(
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
);

export const annotateOperation = documentOperation("annotate", inputSchema, (context, { uuid, text, thread_id, block_id, start, end, row, column, resolved, author }, _request, replica) => {
  const { replicas, annotationJson } = context;

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
    return {
      uuid,
      annotation: annotationJson(replica, updated),
    };
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
  return {
    uuid,
    annotation: annotationJson(replica, created),
  };
});

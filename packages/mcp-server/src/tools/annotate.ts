import { addComment, createAnnotation, getAnnotation, getBlock, moveAnnotation, setAnnotationResolved } from "@uberblick/schema";
import { z } from "zod";
import { ToolError } from "../failures.js";
import { strictInput } from "../inputs.js";
import type { ToolMode } from "../inputs.js";
import { uuidArg } from "./schemas.js";
import { documentOperation } from "./operation.js";

/**
 * Existing threads either receive a reply or move to a range with a reply.
 * Only a reply without a range may change resolution.
 */
const ANNOTATE_MODES: readonly ToolMode[] = [
  {
    title: "A reply (`thread_id`)",
    when: { all: [{ field: "thread_id", present: true }, { field: "block_id", present: false }] },
    forbids: ["block_id", "start", "end", "row", "column"],
  },
  {
    title: "Moving a thread's anchor",
    when: { all: [{ field: "thread_id", present: true }, { field: "block_id", present: true }] },
    requires: ["start", "end"],
    forbids: ["resolved"],
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
      .describe("Reply to or move this existing thread."),
    block_id: z.string().min(1).optional().describe("Target block for opening or moving an anchor."),
    start: z.number().int().min(0).optional().describe("Anchor range start, in characters."),
    end: z.number().int().min(0).optional().describe("Anchor range end, exclusive."),
    row: z.number().int().min(0).optional().describe("Table cell row in the zero-based GFM projection, header 0."),
    column: z.number().int().min(0).optional().describe("Table cell column in the zero-based GFM projection."),
    resolved: z
      .boolean()
      .optional()
      .describe("Reply only: true resolves the thread; false reopens it."),
    author: z.string().min(1).optional(),
  },
  ANNOTATE_MODES,
);

export const annotateOperation = documentOperation({ content: false, contentDurability: false }, inputSchema, (context, { uuid, text, thread_id, block_id, start, end, row, column, resolved, author }, _request, replica) => {
  const { replicas, annotationJson } = context;

  const who = author ?? replicas.name;

  if (thread_id !== undefined && getAnnotation(replica.doc, thread_id) === null) {
    throw new ToolError("thread_not_found", `No annotation thread ${thread_id} in document ${uuid}`, { uuid, threadId: thread_id });
  }

  if (thread_id !== undefined && block_id === undefined) {
    // Combine nested reply/resolution transactions into one durable append.
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

  // ANNOTATE_MODES requires these range fields; TypeScript cannot infer the branch.
  if (getBlock(replica.doc, block_id as string)?.type === "card") {
    throw new ToolError("annotation_card", "Open card anchors on selected text in the web editor; MCP can move an existing thread only to prose or a table cell.", { blockId: block_id });
  }
  if (getBlock(replica.doc, block_id as string)?.type === "figma") {
    throw new ToolError("annotation_figma", "Open Figma caption anchors on selected text in the web editor; MCP can move an existing thread only to prose or a table cell.", { blockId: block_id });
  }
  if ((row === undefined) !== (column === undefined)) {
    throw new ToolError("annotation_cell", "Table cell coordinates require both row and column", { blockId: block_id, reason: "missing" });
  }
  const target = row === undefined || column === undefined ? undefined : { row, column };
  const updated = thread_id === undefined
    ? createAnnotation(replica.doc, block_id as string, start as number, end as number, who, text, target)
    : moveAnnotation(replica.doc, thread_id, block_id as string, start as number, end as number, who, text, target);
  if (updated === null) throw new ToolError("thread_not_found", `No annotation thread ${thread_id} in document ${uuid}`, { uuid, threadId: thread_id });
  return {
    uuid,
    annotation: annotationJson(replica, updated),
  };
});

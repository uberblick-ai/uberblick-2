import { addComment, createAnnotation, getBlock, setAnnotationResolved } from "@uberblick/schema";
import { z } from "zod";
import { ToolError } from "../failures.js";
import { strictInput } from "../inputs.js";
import type { ToolMode } from "../inputs.js";
import { uuidArg } from "./schemas.js";
import { documentOperation } from "./operation.js";

/**
 * thread_id selects a reply with optional resolution; its absence requires
 * a block/range and forbids resolution. The two field sets cannot mix.
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
    throw new ToolError("annotation_card", "Open new card comment threads in the web editor; MCP supports replies to existing card threads.", { blockId: block_id });
  }
  if (getBlock(replica.doc, block_id as string)?.type === "figma") {
    throw new ToolError("annotation_figma", "MCP cannot open a new Figma caption thread; it supports replies to existing Figma threads.", { blockId: block_id });
  }
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

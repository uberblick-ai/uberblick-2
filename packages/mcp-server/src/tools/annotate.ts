import { addComment, createAnnotation, deleteComment, editComment, getAnnotation, getBlock, moveAnnotation, setAnnotationResolved } from "@uberblick/schema";
import type { CommentDeleteRefusal, CommentEditRefusal } from "@uberblick/schema";
import { z } from "zod";
import { ToolError } from "../failures.js";
import { strictInput } from "../inputs.js";
import type { ToolMode } from "../inputs.js";
import { uuidArg } from "./schemas.js";
import { documentOperation } from "./operation.js";

/**
 * Editing and deletion are exclusive of the open, reply and move shapes.
 */
const ANNOTATE_MODES: readonly ToolMode[] = [
  {
    title: "Editing a comment (`action: edit`)",
    when: { field: "action", is: "edit" },
    requires: ["thread_id", "comment_id", "text"],
    forbids: ["author", "block_id", "start", "end", "row", "column", "resolved"],
  },
  {
    title: "Deleting a comment (`action: delete`)",
    when: { field: "action", is: "delete" },
    requires: ["thread_id", "comment_id"],
    forbids: ["text", "author", "block_id", "start", "end", "row", "column", "resolved"],
  },
  {
    title: "A reply (`thread_id`)",
    when: { all: [{ field: "action", present: false }, { field: "thread_id", present: true }, { field: "block_id", present: false }] },
    requires: ["text"],
    forbids: ["comment_id", "block_id", "start", "end", "row", "column"],
  },
  {
    title: "Moving a thread's anchor",
    when: { all: [{ field: "action", present: false }, { field: "thread_id", present: true }, { field: "block_id", present: true }] },
    requires: ["text", "start", "end"],
    forbids: ["comment_id", "resolved"],
  },
  {
    title: "Opening a thread over a range",
    when: { all: [{ field: "action", present: false }, { field: "thread_id", present: false }] },
    requires: ["text", "block_id", "start", "end"],
    forbids: ["comment_id", "resolved"],
  },
];

export const inputSchema = strictInput(
  {
    uuid: uuidArg,
    text: z.string().optional().describe("Comment body; required except for delete. Edit replaces it and refuses blank text."),
    action: z.enum(["delete", "edit"]).optional().describe("Edit or permanently delete; requires thread_id/comment_id. Edit also requires text; other mode fields are forbidden."),
    comment_id: z.string().min(1).optional().describe("Edit/delete only: stable id from get_doc or annotate."),
    thread_id: z
      .string()
      .min(1)
      .optional()
      .describe("Reply to, move, edit or delete a comment in this existing thread."),
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
).superRefine(({ action, text }, ctx) => {
  // Edit's shared writer reports blank text; other shapes retain their input refusal.
  if (action !== "edit" && text === "") {
    ctx.addIssue({ code: "too_small", origin: "string", minimum: 1, inclusive: true, path: ["text"] });
  }
});

const EDIT_RECOVERY: Record<Exclude<CommentEditRefusal, "thread_not_found" | "comment_not_found">, string> = {
  account_required: "Sign in to this workspace's hub account before editing comments; this MCP session has no signed-in account. Nothing was written.",
  comment_account_missing: "Choose a comment with a stored account; comments without an account cannot be edited. Nothing was written.",
  comment_not_owned: "Choose a comment whose stored account matches this session's signed-in GitHub account; someone else's comment cannot be edited. Nothing was written.",
  thread_resolved: "Choose a comment in an unresolved conversation; comments in a resolved conversation cannot be edited. Nothing was written.",
  empty_text: "Supply text that is not empty after trimming; blank comment text cannot be saved. Nothing was written.",
};

const DELETE_RECOVERY: Record<Exclude<CommentDeleteRefusal, "thread_not_found" | "comment_not_found">, string> = {
  account_required: "Sign in to this workspace's hub account before deleting comments; this MCP session has no signed-in account. Nothing was written.",
  comment_account_missing: "Choose a comment with a stored account; comments without an account cannot be deleted. Nothing was written.",
  comment_not_owned: "Choose a comment whose stored account matches this session's signed-in GitHub account; someone else's comment cannot be deleted. Nothing was written.",
  reply_account_missing: "Delete only a reply you own; the opening comment cannot be deleted while a reply has no stored account. Nothing was written.",
  reply_not_owned: "Delete only a reply you own; the opening comment cannot be deleted while another account has replied. Nothing was written.",
  thread_resolved: "Choose a comment in an unresolved conversation; comments in a resolved conversation cannot be deleted. Nothing was written.",
};

export const annotateOperation = documentOperation({ content: false, contentDurability: false }, inputSchema, (context, { uuid, text, action, comment_id, thread_id, block_id, start, end, row, column, resolved, author }, _request, replica) => {
  const { replicas, annotationJson } = context;

  const who = author ?? replicas.name;
  const attribution = replicas.commentAttribution();

  if (action === "edit") {
    const result = editComment(replica.doc, thread_id as string, comment_id as string, attribution.account, text as string, { reportRefusal: true });
    if (!result.ok) {
      const detail = { uuid, threadId: thread_id, commentId: comment_id };
      if (result.reason === "thread_not_found" || result.reason === "comment_not_found") {
        throw new ToolError(result.reason, "The requested comment or conversation no longer exists.", detail);
      }
      throw new ToolError("comment_edit_refused", "This comment cannot be edited.", {
        ...detail, reason: result.reason, recovery: EDIT_RECOVERY[result.reason],
      });
    }
    return { uuid, annotation: annotationJson(replica, result.annotation) };
  }

  if (action === "delete") {
    // The delete mode requires both ids before this handler can run.
    const result = deleteComment(replica.doc, thread_id as string, comment_id as string, attribution.account);
    if (!result.ok) {
      const detail = { uuid, threadId: thread_id, commentId: comment_id };
      if (result.reason === "thread_not_found" || result.reason === "comment_not_found") {
        throw new ToolError(result.reason, "The requested comment or conversation no longer exists.", detail);
      }
      const recovery = DELETE_RECOVERY[result.reason];
      throw new ToolError("comment_delete_refused", "This comment cannot be deleted.", { ...detail, reason: result.reason, recovery });
    }
    return {
      uuid,
      removed: result.removed,
      ...(result.removed === "comment" ? { annotation: annotationJson(replica, result.annotation) } : {}),
    };
  }

  if (thread_id !== undefined && getAnnotation(replica.doc, thread_id) === null) {
    throw new ToolError("thread_not_found", `No annotation thread ${thread_id} in document ${uuid}`, { uuid, threadId: thread_id });
  }

  if (thread_id !== undefined && block_id === undefined) {
    // Combine nested reply/resolution transactions into one durable append.
    const updated = replica.doc.transact(() => {
      const added = addComment(replica.doc, thread_id, who, text as string, attribution);
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
    throw new ToolError("annotation_card", "Open card anchors on selected text in the web editor; MCP can move an existing thread to prose or a table cell.", { blockId: block_id });
  }
  if (getBlock(replica.doc, block_id as string)?.type === "figma") {
    throw new ToolError("annotation_figma", "Open Figma caption anchors on selected text in the web editor; MCP can move an existing thread to prose or a table cell.", { blockId: block_id });
  }
  if ((row === undefined) !== (column === undefined)) {
    throw new ToolError("annotation_cell", "Table cell coordinates require both row and column", { blockId: block_id, reason: "missing" });
  }
  const target = row === undefined || column === undefined ? undefined : { row, column };
  const updated = thread_id === undefined
    ? createAnnotation(replica.doc, block_id as string, start as number, end as number, who, text as string, target, attribution)
    : moveAnnotation(replica.doc, thread_id, block_id as string, start as number, end as number, who, text as string, target, attribution);
  if (updated === null) throw new ToolError("thread_not_found", `No annotation thread ${thread_id} in document ${uuid}`, { uuid, threadId: thread_id });
  return {
    uuid,
    annotation: annotationJson(replica, updated),
  };
});

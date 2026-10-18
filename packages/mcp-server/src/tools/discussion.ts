import { getMeta } from "@uberblick/schema";
import { ToolError } from "../failures.js";
import type { ToolContext } from "./context.js";

/** Connecting a discussion validates its live identity without editing it. */
export function discussionTarget(context: ToolContext, uuid: string): string {
  const target = context.requireWritableDoc(uuid);
  const meta = getMeta(target.doc, target.id);
  if (meta.kind === "decision") {
    throw new ToolError(
      "discussion_not_regular_document",
      `Document ${uuid} is a decision record, so it cannot hold the discussion`,
      { discussion: uuid, kind: "decision" },
    );
  }
  return target.id;
}

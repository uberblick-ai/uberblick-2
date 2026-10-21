import { annotationAnchors, listAnnotations } from "@uberblick/schema";
import * as Y from "yjs";
import { ToolError } from "../failures.js";

/** Apply the actual splice off-replica: Yjs transactions cannot roll back. */
export function preservingOpenAnchors(
  doc: Y.Doc,
  blockId: string,
  change: (draft: Y.Doc) => void,
): void {
  const draft = new Y.Doc();
  try {
    Y.applyUpdate(draft, Y.encodeStateAsUpdate(doc));
    const before = Y.encodeStateVector(draft);
    const anchors = annotationAnchors(draft);
    change(draft);
    const remaining = annotationAnchors(draft);
    const threads = listAnnotations(doc)
      .filter(thread => thread.resolved !== true && anchors.has(thread.id) && !remaining.has(thread.id))
      .map(thread => ({ id: thread.id, text: anchors.get(thread.id) as string }));
    if (threads.length > 0) {
      throw new ToolError(
        "open_thread_anchored",
        `This write would remove the last anchor of open comment threads: ${threads.map(thread => `${thread.id} (${JSON.stringify(thread.text)})`).join(", ")}. Nothing was written.`,
        { blockId, threads },
      );
    }
    Y.applyUpdate(doc, Y.encodeStateAsUpdate(draft, before));
  } finally {
    draft.destroy();
  }
}

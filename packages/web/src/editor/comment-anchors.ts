/**
 * Resolved state lives in annotations, not the comment mark's thread id.
 * Repaint live spans on annotation changes and recreate them from current state;
 * never copy presentation state into block content.
 */

import { Extension } from "@tiptap/core";
import type { Mark } from "@tiptap/pm/model";
import { Plugin } from "@tiptap/pm/state";
import type { MarkView, ViewMutationRecord } from "@tiptap/pm/view";
import {
  COMMENT_MARK,
  getAnnotation,
  getAnnotationsMap,
} from "@uberblick/schema";
import type * as Y from "yjs";

const COMMENT_THREAD_LABEL = "Comment thread";
const RESOLVED_THREAD_LABEL = "Resolved comment thread";

function commentMarkViews(ydoc: Y.Doc): Plugin {
  const painters = new Set<() => void>();
  const repaint = (): void => {
    for (const paint of painters) paint();
  };

  return new Plugin({
    props: {
      markViews: {
        [COMMENT_MARK]: (mark: Mark): MarkView => {
          const dom = document.createElement("span");
          dom.className = "ub-comment";
          const threadId =
            typeof mark.attrs.threadId === "string" ? mark.attrs.threadId : null;
          if (threadId === null) return { dom };

          dom.setAttribute("data-comment-thread", threadId);
          dom.tabIndex = 0;
          dom.setAttribute("role", "button");
          const paint = (): void => {
            const resolved = getAnnotation(ydoc, threadId)?.resolved === true;
            dom.setAttribute(
              "aria-label",
              resolved ? RESOLVED_THREAD_LABEL : COMMENT_THREAD_LABEL,
            );
            if (resolved) dom.setAttribute("title", RESOLVED_THREAD_LABEL);
            else dom.removeAttribute("title");
          };
          paint();
          painters.add(paint);
          return {
            dom,
            // These attributes are live presentation, not an edit to read back
            // into the document. This also prevents a repaint/redraw loop.
            ignoreMutation: (mutation: ViewMutationRecord) =>
              mutation.type === "attributes",
            destroy: () => painters.delete(paint),
          };
        },
      },
    },
    view() {
      const annotations = getAnnotationsMap(ydoc);
      annotations.observeDeep(repaint);
      return {
        destroy() {
          annotations.unobserveDeep(repaint);
          painters.clear();
        },
      };
    },
  });
}

export interface CommentAnchorOptions {
  ydoc: Y.Doc | null;
}

/** Tiptap wrapper around the live comment mark view. */
export const CommentAnchors = Extension.create<CommentAnchorOptions>({
  name: "uberblickCommentAnchors",
  addOptions() {
    return { ydoc: null };
  },
  addProseMirrorPlugins() {
    const { ydoc } = this.options;
    return ydoc === null ? [] : [commentMarkViews(ydoc)];
  },
});

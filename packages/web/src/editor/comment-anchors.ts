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
          const threadId =
            typeof mark.attrs.threadId === "string" ? mark.attrs.threadId : null;
          if (threadId === null) return { dom };

          dom.setAttribute("data-comment-thread", threadId);
          const paint = (): void => {
            const resolved = getAnnotation(ydoc, threadId)?.resolved === true;
            dom.classList.toggle("ub-comment", !resolved);
            dom.toggleAttribute("data-comment-resolved", resolved);
            if (resolved) {
              dom.removeAttribute("tabindex");
              dom.removeAttribute("role");
              dom.removeAttribute("aria-label");
              dom.classList.remove("ub-comment-flash");
            } else {
              dom.tabIndex = 0;
              dom.setAttribute("role", "button");
              dom.setAttribute("aria-label", "Comment");
            }
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

interface CommentAnchorOptions {
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

/** Follow external links without treating pointer selection as activation. */

import { Extension } from "@tiptap/core";
import { Plugin, TextSelection } from "@tiptap/pm/state";
import { isExternalHref } from "@uberblick/schema";

/** The anchor also owns a click/Enter when it overlaps a comment highlight. */
export function linkAnchorFromTarget(
  target: EventTarget | null,
): HTMLAnchorElement | null {
  return target instanceof Element
    ? target.closest<HTMLAnchorElement>("a[href]")
    : null;
}

export const ExternalLinks = Extension.create({
  name: "uberblickExternalLinks",
  addProseMirrorPlugins() {
    return [
      new Plugin({
        props: {
          handleDOMEvents: {
            mousedown: (view, event) => {
              if (event.button !== 0 || !event.shiftKey) return false;
              const anchor = linkAnchorFromTarget(event.target);
              if (
                anchor === null ||
                !anchor.classList.contains("ub-link") ||
                !view.dom.contains(anchor) ||
                !isExternalHref(anchor.getAttribute("href"))
              ) {
                return false;
              }
              const pos = view.posAtCoords({
                left: event.clientX,
                top: event.clientY,
              });
              if (pos === null) return false;
              // Chromium collapses native Shift-click selection on an anchor,
              // even inside contenteditable. Let ProseMirror extend the range
              // instead; its selection transaction never changes the document.
              event.preventDefault();
              view.dispatch(
                view.state.tr.setSelection(
                  TextSelection.between(
                    view.state.selection.$anchor,
                    view.state.doc.resolve(pos.pos),
                  ),
                ),
              );
              view.focus();
              return true;
            },
          },
          handleClick: (view, _pos, event) => {
            if (!view.editable || event.button !== 0 || event.shiftKey) {
              return false;
            }
            const anchor = linkAnchorFromTarget(event.target);
            const href = anchor?.getAttribute("href");
            if (
              anchor === null ||
              !anchor.classList.contains("ub-link") ||
              !view.dom.contains(anchor) ||
              !isExternalHref(href)
            ) {
              return false;
            }
            // Like Tiptap's Link, use handleClick: ProseMirror suppresses it
            // after movement. Shift-click selection is handled above. The
            // stock mark cannot carry our href-only wire format.
            window.open(href, "_blank", "noopener,noreferrer");
            return true;
          },
        },
      }),
    ];
  },
});

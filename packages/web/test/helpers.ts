/**
 * Test helpers: build a document with the schema package, then bind an editor
 * to it the same way the app does.
 */

import * as Y from "yjs";
import { getBlocksFragment } from "@uberblick/schema";
import type { Editor } from "@tiptap/core";
import { createUberblickEditor } from "../src/editor/create-editor.js";
import { plainText } from "../src/editor/ytext.js";

/** Every top-level child of the `blocks` fragment, as a comparable snapshot. */
export interface FragmentSnapshot {
  nodeName: string;
  attributes: Record<string, unknown>;
  text: string;
  /** The text's delta, so formatting marks are part of the comparison. */
  delta: Array<Record<string, unknown>>;
}

export function snapshotFragment(ydoc: Y.Doc): FragmentSnapshot[] {
  return getBlocksFragment(ydoc)
    .toArray()
    .map((child) => {
      if (!(child instanceof Y.XmlElement)) {
        return { nodeName: "#text", attributes: {}, text: String(child), delta: [] };
      }
      const first = child.firstChild;
      const ytext = first instanceof Y.XmlText ? first : null;
      return {
        nodeName: child.nodeName,
        attributes: child.getAttributes() as Record<string, unknown>,
        text: plainText(ytext),
        delta:
          ytext === null
            ? []
            : (ytext.toDelta() as Array<Record<string, unknown>>),
      };
    });
}

/**
 * Mount an editor on a fresh element **inside `document.body`**. jsdom is
 * enough for ProseMirror, which needs no layout — but attachment is not about
 * layout, and the editor is not the only thing reading this DOM.
 *
 * Anything that finds a block by its id needs the block to be in the document
 * to find it: `document.getElementById` (the outline's scroll-to) returns
 * nothing for a detached tree. A test mounting into a detached div would pass
 * by exercising the fallbacks rather than the rules.
 *
 * Being in the document is also why destroying the editor takes the element
 * out of it again. One jsdom document is shared by every test in a file, and
 * block ids are stable per fixture — so a document left behind by an earlier
 * test holds blocks with the very ids a later test looks up, and
 * `getElementById` returns the first match in the document, not the one in the
 * editor that test just mounted. The teardown rides on the editor's own
 * `destroy` event so no call site has to remember it, and `remove()` does not
 * care which parent the element ended up under.
 */
export function mountEditor(
  ydoc: Y.Doc,
  options: { newBlockId?: () => string } = {},
): { editor: Editor; element: HTMLElement } {
  const element = document.createElement("div");
  document.body.appendChild(element);
  const editor = createUberblickEditor({
    element,
    fragment: getBlocksFragment(ydoc),
    awareness: null,
    ...(options.newBlockId === undefined
      ? {}
      : { newBlockId: options.newBlockId }),
  });
  editor.on("destroy", () => element.remove());
  return { editor, element };
}

/** A counter-based id source, so assertions can name exact ids. */
export function sequentialIds(prefix = "fresh"): () => string {
  let n = 0;
  return () => {
    n += 1;
    return `${prefix}-${n}`;
  };
}

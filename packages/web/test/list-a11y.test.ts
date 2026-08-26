/**
 * What a screen reader is told about a list (#227).
 *
 * The document model is flat: a list is a run of adjacent `list-item` blocks,
 * each rendered as a bare `<li>` among every other block (#59). Nothing in that
 * DOM says "list" on its own — an `<li>` outside a list has no role, and the
 * marker is generated content — so the run is exposed through ARIA instead:
 * every item carries `role="listitem"` with its level and its place in its set,
 * and an off-screen list container claims the run with `aria-owns`.
 *
 * Three contracts, and all three are about what is *exposed*, never about how:
 *
 * 1. **A run is one list.** One container per run, counting and levelling the
 *    items the way a nested list would — a nested item belongs to its own small
 *    set, not to the enclosing one.
 * 2. **The document is untouched by it.** Every one of these attributes is a
 *    decoration; the Y.Doc still holds one flat element per item, carrying the
 *    schema's attributes and nothing else.
 * 3. **It follows the document live.** A peer inserting an item into the middle
 *    of a run re-counts the run for the reader, because the structure is
 *    recomputed from the document on every draw rather than stored.
 */

import { describe, expect, it } from "vitest";
import * as Y from "yjs";
import {
  appendBlock,
  getBlocks,
  initDoc,
  insertBlock,
} from "@uberblick/schema";
import type { Editor } from "@tiptap/core";
import { mountEditor, snapshotFragment } from "./helpers.js";

type ItemSpec = readonly [text: string, list: "bullet" | "ordered", indent: 0 | 1];

function docWith(
  blocks: ReadonlyArray<ItemSpec | readonly ["paragraph", string]>,
): { ydoc: Y.Doc; ids: string[] } {
  const ydoc = new Y.Doc();
  initDoc(ydoc, { uuid: "list-a11y", title: "Lists" });
  const ids = blocks.map((block) =>
    block[0] === "paragraph"
      ? appendBlock(ydoc, { type: "paragraph", text: block[1] })
      : appendBlock(ydoc, {
          type: "list-item",
          text: block[0],
          list: block[1] as "bullet" | "ordered",
          indent: block[2] as 0 | 1,
        }),
  );
  return { ydoc, ids };
}

/** What assistive technology is told about each item on screen. */
function exposedItems(
  editor: Editor,
): Array<Record<string, string | null>> {
  return [...editor.view.dom.querySelectorAll("li")].map((item) => ({
    text: item.textContent,
    role: item.getAttribute("role"),
    level: item.getAttribute("aria-level"),
    position: item.getAttribute("aria-posinset"),
    size: item.getAttribute("aria-setsize"),
  }));
}

/** The lists themselves: their style, and the items each one claims. */
function exposedLists(
  editor: Editor,
): Array<{ tag: string; owns: string[] }> {
  return [...editor.view.dom.querySelectorAll("[role=list]")].map((list) => ({
    tag: list.tagName.toLowerCase(),
    owns: (list.getAttribute("aria-owns") ?? "").split(" "),
  }));
}

describe("a run of list items is one list", () => {
  /**
   * The nested fixture from the numbering test, read as a screen reader reads
   * it: three items at the top level and two one-item sets inside it.
   */
  it("counts and levels its items, nesting included", () => {
    const { ydoc, ids } = docWith([
      ["parent", "ordered", 0],
      ["child", "bullet", 1],
      ["parent two", "ordered", 0],
      ["nested count", "ordered", 1],
      ["parent three", "ordered", 0],
    ]);
    const { editor } = mountEditor(ydoc);
    try {
      expect(exposedItems(editor)).toEqual([
        { text: "parent", role: "listitem", level: "1", position: "1", size: "3" },
        { text: "child", role: "listitem", level: "2", position: "1", size: "1" },
        { text: "parent two", role: "listitem", level: "1", position: "2", size: "3" },
        {
          text: "nested count",
          role: "listitem",
          level: "2",
          position: "1",
          size: "1",
        },
        {
          text: "parent three",
          role: "listitem",
          level: "1",
          position: "3",
          size: "3",
        },
      ]);

      // One list, claiming every item of the run in document order. `ol`,
      // because the run is a numbered one — the one thing ARIA cannot say.
      expect(exposedLists(editor)).toEqual([{ tag: "ol", owns: ids }]);
    } finally {
      editor.destroy();
    }
  });

  it("ends at the first block that is not an item, and starts again after it", () => {
    const { ydoc, ids } = docWith([
      ["first", "bullet", 0],
      ["second", "bullet", 0],
      ["paragraph", "Prose in between."],
      ["third", "bullet", 0],
    ]);
    const { editor } = mountEditor(ydoc);
    try {
      expect(
        exposedItems(editor).map((item) => [item.position, item.size]),
      ).toEqual([
        ["1", "2"],
        ["2", "2"],
        // The prose ended the run: the item after it opens a set of its own.
        ["1", "1"],
      ]);
      expect(exposedLists(editor)).toEqual([
        { tag: "ul", owns: [ids[0], ids[1]] },
        { tag: "ul", owns: [ids[3]] },
      ]);
    } finally {
      editor.destroy();
    }
  });
});

describe("the exposed list follows the document", () => {
  /**
   * A peer — another browser, or an agent through the MCP server — inserting an
   * item into the middle of a run. The reader's list has to grow with it, and
   * the document has to stay exactly as flat as it was.
   */
  it("re-counts the run when a peer inserts into the middle of it", () => {
    const { ydoc, ids } = docWith([
      ["alpha", "bullet", 0],
      ["beta", "bullet", 0],
      ["gamma", "bullet", 0],
    ]);
    const peer = new Y.Doc();
    Y.applyUpdate(peer, Y.encodeStateAsUpdate(ydoc));

    const { editor } = mountEditor(ydoc);
    try {
      expect(exposedLists(editor)).toEqual([{ tag: "ul", owns: ids }]);

      const inserted = insertBlock(peer, ids[0] as string, {
        type: "list-item",
        text: "inserted",
        list: "bullet",
        indent: 0,
      });
      Y.applyUpdate(ydoc, Y.encodeStateAsUpdate(peer, Y.encodeStateVector(ydoc)));

      expect(
        exposedItems(editor).map((item) => [
          item.text,
          item.position,
          item.size,
        ]),
      ).toEqual([
        ["alpha", "1", "4"],
        ["inserted", "2", "4"],
        ["beta", "3", "4"],
        ["gamma", "4", "4"],
      ]);
      expect(exposedLists(editor)).toEqual([
        { tag: "ul", owns: [ids[0], inserted, ids[1], ids[2]] },
      ]);

      // Nothing of the rendering layer reached the document: four flat
      // elements, carrying the schema's attributes and no others.
      expect(snapshotFragment(ydoc).map((block) => block.nodeName)).toEqual([
        "list-item",
        "list-item",
        "list-item",
        "list-item",
      ]);
      expect(
        snapshotFragment(ydoc).map((block) => Object.keys(block.attributes).sort()),
      ).toEqual([
        ["id", "indent", "list"],
        ["id", "indent", "list"],
        ["id", "indent", "list"],
        ["id", "indent", "list"],
      ]);
      expect(getBlocks(ydoc).map((block) => block.text)).toEqual([
        "alpha",
        "inserted",
        "beta",
        "gamma",
      ]);
    } finally {
      editor.destroy();
    }
  });
});

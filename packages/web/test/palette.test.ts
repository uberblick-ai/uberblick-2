/**
 * The restricted palette, and what happens to content outside it.
 *
 * The rule from CLAUDE.md is that unknown blocks degrade loudly, never silently.
 * Two halves to that:
 *
 *  - Foreign *node types* must be rejected by the ProseMirror schema, not
 *    normalised into something else.
 *  - Foreign blocks already in the document must keep the editor from binding,
 *    because y-prosemirror's node factory deletes Y.XmlElements whose node name
 *    it cannot instantiate. The gate is what turns silent CRDT data loss into a
 *    visible banner.
 */

import { describe, expect, it } from "vitest";
import * as Y from "yjs";
import {
  COMMENT_MARK,
  appendBlock,
  getBlocks,
  getBlocksFragment,
  initDoc,
} from "@uberblick/schema";
import { uberblickSchema } from "../src/editor/create-editor.js";
import { bindGuardedEditor } from "../src/editor/guarded-binding.js";
import type { GuardedBinding } from "../src/editor/guarded-binding.js";
import {
  BLOCK_NODE_NAMES,
  MARK_NAMES,
  describeForeignBlocks,
  findForeignBlocks,
} from "../src/editor/palette.js";
import { plainText } from "../src/editor/ytext.js";
import { mountEditor } from "./helpers.js";

describe("the palette is exactly the schema's block types", () => {
  it("declares four block nodes plus doc and text, and nothing else", () => {
    expect(Object.keys(uberblickSchema.nodes).sort()).toEqual([
      "code",
      "doc",
      "heading",
      "mermaid",
      "paragraph",
      "text",
    ]);
    expect(BLOCK_NODE_NAMES).toEqual(["paragraph", "heading", "code", "mermaid"]);
  });

  it("declares exactly one mark, and the gate reads its list off the schema", () => {
    expect(Object.keys(uberblickSchema.marks)).toEqual([COMMENT_MARK]);
    expect(MARK_NAMES).toEqual(Object.keys(uberblickSchema.marks));
  });

  it("has no list, blockquote, bold or italic to fall back to", () => {
    for (const absent of [
      "bulletList",
      "orderedList",
      "listItem",
      "blockquote",
      "codeBlock",
      "horizontalRule",
      "hardBreak",
      "image",
      "table",
    ]) {
      expect(uberblickSchema.nodes[absent]).toBeUndefined();
    }
    for (const absent of ["bold", "italic", "strike", "link", "code"]) {
      expect(uberblickSchema.marks[absent]).toBeUndefined();
    }
  });

  it("allows the comment mark inside code and mermaid blocks", () => {
    // A `marks: ""` node spec would make y-prosemirror throw while building the
    // node — and its catch block deletes the Y.XmlText from the document.
    for (const name of ["code", "mermaid", "paragraph", "heading"]) {
      const type = uberblickSchema.nodes[name];
      expect(type).toBeDefined();
      expect(type?.allowsMarkType(uberblickSchema.marks[COMMENT_MARK]!)).toBe(true);
    }
  });

  it("rejects an unknown node type instead of normalising it", () => {
    expect(() => uberblickSchema.node("blockquote")).toThrow(/Unknown node type/);
    expect(() =>
      uberblickSchema.nodeFromJSON({
        type: "doc",
        content: [{ type: "bulletList", content: [] }],
      }),
    ).toThrow();
  });

  it("rejects an unknown mark type", () => {
    expect(uberblickSchema.marks.bold).toBeUndefined();
    expect(() => uberblickSchema.mark("bold")).toThrow();
    expect(() =>
      uberblickSchema.nodeFromJSON({
        type: "doc",
        content: [
          {
            type: "paragraph",
            attrs: { id: "a" },
            content: [{ type: "text", text: "x", marks: [{ type: "bold" }] }],
          },
        ],
      }),
    ).toThrow();
  });

  it("refuses nested blocks — the document is flat", () => {
    const paragraph = uberblickSchema.node("paragraph", { id: "a" });
    expect(() => uberblickSchema.node("paragraph", { id: "b" }, paragraph)).toThrow();
  });
});

describe("foreign blocks already in the document", () => {
  function docWithForeignBlock(): { ydoc: Y.Doc; foreignId: string } {
    const ydoc = new Y.Doc();
    initDoc(ydoc, { uuid: "doc-1", title: "Has a stranger" });
    appendBlock(ydoc, { type: "paragraph", text: "known" });

    // Written the way a future schema version (or another client) would: a node
    // name outside this client's palette.
    const foreignId = "foreign-block-id";
    const element = new Y.XmlElement("callout");
    element.setAttribute("id", foreignId);
    element.setAttribute("tone", "warning");
    element.insert(0, [new Y.XmlText("from the future")]);
    getBlocksFragment(ydoc).insert(1, [element]);
    return { ydoc, foreignId };
  }

  it("is detected by the gate, with enough detail for a loud placeholder", () => {
    const { ydoc, foreignId } = docWithForeignBlock();
    const foreign = findForeignBlocks(getBlocksFragment(ydoc));
    expect(foreign).toHaveLength(1);
    expect(foreign[0]?.nodeName).toBe("callout");
    expect(foreign[0]?.id).toBe(foreignId);
    expect(foreign[0]?.index).toBe(1);
    expect(describeForeignBlocks(foreign)).toContain("callout");
    expect(describeForeignBlocks(foreign)).toMatch(/unsupported type/i);
  });

  it("reports a clean fragment as safe to bind", () => {
    const ydoc = new Y.Doc();
    initDoc(ydoc, { uuid: "doc-2", title: "Fine" });
    appendBlock(ydoc, { type: "heading", text: "h", level: 2 });
    appendBlock(ydoc, { type: "code", text: "x", language: "ts" });
    appendBlock(ydoc, { type: "mermaid", text: "graph TD;" });
    expect(findForeignBlocks(getBlocksFragment(ydoc))).toEqual([]);
    expect(describeForeignBlocks([])).toBe("");
  });

  it("counts a bare top-level Y.XmlText as foreign", () => {
    const ydoc = new Y.Doc();
    initDoc(ydoc, { uuid: "doc-3", title: "Inline at top level" });
    getBlocksFragment(ydoc).insert(0, [new Y.XmlText("loose text")]);
    const foreign = findForeignBlocks(getBlocksFragment(ydoc));
    expect(foreign).toHaveLength(1);
    expect(foreign[0]?.nodeName).toBe("#text");
  });

  /**
   * The reason the gate exists, pinned as a test: bind an editor to a fragment
   * holding a foreign block and y-prosemirror destroys it. If this test ever
   * starts failing because y-prosemirror learned to preserve unknown nodes, the
   * gate can be relaxed — until then it must stay.
   */
  it("would be DESTROYED by binding the editor, which is why binding is gated", () => {
    const { ydoc } = docWithForeignBlock();
    expect(getBlocksFragment(ydoc).length).toBe(2);

    const { editor } = mountEditor(ydoc);
    try {
      // The foreign element is gone from the CRDT — not merely unrendered.
      expect(getBlocksFragment(ydoc).length).toBe(1);
      expect(findForeignBlocks(getBlocksFragment(ydoc))).toEqual([]);
      expect(editor.state.doc.childCount).toBe(1);
    } finally {
      editor.destroy();
    }
  });

  it("leaves the foreign block untouched when the gate refuses to bind", () => {
    const { ydoc, foreignId } = docWithForeignBlock();
    const element = document.createElement("div");
    document.body.appendChild(element);
    const binding = bindGuardedEditor({
      element,
      fragment: getBlocksFragment(ydoc),
      awareness: null,
    });
    expect(binding.refused).toBe(true);
    expect(binding.editor).toBeNull();

    // Nothing was bound, so nothing was dropped.
    expect(getBlocksFragment(ydoc).length).toBe(2);
    const stored = getBlocksFragment(ydoc).get(1);
    expect(stored instanceof Y.XmlElement).toBe(true);
    expect((stored as Y.XmlElement).getAttribute("id")).toBe(foreignId);
    expect((stored as Y.XmlElement).getAttribute("tone")).toBe("warning");

    // And the schema package still reads it — as a paragraph, by its own
    // forward-compatibility rule, with its text and id intact.
    const blocks = getBlocks(ydoc);
    expect(blocks).toHaveLength(2);
    expect(blocks[1]?.id).toBe(foreignId);
    expect(blocks[1]?.text).toBe("from the future");
    binding.destroy();
  });

  /**
   * The run-time half of the gate, and the subtle one. A foreign block arriving
   * from another client is deleted inside the same Yjs transaction cleanup that
   * delivered it, so the guard has to be synchronous — a React re-render is far
   * too late.
   */
  it("survives a foreign block arriving while the editor is bound", () => {
    const ydoc = new Y.Doc();
    initDoc(ydoc, { uuid: "doc-5", title: "Mid-session" });
    appendBlock(ydoc, { type: "paragraph", text: "known" });

    const element = document.createElement("div");
    document.body.appendChild(element);
    const unbound: string[] = [];
    const binding = bindGuardedEditor({
      element,
      fragment: getBlocksFragment(ydoc),
      awareness: null,
      onUnbind: () => unbound.push("unbound"),
    });
    expect(binding.refused).toBe(false);
    expect(binding.editor).not.toBeNull();

    // A remote client writes a block type this palette does not know.
    const foreign = new Y.XmlElement("callout");
    foreign.setAttribute("id", "arrived-later");
    foreign.setAttribute("tone", "warning");
    foreign.insert(0, [new Y.XmlText("arrived mid-session")]);
    getBlocksFragment(ydoc).insert(1, [foreign]);

    // Still there, attributes and text intact — the guard unbound the editor
    // before y-prosemirror's deep observer could delete it.
    expect(unbound).toEqual(["unbound"]);
    expect(getBlocksFragment(ydoc).length).toBe(2);
    const stored = getBlocksFragment(ydoc).get(1);
    expect(stored instanceof Y.XmlElement).toBe(true);
    expect((stored as Y.XmlElement).nodeName).toBe("callout");
    expect((stored as Y.XmlElement).getAttribute("id")).toBe("arrived-later");
    expect((stored as Y.XmlElement).getAttribute("tone")).toBe("warning");
    expect(findForeignBlocks(getBlocksFragment(ydoc))).toHaveLength(1);

    binding.destroy();
  });

  it("re-binds cleanly once the foreign block is gone", () => {
    const { ydoc } = docWithForeignBlock();
    const element = document.createElement("div");
    document.body.appendChild(element);

    expect(
      bindGuardedEditor({
        element,
        fragment: getBlocksFragment(ydoc),
        awareness: null,
      }).refused,
    ).toBe(true);

    // Whoever owns the foreign type removes it; the palette is clean again.
    getBlocksFragment(ydoc).delete(1, 1);
    const second = bindGuardedEditor({
      element,
      fragment: getBlocksFragment(ydoc),
      awareness: null,
    });
    expect(second.refused).toBe(false);
    expect(second.editor?.state.doc.childCount).toBe(1);
    second.destroy();
  });
});

/**
 * The same hazard, one level down. A block name the palette knows is not enough:
 * y-prosemirror recurses into the block's children and builds every mark, and
 * both failure paths end in the same catch-and-delete. So the gate has to look
 * inside the block, at load *and* mid-session.
 */
describe("foreign content inside a known block", () => {
  /** A paragraph the palette can name, holding an element it cannot. */
  function nestedElement(): Y.XmlElement {
    const callout = new Y.XmlElement("callout");
    callout.insert(0, [new Y.XmlText("keep me")]);
    return callout;
  }

  function docWithBlock(): Y.Doc {
    const ydoc = new Y.Doc();
    initDoc(ydoc, { uuid: "nested-doc", title: "Nested" });
    appendBlock(ydoc, { type: "paragraph", text: "known" });
    return ydoc;
  }

  function firstBlockText(ydoc: Y.Doc): Y.XmlText {
    const block = getBlocksFragment(ydoc).get(0) as Y.XmlElement;
    return block.firstChild as Y.XmlText;
  }

  /** The non-string inserts of a Y.XmlText — what an embed leaves in the delta. */
  function embedsOf(ytext: Y.XmlText): unknown[] {
    return (ytext.toDelta() as Array<{ insert?: unknown }>)
      .map((op) => op.insert)
      .filter((insert) => typeof insert !== "string");
  }

  function bind(ydoc: Y.Doc, onUnbind?: () => void): GuardedBinding {
    const element = document.createElement("div");
    document.body.appendChild(element);
    return bindGuardedEditor({
      element,
      fragment: getBlocksFragment(ydoc),
      awareness: null,
      ...(onUnbind === undefined ? {} : { onUnbind }),
    });
  }

  it("is detected, named and attributed to the block that holds it", () => {
    const nested = docWithBlock();
    (getBlocksFragment(nested).get(0) as Y.XmlElement).insert(1, [nestedElement()]);
    const foreign = findForeignBlocks(getBlocksFragment(nested));
    expect(foreign).toHaveLength(1);
    expect(foreign[0]?.nodeName).toBe("callout");
    expect(foreign[0]?.index).toBe(0);
    expect(describeForeignBlocks(foreign)).toContain("callout");

    const marked = docWithBlock();
    firstBlockText(marked).format(0, 3, { bold: {} });
    const markFindings = findForeignBlocks(getBlocksFragment(marked));
    expect(markFindings).toHaveLength(1);
    expect(markFindings[0]?.nodeName).toBe("#mark:bold");
  });

  it("keeps a nested element when it is already there at load", () => {
    const ydoc = docWithBlock();
    (getBlocksFragment(ydoc).get(0) as Y.XmlElement).insert(1, [nestedElement()]);
    const binding = bind(ydoc);
    expect(binding.refused).toBe(true);

    const block = getBlocksFragment(ydoc).get(0) as Y.XmlElement;
    expect(block.length).toBe(2);
    expect((block.get(1) as Y.XmlElement).nodeName).toBe("callout");
    expect((block.get(1) as Y.XmlElement).toString()).toContain("keep me");
    binding.destroy();
  });

  it("keeps a nested element arriving while the editor is bound", () => {
    const ydoc = docWithBlock();
    const unbound: string[] = [];
    const binding = bind(ydoc, () => unbound.push("unbound"));
    expect(binding.refused).toBe(false);

    (getBlocksFragment(ydoc).get(0) as Y.XmlElement).insert(1, [nestedElement()]);

    expect(unbound).toEqual(["unbound"]);
    const block = getBlocksFragment(ydoc).get(0) as Y.XmlElement;
    expect(block.length).toBe(2);
    expect((block.get(1) as Y.XmlElement).nodeName).toBe("callout");
    expect(findForeignBlocks(getBlocksFragment(ydoc))).toHaveLength(1);
    binding.destroy();
  });

  it("keeps a text carrying an undeclared mark at load", () => {
    const ydoc = docWithBlock();
    firstBlockText(ydoc).format(0, 3, { bold: {} });
    const binding = bind(ydoc);
    expect(binding.refused).toBe(true);

    const delta = firstBlockText(ydoc).toDelta() as Array<Record<string, unknown>>;
    expect(plainText(firstBlockText(ydoc))).toBe("known");
    expect(delta[0]?.attributes).toEqual({ bold: {} });
    binding.destroy();
  });

  it("keeps a text carrying an undeclared mark applied mid-session", () => {
    const ydoc = docWithBlock();
    const unbound: string[] = [];
    const binding = bind(ydoc, () => unbound.push("unbound"));
    expect(binding.refused).toBe(false);

    firstBlockText(ydoc).format(0, 3, { bold: {} });

    expect(unbound).toEqual(["unbound"]);
    expect(plainText(firstBlockText(ydoc))).toBe("known");
    const delta = firstBlockText(ydoc).toDelta() as Array<Record<string, unknown>>;
    expect(delta[0]?.attributes).toEqual({ bold: {} });
    binding.destroy();
  });

  /**
   * The quiet variant, and the reason the delta scan checks `insert` as well as
   * `attributes`. An embed throws nothing while binding: y-prosemirror's
   * `createTextNodesFromYText` only ever calls `schema.text(insert, marks)`, so
   * a non-string insert simply never reaches the editor state — and the next
   * keystroke writes the block's text back to the Y.XmlText without it. Silent
   * loss on a later mutation, which is why the gate has to refuse up front.
   */
  it("keeps an embed inside a block's text at load", () => {
    const ydoc = docWithBlock();
    firstBlockText(ydoc).insertEmbed(1, { future: "keep-me" });
    const foreign = findForeignBlocks(getBlocksFragment(ydoc));
    expect(foreign).toHaveLength(1);
    expect(foreign[0]?.nodeName).toBe("#embed");

    const binding = bind(ydoc);
    expect(binding.refused).toBe(true);
    expect(embedsOf(firstBlockText(ydoc))).toEqual([{ future: "keep-me" }]);
    expect(plainText(firstBlockText(ydoc))).toBe("known");
    binding.destroy();
  });

  it("keeps an embed arriving while the editor is bound", () => {
    const ydoc = docWithBlock();
    const unbound: string[] = [];
    const binding = bind(ydoc, () => unbound.push("unbound"));
    expect(binding.refused).toBe(false);

    firstBlockText(ydoc).insertEmbed(1, { future: "keep-me" });

    expect(unbound).toEqual(["unbound"]);
    expect(embedsOf(firstBlockText(ydoc))).toEqual([{ future: "keep-me" }]);
    expect(plainText(firstBlockText(ydoc))).toBe("known");
    expect(findForeignBlocks(getBlocksFragment(ydoc))).toHaveLength(1);
    binding.destroy();
  });

  it("still binds a text carrying the comment mark — that one is declared", () => {
    const ydoc = docWithBlock();
    firstBlockText(ydoc).format(0, 3, { [COMMENT_MARK]: { threadId: "t1" } });
    expect(findForeignBlocks(getBlocksFragment(ydoc))).toEqual([]);
    const binding = bind(ydoc);
    expect(binding.refused).toBe(false);
    binding.destroy();
  });
});

describe("the editor refuses foreign content inserted through commands", () => {
  it("throws rather than silently dropping an unknown node type", () => {
    const ydoc = new Y.Doc();
    initDoc(ydoc, { uuid: "doc-4", title: "Insert" });
    appendBlock(ydoc, { type: "paragraph", text: "hello" });
    const { editor } = mountEditor(ydoc);
    try {
      expect(() =>
        editor.commands.insertContent({
          type: "bulletList",
          content: [{ type: "listItem" }],
        }),
      ).toThrow();
      // The document is untouched.
      expect(getBlocks(ydoc).map((block) => block.type)).toEqual(["paragraph"]);
    } finally {
      editor.destroy();
    }
  });
});

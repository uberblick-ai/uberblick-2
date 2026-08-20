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
import {
  BLOCK_NODE_NAMES,
  describeForeignBlocks,
  findForeignBlocks,
} from "../src/editor/palette.js";
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

  it("declares exactly one mark", () => {
    expect(Object.keys(uberblickSchema.marks)).toEqual([COMMENT_MARK]);
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

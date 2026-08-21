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
  INLINE_MARKS,
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
  describeForeignBlocks,
  findForeignBlocks,
} from "../src/editor/palette.js";
import { plainText } from "../src/editor/ytext.js";
import { mountEditor } from "./helpers.js";

describe("the palette is exactly the schema's block types", () => {
  it("declares four block nodes, six marks, and nothing else", () => {
    expect(Object.keys(uberblickSchema.nodes).sort()).toEqual([
      "code",
      "doc",
      "heading",
      "mermaid",
      "paragraph",
      "text",
    ]);
    expect(BLOCK_NODE_NAMES).toEqual(["paragraph", "heading", "code", "mermaid"]);
    // The closed mark set: the schema package's five inline marks, plus the
    // annotation anchor.
    expect(Object.keys(uberblickSchema.marks).sort()).toEqual(
      [...INLINE_MARKS, COMMENT_MARK].sort(),
    );

    // Stated the other way round, because a node or mark that quietly exists is
    // one the editor could normalise foreign content into.
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
    for (const absent of ["underline", "highlight", "superscript", "textStyle"]) {
      expect(uberblickSchema.marks[absent]).toBeUndefined();
    }
  });

  it("allows the comment mark inside code and mermaid blocks, and nothing else there", () => {
    // A `marks: ""` node spec would make y-prosemirror throw while building the
    // node — and its catch block deletes the Y.XmlText from the document.
    for (const name of ["code", "mermaid", "paragraph", "heading"]) {
      const type = uberblickSchema.nodes[name];
      expect(type).toBeDefined();
      expect(type?.allowsMarkType(uberblickSchema.marks[COMMENT_MARK]!)).toBe(true);
    }

    // Inline marks are prose only: a source block's text is source.
    for (const mark of INLINE_MARKS) {
      const type = uberblickSchema.marks[mark]!;
      expect(uberblickSchema.nodes.paragraph?.allowsMarkType(type), mark).toBe(true);
      expect(uberblickSchema.nodes.heading?.allowsMarkType(type), mark).toBe(true);
      expect(uberblickSchema.nodes.code?.allowsMarkType(type), mark).toBe(false);
      expect(uberblickSchema.nodes.mermaid?.allowsMarkType(type), mark).toBe(false);
    }
  });

  /**
   * The wire contract, asserted on the schema rather than through a document:
   * y-prosemirror writes a mark's Yjs attribute under a hashed key
   * (`bold--A1b2C3d4`) unless the mark type excludes itself. The schema package
   * reads and writes the bare names, so every mark here must be self-excluding.
   */
  it("keeps every mark self-excluding, so its Yjs key is its bare name", () => {
    for (const name of Object.keys(uberblickSchema.marks)) {
      const type = uberblickSchema.marks[name]!;
      expect(type.excludes(type), name).toBe(true);
    }
  });

  it("rejects an unknown node or mark type instead of normalising it", () => {
    expect(() => uberblickSchema.node("blockquote")).toThrow(/Unknown node type/);
    expect(() =>
      uberblickSchema.nodeFromJSON({
        type: "doc",
        content: [{ type: "bulletList", content: [] }],
      }),
    ).toThrow();

    expect(() => uberblickSchema.mark("underline")).toThrow();
    expect(() =>
      uberblickSchema.nodeFromJSON({
        type: "doc",
        content: [
          {
            type: "paragraph",
            attrs: { id: "a" },
            content: [{ type: "text", text: "x", marks: [{ type: "underline" }] }],
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

    // A bare Y.XmlText at the top level is foreign too — the document is a list
    // of block elements, and y-prosemirror would drop loose inline content.
    const loose = new Y.Doc();
    initDoc(loose, { uuid: "doc-3", title: "Inline at top level" });
    getBlocksFragment(loose).insert(0, [new Y.XmlText("loose text")]);
    const looseFindings = findForeignBlocks(getBlocksFragment(loose));
    expect(looseFindings).toHaveLength(1);
    expect(looseFindings[0]?.nodeName).toBe("#text");

    // And a fragment made only of palette blocks is reported as safe to bind:
    // the detector has to be quiet, or the gate would never open.
    const clean = new Y.Doc();
    initDoc(clean, { uuid: "doc-2", title: "Fine" });
    appendBlock(clean, { type: "heading", text: "h", level: 2 });
    appendBlock(clean, { type: "code", text: "x", language: "ts" });
    appendBlock(clean, { type: "mermaid", text: "graph TD;" });
    expect(findForeignBlocks(getBlocksFragment(clean))).toEqual([]);
    expect(describeForeignBlocks([])).toBe("");
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
    firstBlockText(marked).format(0, 3, { underline: {} });
    const markFindings = findForeignBlocks(getBlocksFragment(marked));
    expect(markFindings).toHaveLength(1);
    expect(markFindings[0]?.nodeName).toBe("#mark:underline");

    // A mark the schema declares but this block may not hold is foreign too:
    // inline marks belong to prose, never to a source block.
    const inCode = new Y.Doc();
    initDoc(inCode, { uuid: "code-doc", title: "Marked source" });
    appendBlock(inCode, { type: "code", text: "const x = 1;", language: "ts" });
    const codeText = (getBlocksFragment(inCode).get(0) as Y.XmlElement)
      .firstChild as Y.XmlText;
    codeText.format(0, 5, { bold: {} });
    expect(findForeignBlocks(getBlocksFragment(inCode))).toEqual([
      expect.objectContaining({ nodeName: "#mark:bold", index: 0 }),
    ]);
  });

  /**
   * The three kinds of foreign content a known block can hold, and the two
   * guards that have to catch each of them. One test per guard, because the
   * guard is the subject; the kind of content only varies the fixture.
   */
  const kinds: Array<{
    what: string;
    plant: (ydoc: Y.Doc) => void;
    /** Everything the block must still hold afterwards. */
    intact: (ydoc: Y.Doc) => void;
  }> = [
    {
      what: "a nested element",
      plant: (ydoc) => {
        (getBlocksFragment(ydoc).get(0) as Y.XmlElement).insert(1, [
          nestedElement(),
        ]);
      },
      intact: (ydoc) => {
        const block = getBlocksFragment(ydoc).get(0) as Y.XmlElement;
        expect(block.length).toBe(2);
        expect((block.get(1) as Y.XmlElement).nodeName).toBe("callout");
        expect((block.get(1) as Y.XmlElement).toString()).toContain("keep me");
      },
    },
    {
      what: "a text carrying an undeclared mark",
      plant: (ydoc) => {
        firstBlockText(ydoc).format(0, 3, { underline: {} });
      },
      intact: (ydoc) => {
        expect(plainText(firstBlockText(ydoc))).toBe("known");
        const delta = firstBlockText(ydoc).toDelta() as Array<
          Record<string, unknown>
        >;
        expect(delta[0]?.attributes).toEqual({ underline: {} });
      },
    },
    {
      what: "an embed inside the block's text",
      plant: (ydoc) => {
        firstBlockText(ydoc).insertEmbed(1, { future: "keep-me" });
      },
      intact: (ydoc) => {
        expect(embedsOf(firstBlockText(ydoc))).toEqual([{ future: "keep-me" }]);
        expect(plainText(firstBlockText(ydoc))).toBe("known");
      },
    },
  ];

  it("keeps foreign content that is already there at load, of every kind", () => {
    for (const { what, plant, intact } of kinds) {
      const ydoc = docWithBlock();
      plant(ydoc);
      expect(findForeignBlocks(getBlocksFragment(ydoc)), what).toHaveLength(1);

      const binding = bind(ydoc);
      expect(binding.refused, what).toBe(true);
      intact(ydoc);
      binding.destroy();
    }
  });

  it("keeps foreign content arriving while the editor is bound, of every kind", () => {
    for (const { what, plant, intact } of kinds) {
      const ydoc = docWithBlock();
      const unbound: string[] = [];
      const binding = bind(ydoc, () => unbound.push("unbound"));
      expect(binding.refused, what).toBe(false);

      plant(ydoc);

      expect(unbound, what).toEqual(["unbound"]);
      intact(ydoc);
      expect(findForeignBlocks(getBlocksFragment(ydoc)), what).toHaveLength(1);
      binding.destroy();
    }
  });

  /**
   * The quiet variant, and the reason the delta scan checks `insert` as well as
   * `attributes`. An embed throws nothing while binding: y-prosemirror's
   * `createTextNodesFromYText` only ever calls `schema.text(insert, marks)`, so
   * a non-string insert simply never reaches the editor state — and the next
   * keystroke writes the block's text back to the Y.XmlText without it. Silent
   * loss on a later mutation, which is why the gate has to refuse up front.
   */
  it("names an embed as the silent kind, and binds through the mark it declares", () => {
    // The embed is the one kind that throws NOTHING while binding, so it is
    // named separately: without the delta scan reporting it the gate would open
    // and the loss would happen on the next keystroke instead.
    const ydoc = docWithBlock();
    firstBlockText(ydoc).insertEmbed(1, { future: "keep-me" });
    const foreign = findForeignBlocks(getBlocksFragment(ydoc));
    expect(foreign).toHaveLength(1);
    expect(foreign[0]?.nodeName).toBe("#embed");
    expect(embedsOf(firstBlockText(ydoc))).toEqual([{ future: "keep-me" }]);

    // The other side of the same scan: the comment mark and the inline marks ARE
    // declared on a paragraph, so a text carrying them is not foreign and the
    // editor binds.
    const annotated = docWithBlock();
    firstBlockText(annotated).format(0, 3, {
      [COMMENT_MARK]: { threadId: "t1" },
      bold: {},
      link: { href: "https://example.com" },
    });
    expect(findForeignBlocks(getBlocksFragment(annotated))).toEqual([]);
    const binding = bind(annotated);
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

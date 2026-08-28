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
  PROSE_BLOCK_TYPES,
  appendBlock,
  getBlockInline,
  getBlocks,
  getBlocksFragment,
  initDoc,
} from "@uberblick/schema";
import { uberblickSchema } from "../src/editor/create-editor.js";
import { bindGuardedEditor } from "../src/editor/guarded-binding.js";
import type { GuardedBinding } from "../src/editor/guarded-binding.js";
import {
  BLOCK_NODE_NAMES,
  LINK_CONFLICT,
  describeForeignBlocks,
  findForeignBlocks,
} from "../src/editor/palette.js";
import { plainText } from "../src/editor/ytext.js";
import { mountEditor } from "./helpers.js";

describe("the palette is exactly the schema's block types", () => {
  it("declares the schema's block nodes, seven marks, and nothing else", () => {
    expect(Object.keys(uberblickSchema.nodes).sort()).toEqual([
      "code",
      "doc",
      "heading",
      "list-item",
      "mermaid",
      "paragraph",
      "quote",
      "table",
      "text",
    ]);
    expect(BLOCK_NODE_NAMES).toEqual([
      "paragraph",
      "heading",
      "code",
      "mermaid",
      "list-item",
      "quote",
      "table",
    ]);
    // The closed mark set: the schema package's six inline marks, plus the
    // annotation anchor.
    expect(Object.keys(uberblickSchema.marks).sort()).toEqual(
      [...INLINE_MARKS, COMMENT_MARK].sort(),
    );

    // Stated the other way round, because a node or mark that quietly exists is
    // one the editor could normalise foreign content into. The list and table
    // nodes are the pointed ones: a list here is a *run of blocks* and a table
    // is *source text* (#59), so the wrapper-and-tree spellings stock Tiptap
    // ships — including the cell nodes its table extension brings — must not
    // exist here.
    for (const absent of [
      "bulletList",
      "orderedList",
      "listItem",
      "blockquote",
      "codeBlock",
      "horizontalRule",
      "hardBreak",
      "image",
      "tableRow",
      "tableCell",
      "tableHeader",
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
    for (const name of BLOCK_NODE_NAMES) {
      const type = uberblickSchema.nodes[name];
      expect(type).toBeDefined();
      expect(type?.allowsMarkType(uberblickSchema.marks[COMMENT_MARK]!)).toBe(true);
    }

    // Inline marks are prose only: a source block's text is source. The split is
    // prose vs source, which is why a list item and a quote take the whole set.
    for (const mark of INLINE_MARKS) {
      const type = uberblickSchema.marks[mark]!;
      for (const prose of PROSE_BLOCK_TYPES) {
        expect(uberblickSchema.nodes[prose]?.allowsMarkType(type), mark).toBe(true);
      }
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

    // The two link marks name their exclusions explicitly, which is why the
    // rule above is the pointed one for them: `excludes` *replaces* the
    // self-exclusion default, so naming the other mark without naming itself
    // would have cost the bare key. They exclude each other both ways — one
    // range is a reference to one place.
    const link = uberblickSchema.marks.link!;
    const docLink = uberblickSchema.marks.docLink!;
    expect(link.excludes(docLink)).toBe(true);
    expect(docLink.excludes(link)).toBe(true);
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

  /**
   * The docLink half of the palette, end to end: a reference an agent wrote is
   * bindable (the gate opens), renders as marked text carrying its class, and
   * one whose target the schema package's reader rejects keeps the editor shut
   * — a web `Y.Text` write bypasses the model boundary, so the gate is where
   * the shape is checked. Input rules and navigation are #444's.
   */
  it("binds and renders a stored docLink, and refuses a malformed one", () => {
    const target = "0189abcd-2222-4333-8444-555566667777";
    const ydoc = new Y.Doc();
    initDoc(ydoc, { uuid: "doc-doclink", title: "References" });
    appendBlock(ydoc, {
      type: "paragraph",
      inline: [
        { text: "see ", marks: {} },
        { text: "the hub", marks: { docLink: target } },
      ],
    });
    expect(findForeignBlocks(getBlocksFragment(ydoc))).toEqual([]);

    const { editor } = mountEditor(ydoc);
    try {
      const html = editor.getHTML();
      expect(html).toContain("ub-doclink");
      expect(html).toContain(`data-doc-id="${target}"`);
      // Binding did not rewrite the document: the Yjs key is still the bare
      // mark name, with the attrs the schema package wrote.
      expect(getBlocks(ydoc)[0]?.text).toBe("see the hub");

      // The HTML door is a *write* door, so it canonicalizes where the reader
      // only checks the stored shape: an upper-cased uuid names the same
      // document, and dropping it would lose a reference the model accepts.
      editor.commands.insertContent(
        `<p><a data-doc-id="${target.toUpperCase()}">also the hub</a></p>`,
      );
      expect(editor.getHTML()).not.toContain(target.toUpperCase());
      expect(editor.getHTML()).toContain(`data-doc-id="${target}">also the hub`);
    } finally {
      editor.destroy();
    }

    const malformed = new Y.Doc();
    initDoc(malformed, { uuid: "doc-doclink-bad", title: "Not a reference" });
    appendBlock(malformed, { type: "paragraph", text: "see the hub" });
    const block = getBlocksFragment(malformed).get(0) as Y.XmlElement;
    (block.firstChild as Y.XmlText).format(4, 7, { docLink: { docId: "nope" } });
    expect(findForeignBlocks(getBlocksFragment(malformed))[0]?.nodeName).toBe(
      "#mark:docLink",
    );

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

  /**
   * The precedence half of the gate, and the only case a *legitimate* merge can
   * produce: two replicas format one range as different kinds of link, and the
   * CRDT keeps both keys. The schema package reads that as the docLink alone
   * (its two-replica test pins the rule); y-prosemirror would bind both, since
   * it builds a mark per attribute and never asks ProseMirror's `excludes` —
   * rendering an external anchor wrapped around a document anchor, which is the
   * document meaning two things at once. So the gate refuses, and both marks
   * stay in the CRDT for a writer to resolve.
   */
  it("refuses a range a merge left carrying both link marks", () => {
    const target = "0189abcd-2222-4333-8444-555566667777";
    const a = new Y.Doc();
    initDoc(a, { uuid: "doc-merged-links", title: "Both at once" });
    appendBlock(a, { type: "paragraph", text: "see the hub" });
    const b = new Y.Doc();
    Y.applyUpdate(b, Y.encodeStateAsUpdate(a));

    const textOf = (ydoc: Y.Doc): Y.XmlText =>
      (getBlocksFragment(ydoc).get(0) as Y.XmlElement).firstChild as Y.XmlText;
    textOf(a).format(0, 7, {
      link: { href: "https://example.com/hub" },
      docLink: null,
    });
    textOf(b).format(0, 7, { docLink: { docId: target }, link: null });
    Y.applyUpdate(a, Y.encodeStateAsUpdate(b));
    Y.applyUpdate(b, Y.encodeStateAsUpdate(a));

    const foreign = findForeignBlocks(getBlocksFragment(a));
    expect(foreign.map((block) => block.nodeName)).toEqual([LINK_CONFLICT]);

    // The reason is its own, and so is what the reader is told: `link` is a
    // supported mark, so calling this an unsupported type would name the wrong
    // thing and leave nobody anything to do about it.
    const said = describeForeignBlocks(foreign);
    expect(said).not.toMatch(/unsupported type/i);
    expect(said).toContain("conflicting external and document links");
    expect(said).toContain("MCP tools");

    const element = document.createElement("div");
    document.body.appendChild(element);
    const binding = bindGuardedEditor({
      element,
      fragment: getBlocksFragment(a),
      awareness: null,
    });
    expect(binding.refused).toBe(true);

    // Nothing was dropped, and the schema package still reads the range the way
    // it always did — one docLink, on both replicas.
    expect((textOf(a).toDelta() as Array<{ attributes?: unknown }>)[0]?.attributes)
      .toEqual({
        link: { href: "https://example.com/hub" },
        docLink: { docId: target },
      });
    expect(getBlockInline(a, getBlocks(a)[0]?.id ?? "")).toEqual([
      { text: "see the", marks: { docLink: target } },
      { text: " hub", marks: {} },
    ]);
    expect(getBlockInline(b, getBlocks(b)[0]?.id ?? "")).toEqual(
      getBlockInline(a, getBlocks(a)[0]?.id ?? ""),
    );
    binding.destroy();
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

    // And so is a mark whose *value* the schema package's reader does not read as
    // that mark. y-prosemirror asks no such question — it builds a mark from any
    // attrs it is handed — so binding one of these would make the document mean
    // two things at once: unmarked to every reader, marked in the editor, and
    // rewritten as the real thing on the next keystroke.
    const unreadable: Array<[string, unknown]> = [
      // A link is external URLs only, and this one would reach an `<a href>`.
      ["link", { href: "javascript:alert(1)" }],
      ["link", { href: "mailto:a@b.com" }],
      ["link", { href: "./other.md" }],
      ["link", {}],
      // A flag is `true` or an attrs object. These read as unmarked.
      ["bold", false],
      ["italic", 0],
      ["strike", "yes"],
      // …and an anchor with no thread is not an anchor.
      [COMMENT_MARK, { threadId: "" }],
      [COMMENT_MARK, true],
    ];
    for (const [mark, value] of unreadable) {
      const written = docWithBlock();
      firstBlockText(written).format(0, 3, { [mark]: value });
      const label = `${mark}=${JSON.stringify(value)}`;
      expect(findForeignBlocks(getBlocksFragment(written)), label).toEqual([
        expect.objectContaining({ nodeName: `#mark:${mark}` }),
      ]);
      expect(bind(written).refused, label).toBe(true);
    }

    // The values the reader *does* read bind, or the gate would never open.
    for (const [mark, value] of [
      ["bold", {}],
      ["italic", true],
      ["link", { href: "https://example.com" }],
      [COMMENT_MARK, { threadId: "t1" }],
    ] as Array<[string, unknown]>) {
      const written = docWithBlock();
      firstBlockText(written).format(0, 3, { [mark]: value });
      const label = `${mark}=${JSON.stringify(value)}`;
      expect(findForeignBlocks(getBlocksFragment(written)), label).toEqual([]);
    }
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

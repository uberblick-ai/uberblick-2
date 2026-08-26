import { describe, expect, it } from "vitest";
import * as Y from "yjs";
import type { Block } from "../src/index.js";
import {
  BLOCKS_KEY,
  BlockNotFoundError,
  appendBlock,
  blockRev,
  deleteBlock,
  getBlock,
  getBlockText,
  getBlocks,
  getMeta,
  initDoc,
  insertBlock,
  setBlockLanguage,
  setBlockLevel,
  setDescription,
  setLinks,
  setTags,
  setTitle,
} from "../src/index.js";

const UUID = "11111111-1111-4111-8111-111111111111";

/** Expected block, with the rev the reader should have computed for it. */
function withRev(block: Omit<Block, "rev">): Block {
  const { type, text, level, language, list, indent } = block;
  return {
    ...block,
    rev: blockRev({ type, text, level, language, list, indent }),
  };
}

function seeded(): Y.Doc {
  const doc = new Y.Doc();
  initDoc(doc, { uuid: UUID, title: "Block model", tags: ["schema"] });
  return doc;
}

describe("document round-trip", () => {
  it("initialises metadata and materialises the three roots", () => {
    const doc = seeded();
    expect(getMeta(doc)).toEqual({
      uuid: UUID,
      title: "Block model",
      tags: ["schema"],
      description: null,
      links: [],
    });
    expect(doc.share.has("meta")).toBe(true);
    expect(doc.share.has(BLOCKS_KEY)).toBe(true);
    expect(doc.share.has("annotations")).toBe(true);
  });

  it("updates title, tags and links independently", () => {
    const doc = seeded();
    setTitle(doc, "Block model, revised");
    setTags(doc, ["schema", "keystone"]);
    const target = "22222222-2222-4222-8222-222222222222";
    setLinks(doc, [target]);
    expect(getMeta(doc)).toEqual({
      uuid: UUID,
      title: "Block model, revised",
      tags: ["schema", "keystone"],
      description: null,
      links: [target],
    });
  });

  it("carries a description, and reads absent and blank as the same null", () => {
    const doc = new Y.Doc();
    initDoc(doc, { uuid: UUID, title: "Described" });
    // Nobody has said what this is for. That is one fact, with one shape.
    expect(getMeta(doc).description).toBeNull();

    setDescription(doc, "What this document is for, in a sentence.");
    expect(getMeta(doc).description).toBe(
      "What this document is for, in a sentence.",
    );

    // Re-initialising without one must not erase a description the document
    // has since acquired — the same rule `links` already has.
    initDoc(doc, { uuid: UUID, title: "Described" });
    expect(getMeta(doc).description).toBe(
      "What this document is for, in a sentence.",
    );

    setDescription(doc, "");
    expect(getMeta(doc).description).toBeNull();
  });

  it("defaults tags and links to empty arrays and keeps links across re-init", () => {
    const doc = new Y.Doc();
    initDoc(doc, { uuid: UUID, title: "Untagged" });
    setLinks(doc, ["33333333-3333-4333-8333-333333333333"]);
    initDoc(doc, { uuid: UUID, title: "Untagged" });
    const meta = getMeta(doc);
    expect(meta.tags).toEqual([]);
    expect(meta.links).toEqual(["33333333-3333-4333-8333-333333333333"]);
  });

  it("stores every block type and reads them back in order", () => {
    const doc = seeded();
    const h1 = appendBlock(doc, { type: "heading", text: "Overview", level: 1 });
    const p = appendBlock(doc, { type: "paragraph", text: "Blocks hold text." });
    const code = appendBlock(doc, {
      type: "code",
      text: 'const x: number = 1;\nconsole.log(x);',
      language: "ts",
    });
    const mermaid = appendBlock(doc, {
      type: "mermaid",
      text: "graph TD\n  A-->B",
    });

    expect(getBlocks(doc)).toEqual([
      withRev({ id: h1, type: "heading", text: "Overview", level: 1 }),
      withRev({ id: p, type: "paragraph", text: "Blocks hold text." }),
      withRev({
        id: code,
        type: "code",
        text: 'const x: number = 1;\nconsole.log(x);',
        language: "ts",
      }),
      withRev({ id: mermaid, type: "mermaid", text: "graph TD\n  A-->B" }),
    ]);
    expect(new Set([h1, p, code, mermaid]).size).toBe(4);
  });

  /**
   * A list is a *run* of blocks, not a tree: what makes two items one list is
   * that they are adjacent, and each carries its own marker and depth. So the
   * attributes have to survive a read the way a heading's level does, and the
   * indent has to be clamped to what the model holds rather than refused.
   */
  it("stores list items as flat blocks carrying their marker and depth", () => {
    const doc = seeded();
    const first = appendBlock(doc, { type: "list-item", text: "alpha" });
    const nested = appendBlock(doc, {
      type: "list-item",
      text: "beta",
      list: "ordered",
      indent: 2,
    });
    const deep = appendBlock(doc, { type: "list-item", indent: 9 });
    const quote = appendBlock(doc, { type: "quote", text: "said someone" });

    expect(getBlocks(doc)).toEqual([
      withRev({ id: first, type: "list-item", text: "alpha", list: "bullet", indent: 0 }),
      withRev({ id: nested, type: "list-item", text: "beta", list: "ordered", indent: 2 }),
      withRev({ id: deep, type: "list-item", text: "", list: "bullet", indent: 3 }),
      withRev({ id: quote, type: "quote", text: "said someone" }),
    ]);

    // The marker and the depth are part of the block's identity for an
    // optimistic write: an item that moved a level is not the item that was read.
    expect(getBlock(doc, first)?.rev).not.toBe(
      blockRev({ type: "list-item", text: "alpha", list: "bullet", indent: 1 }),
    );
    expect(getBlock(doc, first)?.rev).not.toBe(
      blockRev({ type: "list-item", text: "alpha", list: "ordered", indent: 0 }),
    );
  });

  it("inserts at the start, after a block, and at the end", () => {
    const doc = seeded();
    const first = appendBlock(doc, { type: "paragraph", text: "one" });
    const last = appendBlock(doc, { type: "paragraph", text: "three" });
    const middle = insertBlock(doc, first, { type: "paragraph", text: "two" });
    const start = insertBlock(doc, null, { type: "paragraph", text: "zero" });

    expect(getBlocks(doc).map((block) => block.text)).toEqual([
      "zero",
      "one",
      "two",
      "three",
    ]);
    expect(getBlocks(doc).map((block) => block.id)).toEqual([
      start,
      first,
      middle,
      last,
    ]);
  });

  it("defaults heading level to 1, clamps out-of-range levels, and defaults code language to empty", () => {
    const doc = seeded();
    const plain = appendBlock(doc, { type: "heading", text: "No level" });
    const deep = appendBlock(doc, {
      type: "heading",
      text: "Too deep",
      level: 9 as 6,
    });
    const code = appendBlock(doc, { type: "code", text: "echo hi" });

    expect(getBlock(doc, plain)?.level).toBe(1);
    expect(getBlock(doc, deep)?.level).toBe(6);
    expect(getBlock(doc, code)).toEqual(
      withRev({ id: code, type: "code", text: "echo hi", language: "" }),
    );

    // Both attributes are also settable in place, without a re-type.
    setBlockLevel(doc, plain, 3);
    setBlockLanguage(doc, code, "python");
    expect(getBlock(doc, plain)?.level).toBe(3);
    expect(getBlock(doc, code)?.language).toBe("python");
  });

  it("deletes blocks and reports unknown ids", () => {
    const doc = seeded();
    const keep = appendBlock(doc, { type: "paragraph", text: "keep" });
    const drop = appendBlock(doc, { type: "paragraph", text: "drop" });
    deleteBlock(doc, drop);

    expect(getBlocks(doc).map((block) => block.id)).toEqual([keep]);
    expect(getBlock(doc, drop)).toBeNull();
    expect(() => deleteBlock(doc, drop)).toThrow(BlockNotFoundError);
    expect(() => getBlockText(doc, drop)).toThrow(BlockNotFoundError);
    expect(() => insertBlock(doc, drop, { type: "paragraph" })).toThrow(
      BlockNotFoundError,
    );
  });

});

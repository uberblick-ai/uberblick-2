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
  setLinks,
  setTags,
  setTitle,
} from "../src/index.js";

const UUID = "11111111-1111-4111-8111-111111111111";

/** Expected block, with the rev the reader should have computed for it. */
function withRev(block: Omit<Block, "rev">): Block {
  const { type, text, level, language } = block;
  return { ...block, rev: blockRev({ type, text, level, language }) };
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
      links: [target],
    });
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

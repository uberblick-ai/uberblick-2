/**
 * `setBlockType` is the only sanctioned way to change a block's type: it keeps
 * the block id and replays the text delta, so inbound references and annotation
 * anchors both survive. These tests pin that.
 */

import { describe, expect, it } from "vitest";
import * as Y from "yjs";
import {
  BlockNotFoundError,
  appendBlock,
  createAnnotation,
  editBlock,
  exportMarkdown,
  getBlock,
  getBlockText,
  getBlocks,
  initDoc,
  resolveAnnotationRange,
  setBlockType,
} from "../src/index.js";
import { replicaPair, syncDocs } from "./helpers.js";

const UUID = "99999999-9999-4999-8999-999999999999";

function seeded(): Y.Doc {
  const doc = new Y.Doc();
  initDoc(doc, { uuid: UUID, title: "Re-types" });
  return doc;
}

describe("setBlockType", () => {
  it("keeps the block id, the text and the position", () => {
    const doc = seeded();
    const first = appendBlock(doc, { type: "paragraph", text: "before" });
    const target = appendBlock(doc, {
      type: "paragraph",
      text: "def f():\n    return 1",
    });
    const last = appendBlock(doc, { type: "paragraph", text: "after" });

    setBlockType(doc, target, "code", { language: "python" });

    expect(getBlocks(doc).map((block) => block.id)).toEqual([
      first,
      target,
      last,
    ]);
    expect(getBlock(doc, target)).toMatchObject({
      id: target,
      type: "code",
      text: "def f():\n    return 1",
      language: "python",
    });
  });

  it("carries type attributes over where they still apply", () => {
    const doc = seeded();
    const heading = appendBlock(doc, {
      type: "heading",
      text: "Section",
      level: 4,
    });

    // heading → paragraph drops the level, paragraph → heading defaults it…
    setBlockType(doc, heading, "paragraph");
    expect(getBlock(doc, heading)?.level).toBeUndefined();
    setBlockType(doc, heading, "heading");
    expect(getBlock(doc, heading)?.level).toBe(1);

    // …while a heading → heading re-type keeps the level it had.
    setBlockType(doc, heading, "heading", { level: 3 });
    setBlockType(doc, heading, "heading");
    expect(getBlock(doc, heading)?.level).toBe(3);

    const code = appendBlock(doc, { type: "code", text: "x", language: "ts" });
    setBlockType(doc, code, "code");
    expect(getBlock(doc, code)?.language).toBe("ts");
    setBlockType(doc, code, "mermaid");
    expect(getBlock(doc, code)?.language).toBeUndefined();
    setBlockType(doc, code, "code");
    expect(getBlock(doc, code)?.language).toBe("");
  });

  it("re-types every pair of block types without touching the text", () => {
    const types = ["paragraph", "heading", "code", "mermaid"] as const;
    for (const from of types) {
      for (const to of types) {
        const doc = seeded();
        const id = appendBlock(doc, { type: from, text: "graph TD\n  A-->B" });
        setBlockType(doc, id, to);
        expect(getBlock(doc, id)?.type).toBe(to);
        expect(getBlockText(doc, id)).toBe("graph TD\n  A-->B");
      }
    }
  });

  it("preserves an empty block's text child", () => {
    const doc = seeded();
    const id = appendBlock(doc, { type: "paragraph" });
    setBlockType(doc, id, "heading", { level: 2 });
    expect(getBlockText(doc, id)).toBe("");
    // The re-typed block still takes edits.
    editBlock(doc, id, "", "Now a heading");
    expect(getBlockText(doc, id)).toBe("Now a heading");
  });

  it("keeps annotation anchors, which a delete-and-reinsert re-type would orphan", () => {
    const doc = seeded();
    const id = appendBlock(doc, {
      type: "paragraph",
      text: "Hello brave world",
    });
    const thread = createAnnotation(doc, id, 6, 11, "reviewer", "hm");

    setBlockType(doc, id, "heading", { level: 2 });

    const range = resolveAnnotationRange(doc, thread.id);
    expect(range).toEqual({ start: 6, end: 11, collapsed: false });
    expect(getAnnotatedText(doc, id, thread.id)).toBe("brave");
    expect(exportMarkdown(doc, { frontmatter: false })).toBe(
      "## Hello brave world\n",
    );
  });

  it("reports an unknown block", () => {
    const doc = seeded();
    expect(() => setBlockType(doc, "nope", "code")).toThrow(BlockNotFoundError);
  });

  it("converges with a concurrent edit to the same block", () => {
    let id = "";
    const [a, b] = replicaPair((doc) => {
      initDoc(doc, { uuid: UUID, title: "Re-types" });
      id = appendBlock(doc, { type: "paragraph", text: "shared text" });
    });

    // A re-types the block; B, unaware, edits its text.
    setBlockType(a, id, "heading", { level: 2 });
    editBlock(b, id, "shared text", "shared text, edited");
    syncDocs(a, b);

    // The re-type replaces the element, so B's edit to the old element is not
    // carried into the new one: the re-typed block wins, deterministically and
    // identically on both replicas. Documented, not accidental — a re-type is a
    // structural change, and `rev`/`old_text` is what protects a caller that
    // cares.
    expect(getBlocks(a)).toEqual(getBlocks(b));
    expect(getBlocks(a)).toHaveLength(1);
    expect(getBlock(a, id)?.type).toBe("heading");
    expect(getBlock(a, id)?.id).toBe(id);
  });

  it("converges when both replicas re-type the same block", () => {
    let id = "";
    const [a, b] = replicaPair((doc) => {
      initDoc(doc, { uuid: UUID, title: "Re-types" });
      id = appendBlock(doc, { type: "paragraph", text: "shared text" });
    });

    setBlockType(a, id, "heading", { level: 2 });
    setBlockType(b, id, "code", { language: "ts" });
    syncDocs(a, b);

    // Known limitation, pinned here so it cannot regress unnoticed: a re-type
    // inserts a replacement element, so two concurrent re-types of one block
    // leave TWO elements carrying that block id, each with the full text. Both
    // replicas converge on the same pair in the same order, and `getBlock`
    // resolves the first one deterministically — so consumers keyed by block id
    // stay consistent — but the document is left with a duplicate id until
    // someone deletes one. Concurrent re-types of the same block are rare;
    // making them idempotent needs a tie-break the schema does not have yet.
    const blocksA = getBlocks(a);
    expect(blocksA).toEqual(getBlocks(b));
    expect(blocksA).toHaveLength(2);
    expect(blocksA.map((block) => block.id)).toEqual([id, id]);
    expect(blocksA.map((block) => block.text)).toEqual([
      "shared text",
      "shared text",
    ]);
    expect(getBlock(a, id)).toEqual(blocksA[0]);
    expect(getBlockText(a, id)).toBe("shared text");
  });
});

function getAnnotatedText(
  doc: Y.Doc,
  blockId: string,
  threadId: string,
): string | null {
  const range = resolveAnnotationRange(doc, threadId);
  if (range === null) return null;
  return getBlockText(doc, blockId).slice(range.start, range.end);
}

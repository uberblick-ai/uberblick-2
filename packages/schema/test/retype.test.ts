/**
 * `setBlockType` is the only sanctioned way to change a block's type: it keeps
 * the block id and replays the text delta, so inbound references and annotation
 * anchors both survive. These tests pin that.
 */

import { describe, expect, it } from "vitest";
import * as Y from "yjs";
import {
  BlockNotFoundError,
  COMMENT_MARK,
  appendBlock,
  createAnnotation,
  deleteBlock,
  editBlock,
  exportMarkdown,
  getBlock,
  getBlockRev,
  getBlockText,
  getBlocks,
  getBlocksFragment,
  initDoc,
  repairDuplicateBlocks,
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

/** The raw element names in the blocks fragment, duplicates included. */
function fragmentTypes(doc: Y.Doc): string[] {
  return getBlocksFragment(doc)
    .toArray()
    .map((child) => (child as Y.XmlElement).nodeName);
}

/**
 * Two replicas that re-typed the same block concurrently and then synced: the
 * state where one block id is carried by two elements.
 */
function duplicated(): { a: Y.Doc; b: Y.Doc; id: string } {
  let id = "";
  const [a, b] = replicaPair((doc) => {
    initDoc(doc, { uuid: UUID, title: "Re-types" });
    id = appendBlock(doc, { type: "paragraph", text: "shared text" });
  });
  setBlockType(a, id, "heading", { level: 2 });
  setBlockType(b, id, "code", { language: "ts" });
  syncDocs(a, b);
  return { a, b, id };
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

    expect(() => setBlockType(doc, "nope", "code")).toThrow(BlockNotFoundError);
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

    // A list item's marker and depth behave the same way: kept across a
    // list-item → list-item re-type, dropped when it stops being one, and back
    // to the defaults when it becomes one again.
    const item = appendBlock(doc, {
      type: "list-item",
      text: "point",
      list: "ordered",
      indent: 2,
    });
    setBlockType(doc, item, "list-item");
    expect(getBlock(doc, item)).toMatchObject({ list: "ordered", indent: 2 });
    setBlockType(doc, item, "quote");
    expect(getBlock(doc, item)?.list).toBeUndefined();
    setBlockType(doc, item, "list-item");
    expect(getBlock(doc, item)).toMatchObject({ list: "bullet", indent: 0 });
  });

  it("re-types every pair of block types without touching the text", () => {
    const types = [
      "paragraph",
      "heading",
      "code",
      "mermaid",
      "list-item",
      "quote",
    ] as const;
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

  // The canonical annotation-survives-a-re-type test. It asserts the anchor at
  // every level a caller can see it — the raw comment mark Yjs holds, the
  // resolved range, the covered text, the export — and that the mark keeps
  // tracking edits afterwards, so no other package needs its own copy.
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
    // The mark itself came through the re-type, not just a range that happens
    // to line up.
    expect(commentDelta(doc, id)).toEqual([
      ["Hello ", null],
      ["brave", { [COMMENT_MARK]: { threadId: thread.id } }],
      [" world", null],
    ]);
    expect(exportMarkdown(doc, { frontmatter: false })).toBe(
      "## Hello brave world\n",
    );

    // …and the re-typed block's mark still moves with the text.
    editBlock(doc, id, "Hello brave world", "Say: Hello brave world");
    expect(getAnnotatedText(doc, id, thread.id)).toBe("brave");
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

  it("converges when both replicas re-type the same block, with reads showing one block", () => {
    const { a, b, id } = duplicated();

    // A re-type inserts a replacement element (Yjs element names are
    // immutable), so two concurrent re-types of one block leave TWO elements
    // carrying that block id — in the same order on both replicas.
    expect(fragmentTypes(a)).toEqual(fragmentTypes(b));
    expect(fragmentTypes(a)).toHaveLength(2);

    // Reads shadow the later copy: exactly one block per id, and the same
    // winner — the document-order one — on every replica.
    const blocksA = getBlocks(a);
    expect(blocksA).toEqual(getBlocks(b));
    expect(blocksA.map((block) => block.id)).toEqual([id]);
    expect(blocksA[0]?.type).toBe(fragmentTypes(a)[0]);
    expect(blocksA[0]?.text).toBe("shared text");
    expect(getBlock(a, id)).toEqual(blocksA[0]);
    expect(getBlock(b, id)).toEqual(blocksA[0]);
    expect(getBlockText(b, id)).toBe("shared text");
    expect(getBlockRev(b, id)).toBe(getBlockRev(a, id));
  });

  it("repairs the duplicate to one element, idempotently and on either replica", () => {
    const { a, b, id } = duplicated();
    const winner = getBlock(a, id);

    // Each replica repairs on its own, before hearing about the other's repair:
    // both delete the element reads already ignored, so the two deletions are
    // the same deletion and the merge is a single surviving element.
    expect(repairDuplicateBlocks(a)).toBe(1);
    expect(repairDuplicateBlocks(b)).toBe(1);
    // Idempotent: a second pass finds nothing and writes nothing.
    const quiet = Y.encodeStateVector(a);
    expect(repairDuplicateBlocks(a)).toBe(0);
    expect(Y.encodeStateVector(a)).toEqual(quiet);

    syncDocs(a, b);

    expect(fragmentTypes(a)).toEqual(fragmentTypes(b));
    expect(fragmentTypes(a)).toHaveLength(1);
    expect(getBlock(a, id)).toEqual(winner);
    expect(getBlocks(b)).toEqual(getBlocks(a));
  });

  it("never shadows or repairs id-less foreign content", () => {
    const doc = seeded();
    const mine = appendBlock(doc, { type: "paragraph", text: "mine" });
    doc.transact(() => {
      const fragment = getBlocksFragment(doc);
      for (const [name, text] of [
        ["future-a", "alpha"],
        ["future-b", "beta"],
      ] as const) {
        const element = new Y.XmlElement(name);
        element.insert(0, [new Y.XmlText(text)]);
        fragment.insert(fragment.length, [element]);
      }
    });

    // Two elements with no id are not two copies of one block: an absent id has
    // claimed no identity. Both stay visible and the repair leaves them alone —
    // unknown content degrades loudly, it is never silently dropped.
    expect(getBlocks(doc).map((block) => block.text)).toEqual([
      "mine",
      "alpha",
      "beta",
    ]);
    expect(repairDuplicateBlocks(doc)).toBe(0);
    expect(fragmentTypes(doc)).toEqual(["paragraph", "future-a", "future-b"]);
    expect(getBlock(doc, mine)?.text).toBe("mine");
  });

  it("deletes every copy of a duplicated block, so it cannot come back", () => {
    const { a, id } = duplicated();

    deleteBlock(a, id);

    expect(getBlock(a, id)).toBeNull();
    expect(fragmentTypes(a)).toEqual([]);
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

/** The raw formatting attributes Yjs holds, to prove the anchor is a mark. */
function commentDelta(doc: Y.Doc, blockId: string): Array<[string, unknown]> {
  const element = getBlocksFragment(doc)
    .toArray()
    .find((child) => {
      return (
        child instanceof Y.XmlElement && child.getAttribute("id") === blockId
      );
    }) as Y.XmlElement;
  const text = element.firstChild as Y.XmlText;
  return (
    text.toDelta() as Array<{ insert: string; attributes?: unknown }>
  ).map((op) => [op.insert, op.attributes ?? null]);
}

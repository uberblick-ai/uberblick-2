/**
 * Two replicas that retype one block concurrently leave two elements carrying
 * its id. Reads shadow the later copy and the repair deletes it; these tests
 * pin both.
 */

import { describe, expect, it } from "vitest";
import * as Y from "yjs";
import {
  appendBlock,
  deleteBlock,
  getBlock,
  getBlockRev,
  getBlocks,
  getBlocksFragment,
  initDoc,
  repairDuplicateBlocks,
} from "../src/index.js";
import { replicaPair, retype, syncDocs } from "./helpers.js";

const UUID = "99999999-9999-4999-8999-999999999999";

/** The raw element names in the blocks fragment, duplicates included. */
function fragmentTypes(doc: Y.Doc): string[] {
  return getBlocksFragment(doc)
    .toArray()
    .map((child) => (child as Y.XmlElement).nodeName);
}

/** Both replicas retyped the same block, then synced. */
function duplicated(): { a: Y.Doc; b: Y.Doc; id: string } {
  let id = "";
  const [a, b] = replicaPair((doc) => {
    initDoc(doc, { uuid: UUID, title: "Duplicates" });
    id = appendBlock(doc, { type: "paragraph", text: "shared text" });
  });
  retype(a, id, "heading");
  retype(b, id, "code");
  syncDocs(a, b);
  return { a, b, id };
}

describe("same-id duplicate blocks", () => {
  it("read as one block, the same document-order winner on every replica", () => {
    const { a, b, id } = duplicated();

    expect(fragmentTypes(a)).toEqual(fragmentTypes(b));
    expect(fragmentTypes(a)).toHaveLength(2);

    const blocksA = getBlocks(a);
    expect(blocksA).toEqual(getBlocks(b));
    expect(blocksA.map((block) => block.id)).toEqual([id]);
    expect(blocksA[0]?.type).toBe(fragmentTypes(a)[0]);
    expect(blocksA[0]?.text).toBe("shared text");
    expect(getBlock(a, id)).toEqual(blocksA[0]);
    expect(getBlock(b, id)).toEqual(blocksA[0]);
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
    const doc = new Y.Doc();
    initDoc(doc, { uuid: UUID, title: "Duplicates" });
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

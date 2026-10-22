import * as Y from "yjs";
import { describe, expect, it } from "vitest";
import {
  appendBlock,
  createAnnotation,
  findBlockElement,
  getAnnotation,
  getBlock,
  getBlocks,
  getBlocksFragment,
  initDoc,
  moveBlocks,
  repairDuplicateBlocks,
  resolveAnnotationRange,
} from "../src/index.js";
import { replicaPair, syncDocs } from "./helpers.js";

const UUID = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";

function fixture(): { doc: Y.Doc; ids: string[] } {
  const doc = new Y.Doc();
  initDoc(doc, { uuid: UUID, title: "Moves" });
  const ids = ["Alpha", "Bravo", "Charlie", "Delta", "Echo"].map((text) =>
    appendBlock(doc, { type: "paragraph", text }),
  );
  return { doc, ids };
}

describe("block moves", () => {
  it("groups non-adjacent blocks in the requested order after a surviving target", () => {
    const { doc, ids } = fixture();
    const before = new Map(getBlocks(doc).map((block) => [block.id, block]));
    const peer = new Y.Doc();
    Y.applyUpdate(peer, Y.encodeStateAsUpdate(doc));
    let updates = 0;
    let peerUpdates = 0;
    doc.on("update", (update: Uint8Array) => {
      updates += 1;
      Y.applyUpdate(peer, update);
    });
    peer.on("update", () => { peerUpdates += 1; });

    expect(moveBlocks(doc, [ids[2]!, ids[0]!], ids[3]!)).toBe(true);

    expect(getBlocks(doc).map((block) => block.id)).toEqual([ids[1], ids[3], ids[2], ids[0], ids[4]]);
    for (const id of ids) expect(getBlock(doc, id)).toEqual(before.get(id));
    expect(getBlocks(peer)).toEqual(getBlocks(doc));
    expect(updates).toBe(1);
    expect(peerUpdates).toBe(1);
    expect(getBlocksFragment(peer).length).toBe(ids.length);
    doc.destroy();
    peer.destroy();
  });

  it.each([undefined, null])("moves to the top with destination %s", (destination) => {
    const { doc, ids } = fixture();
    moveBlocks(doc, [ids[4]!, ids[1]!], destination);
    expect(getBlocks(doc).map((block) => block.id)).toEqual([ids[4], ids[1], ids[0], ids[2], ids[3]]);
    doc.destroy();
  });

  it("keeps existing elements and writes no update when the requested order already holds", () => {
    const { doc, ids } = fixture();
    const elements = getBlocksFragment(doc).toArray();
    const before = Y.encodeStateAsUpdate(doc);
    let updates = 0;
    doc.on("update", () => { updates += 1; });
    expect(moveBlocks(doc, [ids[1]!, ids[2]!], ids[0]!)).toBe(false);
    expect(moveBlocks(doc, [ids[0]!, ids[1]!])).toBe(false);
    expect(getBlocksFragment(doc).toArray()).toEqual(elements);
    expect(Y.encodeStateAsUpdate(doc)).toEqual(before);
    expect(updates).toBe(0);
    doc.destroy();
  });

  it("refuses invalid selections and destinations without changing any bytes", () => {
    const { doc, ids } = fixture();
    const before = Y.encodeStateAsUpdate(doc);
    let updates = 0;
    doc.on("update", () => { updates += 1; });
    const failures = [
      { selected: [], target: null, code: "empty_block_ids", details: {} },
      { selected: [ids[0]!, "absent"], target: null, code: "block_not_found", details: { blockId: "absent" } },
      { selected: [ids[0]!, ids[0]!], target: null, code: "duplicate_block_id", details: { blockId: ids[0] } },
      { selected: [ids[0]!], target: "absent", code: "block_not_found", details: { blockId: "absent" } },
      { selected: [ids[0]!, ids[1]!], target: ids[1]!, code: "move_target_in_selection", details: { blockId: ids[1] } },
    ];
    for (const failure of failures) {
      expect(() => moveBlocks(doc, failure.selected, failure.target)).toThrowError(expect.objectContaining({
        code: failure.code, details: failure.details,
      }));
      expect(Y.encodeStateAsUpdate(doc)).toEqual(before);
    }
    expect(updates).toBe(0);
    doc.destroy();
  });

  it("removes every original copy and moves the visible winner", () => {
    const { doc, ids } = fixture();
    const original = findBlockElement(doc, ids[0]!)!;
    const shadow = original.clone();
    getBlocksFragment(doc).insert(2, [shadow]);
    (shadow.firstChild as Y.XmlText).insert(0, "Shadow ");
    const before = getBlock(doc, ids[0]!);

    moveBlocks(doc, [ids[0]!], ids[4]!);

    expect(getBlock(doc, ids[0]!)).toEqual(before);
    expect(getBlocks(doc).map((block) => block.id)).toEqual([...ids.slice(1), ids[0]]);
    expect(getBlocksFragment(doc).toArray().filter((node) =>
      node instanceof Y.XmlElement && node.getAttribute("id") === ids[0],
    )).toHaveLength(1);
    expect(repairDuplicateBlocks(doc)).toBe(0);
    doc.destroy();
  });

  it("converges concurrent same-id moves through the existing duplicate repair", () => {
    let ids: string[] = [];
    const [a, b] = replicaPair((doc) => {
      initDoc(doc, { uuid: UUID, title: "Concurrent moves" });
      ids = ["A", "B", "C", "D"].map((text) => appendBlock(doc, { type: "paragraph", text }));
    });
    moveBlocks(a, [ids[1]!], ids[3]!);
    moveBlocks(b, [ids[1]!], null);
    syncDocs(a, b);
    expect(getBlocks(a)).toEqual(getBlocks(b));
    expect(getBlocks(a).filter((block) => block.id === ids[1])).toHaveLength(1);
    expect(repairDuplicateBlocks(a)).toBe(1);
    expect(repairDuplicateBlocks(b)).toBe(1);
    syncDocs(a, b);
    expect(getBlocksFragment(a).length).toBe(ids.length);
    expect(getBlocksFragment(b).length).toBe(ids.length);
    expect(getBlocks(a)).toEqual(getBlocks(b));
    expect(getBlock(a, ids[1]!)?.text).toBe("B");
    a.destroy();
    b.destroy();
  });

  it("drops edits to the old copy from an offline peer but preserves its new orphaned thread", () => {
    const { doc: a, ids } = fixture();
    const b = new Y.Doc();
    Y.applyUpdate(b, Y.encodeStateAsUpdate(a));
    moveBlocks(a, [ids[0]!], ids[4]!);
    (findBlockElement(b, ids[0]!)!.firstChild as Y.XmlText).insert(0, "Offline ");
    const thread = createAnnotation(b, ids[0]!, 0, 7, "offline reader", "New comment");

    syncDocs(a, b);

    expect(getBlocks(a)).toEqual(getBlocks(b));
    expect(getBlock(a, ids[0]!)?.text).toBe("Alpha");
    expect(getAnnotation(a, thread.id)).toEqual(thread);
    expect(getAnnotation(b, thread.id)).toEqual(thread);
    expect(resolveAnnotationRange(a, thread.id)).toBeNull();
    expect(resolveAnnotationRange(b, thread.id)).toBeNull();
    a.destroy();
    b.destroy();
  });
});

/**
 * Two replicas, updates exchanged by hand. These tests are the reason the block
 * model exists: they pin the merge behaviour of concurrent human+agent editing.
 */

import { describe, expect, it } from "vitest";
import * as Y from "yjs";
import {
  BlockNotFoundError,
  StaleBlockError,
  appendBlock,
  createAnnotation,
  deleteBlock,
  editBlock,
  getBlock,
  getBlockRev,
  getBlockText,
  getBlocks,
  getBlocksFragment,
  initDoc,
  insertBlock,
  resolveAnnotationRange,
  setBlockLevel,
} from "../src/index.js";
import { replicaPair, syncDocs } from "./helpers.js";

const UUID = "44444444-4444-4444-8444-444444444444";

function blockIdsOf(doc: Y.Doc): string[] {
  return getBlocks(doc).map((block) => block.id);
}

describe("editBlock: minimal splices", () => {
  it("survives a concurrent append at the end of the same block", () => {
    let blockId = "";
    const [a, b] = replicaPair((doc) => {
      initDoc(doc, { uuid: UUID, title: "Splices" });
      blockId = appendBlock(doc, { type: "paragraph", text: "abc" });
    });

    // A edits the middle; B, still unaware, appends at the end.
    editBlock(a, blockId, "abc", "abXc");
    editBlock(b, blockId, "abc", "abcd");
    syncDocs(a, b);

    expect(getBlockText(a, blockId)).toBe("abXcd");
    expect(getBlockText(b, blockId)).toBe("abXcd");
  });

  it("does not rewrite untouched characters", () => {
    const original = [
      "The block model is the keystone of uberblick: every other package",
      "imports it, and every agent edit is scoped to exactly one block, so a",
      "concurrent human edit in the same document never loses keystrokes.",
    ].join(" ");
    const changed = original.replace("keystone", "cornerstone");

    const spliced = new Y.Doc();
    initDoc(spliced, { uuid: UUID, title: "Splices" });
    const blockId = appendBlock(spliced, {
      type: "paragraph",
      text: original,
    });

    // An annotation on text *after* the edit is the sharpest probe of
    // minimality: a delete-all/reinsert would take its anchors down with it.
    const probeStart = original.indexOf("keystrokes");
    const thread = createAnnotation(
      spliced,
      blockId,
      probeStart,
      probeStart + "keystrokes".length,
      "probe",
      "here",
    );
    expect(resolveAnnotationRange(spliced, thread.id)?.collapsed).toBe(false);

    const beforeSplice = Y.encodeStateVector(spliced);
    editBlock(spliced, blockId, original, changed);
    const spliceUpdate = Y.encodeStateAsUpdate(spliced, beforeSplice);

    expect(getBlockText(spliced, blockId)).toBe(changed);
    const range = resolveAnnotationRange(spliced, thread.id);
    expect(range?.collapsed).toBe(false);
    expect(
      getBlockText(spliced, blockId).slice(range?.start, range?.end),
    ).toBe("keystrokes");

    // …and the update stays far smaller than the delete-all/reinsert an
    // unsophisticated implementation would produce.
    const naiveDoc = new Y.Doc();
    initDoc(naiveDoc, { uuid: UUID, title: "Splices" });
    const naiveId = appendBlock(naiveDoc, { type: "paragraph", text: original });
    const beforeNaive = Y.encodeStateVector(naiveDoc);
    naiveDoc.transact(() => {
      const element = getBlocksFragment(naiveDoc).get(0) as Y.XmlElement;
      const text = element.firstChild as Y.XmlText;
      text.delete(0, original.length);
      text.insert(0, changed);
    });
    const naiveUpdate = Y.encodeStateAsUpdate(naiveDoc, beforeNaive);

    expect(getBlockText(naiveDoc, naiveId)).toBe(changed);
    expect(spliceUpdate.byteLength).toBeLessThan(naiveUpdate.byteLength / 3);
  });

  it("is a no-op when newText equals the current text", () => {
    const doc = new Y.Doc();
    initDoc(doc, { uuid: UUID, title: "Splices" });
    const blockId = appendBlock(doc, { type: "paragraph", text: "steady" });
    const before = Y.encodeStateVector(doc);
    editBlock(doc, blockId, "steady", "steady");
    expect(Y.encodeStateAsUpdate(doc, before).byteLength).toBeLessThanOrEqual(3);
    expect(getBlockText(doc, blockId)).toBe("steady");
  });

  it("handles editing from and to the empty string", () => {
    const doc = new Y.Doc();
    initDoc(doc, { uuid: UUID, title: "Splices" });
    const blockId = appendBlock(doc, { type: "paragraph" });
    editBlock(doc, blockId, "", "now with content");
    expect(getBlockText(doc, blockId)).toBe("now with content");
    editBlock(doc, blockId, "now with content", "");
    expect(getBlockText(doc, blockId)).toBe("");
  });
});

describe("two clients, one block", () => {
  it("merges edits to different ranges and converges identically", () => {
    const original = "The quick brown fox jumps";
    let blockId = "";
    const [a, b] = replicaPair((doc) => {
      initDoc(doc, { uuid: UUID, title: "Same block" });
      blockId = appendBlock(doc, { type: "paragraph", text: original });
    });

    editBlock(a, blockId, original, "The slow brown fox jumps");
    editBlock(b, blockId, original, "The quick brown cat jumps");
    syncDocs(a, b);

    expect(getBlockText(a, blockId)).toBe("The slow brown cat jumps");
    expect(getBlockText(b, blockId)).toBe(getBlockText(a, blockId));
  });

  it("converges when both clients edit the same range (no lost characters, deterministic)", () => {
    const original = "one two three";
    let blockId = "";
    const [a, b] = replicaPair((doc) => {
      initDoc(doc, { uuid: UUID, title: "Same range" });
      blockId = appendBlock(doc, { type: "paragraph", text: original });
    });

    editBlock(a, blockId, original, "one TWO three");
    editBlock(b, blockId, original, "one 2 three");
    syncDocs(a, b);

    // Overlapping edits interleave rather than clobber; the point is that both
    // replicas agree, and that this is exactly the case a caller avoids by
    // passing a fresh oldText (see the stale-oldText test below).
    const merged = getBlockText(a, blockId);
    expect(getBlockText(b, blockId)).toBe(merged);
    expect(merged.startsWith("one ")).toBe(true);
    expect(merged.endsWith(" three")).toBe(true);
  });
});

describe("stale oldText", () => {
  it("fails safely with the current text and rev attached", () => {
    let blockId = "";
    const [a, b] = replicaPair((doc) => {
      initDoc(doc, { uuid: UUID, title: "Stale" });
      blockId = appendBlock(doc, { type: "paragraph", text: "original text" });
    });

    // A rewrites the block; B only learns about it when it syncs.
    editBlock(a, blockId, "original text", "rewritten text");
    syncDocs(a, b);

    let caught: unknown;
    try {
      // B is still holding the text it read before the sync.
      editBlock(b, blockId, "original text", "B's version");
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(StaleBlockError);
    const staleError = caught as StaleBlockError;
    expect(staleError.blockId).toBe(blockId);
    expect(staleError.expectedText).toBe("original text");
    expect(staleError.expectedRev).toBeUndefined();
    expect(staleError.currentText).toBe("rewritten text");
    expect(staleError.currentRev).toBe(getBlockRev(b, blockId));
    // Nothing was written: the failed edit left the block untouched.
    expect(getBlockText(b, blockId)).toBe("rewritten text");

    // The documented recovery: re-read, re-diff, retry — and the rev the error
    // handed back is accepted on the retry.
    const current = staleError.currentText;
    editBlock(b, blockId, current, `${current} plus B's addition`, {
      rev: staleError.currentRev,
    });
    syncDocs(a, b);
    expect(getBlockText(a, blockId)).toBe("rewritten text plus B's addition");
  });

  it("refuses an edit whose rev is stale even when the text still matches", () => {
    let blockId = "";
    const [a, b] = replicaPair((doc) => {
      initDoc(doc, { uuid: UUID, title: "Stale rev" });
      blockId = appendBlock(doc, { type: "heading", text: "Section", level: 2 });
    });

    const staleRev = getBlockRev(b, blockId);
    // A changes only an attribute — the text is untouched, so `oldText` alone
    // cannot detect it.
    setBlockLevel(a, blockId, 4);
    syncDocs(a, b);
    expect(getBlockText(b, blockId)).toBe("Section");

    let caught: unknown;
    try {
      editBlock(b, blockId, "Section", "Section, edited", { rev: staleRev });
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(StaleBlockError);
    const error = caught as StaleBlockError;
    expect(error.expectedRev).toBe(staleRev);
    expect(error.currentRev).toBe(getBlockRev(b, blockId));
    expect(error.currentText).toBe("Section");
    expect(getBlockText(b, blockId)).toBe("Section");

    // Without the rev assertion the same edit is accepted: rev is opt-in.
    editBlock(b, blockId, "Section", "Section, edited");
    expect(getBlockText(b, blockId)).toBe("Section, edited");

    // The other half of the contract: a MATCHING rev is accepted, the write
    // moves the rev on, and replaying the now-stale one is refused.
    const fresh = getBlockRev(b, blockId);
    editBlock(b, blockId, "Section, edited", "Section, edited twice", {
      rev: fresh,
    });
    expect(getBlockText(b, blockId)).toBe("Section, edited twice");
    expect(getBlockRev(b, blockId)).not.toBe(fresh);
    expect(() =>
      editBlock(b, blockId, "Section, edited twice", "again", { rev: fresh }),
    ).toThrow(StaleBlockError);
  });
});

describe("edit versus deletion", () => {
  it("lets the deletion win and reports the block as gone on both replicas", () => {
    let doomed = "";
    let survivor = "";
    const [a, b] = replicaPair((doc) => {
      initDoc(doc, { uuid: UUID, title: "Edit vs delete" });
      doomed = appendBlock(doc, { type: "paragraph", text: "delete me" });
      survivor = appendBlock(doc, { type: "paragraph", text: "keep me" });
    });

    // A removes the block; B, unaware, edits it.
    deleteBlock(a, doomed);
    editBlock(b, doomed, "delete me", "delete me, edited");
    expect(getBlockText(b, doomed)).toBe("delete me, edited");

    syncDocs(a, b);

    // Decision: block deletion beats in-block edits. The element and its text
    // are gone on both sides, and the edit is lost with them — Yjs deletes the
    // whole subtree, so there is nothing left to merge the characters into.
    expect(getBlock(a, doomed)).toBeNull();
    expect(getBlock(b, doomed)).toBeNull();
    expect(blockIdsOf(a)).toEqual([survivor]);
    expect(blockIdsOf(b)).toEqual([survivor]);

    // A later edit against the deleted block fails safely, on either replica.
    expect(() => editBlock(b, doomed, "delete me, edited", "again")).toThrow(
      BlockNotFoundError,
    );
    expect(() => editBlock(a, doomed, "delete me", "again")).toThrow(
      BlockNotFoundError,
    );
  });

  it("errors instead of no-op'ing when the block is deleted inside the same transaction", () => {
    const doc = new Y.Doc();
    initDoc(doc, { uuid: UUID, title: "Detached" });
    const blockId = appendBlock(doc, { type: "paragraph", text: "here" });

    // A caller's enclosing transaction can detach the element mid-flight. An
    // edit into a detached element would apply to nothing; it must report that
    // rather than return as though it had written.
    expect(() =>
      doc.transact(() => {
        deleteBlock(doc, blockId);
        editBlock(doc, blockId, "here", "gone");
      }),
    ).toThrow(BlockNotFoundError);
    expect(getBlock(doc, blockId)).toBeNull();
    expect(getBlocks(doc)).toEqual([]);
  });
});

describe("concurrent structural changes", () => {
  it("keeps every inserted block, with unique ids and one converged order", () => {
    let anchor = "";
    const [a, b] = replicaPair((doc) => {
      initDoc(doc, { uuid: UUID, title: "Structure" });
      anchor = appendBlock(doc, { type: "paragraph", text: "anchor" });
    });

    const fromA = insertBlock(a, anchor, { type: "paragraph", text: "from A" });
    const fromB = insertBlock(b, anchor, { type: "paragraph", text: "from B" });
    const appendedA = appendBlock(a, { type: "heading", text: "A tail" });
    const appendedB = appendBlock(b, { type: "heading", text: "B tail" });

    syncDocs(a, b);

    const idsA = blockIdsOf(a);
    const idsB = blockIdsOf(b);
    expect(idsA).toEqual(idsB);
    expect(new Set(idsA).size).toBe(idsA.length);
    expect(idsA).toHaveLength(5);
    expect(new Set(idsA)).toEqual(
      new Set([anchor, fromA, fromB, appendedA, appendedB]),
    );
    // The anchor stays first, and each replica's own edits keep their relative
    // order; the two concurrent runs interleave in a Yjs-deterministic way.
    expect(idsA[0]).toBe(anchor);
    expect(idsA.indexOf(fromA)).toBeLessThan(idsA.indexOf(appendedA));
    expect(idsA.indexOf(fromB)).toBeLessThan(idsA.indexOf(appendedB));
    expect(getBlocks(a)).toEqual(getBlocks(b));
  });

  it("converges when one client deletes a block another client inserts after", () => {
    let anchor = "";
    let tail = "";
    const [a, b] = replicaPair((doc) => {
      initDoc(doc, { uuid: UUID, title: "Structure" });
      anchor = appendBlock(doc, { type: "paragraph", text: "anchor" });
      tail = appendBlock(doc, { type: "paragraph", text: "tail" });
    });

    const inserted = insertBlock(b, anchor, {
      type: "paragraph",
      text: "inserted after anchor",
    });
    deleteBlock(a, anchor);

    syncDocs(a, b);

    // The inserted block survives its deleted neighbour and keeps its place.
    expect(blockIdsOf(a)).toEqual([inserted, tail]);
    expect(blockIdsOf(b)).toEqual([inserted, tail]);
  });

});

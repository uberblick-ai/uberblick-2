/**
 * The document rev is bounded work.
 *
 * The rev shown in the doc chrome is a fold of the block revs, and the naive
 * shape of that — re-read the document whenever anything changes — hashes every
 * character of every block on every keystroke, for eight characters of chrome.
 * That is what these tests defend against, and they defend it where it can be
 * observed rather than by timing anything: `getBlocks` is the only read that
 * touches the whole document, so it may run once, to seed, and never again;
 * every later edit may re-read the block it landed in and no other.
 *
 * The schema module is spied through, not replaced — the derivation under test
 * is the real one, and only its calls are counted.
 */

import { describe, expect, it, vi } from "vitest";
import * as Y from "yjs";

vi.mock("@uberblick/schema", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@uberblick/schema")>();
  return { ...actual, getBlock: vi.fn(actual.getBlock), getBlocks: vi.fn(actual.getBlocks) };
});

import {
  appendBlock,
  editBlock,
  getBlock,
  getBlocks,
  getBlocksFragment,
  initDoc,
  repairDuplicateBlocks,
  setBlockType,
} from "@uberblick/schema";
import { observeDocRev } from "../src/ui/doc-chrome.js";

interface Fixture {
  ydoc: Y.Doc;
  alpha: string;
  bravo: string;
  revs: string[];
  stop: () => void;
}

/** Two blocks, observed, with the seeding pass already accounted for. */
function fixture(): Fixture {
  const ydoc = new Y.Doc();
  initDoc(ydoc, { uuid: "11111111-1111-4111-8111-111111111111", title: "Revs" });
  const alpha = appendBlock(ydoc, { type: "paragraph", text: "alpha, at length" });
  const bravo = appendBlock(ydoc, { type: "paragraph", text: "bravo" });
  const revs: string[] = [];
  const stop = observeDocRev(ydoc, (rev) => revs.push(rev));
  vi.mocked(getBlocks).mockClear();
  vi.mocked(getBlock).mockClear();
  return { ydoc, alpha, bravo, revs, stop };
}

describe("the document rev is recomputed incrementally", () => {
  it("re-reads only the block an edit landed in", () => {
    const fix = fixture();
    try {
      editBlock(fix.ydoc, fix.bravo, "bravo", "bravo, edited");

      // The rev moved, so the chrome is telling the truth about the change.
      expect(fix.revs).toHaveLength(2);
      expect(fix.revs[1]).not.toBe(fix.revs[0]);

      // And it cost one block, not the document: `alpha` was never re-read, and
      // the whole-document read did not happen a second time.
      expect(vi.mocked(getBlocks)).not.toHaveBeenCalled();
      expect(vi.mocked(getBlock).mock.calls.map((call) => call[1])).toEqual([
        fix.bravo,
      ]);
    } finally {
      fix.stop();
    }
  });

  it("re-reads only the new block when one is inserted", () => {
    const fix = fixture();
    try {
      const charlie = appendBlock(fix.ydoc, { type: "paragraph", text: "charlie" });

      expect(fix.revs).toHaveLength(2);
      expect(fix.revs[1]).not.toBe(fix.revs[0]);
      expect(vi.mocked(getBlocks)).not.toHaveBeenCalled();
      expect(vi.mocked(getBlock).mock.calls.map((call) => call[1])).toEqual([
        charlie,
      ]);
    } finally {
      fix.stop();
    }
  });

  it("moves the rev when a re-type replaces a block's element under its id", () => {
    const fix = fixture();
    try {
      // The trap this test exists for: `setBlockType` keeps the block id and
      // swaps the element beneath it, and Yjs reports that as a structural
      // change on the fragment alone — no event names the block. A cache keyed
      // by id would answer with the paragraph's rev for as long as the document
      // stayed open, so the chrome would say nothing had changed.
      setBlockType(fix.ydoc, fix.alpha, "heading", { level: 2 });
      expect(fix.revs.at(-1)).not.toBe(fix.revs[0]);
      expect(vi.mocked(getBlocks)).not.toHaveBeenCalled();
    } finally {
      fix.stop();
    }
  });

  it("folds a shadowed duplicate as the nothing it is", () => {
    const fix = fixture();
    const before = fix.revs[0];
    try {
      // What two replicas re-typing one block converge on: two elements sharing
      // an id, of which only the first is a block anyone can see. `getBlocks`
      // shadows the second, so the rev has to as well — otherwise a hidden
      // element counts as content, and the repair that eventually deletes it
      // moves the rev with nothing on screen having changed.
      const duplicate = new Y.XmlElement("paragraph");
      duplicate.setAttribute("id", fix.alpha);
      duplicate.insert(0, [new Y.XmlText("a losing copy, with other text")]);
      getBlocksFragment(fix.ydoc).insert(1, [duplicate]);
      expect(fix.revs.at(-1)).toBe(before);

      repairDuplicateBlocks(fix.ydoc);
      expect(fix.revs.at(-1)).toBe(before);
    } finally {
      fix.stop();
    }
  });

  it("returns to the rev it had when an edit is undone", () => {
    const fix = fixture();
    try {
      editBlock(fix.ydoc, fix.bravo, "bravo", "bravo, edited");
      editBlock(fix.ydoc, fix.bravo, "bravo, edited", "bravo");
      expect(fix.revs[2]).toBe(fix.revs[0]);
    } finally {
      fix.stop();
    }
  });
});

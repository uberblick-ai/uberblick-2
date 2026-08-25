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

import { appendBlock, editBlock, getBlock, getBlocks, initDoc } from "@uberblick/schema";
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

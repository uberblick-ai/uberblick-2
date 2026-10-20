// @vitest-environment node
/**
 * The document rev is bounded work.
 *
 * The rev shown in the doc chrome is a fold of the block revs, and the naive
 * shape of that — re-read the document whenever anything changes — hashes every
 * character of every block on every keystroke, for the revision in the header.
 * That is what these tests defend against, and they defend it where it can be
 * observed rather than by timing anything: reading Y.XmlText deltas touches
 * block content, so an edit must never reread an unchanged block's text.
 */

import { describe, expect, it, vi } from "vitest";
import * as Y from "yjs";

import {
  appendBlock,
  docRev,
  editBlock,
  getBlocksFragment,
  initDoc,
  repairDuplicateBlocks,
  setBlockType,
  type TableMapping,
} from "@uberblick/schema";
import { observeDocRev } from "../src/ui/status/doc-chrome.js";

interface Fixture {
  ydoc: Y.Doc;
  alpha: string;
  bravo: string;
  revs: string[];
  alphaReads: () => number;
  stop: () => void;
}

/** Two blocks, observed, with the seeding pass already accounted for. */
function fixture(
  bravoBlock: Parameters<typeof appendBlock>[1] = { type: "paragraph", text: "bravo" },
): Fixture {
  const ydoc = new Y.Doc();
  initDoc(ydoc, { uuid: "11111111-1111-4111-8111-111111111111", title: "Revs" });
  const alpha = appendBlock(ydoc, { type: "paragraph", text: "alpha, at length" });
  const bravo = appendBlock(ydoc, bravoBlock);
  const revs: string[] = [];
  const stop = observeDocRev(ydoc, (rev) => revs.push(rev));
  const alphaText = (getBlocksFragment(ydoc).get(0) as Y.XmlElement).firstChild as Y.XmlText;
  const reads = vi.spyOn(alphaText, "toDelta");
  return { ydoc, alpha, bravo, revs, alphaReads: () => reads.mock.calls.length, stop };
}

describe("the document rev is recomputed incrementally", () => {
  it("exposes the full 16-character revision for copying", () => {
    const fix = fixture();
    try {
      expect(fix.revs[0]).toMatch(/^[0-9a-f]{16}$/);
    } finally {
      fix.stop();
    }
  });

  const tableText = "| Name | State |\n| --- | --- |\n| Alpha | Ready |";
  const tableEdits: Array<{ name: string; text: string; tableMapping?: TableMapping }> = [
    { name: "cell text", text: tableText.replace("Alpha", "Alpine") },
    { name: "cell formatting", text: tableText.replace("Alpha", "**Alpha**") },
    {
      name: "column insertion",
      text: "| Name | Added | State |\n| --- | --- | --- |\n| Alpha | New | Ready |",
      tableMapping: { rows: [0, 1], columns: [0, null, 1] },
    },
    {
      name: "column deletion",
      text: "| State |\n| --- |\n| Ready |",
      tableMapping: { rows: [0, 1], columns: [1] },
    },
  ];

  it.each(tableEdits)("refreshes the table rev after $name without rereading other blocks", ({ text, tableMapping }) => {
    const fix = fixture({ type: "table", text: tableText });
    try {
      editBlock(fix.ydoc, fix.bravo, tableText, text, tableMapping === undefined ? {} : { tableMapping });

      expect(fix.revs).toHaveLength(2);
      expect(fix.revs[1]).not.toBe(fix.revs[0]);
      expect(fix.alphaReads()).toBe(0);

      // The independent seeding read comes after the bounded-work assertions.
      const fresh: string[] = [];
      const stopFresh = observeDocRev(fix.ydoc, (rev) => fresh.push(rev));
      stopFresh();
      expect(fresh).toEqual([fix.revs[1]]);
    } finally {
      fix.stop();
    }
  });

  it("re-reads only the block an edit landed in", () => {
    const fix = fixture();
    try {
      const bravoText = (getBlocksFragment(fix.ydoc).get(1) as Y.XmlElement).firstChild as Y.XmlText;
      const bravoReads = vi.spyOn(bravoText, "toDelta");
      bravoText.insert(bravoText.length, ", edited");

      // The rev moved, so the chrome is telling the truth about the change.
      expect(fix.revs).toHaveLength(2);
      expect(fix.revs[1]).not.toBe(fix.revs[0]);

      // And it cost one block, not the document: `alpha` was never re-read, and
      // the whole-document read did not happen a second time.
      expect(fix.alphaReads()).toBe(0);
      expect(bravoReads).toHaveBeenCalledTimes(1);
      expect(fix.revs.at(-1)).toBe(docRev(fix.ydoc));
    } finally {
      fix.stop();
    }
  });

  it("re-reads only the new block when one is inserted", () => {
    const fix = fixture();
    try {
      const bravoText = (getBlocksFragment(fix.ydoc).get(1) as Y.XmlElement).firstChild as Y.XmlText;
      const bravoReads = vi.spyOn(bravoText, "toDelta");
      appendBlock(fix.ydoc, { type: "paragraph", text: "charlie" });

      expect(fix.revs).toHaveLength(2);
      expect(fix.revs[1]).not.toBe(fix.revs[0]);
      expect(fix.alphaReads()).toBe(0);
      expect(bravoReads).not.toHaveBeenCalled();
      expect(fix.revs.at(-1)).toBe(docRev(fix.ydoc));
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
      expect(fix.revs.at(-1)).toBe(docRev(fix.ydoc));
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

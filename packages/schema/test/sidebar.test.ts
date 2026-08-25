import { describe, expect, it } from "vitest";
import * as Y from "yjs";
import {
  appendBlock,
  createGroup,
  deleteGroup,
  getBlocks,
  getSidebarUnpinned,
  initDoc,
  moveDoc,
  moveGroup,
  pinDoc,
  readSidebar,
  renameGroup,
  unpinDoc,
  upsertDirectoryEntry,
  listDirectory,
} from "../src/index.js";
import { syncDocs } from "./helpers.js";

const ALPHA = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const BETA = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const GAMMA = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";

/**
 * Two replicas of one sidebar, already sharing two groups.
 *
 * The client ids are explicit because Yjs breaks some ties by clientID order,
 * so a test that happened to run with one ordering could pass while the same
 * code diverged on another machine. Every claim here has to hold either way.
 */
function seededPair(
  clientIds: [number, number] = [1, 2],
): { a: Y.Doc; b: Y.Doc; work: string; reading: string } {
  const a = new Y.Doc();
  a.clientID = clientIds[0];
  const work = createGroup(a, "Work");
  const reading = createGroup(a, "Reading");
  const b = new Y.Doc();
  b.clientID = clientIds[1];
  syncDocs(a, b);
  return { a, b, work, reading };
}

/** Both clientID orderings, so no assertion can rest on a coin flip. */
const CLIENT_ORDERS: [number, number][] = [
  [1, 2],
  [2, 1],
];

// The well-known room name itself is pinned once, in rooms.test.ts.
describe("sidebar doc", () => {
  it("returns groups and pins in stored order, never sorted by name", () => {
    const doc = new Y.Doc();
    const zulu = createGroup(doc, "Zulu");
    const alpha = createGroup(doc, "Alpha");
    pinDoc(doc, zulu, GAMMA);
    pinDoc(doc, zulu, ALPHA);
    pinDoc(doc, zulu, BETA, 1);

    expect(readSidebar(doc)).toEqual([
      { id: zulu, name: "Zulu", docs: [GAMMA, BETA, ALPHA] },
      { id: alpha, name: "Alpha", docs: [] },
    ]);

    // Explicit moves, and only explicit moves, change the order.
    moveGroup(doc, alpha, 0);
    moveDoc(doc, ALPHA, zulu, 0);
    renameGroup(doc, zulu, "Work");
    expect(readSidebar(doc)).toEqual([
      { id: alpha, name: "Alpha", docs: [] },
      { id: zulu, name: "Work", docs: [ALPHA, GAMMA, BETA] },
    ]);
  });

  it("pins a document once across the whole sidebar", () => {
    const doc = new Y.Doc();
    const work = createGroup(doc, "Work");
    const reading = createGroup(doc, "Reading");
    pinDoc(doc, work, ALPHA);
    pinDoc(doc, work, ALPHA);
    pinDoc(doc, reading, ALPHA);

    expect(readSidebar(doc)).toEqual([
      { id: work, name: "Work", docs: [ALPHA] },
      { id: reading, name: "Reading", docs: [] },
    ]);

    // Moving is how a pinned document changes group.
    moveDoc(doc, ALPHA, reading);
    expect(readSidebar(doc)).toEqual([
      { id: work, name: "Work", docs: [] },
      { id: reading, name: "Reading", docs: [ALPHA] },
    ]);
  });

  it("deleting a group unpins its documents and leaves the documents intact", () => {
    const document = new Y.Doc();
    initDoc(document, { uuid: ALPHA, title: "Alpha" });
    appendBlock(document, { type: "paragraph", text: "still here" });
    const directory = new Y.Doc();
    upsertDirectoryEntry(directory, { uuid: ALPHA, title: "Alpha" });

    const sidebar = new Y.Doc();
    const work = createGroup(sidebar, "Work");
    pinDoc(sidebar, work, ALPHA);
    deleteGroup(sidebar, work);

    expect(readSidebar(sidebar)).toEqual([]);
    // The sidebar only ever held the uuid, so neither the document nor its
    // directory stub can have been touched.
    expect(getBlocks(document).map((block) => block.text)).toEqual([
      "still here",
    ]);
    expect(listDirectory(directory)).toEqual([
      { uuid: ALPHA, title: "Alpha", tags: [] },
    ]);

    // And it is pinnable again, because nothing tombstoned it.
    const reading = createGroup(sidebar, "Reading");
    pinDoc(sidebar, reading, ALPHA);
    expect(readSidebar(sidebar)).toEqual([
      { id: reading, name: "Reading", docs: [ALPHA] },
    ]);
  });

  it("converges on one pin when two replicas pin the same document into different groups", () => {
    const { a, b, work, reading } = seededPair();
    pinDoc(a, work, ALPHA);
    pinDoc(b, reading, ALPHA);
    syncDocs(a, b);

    // One pin, in one named place: dedupe keeps the first occurrence in stored
    // traversal order, and "Work" precedes "Reading" in the group order.
    expect(readSidebar(a)).toEqual(readSidebar(b));
    expect(readSidebar(a)).toEqual([
      { id: work, name: "Work", docs: [ALPHA] },
      { id: reading, name: "Reading", docs: [] },
    ]);

    // The shadowed duplicate is storage, not state: the next write clears it.
    moveDoc(a, ALPHA, reading);
    syncDocs(a, b);
    expect(readSidebar(b)).toEqual([
      { id: work, name: "Work", docs: [] },
      { id: reading, name: "Reading", docs: [ALPHA] },
    ]);
  });

  it("converges when one replica reorders groups while another moves a document", () => {
    const { a, b, work, reading } = seededPair();
    pinDoc(a, work, ALPHA);
    pinDoc(a, work, BETA);
    syncDocs(a, b);

    moveGroup(a, reading, 0);
    moveDoc(b, BETA, reading, 0);
    syncDocs(a, b);

    expect(readSidebar(a)).toEqual(readSidebar(b));
    // Reordering rewrites the order array only, so the concurrent pin survives.
    expect(readSidebar(a)).toEqual([
      { id: reading, name: "Reading", docs: [BETA] },
      { id: work, name: "Work", docs: [ALPHA] },
    ]);
  });

  it("converges on the first occurrence in stored order when both replicas move the same document", () => {
    const { a, b, work, reading } = seededPair();
    pinDoc(a, work, ALPHA);
    pinDoc(a, work, BETA);
    syncDocs(a, b);

    moveDoc(a, ALPHA, reading, 0);
    moveDoc(b, ALPHA, work, 0);
    syncDocs(a, b);

    // One place, never both, and a named place: both inserts survive, so dedupe
    // decides, and it keeps the earlier position in traversal order — "Work"
    // precedes "Reading".
    expect(readSidebar(a)).toEqual(readSidebar(b));
    expect(readSidebar(a)).toEqual([
      { id: work, name: "Work", docs: [ALPHA, BETA] },
      { id: reading, name: "Reading", docs: [] },
    ]);

    // The shadowed copy clears on the next write touching that uuid.
    moveDoc(a, ALPHA, reading, 0);
    syncDocs(a, b);
    expect(readSidebar(b)).toEqual([
      { id: work, name: "Work", docs: [BETA] },
      { id: reading, name: "Reading", docs: [ALPHA] },
    ]);
  });

  it("picks the same destination whichever concurrent move is made first", () => {
    // The winner above is a position, not a timestamp. Running the same race
    // with the two moves swapped must therefore land the document in the same
    // group — otherwise "first occurrence in stored order" would be recency in
    // disguise, and the two replicas could disagree.
    const destinations = [false, true].map((swapped) => {
      const { a, b, work, reading } = seededPair();
      pinDoc(a, work, ALPHA);
      syncDocs(a, b);

      if (swapped) {
        moveDoc(b, ALPHA, work, 0);
        moveDoc(a, ALPHA, reading, 0);
      } else {
        moveDoc(a, ALPHA, reading, 0);
        moveDoc(b, ALPHA, work, 0);
      }
      syncDocs(a, b);

      expect(readSidebar(a)).toEqual(readSidebar(b));
      const holder = readSidebar(a).find((group) => group.docs.includes(ALPHA));
      expect(holder?.id).toBe(work);
      expect(reading).not.toBe(work);
      return holder?.name;
    });
    expect(destinations).toEqual(["Work", "Work"]);
  });

  it.each(CLIENT_ORDERS)(
    "unpins on both replicas when a move races an unpin (clients %i, %i)",
    (first, second) => {
      const { a, b, work, reading } = seededPair([first, second]);
      pinDoc(a, work, ALPHA);
      syncDocs(a, b);

      unpinDoc(a, ALPHA);
      moveDoc(b, ALPHA, reading, 0);
      syncDocs(a, b);

      // The decided rule. Removing the pins cannot carry it on its own — the
      // unpin's delete never reaches the pin the move inserted — so the unpin
      // counter does: the moved pin still carries the level it was made under,
      // which no longer clears the raised one.
      expect(readSidebar(a)).toEqual(readSidebar(b));
      expect(readSidebar(a)).toEqual([
        { id: work, name: "Work", docs: [] },
        { id: reading, name: "Reading", docs: [] },
      ]);

      // A deliberate re-pin is the way back: it stamps the pin with the level
      // it can see and sweeps up the one that was being shadowed, so the
      // document lands where this call puts it and nowhere else.
      pinDoc(b, reading, ALPHA);
      syncDocs(a, b);
      expect(readSidebar(a)).toEqual(readSidebar(b));
      expect(readSidebar(a)).toEqual([
        { id: work, name: "Work", docs: [] },
        { id: reading, name: "Reading", docs: [ALPHA] },
      ]);
    },
  );

  it.each(CLIENT_ORDERS)(
    "resolves an unpin racing a re-pin neither replica saw as pinned (clients %i, %i)",
    (first, second) => {
      // The case where the replicas disagree about whether the document is
      // pinned at all: B unpins and re-pins entirely on its own side, while A,
      // still holding the original pin, unpins. Both unpins are made from
      // level 0, so both write 1 — to their own client's key, never the same
      // one, so nothing is overwritten and nothing is deleted.
      const { a, b, work, reading } = seededPair([first, second]);
      pinDoc(a, work, ALPHA);
      syncDocs(a, b);

      unpinDoc(b, ALPHA);
      pinDoc(b, reading, ALPHA);
      unpinDoc(a, ALPHA);
      syncDocs(a, b);

      // Each replica's own counter survives the merge intact.
      expect(getSidebarUnpinned(a).get(`${ALPHA}#${a.clientID}`)).toBe(1);
      expect(getSidebarUnpinned(a).get(`${ALPHA}#${b.clientID}`)).toBe(1);

      // The level is the max, 1, and B's re-pin was stamped 1 — so the tie
      // reads as pinned, by the rule rather than by whichever clientID sorts
      // first. Same answer under either ordering, which is the whole point.
      expect(readSidebar(a)).toEqual(readSidebar(b));
      expect(readSidebar(a)).toEqual([
        { id: work, name: "Work", docs: [] },
        { id: reading, name: "Reading", docs: [ALPHA] },
      ]);

      // And an unpin that has seen all of it still wins: it raises its own
      // counter past the re-pin's stamp.
      unpinDoc(a, ALPHA);
      syncDocs(a, b);
      expect(readSidebar(a)).toEqual(readSidebar(b));
      expect(readSidebar(a).flatMap((group) => group.docs)).toEqual([]);
    },
  );

  it("drops the pins of a group deleted concurrently with a pin into it", () => {
    const { a, b, work, reading } = seededPair();

    deleteGroup(a, reading);
    pinDoc(b, reading, ALPHA);
    syncDocs(a, b);

    expect(readSidebar(a)).toEqual(readSidebar(b));
    expect(readSidebar(a)).toEqual([{ id: work, name: "Work", docs: [] }]);
    // Unpinned, not lost: the document is pinnable again.
    pinDoc(a, work, ALPHA);
    syncDocs(a, b);
    expect(readSidebar(b)).toEqual([{ id: work, name: "Work", docs: [ALPHA] }]);
  });
});

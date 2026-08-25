import { describe, expect, it } from "vitest";
import * as Y from "yjs";
import {
  appendBlock,
  createGroup,
  deleteGroup,
  getBlocks,
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

/** Two replicas of one sidebar, already sharing two groups. */
function seededPair(): {
  a: Y.Doc;
  b: Y.Doc;
  work: string;
  reading: string;
} {
  const a = new Y.Doc();
  const work = createGroup(a, "Work");
  const reading = createGroup(a, "Reading");
  const b = new Y.Doc();
  syncDocs(a, b);
  return { a, b, work, reading };
}

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

    expect(readSidebar(a)).toEqual(readSidebar(b));
    const pins = readSidebar(a).flatMap((group) => group.docs);
    expect(pins).toEqual([ALPHA]);

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

  it("converges on the last-integrated position when both replicas move the same document", () => {
    const { a, b, work, reading } = seededPair();
    pinDoc(a, work, ALPHA);
    pinDoc(a, work, BETA);
    syncDocs(a, b);

    moveDoc(a, ALPHA, reading, 0);
    moveDoc(b, ALPHA, work, 0);
    syncDocs(a, b);

    expect(readSidebar(a)).toEqual(readSidebar(b));
    const pins = readSidebar(a).flatMap((group) => group.docs);
    // One place, never both: the loser's pin is shadowed, not duplicated.
    expect(pins.filter((uuid) => uuid === ALPHA)).toEqual([ALPHA]);
    expect(pins).toContain(BETA);
  });

  it("keeps a document pinned when a move races an unpin", () => {
    const { a, b, work, reading } = seededPair();
    pinDoc(a, work, ALPHA);
    syncDocs(a, b);

    unpinDoc(a, ALPHA);
    moveDoc(b, ALPHA, reading, 0);
    syncDocs(a, b);

    // The unpin deleted the pin it could see; the move inserted one it never
    // saw. Both replicas agree, and there is exactly one pin — no duplicate.
    expect(readSidebar(a)).toEqual(readSidebar(b));
    expect(readSidebar(a)).toEqual([
      { id: work, name: "Work", docs: [] },
      { id: reading, name: "Reading", docs: [ALPHA] },
    ]);

    // The other direction leaves nothing behind: an unpin that has seen the
    // move removes every occurrence.
    unpinDoc(b, ALPHA);
    syncDocs(a, b);
    expect(readSidebar(a).flatMap((group) => group.docs)).toEqual([]);
  });

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

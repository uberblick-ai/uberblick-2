import { describe, expect, it } from "vitest";
import * as Y from "yjs";
import {
  SIDEBAR_GROUPS_KEY,
  SIDEBAR_ORDER_KEY,
  appendBlock,
  createGroup,
  deleteGroup,
  getBlocks,
  getOrCreateGroup,
  getSidebarUnpinned,
  initDoc,
  isSidebarSeeded,
  markSidebarSeeded,
  migrateLegacySidebar,
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

  it.each(CLIENT_ORDERS)(
    "unpins a pin stamped above the counters it has received (clients %i, %i)",
    (first, second) => {
      // Partial delivery. Updates from different clients arrive in no
      // guaranteed order, so B can hold a pin stamped `since: 1` while the
      // counter that justified it — written by a third client — has not
      // arrived, leaving B's level at 0. An unpin counting from the level
      // alone would write 1, which that pin already clears, and A's concurrent
      // move would carry it straight back. It takes a third writer to build:
      // Yjs keeps one client's own updates in order, so a pin can only outrun
      // the counter that justified it when someone else wrote that counter.
      const { a, b, work, reading } = seededPair([first, second]);
      pinDoc(a, work, ALPHA);
      syncDocs(a, b);

      const c = new Y.Doc();
      c.clientID = 3;
      syncDocs(a, c);
      unpinDoc(c, ALPHA);
      syncDocs(a, c);

      // A re-pins at the level C established: the pin carries `since: 1`.
      let pinUpdate: Uint8Array | null = null;
      const capture = (update: Uint8Array) => {
        pinUpdate = update;
      };
      a.on("update", capture);
      pinDoc(a, work, ALPHA);
      a.off("update", capture);
      expect(pinUpdate).not.toBeNull();

      // B receives that pin and nothing else — never C's counter.
      Y.applyUpdate(b, pinUpdate as unknown as Uint8Array);
      expect(readSidebar(b).flatMap((group) => group.docs)).toEqual([ALPHA]);

      // B unpins what it can see, while A moves the same pin elsewhere. The
      // move carries `since: 1` into an item B has never had a chance to
      // delete, so only B's counter can hide it.
      unpinDoc(b, ALPHA);
      moveDoc(a, ALPHA, reading, 0);

      syncDocs(a, c);
      syncDocs(a, b);
      syncDocs(a, c);
      syncDocs(a, b);

      expect(readSidebar(a)).toEqual(readSidebar(b));
      expect(readSidebar(a)).toEqual([
        { id: work, name: "Work", docs: [] },
        { id: reading, name: "Reading", docs: [] },
      ]);
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

/**
 * Two replicas making "the same" group while out of contact.
 *
 * The layout's reason for existing: a group's fields have to merge rather than
 * replace each other, or the replica whose create loses takes its pins down
 * with it — silently, which is the one thing a sidebar must never do.
 */
describe("creating one group on two replicas", () => {
  const PINNED = "5e1d0000-0000-4000-8000-000000000002";

  it.each(CLIENT_ORDERS)(
    "keeps both sides' pins when both create the same id (clients %i, %i)",
    (first, second) => {
      const a = new Y.Doc();
      a.clientID = first;
      const b = new Y.Doc();
      b.clientID = second;

      // Neither replica has seen the other, so both write the same group id.
      createGroup(a, "Pinned", undefined, PINNED);
      pinDoc(a, PINNED, ALPHA);
      createGroup(b, "Pinned", undefined, PINNED);
      pinDoc(b, PINNED, BETA);
      syncDocs(a, b);

      expect(readSidebar(a)).toEqual(readSidebar(b));
      const groups = readSidebar(a);
      expect(groups).toHaveLength(1);
      expect(groups[0]?.id).toBe(PINNED);
      expect(groups[0]?.name).toBe("Pinned");
      // Which pin sorts first is Yjs's tie-break between two blind inserts;
      // that neither is lost is the rule.
      expect([...(groups[0]?.docs ?? [])].sort()).toEqual([ALPHA, BETA]);
    },
  );

  it.each(CLIENT_ORDERS)(
    "keeps both sides' pins when both name the same group (clients %i, %i)",
    (first, second) => {
      const a = new Y.Doc();
      a.clientID = first;
      const b = new Y.Doc();
      b.clientID = second;

      // A caller that addresses groups by name gets the same guarantee: the id
      // comes from the name, so two replicas write one group.
      const here = getOrCreateGroup(a, "Reading");
      const there = getOrCreateGroup(b, "Reading");
      expect(here).toBe(there);
      pinDoc(a, here, ALPHA);
      pinDoc(b, there, BETA);
      syncDocs(a, b);

      expect(readSidebar(a)).toEqual(readSidebar(b));
      const groups = readSidebar(a);
      expect(groups).toHaveLength(1);
      expect(groups[0]?.name).toBe("Reading");
      expect([...(groups[0]?.docs ?? [])].sort()).toEqual([ALPHA, BETA]);

      // The "get" half: a name already on the sidebar is never created twice.
      expect(getOrCreateGroup(a, "Reading")).toBe(here);
      expect(readSidebar(a)).toHaveLength(1);
    },
  );

  it("gives a deleted group's id no pins when it is created again", () => {
    // A group's pins outlive the group as a top-level array, which is the one
    // hazard of reaching them by name: deleting has to empty it, or the next
    // group created under that id would inherit somebody else's curation.
    const doc = new Y.Doc();
    const work = createGroup(doc, "Work");
    pinDoc(doc, work, ALPHA);
    deleteGroup(doc, work);

    createGroup(doc, "Work again", undefined, work);
    expect(readSidebar(doc)).toEqual([
      { id: work, name: "Work again", docs: [] },
    ]);
  });
});

/**
 * What a one-time migration needs from this module: a way to say it has run
 * that a delete cannot undo, and ids of its own choosing so that two replicas
 * running it independently write one sidebar rather than two.
 */
describe("migrating into the sidebar", () => {
  const START_HERE = "5e1d0000-0000-4000-8000-000000000001";

  it("merges two independent runs into one set of groups", () => {
    const a = new Y.Doc();
    a.clientID = 1;
    const b = new Y.Doc();
    b.clientID = 2;

    // Neither replica has seen the other's flag — the offline case a migration
    // guarded by one still has to survive.
    for (const doc of [a, b]) {
      expect(isSidebarSeeded(doc)).toBe(false);
      createGroup(doc, "Start here", undefined, START_HERE);
      pinDoc(doc, START_HERE, ALPHA);
      markSidebarSeeded(doc);
    }
    syncDocs(a, b);

    expect(readSidebar(a)).toEqual(readSidebar(b));
    expect(readSidebar(a)).toEqual([
      { id: START_HERE, name: "Start here", docs: [ALPHA] },
    ]);
  });

  it("stays marked when the sidebar is emptied", () => {
    const doc = new Y.Doc();
    createGroup(doc, "Start here", undefined, START_HERE);
    markSidebarSeeded(doc);

    deleteGroup(doc, START_HERE);

    // Emptiness is not the marker: the migration ran, and a deliberate delete
    // of everything it wrote must not bring it back.
    expect(readSidebar(doc)).toEqual([]);
    expect(isSidebarSeeded(doc)).toBe(true);
  });

  it("brings a seeded group back under its constant id", () => {
    // A seeded group's id is what tests, briefs and placements reference, so
    // recreating one by name has to return the group rather than one that
    // merely reads the same. Two replicas doing it converge on one group.
    const a = new Y.Doc();
    a.clientID = 1;
    const b = new Y.Doc();
    b.clientID = 2;

    const here = getOrCreateGroup(a, "Start here", undefined, START_HERE);
    const there = getOrCreateGroup(b, "Start here", undefined, START_HERE);
    expect(here).toBe(START_HERE);
    expect(there).toBe(START_HERE);
    pinDoc(a, here, ALPHA);
    pinDoc(b, there, BETA);
    syncDocs(a, b);

    expect(readSidebar(a)).toEqual(readSidebar(b));
    expect(readSidebar(a)).toHaveLength(1);
    expect([...(readSidebar(a)[0]?.docs ?? [])].sort()).toEqual([ALPHA, BETA]);
  });

  it("never takes a well-known id over from a group somebody renamed", () => {
    const doc = new Y.Doc();
    createGroup(doc, "Archive", undefined, START_HERE);

    // The constant is held by a group that is no longer the seeded one, so the
    // name gets an id of its own: two groups, both visible and repairable —
    // never a rename of somebody's group as a side effect of a pin.
    const recreated = getOrCreateGroup(doc, "Start here", undefined, START_HERE);
    expect(recreated).not.toBe(START_HERE);
    expect(readSidebar(doc).map((group) => group.name)).toEqual([
      "Archive",
      "Start here",
    ]);
  });
});

/**
 * The layout that preceded this one: a group was a `Y.Map` under its id,
 * holding `name` and a `docs` array of the same plain pins.
 *
 * Written the way the old module wrote it — the map into `groups` first, its
 * fields after — so what these tests convert is the shape the live workspaces
 * actually hold rather than a reconstruction of it.
 */
function legacyGroup(
  doc: Y.Doc,
  id: string,
  name: string,
  uuids: string[],
): void {
  doc.transact(() => {
    const group = new Y.Map<unknown>();
    doc.getMap<unknown>(SIDEBAR_GROUPS_KEY).set(id, group);
    group.set("name", name);
    const docs = new Y.Array<{ uuid: string; since: number }>();
    group.set("docs", docs);
    docs.push(uuids.map((uuid) => ({ uuid, since: 0 })));
    doc.getArray<string>(SIDEBAR_ORDER_KEY).push([id]);
  });
}

/**
 * Converting a sidebar written before this layout existed.
 *
 * Not a hypothetical: shipping the layout without converting these documents
 * made every group and every pin in the live workspaces invisible on the next
 * start — nothing deleted, nothing readable (#350).
 */
describe("a sidebar written under the earlier layout", () => {
  const WORK = "10000000-0000-4000-8000-000000000001";
  const READING = "10000000-0000-4000-8000-000000000002";

  it("reads as empty until it is converted, then reads as it was written", () => {
    const doc = new Y.Doc();
    legacyGroup(doc, WORK, "Work", [ALPHA, BETA]);
    legacyGroup(doc, READING, "Reading", [GAMMA]);

    // The whole bug in one assertion: the document is full, the sidebar empty.
    expect(readSidebar(doc)).toEqual([]);

    expect(migrateLegacySidebar(doc)).toBe(2);
    expect(readSidebar(doc)).toEqual([
      { id: WORK, name: "Work", docs: [ALPHA, BETA] },
      { id: READING, name: "Reading", docs: [GAMMA] },
    ]);
  });

  it("converts once, and leaves a converted sidebar untouched", () => {
    const doc = new Y.Doc();
    legacyGroup(doc, WORK, "Work", [ALPHA]);
    const native = createGroup(doc, "Reading");
    pinDoc(doc, native, BETA);
    migrateLegacySidebar(doc);

    let updates = 0;
    doc.on("update", () => {
      updates += 1;
    });

    // Every start after the first pays one map read and writes nothing: no
    // duplicated pins, and no update for every other replica to merge.
    expect(migrateLegacySidebar(doc)).toBe(0);
    expect(updates).toBe(0);
    expect(readSidebar(doc)).toEqual([
      { id: WORK, name: "Work", docs: [ALPHA] },
      { id: native, name: "Reading", docs: [BETA] },
    ]);
  });

  it.each(CLIENT_ORDERS)(
    "converges when two replicas convert the same document (clients %i, %i)",
    (first, second) => {
      // Every replica converts at start, so two of them out of contact doing it
      // to one sidebar is the ordinary case rather than the exotic one.
      const a = new Y.Doc();
      a.clientID = first;
      const b = new Y.Doc();
      b.clientID = second;
      legacyGroup(a, WORK, "Work", [ALPHA, BETA]);
      syncDocs(a, b);

      expect(migrateLegacySidebar(a)).toBe(1);
      expect(migrateLegacySidebar(b)).toBe(1);
      syncDocs(a, b);

      expect(readSidebar(a)).toEqual(readSidebar(b));
      // Both conversions wrote the same pins, so storage holds each uuid twice;
      // the read rule keeps one, and the sidebar looks like nothing happened.
      expect(readSidebar(a)).toEqual([
        { id: WORK, name: "Work", docs: [ALPHA, BETA] },
      ]);
    },
  );
});

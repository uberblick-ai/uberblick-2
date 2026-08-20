/**
 * The three ways the local replica could quietly stop being the log.
 *
 * Each test here reproduces a real defect found in review, at the level where
 * the defect lived:
 *
 * 1. reading the snapshot and the log tail apart, so a concurrent compaction
 *    falls between them and the reader advances past a gap Yjs can never fill;
 * 2. a non-monotonic snapshot upsert, so a lagging compactor replaces a newer
 *    snapshot whose rows have already been pruned — losing the document's tail;
 * 3. a failed append that leaves the live replica ahead of its own log, still
 *    answering as if the write were durable.
 *
 * They are grouped because they share one subject: the log is the replica, and
 * anything that lets the two drift apart is data loss with extra steps.
 */

import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import * as Y from "yjs";
import { MirrorStore } from "../src/store.js";
import type { UpdateOrigin } from "../src/store.js";
import {
  removeTempDirs,
  startServer,
  tempDatabasePath,
  testConfig,
} from "./helpers.js";
import type { Rig } from "./helpers.js";

const ROOM = "main/durability";
const TEXT = "body";

const stores: MirrorStore[] = [];
const rigs: Rig[] = [];

function store(databasePath: string): MirrorStore {
  const opened = new MirrorStore(databasePath);
  stores.push(opened);
  return opened;
}

/** A store that lets a test run something between the two halves of a read. */
class InterleavingStore extends MirrorStore {
  private hook: (() => void) | null = null;

  /** Run `hook` once, immediately after the next snapshot read. */
  interleaveOnce(hook: () => void): void {
    this.hook = hook;
  }

  override snapshot(room: string) {
    const result = super.snapshot(room);
    const hook = this.hook;
    this.hook = null;
    hook?.();
    return result;
  }
}

/** A store whose appends can be made to fail, as a full disk would. */
class FailingStore extends MirrorStore {
  failing = false;

  override appendUpdate(
    room: string,
    payload: Uint8Array,
    origin: UpdateOrigin,
  ): number {
    if (this.failing) {
      throw new Error("simulated disk failure");
    }
    return super.appendUpdate(room, payload, origin);
  }
}

/** A Y.Doc recording every update it emits, so a test can log them by hand. */
function recordingDoc(): { doc: Y.Doc; updates: Uint8Array[] } {
  const doc = new Y.Doc();
  const updates: Uint8Array[] = [];
  doc.on("update", (update: Uint8Array) => updates.push(update));
  return { doc, updates };
}

function replay(updates: Uint8Array[], snapshot?: Uint8Array): string {
  const doc = new Y.Doc();
  if (snapshot !== undefined) {
    Y.applyUpdate(doc, snapshot);
  }
  for (const update of updates) {
    Y.applyUpdate(doc, update);
  }
  return doc.getText(TEXT).toString();
}

afterEach(async () => {
  for (const rig of rigs.splice(0)) {
    await rig.close();
  }
  for (const opened of stores.splice(0)) {
    opened.close();
  }
  removeTempDirs();
});

describe("reading the log", () => {
  it("never returns a tail that skips the snapshot bridging it", async () => {
    const databasePath = tempDatabasePath();
    const writer = store(databasePath);

    // Rows 1..3 for one room, and the state they add up to.
    const { doc, updates } = recordingDoc();
    const text = doc.getText(TEXT);
    text.insert(0, "A");
    text.insert(1, "B");
    text.insert(2, "C");
    expect(updates).toHaveLength(3);
    for (const update of updates) {
      writer.appendUpdate(ROOM, update, "remote");
    }

    // A reader that has applied row 1 and is about to read the rest, while
    // another process compacts through 3 and appends a fourth update.
    const reader = new InterleavingStore(databasePath);
    stores.push(reader);
    const other = store(databasePath);
    const later = new Y.Doc();
    Y.applyUpdate(later, Y.encodeStateAsUpdate(doc));
    let fourth: Uint8Array | null = null;
    later.on("update", (update: Uint8Array) => {
      fourth = update;
    });

    reader.interleaveOnce(() => {
      other.compact(ROOM, Y.encodeStateAsUpdate(doc), 3);
      later.getText(TEXT).insert(3, "D");
      if (fourth !== null) other.appendUpdate(ROOM, fourth, "remote");
    });

    const slice = reader.readSince(ROOM, 1);

    // The read is one transaction, so it answers from a single view: rows 2 and
    // 3 as they were, not the post-compaction row 4 on its own. Whatever it
    // returns, it is contiguous with where the reader was — the only property
    // that keeps a replica whole.
    const seqs = slice.updates.map((entry) => entry.seq);
    const first = seqs[0];
    if (first !== undefined && first > 2) {
      expect(slice.snapshot).not.toBeNull();
    }
    expect(seqs).toEqual([2, 3]);
    expect(replay(slice.updates.map((entry) => entry.payload), updates[0])).toBe(
      "ABC",
    );

    // And the next read picks up what the compaction left behind.
    const next = reader.readSince(ROOM, 3);
    expect(next.updates.map((entry) => entry.seq)).toEqual([4]);
  });
});

describe("compaction", () => {
  it("refuses a stale snapshot rather than overwriting a newer one", () => {
    const databasePath = tempDatabasePath();
    const writer = store(databasePath);

    const { doc, updates } = recordingDoc();
    const text = doc.getText(TEXT);
    text.insert(0, "A");
    text.insert(1, "B");
    const stale = Y.encodeStateAsUpdate(doc);
    text.insert(2, "C");
    text.insert(3, "D");
    for (const update of updates) {
      writer.appendUpdate(ROOM, update, "remote");
    }

    // The up-to-date compactor wins and prunes what it covered.
    const ahead = store(databasePath);
    expect(ahead.compact(ROOM, Y.encodeStateAsUpdate(doc), 4)).toBe(true);
    expect(ahead.updateCount(ROOM)).toBe(0);

    // A second process, still holding the two-character view, must not replace
    // it: the rows that would have made the difference are already gone.
    const behind = store(databasePath);
    expect(behind.compact(ROOM, stale, 2)).toBe(false);

    const reopened = store(databasePath);
    const snapshot = reopened.snapshot(ROOM);
    expect(snapshot?.throughSeq).toBe(4);
    expect(replay([], snapshot?.state)).toBe("ABCD");
  });

  it("keeps a document whole when a stale compactor loses the race", async () => {
    const databasePath = tempDatabasePath();
    const rig = await startServer(testConfig({ databasePath }));
    rigs.push(rig);

    const created = await rig.ok("create_doc", {
      title: "Compaction race",
      blocks: [
        { type: "paragraph", text: "first" },
        { type: "paragraph", text: "second" },
      ],
    });
    const room = `main/${created.uuid}`;
    const replica = rig.instance.replicas
      .attachedReplicas()
      .find((candidate) => candidate.id === created.uuid);
    if (replica === undefined) throw new Error("no replica");

    // A snapshot of the document as it was, standing in for another process
    // that has not caught up.
    const staleState = Y.encodeStateAsUpdate(replica.doc);
    const staleSeq = replica.lastSeq;

    await rig.ok("insert_block", {
      uuid: created.uuid,
      after_block_id: created.blocks[1].id,
      type: "paragraph",
      text: "third",
    });
    await rig.ok("sync_status", {});

    const outside = store(databasePath);
    expect(
      outside.compact(room, Y.encodeStateAsUpdate(replica.doc), replica.lastSeq),
    ).toBe(true);
    // The laggard tries to compact its older view of the same room.
    expect(outside.compact(room, staleState, staleSeq)).toBe(false);

    await rig.close();
    rigs.length = 0;

    const restarted = await startServer(testConfig({ databasePath }));
    rigs.push(restarted);
    const read = await restarted.ok("get_doc", { uuid: created.uuid });
    expect(read.blocks.map((block: { text: string }) => block.text)).toEqual([
      "first",
      "second",
      "third",
    ]);
  });
});

describe("a failed append", () => {
  it("stops every tool instead of serving a replica ahead of its log", async () => {
    const databasePath = tempDatabasePath();
    const faulty = new FailingStore(databasePath);
    stores.push(faulty);
    const rig = await startServer(testConfig({ databasePath }), faulty);
    rigs.push(rig);

    const created = await rig.ok("create_doc", {
      title: "Fail-stop",
      blocks: [{ type: "paragraph", text: "one" }],
    });
    const blockId = created.blocks[0].id;

    faulty.failing = true;
    const refused = await rig.call("edit_block", {
      uuid: created.uuid,
      block_id: blockId,
      old_text: "one",
      new_text: "two",
    });
    expect(refused.isError).toBe(true);
    expect(refused.payload.error).toBe("persistence_failed");
    expect(refused.payload.applied).toBe(false);

    // Fail-stop: the replica now holds a change the log does not, so it may not
    // answer anything — including reads, which would hand out state that a
    // restart will drop.
    for (const call of ["get_doc", "export_markdown"]) {
      const blocked = await rig.call(call, { uuid: created.uuid });
      expect(blocked.isError).toBe(true);
      expect(blocked.payload.error).toBe("persistence_failed");
    }
    const alsoBlocked = await rig.call("list_docs", {});
    expect(alsoBlocked.payload.error).toBe("persistence_failed");

    // Diagnostics still answer — that is when they are needed most.
    const status = await rig.ok("sync_status", {});
    expect(status.persistence).not.toBeNull();
    expect(status.persistence.room).toBe(`main/${created.uuid}`);

    // A restart rebuilds from the log, so the unlogged edit is simply gone —
    // never half-applied, and never reported as applied.
    faulty.failing = false;
    await rig.close();
    rigs.length = 0;

    const restarted = await startServer(testConfig({ databasePath }));
    rigs.push(restarted);
    const read = await restarted.ok("get_doc", { uuid: created.uuid });
    expect(read.blocks.map((block: { text: string }) => block.text)).toEqual([
      "one",
    ]);
  });
});

describe("the pending watermark", () => {
  it("is committed with the update it belongs to", async () => {
    const databasePath = tempDatabasePath();
    const rig = await startServer(testConfig({ databasePath }));
    rigs.push(rig);

    const created = await rig.ok("create_doc", { title: "Marked" });

    // Read through a second handle: only committed rows are visible, so seeing
    // both the update and its marker proves they landed together — there is no
    // window where a SIGKILL leaves a logged local change nothing will push.
    const reader = store(databasePath);
    const room = `main/${created.uuid}`;
    const pending = reader.pendingRooms().find((entry) => entry.room === room);
    expect(pending).toBeDefined();
    expect(reader.updatesAfter(room, 0).length).toBeGreaterThan(0);
    expect(pending?.seq).toBeGreaterThan(0);
  });

  it("is not cleared by a process that never saw the newer change", () => {
    const databasePath = tempDatabasePath();
    const writer = store(databasePath);

    const { doc, updates } = recordingDoc();
    const text = doc.getText(TEXT);
    text.insert(0, "A");
    writer.appendUpdate(ROOM, updates[0] as Uint8Array, "local");
    const seen = writer.pendingRooms();
    expect(seen).toEqual([{ room: ROOM, seq: 1 }]);

    // Another process appends while we were deciding the room was quiet.
    text.insert(1, "B");
    writer.appendUpdate(ROOM, updates[1] as Uint8Array, "local");

    // Clearing through the watermark we actually saw acknowledged leaves the
    // newer generation pending, instead of forgetting it.
    writer.clearPending(ROOM, seen[0]?.seq ?? 0);
    expect(writer.pendingRooms()).toEqual([{ room: ROOM, seq: 2 }]);

    writer.clearPending(ROOM, 2);
    expect(writer.pendingRooms()).toEqual([]);
  });

  it("survives a database written before the watermark existed", () => {
    // A pre-watermark file must open rather than crash on the old table shape.
    const databasePath = tempDatabasePath();
    const legacy = new Database(databasePath);
    legacy.exec(
      "CREATE TABLE pending_rooms (room TEXT PRIMARY KEY, since INTEGER NOT NULL);" +
        `INSERT INTO pending_rooms (room, since) VALUES ('${ROOM}', 1);`,
    );
    legacy.close();

    const opened = store(databasePath);
    expect(opened.pendingRooms()).toEqual([]);

    // …and then behave like any other store.
    const { doc, updates } = recordingDoc();
    doc.getText(TEXT).insert(0, "A");
    opened.appendUpdate(ROOM, updates[0] as Uint8Array, "local");
    expect(opened.pendingRooms()).toEqual([{ room: ROOM, seq: 1 }]);
  });
});

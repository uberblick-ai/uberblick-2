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

import { randomUUID } from "node:crypto";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import * as Y from "yjs";
import { appendBlock, getBlocks, initDoc } from "@uberblick/schema";
import type { Hub } from "@uberblick/hub";
import { MirrorStore } from "../src/store.js";
import type { UpdateOrigin } from "../src/store.js";
import {
  peerClient,
  removeTempDirs,
  sleep,
  startHub,
  startServer,
  tempDatabasePath,
  testConfig,
  TEST_SECRET,
  waitUntil,
} from "./helpers.js";
import type { PeerClient, Rig } from "./helpers.js";

const ROOM = "main/durability";
const TEXT = "body";

const stores: MirrorStore[] = [];
const rigs: Rig[] = [];
const hubs: Hub[] = [];
const peers: PeerClient[] = [];

function store(databasePath: string): MirrorStore {
  const opened = new MirrorStore(databasePath);
  stores.push(opened);
  return opened;
}

async function hub(): Promise<Hub> {
  const started = await startHub();
  hubs.push(started);
  return started;
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

/** A store that lets a test append from elsewhere just before a pending read. */
class LatePendingStore extends MirrorStore {
  private hook: (() => void) | null = null;

  beforeNextPendingRead(hook: () => void): void {
    this.hook = hook;
  }

  override pendingRooms() {
    const hook = this.hook;
    this.hook = null;
    hook?.();
    return super.pendingRooms();
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
  for (const peer of peers.splice(0)) {
    peer.destroy();
  }
  for (const rig of rigs.splice(0)) {
    await rig.close();
  }
  for (const opened of stores.splice(0)) {
    opened.close();
  }
  for (const started of hubs.splice(0)) {
    await started.stop().catch(() => {});
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

  it("never reaches another client, even though Yjs told the provider", async () => {
    // The failure is caught in this package's update listener, but Yjs goes on
    // to call every other listener on the document — including the Hocuspocus
    // provider's, which would broadcast the very mutation the log refused. A
    // real hub and a real second client are the only way to see that.
    const running = await hub();
    const databasePath = tempDatabasePath();
    const faulty = new FailingStore(databasePath);
    stores.push(faulty);
    const rig = await startServer(
      testConfig({
        databasePath,
        authSecret: TEST_SECRET,
        hubUrl: `ws://127.0.0.1:${running.port}`,
      }),
      faulty,
    );
    rigs.push(rig);

    const created = await rig.ok("create_doc", {
      title: "Quarantine",
      blocks: [{ type: "paragraph", text: "one" }],
    });
    const room = `main/${created.uuid}`;
    const peer = await peerClient(running.port, room);
    peers.push(peer);

    // The healthy write gets there, so the channel demonstrably works.
    await waitUntil("the peer to see the logged block", () =>
      getBlocks(peer.doc).some((block) => block.text === "one"),
    );

    faulty.failing = true;
    const refused = await rig.call("edit_block", {
      uuid: created.uuid,
      block_id: created.blocks[0].id,
      old_text: "one",
      new_text: "two",
    });
    expect(refused.isError).toBe(true);
    expect(refused.payload.error).toBe("persistence_failed");

    // The connection is cut, and the unlogged edit stays where it cannot spread.
    const status = await rig.ok("sync_status", {});
    expect(status.hub.status).toBe("quarantined");

    await sleep(300);
    expect(getBlocks(peer.doc).map((block) => block.text)).toEqual(["one"]);
  });

  it("is never folded into a snapshot by a later diagnostic call", async () => {
    // Compaction encodes the live document. On a poisoned replica that document
    // holds the unlogged change, so compacting would make a write reported as
    // refused durable — and a restart would bring it back.
    const databasePath = tempDatabasePath();
    const faulty = new FailingStore(databasePath);
    stores.push(faulty);
    const rig = await startServer(
      testConfig({ databasePath, compactAfter: 1 }),
      faulty,
    );
    rigs.push(rig);

    const created = await rig.ok("create_doc", {
      title: "No snapshots while broken",
      blocks: [{ type: "paragraph", text: "original" }],
    });
    const room = `main/${created.uuid}`;

    faulty.failing = true;
    const refused = await rig.call("edit_block", {
      uuid: created.uuid,
      block_id: created.blocks[0].id,
      old_text: "original",
      new_text: "corrupted",
    });
    expect(refused.isError).toBe(true);

    // Another process logs something, so the room's log is over the compaction
    // threshold and a settle would want to snapshot it.
    faulty.failing = false;
    const outside = store(databasePath);
    const foreign = new Y.Doc();
    initDoc(foreign, { uuid: created.uuid, title: "No snapshots while broken" });
    outside.appendUpdate(room, Y.encodeStateAsUpdate(foreign), "remote");

    // Diagnostics still answer, and touch nothing.
    const status = await rig.ok("sync_status", {});
    expect(status.persistence).not.toBeNull();

    await rig.close();
    rigs.length = 0;

    const restarted = await startServer(testConfig({ databasePath }));
    rigs.push(restarted);
    const read = await restarted.ok("get_doc", { uuid: created.uuid });
    expect(read.blocks.map((block: { text: string }) => block.text)).toEqual([
      "original",
    ]);
  });
});

describe("the pending watermark", () => {
  it("rolls the update back when its marker cannot be written", () => {
    const databasePath = tempDatabasePath();
    const writer = store(databasePath);
    const { doc, updates } = recordingDoc();
    doc.getText(TEXT).insert(0, "A");

    // Fail the second half of the append, from inside SQLite. Under an
    // append-then-mark implementation the update row is already committed by
    // this point and survives; in one transaction, neither effect lands.
    const saboteur = new Database(databasePath);
    saboteur.exec(
      "CREATE TRIGGER refuse_markers AFTER INSERT ON pending_rooms " +
        "BEGIN SELECT RAISE(ABORT, 'no markers today'); END",
    );
    saboteur.close();

    expect(() =>
      writer.appendUpdate(ROOM, updates[0] as Uint8Array, "local"),
    ).toThrow(/no markers today/);
    expect(writer.updatesAfter(ROOM, 0)).toEqual([]);
    expect(writer.pendingRooms()).toEqual([]);

    // With the trigger gone, both effects land together.
    const repair = new Database(databasePath);
    repair.exec("DROP TRIGGER refuse_markers");
    repair.close();

    const seq = writer.appendUpdate(ROOM, updates[0] as Uint8Array, "local");
    expect(writer.updatesAfter(ROOM, 0).map((entry) => entry.seq)).toEqual([seq]);
    expect(writer.pendingRooms()).toEqual([{ room: ROOM, seq }]);
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

  it("backfills a pre-watermark marker instead of orphaning its document", async () => {
    // The old crash window: a local update logged and marked, with the
    // directory stub never written. The marker is the only record that this
    // room exists, so deleting it would strand the document — nothing would
    // attach its room, and it could never be discovered or pushed.
    const databasePath = tempDatabasePath();
    const uuid = randomUUID();
    const room = `main/${uuid}`;

    const seeded = new MirrorStore(databasePath);
    const doc = new Y.Doc();
    initDoc(doc, { uuid, title: "Offline only" });
    appendBlock(doc, { type: "paragraph", text: "never announced" });
    const seq = seeded.appendUpdate(room, Y.encodeStateAsUpdate(doc), "local");
    seeded.close();

    // Rewrite the marker in the pre-watermark shape, and leave no stub.
    const legacy = new Database(databasePath);
    legacy.exec(
      "DROP TABLE pending_rooms;" +
        "CREATE TABLE pending_rooms (room TEXT PRIMARY KEY, since INTEGER NOT NULL);" +
        `INSERT INTO pending_rooms (room, since) VALUES ('${room}', 1);`,
    );
    legacy.close();

    const migrated = store(databasePath);
    expect(migrated.pendingRooms()).toEqual([{ room, seq }]);
    migrated.close();
    stores.pop();

    // And the document comes back: the marker attaches the room, hydration
    // replays it, and the stub is repaired from the document itself.
    const rig = await startServer(testConfig({ databasePath }));
    rigs.push(rig);
    const status = await rig.ok("sync_status", {});
    expect(
      status.rooms.map((entry: { room: string }) => entry.room),
    ).toContain(room);
    expect(
      (status.pendingRooms as { room: string }[]).map((entry) => entry.room),
    ).toContain(room);

    const listed = await rig.ok("list_docs", {});
    expect(listed.docs.map((entry: { uuid: string }) => entry.uuid)).toContain(
      uuid,
    );
    const read = await rig.ok("get_doc", { uuid });
    expect(read.blocks.map((block: { text: string }) => block.text)).toEqual([
      "never announced",
    ]);
  });

  it("is not cleared through a sequence this replica has not applied", async () => {
    // The reviewer's schedule: another process appends after this instance's
    // poll but before it reads the pending set. The marker in the database is
    // then ahead of everything this replica has applied, and clearing through
    // it would forget a change nobody has seen acknowledged.
    const running = await hub();
    const databasePath = tempDatabasePath();
    const late = new LatePendingStore(databasePath);
    stores.push(late);

    const rig = await startServer(
      testConfig({
        databasePath,
        authSecret: TEST_SECRET,
        hubUrl: `ws://127.0.0.1:${running.port}`,
      }),
      late,
    );
    rigs.push(rig);

    const created = await rig.ok("create_doc", { title: "Watermarks" });
    const room = `main/${created.uuid}`;
    await waitUntil("the room to be acknowledged", async () => {
      const status = await rig.ok("sync_status", {});
      return (
        status.hub.status === "connected" &&
        !(status.pendingRooms as { room: string }[]).some(
          (entry) => entry.room === room,
        )
      );
    });

    // An outside process appends between the poll and the pending read.
    const outside = store(databasePath);
    const foreign = new Y.Doc();
    initDoc(foreign, { uuid: created.uuid, title: "Renamed elsewhere" });
    let injected = 0;
    late.beforeNextPendingRead(() => {
      injected = outside.appendUpdate(
        room,
        Y.encodeStateAsUpdate(foreign),
        "local",
      );
    });

    await rig.ok("sync_status", {});

    // The outside change is still pending, and still in the log tail.
    const after = outside.pendingRooms().find((entry) => entry.room === room);
    expect(after).toEqual({ room, seq: injected });
    expect(outside.updatesAfter(room, injected - 1).length).toBeGreaterThan(0);
  });
});

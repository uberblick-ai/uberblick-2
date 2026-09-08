/**
 * Archiving a document: what stops seeing it, what keeps seeing it, and what
 * comes back.
 *
 * The tombstone itself belongs to the schema package — that a tombstone is
 * sticky, and that restoring is the one thing that lifts it, are pinned in
 * `packages/schema/test/directory.test.ts`. What this suite defends is the tool
 * contract an agent actually relies on: archiving removes a document from
 * discovery, from search and from the sidebar without touching a byte of it,
 * and restoring is a true reversal of the tombstone alone.
 */

import { afterAll, afterEach, describe, expect, it } from "vitest";
import * as Y from "yjs";
import {
  pinDoc,
  setTags,
  tombstoneDirectoryEntry,
  upsertDirectoryEntry,
} from "@uberblick/schema";
import {
  WORKSPACE,
  removeTempDirs,
  startServer,
  tempDatabasePath,
  testConfig,
  waitUntil,
} from "./helpers.js";
import type { Rig } from "./helpers.js";
import { MirrorStore } from "../src/store.js";
import type { IndexedDoc } from "../src/store.js";

/**
 * A real store that remembers which documents it was asked to re-index, and can
 * refuse the next request the way a locked or full database would.
 */
class CountingStore extends MirrorStore {
  readonly indexed: string[] = [];

  failNextIndex = false;

  /** Refuse every index write, the way a database locked for good would. */
  failEveryIndex = false;

  failUnindex = false;

  indexAttempts = 0;

  override indexDoc(
    doc: IndexedDoc,
    throughSeq: number,
    catalogThroughSeq = 0,
  ): void {
    this.indexAttempts += 1;
    if (this.failEveryIndex || this.failNextIndex) {
      this.failNextIndex = false;
      throw new Error("simulated index failure");
    }
    this.indexed.push(doc.uuid);
    super.indexDoc(doc, throughSeq, catalogThroughSeq);
  }

  unindexAttempts = 0;

  override unindexDoc(uuid: string): void {
    this.unindexAttempts += 1;
    if (this.failUnindex) {
      throw new Error("simulated unindex failure");
    }
    super.unindexDoc(uuid);
  }
}

/**
 * A real store that refuses every append to one named room.
 *
 * Archiving writes two rooms now, so "the log said no" has to be reachable for
 * the second one on its own: the directory tombstone is durable and the unpin
 * is not, which is the partial this tool has to report rather than call an
 * archive.
 */
class RefusingStore extends MirrorStore {
  refuseRoom: string | null = null;

  override appendUpdate(
    room: string,
    payload: Uint8Array,
    origin: Parameters<MirrorStore["appendUpdate"]>[2],
  ): number {
    if (room === this.refuseRoom) {
      throw new Error("simulated append failure");
    }
    return super.appendUpdate(room, payload, origin);
  }
}

const rigs: Rig[] = [];

async function localRig(): Promise<Rig> {
  const rig = await startServer(testConfig());
  rigs.push(rig);
  return rig;
}

const BODY = "A glossary of the terms this system keeps using.";

async function seedDoc(rig: Rig): Promise<any> {
  return rig.ok("create_doc", {
    title: "Concepts",
    description: "A test document.",
    tags: ["mcp"],
    blocks: [{ type: "paragraph", text: BODY }],
  });
}

afterEach(async () => {
  for (const rig of rigs.splice(0)) {
    await rig.close();
  }
});

afterAll(() => {
  removeTempDirs();
});

describe("archive_doc", () => {
  it("leaves a requirement and its ordered decisions independent", async () => {
    const rig = await localRig();
    const requirement = await rig.ok("create_doc", {
      title: "Choose the delivery path",
      description: "A requirement with two decisions in its log.",
      kind: "requirement",
      status: "planned",
    });
    const first = await rig.ok("create_doc", {
      title: "Choose the store",
      description: "The first decision in the requirement's log.",
      kind: "decision",
      status: "decided",
      governs: requirement.uuid,
      blocks: [
        { type: "paragraph", text: "Use the append-only update log." },
        { type: "heading", text: "Reconsidering", level: 2 },
        { type: "paragraph", text: "Revisit if the log outgrows one file." },
      ],
    });
    const second = await rig.ok("create_doc", {
      title: "Choose the serving process",
      description: "The second decision in the requirement's log.",
      kind: "decision",
      governs: requirement.uuid,
      blocks: [{ type: "paragraph", text: "Use ub open." }],
    });
    const expectedLog = [
      {
        uuid: first.uuid,
        title: "Choose the store",
        status: "decided",
        available: true,
      },
      {
        uuid: second.uuid,
        title: "Choose the serving process",
        status: "open",
        available: true,
      },
    ];
    const decisionsBefore = await Promise.all(
      [first.uuid, second.uuid].map((uuid) => rig.ok("get_doc", { uuid })),
    );

    expect(
      (await rig.ok("get_doc", { uuid: requirement.uuid })).decisions,
    ).toEqual(expectedLog);

    await rig.ok("archive_doc", { uuid: requirement.uuid });
    expect(
      (await rig.ok("get_doc", { uuid: requirement.uuid })).decisions,
    ).toEqual(expectedLog);
    expect(
      await Promise.all(
        [first.uuid, second.uuid].map((uuid) => rig.ok("get_doc", { uuid })),
      ),
    ).toEqual(decisionsBefore);

    await rig.ok("restore_doc", { uuid: requirement.uuid });
    expect(
      (await rig.ok("get_doc", { uuid: requirement.uuid })).decisions,
    ).toEqual(expectedLog);
    expect(
      await Promise.all(
        [first.uuid, second.uuid].map((uuid) => rig.ok("get_doc", { uuid })),
      ),
    ).toEqual(decisionsBefore);

    // Restore remains single-document in the other direction too: a decision
    // archived deliberately stays archived when its requirement cycles.
    await rig.ok("archive_doc", { uuid: first.uuid });
    await rig.ok("archive_doc", { uuid: requirement.uuid });
    await rig.ok("restore_doc", { uuid: requirement.uuid });
    expect(
      (await rig.ok("get_doc", { uuid: requirement.uuid })).decisions,
    ).toEqual([
      { ...expectedLog[0], available: false },
      expectedLog[1],
    ]);
  });

  it("drops a document from discovery and search, and from nothing else", async () => {
    const rig = await localRig();
    const doc = await seedDoc(rig);

    const archived = await rig.ok("archive_doc", { uuid: doc.uuid });
    expect(archived).toMatchObject({
      uuid: doc.uuid,
      title: "Concepts",
      archived: true,
      applied: true,
    });
    // Durability is reported honestly rather than assumed: with no hub in this
    // rig the local write is applied and demonstrably not synced.
    expect(archived.synced).toBe(false);

    const listed = await rig.ok("list_docs");
    expect(listed.docs.map((entry: any) => entry.uuid)).not.toContain(doc.uuid);

    const withDeleted = await rig.ok("list_docs", { include_deleted: true });
    expect(
      withDeleted.docs.find((entry: any) => entry.uuid === doc.uuid),
    ).toEqual({
      uuid: doc.uuid,
      title: "Concepts",
      tags: [
        {
          id: "00000000-0000-4000-8000-000000000003",
          name: "mcp",
          state: "active",
        },
      ],
      description: "A test document.",
      deleted: true,
      pinned: false,
      // Stamped at creation and carried through the tombstone — see
      // timestamps.test.ts for what they mean.
      createdAt: expect.any(Number),
      updatedAt: expect.any(Number),
    });

    // Search reads the derived index, which a directory write does not itself
    // touch — so this is the assertion that the tool re-derives it.
    const hits = await rig.ok("search", { query: "glossary" });
    expect(hits.hits).toEqual([]);

    // The point of a tombstone: the document is hidden, not erased.
    const read = await rig.ok("get_doc", { uuid: doc.uuid });
    expect(read.title).toBe("Concepts");
    expect(read.blocks.map((block: any) => block.text)).toEqual([BODY]);
  });

  // Every title keystroke in the web editor writes the directory. Re-deriving
  // the whole corpus on each one would put a SQLite write per document behind
  // every character typed, on every MCP server that observes it.
  it("reconciles only the entries a directory update changed", async () => {
    const store = new CountingStore(tempDatabasePath(), WORKSPACE);
    const rig = await startServer(testConfig(), store);
    rigs.push(rig);

    const renamed = await seedDoc(rig);
    const bystander = await rig.ok("create_doc", { title: "Untouched", description: "A test document." });

    store.indexed.length = 0;
    upsertDirectoryEntry(rig.instance.replicas.directory().doc, {
      uuid: renamed.uuid,
      title: "Concepts, renamed",
    });

    expect(store.indexed).toEqual([renamed.uuid]);
    expect(store.indexed).not.toContain(bystander.uuid);
  });

  it("takes the sidebar pin with it, and restoring does not put it back", async () => {
    const rig = await localRig();
    const doc = await seedDoc(rig);
    const bystander = await rig.ok("create_doc", {
      title: "Still an entry point",
      description: "A test document that is not being archived.",
    });
    await rig.ok("pin_doc", { uuid: doc.uuid, group: "Start here" });
    await rig.ok("pin_doc", { uuid: bystander.uuid, group: "Start here" });

    const archived = await rig.ok("archive_doc", { uuid: doc.uuid });
    expect(archived).toMatchObject({ archived: true, unpinned: true });

    // Both rooms this call wrote, reported one by one — no single boolean can
    // describe two independently logged and independently acknowledged rooms.
    expect(archived.rooms).toEqual([
      { purpose: "directory", room: `${WORKSPACE}/_directory`, applied: true, synced: false },
      { purpose: "sidebar", room: `${WORKSPACE}/_sidebar`, applied: true, synced: false },
    ]);
    expect(archived.applied).toBe(true);
    expect(archived.synced).toBe(false);

    // The sidebar stops carrying it, and the neighbour keeps its place.
    const sidebar = await rig.ok("get_sidebar");
    expect(sidebar.groups[0].docs).toEqual([
      { uuid: bystander.uuid, title: "Still an entry point", status: "ok" },
    ]);
    const listed = await rig.ok("list_docs", { include_deleted: true });
    expect(
      listed.docs.find((entry: any) => entry.uuid === doc.uuid).pinned,
    ).toBe(false);

    // Restore lifts the tombstone and nothing else: being reachable again is
    // not being an entry point again.
    const restored = await rig.ok("restore_doc", { uuid: doc.uuid });
    expect(restored.archived).toBe(false);
    expect((await rig.ok("get_sidebar")).groups[0].docs).toEqual([
      { uuid: bystander.uuid, title: "Still an entry point", status: "ok" },
    ]);
    expect(
      (await rig.ok("list_docs")).docs.find(
        (entry: any) => entry.uuid === doc.uuid,
      ).pinned,
    ).toBe(false);
  });

  it("names both rooms even when this replica can see no pin", async () => {
    const rig = await localRig();
    const doc = await seedDoc(rig);

    // The unpin is unconditional, so the sidebar is a room this call wrote
    // whatever this replica happened to hold — and `unpinned` reports what the
    // call asserts rather than what its read found.
    const archived = await rig.ok("archive_doc", { uuid: doc.uuid });
    expect(archived.unpinned).toBe(true);
    expect(archived.rooms).toEqual([
      { purpose: "directory", room: `${WORKSPACE}/_directory`, applied: true, synced: false },
      { purpose: "sidebar", room: `${WORKSPACE}/_sidebar`, applied: true, synced: false },
    ]);

    // A constant `true` is only honest with the sentence a caller reads beside
    // it: this replica hid what it could see, and a pin it never received can
    // still surface, so the tool has to say so and name where to look. Without
    // this the field reads as a guarantee the write cannot make (#969).
    const { tools } = await rig.client.listTools();
    expect(
      tools.find((tool) => tool.name === "archive_doc")?.description,
    ).toContain(
      "a pin made elsewhere that this replica has not received can still merge in behind the archive and " +
        "leave the document archived AND pinned. get_sidebar is where you see that",
    );
  });

  // The window this closes is ordinary: `settle()` returns when the sync budget
  // expires as readily as when the hub answered, so the sidebar can be behind
  // while the directory is current. An unpin that only removed what this
  // replica could see would leave the pin to merge in behind the tombstone,
  // and the document would read archived *and* pinned until a person noticed.
  it("hides a pin this replica never received, and lets a later pin_doc win", async () => {
    const rig = await localRig();
    const doc = await seedDoc(rig);
    const bystander = await rig.ok("create_doc", {
      title: "Still an entry point",
      description: "A test document that is not being archived.",
    });
    await rig.ok("pin_doc", { uuid: bystander.uuid, group: "Start here" });
    const sidebar = rig.instance.replicas.sidebar().doc;
    const group = (await rig.ok("get_sidebar")).groups[0];
    const neighbour = {
      uuid: bystander.uuid,
      title: "Still an entry point",
      status: "ok",
    };

    // A second replica pins the document. Its update is held back, so this
    // replica archives without ever having seen the pin.
    const peer = new Y.Doc();
    Y.applyUpdate(peer, Y.encodeStateAsUpdate(sidebar));
    pinDoc(peer, group.id, doc.uuid);
    const pinUpdate = Y.encodeStateAsUpdate(peer, Y.encodeStateVector(sidebar));

    expect((await rig.ok("archive_doc", { uuid: doc.uuid })).unpinned).toBe(true);

    Y.applyUpdate(sidebar, pinUpdate);
    expect((await rig.ok("get_sidebar")).groups[0].docs).toEqual([neighbour]);
    expect(
      (await rig.ok("list_docs", { include_deleted: true })).docs.find(
        (entry: any) => entry.uuid === doc.uuid,
      ).pinned,
    ).toBe(false);

    // Hiding an unseen pin is not a lock on the document: pinning an archived
    // target deliberately is still that caller's decision, and it still wins.
    await rig.ok("pin_doc", { uuid: doc.uuid, group: group.id });
    expect((await rig.ok("get_sidebar")).groups[0].docs).toEqual([
      neighbour,
      { uuid: doc.uuid, title: "Concepts", status: "archived" },
    ]);
  });

  it("reports a refused unpin as a partial write, never as a completed archive", async () => {
    const store = new RefusingStore(tempDatabasePath(), WORKSPACE);
    const rig = await startServer(testConfig(), store);
    rigs.push(rig);
    const doc = await seedDoc(rig);
    await rig.ok("pin_doc", { uuid: doc.uuid, group: "Start here" });

    store.refuseRoom = `${WORKSPACE}/_sidebar`;
    const refused = await rig.call("archive_doc", { uuid: doc.uuid });
    expect(refused.isError).toBe(true);
    expect(refused.payload).toMatchObject({
      error: "persistence_failed",
      uuid: doc.uuid,
      partial: true,
      rolledBack: false,
      applied: false,
      completed: [
        { purpose: "directory", room: `${WORKSPACE}/_directory`, applied: true },
      ],
      failed: { purpose: "sidebar", room: `${WORKSPACE}/_sidebar` },
      room: `${WORKSPACE}/_sidebar`,
      recoveryClass: "manual",
    });
    // The caller is told to finish the unpin, and told not to re-archive.
    expect(refused.payload.recovery).toContain("unpin_doc");
    expect(refused.payload.recovery).toContain("Do NOT call archive_doc again");
  });

  it("claims no pin the document never had when the tombstone is refused", async () => {
    const store = new RefusingStore(tempDatabasePath(), WORKSPACE);
    const rig = await startServer(testConfig(), store);
    rigs.push(rig);
    const doc = await seedDoc(rig);

    // Nothing was pinned, and nothing was written: a recovery line that says
    // the document is "still pinned" would send the caller looking for a pin
    // that never existed.
    store.refuseRoom = `${WORKSPACE}/_directory`;
    const refused = await rig.call("archive_doc", { uuid: doc.uuid });
    expect(refused.isError).toBe(true);
    expect(refused.payload).toMatchObject({
      error: "persistence_failed",
      uuid: doc.uuid,
      partial: false,
      rolledBack: false,
      failed: { purpose: "directory", room: `${WORKSPACE}/_directory` },
    });
    expect(refused.payload.recovery).toContain("its pin state is unchanged");
    expect(refused.payload.recovery).toContain("archive_doc again");
  });

  it("refuses a uuid the workspace has never heard of", async () => {
    const rig = await localRig();

    // Tombstoning a typo would publish a directory entry for a document that
    // never existed, and a tombstone is sticky.
    const refused = await rig.call("archive_doc", {
      uuid: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
    });
    expect(refused.isError).toBe(true);
    expect(refused.payload.error).toBe("doc_not_found");
  });
});

describe("an archived document is read-only", () => {
  it("refuses every mutating tool, naming restore_doc", async () => {
    const rig = await localRig();
    const doc = await seedDoc(rig);
    const blockId = doc.blocks[0].id;
    await rig.ok("archive_doc", { uuid: doc.uuid });

    for (const [tool, args] of [
      [
        "edit_block",
        { uuid: doc.uuid, block_id: blockId, old_text: BODY, new_text: "No." },
      ],
      ["insert_block", { uuid: doc.uuid, type: "paragraph", text: "No." }],
      ["set_tags", { uuid: doc.uuid, tags: ["billing"] }],
    ] as const) {
      const refused = await rig.call(tool, args);
      expect(refused.isError).toBe(true);
      expect(refused.payload).toMatchObject({
        error: "doc_archived",
        uuid: doc.uuid,
        // A refusal changed nothing, and says so in the same words a write
        // would have used.
        applied: false,
        synced: false,
      });
      expect(refused.payload.message).toContain("restore_doc");
    }

    // Refused, not merely reported as refused.
    const read = await rig.ok("get_doc", { uuid: doc.uuid });
    expect(read.blocks.map((block: any) => block.text)).toEqual([BODY]);
    expect(read.tags).toEqual([
      {
        id: "00000000-0000-4000-8000-000000000003",
        name: "mcp",
        state: "active",
      },
    ]);
  });

  it("goes back to accepting edits once restored", async () => {
    const rig = await localRig();
    const doc = await seedDoc(rig);
    const blockId = doc.blocks[0].id;
    await rig.ok("archive_doc", { uuid: doc.uuid });
    await rig.ok("restore_doc", { uuid: doc.uuid });

    const edited = await rig.ok("edit_block", {
      uuid: doc.uuid,
      block_id: blockId,
      old_text: BODY,
      new_text: "A glossary, rewritten.",
    });
    expect(edited).toMatchObject({ applied: true });
    expect(edited.block.text).toBe("A glossary, rewritten.");
  });

  // Reading an archive is the whole point of archiving rather than deleting.
  it("keeps serving reads", async () => {
    const rig = await localRig();
    const doc = await seedDoc(rig);
    await rig.ok("set_links", { uuid: doc.uuid, links: [] });
    await rig.ok("archive_doc", { uuid: doc.uuid });

    const exported = await rig.ok("export_markdown", { uuid: doc.uuid });
    expect(exported.markdown).toContain(BODY);
    expect((await rig.ok("backlinks", { uuid: doc.uuid })).backlinks).toEqual(
      [],
    );
    expect((await rig.ok("list_docs")).docs).toEqual([]);
    expect(
      (await rig.ok("list_docs", { include_deleted: true })).docs.map(
        (entry: any) => entry.uuid,
      ),
    ).toEqual([doc.uuid]);
  });
});

describe("restore_doc", () => {
  it("restores a document this replica knows only from the directory", async () => {
    const rig = await localRig();
    const uuid = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";

    // A document archived elsewhere: the directory carries it, the room never
    // reached this replica — and never will, because an archived room is not
    // one `adoptKnownDocs` attaches. Gating on local hydration would strand it
    // archived forever.
    const directory = rig.instance.replicas.directory().doc;
    upsertDirectoryEntry(directory, { uuid, title: "Archived elsewhere" });
    tombstoneDirectoryEntry(directory, uuid);

    const restored = await rig.ok("restore_doc", { uuid });
    expect(restored).toMatchObject({
      uuid,
      title: "Archived elsewhere",
      archived: false,
      applied: true,
      // The honest half: the restore is real and replicates, but this replica
      // has no content to index, so its own search cannot answer for the
      // document until the room arrives.
      indexed: false,
    });

    const listed = await rig.ok("list_docs");
    expect(listed.docs.map((entry: any) => entry.uuid)).toContain(uuid);
  });

  it("reverses an archive, in discovery and in search alike", async () => {
    const rig = await localRig();
    const doc = await seedDoc(rig);
    await rig.ok("archive_doc", { uuid: doc.uuid });

    const restored = await rig.ok("restore_doc", { uuid: doc.uuid });
    expect(restored).toMatchObject({
      uuid: doc.uuid,
      title: "Concepts",
      archived: false,
      applied: true,
      indexed: true,
    });
    expect(restored.synced).toBe(false);

    const listed = await rig.ok("list_docs");
    expect(listed.docs.find((entry: any) => entry.uuid === doc.uuid)).toEqual({
      uuid: doc.uuid,
      title: "Concepts",
      tags: [
        {
          id: "00000000-0000-4000-8000-000000000003",
          name: "mcp",
          state: "active",
        },
      ],
      description: "A test document.",
      pinned: false,
      createdAt: expect.any(Number),
      updatedAt: expect.any(Number),
    });

    const hits = await rig.ok("search", { query: "glossary" });
    expect(hits.hits.map((hit: any) => hit.uuid)).toEqual([doc.uuid]);
  });

  it("reports a refused index write as not indexed, and retries it", async () => {
    const store = new CountingStore(tempDatabasePath(), WORKSPACE);
    const rig = await startServer(testConfig(), store);
    rigs.push(rig);

    const doc = await seedDoc(rig);
    await rig.ok("archive_doc", { uuid: doc.uuid });

    // The restore lands in the directory and replicates; only the derived index
    // write fails. Claiming `indexed: true` here would send an agent looking for
    // a document its own search cannot return.
    store.failNextIndex = true;
    const restored = await rig.ok("restore_doc", { uuid: doc.uuid });
    expect(restored).toMatchObject({
      uuid: doc.uuid,
      archived: false,
      applied: true,
      indexed: false,
    });

    // Not merely reported as missing: still owed. Asserted before any further
    // tool call, because the settle at the start of one would repair it — which
    // is exactly the point of keeping the uuid queued.
    expect(rig.instance.replicas.indexReconciled(doc.uuid)).toBe(false);

    // And that repair happens: the next call settles, retries, and search finds
    // the document. A refused index write is transient, not a divergence that
    // outlives it.
    await waitUntil("the refused index write to be retried", async () => {
      const hits = await rig.ok("search", { query: "glossary" });
      return hits.hits.length === 1;
    });
    expect(rig.instance.replicas.indexReconciled(doc.uuid)).toBe(true);
  });

  // A database locked for good must cost a stale index row, not a stalled
  // server: each failed attempt spends SQLite's busy timeout, so retrying the
  // whole backlog on every tool call would charge that wait to every caller.
  it("paces a persistently refused entry instead of retrying it every call", async () => {
    const store = new CountingStore(tempDatabasePath(), WORKSPACE);
    const rig = await startServer(
      testConfig({ reconcileRetryMs: 60_000 }),
      store,
    );
    rigs.push(rig);

    const doc = await seedDoc(rig);
    await rig.ok("archive_doc", { uuid: doc.uuid });

    store.failEveryIndex = true;
    const restored = await rig.ok("restore_doc", { uuid: doc.uuid });
    expect(restored.indexed).toBe(false);

    const afterFirstFailure = store.indexAttempts;
    for (let call = 0; call < 4; call += 1) {
      // Unrelated work keeps working — the refusal is not allowed to leak out
      // of the index and into every other tool.
      const listed = await rig.call("list_docs", {});
      expect(listed.isError).toBe(false);
    }

    // Inside the cooldown, and nothing else touched the entry, so the store was
    // not asked again.
    expect(store.indexAttempts).toBe(afterFirstFailure);
    expect(rig.instance.replicas.indexReconciled(doc.uuid)).toBe(false);
  });

  // Adoption walks every tombstone on every settle. Deleting rows that are
  // already gone is the common case by far, and each pointless delete would
  // still queue behind a write lock for its busy timeout.
  it("does not touch the store for tombstones whose rows are already gone", async () => {
    const store = new CountingStore(tempDatabasePath(), WORKSPACE);
    const rig = await startServer(testConfig(), store);
    rigs.push(rig);

    for (const title of ["One", "Two", "Three"]) {
      const doc = await rig.ok("create_doc", { title, description: "A test document." });
      await rig.ok("archive_doc", { uuid: doc.uuid });
    }

    const afterArchiving = store.unindexAttempts;
    for (let call = 0; call < 3; call += 1) {
      await rig.ok("list_docs", {});
    }

    expect(store.unindexAttempts).toBe(afterArchiving);
  });

  // And when rows really are stale — a mirror rebuilt from an older corpus, or
  // a tombstone learned by replaying the log — the backlog is drained a piece
  // at a time rather than landing whole on whichever call arrives first.
  it("drains a stale mirror one delete per call", async () => {
    const store = new CountingStore(tempDatabasePath(), WORKSPACE);
    const rig = await startServer(testConfig(), store);
    rigs.push(rig);

    const uuids: string[] = [];
    for (const title of ["One", "Two", "Three"]) {
      const doc = await rig.ok("create_doc", { title, description: "A test document." });
      await rig.ok("archive_doc", { uuid: doc.uuid });
      uuids.push(doc.uuid);
    }

    // Rows for tombstoned documents, with nothing queued — what a rebuilt
    // mirror looks like before anything has noticed.
    for (const uuid of uuids) {
      store.indexDoc(
        { uuid, title: "stale", tags: [], description: "", links: [], body: "" },
        0,
      );
      expect(store.isIndexed(uuid)).toBe(true);
    }
    const before = store.unindexAttempts;

    await rig.ok("list_docs", {});
    expect(store.unindexAttempts).toBe(before + 1);

    await rig.ok("list_docs", {});
    expect(store.unindexAttempts).toBe(before + 2);

    // It does finish: no entry is abandoned, it is only rationed.
    await waitUntil("the stale mirror to drain", async () => {
      await rig.ok("list_docs", {});
      return uuids.every((uuid) => !store.isIndexed(uuid));
    });
  });

  // The unindex in adoptKnownDocs runs on every settle, outside the drain. Left
  // unguarded, a store refusing it turned a stale row into an error from every
  // unrelated tool.
  it("survives a refused unindex during adoption", async () => {
    const store = new CountingStore(tempDatabasePath(), WORKSPACE);
    const rig = await startServer(testConfig(), store);
    rigs.push(rig);

    const doc = await seedDoc(rig);
    await rig.ok("archive_doc", { uuid: doc.uuid });

    // Give adoption something to actually do. The archive above already removed
    // the rows, and the read guard means a tombstone with no rows is never
    // deleted at all — so without this the refusal below would never be reached
    // and this test would pass no matter what escaped.
    store.indexDoc(
      {
        uuid: doc.uuid,
        title: "stale",
        tags: [],
        description: "",
        links: [],
        body: "",
      },
      0,
    );
    store.failUnindex = true;

    const before = store.unindexAttempts;
    const listed = await rig.call("list_docs", {});
    expect(listed.isError).toBe(false);
    expect(listed.payload.docs).toEqual([]);

    // The delete really was attempted, and the refusal stayed inside the index
    // instead of coming back as this tool's answer.
    expect(store.unindexAttempts).toBeGreaterThan(before);

    const searched = await rig.call("search", { query: "glossary" });
    expect(searched.isError).toBe(false);
  });

  it("republishes metadata that changed while the document was archived", async () => {
    const rig = await localRig();
    const doc = await seedDoc(rig);
    await rig.ok("archive_doc", { uuid: doc.uuid });

    // A retag from a replica that had not seen the archive — this server's own
    // tools would refuse it, but a CRDT update arriving from elsewhere is not
    // something any tool guard can stop. Its stub does not follow: stub repair
    // rides document updates, and those stop at the tombstone. The directory
    // would otherwise keep serving the tags it was archived with while search
    // answers from the new ones — divergence with no way back.
    setTags(rig.instance.replicas.replica(doc.uuid).doc, [
      "00000000-0000-4000-8000-000000000002",
    ]);
    await rig.ok("restore_doc", { uuid: doc.uuid });

    const listed = await rig.ok("list_docs");
    expect(listed.docs.find((entry: any) => entry.uuid === doc.uuid)).toEqual({
      uuid: doc.uuid,
      title: "Concepts",
      tags: [
        {
          id: "00000000-0000-4000-8000-000000000002",
          name: "billing",
          state: "active",
        },
      ],
      description: "A test document.",
      pinned: false,
      createdAt: expect.any(Number),
      updatedAt: expect.any(Number),
    });
  });
});

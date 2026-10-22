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
import { DIRECTORY_ARCHIVED_RECORDS_KEY, getMetaMap, pinDoc, setTags, tombstoneDirectoryEntry, upsertDirectoryEntry } from "@uberblick/schema";
import { WORKSPACE, directoryStub, removeTempDirs, startServer, testConfig } from "./core-helpers.js";
import type { Rig } from "./core-helpers.js";
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
    directoryThroughSeq = 0,
  ): boolean {
    this.indexAttempts += 1;
    if (this.failEveryIndex || this.failNextIndex) {
      this.failNextIndex = false;
      throw new Error("simulated index failure");
    }
    this.indexed.push(doc.uuid);
    return super.indexDoc(doc, throughSeq, catalogThroughSeq, directoryThroughSeq);
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
  it("leaves a page and its derived decision topics independent", async () => {
    const rig = await localRig();
    const page = await rig.ok("create_doc", {
      title: "Choose the delivery path",
      description: "A page with two decisions in its log.",
    });
    const first = await rig.ok("create_doc", {
      title: "Choose the store",
      description: "The first decision in the page's log.",
      kind: "decision",
      status: "decided",
      related: page.uuid,
      blocks: [
        { type: "paragraph", text: "Use the append-only update log." },
      ],
    });
    const second = await rig.ok("create_doc", {
      title: "Choose the serving process",
      description: "The second decision in the page's log.",
      kind: "decision",
      related: page.uuid,
      blocks: [{ type: "paragraph", text: "Use ub open." }],
    });
    const expectedLog = (await rig.ok("get_doc", { uuid: page.uuid })).decisions;
    expect(expectedLog).toMatchObject([
      { topic: first.uuid, inForce: { uuid: first.uuid }, pending: [] },
      { topic: second.uuid, inForce: null, pending: [{ uuid: second.uuid }] },
    ]);
    const decisionsBefore = await Promise.all(
      [first.uuid, second.uuid].map((uuid) => rig.ok("get_doc", { uuid })),
    );

    expect(
      (await rig.ok("get_doc", { uuid: page.uuid })).decisions,
    ).toEqual(expectedLog);

    await rig.ok("archive_doc", { uuid: page.uuid });
    expect(
      (await rig.ok("get_doc", { uuid: page.uuid })).decisions,
    ).toEqual(expectedLog);
    expect(
      await Promise.all(
        [first.uuid, second.uuid].map((uuid) => rig.ok("get_doc", { uuid })),
      ),
    ).toEqual(decisionsBefore);

    await rig.ok("restore_doc", { uuid: page.uuid });
    expect(
      (await rig.ok("get_doc", { uuid: page.uuid })).decisions,
    ).toEqual(expectedLog);
    expect(
      await Promise.all(
        [first.uuid, second.uuid].map((uuid) => rig.ok("get_doc", { uuid })),
      ),
    ).toEqual(decisionsBefore);

    // Page restore remains independent in the other direction too: a decision
    // archived deliberately stays archived when its page cycles.
    await rig.ok("archive_doc", { uuid: first.uuid });
    await rig.ok("archive_doc", { uuid: page.uuid });
    await rig.ok("restore_doc", { uuid: page.uuid });
    expect(
      (await rig.ok("get_doc", { uuid: page.uuid })).decisions,
    ).toEqual([expectedLog[1]]);
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
        },
      ],
      description: "A test document.",
      deleted: true,
      pinned: false,
      openThreadCount: 0,
      // Stamped at creation and carried through the tombstone — see
      // timestamps.test.ts for what they mean.
      updatedAt: expect.any(String),
    });
    expect(directoryStub(rig.instance, doc.uuid)).toMatchObject({ createdAt: expect.any(Number), code_check: [] });

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
    const store = new CountingStore(":memory:", WORKSPACE);
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
    const store = new RefusingStore(":memory:", WORKSPACE);
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
      message: `The update log refused the write to ${WORKSPACE}/_sidebar, so archive_doc stopped part-way. ` +
        "Nothing was rolled back: the rooms in `completed` are durable and the rooms after the failure were never written.",
      recovery: "The tombstone is durable, so the document is archived; only the unpin is missing, so any pin it has is " +
        "still there and get_sidebar reports such a pin with `status: \"archived\"`. Restart the MCP server, then " +
        "call unpin_doc with this uuid to finish it. Do NOT call archive_doc again — it is already archived.",
    });
  });

  it("claims no pin the document never had when the tombstone is refused", async () => {
    const store = new RefusingStore(":memory:", WORKSPACE);
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
      recoveryClass: "manual",
      message: `The update log refused the write to ${WORKSPACE}/_directory, so archive_doc stopped part-way. ` +
        "Nothing was rolled back: the rooms in `completed` are durable and the rooms after the failure were never written.",
      recovery: "Nothing survived: the refused write is the tombstone itself, so the document is still listed and its pin " +
        "state is unchanged. Restart the MCP server — the failure is sticky and every tool refuses until then — " +
        "then call archive_doc again.",
    });
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
      ["insert_block", { uuid: doc.uuid, blocks: [{ type: "paragraph", text: "No." }] }],
      ["delete_block", { uuid: doc.uuid, block_id: blockId }],
      ["set_metadata", { uuid: doc.uuid, tags: ["billing"] }],
      ["set_metadata", { uuid: doc.uuid, title: "Renamed while archived" }],
      ["set_metadata", { uuid: doc.uuid, description: "Should not land." }],
      ["set_metadata", { uuid: doc.uuid, tldr: "This must not land." }],
      ["set_metadata", { uuid: doc.uuid, links: [] }],
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
        message: `Document ${doc.uuid} is archived — restore_doc to edit${tool === "insert_block" ? " Nothing was written." : ""}`,
        recoveryClass: "manual",
        recovery: "Archived documents are read-only. Call restore_doc for this uuid before editing, or delete_doc to permanently delete an archived regular document.",
      });
    }

    // Refused, not merely reported as refused.
    const read = await rig.ok("get_doc", { uuid: doc.uuid });
    expect(read.blocks.map((block: any) => block.text)).toEqual([BODY]);
    expect(read).toMatchObject({ title: "Concepts", description: "A test document.", tldr: null });
    expect(read.tags).toEqual([
      {
        id: "00000000-0000-4000-8000-000000000003",
        name: "mcp",
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
    await rig.ok("set_metadata", { uuid: doc.uuid, links: [] });
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
        },
      ],
      description: "A test document.",
      pinned: false,
      updatedAt: expect.any(String),
      openThreadCount: 0,
    });
    expect(directoryStub(rig.instance, doc.uuid)).toMatchObject({ createdAt: expect.any(Number), code_check: [] });

    const hits = await rig.ok("search", { query: "glossary" });
    expect(hits.hits.map((hit: any) => hit.uuid)).toEqual([doc.uuid]);
  });

  // A database locked for good must cost a stale index row, not a stalled
  // server: each failed attempt spends SQLite's busy timeout, so retrying the
  // whole backlog on every tool call would charge that wait to every caller.

  // Adoption walks every tombstone on every settle. Deleting rows that are
  // already gone is the common case by far, and each pointless delete would
  // still queue behind a write lock for its busy timeout.
  it("does not touch the store for tombstones whose rows are already gone", async () => {
    const store = new CountingStore(":memory:", WORKSPACE);
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

  // The unindex in adoptKnownDocs runs on every settle, outside the drain. Left
  // unguarded, a store refusing it turned a stale row into an error from every
  // unrelated tool.
  it("survives a refused unindex during adoption", async () => {
    const store = new CountingStore(":memory:", WORKSPACE);
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
        },
      ],
      description: "A test document.",
      pinned: false,
      updatedAt: expect.any(String),
      openThreadCount: 0,
    });
    expect(directoryStub(rig.instance, doc.uuid)).toMatchObject({ createdAt: expect.any(Number), code_check: [] });
  });
});

describe("individual decision record archives", () => {
  const answer = { who: "A person", when: "2026-10-04T12:00:00Z", where: "A recorded team discussion." };

  async function record(rig: Rig, fields: Record<string, unknown> = {}) {
    return rig.ok("create_doc", {
      title: "Archive question", description: "A decision archive test.", kind: "decision",
      blocks: [{ type: "paragraph", text: "An archiveworthy answer." }], ...fields,
    });
  }

  it("hides a record, refuses content, comments and lifecycle writes, and restores it", async () => {
    const rig = await localRig();
    const first = await record(rig, { status: "decided" });
    const proposal = await record(rig, { supersedes: first.uuid });
    const thread = await rig.ok("annotate", {
      uuid: proposal.uuid, block_id: proposal.blocks[0].id, start: 0, end: 2, text: "Retain this comment.",
    });
    const directory = rig.instance.replicas.directory().doc;
    directory.getMap(DIRECTORY_ARCHIVED_RECORDS_KEY).set(proposal.uuid, true);

    expect(rig.instance.store.isIndexed(proposal.uuid)).toBe(false);
    expect((await rig.ok("search", { query: "archiveworthy" })).hits.map((hit: any) => hit.uuid)).toEqual([first.uuid]);
    expect((await rig.ok("list_docs", { kind: "decision" })).docs).toMatchObject([
      { uuid: first.uuid, inForce: first.uuid, pending: [] },
    ]);
    expect((await rig.ok("list_docs", { kind: "decision", include_superseded: true })).docs.map((entry: any) => entry.uuid)).toEqual([first.uuid]);
    expect((await rig.ok("list_docs", { kind: "decision", include_superseded: true, include_deleted: true })).docs)
      .toEqual(expect.arrayContaining([expect.objectContaining({ uuid: proposal.uuid, deleted: true })]));
    const read = await rig.ok("get_doc", { uuid: proposal.uuid });
    expect(read.blocks[0].text).toBe("An archiveworthy answer.");
    expect(read.annotations).toHaveLength(1);
    expect(read.predecessors).toMatchObject([{ uuid: first.uuid, deleted: false }]);
    expect((await rig.ok("get_doc", { uuid: first.uuid })).successors)
      .toMatchObject([{ uuid: proposal.uuid, deleted: true }]);
    const before = Y.encodeStateAsUpdate(rig.instance.replicas.replica(proposal.uuid).doc);
    for (const [tool, args] of [
      ["edit_block", { uuid: proposal.uuid, block_id: proposal.blocks[0].id, old_text: "An archiveworthy answer.", new_text: "Changed" }],
      ["set_metadata", { uuid: proposal.uuid, description: "Changed" }],
      ["annotate", { uuid: proposal.uuid, thread_id: thread.annotation.id, text: "Changed", resolved: true }],
      ["set_status", { uuid: proposal.uuid, status: "decided", answer }],
    ] as const) {
      expect((await rig.call(tool, args)).payload).toMatchObject({ error: "doc_archived", uuid: proposal.uuid, applied: false });
    }
    expect(Y.encodeStateAsUpdate(rig.instance.replicas.replica(proposal.uuid).doc)).toEqual(before);
    expect(await rig.ok("restore_doc", { uuid: proposal.uuid })).toMatchObject({ records: [proposal.uuid], archived: false, indexed: true });
    expect((await rig.ok("list_docs", { kind: "decision" })).docs).toMatchObject([{ pending: [proposal.uuid] }]);
    expect((await rig.ok("search", { query: "archiveworthy" })).hits.map((hit: any) => hit.uuid).sort()).toEqual([first.uuid, proposal.uuid].sort());
    expect((await rig.ok("set_status", { uuid: proposal.uuid, status: "withdrawn" })).applied).toBe(true);
  });

  it("restores a topic before a record and keeps the first UUID usable as a live pin", async () => {
    const rig = await localRig();
    const first = await record(rig, { status: "decided" });
    const middle = await record(rig, { supersedes: first.uuid, status: "decided", answer });
    const current = await record(rig, { supersedes: middle.uuid, status: "decided", answer });
    const directory = rig.instance.replicas.directory().doc;
    await rig.ok("pin_doc", { uuid: first.uuid, group: "Reading" });
    directory.getMap(DIRECTORY_ARCHIVED_RECORDS_KEY).set(first.uuid, true);
    directory.getMap(DIRECTORY_ARCHIVED_RECORDS_KEY).set(middle.uuid, true);
    await rig.ok("pin_doc", { uuid: middle.uuid, group: "Reading" });
    expect((await rig.ok("get_sidebar")).groups[0].docs).toEqual([
      { uuid: first.uuid, title: "Archive question", status: "ok" },
      { uuid: middle.uuid, title: "Archive question", status: "archived" },
    ]);

    expect((await rig.ok("archive_doc", { uuid: middle.uuid })).records.sort()).toEqual([first.uuid, middle.uuid, current.uuid].sort());
    expect((await rig.ok("list_docs", { kind: "decision" })).docs).toEqual([]);
    expect(await rig.ok("restore_doc", { uuid: middle.uuid })).toMatchObject({ archived: true });
    expect((await rig.ok("list_docs", { kind: "decision", include_superseded: true })).docs.map((entry: any) => entry.uuid)).toEqual([current.uuid]);
    expect((await rig.call("set_metadata", { uuid: middle.uuid, description: "Still archived" })).payload.error).toBe("doc_archived");
    expect(await rig.ok("restore_doc", { uuid: middle.uuid })).toMatchObject({ records: [middle.uuid], archived: false, indexed: true });
    const archived = (await rig.ok("list_docs", { kind: "decision", include_superseded: true, include_deleted: true })).docs;
    expect(archived.find((entry: any) => entry.uuid === first.uuid).deleted).toBe(true);
    expect(archived.find((entry: any) => entry.uuid === middle.uuid)).not.toHaveProperty("deleted");
    expect((await rig.ok("list_docs", { kind: "decision" })).docs).toMatchObject([{ inForce: current.uuid, conflicts: [] }]);
  });

  it("restores an individually archived record known only from directory stubs", async () => {
    const rig = await localRig();
    const first = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    const archived = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
    const directory = rig.instance.replicas.directory().doc;
    upsertDirectoryEntry(directory, { uuid: first, title: "Unhydrated topic", kind: "decision", topic: first, status: "open" });
    upsertDirectoryEntry(directory, { uuid: archived, title: "Unhydrated topic", kind: "decision", topic: first, status: "open", supersedes: first });
    directory.getMap(DIRECTORY_ARCHIVED_RECORDS_KEY).set(archived, true);
    expect(await rig.ok("restore_doc", { uuid: archived })).toMatchObject({ records: [archived], archived: false, indexed: false });
    expect(rig.instance.replicas.hydrated(archived)).toBe(false);
    expect((await rig.ok("list_docs", { kind: "decision", include_superseded: true })).docs.map((entry: any) => entry.uuid).sort()).toEqual([first, archived].sort());
  });

  it("excludes an archived record when its index withdrawal fails", async () => {
    const store = new CountingStore(":memory:", WORKSPACE);
    const rig = await startServer(testConfig(), store);
    rigs.push(rig);
    const page = await seedDoc(rig);
    const first = await record(rig, { status: "decided" });
    const proposal = await record(rig, {
      supersedes: first.uuid,
      blocks: [{ type: "paragraph", text: "", inline: [
        { text: "An archiveworthy answer.", marks: { link: "https://github.com/owner/repo/issues/42" } },
      ] }],
    });
    await rig.ok("set_metadata", { uuid: proposal.uuid, links: [page.uuid] });
    expect((await rig.ok("backlinks", { uuid: page.uuid })).backlinks).toHaveLength(1);
    expect((await rig.ok("find_decisions", { github_ref: "owner/repo#42" })).decisions).toHaveLength(1);
    store.failUnindex = true;
    rig.instance.replicas.directory().doc.getMap(DIRECTORY_ARCHIVED_RECORDS_KEY).set(proposal.uuid, true);
    expect(store.isIndexed(proposal.uuid)).toBe(true);
    expect((await rig.ok("search", { query: "archiveworthy" })).hits.map((hit: any) => hit.uuid)).toEqual([first.uuid]);
    expect((await rig.ok("backlinks", { uuid: page.uuid })).backlinks).toEqual([]);
    expect((await rig.ok("find_decisions", { github_ref: "owner/repo#42" })).decisions).toEqual([]);
  });

  it("unhides a marked answer when an older client approves it or creates a conflict", async () => {
    const rig = await localRig();
    const first = await record(rig, { status: "decided" });
    const proposal = await record(rig, { supersedes: first.uuid });
    const directory = rig.instance.replicas.directory().doc;
    directory.getMap(DIRECTORY_ARCHIVED_RECORDS_KEY).set(proposal.uuid, true);
    expect(rig.instance.store.isIndexed(proposal.uuid)).toBe(false);

    getMetaMap(rig.instance.replicas.replica(proposal.uuid).doc).set("status", "decided");
    expect((await rig.ok("search", { query: "archiveworthy" })).hits.map((hit: any) => hit.uuid).sort()).toEqual([first.uuid, proposal.uuid].sort());
    expect((await rig.ok("list_docs", { kind: "decision" })).docs).toMatchObject([{ inForce: proposal.uuid }]);
    expect((await rig.ok("list_docs", { kind: "decision", include_superseded: true, include_deleted: true })).docs
      .find((entry: any) => entry.uuid === proposal.uuid)).not.toHaveProperty("deleted");
    expect((await rig.ok("set_metadata", { uuid: proposal.uuid, description: "Live answer" })).applied).toBe(true);
    const rival = await record(rig, { supersedes: first.uuid });
    directory.getMap(DIRECTORY_ARCHIVED_RECORDS_KEY).set(first.uuid, true);
    expect(rig.instance.store.isIndexed(first.uuid)).toBe(false);
    directory.getMap(DIRECTORY_ARCHIVED_RECORDS_KEY).set(rival.uuid, true);
    getMetaMap(rig.instance.replicas.replica(rival.uuid).doc).set("status", "decided");
    const topic = (await rig.ok("list_docs", { kind: "decision" })).docs[0];
    expect(topic.inForce).toBeNull();
    expect([...topic.conflicts].sort()).toEqual([proposal.uuid, rival.uuid].sort());
    expect((await rig.ok("get_doc", { uuid: proposal.uuid })).resolution.conflicts).toMatchObject([{ deleted: false }, { deleted: false }]);
    const records = (await rig.ok("list_docs", { kind: "decision", include_superseded: true, include_deleted: true })).docs;
    expect(records.find((entry: any) => entry.uuid === first.uuid).deleted).toBe(true);
    expect(records.find((entry: any) => entry.uuid === proposal.uuid)).not.toHaveProperty("deleted");
    expect(records.find((entry: any) => entry.uuid === rival.uuid)).not.toHaveProperty("deleted");
    expect(rig.instance.store.isIndexed(proposal.uuid)).toBe(true);
    expect(rig.instance.store.isIndexed(rival.uuid)).toBe(true);
    getMetaMap(rig.instance.replicas.replica(rival.uuid).doc).set("status", "rejected");
    getMetaMap(rig.instance.replicas.replica(proposal.uuid).doc).set("status", "rejected");
    expect((await rig.ok("list_docs", { kind: "decision" })).docs).toMatchObject([{ inForce: first.uuid }]);
    expect(rig.instance.store.isIndexed(first.uuid)).toBe(true);
  });
});

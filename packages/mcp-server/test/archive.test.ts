/**
 * Archiving a document: what stops seeing it, what keeps seeing it, and what
 * comes back.
 *
 * The tombstone itself belongs to the schema package — that a tombstone is
 * sticky, and that restoring is the one thing that lifts it, are pinned in
 * `packages/schema/test/directory.test.ts`. What this suite defends is the tool
 * contract an agent actually relies on: archiving removes a document from
 * discovery and from search without touching a byte of it, and restoring is a
 * true reversal.
 */

import { afterAll, afterEach, describe, expect, it } from "vitest";
import {
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

  override indexDoc(doc: IndexedDoc): void {
    this.indexAttempts += 1;
    if (this.failEveryIndex || this.failNextIndex) {
      this.failNextIndex = false;
      throw new Error("simulated index failure");
    }
    this.indexed.push(doc.uuid);
    super.indexDoc(doc);
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
    tags: ["reference"],
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
      tags: ["reference"],
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
      ["set_tags", { uuid: doc.uuid, tags: ["retired"] }],
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
    expect(read.tags).toEqual(["reference"]);
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
      tags: ["reference"],
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
      store.indexDoc({ uuid, title: "stale", tags: [], description: "", links: [], body: "" });
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
    store.indexDoc({
      uuid: doc.uuid,
      title: "stale",
      tags: [],
      description: "",
      links: [],
      body: "",
    });
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
    setTags(rig.instance.replicas.replica(doc.uuid).doc, ["retired"]);
    await rig.ok("restore_doc", { uuid: doc.uuid });

    const listed = await rig.ok("list_docs");
    expect(listed.docs.find((entry: any) => entry.uuid === doc.uuid)).toEqual({
      uuid: doc.uuid,
      title: "Concepts",
      tags: ["retired"],
      description: "A test document.",
      pinned: false,
      createdAt: expect.any(Number),
      updatedAt: expect.any(Number),
    });
  });
});

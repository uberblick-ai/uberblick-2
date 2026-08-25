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
  tombstoneDirectoryEntry,
  upsertDirectoryEntry,
} from "@uberblick/schema";
import {
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

  override unindexDoc(uuid: string): void {
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
      deleted: true,
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
    const store = new CountingStore(tempDatabasePath());
    const rig = await startServer(testConfig(), store);
    rigs.push(rig);

    const renamed = await seedDoc(rig);
    const bystander = await rig.ok("create_doc", { title: "Untouched" });

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
    });

    const hits = await rig.ok("search", { query: "glossary" });
    expect(hits.hits.map((hit: any) => hit.uuid)).toEqual([doc.uuid]);
  });

  it("reports a refused index write as not indexed, and retries it", async () => {
    const store = new CountingStore(tempDatabasePath());
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
    const store = new CountingStore(tempDatabasePath());
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

  // The unindex in adoptKnownDocs runs on every settle, outside the drain. Left
  // unguarded, a store refusing it turned a stale row into an error from every
  // unrelated tool.
  it("survives a refused unindex during adoption", async () => {
    const store = new CountingStore(tempDatabasePath());
    const rig = await startServer(testConfig(), store);
    rigs.push(rig);

    const doc = await seedDoc(rig);
    await rig.ok("archive_doc", { uuid: doc.uuid });

    // The tombstone is already reconciled and off the queue, so the next
    // settle's adoption pass is what meets the refusal.
    store.failUnindex = true;
    const listed = await rig.call("list_docs", {});
    expect(listed.isError).toBe(false);
    expect(listed.payload.docs).toEqual([]);

    const searched = await rig.call("search", { query: "glossary" });
    expect(searched.isError).toBe(false);
  });

  it("republishes metadata that changed while the document was archived", async () => {
    const rig = await localRig();
    const doc = await seedDoc(rig);
    await rig.ok("archive_doc", { uuid: doc.uuid });

    // Editing an archived document is allowed, and its stub does not follow:
    // stub repair rides document updates, and those stop at the tombstone. The
    // directory would otherwise keep serving the tags it was archived with
    // while search answers from the new ones — divergence with no way back.
    await rig.ok("set_tags", { uuid: doc.uuid, tags: ["retired"] });
    await rig.ok("restore_doc", { uuid: doc.uuid });

    const listed = await rig.ok("list_docs");
    expect(listed.docs.find((entry: any) => entry.uuid === doc.uuid)).toEqual({
      uuid: doc.uuid,
      title: "Concepts",
      tags: ["retired"],
    });
  });
});

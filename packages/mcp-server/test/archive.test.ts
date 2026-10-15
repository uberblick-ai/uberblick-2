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

import { WORKSPACE, removeTempDirs, startServer, tempDatabasePath, testConfig, waitUntil } from "./helpers.js";
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

const rigs: Rig[] = [];

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

describe("restore_doc", () => {

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

});

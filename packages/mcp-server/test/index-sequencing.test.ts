/** Derived-index generations stay monotone and atomic across processes. */

import { constants, DatabaseSync } from "node:sqlite";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { editBlock, getBlocks, getDirectoryEntry, getMeta, setDescription, setTitle, setWorkspaceName, upsertDirectoryEntry } from "@uberblick/schema";
import {
  removeTempDirs,
  startServer,
  tempDatabasePath,
  testConfig,
} from "./helpers.js";
import type { Rig } from "./helpers.js";

const rigs: Rig[] = [];
const SQLITE_BUSY = 5;

async function server(databasePath: string): Promise<Rig> {
  const rig = await startServer(testConfig({ databasePath }));
  rigs.push(rig);
  return rig;
}

afterEach(async () => {
  for (const rig of rigs.splice(0)) await rig.close();
});

afterAll(removeTempDirs);

describe("the index derivation cut", () => {
  it("retries content rejected by a newer directory cut after idle peer catch-up", async () => {
    const databasePath = tempDatabasePath();
    const first = await server(databasePath);
    const created = await first.ok("create_doc", {
      title: "Stable title", description: "Stable metadata.", blocks: [{ type: "paragraph", text: "Oldbody" }],
    });
    const unrelated = await first.ok("create_doc", { title: "Unrelated", description: "Another page." });
    const second = await server(databasePath);
    await second.ok("get_doc", { uuid: created.uuid });
    first.instance.replicas.refresh();
    second.instance.replicas.refresh();
    expect(second.instance.replicas.indexReconciled(created.uuid)).toBe(true);

    const replica = second.instance.replicas.replica(created.uuid);
    const directory = second.instance.replicas.directory();
    const readSince = second.instance.store.readSince.bind(second.instance.store);
    let directoryReads = 0;
    let injected = false;
    const replay = vi.spyOn(second.instance.store, "readSince").mockImplementation((room, seq) => {
      const slice = readSince(room, seq);
      // A peer can advance the shared directory and rederive rows after this
      // process's directory poll but before its document poll.
      if (room === directory.room && ++directoryReads === 2 && !injected) {
        injected = true;
        const firstDirectory = first.instance.replicas.directory().doc;
        upsertDirectoryEntry(firstDirectory, { ...getDirectoryEntry(firstDirectory, unrelated.uuid)!, title: "Unrelated changed" });
        setWorkspaceName(first.instance.replicas.settings().doc, "A peer settings change");
        const block = getBlocks(replica.doc)[0]!;
        editBlock(replica.doc, block.id, block.text, "Newbody", { rev: block.rev });
      }
      return slice;
    });
    try {
      second.instance.replicas.refresh();
    } finally {
      replay.mockRestore();
    }
    expect(injected).toBe(true);
    expect(getBlocks(replica.doc)[0]?.text).toBe("Newbody");
    expect(replica.lastSeq).toBe(replica.indexedThroughSeq);
    expect(second.instance.store.search("Newbody", 10)).toEqual([]);
    expect(second.instance.replicas.indexReconciled(created.uuid)).toBe(false);

    second.instance.replicas.refresh();
    second.instance.replicas.refresh();
    expect(second.instance.store.search("Newbody", 10)).toMatchObject([{ uuid: created.uuid }]);
    expect(second.instance.store.search("Oldbody", 10)).toEqual([]);
    expect(second.instance.replicas.indexReconciled(created.uuid)).toBe(true);
    second.instance.replicas.refresh();
    expect(second.instance.replicas.indexReconciled(created.uuid)).toBe(true);
  });

  it("replays the missing prefix before indexing its own later append", async () => {
    const databasePath = tempDatabasePath();
    const first = await server(databasePath);
    const created = await first.ok("create_doc", {
      title: "Baseline",
      description: "A test document.",
    });
    await first.ok("get_doc", { uuid: created.uuid });

    const second = await server(databasePath);
    await second.ok("get_doc", { uuid: created.uuid });

    const firstReplica = first.instance.replicas.replica(created.uuid);
    const secondReplica = second.instance.replicas.replica(created.uuid);
    const settledCut = firstReplica.lastSeq;
    expect(firstReplica.indexedThroughSeq).toBe(settledCut);

    // Process B appends N+1. Process A deliberately does not settle, then
    // appends N+2 on a different metadata field. Its Y.Doc must replay B's row
    // before it derives rows bearing the later cut.
    setDescription(secondReplica.doc, "written-by-the-second-process");
    const secondCut = secondReplica.indexedThroughSeq;
    expect(secondCut).toBeGreaterThan(settledCut);
    expect(firstReplica.indexedThroughSeq).toBe(settledCut);

    setTitle(firstReplica.doc, "Merged title");

    // `lastSeq` remains poll-owned: the index-only catch-up does not change the
    // pending-room release or compaction watermark.
    expect(firstReplica.lastSeq).toBe(settledCut);
    expect(firstReplica.indexedThroughSeq).toBeGreaterThan(secondCut);
    expect(getMeta(firstReplica.doc)).toEqual(
      expect.objectContaining({
        title: "Merged title",
        description: "written-by-the-second-process",
      }),
    );

    const db = new DatabaseSync(databasePath, { readOnly: true });
    const indexed = db
      .prepare(
        "SELECT indexed_through_seq AS seq FROM doc_index_seq WHERE uuid = ?",
      )
      .get(created.uuid) as { seq: number };
    const latest = db
      .prepare("SELECT MAX(seq) AS seq FROM updates WHERE room = ?")
      .get(firstReplica.room) as { seq: number };
    db.close();

    expect(indexed.seq).toBe(latest.seq);
    expect(first.instance.store.search("second-process", 10)).toEqual([
      expect.objectContaining({
        uuid: created.uuid,
        title: "Merged title",
      }),
    ]);
  });

  it("rebuilds a complete index when another process derives at the same cut", async () => {
    const databasePath = tempDatabasePath();
    const first = await server(databasePath);
    const target = await first.ok("create_doc", {
      title: "Target",
      description: "A test document.",
    });
    const created = await first.ok("create_doc", {
      title: "Race winner",
      description: "A test document.",
      tags: ["auth"],
      blocks: [{ type: "paragraph", text: "searchable pangolin" }],
    });
    await first.ok("set_metadata", {
      uuid: created.uuid,
      links: [target.uuid],
    });

    const second = await server(databasePath);
    const replica = first.instance.replicas.replica(created.uuid);
    const cut = replica.indexedThroughSeq;
    const firstDb = (first.instance.store as unknown as { db: DatabaseSync })
      .db;
    const secondDb = (second.instance.store as unknown as { db: DatabaseSync })
      .db;
    secondDb.exec("PRAGMA busy_timeout = 0");

    // Pause the clear after its marker delete. A peer writer must be refused
    // until the complete clear transaction commits; the
    // rebuild then writes the same cut as one complete generation.
    let attempted = false;
    firstDb.setAuthorizer((action, table) => {
      if (
        !attempted &&
        action === constants.SQLITE_DELETE &&
        table === "doc_tags"
      ) {
        attempted = true;
        try {
          second.instance.store.indexDoc(
            {
              uuid: created.uuid,
              title: "Race winner",
              description: "A test document.",
              tags: ["00000000-0000-4000-8000-000000000001"],
              links: [target.uuid],
              body: "searchable pangolin",
            },
            cut,
          );
        } catch (error) {
          const errcode = (error as { errcode?: unknown } | null)?.errcode;
          if (errcode !== SQLITE_BUSY) {
            throw error;
          }
        }
      }
      return constants.SQLITE_OK;
    });

    try {
      first.instance.replicas.rebuildIndex();
    } finally {
      firstDb.setAuthorizer(null);
    }
    expect(attempted).toBe(true);

    const db = new DatabaseSync(databasePath, { readOnly: true });
    const count = (table: string, column = "uuid"): number =>
      Number(
        (
          db
            .prepare(
              `SELECT COUNT(*) AS n FROM ${table} WHERE ${column} = ?`,
            )
            .get(created.uuid) as { n: number }
        ).n,
      );
    expect({
      doc_index: count("doc_index"),
      doc_index_seq: count("doc_index_seq"),
      doc_tags: count("doc_tags"),
      doc_links: count("doc_links", "source"),
      docs_fts: count("docs_fts"),
    }).toEqual({
      doc_index: 1,
      doc_index_seq: 1,
      doc_tags: 1,
      doc_links: 1,
      docs_fts: 1,
    });
    db.close();

    expect(first.instance.store.search("pangolin", 10)).toEqual([
      expect.objectContaining({
        uuid: created.uuid,
        tags: ["00000000-0000-4000-8000-000000000001"],
      }),
    ]);
  });
});

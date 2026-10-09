/** Derived-index generations stay monotone and atomic across processes. */

import { constants, DatabaseSync } from "node:sqlite";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import { getMeta, setDescription, setTitle } from "@uberblick/schema";
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

    // Pause the clear after its marker delete has executed, at the exact
    // boundary where the old autocommit script admitted another writer. Under
    // one transaction that writer is refused until the clear commits; the
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

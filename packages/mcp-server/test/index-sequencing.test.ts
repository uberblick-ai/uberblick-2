/**
 * A local write after another process's unseen write must not certify an
 * incomplete document as the newest index derivation.
 */

import { DatabaseSync } from "node:sqlite";
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
});

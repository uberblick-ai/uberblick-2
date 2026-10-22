/** Search rows remain derived from live documents and current catalog names. */

import { DatabaseSync } from "node:sqlite";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import * as Y from "yjs";
import { getMeta, getMetaMap } from "@uberblick/schema";

import { MirrorStore } from "../src/store.js";
import { hubUrl, LIVE_HUB_SETTLE, removeTempDirs, startHub, startServer, tempDatabasePath, testConfig, TEST_SECRET, waitUntil, WORKSPACE } from "./helpers.js";
import type { Rig, TestHub } from "./helpers.js";

const rigs = new Set<Rig>();
const hubs = new Set<TestHub>();

async function local(databasePath = tempDatabasePath(), store?: MirrorStore): Promise<Rig> {
  const rig = await startServer(testConfig({ databasePath }), store);
  rigs.add(rig);
  return rig;
}

async function close(rig: Rig): Promise<void> {
  await rig.close();
  rigs.delete(rig);
}

function sourceRows(databasePath: string) {
  const db = new DatabaseSync(databasePath, { readOnly: true });
  try {
    return {
      updates: db.prepare("SELECT * FROM updates ORDER BY seq").all(),
      snapshots: db.prepare("SELECT * FROM snapshots ORDER BY room").all(),
    };
  } finally {
    db.close();
  }
}

afterEach(async () => {
  for (const rig of rigs) await rig.close();
  rigs.clear();
  for (const hub of hubs) await hub.stop();
  hubs.clear();
});
afterAll(removeTempDirs);

describe("replica search derivation", () => {
  it("syncs a topic rename and searches pre-existing records without rewriting their titles", async () => {
    const hub = await startHub();
    hubs.add(hub);
    const config = () => testConfig({ hubUrl: hubUrl(hub.port), authSecret: TEST_SECRET, ...LIVE_HUB_SETTLE });
    const writer = await startServer(config());
    rigs.add(writer);
    const first = await writer.ok("create_doc", {
      title: "Orchard", description: "A question.", kind: "decision", status: "decided",
      blocks: [{ type: "paragraph", text: "Keep the current choice." }],
    });
    const successor = await writer.ok("create_doc", {
      kind: "decision", description: "A proposal.", supersedes: first.uuid,
    });
    expect(await writer.instance.replicas.waitForSettled()).toMatchObject({ caughtUp: true });
    const reader = await startServer(config());
    rigs.add(reader);
    expect(await reader.instance.replicas.waitForSettled()).toMatchObject({ caughtUp: true });
    expect((await reader.ok("search", { query: "orchard" })).hits).toHaveLength(2);
    const successorDoc = reader.instance.replicas.replica(successor.uuid).doc;
    const before = Y.encodeStateAsUpdate(successorDoc);
    const firstApproval = getMetaMap(reader.instance.replicas.replica(first.uuid).doc).get("approvalFingerprint");

    await writer.ok("set_metadata", { uuid: successor.uuid, title: "Meadow" });
    expect(await writer.instance.replicas.waitForSettled()).toMatchObject({ caughtUp: true });
    await waitUntil("the renamed first record", () => getMeta(reader.instance.replicas.replica(first.uuid).doc).title === "Meadow");
    expect(await reader.instance.replicas.waitForSettled()).toMatchObject({ caughtUp: true });
    expect((await reader.ok("search", { query: "orchard" })).hits).toEqual([]);
    const hits = (await reader.ok("search", { query: "meadow" })).hits;
    expect(hits.map((hit: { uuid: string }) => hit.uuid).sort()).toEqual([first.uuid, successor.uuid].sort());
    expect(hits.every((hit: { title: string }) => hit.title === "Meadow")).toBe(true);
    expect(reader.instance.store.searchUuids("mead").sort()).toEqual([first.uuid, successor.uuid].sort());
    expect(reader.instance.store.searchUuids("orch")).toEqual([]);
    expect((await reader.ok("get_doc", { uuid: successor.uuid })).title).toBe("Meadow");
    expect(getMeta(successorDoc).title).toBe("Orchard");
    expect(Y.encodeStateAsUpdate(successorDoc)).toEqual(before);
    expect(getMetaMap(reader.instance.replicas.replica(first.uuid).doc).get("approvalFingerprint")).toBe(firstApproval);
  });

  it("upgrades an old index at unchanged log cuts without rewriting logs, snapshots or documents", async () => {
    const databasePath = tempDatabasePath();
    const first = await local(databasePath);
    const live = await first.ok("create_doc", {
      title: "Upgrade fixture",
      description: "A live page indexed before the upgrade.",
      tags: ["auth"],
      blocks: [{ type: "paragraph", text: "Launching the new search." }],
    });
    const decision = await first.ok("create_doc", {
      title: "Can we keep launching?",
      description: "A retained decision record.",
      kind: "decision",
      blocks: [{ type: "paragraph", text: "Keep the live corpus searchable." }],
    });
    const archived = await first.ok("create_doc", {
      title: "Archived upgrade fixture",
      description: "An archived page stays out.",
      tags: ["auth"],
      blocks: [{ type: "paragraph", text: "Launching an archived fixture." }],
    });
    await first.ok("archive_doc", { uuid: archived.uuid });
    const replica = first.instance.replicas.replica(live.uuid);
    first.instance.store.clearPending(replica.room, replica.indexedThroughSeq);
    first.instance.store.compact(replica.room, Y.encodeStateAsUpdate(replica.doc), replica.indexedThroughSeq);
    const before = sourceRows(databasePath);
    expect(before.snapshots).not.toHaveLength(0);
    expect(before.updates).not.toHaveLength(0);
    await close(first);

    const legacy = new DatabaseSync(databasePath);
    try {
      legacy.exec("CREATE TEMP TABLE legacy_search_rows AS SELECT uuid, title, description || char(10) || body AS body FROM docs_fts");
      legacy.exec("DROP TABLE docs_fts");
      legacy.exec("CREATE VIRTUAL TABLE docs_fts USING fts5(uuid UNINDEXED, title, body)");
      legacy.exec("INSERT INTO docs_fts SELECT uuid, title, body FROM legacy_search_rows");
      legacy.exec("DROP TABLE legacy_search_rows");
      legacy.exec("ALTER TABLE doc_index DROP COLUMN kind");
      legacy.exec("ALTER TABLE doc_index_seq DROP COLUMN search_rowid");
    } finally {
      legacy.close();
    }

    // Search still answers immediately after migration, before rooms have replayed.
    const store = new MirrorStore(databasePath, WORKSPACE);
    expect(store.search("launch", 100).map(hit => hit.uuid).sort()).toEqual([live.uuid, decision.uuid].sort());
    const reopened = await local(databasePath, store);
    expect((await reopened.ok("search", { query: "auth" })).hits).toMatchObject([
      { uuid: live.uuid, kind: "regular" },
    ]);
    expect((await reopened.ok("search", { query: "launch", kind: "decision" })).hits).toMatchObject([
      { uuid: decision.uuid, kind: "decision" },
    ]);
    expect((await reopened.ok("search", { query: "launch" })).hits.map((hit: { uuid: string }) => hit.uuid).sort()).toEqual([live.uuid, decision.uuid].sort());
    expect(sourceRows(databasePath)).toEqual(before);

    await close(reopened);
    const secondOpen = await local(databasePath);
    expect((await secondOpen.ok("search", { query: "auth" })).hits).toMatchObject([
      { uuid: live.uuid, kind: "regular" },
    ]);
    expect(sourceRows(databasePath)).toEqual(before);
    await secondOpen.ok("restore_doc", { uuid: archived.uuid });
    expect((await secondOpen.ok("search", { query: "auth" })).hits.map((hit: { uuid: string }) => hit.uuid).sort()).toEqual([live.uuid, archived.uuid].sort());
  });
});

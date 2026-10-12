/** Search rows remain derived from live documents and current catalog names. */

import { DatabaseSync } from "node:sqlite";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import * as Y from "yjs";
import {
  createTagCatalogEntry,
  getMetaMap,
  getTagCatalogIdentities,
  retireTagCatalogEntry,
  setTags,
} from "@uberblick/schema";
import { MirrorStore } from "../src/store.js";
import {
  removeTempDirs,
  startServer,
  tempDatabasePath,
  testConfig,
  WORKSPACE,
} from "./helpers.js";
import type { Rig } from "./helpers.js";

const rigs = new Set<Rig>();
const UNKNOWN_TAG = "b1dbad6b-9c62-47a4-9e36-6923b04eae91";

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
});
afterAll(removeTempDirs);

describe("replica search derivation", () => {
  it("searches the tag names shown on hits and refreshes them without a document write", async () => {
    const rig = await local();
    const catalog = rig.instance.replicas.settings().doc;
    const tag = createTagCatalogEntry(catalog, "orchard");
    const created = await rig.ok("create_doc", {
      title: "Catalog example",
      description: "A page whose subject exists only in its assigned tag.",
      tags: [tag.id],
    });
    const document = rig.instance.replicas.replica(created.uuid);
    const before = Y.encodeStateAsUpdate(document.doc);
    const count = rig.instance.store.updateCount(document.room);

    expect((await rig.ok("search", { query: "orchard" })).hits).toMatchObject([
      { uuid: created.uuid, tags: [{ id: tag.id, name: "orchard", state: "active" }] },
    ]);
    getTagCatalogIdentities(catalog).set(tag.id, "grove");
    expect((await rig.ok("search", { query: "orchard" })).hits).toEqual([]);
    expect((await rig.ok("search", { query: "grove" })).hits).toMatchObject([
      { uuid: created.uuid, tags: [{ id: tag.id, name: "grove", state: "active" }] },
    ]);
    retireTagCatalogEntry(catalog, tag.id);
    expect((await rig.ok("search", { query: "grove" })).hits).toMatchObject([
      { uuid: created.uuid, tags: [{ id: tag.id, name: "grove", state: "retired" }] },
    ]);
    expect(Y.encodeStateAsUpdate(document.doc)).toEqual(before);
    expect(rig.instance.store.updateCount(document.room)).toBe(count);

    setTags(document.doc, [UNKNOWN_TAG]);
    expect((await rig.ok("search", { query: "grove" })).hits).toEqual([]);
    expect((await rig.ok("search", { query: UNKNOWN_TAG })).hits).toEqual([]);
    expect((await rig.ok("search", { query: "Catalog" })).hits).toMatchObject([
      { uuid: created.uuid, tags: [{ id: UNKNOWN_TAG, name: null, state: "unresolved" }] },
    ]);
  });

  it("normalizes stored requirements as regular while indexing decision questions separately", async () => {
    const rig = await local();
    const regular = await rig.ok("create_doc", {
      title: "Starting guide",
      description: "A regular page.",
    });
    const formerRequirement = await rig.ok("create_doc", {
      title: "Starting proposal",
      description: "A stored legacy document.",
    });
    getMetaMap(rig.instance.replicas.replica(formerRequirement.uuid).doc).set("kind", "requirement");
    const decision = await rig.ok("create_doc", {
      title: "Should we start?",
      description: "The topic question is the searchable title.",
      kind: "decision",
      blocks: [{ type: "paragraph", text: "Keep the current approach." }],
    });

    const regularHits = rig.instance.store.search("start", 10, undefined, "regular");
    expect(regularHits.map(hit => hit.uuid).sort()).toEqual([regular.uuid, formerRequirement.uuid].sort());
    expect(regularHits.every(hit => hit.kind === "regular")).toBe(true);
    expect(rig.instance.store.search("start", 10, undefined, "decision")).toMatchObject([
      { uuid: decision.uuid, kind: "decision", title: "Should we start?" },
    ]);
  });

  it("does not reintroduce an archived document on catalog changes and searches its current name after restore", async () => {
    const rig = await local();
    const catalog = rig.instance.replicas.settings().doc;
    const tag = createTagCatalogEntry(catalog, "meadow");
    const created = await rig.ok("create_doc", {
      title: "Hidden catalog example",
      description: "A page whose searchable tag changes while archived.",
      tags: [tag.id],
      blocks: [{ type: "paragraph", text: "Launching a local fixture." }],
    });
    const document = rig.instance.replicas.replica(created.uuid).doc;
    const before = Y.encodeStateAsUpdate(document);
    await rig.ok("archive_doc", { uuid: created.uuid });
    getTagCatalogIdentities(catalog).set(tag.id, "pasture");
    expect((await rig.ok("search", { query: "launch meadow pasture" })).hits).toEqual([]);

    await rig.ok("restore_doc", { uuid: created.uuid });
    expect((await rig.ok("search", { query: "meadow" })).hits).toEqual([]);
    expect((await rig.ok("search", { query: "pasture" })).hits).toMatchObject([
      { uuid: created.uuid, kind: "regular", tags: [{ id: tag.id, name: "pasture" }] },
    ]);
    expect(Y.encodeStateAsUpdate(document)).toEqual(before);
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
      legacy.exec("ALTER TABLE doc_index_seq DROP COLUMN search_indexed");
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

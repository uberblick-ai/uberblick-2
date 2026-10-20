/** Search rows remain derived from live documents and current catalog names. */

import { afterAll, afterEach, describe, expect, it } from "vitest";
import * as Y from "yjs";
import { createTagCatalogEntry, getMeta, getMetaMap, getTagCatalogIdentities, retireTagCatalogEntry, setTags } from "@uberblick/schema";
import type { MirrorStore } from "../src/store.js";
import { removeTempDirs, startServer, testConfig } from "./core-helpers.js";
import type { Rig } from "./core-helpers.js";

const rigs = new Set<Rig>();
const UNKNOWN_TAG = "b1dbad6b-9c62-47a4-9e36-6923b04eae91";

async function local(databasePath = ":memory:", store?: MirrorStore): Promise<Rig> {
  const rig = await startServer(testConfig({ databasePath }), store);
  rigs.add(rig);
  return rig;
}

afterEach(async () => {
  for (const rig of rigs) await rig.close();
  rigs.clear();
});
afterAll(removeTempDirs);

describe("replica search derivation", () => {
  it("reindexes every record after renaming only the first record", async () => {
    const rig = await local();
    const first = await rig.ok("create_doc", {
      title: "Orchard", description: "A question.", kind: "decision", status: "decided",
      blocks: [{ type: "paragraph", text: "Keep the current choice." }],
    });
    const successor = await rig.ok("create_doc", {
      description: "An alternative.", kind: "decision", supersedes: first.uuid,
    });
    const room = rig.instance.replicas.replica(successor.uuid);
    const before = Y.encodeStateAsUpdate(room.doc);
    const count = rig.instance.store.updateCount(room.room);
    await rig.ok("set_metadata", { uuid: successor.uuid, title: "Meadow" });
    expect((await rig.ok("search", { query: "orchard" })).hits).toEqual([]);
    expect((await rig.ok("search", { query: "meadow" })).hits.map((hit: { uuid: string }) => hit.uuid).sort())
      .toEqual([first.uuid, successor.uuid].sort());
    expect(rig.instance.store.searchUuids("mead").sort()).toEqual([first.uuid, successor.uuid].sort());
    expect(rig.instance.store.searchUuids("orch")).toEqual([]);
    expect(getMeta(room.doc).title).toBe("Orchard");
    expect(Y.encodeStateAsUpdate(room.doc)).toEqual(before);
    expect(rig.instance.store.updateCount(room.room)).toBe(count);
  });

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

});

/** Search rows remain derived from live documents and current catalog names. */

import { afterAll, afterEach, describe, expect, it } from "vitest";
import * as Y from "yjs";
import { createTagCatalogEntry, deleteTagCatalogEntry, findBlockElement, getMeta, getMetaMap, getTagCatalogIdentities, insertBlock, setTags } from "@uberblick/schema";
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
  it("finds languages without prose mentions, including fence names and decision answers", async () => {
    const rig = await local();
    const created = await rig.ok("create_doc", {
      title: "Source samples", description: "A page of examples.", tags: ["auth"],
      blocks: [
        { type: "code", language: "wireframe", text: "page" },
        { type: "code", language: "ts", text: "const answer = 42" },
        { type: "code", language: "Écoles", text: "sample" },
        { type: "code", language: "launching", text: "sample" },
        { type: "code", language: "customlang", text: "sample" },
        { type: "chart", text: "{}" },
        { type: "terminal", text: "echo example" },
      ],
    });
    const decision = await rig.ok("create_doc", {
      title: "Which approach?", description: "A proposed answer.", kind: "decision",
      blocks: [{ type: "code", language: "ablauf", text: "flow v0" }],
    });

    for (const query of ["wireframe", "ts", "ecole", "launch", "customlang", "chart", "terminal", "wire*", "unmatched wireframe"]) {
      expect((await rig.ok("search", { query })).hits, query).toMatchObject([{ uuid: created.uuid }]);
    }
    expect((await rig.ok("search", { query: "typescript code" })).hits).toEqual([]);
    expect((await rig.ok("search", { query: "wireframe", tag: "auth", kind: "regular" })).hits).toMatchObject([{ uuid: created.uuid }]);
    expect((await rig.ok("search", { query: "wireframe", kind: "decision" })).hits).toEqual([]);
    expect((await rig.ok("search", { query: "ablauf", kind: "decision" })).hits).toMatchObject([{ uuid: decision.uuid }]);
    expect(rig.instance.store.searchUuids("wire")).toEqual([created.uuid]);
    expect(rig.instance.store.searchUuids("ts")).toEqual([created.uuid]);

    await rig.ok("update_data", { uuid: created.uuid, operations: [{
      collection: "samples", schema: { version: 1, schema: { type: "object" } },
      upsert: [{ id: "one", value: { text: "quartzrecordvalue" } }],
    }] });
    expect((await rig.ok("search", { query: "quartzrecordvalue" })).hits).toEqual([]);
  });

  it("tracks language-only edits, remaining blocks and archive visibility", async () => {
    const rig = await local();
    const created = await rig.ok("create_doc", {
      title: "Source sample", description: "A page of examples.",
      blocks: [
        { type: "code", language: "wireframe", text: "unchanged source" },
        { type: "code", language: "wireframe", text: "other source" },
      ],
    });
    const document = rig.instance.replicas.replica(created.uuid).doc;
    findBlockElement(document, created.blocks[0].id)!.setAttribute("language", "ablauf");
    expect((await rig.ok("search", { query: "wireframe" })).hits).toMatchObject([{ uuid: created.uuid }]);
    expect((await rig.ok("search", { query: "ablauf" })).hits).toMatchObject([{ uuid: created.uuid }]);
    expect((await rig.ok("get_doc", { uuid: created.uuid })).blocks[0]).toMatchObject({ text: "unchanged source", language: "ablauf" });

    await rig.ok("delete_block", { uuid: created.uuid, block_id: created.blocks[1].id });
    expect((await rig.ok("search", { query: "wireframe" })).hits).toEqual([]);
    expect(rig.instance.store.searchUuids("wire")).toEqual([]);
    expect(rig.instance.store.searchUuids("ablauf")).toEqual([created.uuid]);

    await rig.ok("archive_doc", { uuid: created.uuid });
    expect((await rig.ok("search", { query: "ablauf" })).hits).toEqual([]);
    expect(rig.instance.store.searchUuids("ablauf")).toEqual([]);
    await rig.ok("restore_doc", { uuid: created.uuid });
    expect((await rig.ok("search", { query: "ablauf" })).hits).toMatchObject([{ uuid: created.uuid }]);
    findBlockElement(document, created.blocks[0].id)!.setAttribute("language", "");
    expect((await rig.ok("search", { query: "ablauf" })).hits).toEqual([]);
    expect(rig.instance.store.searchUuids("ablauf")).toEqual([]);
    expect((await rig.ok("search", { query: "unchanged" })).hits).toMatchObject([{ uuid: created.uuid }]);
  });

  it("indexes callout prose without its variant or icon", async () => {
    const rig = await local();
    const created = await rig.ok("create_doc", { title: "Passage", description: "A prose fixture." });
    const document = rig.instance.replicas.replica(created.uuid).doc;
    insertBlock(document, null, { type: "callout", variant: "warning", icon: ":claude:", text: "Orchard harvest" });

    expect((await rig.ok("search", { query: "harvest" })).hits).toMatchObject([{ uuid: created.uuid }]);
    expect((await rig.ok("search", { query: "warning claude callout" })).hits).toEqual([]);
  });

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
      { uuid: created.uuid, tags: [{ id: tag.id, name: "orchard" }] },
    ]);
    getTagCatalogIdentities(catalog).set(tag.id, "grove");
    expect((await rig.ok("search", { query: "orchard" })).hits).toEqual([]);
    expect((await rig.ok("search", { query: "grove" })).hits).toMatchObject([
      { uuid: created.uuid, tags: [{ id: tag.id, name: "grove" }] },
    ]);
    deleteTagCatalogEntry(catalog, tag.id);
    expect((await rig.ok("search", { query: "grove" })).hits).toEqual([]);
    expect(Y.encodeStateAsUpdate(document.doc)).toEqual(before);
    expect(rig.instance.store.updateCount(document.room)).toBe(count);

    setTags(document.doc, [UNKNOWN_TAG]);
    expect((await rig.ok("search", { query: "grove" })).hits).toEqual([]);
    expect((await rig.ok("search", { query: UNKNOWN_TAG })).hits).toEqual([]);
    expect((await rig.ok("search", { query: "Catalog" })).hits).toMatchObject([
      { uuid: created.uuid, tags: [] },
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

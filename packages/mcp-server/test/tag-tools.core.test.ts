import { afterEach, describe, expect, it } from "vitest";
import * as Y from "yjs";
import { createTagCatalogEntry, deleteTagCatalogEntry, getMeta, setTags, settingsRoom } from "@uberblick/schema";
import { FailingStore, cleanupTestResources, startServer, testConfig, WORKSPACE } from "./core-helpers.js";
import type { Rig } from "./core-helpers.js";

const rigs: Rig[] = [];
const UNKNOWN = "33333333-3333-4333-8333-333333333333";

async function local(store?: FailingStore): Promise<Rig> {
  const rig = await startServer(testConfig(), store);
  rigs.push(rig);
  return rig;
}

afterEach(async () => {
  await cleanupTestResources({ clients: rigs.splice(0).map((rig) => () => rig.close()) });
});

describe("explicit tag catalog writes", () => {
  it("normalizes and reuses names without overwriting guidance or assigning documents", async () => {
    const rig = await local();
    const created = await rig.ok("create_doc", { title: "Unchanged document", description: "Catalog writes leave assignments alone.", tags: ["auth"] });
    const doc = rig.instance.replicas.replica(created.uuid).doc;
    setTags(doc, [...getMeta(doc).tags, UNKNOWN]);
    const before = Y.encodeStateAsUpdate(doc);
    const directory = Y.encodeStateAsUpdate(rig.instance.replicas.directory().doc);
    const tag = await rig.ok("create_tag", { name: " Release ", description: " Use for release coordination. " });
    expect(tag).toEqual({ id: expect.any(String), name: "release", description: "Use for release coordination.", applied: true, synced: false, hub: expect.objectContaining({ status: "disabled" }) });
    const size = rig.instance.store.logSize();
    expect(await rig.ok("create_tag", { name: "RELEASE", description: "A replacement must be explicit." })).toEqual(tag);
    expect(await rig.ok("create_tag", { name: "release" })).toEqual(tag);
    expect(rig.instance.store.logSize()).toBe(size);
    expect((await rig.ok("list_tags")).tags).toContainEqual({ id: tag.id, name: tag.name, description: tag.description });
    expect(Y.encodeStateAsUpdate(doc)).toEqual(before);
    expect(Y.encodeStateAsUpdate(rig.instance.replicas.directory().doc)).toEqual(directory);

    expect((await rig.ok("set_metadata", { uuid: created.uuid, tags: [tag.id] })).tags)
      .toEqual([{ id: tag.id, name: tag.name, description: tag.description }]);
    const assigned = await rig.ok("create_doc", { title: "Newly assignable", description: "An explicitly created category.", tags: ["RELEASE"] });
    expect(assigned.tags).toEqual([{ id: tag.id, name: tag.name, description: tag.description }]);
    expect((await rig.call("set_metadata", { uuid: created.uuid, tags: ["missing"] })).payload)
      .toMatchObject({ error: "invalid_tag_assignment", applied: false, partial: false, synced: false });
    expect((await rig.ok("list_tags")).tags.some((entry: { name: string }) => entry.name === "missing")).toBe(false);
  });

  it("edits canonical guidance through an alias, skips identical writes and clears with null or blank", async () => {
    const rig = await local();
    const catalog = rig.instance.replicas.settings().doc;
    const alias = "ffffffff-ffff-4fff-8fff-ffffffffffff";
    const canonical = "11111111-1111-4111-8111-111111111111";
    createTagCatalogEntry(catalog, "release", alias, "Old guidance");
    const created = await rig.ok("create_doc", { title: "Alias assignment", description: "Catalog editing keeps stored assignments.", tags: [alias] });
    const doc = rig.instance.replicas.replica(created.uuid).doc;
    const before = Y.encodeStateAsUpdate(doc);
    const peer = new Y.Doc();
    createTagCatalogEntry(peer, "release", canonical);
    Y.applyUpdate(catalog, Y.encodeStateAsUpdate(peer));
    peer.destroy();
    for (const description of ["x".repeat(300), null, "Restored guidance", "   "]) {
      const edited = await rig.ok("edit_tag", { id: alias, description });
      expect(edited).toMatchObject({ id: canonical, name: "release", applied: true });
      const expected = description === null || description.trim() === "" ? {} : { description };
      expect((await rig.ok("list_tags")).tags).toContainEqual({ id: canonical, name: "release", ...expected });
      if (!("description" in expected)) expect(edited).not.toHaveProperty("description");
      const size = rig.instance.store.logSize();
      expect(await rig.ok("edit_tag", { id: alias, description })).toEqual(edited);
      expect(rig.instance.store.logSize()).toBe(size);
      expect(Y.encodeStateAsUpdate(doc)).toEqual(before);
    }
    expect(getMeta(doc).tags).toEqual([alias]);
  });

  it("refuses invalid values and undeclared fields before changing any state", async () => {
    const rig = await local();
    const tag = await rig.ok("create_tag", { name: "release", description: "Existing guidance" });
    const deleted = await rig.ok("create_tag", { name: "deleted" });
    deleteTagCatalogEntry(rig.instance.replicas.settings().doc, deleted.id);
    const before = Y.encodeStateAsUpdate(rig.instance.replicas.settings().doc);
    const size = rig.instance.store.logSize();
    const cases: [string, Record<string, unknown>, string][] = [
      ...["", "bad name", "bad--name", "x".repeat(31)].map(name => ["create_tag", { name }, "invalid_tag_name"] as [string, Record<string, unknown>, string]),
      ...["line\nbreak", "line\rbreak", "line\u2028break", "line\u2029break", "x".repeat(301)].flatMap(description => [
        ["create_tag", { name: "release", description }, "invalid_tag_description"],
        ["edit_tag", { id: tag.id, description }, "invalid_tag_description"],
      ] as [string, Record<string, unknown>, string][]),
      ...[UNKNOWN, deleted.id, "release"].map(id => ["edit_tag", { id, description: "Must refuse" }, "invalid_tag_identity"] as [string, Record<string, unknown>, string]),
      ["create_tag", { name: "new", rename: "other" }, "schema_validation"],
      ["create_tag", { description: "No name" }, "schema_validation"],
      ["create_tag", { name: 5 }, "schema_validation"],
      ["create_tag", { name: "new", description: 5 }, "schema_validation"],
      ["edit_tag", { id: tag.id }, "schema_validation"],
      ["edit_tag", { id: tag.id, description: "Valid", name: "new" }, "schema_validation"],
      ["edit_tag", { id: tag.id, description: 5 }, "schema_validation"],
    ];
    for (const [name, args, error] of cases) {
      const result = await rig.call(name, args);
      expect(result.isError, JSON.stringify(args)).toBe(true);
      expect(result.payload, JSON.stringify(args)).toMatchObject({ error });
      if (error !== "schema_validation") expect(result.payload).toMatchObject({ applied: false, partial: false, synced: false, recovery: expect.any(String) });
      expect(Y.encodeStateAsUpdate(rig.instance.replicas.settings().doc)).toEqual(before);
      expect(rig.instance.store.logSize()).toBe(size);
    }
    expect((await rig.ok("create_tag", { name: "X".repeat(30), description: ` ${"x".repeat(300)} ` })).name).toBe("x".repeat(30));
  });

  it.each(["create_tag", "edit_tag"])("does not claim durability when %s cannot append to the settings log", async name => {
    const store = new FailingStore(":memory:", WORKSPACE);
    const rig = await local(store);
    const tag = await rig.ok("create_tag", { name: "release" });
    store.failing = true;
    store.failRoom = room => room === settingsRoom(WORKSPACE);
    const refused = await rig.call(name, name === "create_tag" ? { name: "another" } : { id: tag.id, description: "Changed" });
    expect(refused).toMatchObject({ isError: true, payload: {
      error: "persistence_failed", applied: false, partial: false, synced: false, room: settingsRoom(WORKSPACE),
    } });
    expect((await rig.call("list_tags")).payload.error).toBe("persistence_failed");
    expect((await rig.ok("sync_status")).persistence).toMatchObject({ room: settingsRoom(WORKSPACE) });
  });
});

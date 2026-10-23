import { randomUUID } from "node:crypto";
import { getDirectoryMap, getMetaMap } from "@uberblick/schema";
import * as Y from "yjs";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import { removeTempDirs, startServer, testConfig } from "./core-helpers.js";
import type { Rig } from "./core-helpers.js";

const rigs = new Set<Rig>();
afterEach(async () => {
  for (const rig of rigs) await rig.close();
  rigs.clear();
});
afterAll(removeTempDirs);

async function local(databasePath = ":memory:") {
  const rig = await startServer(testConfig({ databasePath }));
  rigs.add(rig);
  return rig;
}

function storeLegacyPair(rig: Rig, uuid: string, status: string | undefined) {
  const doc = rig.instance.replicas.replica(uuid).doc;
  doc.transact(() => {
    getMetaMap(doc).set("kind", "requirement");
    if (status !== undefined) getMetaMap(doc).set("status", status);
  });
  const directory = getDirectoryMap(rig.instance.replicas.directory().doc);
  directory.set(uuid, {
    ...(directory.get(uuid) as Record<string, unknown>),
    kind: "requirement",
    ...(status === undefined ? {} : { status }),
  });
}

function expectLegacyPair(rig: Rig, uuid: string, status: string | undefined) {
  const meta = getMetaMap(rig.instance.replicas.replica(uuid).doc);
  expect(meta.get("kind")).toBe("requirement");
  expect(meta.get("status")).toBe(status);
}

describe("stored requirement documents", () => {

  it("lists raw live and archived stubs as regular pages without opening their rooms", async () => {
    const rig = await local();
    const directory = getDirectoryMap(rig.instance.replicas.directory().doc);
    const live = randomUUID();
    const archived = randomUUID();
    directory.set(live, { title: "Only a stub", tags: [], kind: "requirement", status: "planned" });
    directory.set(archived, { title: "Archived stub", tags: [], kind: "requirement", deleted: true });
    const raw = Y.encodeStateAsUpdate(rig.instance.replicas.directory().doc);
    expect((await rig.ok("list_docs")).docs.map((entry: any) => entry.uuid)).toEqual([live]);
    const all = (await rig.ok("list_docs", { include_deleted: true })).docs;
    expect(all.map((entry: any) => entry.uuid).sort()).toEqual([live, archived].sort());
    for (const entry of all) {
      expect(entry).not.toHaveProperty("kind");
      expect(entry).not.toHaveProperty("status");
      expect(rig.instance.replicas.hydrated(entry.uuid)).toBe(false);
    }
    expect(Y.encodeStateAsUpdate(rig.instance.replicas.directory().doc)).toEqual(raw);
  });

  it("accepts regular writes, relationships, archive, restore and block deletion while keeping raw fields until decision adoption", async () => {
    const rig = await local();
    const page = await rig.ok("create_doc", {
      title: "Former requirement", description: "An editable regular page.", tldr: "Existing summary.",
      blocks: [{ type: "paragraph", text: "Existing answer." }],
    });
    storeLegacyPair(rig, page.uuid, "done");
    const decision = await rig.ok("create_doc", {
      title: "New topic", description: "Former requirements qualify as regular targets.",
      kind: "decision", related: page.uuid, discussion: page.uuid,
    });
    expect(decision).toMatchObject({ related: [page.uuid], discussion: page.uuid });
    await rig.ok("set_metadata", { uuid: page.uuid, title: "Renamed proposal", tags: ["rfc"] });
    const edited = await rig.ok("edit_block", {
      uuid: page.uuid, block_id: page.blocks[0].id, old_text: "Existing answer.",
      new_text: "Edited answer.", rev: page.blocks[0].rev,
    });
    await rig.ok("annotate", { uuid: page.uuid, block_id: edited.block.id, start: 0, end: 6, text: "New comment." });
    const extra = await rig.ok("insert_block", { uuid: page.uuid, blocks: [{ type: "paragraph", text: "Temporary answer." }] });
    await rig.ok("delete_block", { uuid: page.uuid, block_id: extra.blocks[0].id });
    await rig.ok("update_data", {
      uuid: page.uuid, operations: [{ collection: "notes", schema: { version: 1, schema: { type: "object", properties: { text: { type: "string" } }, required: ["text"] } }, upsert: [{ id: "one", value: { text: "Editable data." } }] }],
    });
    expectLegacyPair(rig, page.uuid, "done");
    const content = await rig.ok("get_doc", { uuid: page.uuid });
    await rig.ok("archive_doc", { uuid: page.uuid });
    expect((await rig.ok("list_docs")).docs).toEqual([]);
    const archived = (await rig.ok("list_docs", { include_deleted: true })).docs[0];
    expect(archived).toMatchObject({ uuid: page.uuid, deleted: true });
    expect(archived).not.toHaveProperty("kind");
    expect(await rig.ok("get_doc", { uuid: page.uuid })).toEqual(content);
    await rig.ok("restore_doc", { uuid: page.uuid });
    expect(await rig.ok("get_doc", { uuid: page.uuid })).toEqual(content);
    expectLegacyPair(rig, page.uuid, "done");

    const doc = rig.instance.replicas.replica(page.uuid).doc;
    await rig.ok("set_metadata", { uuid: page.uuid, tldr: null });
    const raw = Y.encodeStateAsUpdate(doc);
    expect((await rig.call("set_status", { uuid: page.uuid, status: "decided" })).payload.error).toBe("decision_data_unsupported");
    expect(Y.encodeStateAsUpdate(doc)).toEqual(raw);
    expectLegacyPair(rig, page.uuid, "done");
    await rig.ok("update_data", { uuid: page.uuid, operations: [{ collection: "notes", deleteCollection: true }] });
    expect(await rig.ok("set_status", { uuid: page.uuid, status: "decided" })).toMatchObject({ kind: "decision", status: "decided", agentStance: true });
    expect(getMetaMap(doc).get("kind")).toBe("decision");
    expect(getMetaMap(doc).get("status")).toBe("decided");
  });
});

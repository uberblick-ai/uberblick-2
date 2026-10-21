
import { getDirectoryMap, getMetaMap } from "@uberblick/schema";
import * as Y from "yjs";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import { removeTempDirs, startServer, tempDatabasePath, testConfig } from "./helpers.js";
import type { Rig } from "./helpers.js";

const rigs = new Set<Rig>();
afterEach(async () => {
  for (const rig of rigs) await rig.close();
  rigs.clear();
});
afterAll(removeTempDirs);

async function local(databasePath = tempDatabasePath()) {
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
  // No reader branches on a requirement's status value, only on its presence.
  it.each([undefined, "draft"])("projects a stored %s lifecycle through reads and offline restart without changing its room", async status => {
    const databasePath = tempDatabasePath();
    const rig = await local(databasePath);
    const target = await rig.ok("create_doc", { title: "Link target", description: "A regular link target." });
    const page = await rig.ok("create_doc", {
      title: "Existing proposal", description: "Existing document metadata.",
      tldr: "Keep all existing content and context.", tags: ["rfc"],
      blocks: [{ type: "paragraph", text: "Existing proposal content." }],
    });
    await rig.ok("set_metadata", { uuid: page.uuid, links: [target.uuid] });
    await rig.ok("update_data", {
      uuid: page.uuid, operations: [{
        collection: "notes", schema: { version: 1, schema: { type: "object", properties: { text: { type: "string" } }, required: ["text"] } },
        upsert: [{ id: "existing", value: { text: "Stored structured value." } }],
      }],
    });
    await rig.ok("annotate", { uuid: page.uuid, block_id: page.blocks[0].id, start: 0, end: 8, text: "Existing comment." });
    const decision = await rig.ok("create_doc", {
      title: "Existing decision", description: "The proposal's retained history.",
      kind: "decision", related: page.uuid, discussion: page.uuid,
      blocks: [{ type: "paragraph", text: "Preserve the existing relationships." }],
    });
    const before = await rig.ok("get_doc", { uuid: page.uuid });
    const dataBefore = await rig.ok("get_data", { uuid: page.uuid, collection: "notes" });
    const backlinksBefore = await rig.ok("backlinks", { uuid: page.uuid });
    const exportBefore = await rig.ok("export_markdown", { uuid: page.uuid, annotations: "html-comments" });
    expect(before.decisions).toMatchObject([{ topic: decision.uuid, relation: "related" }]);
    storeLegacyPair(rig, page.uuid, status);
    const doc = rig.instance.replicas.replica(page.uuid).doc;
    const raw = Y.encodeStateAsUpdate(doc);
    const count = rig.instance.store.updateCount(rig.instance.replicas.replica(page.uuid).room);

    expect(await rig.ok("get_doc", { uuid: page.uuid })).toEqual(before);
    expect(await rig.ok("get_data", { uuid: page.uuid, collection: "notes" })).toEqual(dataBefore);
    expect(await rig.ok("backlinks", { uuid: page.uuid })).toEqual(backlinksBefore);
    expect(await rig.ok("export_markdown", { uuid: page.uuid, annotations: "html-comments" })).toEqual(exportBefore);
    expect(exportBefore.markdown).not.toMatch(/^(kind|status):/m);
    const listed = (await rig.ok("list_docs")).docs.find((entry: any) => entry.uuid === page.uuid);
    expect(listed).toMatchObject({ title: page.title, description: page.description, tags: page.tags });
    expect(listed).not.toHaveProperty("kind");
    expect(listed).not.toHaveProperty("status");
    expect(Y.encodeStateAsUpdate(doc)).toEqual(raw);
    expect(rig.instance.store.updateCount(rig.instance.replicas.replica(page.uuid).room)).toBe(count);
    expectLegacyPair(rig, page.uuid, status);

    await rig.close();
    rigs.delete(rig);
    const restarted = await local(databasePath);
    expect(await restarted.ok("get_doc", { uuid: page.uuid })).toEqual(before);
    expect(Y.encodeStateAsUpdate(restarted.instance.replicas.replica(page.uuid).doc)).toEqual(raw);
    expectLegacyPair(restarted, page.uuid, status);
  });

});

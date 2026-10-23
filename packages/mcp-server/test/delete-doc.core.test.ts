import { afterEach, describe, expect, it } from "vitest";
import { getMetaMap, isDirectoryEntryDeleted, pinDoc, readSidebar, tombstoneDirectoryEntry, upsertDirectoryEntry } from "@uberblick/schema";
import * as Y from "yjs";
import { readBlocks, startServer, testConfig } from "./core-helpers.js";
import type { Rig } from "./core-helpers.js";

const rigs: Rig[] = [];
afterEach(async () => { for (const rig of rigs.splice(0)) await rig.close(); });
async function local(): Promise<Rig> {
  const rig = await startServer(testConfig());
  rigs.push(rig);
  return rig;
}
async function seed(rig: Rig) {
  return rig.ok("create_doc", {
    title: "Disposable glossary", description: "A document for permanent deletion.",
    blocks: [{ type: "paragraph", text: "Erase this glossary." }],
  });
}

describe("delete_doc", () => {
  it("purges an archived document, hides stale pins and preserves other documents' stored links", async () => {
    const rig = await local();
    const target = await seed(rig);
    const source = await rig.ok("create_doc", {
      title: "References", description: "Links must stay stored after deletion.",
      blocks: [{ type: "paragraph", inline: [{ text: "Glossary", marks: { docLink: target.uuid } }] }],
    });
    await rig.ok("set_metadata", { uuid: source.uuid, links: [target.uuid] });
    await rig.ok("set_metadata", { uuid: target.uuid, links: [source.uuid] });
    await rig.ok("update_data", { uuid: target.uuid, operations: [{ collection: "runs", schema: { version: 1, schema: { type: "object", properties: { secret: { type: "string" } }, additionalProperties: false } }, upsert: [{ id: "one", value: { secret: "erase" } }] }] });
    const block = target.blocks[0];
    await rig.ok("annotate", { uuid: target.uuid, block_id: block.id, start: 0, end: 5, text: "Erase this comment too." });
    const before = await rig.ok("get_doc", { uuid: source.uuid });
    await rig.ok("archive_doc", { uuid: target.uuid });
    const deleted = await rig.ok("delete_doc", { uuid: target.uuid });
    expect(deleted).toMatchObject({ uuid: target.uuid, title: "Disposable glossary", records: [target.uuid], deleted: true, applied: true, synced: false });
    expect(deleted.rooms.map((room: { purpose: string }) => room.purpose)).toEqual(["directory", "sidebar"]);
    const { replicas, store } = rig.instance;
    expect(isDirectoryEntryDeleted(replicas.directory().doc, target.uuid)).toBe(true);
    expect(store.hasRoom(`${rig.config.workspaceId}/${target.uuid}`)).toBe(false);
    expect(await rig.ok("get_doc", { uuid: source.uuid })).toEqual(before);
    expect(getMetaMap(replicas.replica(source.uuid).doc).get("links")).toEqual([target.uuid]);
    expect((await rig.ok("backlinks", { uuid: source.uuid })).backlinks).toEqual([]);
    expect((await rig.ok("list_docs", { include_deleted: true })).docs.map((doc: { uuid: string }) => doc.uuid)).not.toContain(target.uuid);
    expect((await rig.ok("search", { query: "glossary" })).hits.map((doc: { uuid: string }) => doc.uuid)).not.toContain(target.uuid);
    const sidebar = replicas.sidebar();
    const group = (await rig.ok("pin_doc", { uuid: source.uuid, group: "Reference" })).group.id;
    pinDoc(sidebar.doc, group, target.uuid);
    expect((await rig.ok("get_sidebar")).groups.flatMap((entry: { docs: unknown[] }) => entry.docs)).not.toEqual(expect.arrayContaining([expect.objectContaining({ uuid: target.uuid })]));
    expect((await rig.ok("unpin_doc", { uuid: target.uuid })).unpinned).toBe(true);
    expect(readSidebar(sidebar.doc).flatMap(entry => entry.docs)).not.toContain(target.uuid);
    expect((await rig.ok("unpin_doc", { uuid: target.uuid })).unpinned).toBe(false);
    expect(replicas.known(target.uuid)).toBe(false);
    expect(store.hasRoom(`${rig.config.workspaceId}/${target.uuid}`)).toBe(false);
    await rig.ok("set_metadata", { uuid: source.uuid, links: [target.uuid], description: "Existing target retained." });
  });

  it("refuses every named access and new reference with doc_deleted without writing", async () => {
    const rig = await local();
    const target = await seed(rig);
    const source = await seed(rig);
    const [block] = await readBlocks(rig, target.uuid, target.blocks);
    await rig.ok("archive_doc", { uuid: target.uuid });
    await rig.ok("delete_doc", { uuid: target.uuid });
    const uuid = target.uuid;
    const calls: [string, Record<string, unknown>][] = [
      ["get_doc", { uuid }], ["get_data", { uuid }], ["export_markdown", { uuid }], ["backlinks", { uuid }],
      ["set_metadata", { uuid, title: "Return" }], ["set_status", { uuid, status: "open" }],
      ["insert_block", { uuid, blocks: [{ text: "Return", type: "paragraph" }] }],
      ["edit_block", { uuid, block_id: block.id, old_text: block.text, new_text: "Return", rev: block.rev }],
      ["delete_block", { uuid, block_id: block.id }], ["update_data", { uuid, operations: [] }],
      ["annotate", { uuid, block_id: block.id, start: 0, end: 1, text: "Return" }],
      ["link_range", { uuid, block_id: block.id, start: 0, end: 1, doc_id: source.uuid, rev: block.rev }],
      ["archive_doc", { uuid }], ["restore_doc", { uuid }], ["delete_doc", { uuid }],
      ["pin_doc", { uuid, group: "Must not exist" }],
      ["set_metadata", { uuid: source.uuid, title: "Atomic refusal", links: [uuid] }],
      ["create_doc", { title: "Refused reference", description: "Must not be created.", kind: "decision", related: uuid }],
      ["create_doc", { title: "Refused predecessor", description: "Must not be created.", kind: "decision", supersedes: uuid }],
      ["create_doc", { title: "Refused discussion", description: "Must not be created.", kind: "decision", discussion: uuid }],
      ["create_doc", { title: "Refused inline link", description: "Must not be created.", blocks: [{ type: "paragraph", inline: [{ text: "Deleted", marks: { docLink: uuid } }] }] }],
    ];
    const directory = rig.instance.replicas.directory().doc;
    const before = Y.encodeStateAsUpdate(directory);
    const logSize = rig.instance.store.logSize();
    for (const [name, args] of calls) {
      expect(await rig.call(name, args), name).toMatchObject({ isError: true, payload: { error: "doc_deleted", recoveryClass: "manual" } });
      expect(rig.instance.store.logSize(), name).toBe(logSize);
    }
    expect(Y.encodeStateAsUpdate(directory)).toEqual(before);
  });

  it("requires archive, refuses decision records and can delete an archived stub without joining it", async () => {
    const rig = await local();
    const doc = await seed(rig);
    const size = rig.instance.store.logSize();
    expect(await rig.call("delete_doc", { uuid: doc.uuid })).toMatchObject({ isError: true, payload: { error: "doc_not_archived", applied: false, partial: false, synced: false } });
    expect(rig.instance.store.logSize()).toBe(size);
    const decision = await rig.ok("create_doc", { title: "Which deletion scope?", description: "A decision record.", kind: "decision" });
    await rig.ok("archive_doc", { uuid: decision.uuid });
    const decisionSize = rig.instance.store.logSize();
    expect(await rig.call("delete_doc", { uuid: decision.uuid })).toMatchObject({ isError: true, payload: { error: "decision_delete_unsupported", applied: false } });
    expect(rig.instance.store.logSize()).toBe(decisionSize);
    const uuid = "11111111-1111-4111-8111-111111111111";
    const replicas = rig.instance.replicas;
    upsertDirectoryEntry(replicas.directory().doc, { uuid, title: "Unhydrated" });
    tombstoneDirectoryEntry(replicas.directory().doc, uuid);
    expect((await rig.ok("delete_doc", { uuid })).title).toBe("Unhydrated");
    expect(replicas.known(uuid)).toBe(false);
  });
});

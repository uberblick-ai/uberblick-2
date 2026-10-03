import { randomUUID } from "node:crypto";
import * as Y from "yjs";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import { getDirectoryEntry, getDirectoryMap, getMetaMap, listDirectory, upsertDirectoryEntry } from "@uberblick/schema";
import { FailingStore, removeTempDirs, startServer, tempDatabasePath, testConfig, WORKSPACE } from "./helpers.js";
import type { Rig } from "./helpers.js";

const rigs: Rig[] = [];
const stores: FailingStore[] = [];
afterEach(async () => { for (const rig of rigs.splice(0)) await rig.close(); for (const store of stores.splice(0)) store.close(); });
afterAll(removeTempDirs);
async function localRig() { const rig = await startServer(testConfig()); rigs.push(rig); return rig; }
const blocks = [{ type: "heading", text: "Reconsidering", level: 2 }, { type: "paragraph", text: "If constraints change." }];
async function decision(rig: Rig, fields: Record<string, unknown> = {}) {
  return rig.ok("create_doc", { title: "Topic", description: "A decision record.", kind: "decision", blocks, ...fields });
}
function rawDeleted(rig: Rig, uuid: string, deleted: boolean) {
  const map = getDirectoryMap(rig.instance.replicas.directory().doc);
  map.set(uuid, { ...(map.get(uuid) as Record<string, unknown>), deleted });
}

describe("decision topics through directory stubs", () => {
  it("copies write-once topic identity and stores governing links without writing the requirement", async () => {
    const rig = await localRig();
    const requirement = await rig.ok("create_doc", { title: "Product", description: "Product direction.", kind: "requirement" });
    const before = Y.encodeStateAsUpdate(rig.instance.replicas.replica(requirement.uuid).doc);
    const first = await decision(rig, { governs: requirement.uuid });
    const next = await decision(rig, { supersedes: first.uuid, governs: requirement.uuid });
    expect(first.topic).toBe(first.uuid);
    expect(next.topic).toBe(first.uuid);
    expect(Y.encodeStateAsUpdate(rig.instance.replicas.replica(requirement.uuid).doc)).toEqual(before);
    expect(getMetaMap(rig.instance.replicas.replica(next.uuid).doc).get("governs")).toBe(requirement.uuid);
    expect((await rig.call("create_doc", { title: "Invalid", description: "Caller topic is forbidden.", kind: "decision", topic: first.uuid })).isError).toBe(true);
    const adopted = await rig.ok("create_doc", { title: "Adopted", description: "Becomes a decision through status." });
    await rig.ok("set_status", { uuid: adopted.uuid, status: "open" });
    expect((await rig.ok("get_doc", { uuid: adopted.uuid })).topic).toBe(adopted.uuid);
  });

  it("resolves the full fork with rejected intermediates and never hydrates the other decision rooms", async () => {
    const rig = await localRig();
    const requirement = await rig.ok("create_doc", { title: "Product", description: "Product direction.", kind: "requirement" });
    const a = await decision(rig, { status: "decided", governs: requirement.uuid });
    const [b, c, d, e, f] = [randomUUID(), randomUUID(), randomUUID(), randomUUID(), randomUUID()] as const;
    const directory = rig.instance.replicas.directory().doc;
    for (const entry of [
      { uuid: b, status: "rejected", supersedes: a.uuid },
      { uuid: c, status: "decided", supersedes: a.uuid },
      { uuid: d, status: "decided", supersedes: b, tags: ["00000000-0000-4000-8000-000000000005"] },
      { uuid: e, status: "open", supersedes: d },
      { uuid: f, status: "open", supersedes: e },
    ] as const) upsertDirectoryEntry(directory, { title: "Foreign record", kind: "decision", topic: a.uuid, governs: requirement.uuid, createdAt: 1, ...entry, tags: [...(entry.tags ?? [])] });
    rawDeleted(rig, d, true);
    const rows = (await rig.ok("list_docs", { kind: "decision", tag: "sync" })).docs;
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ topic: a.uuid, inForce: null, pending: [{ uuid: f }] });
    expect(rows[0].conflicts.map((record: any) => record.uuid).sort()).toEqual([c, d].sort());
    expect(rows[0].superseded).toBeUndefined();
    const combined = (await rig.ok("list_docs", { kind: "decision", status: "open", tag: "sync" })).docs;
    expect(combined).toMatchObject([{ topic: a.uuid, inForce: null, pending: [{ uuid: f }] }]);
    expect(combined[0].conflicts.map((record: any) => record.uuid).sort()).toEqual([c, d].sort());
    expect((await rig.ok("list_docs", { kind: "decision", status: "open", tag: "sync", include_superseded: true })).docs).toEqual([]);
    const read = await rig.ok("get_doc", { uuid: a.uuid });
    expect(read.successors.map((record: any) => [record.uuid, record.status]).sort()).toEqual([[b, "rejected"], [c, "decided"]].sort());
    expect(read.resolution.inForce).toBeNull();
    expect(read.resolution.conflicts.map((record: any) => record.uuid).sort()).toEqual([c, d].sort());
    expect((await rig.ok("get_doc", { uuid: requirement.uuid })).decisions).toMatchObject([{ topic: a.uuid, inForce: null }]);
    const exported = (await rig.ok("export_markdown", { uuid: requirement.uuid })).markdown;
    expect(exported).toContain(c);
    expect(exported).toContain(d);
    expect(exported).toContain("nothing in force");
    expect((await rig.ok("list_docs", { kind: "decision", status: "rejected" })).docs).toEqual([]);
    expect((await rig.ok("list_docs", { kind: "decision", status: "rejected", include_superseded: true })).docs).toMatchObject([{ uuid: b }]);
    expect((await rig.ok("list_docs", { kind: "decision", include_superseded: true })).docs).toHaveLength(6);
    for (const uuid of [b, c, d, e, f]) expect(rig.instance.replicas.hydrated(uuid)).toBe(false);
  });

  it("uses only the first tombstone for listing, read-only refusal and derived log; archive and restore affect all records", async () => {
    const rig = await localRig();
    const requirement = await rig.ok("create_doc", { title: "Product", description: "Product direction.", kind: "requirement" });
    const a = await decision(rig, { status: "decided", governs: requirement.uuid });
    const b = await decision(rig, { status: "decided", supersedes: a.uuid, governs: requirement.uuid });
    rawDeleted(rig, b.uuid, true);
    expect((await rig.ok("search", { query: "constraints" })).hits.map((hit: any) => hit.uuid).sort()).toEqual([a.uuid, b.uuid].sort());
    expect((await rig.ok("list_docs", { kind: "decision" })).docs).toMatchObject([{ uuid: b.uuid, inForce: { uuid: b.uuid } }]);
    await rig.ok("set_tldr", { uuid: b.uuid, tldr: "The answer." });
    expect(getDirectoryEntry(rig.instance.replicas.directory().doc, b.uuid)?.tldr).toBe("The answer.");
    expect((await rig.ok("list_docs", { kind: "decision" })).docs[0].inForce.deleted).toBe(false);
    rawDeleted(rig, a.uuid, true);
    rawDeleted(rig, b.uuid, false);
    expect((await rig.ok("list_docs", { kind: "decision" })).docs).toEqual([]);
    expect((await rig.ok("get_doc", { uuid: requirement.uuid })).decisions).toEqual([]);
    expect((await rig.ok("search", { query: "constraints" })).hits).toEqual([]);
    expect((await rig.call("set_title", { uuid: b.uuid, title: "Refused" })).payload.error).toBe("doc_archived");
    expect((await rig.ok("get_doc", { uuid: b.uuid })).resolution).toMatchObject({ inForce: { uuid: b.uuid }, archived: true });
    const restored = await rig.ok("restore_doc", { uuid: b.uuid });
    expect(restored.records.sort()).toEqual([a.uuid, b.uuid].sort());
    expect(restored.rooms.map((room: any) => room.purpose)).toEqual(["directory"]);
    expect((await rig.ok("search", { query: "constraints" })).hits.map((hit: any) => hit.uuid).sort()).toEqual([a.uuid, b.uuid].sort());
    expect(listDirectory(rig.instance.replicas.directory().doc)).toHaveLength(3);
    const archived = await rig.ok("archive_doc", { uuid: b.uuid });
    expect(archived.records.sort()).toEqual([a.uuid, b.uuid].sort());
    expect(archived.rooms.map((room: any) => room.purpose)).toEqual(["directory", "sidebar"]);
    for (const uuid of [a.uuid, b.uuid]) expect(getDirectoryEntry(rig.instance.replicas.directory().doc, uuid)?.deleted).toBe(true);
    expect((await rig.ok("list_docs", { kind: "decision", include_deleted: true })).docs).toMatchObject([{ inForce: { uuid: b.uuid }, deleted: true }]);
  });

  it("lists a rejected or withdrawn first proposal even with no live records", async () => {
    const rig = await localRig();
    const rejected = await decision(rig, { status: "rejected" });
    const withdrawn = await decision(rig, { status: "withdrawn" });
    const rows = (await rig.ok("list_docs", { kind: "decision" })).docs;
    expect(rows.map((row: any) => row.uuid).sort()).toEqual([rejected.uuid, withdrawn.uuid].sort());
    for (const row of rows) expect(row).toMatchObject({ inForce: null, pending: [], conflicts: [] });
    expect((await rig.ok("list_docs", { status: "rejected" })).docs).toEqual([]);
  });

  it("reports topic archive and restore persistence failures per touched room", async () => {
    const databasePath = tempDatabasePath();
    const store = new FailingStore(databasePath, WORKSPACE);
    stores.push(store);
    const rig = await startServer(testConfig({ databasePath }), store);
    rigs.push(rig);
    const a = await decision(rig);
    const b = await decision(rig, { supersedes: a.uuid });
    store.failRoom = room => room === `${WORKSPACE}/_sidebar`;
    store.failing = true;
    const refused = await rig.call("archive_doc", { uuid: b.uuid });
    expect(refused.payload).toMatchObject({ error: "persistence_failed", partial: true, rolledBack: false, failed: { purpose: "sidebar" }, completed: [{ purpose: "directory", applied: true }] });
    await rig.close();
    rigs.splice(rigs.indexOf(rig), 1);
    const restartedStore = new FailingStore(databasePath, WORKSPACE);
    stores.push(restartedStore);
    const restarted = await startServer(testConfig({ databasePath }), restartedStore);
    rigs.push(restarted);
    expect((await restarted.ok("list_docs", { kind: "decision" })).docs).toEqual([]);
    restartedStore.failRoom = room => room === `${WORKSPACE}/_directory`;
    restartedStore.failing = true;
    const restore = await restarted.call("restore_doc", { uuid: b.uuid });
    expect(restore.payload).toMatchObject({ error: "persistence_failed", partial: false, rolledBack: false, failed: { purpose: "directory" }, completed: [] });
  });

  it("repairs all decision cache fields including comments and preserves them in directory-only writes", async () => {
    const rig = await localRig();
    const record = await decision(rig);
    const doc = rig.instance.replicas.replica(record.uuid).doc;
    doc.transact(() => {
      getMetaMap(doc).set("agentStance", false);
      getMetaMap(doc).set("decidedBy", "A person");
      getMetaMap(doc).set("decidedAt", "2026-10-04T12:00:00Z");
    });
    await rig.ok("set_tldr", { uuid: record.uuid, tldr: "A concise answer." });
    const opened = await rig.ok("annotate", { uuid: record.uuid, block_id: record.blocks[1].id, start: 0, end: 2, text: "Question" });
    await rig.ok("annotate", { uuid: record.uuid, thread_id: opened.annotation.id, text: "Reply" });
    const directory = rig.instance.replicas.directory().doc;
    expect(getDirectoryEntry(directory, record.uuid)).toMatchObject({ topic: record.uuid, tldr: "A concise answer.", agentStance: false, decidedBy: "A person", decidedAt: "2026-10-04T12:00:00Z", commentCount: 2 });
    upsertDirectoryEntry(directory, { uuid: record.uuid, title: "Directory only" });
    expect(getDirectoryEntry(directory, record.uuid)?.commentCount).toBe(2);
    await rig.ok("archive_doc", { uuid: record.uuid });
    await rig.ok("restore_doc", { uuid: record.uuid });
    expect(getDirectoryEntry(directory, record.uuid)).toMatchObject({ agentStance: false, decidedBy: "A person", commentCount: 2 });
  });
});

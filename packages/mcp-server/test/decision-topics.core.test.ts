import { randomUUID } from "node:crypto";
import * as Y from "yjs";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { getDirectoryEntry, getDirectoryMap, getMetaMap, listDirectory, setTldr, upsertDirectoryEntry } from "@uberblick/schema";
import { type FailingStore, removeTempDirs, startServer, testConfig } from "./core-helpers.js";
import type { Rig } from "./core-helpers.js";

vi.mock("node:crypto", async (importOriginal) => {
  const crypto = await importOriginal<typeof import("node:crypto")>();
  return { ...crypto, randomUUID: vi.fn(crypto.randomUUID) };
});

const rigs: Rig[] = [];
const stores: FailingStore[] = [];
afterEach(async () => { for (const rig of rigs.splice(0)) await rig.close(); for (const store of stores.splice(0)) store.close(); });
afterAll(removeTempDirs);
async function localRig() { const rig = await startServer(testConfig()); rigs.push(rig); return rig; }
const blocks = [{ type: "paragraph", text: "Choose the implementation under these constraints." }];
const answer = { who: "A person", when: "2026-10-04T12:00:00Z", where: "A recorded team discussion." };
async function decision(rig: Rig, fields: Record<string, unknown> = {}) {
  return rig.ok("create_doc", { title: "Topic", description: "A decision record.", kind: "decision", blocks, ...fields });
}
function rawDeleted(rig: Rig, uuid: string, deleted: boolean) {
  const map = getDirectoryMap(rig.instance.replicas.directory().doc);
  map.set(uuid, { ...(map.get(uuid) as Record<string, unknown>), deleted });
}

describe("decision topics through directory stubs", () => {
  it("creates, reads and inherits complete related sets while explicit successors replace only their own set", async () => {
    const rig = await localRig();
    const left = await rig.ok("create_doc", { title: "Left", description: "First owning page." });
    const right = await rig.ok("create_doc", { title: "Right", description: "Second owning page." });
    const third = await rig.ok("create_doc", { title: "Third", description: "Replacement owning page." });
    const pages = [left, right, third];
    const unchanged = pages.map(page => Y.encodeStateAsUpdate(rig.instance.replicas.replica(page.uuid).doc));
    const first = await decision(rig, { status: "decided", related: [left.uuid.toUpperCase(), right.uuid, left.uuid] });
    const next = await decision(rig, { supersedes: first.uuid });
    const replacement = await decision(rig, { supersedes: next.uuid, related: [third.uuid, right.uuid] });
    const inherited = await decision(rig, { supersedes: replacement.uuid });
    const scalar = await decision(rig, { supersedes: first.uuid, related: third.uuid });
    const expected = [
      [first, [left.uuid, right.uuid]], [next, [left.uuid, right.uuid]],
      [replacement, [third.uuid, right.uuid]], [inherited, [third.uuid, right.uuid]],
      [scalar, [third.uuid]],
    ] as const;
    const records = (await rig.ok("list_docs", { kind: "decision", include_superseded: true })).docs;
    for (const [record, related] of expected) {
      // The stored scalar view stays out of answers: `related` names every page.
      for (const answer of [record, await rig.ok("get_doc", { uuid: record.uuid }), records.find((row: any) => row.uuid === record.uuid)]) {
        expect(answer).toMatchObject({ related });
        expect(answer).not.toHaveProperty("governs");
      }
      const before = Y.encodeStateAsUpdate(rig.instance.replicas.replica(record.uuid).doc);
      expect((await rig.call("set_metadata", { uuid: record.uuid, related: [third.uuid] })).payload.error).toBe("schema_validation");
      expect(Y.encodeStateAsUpdate(rig.instance.replicas.replica(record.uuid).doc)).toEqual(before);
    }
    expect((await rig.ok("list_docs", { kind: "decision" })).docs).toMatchObject([
      { uuid: first.uuid, related: [left.uuid, right.uuid] },
    ]);
    for (const page of pages) {
      expect((await rig.ok("get_doc", { uuid: page.uuid })).decisions).toMatchObject([{ topic: first.uuid, relation: "related" }]);
      expect((await rig.ok("backlinks", { uuid: page.uuid })).backlinks.length).toBeGreaterThan(0);
    }
    expect(pages.map(page => Y.encodeStateAsUpdate(rig.instance.replicas.replica(page.uuid).doc))).toEqual(unchanged);
    await rig.ok("set_status", { uuid: next.uuid, status: "rejected", answer, reason: "Another answer remains in force." });
    await rig.ok("set_status", { uuid: inherited.uuid, status: "withdrawn" });
    expect((await rig.ok("get_doc", { uuid: right.uuid })).decisions).toHaveLength(1);
  });

  it("refuses any invalid related target before allocating an identity or writing any room", async () => {
    const rig = await localRig();
    const page = await rig.ok("create_doc", { title: "Page", description: "A valid target." });
    const archived = await rig.ok("create_doc", { title: "Archived", description: "No longer live." });
    const deleted = await rig.ok("create_doc", { title: "Deleted", description: "Permanently removed." });
    const record = await decision(rig);
    await rig.ok("archive_doc", { uuid: archived.uuid });
    await rig.ok("archive_doc", { uuid: deleted.uuid });
    await rig.ok("delete_doc", { uuid: deleted.uuid });
    const unhydrated = randomUUID();
    upsertDirectoryEntry(rig.instance.replicas.directory().doc, { uuid: unhydrated, title: "Unhydrated" });
    const cases = [
      [record.uuid, "related_not_regular_document"], [archived.uuid, "doc_archived"],
      [deleted.uuid, "doc_deleted"], [randomUUID(), "doc_not_found"], [unhydrated, "doc_not_hydrated"],
    ] as const;
    const snapshot = () => ({
      directory: Y.encodeStateAsUpdate(rig.instance.replicas.directory().doc),
      sidebar: Y.encodeStateAsUpdate(rig.instance.replicas.sidebar().doc),
      settings: Y.encodeStateAsUpdate(rig.instance.replicas.settings().doc),
      documents: [page, archived, record].map(doc => Y.encodeStateAsUpdate(rig.instance.replicas.replica(doc.uuid).doc)),
      log: rig.instance.store.logSize(),
    });
    for (const [uuid, error] of cases) {
      const before = snapshot();
      vi.mocked(randomUUID).mockClear();
      const refused = await rig.call("create_doc", { title: "Refused", description: "Nothing created.", kind: "decision", related: [page.uuid, uuid] });
      expect(refused.isError).toBe(true);
      expect(refused.payload).toMatchObject({ error, applied: false, partial: false, synced: false });
      expect(refused.payload.message).toContain(uuid);
      expect(randomUUID).not.toHaveBeenCalled();
      expect(snapshot()).toEqual(before);
    }
    for (const related of [[], [page.uuid, "invalid-uuid"]]) {
      const before = snapshot();
      vi.mocked(randomUUID).mockClear();
      expect((await rig.call("create_doc", { title: "Refused", description: "Invalid set.", kind: "decision", related })).payload.error).toBe("schema_validation");
      expect(randomUUID).not.toHaveBeenCalled();
      expect(snapshot()).toEqual(before);
    }
  });

  it("copies write-once topic identity and stores governing links without writing the page", async () => {
    const rig = await localRig();
    const page = await rig.ok("create_doc", { title: "Product", description: "Product direction." });
    const before = Y.encodeStateAsUpdate(rig.instance.replicas.replica(page.uuid).doc);
    const first = await decision(rig, { related: page.uuid });
    // Released records hold only the scalar relation in their document room.
    getMetaMap(rig.instance.replicas.replica(first.uuid).doc).delete("related");
    expect(await rig.ok("get_doc", { uuid: first.uuid })).toMatchObject({ related: [page.uuid] });
    const next = await decision(rig, { supersedes: first.uuid });
    expect(next.related).toEqual([page.uuid]);
    const otherPage = await rig.ok("create_doc", { title: "Other page", description: "A regular owning page." });
    const redirected = await decision(rig, { supersedes: next.uuid, related: otherPage.uuid });
    const inherited = await decision(rig, { supersedes: redirected.uuid });
    expect(first.topic).toBe(first.uuid);
    expect(next.topic).toBe(first.uuid);
    expect(Y.encodeStateAsUpdate(rig.instance.replicas.replica(page.uuid).doc)).toEqual(before);
    expect(getMetaMap(rig.instance.replicas.replica(next.uuid).doc).get("governs")).toBe(page.uuid);
    for (const record of [redirected, inherited]) {
      expect(record.topic).toBe(first.uuid);
      expect(getMetaMap(rig.instance.replicas.replica(record.uuid).doc).get("governs")).toBe(otherPage.uuid);
    }
    for (const relatedPage of [page, otherPage]) {
      expect((await rig.ok("get_doc", { uuid: relatedPage.uuid })).decisions).toMatchObject([{ topic: first.uuid, relation: "related" }]);
    }
    const stored = Y.encodeStateAsUpdate(rig.instance.replicas.replica(inherited.uuid).doc);
    expect((await rig.call("set_metadata", { uuid: inherited.uuid, related: page.uuid })).payload.error).toBe("schema_validation");
    expect(Y.encodeStateAsUpdate(rig.instance.replicas.replica(inherited.uuid).doc)).toEqual(stored);
    expect((await rig.call("create_doc", { title: "Invalid", description: "Caller topic is forbidden.", kind: "decision", topic: first.uuid })).isError).toBe(true);
    const adopted = await rig.ok("create_doc", { title: "Adopted", description: "Becomes a decision through status." });
    await rig.ok("set_status", { uuid: adopted.uuid, status: "open" });
    expect((await rig.ok("get_doc", { uuid: adopted.uuid })).topic).toBe(adopted.uuid);
  });

  it("resolves the full fork with rejected intermediates and never hydrates the other decision rooms", async () => {
    const rig = await localRig();
    const page = await rig.ok("create_doc", { title: "Product", description: "Product direction." });
    const a = await decision(rig, { status: "decided", related: page.uuid });
    const [b, c, d, e, f] = [randomUUID(), randomUUID(), randomUUID(), randomUUID(), randomUUID()] as const;
    const directory = rig.instance.replicas.directory().doc;
    for (const entry of [
      { uuid: b, status: "rejected", supersedes: a.uuid },
      { uuid: c, status: "decided", supersedes: a.uuid },
      { uuid: d, status: "decided", supersedes: b, tags: ["00000000-0000-4000-8000-000000000005"] },
      { uuid: e, status: "open", supersedes: d },
      { uuid: f, status: "open", supersedes: e },
    ] as const) upsertDirectoryEntry(directory, { title: "Foreign record", kind: "decision", topic: a.uuid, governs: page.uuid, createdAt: 1, ...entry, tags: [...(entry.tags ?? [])] });
    rawDeleted(rig, d, true);
    const rows = (await rig.ok("list_docs", { kind: "decision", tag: "sync" })).docs;
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ topic: a.uuid, inForce: null, pending: [f] });
    expect([...rows[0].conflicts].sort()).toEqual([c, d].sort());
    expect(rows[0].superseded).toBeUndefined();
    const combined = (await rig.ok("list_docs", { kind: "decision", status: "open", tag: "sync" })).docs;
    expect(combined).toMatchObject([{ topic: a.uuid, inForce: null, pending: [f] }]);
    expect([...combined[0].conflicts].sort()).toEqual([c, d].sort());
    expect((await rig.ok("list_docs", { kind: "decision", status: "open", tag: "sync", include_superseded: true })).docs).toEqual([]);
    const read = await rig.ok("get_doc", { uuid: a.uuid });
    expect(read.successors.map((record: any) => [record.uuid, record.status]).sort()).toEqual([[b, "rejected"], [c, "decided"]].sort());
    expect(read.resolution.inForce).toBeNull();
    expect([...read.resolution.conflicts].sort()).toEqual([c, d].sort());
    expect((await rig.ok("get_doc", { uuid: page.uuid })).decisions).toMatchObject([{ topic: a.uuid, inForce: null }]);
    const exported = (await rig.ok("export_markdown", { uuid: page.uuid })).markdown;
    expect(exported).toContain(c);
    expect(exported).toContain(d);
    expect(exported).toContain("nothing in force");
    expect((await rig.ok("list_docs", { kind: "decision", status: "rejected" })).docs).toEqual([]);
    expect((await rig.ok("list_docs", { kind: "decision", status: "rejected", include_superseded: true })).docs).toMatchObject([{ uuid: b }]);
    expect((await rig.ok("list_docs", { kind: "decision", include_superseded: true })).docs).toHaveLength(6);
    for (const uuid of [b, c, d, e, f]) expect(rig.instance.replicas.hydrated(uuid)).toBe(false);
  });

  it("refuses successors into an archived topic before writing any room", async () => {
    const rig = await localRig();
    const first = await decision(rig, { status: "decided" });
    const next = await decision(rig, { supersedes: first.uuid });
    const pinned = await rig.ok("pin_doc", { uuid: next.uuid, group: "Reading" });
    await rig.ok("archive_doc", { uuid: next.uuid });
    // The successor's mirror can be live while the first record still archives the topic.
    rawDeleted(rig, next.uuid, false);
    const directory = rig.instance.replicas.directory().doc;
    const sidebar = rig.instance.replicas.sidebar().doc;
    const beforeDirectory = Y.encodeStateAsUpdate(directory);
    const beforeSidebar = Y.encodeStateAsUpdate(sidebar);
    const beforeLog = rig.instance.store.logSize();
    for (const predecessor of [first.uuid, next.uuid]) {
      const refused = await rig.call("create_doc", {
        title: "Reconsideration", description: "Must restore its topic first.",
        kind: "decision", supersedes: predecessor,
        sidebar: { group: { id: pinned.group.id } },
      });
      expect(refused.isError).toBe(true);
      expect(refused.payload).toMatchObject({ error: "doc_archived", applied: false, partial: false, synced: false });
    }
    expect(Y.encodeStateAsUpdate(directory)).toEqual(beforeDirectory);
    expect(Y.encodeStateAsUpdate(sidebar)).toEqual(beforeSidebar);
    expect(rig.instance.store.logSize()).toBe(beforeLog);
    await rig.ok("restore_doc", { uuid: next.uuid });
    expect((await decision(rig, { supersedes: next.uuid })).topic).toBe(first.uuid);
  });

  it("uses only the first tombstone for listing, read-only refusal and derived log; archive and restore affect all records", async () => {
    const rig = await localRig();
    const page = await rig.ok("create_doc", { title: "Product", description: "Product direction." });
    const a = await decision(rig, { status: "decided", related: page.uuid });
    const b = await decision(rig, { status: "decided", supersedes: a.uuid, answer });
    setTldr(rig.instance.replicas.replica(b.uuid).doc, "The answer.");
    await rig.ok("pin_doc", { uuid: a.uuid, group: "Reading" });
    await rig.ok("pin_doc", { uuid: b.uuid, group: "Reading" });
    rawDeleted(rig, b.uuid, true);
    expect((await rig.ok("get_sidebar")).groups[0].docs).toEqual([
      { uuid: a.uuid, title: "Topic", status: "ok" },
      { uuid: b.uuid, title: "Topic", status: "ok" },
    ]);
    expect((await rig.ok("search", { query: "constraints" })).hits.map((hit: any) => hit.uuid).sort()).toEqual([a.uuid, b.uuid].sort());
    expect((await rig.ok("list_docs", { kind: "decision" })).docs).toMatchObject([{ uuid: b.uuid, inForce: b.uuid }]);
    expect(getDirectoryEntry(rig.instance.replicas.directory().doc, b.uuid)).not.toHaveProperty("tldr");
    expect((await rig.ok("list_docs", { kind: "decision" })).docs[0]).not.toHaveProperty("deleted");
    expect((await rig.ok("get_doc", { uuid: b.uuid })).resolution).toMatchObject({ inForce: b.uuid, archived: false });
    rawDeleted(rig, a.uuid, true);
    rawDeleted(rig, b.uuid, false);
    expect((await rig.ok("get_sidebar")).groups[0].docs).toEqual([
      { uuid: a.uuid, title: "Topic", status: "archived" },
      { uuid: b.uuid, title: "Topic", status: "archived" },
    ]);
    expect((await rig.ok("list_docs", { kind: "decision" })).docs).toEqual([]);
    expect((await rig.ok("get_doc", { uuid: page.uuid })).decisions).toEqual([]);
    expect((await rig.ok("search", { query: "constraints" })).hits).toEqual([]);
    expect((await rig.call("set_metadata", { uuid: b.uuid, title: "Refused" })).payload.error).toBe("doc_archived");
    expect((await rig.ok("get_doc", { uuid: b.uuid })).resolution).toMatchObject({ inForce: b.uuid, archived: true });
    const restored = await rig.ok("restore_doc", { uuid: b.uuid });
    expect(restored.records.sort()).toEqual([a.uuid, b.uuid].sort());
    expect(restored.rooms.map((room: any) => room.purpose)).toEqual(["directory"]);
    expect((await rig.ok("search", { query: "constraints" })).hits.map((hit: any) => hit.uuid).sort()).toEqual([a.uuid, b.uuid].sort());
    expect(listDirectory(rig.instance.replicas.directory().doc)).toHaveLength(3);
    const archived = await rig.ok("archive_doc", { uuid: b.uuid });
    expect(archived.records.sort()).toEqual([a.uuid, b.uuid].sort());
    expect(archived.rooms.map((room: any) => room.purpose)).toEqual(["directory", "sidebar"]);
    for (const uuid of [a.uuid, b.uuid]) expect(getDirectoryEntry(rig.instance.replicas.directory().doc, uuid)?.deleted).toBe(true);
    expect((await rig.ok("list_docs", { kind: "decision", include_deleted: true })).docs).toMatchObject([{ inForce: b.uuid, deleted: true }]);
  });

  it("lists a rejected or withdrawn first proposal even with no live records", async () => {
    const rig = await localRig();
    const rejected = await decision(rig);
    const withdrawn = await decision(rig);
    await rig.ok("set_status", { uuid: rejected.uuid, status: "rejected", answer, reason: "The team chose another option." });
    await rig.ok("set_status", { uuid: withdrawn.uuid, status: "withdrawn" });
    const rows = (await rig.ok("list_docs", { kind: "decision" })).docs;
    expect(rows.map((row: any) => row.uuid).sort()).toEqual([rejected.uuid, withdrawn.uuid].sort());
    for (const row of rows) expect(row).toMatchObject({ inForce: null, pending: [], conflicts: [] });
    expect((await rig.ok("list_docs", { status: "rejected" })).docs).toEqual([]);
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
    setTldr(doc, "A concise answer.");
    const opened = await rig.ok("annotate", { uuid: record.uuid, block_id: record.blocks[0].id, start: 0, end: 2, text: "Question" });
    await rig.ok("annotate", { uuid: record.uuid, thread_id: opened.annotation.id, text: "Reply" });
    const directory = rig.instance.replicas.directory().doc;
    expect(getDirectoryEntry(directory, record.uuid)).toMatchObject({ topic: record.uuid, agentStance: false, decidedBy: "A person", decidedAt: "2026-10-04T12:00:00Z", commentCount: 2 });
    expect(getDirectoryEntry(directory, record.uuid)).not.toHaveProperty("tldr");
    upsertDirectoryEntry(directory, { uuid: record.uuid, title: "Directory only" });
    expect(getDirectoryEntry(directory, record.uuid)?.commentCount).toBe(2);
    await rig.ok("archive_doc", { uuid: record.uuid });
    await rig.ok("restore_doc", { uuid: record.uuid });
    expect(getDirectoryEntry(directory, record.uuid)).toMatchObject({ agentStance: false, decidedBy: "A person", commentCount: 2 });
  });
});

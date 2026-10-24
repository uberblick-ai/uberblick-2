import { randomUUID } from "node:crypto";
import { getDirectoryEntry, getDirectoryMap, tombstoneDirectoryEntry, upsertDirectoryEntry } from "@uberblick/schema";
import type { DirectoryEntry } from "@uberblick/schema";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import { removeTempDirs, startServer, testConfig } from "./core-helpers.js";
import type { Rig } from "./core-helpers.js";

const rigs: Rig[] = [];
afterEach(async () => { for (const rig of rigs.splice(0)) await rig.close(); });
afterAll(removeTempDirs);

async function localRig() {
  const rig = await startServer(testConfig());
  rigs.push(rig);
  return rig;
}

function stub(rig: Rig, fields: Partial<DirectoryEntry>, regular = false): DirectoryEntry {
  const entry: DirectoryEntry = {
    uuid: randomUUID(), title: "Cached record", kind: "decision", status: "open", tags: [], ...fields,
  };
  if (regular) { delete entry.kind; delete entry.status; }
  upsertDirectoryEntry(rig.instance.replicas.directory().doc, entry);
  if (entry.deleted) tombstoneDirectoryEntry(rig.instance.replicas.directory().doc, entry.uuid);
  return entry;
}

function indexLink(rig: Rig, source: DirectoryEntry, target: string) {
  rig.instance.store.indexDoc({
    uuid: source.uuid, title: source.title, description: "", tags: [], links: [target], body: "",
  }, 1);
}

describe("decision context on page reads", () => {
  it("reads related before linked topics on a regular page from directory and index alone", async () => {
    const rig = await localRig();
    const page = await rig.ok("create_doc", { title: "Owning page", description: "Page context." });
    const other = await rig.ok("create_doc", { title: "Other page", description: "Another context." });

    const relatedOld = stub(rig, { createdAt: 30, status: "decided", governs: other.uuid, answerPreview: "Old related answer" });
    stub(rig, { createdAt: 31, topic: relatedOld.uuid, supersedes: relatedOld.uuid, status: "rejected", governs: page.uuid });
    const relatedMiddle = stub(rig, { createdAt: 40, status: "decided", governs: page.uuid });
    const relatedCurrent = stub(rig, { createdAt: 41, topic: relatedMiddle.uuid, supersedes: relatedMiddle.uuid, status: "decided", governs: other.uuid, answerPreview: "Current related answer" });
    const relatedNew = stub(rig, { createdAt: 50, status: "withdrawn", governs: page.uuid });
    const relatedPending = stub(rig, { createdAt: 51, topic: relatedNew.uuid, supersedes: relatedNew.uuid, answerPreview: null });

    const linkedOld = stub(rig, { createdAt: 10, status: "decided" });
    const linkedRejected = stub(rig, { createdAt: 11, topic: linkedOld.uuid, supersedes: linkedOld.uuid, status: "rejected" });
    const linkedNew = stub(rig, { createdAt: 20, status: "withdrawn" });
    const linkedPending = stub(rig, { createdAt: 21, topic: linkedNew.uuid, supersedes: linkedNew.uuid, answerPreview: "Pending linked answer" });
    const archived = stub(rig, { createdAt: 1, deleted: true, governs: page.uuid });
    const regularBacklink = stub(rig, {}, true);
    for (const source of [linkedRejected, linkedNew, relatedMiddle, archived, regularBacklink]) indexLink(rig, source, page.uuid);

    const read = await rig.ok("get_doc", { uuid: page.uuid });
    expect(read.decisions.map((topic: any) => [topic.topic, topic.relation])).toEqual([
      [relatedOld.uuid, "related"], [relatedMiddle.uuid, "related"], [relatedNew.uuid, "related"],
      [linkedOld.uuid, "linked"], [linkedNew.uuid, "linked"],
    ]);
    expect(read.decisions[0]).toMatchObject({ uuid: relatedOld.uuid, answerPreview: "Old related answer", inForce: relatedOld.uuid });
    expect(read.decisions[1]).toMatchObject({ uuid: relatedCurrent.uuid, answerPreview: "Current related answer", inForce: relatedCurrent.uuid });
    expect(read.decisions[2]).toMatchObject({ uuid: relatedPending.uuid, answerPreview: null, inForce: null, pending: [relatedPending.uuid] });
    expect(read.decisions[3]).toMatchObject({ uuid: linkedOld.uuid, inForce: linkedOld.uuid });
    expect(read.decisions[3]).not.toHaveProperty("answerPreview");
    expect(read.decisions[4]).toMatchObject({ uuid: linkedPending.uuid, answerPreview: "Pending linked answer", pending: [linkedPending.uuid] });
    for (const entry of [relatedOld, relatedMiddle, relatedCurrent, relatedNew, relatedPending, linkedOld, linkedRejected, linkedNew, linkedPending, archived, regularBacklink]) {
      expect(rig.instance.replicas.hydrated(entry.uuid)).toBe(false);
    }
  });

  it("returns preview caches through topic rows, conflicts, record rows and decision relations", async () => {
    const rig = await localRig();
    const first = await rig.ok("create_doc", { title: "Actual topic", description: "Decision history.", kind: "decision", blocks: [{ type: "paragraph", text: "First answer." }] });
    const next = await rig.ok("create_doc", { description: "Proposal.", kind: "decision", supersedes: first.uuid, blocks: [{ type: "paragraph", text: "Replacement answer." }] });
    const conflictA = stub(rig, { title: "Conflict A", createdAt: 1, status: "decided", topic: first.uuid, supersedes: first.uuid, answerPreview: "Conflict answer A" });
    const conflictB = stub(rig, { title: "Conflict B", createdAt: 2, status: "decided", topic: first.uuid, supersedes: first.uuid, answerPreview: null });

    const topics = (await rig.ok("list_docs", { kind: "decision" })).docs;
    expect(topics).toMatchObject([{ uuid: next.uuid, answerPreview: "Replacement answer.", inForce: null, pending: [next.uuid], conflicts: [conflictA.uuid, conflictB.uuid] }]);
    const records = (await rig.ok("list_docs", { kind: "decision", include_superseded: true })).docs;
    const readNext = await rig.ok("get_doc", { uuid: next.uuid });
    for (const row of [...topics, ...records]) expect(row.title).toBe("Actual topic");
    expect(records.find((entry: any) => entry.uuid === first.uuid)).toMatchObject({ answerPreview: "First answer." });
    expect(records.find((entry: any) => entry.uuid === conflictB.uuid)).toMatchObject({ answerPreview: null });
    expect(readNext.predecessors).toMatchObject([{ uuid: first.uuid, answerPreview: "First answer." }]);
    expect(readNext.resolution).toEqual({ inForce: null, pending: [next.uuid], conflicts: [conflictA.uuid, conflictB.uuid], archived: false });
    const readFirst = await rig.ok("get_doc", { uuid: first.uuid });
    expect(readFirst.decisions).toEqual([]);
    expect(readFirst.successors.find((entry: any) => entry.uuid === next.uuid)).toMatchObject({ answerPreview: "Replacement answer." });
    expect(readFirst.successors.find((entry: any) => entry.uuid === conflictB.uuid)).toMatchObject({ answerPreview: null });
    expect(rig.instance.replicas.hydrated(conflictA.uuid)).toBe(false);
    expect(rig.instance.replicas.hydrated(conflictB.uuid)).toBe(false);
  });

  it.each([
    { label: "known", stamp: 1_792_608_973_213, iso: "2026-10-21T18:56:13.213Z" },
    { label: "unknown", stamp: undefined, iso: undefined },
    { label: "beyond the latest Date", stamp: 8_640_000_000_000_001, iso: undefined },
    { label: "before the earliest Date", stamp: -8_640_000_000_000_001, iso: undefined },
  ])("serializes $label timestamps throughout decision context without changing directory values", async ({ stamp, iso }) => {
    const rig = await localRig();
    const page = await rig.ok("create_doc", { title: "Owning page", description: "Page context." });
    const first = await rig.ok("create_doc", { title: "Forked topic", description: "Decision history.", kind: "decision", related: page.uuid });
    const next = await rig.ok("create_doc", { description: "Pending answer.", kind: "decision", supersedes: first.uuid });
    const conflictA = stub(rig, { status: "decided", topic: first.uuid, supersedes: first.uuid });
    const conflictB = stub(rig, { status: "decided", topic: first.uuid, supersedes: first.uuid });
    const inForce = stub(rig, { status: "decided", governs: page.uuid });
    for (const document of [page, first, next]) await rig.ok("get_doc", { uuid: document.uuid });
    const directoryDoc = rig.instance.replicas.directory().doc;
    const directory = getDirectoryMap(directoryDoc);
    const records = [first, next, conflictA, conflictB, inForce];
    directoryDoc.getMap("updatedAt").clear();
    for (const record of records) {
      const { createdAt: _createdAt, updatedAt: _updatedAt, ...fields } = directory.get(record.uuid) as Record<string, unknown>;
      directory.set(record.uuid, { ...fields, ...(stamp === undefined ? {} : { createdAt: stamp, updatedAt: stamp }) });
    }
    const before = records.map(record => getDirectoryEntry(directoryDoc, record.uuid));

    const pageRead = await rig.ok("get_doc", { uuid: page.uuid });
    const firstRead = await rig.ok("get_doc", { uuid: first.uuid });
    const nextRead = await rig.ok("get_doc", { uuid: next.uuid });
    expect(pageRead.decisions).toHaveLength(2);
    expect(pageRead.decisions.find((topic: any) => topic.topic === inForce.uuid).inForce).toBe(inForce.uuid);
    expect(nextRead.predecessors).toHaveLength(1);
    expect(firstRead.successors).toHaveLength(3);
    expect(nextRead.resolution.pending).toHaveLength(1);
    expect(nextRead.resolution.conflicts).toHaveLength(2);

    for (const entry of [...firstRead.successors, ...nextRead.predecessors]) {
      if (iso === undefined) {
        expect(entry).not.toHaveProperty("createdAt");
        expect(entry).not.toHaveProperty("updatedAt");
      } else {
        expect(entry).toMatchObject({ createdAt: iso, updatedAt: iso });
      }
    }
    // Topic rows, as in list_docs, carry updatedAt without createdAt.
    for (const include_superseded of [false, true]) {
      const listed = await rig.ok("list_docs", { kind: "decision", include_superseded });
      for (const entry of [...listed.docs, ...pageRead.decisions]) {
        if (iso === undefined) expect(entry).not.toHaveProperty("updatedAt");
        else expect(entry.updatedAt).toBe(iso);
      }
    }
    expect(records.map(record => getDirectoryEntry(directoryDoc, record.uuid))).toEqual(before);
  });
});

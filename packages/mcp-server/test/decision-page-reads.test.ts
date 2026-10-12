import { randomUUID } from "node:crypto";
import { tombstoneDirectoryEntry, upsertDirectoryEntry } from "@uberblick/schema";
import type { DirectoryEntry } from "@uberblick/schema";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import { removeTempDirs, startServer, testConfig } from "./helpers.js";
import type { Rig } from "./helpers.js";

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
    expect(read.decisions[0].inForce).toMatchObject({ uuid: relatedOld.uuid, answerPreview: "Old related answer" });
    expect(read.decisions[1]).toMatchObject({ uuid: relatedCurrent.uuid, answerPreview: "Current related answer", inForce: { uuid: relatedCurrent.uuid } });
    expect(read.decisions[2]).toMatchObject({ uuid: relatedPending.uuid, answerPreview: null, inForce: null, pending: [{ uuid: relatedPending.uuid, answerPreview: null }] });
    expect(read.decisions[3]).not.toHaveProperty("answerPreview");
    expect(read.decisions[3].inForce).not.toHaveProperty("answerPreview");
    expect(read.decisions[4]).toMatchObject({ uuid: linkedPending.uuid, pending: [{ answerPreview: "Pending linked answer" }] });
    for (const entry of [relatedOld, relatedMiddle, relatedCurrent, relatedNew, relatedPending, linkedOld, linkedRejected, linkedNew, linkedPending, archived, regularBacklink]) {
      expect(rig.instance.replicas.hydrated(entry.uuid)).toBe(false);
    }
  });

  it("returns preview caches through topic rows, conflicts, record rows and decision relations", async () => {
    const rig = await localRig();
    const first = await rig.ok("create_doc", { title: "Actual topic", description: "Decision history.", kind: "decision", blocks: [{ type: "paragraph", text: "First answer." }] });
    const next = await rig.ok("create_doc", { title: "Actual replacement", description: "Proposal.", kind: "decision", supersedes: first.uuid, blocks: [{ type: "paragraph", text: "Replacement answer." }] });
    const conflictA = stub(rig, { title: "Conflict A", createdAt: 1, status: "decided", topic: first.uuid, supersedes: first.uuid, answerPreview: "Conflict answer A" });
    const conflictB = stub(rig, { title: "Conflict B", createdAt: 2, status: "decided", topic: first.uuid, supersedes: first.uuid, answerPreview: null });

    const topics = (await rig.ok("list_docs", { kind: "decision" })).docs;
    expect(topics).toMatchObject([{ uuid: next.uuid, answerPreview: "Replacement answer.", inForce: null, pending: [{ uuid: next.uuid, answerPreview: "Replacement answer." }], conflicts: [{ uuid: conflictA.uuid, answerPreview: "Conflict answer A" }, { uuid: conflictB.uuid, answerPreview: null }] }]);
    const records = (await rig.ok("list_docs", { kind: "decision", include_superseded: true })).docs;
    expect(records.find((entry: any) => entry.uuid === first.uuid)).toMatchObject({ answerPreview: "First answer." });
    expect(records.find((entry: any) => entry.uuid === conflictB.uuid)).toMatchObject({ answerPreview: null });
    const readNext = await rig.ok("get_doc", { uuid: next.uuid });
    expect(readNext.predecessors).toMatchObject([{ uuid: first.uuid, answerPreview: "First answer." }]);
    expect(readNext.resolution).toMatchObject({ answerPreview: "Replacement answer.", pending: [{ answerPreview: "Replacement answer." }], conflicts: [{ answerPreview: "Conflict answer A" }, { answerPreview: null }] });
    const readFirst = await rig.ok("get_doc", { uuid: first.uuid });
    expect(readFirst.decisions).toEqual([]);
    expect(readFirst.successors.find((entry: any) => entry.uuid === next.uuid)).toMatchObject({ answerPreview: "Replacement answer." });
    expect(readFirst.successors.find((entry: any) => entry.uuid === conflictB.uuid)).toMatchObject({ answerPreview: null });
    expect(rig.instance.replicas.hydrated(conflictA.uuid)).toBe(false);
    expect(rig.instance.replicas.hydrated(conflictB.uuid)).toBe(false);
  });
});

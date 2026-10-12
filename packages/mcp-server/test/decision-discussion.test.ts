import { randomUUID } from "node:crypto";
import {
  EXAMPLE_TAGS,
  decisionApprovalFingerprint,
  getDirectoryEntry,
  getDirectoryMap,
  getMetaMap,
  listDirectory,
  deleteTagCatalogEntry,
  upsertDirectoryEntry,
} from "@uberblick/schema";
import type { DirectoryEntry } from "@uberblick/schema";
import * as Y from "yjs";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { removeTempDirs, startServer, tempDatabasePath, testConfig } from "./helpers.js";
import type { Rig } from "./helpers.js";

vi.mock("node:crypto", async (importOriginal) => {
  const crypto = await importOriginal<typeof import("node:crypto")>();
  return { ...crypto, randomUUID: vi.fn(crypto.randomUUID) };
});

const rigs: Rig[] = [];
const blocks = [{ type: "paragraph", text: "Keep the current answer until the replacement is accepted." }];
const answer = { who: "A workspace member", when: "2026-10-04T12:00:00Z", where: "https://example.org/team/decision" };

afterEach(async () => {
  for (const rig of rigs.splice(0)) await rig.close();
  vi.clearAllMocks();
});
afterAll(removeTempDirs);

async function localRig(databasePath = tempDatabasePath()): Promise<Rig> {
  const rig = await startServer(testConfig({ databasePath }));
  rigs.push(rig);
  return rig;
}

async function page(rig: Rig, fields: Record<string, unknown> = {}) {
  return rig.ok("create_doc", { title: "Discussion", description: "A manually authored regular document.", ...fields });
}

async function decision(rig: Rig, fields: Record<string, unknown> = {}) {
  return rig.ok("create_doc", { title: "Topic", description: "A decision and its discussion.", kind: "decision", blocks, ...fields });
}

function state(rig: Rig, uuids: string[] = []) {
  return {
    directory: Y.encodeStateAsUpdate(rig.instance.replicas.directory().doc),
    sidebar: Y.encodeStateAsUpdate(rig.instance.replicas.sidebar().doc),
    settings: Y.encodeStateAsUpdate(rig.instance.replicas.settings().doc),
    documents: uuids.map(uuid => Y.encodeStateAsUpdate(rig.instance.replicas.replica(uuid).doc)),
    log: rig.instance.store.logSize(),
  };
}

async function refuse(rig: Rig, tool: string, args: Record<string, unknown>, error: string, uuids: string[] = []) {
  const before = state(rig, uuids);
  const result = await rig.call(tool, args);
  expect(result.isError).toBe(true);
  expect(result.payload.error).toBe(error);
  if (error !== "schema_validation") expect(result.payload).toMatchObject({ applied: false, partial: false, synced: false });
  expect(state(rig, uuids)).toEqual(before);
  return result.payload;
}

function stub(rig: Rig, fields: Partial<DirectoryEntry> = {}): DirectoryEntry {
  const entry: DirectoryEntry = { uuid: randomUUID(), title: "Cached proposal", kind: "decision", status: "open", tags: [], ...fields };
  upsertDirectoryEntry(rig.instance.replicas.directory().doc, entry);
  return entry;
}

function references(entries: any[]) {
  return entries.map(entry => [entry.uuid, entry.discussion]).sort();
}

describe("explicit decision discussion references", () => {
  it("connects open first records, successors and direct answers without inheritance or document side effects", async () => {
    const rig = await localRig();
    const related = await page(rig, { title: "Owning page" });
    const rfc = await page(rig);
    const requirement = await page(rig, { kind: "requirement" });
    const unchanged = [related.uuid, rfc.uuid, requirement.uuid].map(uuid => Y.encodeStateAsUpdate(rig.instance.replicas.replica(uuid).doc));
    const beforeCount = listDirectory(rig.instance.replicas.directory().doc).length;

    vi.mocked(randomUUID).mockClear();
    const first = await decision(rig, { related: related.uuid, discussion: rfc.uuid, blocks: [] });
    expect(randomUUID).toHaveBeenCalled();
    expect(first).toMatchObject({ status: "open", topic: first.uuid, discussion: rfc.uuid, blocks: [] });
    const next = await decision(rig, { supersedes: first.uuid, discussion: requirement.uuid });
    const without = await decision(rig, { supersedes: first.uuid });
    const stance = await decision(rig, { status: "decided", discussion: rfc.uuid });
    const recorded = await decision(rig, { status: "decided", supersedes: stance.uuid, discussion: requirement.uuid, answer });
    expect(stance).toMatchObject({ discussion: rfc.uuid, agentStance: true });
    expect(recorded).toMatchObject({ discussion: requirement.uuid, decidedBy: answer.who, approvalChanged: false });
    for (const record of [next, without]) expect(record).toMatchObject({ topic: first.uuid, governs: related.uuid });
    expect(without.discussion).toBeNull();
    for (const record of [first, next, without, stance, recorded]) {
      expect((await rig.ok("get_doc", { uuid: record.uuid })).discussion).toBe(record.discussion);
      expect(getDirectoryEntry(rig.instance.replicas.directory().doc, record.uuid)?.discussion).toBe(record.discussion);
    }
    expect([related.uuid, rfc.uuid, requirement.uuid].map(uuid => Y.encodeStateAsUpdate(rig.instance.replicas.replica(uuid).doc))).toEqual(unchanged);
    expect(listDirectory(rig.instance.replicas.directory().doc)).toHaveLength(beforeCount + 5);
    expect((await rig.ok("get_doc", { uuid: rfc.uuid })).tags).toEqual([]);
  });

  it("refuses invalid creation targets before allocating a UUID or writing any room", async () => {
    const rig = await localRig();
    const regular = await page(rig);
    const record = await decision(rig);
    const archived = await page(rig);
    await rig.ok("archive_doc", { uuid: archived.uuid });
    const unknown = randomUUID();
    const unhydrated = stub(rig, { kind: "requirement", status: "draft" });
    const targets = [
      [record.uuid, "discussion_not_regular_document"],
      [archived.uuid, "doc_archived"],
      [unknown, "doc_not_found"],
      [unhydrated.uuid, "doc_not_hydrated"],
    ] as const;
    for (const [discussion, error] of targets) {
      vi.mocked(randomUUID).mockClear();
      await refuse(rig, "create_doc", { title: "Refused", description: "No record must survive.", kind: "decision", discussion }, error, [regular.uuid, record.uuid, archived.uuid]);
      expect(randomUUID).not.toHaveBeenCalled();
    }
    for (const kind of [undefined, "requirement"]) {
      vi.mocked(randomUUID).mockClear();
      await refuse(rig, "create_doc", { title: "Wrong shape", description: "Only decision records name a discussion.", ...(kind === undefined ? {} : { kind }), discussion: regular.uuid }, "schema_validation", [regular.uuid]);
      expect(randomUUID).not.toHaveBeenCalled();
    }
  });

  it("sets, corrects and clears only the record, leaving approval and curated links independent", async () => {
    const rig = await localRig();
    const related = await page(rig, { title: "Related page" });
    const left = await page(rig, { title: "First RFC" });
    const right = await page(rig, { title: "Replacement RFC" });
    const record = await decision(rig, { related: related.uuid });
    const doc = rig.instance.replicas.replica(record.uuid).doc;
    const fingerprint = decisionApprovalFingerprint(doc);
    getMetaMap(doc).set("approvalFingerprint", fingerprint);
    await rig.ok("get_doc", { uuid: record.uuid });
    const unchanged = [related.uuid, left.uuid, right.uuid].map(uuid => Y.encodeStateAsUpdate(rig.instance.replicas.replica(uuid).doc));
    const count = listDirectory(rig.instance.replicas.directory().doc).length;

    const set = await rig.ok("set_metadata", { uuid: record.uuid, description: "Updated discovery text.", discussion: left.uuid, tags: ["mcp"], links: [right.uuid] });
    expect(set).toMatchObject({ discussion: left.uuid, description: "Updated discovery text." });
    expect(set.links.sort()).toEqual([related.uuid, left.uuid, right.uuid].sort());
    const changed = await rig.ok("set_metadata", { uuid: record.uuid, discussion: right.uuid });
    expect(changed.discussion).toBe(right.uuid);
    expect(changed.links.sort()).toEqual([related.uuid, right.uuid].sort());
    const cleared = await rig.ok("set_metadata", { uuid: record.uuid, discussion: null });
    expect(cleared.discussion).toBeNull();
    expect(cleared.links.sort()).toEqual([related.uuid, right.uuid].sort());
    expect(getMetaMap(doc).get("links")).toEqual([right.uuid]);
    expect(getMetaMap(doc).get("approvalFingerprint")).toBe(fingerprint);
    expect(decisionApprovalFingerprint(doc)).toBe(fingerprint);
    expect(await rig.ok("get_doc", { uuid: record.uuid })).toMatchObject({ discussion: null, approvalChanged: false });
    expect(getDirectoryEntry(rig.instance.replicas.directory().doc, record.uuid)?.discussion).toBeNull();
    expect([related.uuid, left.uuid, right.uuid].map(uuid => Y.encodeStateAsUpdate(rig.instance.replicas.replica(uuid).doc))).toEqual(unchanged);
    expect(listDirectory(rig.instance.replicas.directory().doc)).toHaveLength(count);
  });

  it("validates metadata targets and all other named fields before committing a mixed update", async () => {
    const rig = await localRig();
    const rfc = await page(rig);
    const record = await decision(rig, { discussion: rfc.uuid });
    const archived = await page(rig);
    await rig.ok("archive_doc", { uuid: archived.uuid });
    const unhydrated = stub(rig, { kind: "requirement", status: "draft" });
    const cases = [
      [record.uuid, "discussion_not_regular_document"],
      [archived.uuid, "doc_archived"],
      [randomUUID(), "doc_not_found"],
      [unhydrated.uuid, "doc_not_hydrated"],
    ] as const;
    for (const [discussion, error] of cases) {
      const refused = await refuse(rig, "set_metadata", { uuid: record.uuid, title: "Must not survive", description: "Nor this text.", discussion }, error, [record.uuid, rfc.uuid, archived.uuid]);
      expect(refused.field).toBe("discussion");
    }
    for (const args of [
      { discussion: null, tags: ["unknown-tag"] },
      { discussion: null, links: [randomUUID()] },
      { discussion: null, tldr: "A forbidden decision TL;DR." },
    ]) {
      const before = state(rig, [record.uuid, rfc.uuid]);
      expect((await rig.call("set_metadata", { uuid: record.uuid, ...args })).isError).toBe(true);
      expect(state(rig, [record.uuid, rfc.uuid])).toEqual(before);
    }
  });

  it("locks settled references and names the field when the source is not an open decision", async () => {
    const rig = await localRig();
    const rfc = await page(rig);
    const decided = await decision(rig, { status: "decided", discussion: rfc.uuid, answer });
    const rejected = await decision(rig, { discussion: rfc.uuid });
    const withdrawn = await decision(rig, { discussion: rfc.uuid });
    const regular = await page(rig);
    const requirement = await page(rig, { kind: "requirement" });
    await rig.ok("set_status", { uuid: rejected.uuid, status: "rejected", answer, reason: "Another answer was chosen." });
    await rig.ok("set_status", { uuid: withdrawn.uuid, status: "withdrawn" });
    for (const record of [decided, rejected, withdrawn, regular, requirement]) {
      for (const discussion of [rfc.uuid, null]) {
        const error = record.uuid === decided.uuid ? "decision_read_only" : "discussion_not_writable";
        const refused = await refuse(rig, "set_metadata", { uuid: record.uuid, description: "Must not survive.", discussion }, error, [record.uuid, rfc.uuid]);
        expect(refused.field).toBe("discussion");
      }
    }
    const open = await decision(rig, { discussion: rfc.uuid });
    const successor = await decision(rig, { supersedes: open.uuid, discussion: rfc.uuid });
    await rig.ok("archive_doc", { uuid: open.uuid });
    const refused = await refuse(rig, "set_metadata", { uuid: successor.uuid, discussion: null }, "doc_archived", [open.uuid, successor.uuid, rfc.uuid]);
    expect(refused).not.toHaveProperty("field");
  });

  it("returns cached references in topic rows, record rows, page context and record relations", async () => {
    const rig = await localRig();
    const owner = await page(rig);
    const firstRfc = await page(rig);
    const nextRfc = await page(rig);
    const first = await decision(rig, { related: owner.uuid, status: "decided", discussion: firstRfc.uuid });
    const next = await decision(rig, { supersedes: first.uuid, discussion: nextRfc.uuid });
    const noDiscussion = await decision(rig, { supersedes: first.uuid });
    const current = (await rig.ok("list_docs", { kind: "decision" })).docs[0];
    expect(current.inForce).toMatchObject({ uuid: first.uuid, discussion: firstRfc.uuid });
    expect(references(current.pending)).toEqual([[next.uuid, nextRfc.uuid], [noDiscussion.uuid, null]].sort());
    const conflict = stub(rig, { topic: first.uuid, supersedes: first.uuid, status: "decided", discussion: firstRfc.uuid, createdAt: 1 });
    const absent = stub(rig, { topic: first.uuid, supersedes: first.uuid, status: "decided", discussion: null, createdAt: 2 });
    const unknown = stub(rig, { createdAt: 3 });
    const topics = (await rig.ok("list_docs", { kind: "decision" })).docs;
    expect(topics.find((entry: any) => entry.topic === unknown.uuid)).not.toHaveProperty("discussion");
    const topic = topics.find((entry: any) => entry.topic === first.uuid);
    expect(topic).toHaveProperty("discussion");
    expect(topic.inForce).toBeNull();
    const expectedConflicts = [[conflict.uuid, firstRfc.uuid], [absent.uuid, null]].sort();
    expect(references(topic.conflicts)).toEqual(expectedConflicts);
    const records = (await rig.ok("list_docs", { kind: "decision", include_superseded: true })).docs;
    expect(references(records.filter((entry: any) => entry.topic === first.uuid))).toEqual([
      [first.uuid, firstRfc.uuid], [next.uuid, nextRfc.uuid], [noDiscussion.uuid, null], ...expectedConflicts,
    ].sort());
    expect(records.find((entry: any) => entry.uuid === unknown.uuid)).not.toHaveProperty("discussion");
    const readNext = await rig.ok("get_doc", { uuid: next.uuid });
    expect(readNext.predecessors).toMatchObject([{ uuid: first.uuid, discussion: firstRfc.uuid }]);
    expect(references(readNext.resolution.pending)).toEqual(references(topic.pending));
    expect(references(readNext.resolution.conflicts)).toEqual(expectedConflicts);
    const readFirst = await rig.ok("get_doc", { uuid: first.uuid });
    expect(references(readFirst.successors)).toEqual([[next.uuid, nextRfc.uuid], [noDiscussion.uuid, null], ...expectedConflicts].sort());
    const pageTopic = (await rig.ok("get_doc", { uuid: owner.uuid })).decisions[0];
    expect(pageTopic).toMatchObject({ topic: first.uuid, relation: "related" });
    expect(pageTopic).toHaveProperty("discussion");
    expect(references(pageTopic.pending)).toEqual(references(topic.pending));
    expect(references(pageTopic.conflicts)).toEqual(expectedConflicts);
    for (const entry of [conflict, absent, unknown]) expect(rig.instance.replicas.hydrated(entry.uuid)).toBe(false);
  });

  it("repairs an unknown or stale cache from the record's current reference", async () => {
    const rig = await localRig();
    const rfc = await page(rig);
    const record = await decision(rig, { discussion: rfc.uuid });
    const directory = rig.instance.replicas.directory().doc;
    const map = getDirectoryMap(directory);
    const entry = map.get(record.uuid) as Record<string, unknown>;
    const { discussion: _discussion, ...oldClient } = entry;
    map.set(record.uuid, oldClient);
    expect(getDirectoryEntry(directory, record.uuid)).not.toHaveProperty("discussion");
    await rig.ok("get_doc", { uuid: record.uuid });
    expect(getDirectoryEntry(directory, record.uuid)?.discussion).toBe(rfc.uuid);
    map.set(record.uuid, { ...map.get(record.uuid) as Record<string, unknown>, discussion: null });
    await rig.ok("set_metadata", { uuid: record.uuid, description: "An authored metadata write also repairs the cache." });
    expect(getDirectoryEntry(directory, record.uuid)?.discussion).toBe(rfc.uuid);
  });

  it("indexes the derived edge, updates backlinks on correction and gives related-page precedence", async () => {
    const rig = await localRig();
    const left = await page(rig);
    const right = await page(rig);
    const record = await decision(rig, { discussion: left.uuid });
    expect((await rig.ok("get_doc", { uuid: record.uuid })).links).toEqual([left.uuid]);
    expect((await rig.ok("backlinks", { uuid: left.uuid })).backlinks).toMatchObject([{ uuid: record.uuid }]);
    expect((await rig.ok("get_doc", { uuid: left.uuid })).decisions).toMatchObject([{ topic: record.uuid, relation: "linked" }]);
    await rig.ok("set_metadata", { uuid: record.uuid, discussion: right.uuid });
    expect((await rig.ok("backlinks", { uuid: left.uuid })).backlinks).toEqual([]);
    expect((await rig.ok("get_doc", { uuid: left.uuid })).decisions).toEqual([]);
    expect((await rig.ok("backlinks", { uuid: right.uuid })).backlinks).toMatchObject([{ uuid: record.uuid }]);
    await rig.ok("set_metadata", { uuid: record.uuid, discussion: null });
    expect((await rig.ok("backlinks", { uuid: right.uuid })).backlinks).toEqual([]);
    const related = await decision(rig, { related: left.uuid, discussion: left.uuid });
    expect((await rig.ok("get_doc", { uuid: related.uuid })).links).toEqual([left.uuid]);
    expect((await rig.ok("get_doc", { uuid: left.uuid })).decisions).toMatchObject([{ topic: related.uuid, relation: "related" }]);
    expect((await rig.ok("get_doc", { uuid: left.uuid })).decisions).toHaveLength(1);
  });

  it("retains document identity through RFC rename, archival and restart without requiring the rfc tag", async () => {
    const databasePath = tempDatabasePath();
    const rig = await localRig(databasePath);
    const rfcTag = EXAMPLE_TAGS.find(tag => tag.name === "rfc");
    expect(rfcTag).toBeDefined();
    deleteTagCatalogEntry(rig.instance.replicas.settings().doc, rfcTag!.id);
    const rfc = await page(rig);
    const record = await decision(rig, { status: "decided", discussion: rfc.uuid, answer });
    await rig.ok("set_metadata", { uuid: rfc.uuid, title: "Renamed RFC" });
    await rig.ok("archive_doc", { uuid: rfc.uuid });
    expect(await rig.ok("get_doc", { uuid: rfc.uuid })).toMatchObject({ uuid: rfc.uuid, title: "Renamed RFC" });
    expect(await rig.ok("get_doc", { uuid: record.uuid })).toMatchObject({ discussion: rfc.uuid, links: [rfc.uuid], approvalChanged: false });
    expect((await rig.ok("list_docs", { kind: "decision" })).docs).toMatchObject([{ discussion: rfc.uuid, inForce: { discussion: rfc.uuid } }]);
    expect((await rig.ok("list_tags")).tags).not.toContainEqual(rfcTag);
    await rig.close();
    rigs.splice(rigs.indexOf(rig), 1);

    const restarted = await localRig(databasePath);
    expect(getDirectoryEntry(restarted.instance.replicas.directory().doc, record.uuid)?.discussion).toBe(rfc.uuid);
    expect((await restarted.ok("list_tags")).tags).not.toContainEqual(rfcTag);
    expect(await restarted.ok("get_doc", { uuid: record.uuid })).toMatchObject({ discussion: rfc.uuid, links: [rfc.uuid], approvalChanged: false });
    expect((await restarted.ok("backlinks", { uuid: rfc.uuid })).backlinks).toMatchObject([{ uuid: record.uuid }]);
    expect(await restarted.ok("get_doc", { uuid: rfc.uuid })).toMatchObject({ uuid: rfc.uuid, title: "Renamed RFC", decisions: [{ topic: record.uuid, relation: "linked" }] });
  });

  it("preserves each record's discussion and every other pending proposal when settling one", async () => {
    const rig = await localRig();
    const earlierRfc = await page(rig);
    const proposalRfc = await page(rig);
    const first = await decision(rig, { status: "decided", discussion: earlierRfc.uuid, answer });
    const proposals = [];
    for (let index = 0; index < 4; index++) {
      const before = proposals.map(record => Y.encodeStateAsUpdate(rig.instance.replicas.replica(record.uuid).doc));
      proposals.push(await decision(rig, { supersedes: first.uuid, discussion: proposalRfc.uuid }));
      expect(proposals.slice(0, -1).map(record => Y.encodeStateAsUpdate(rig.instance.replicas.replica(record.uuid).doc))).toEqual(before);
    }
    expect((await rig.ok("get_doc", { uuid: first.uuid })).resolution).toMatchObject({ inForce: { uuid: first.uuid }, pending: expect.any(Array) });
    await refuse(rig, "set_status", { uuid: proposals[0].uuid, status: "decided" }, "decision_answer_required", [first.uuid, ...proposals.map(record => record.uuid)]);
    const transitions = [
      { status: "decided", answer },
      { status: "rejected", answer, reason: "Another proposal was accepted." },
      { status: "withdrawn" },
    ];
    for (const [index, transition] of transitions.entries()) {
      const others = [first, ...proposals.filter((_, candidate) => candidate !== index)];
      const unchanged = others.map(record => Y.encodeStateAsUpdate(rig.instance.replicas.replica(record.uuid).doc));
      await rig.ok("set_status", { uuid: proposals[index].uuid, ...transition });
      expect(others.map(record => Y.encodeStateAsUpdate(rig.instance.replicas.replica(record.uuid).doc))).toEqual(unchanged);
      expect((await rig.ok("get_doc", { uuid: proposals[index].uuid })).discussion).toBe(proposalRfc.uuid);
    }
    const read = await rig.ok("get_doc", { uuid: first.uuid });
    expect(read).toMatchObject({ discussion: earlierRfc.uuid, approvalChanged: false });
    expect(read.resolution).toMatchObject({ inForce: { uuid: proposals[0].uuid, discussion: proposalRfc.uuid }, pending: [{ uuid: proposals[3].uuid, discussion: proposalRfc.uuid }] });
    expect((await rig.ok("get_doc", { uuid: proposalRfc.uuid })).tags).toEqual([]);
  });
});

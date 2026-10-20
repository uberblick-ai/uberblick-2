import { randomUUID } from "node:crypto";
import { decisionApprovalChanged, getBlocks, getDirectoryEntry, getDirectoryMap, getMeta, getMetaMap, editBlock, setTitle, upsertDirectoryEntry } from "@uberblick/schema";
import { afterEach, expect, it, vi } from "vitest";
import * as Y from "yjs";
import { startServer, testConfig } from "./core-helpers.js";
import type { Rig } from "./core-helpers.js";

const rigs: Rig[] = [];
const answer = { who: "A maintainer", when: "2026-10-20T08:00:00Z", where: "A reviewed decision." };
const blocks = [{ type: "paragraph", text: "Use the existing update log." }];

async function localRig() {
  const rig = await startServer(testConfig());
  rigs.push(rig);
  return rig;
}

async function decision(rig: Rig, fields: Record<string, unknown> = {}) {
  return rig.ok("create_doc", {
    description: "One title belongs to the whole topic.", kind: "decision", blocks,
    ...fields,
  });
}

function roomState(rig: Rig, uuids: string[]) {
  return {
    rooms: uuids.map(uuid => Y.encodeStateAsUpdate(rig.instance.replicas.replica(uuid).doc)),
    directory: Y.encodeStateAsUpdate(rig.instance.replicas.directory().doc),
    log: rig.instance.store.logSize(),
  };
}

function approval(rig: Rig, uuid: string) {
  const doc = rig.instance.replicas.replica(uuid).doc;
  const meta = getMeta(doc);
  return {
    status: meta.status, approvalFingerprint: meta.approvalFingerprint,
    approvalChanged: decisionApprovalChanged(doc), decidedAt: meta.decidedAt,
    decidedBy: meta.decidedBy, decidedWhere: meta.decidedWhere,
  };
}

function durableMeta(rig: Rig, room: string) {
  const doc = new Y.Doc();
  try {
    const { snapshot, updates } = rig.instance.store.readSince(room, 0);
    if (snapshot !== null) Y.applyUpdate(doc, snapshot.state);
    for (const update of updates) Y.applyUpdate(doc, update.payload);
    return getMeta(doc);
  } finally {
    doc.destroy();
  }
}

afterEach(async () => {
  vi.restoreAllMocks();
  for (const rig of rigs.splice(0)) await rig.close();
});

it("inherits the current topic title and refuses a different successor title before allocation", async () => {
  const rig = await localRig();
  const first = await decision(rig, { title: "Original question", status: "decided", answer });
  const old = await decision(rig, { supersedes: first.uuid });
  setTitle(rig.instance.replicas.replica(old.uuid).doc, "Older client record title");
  await rig.ok("set_metadata", { uuid: first.uuid, title: "Renamed question" });
  for (const title of [undefined, "Renamed question"]) {
    const next = await decision(rig, { supersedes: old.uuid, ...(title === undefined ? {} : { title }) });
    expect(next.title).toBe("Renamed question");
    expect(getMeta(rig.instance.replicas.replica(next.uuid).doc).title).toBe("Renamed question");
  }
  const before = roomState(rig, [first.uuid, old.uuid]);
  expect(await rig.call("create_doc", {
    kind: "decision", supersedes: old.uuid, title: "A different question", description: "Must not allocate a record.",
  })).toMatchObject({ isError: true, payload: { error: "decision_title_mismatch", field: "title", title: "Renamed question", applied: false, partial: false } });
  expect(roomState(rig, [first.uuid, old.uuid])).toEqual(before);
  for (const kind of [undefined, "decision"]) {
    expect(await rig.call("create_doc", { description: "First records need a title.", ...(kind === undefined ? {} : { kind }) }))
      .toMatchObject({ isError: true, payload: { error: "schema_validation" } });
  }
});

it("renames through every live record state, writes only the first title and preserves answer approval", async () => {
  const rig = await localRig();
  const first = await decision(rig, { title: "Stable question", status: "decided", answer });
  const current = await decision(rig, { supersedes: first.uuid, status: "decided", answer });
  const pending = await decision(rig, { supersedes: current.uuid });
  const rejected = await decision(rig, { supersedes: current.uuid });
  const withdrawn = await decision(rig, { supersedes: current.uuid });
  await rig.ok("set_status", { uuid: rejected.uuid, status: "rejected", reason: "Keep the accepted answer.", answer });
  await rig.ok("set_status", { uuid: withdrawn.uuid, status: "withdrawn" });
  const records = [first, current, pending, rejected, withdrawn];
  const currentDoc = rig.instance.replicas.replica(current.uuid).doc;
  const block = getBlocks(currentDoc)[0]!;
  editBlock(currentDoc, block.id, block.text, "An answer changed after approval.", { rev: block.rev });
  const directory = rig.instance.replicas.directory().doc;
  getDirectoryMap(directory).set(pending.uuid, { ...getDirectoryEntry(directory, pending.uuid), deleted: true });
  const approved = records.map(record => approval(rig, record.uuid));
  const storedTitles = records.slice(1).map(record => getMeta(rig.instance.replicas.replica(record.uuid).doc).title);
  for (const [index, record] of records.entries()) {
    const untouched = records.slice(1).map(other => Y.encodeStateAsUpdate(rig.instance.replicas.replica(other.uuid).doc));
    const title = `Question revision ${index}`;
    expect(await rig.ok("set_metadata", { uuid: record.uuid, title })).toMatchObject({ title, applied: true });
    expect(getMeta(rig.instance.replicas.replica(first.uuid).doc).title).toBe(title);
    expect(records.slice(1).map(other => Y.encodeStateAsUpdate(rig.instance.replicas.replica(other.uuid).doc))).toEqual(untouched);
    expect(records.map(other => approval(rig, other.uuid))).toEqual(approved);
    expect(records.slice(1).map(other => getMeta(rig.instance.replicas.replica(other.uuid).doc).title)).toEqual(storedTitles);
  }
  expect(getDirectoryEntry(directory, pending.uuid)?.deleted).toBe(true);
  expect((await rig.ok("set_metadata", { uuid: pending.uuid, description: "Other metadata stays on the addressed record." })).title)
    .toBe("Question revision 4");
  expect(getMeta(rig.instance.replicas.replica(pending.uuid).doc).description).toBe("Other metadata stays on the addressed record.");
  await rig.ok("archive_doc", { uuid: current.uuid });
  const before = roomState(rig, records.map(record => record.uuid));
  for (const record of records) {
    expect(await rig.call("set_metadata", { uuid: record.uuid, title: "Archived rename" }))
      .toMatchObject({ isError: true, payload: { error: "doc_archived", applied: false, partial: false } });
  }
  expect(roomState(rig, records.map(record => record.uuid))).toEqual(before);
});

it("validates all metadata and the first record's room before writing either room", async () => {
  const rig = await localRig();
  const first = await decision(rig, { title: "A question", status: "decided", answer });
  const next = await decision(rig, { supersedes: first.uuid });
  const before = roomState(rig, [first.uuid, next.uuid]);
  expect(await rig.call("set_metadata", { uuid: next.uuid, title: "Do not write", description: "Do not write this either.", tags: ["missing-tag"] }))
    .toMatchObject({ isError: true, payload: { error: "invalid_tag_assignment", field: "tags", applied: false, partial: false } });
  expect(roomState(rig, [first.uuid, next.uuid])).toEqual(before);
  const missingFirst = randomUUID();
  upsertDirectoryEntry(rig.instance.replicas.directory().doc, { uuid: missingFirst, kind: "decision", topic: missingFirst, status: "decided", title: "Known elsewhere" });
  getMetaMap(rig.instance.replicas.replica(next.uuid).doc).set("topic", missingFirst);
  await rig.ok("get_doc", { uuid: next.uuid });
  const missingBefore = roomState(rig, [first.uuid, next.uuid]);
  expect(await rig.call("set_metadata", { uuid: next.uuid, title: "Do not write", description: "Do not write this either." }))
    .toMatchObject({ isError: true, payload: { error: "doc_not_hydrated", field: "title", uuid: missingFirst, applied: false, partial: false } });
  expect(roomState(rig, [first.uuid, next.uuid])).toEqual(missingBefore);
});

it("reports both target rooms and requires every room's acknowledgement", async () => {
  const rig = await localRig();
  const first = await decision(rig, { title: "A question" });
  const next = await decision(rig, { supersedes: first.uuid });
  const topicRoom = rig.instance.replicas.replica(first.uuid).room;
  const recordRoom = rig.instance.replicas.replica(next.uuid).room;
  vi.spyOn(rig.instance.replicas, "isRoomQuiet").mockImplementation(room => room !== topicRoom);
  const written = await rig.ok("set_metadata", { uuid: next.uuid, title: "A renamed question", description: "Addressed metadata." });
  expect(written).toMatchObject({ applied: true, synced: false, rooms: [
    { purpose: "document", room: recordRoom, applied: true, synced: true },
    { purpose: "topic", room: topicRoom, applied: true, synced: false },
    { purpose: "directory", room: rig.instance.replicas.directory().room, applied: true, synced: true },
  ] });
  expect(getMeta(rig.instance.replicas.replica(first.uuid).doc)).toMatchObject({ title: "A renamed question", description: "One title belongs to the whole topic." });
  expect(getMeta(rig.instance.replicas.replica(next.uuid).doc)).toMatchObject({ title: "A question", description: "Addressed metadata." });
});

it.each(["document", "topic", "directory"])("stops a multi-room rename after a %s append fails and reports completed writes", async failed => {
  const rig = await localRig();
  const first = await decision(rig, { title: "A question" });
  const next = await decision(rig, { supersedes: first.uuid });
  const topicRoom = rig.instance.replicas.replica(first.uuid).room;
  const recordRoom = rig.instance.replicas.replica(next.uuid).room;
  const directoryRoom = rig.instance.replicas.directory().room;
  const failedRoom = failed === "document" ? recordRoom : failed === "topic" ? topicRoom : directoryRoom;
  const append = rig.instance.store.appendUpdate.bind(rig.instance.store);
  vi.spyOn(rig.instance.store, "appendUpdate").mockImplementation((room, update, origin) => {
    if (room === failedRoom) throw new Error("Simulated update log failure");
    return append(room, update, origin);
  });
  const refused = await rig.call("set_metadata", { uuid: next.uuid, title: "Renamed question", description: "Addressed metadata." });
  expect(refused).toMatchObject({ isError: true, payload: {
    error: "persistence_failed", applied: false, partial: failed !== "document", synced: false, rolledBack: false,
    failed: { purpose: failed, room: failedRoom },
    completed: failed === "document" ? [] : [{ purpose: "document", room: recordRoom, applied: true }],
    recovery: expect.stringContaining("re-read"),
  } });
  expect(durableMeta(rig, topicRoom).title).toBe("A question");
  expect(durableMeta(rig, recordRoom).description).toBe(failed === "document" ? "One title belongs to the whole topic." : "Addressed metadata.");
});

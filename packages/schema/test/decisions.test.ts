import { describe, expect, it } from "vitest";
import * as Y from "yjs";
import {
  InvalidSupersedesReferenceError,
  DIRECTORY_ARCHIVED_RECORDS_KEY,
  addComment,
  appendBlock,
  createAnnotation,
  deleteBlock,
  editBlock,
  setAnnotationResolved,
  decisionDirectoryFields,
  decisionCurrentRecord,
  decisionRelations,
  decisionTopicArchived,
  decisionTopicState,
  directoryStubDiffers,
  exportMarkdown,
  getDirectoryEntry,
  getDirectoryMap,
  isDirectoryEntryArchived,
  getMeta,
  getMetaMap,
  initDoc,
  listDirectory,
  readDecisions,
  relatedDecisionTopics,
  resolveDecisionTopics,
  restoreDirectoryEntry,
  setKind,
  setDiscussion,
  setLinks,
  setStatus,
  setTldr,
  tombstoneDirectoryEntry,
  tombstoneDecisionRecord,
  upsertDirectoryEntry,
} from "../src/index.js";
import type { DirectoryUpsert } from "../src/index.js";
import { syncDocs } from "./helpers.js";

const PAGE = "11111111-1111-4111-8111-111111111111";
const A = "22222222-2222-4222-8222-222222222222";
const B = "33333333-3333-4333-8333-333333333333";
const C = "44444444-4444-4444-8444-444444444444";
const D = "55555555-5555-4555-8555-555555555555";
const E = "66666666-6666-4666-8666-666666666666";

function record(uuid = A, supersedes?: string, topic = A): Y.Doc {
  const doc = new Y.Doc();
  initDoc(doc, { uuid, title: "A choice", governs: PAGE, topic, ...(supersedes === undefined ? {} : { supersedes }) });
  setKind(doc, "decision");
  setStatus(doc, "decided");
  return doc;
}

function stub(directory: Y.Doc, uuid: string, fields: Partial<DirectoryUpsert> = {}): void {
  upsertDirectoryEntry(directory, { uuid, title: uuid, kind: "decision", topic: A, status: "decided", ...fields });
}

function ids(records: readonly { uuid: string }[]): string[] { return records.map((entry) => entry.uuid); }

function fork(): Y.Doc {
  const directory = new Y.Doc();
  stub(directory, A, { governs: PAGE, createdAt: 10 });
  stub(directory, B, { supersedes: A, createdAt: 20 });
  stub(directory, C, { supersedes: A, createdAt: 9999 });
  stub(directory, D, { supersedes: B, createdAt: 1 });
  return directory;
}

describe("decision metadata and caches", () => {
  it("stores own links and fixes both topic and predecessor at creation", () => {
    const doc = record(B, A);
    setLinks(doc, [PAGE.toUpperCase(), PAGE, E, A.toUpperCase()]);
    expect(getMeta(doc)).toMatchObject({ topic: A, governs: PAGE, supersedes: A, links: [PAGE, E, A] });
    initDoc(doc, { uuid: B, title: "Same", supersedes: A, topic: A });
    initDoc(doc, { uuid: B, title: "Same", supersedes: A });
    expect(getMeta(doc).topic).toBe(A);
    expect(() => initDoc(doc, { uuid: B, title: "Wrong", supersedes: C, topic: A })).toThrow(InvalidSupersedesReferenceError);
    expect(() => initDoc(doc, { uuid: B, title: "Wrong", supersedes: A, topic: C })).toThrow(/immutable/);
    expect(getMeta(doc).title).toBe("Same");
    const fresh = new Y.Doc();
    expect(() => initDoc(fresh, { uuid: B, title: "Missing copied topic", supersedes: A })).toThrow(/copy the predecessor/);
    expect(getMetaMap(fresh).size).toBe(0);
    const first = record();
    expect(getMeta(first).topic).toBe(A);
    expect(() => initDoc(first, { uuid: A, title: "Wrong", supersedes: B })).toThrow(InvalidSupersedesReferenceError);
    expect(() => initDoc(first, { uuid: B, title: "Wrong" })).toThrow(/immutable/);
  });

  it("fixes the related page and its absence at creation, refusing before any metadata write", () => {
    const related = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    const doc = new Y.Doc();
    initDoc(doc, { uuid: A, title: "A choice", governs: related });
    setKind(doc, "decision");
    initDoc(doc, { uuid: A, title: "Restated", governs: related.toUpperCase() });
    initDoc(doc, { uuid: A, title: "Omitted" });
    expect(getMeta(doc).governs).toBe(related);
    const before = Y.encodeStateAsUpdate(doc);
    expect(() => initDoc(doc, { uuid: A, title: "Must not change", tags: ["new"], governs: E })).toThrow(/related page is immutable/);
    expect(Y.encodeStateAsUpdate(doc)).toEqual(before);
    const adopted = new Y.Doc();
    initDoc(adopted, { uuid: B, title: "No related page" });
    setKind(adopted, "decision");
    const noPage = Y.encodeStateAsUpdate(adopted);
    expect(() => initDoc(adopted, { uuid: B, title: "Must not change", governs: PAGE })).toThrow(/related page is immutable/);
    expect(Y.encodeStateAsUpdate(adopted)).toEqual(noPage);
    expect(getMeta(adopted)).not.toHaveProperty("governs");
  });

  it("adopted decisions use their own identity as topic, tolerating foreign values", () => {
    const doc = new Y.Doc();
    initDoc(doc, { uuid: A, title: "Adopted" });
    setKind(doc, "decision");
    setStatus(doc, "withdrawn");
    const meta = getMetaMap(doc);
    meta.set("topic", "not-a-uuid");
    meta.set("governs", 42);
    meta.set("supersedes", A);
    meta.set("agentStance", "yes");
    meta.set("decidedBy", " ");
    meta.set("decidedAt", 42);
    meta.set("decidedWhere", " ");
    meta.set("approvalFingerprint", 42);
    meta.set("rejectionReason", " ");
    expect(getMeta(doc)).toMatchObject({ topic: A, status: "withdrawn" });
    expect(getMeta(doc)).not.toHaveProperty("supersedes");
    expect(getMeta(doc)).not.toHaveProperty("agentStance");
    expect(getMeta(doc)).not.toHaveProperty("decidedBy");
    expect(getMeta(doc)).not.toHaveProperty("decidedAt");
    expect(getMeta(doc)).not.toHaveProperty("decidedWhere");
    expect(getMeta(doc)).not.toHaveProperty("approvalFingerprint");
    expect(getMeta(doc)).not.toHaveProperty("rejectionReason");
  });

  it("derives the discussion edge by identity, keeps curated links, and tolerates foreign values", () => {
    const doc = record(B, A);
    expect(getMeta(doc).discussion).toBeNull();
    const discussion = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    setDiscussion(doc, discussion.toUpperCase());
    setLinks(doc, [discussion.toUpperCase(), E, discussion]);
    expect(getMeta(doc)).toMatchObject({
      discussion,
      links: [E, discussion, PAGE, A],
    });
    expect(getMetaMap(doc).get("links")).toEqual([discussion.toUpperCase(), E, discussion]);
    setDiscussion(doc, D);
    expect(getMeta(doc)).toMatchObject({ discussion: D, links: [E, discussion, PAGE, A, D] });
    setDiscussion(doc, null);
    expect(getMetaMap(doc).get("discussion")).toBeNull();
    expect(getMeta(doc).discussion).toBeNull();
    for (const malformed of [42, "not-a-uuid", undefined]) {
      getMetaMap(doc).set("discussion", malformed);
      expect(getMeta(doc).discussion).toBeNull();
      expect(getMeta(doc).links).not.toContain(D);
    }
    setKind(doc, "");
    setDiscussion(doc, D);
    expect(getMeta(doc)).not.toHaveProperty("discussion");
    expect(getMeta(doc).links).not.toContain(D);
  });

  it("caches all decision fields and counts comments across resolved and orphaned threads", () => {
    const doc = record(B, A);
    setTldr(doc, "Use durable rooms.");
    const meta = getMetaMap(doc);
    meta.set("agentStance", false);
    meta.set("decidedBy", "a-person");
    meta.set("decidedAt", "2026-10-03T12:00:00Z");
    meta.set("decidedWhere", "An owner answer");
    meta.set("rejectionReason", "The alternative fits the constraint");
    expect(getMeta(doc)).toMatchObject({ decidedWhere: "An owner answer", rejectionReason: "The alternative fits the constraint" });
    const block = appendBlock(doc, { type: "paragraph", text: "Reasoning" });
    const thread = createAnnotation(doc, block, 0, 3, "a-person", "One");
    addComment(doc, thread.id, "another-person", "Two");
    const resolved = createAnnotation(doc, block, 3, 6, "a-person", "Three");
    setAnnotationResolved(doc, resolved.id, true);
    deleteBlock(doc, block);
    const fields = decisionDirectoryFields(doc);
    expect(fields).toEqual({ governs: PAGE, topic: A, supersedes: A, discussion: null, answerPreview: null, agentStance: false, decidedBy: "a-person", decidedAt: "2026-10-03T12:00:00Z", approvalChanged: false, commentCount: 3 });
    const directory = new Y.Doc();
    upsertDirectoryEntry(directory, { ...getMeta(doc), description: getMeta(doc).description ?? "", ...fields });
    expect(directoryStubDiffers(getDirectoryEntry(directory, B), getMeta(doc), fields)).toBe(false);
    addComment(doc, thread.id, "a-person", "Four");
    expect(directoryStubDiffers(getDirectoryEntry(directory, B), getMeta(doc), decisionDirectoryFields(doc))).toBe(true);
  });

  it("preserves omitted fields across upserts and topic archive/restore, and repairs clears", () => {
    const doc = record(B, A);
    setTldr(doc, "The answer.");
    getMetaMap(doc).set("agentStance", true);
    const directory = new Y.Doc();
    stub(directory, A);
    upsertDirectoryEntry(directory, { ...getMeta(doc), description: getMeta(doc).description ?? "", ...decisionDirectoryFields(doc) });
    const before = getDirectoryEntry(directory, B)!;
    upsertDirectoryEntry(directory, { uuid: B, title: "Renamed" });
    tombstoneDirectoryEntry(directory, B);
    restoreDirectoryEntry(directory, A);
    expect(getDirectoryEntry(directory, B)).toEqual({ ...before, title: "Renamed" });
    getMetaMap(doc).set("agentStance", null);
    setTldr(doc, null);
    expect(directoryStubDiffers(getDirectoryEntry(directory, B), getMeta(doc), decisionDirectoryFields(doc))).toBe(true);
    upsertDirectoryEntry(directory, { ...getMeta(doc), description: getMeta(doc).description ?? "", ...decisionDirectoryFields(doc) });
    expect(getDirectoryEntry(directory, B)).not.toHaveProperty("agentStance");
    expect(getDirectoryEntry(directory, B)).not.toHaveProperty("tldr");
    expect(directoryStubDiffers(getDirectoryEntry(directory, B), getMeta(doc), decisionDirectoryFields(doc))).toBe(false);
  });

  it.each(["Legacy answer", "   "])("ignores a stored legacy TL;DR %j and repairs its preview without changing the record", (tldr) => {
    const doc = record();
    getMetaMap(doc).set("tldr", tldr);
    appendBlock(doc, { type: "paragraph", text: "Current answer" });
    const before = Y.encodeStateAsUpdate(doc);
    const directory = new Y.Doc();
    getDirectoryMap(directory).set(A, { title: "A choice", tags: [], kind: "decision", status: "decided", topic: A, tldr, answerPreview: tldr });
    expect(getDirectoryEntry(directory, A)).not.toHaveProperty("tldr");
    expect(listDirectory(directory)[0]).not.toHaveProperty("tldr");
    expect(directoryStubDiffers(getDirectoryEntry(directory, A), getMeta(doc), decisionDirectoryFields(doc))).toBe(true);
    upsertDirectoryEntry(directory, { ...getMeta(doc), description: "", ...decisionDirectoryFields(doc) });
    expect(getDirectoryEntry(directory, A)).toMatchObject({ answerPreview: "Current answer" });
    expect(getDirectoryEntry(directory, A)).not.toHaveProperty("tldr");
    expect(directoryStubDiffers(getDirectoryEntry(directory, A), getMeta(doc), decisionDirectoryFields(doc))).toBe(false);
    expect(getMetaMap(doc).get("tldr")).toBe(tldr);
    expect(Y.encodeStateAsUpdate(doc)).toEqual(before);
    doc.destroy();
    directory.destroy();
  });

  it("caches plain answer previews from the first prose block and ignores legacy TL;DR", () => {
    const doc = record();
    appendBlock(doc, { type: "code", text: "ignored source" });
    appendBlock(doc, {
      type: "paragraph", inline: [
        { text: "  Use\n", marks: { bold: true } },
        { text: "this   answer. ", marks: { link: "https://example.com" } },
      ],
    });
    appendBlock(doc, { type: "paragraph", text: "Ignored later answer" });
    expect(decisionDirectoryFields(doc).answerPreview).toBe("Use this answer.");
    setTldr(doc, "  Legacy\nanswer ");
    expect(decisionDirectoryFields(doc).answerPreview).toBe("Use this answer.");
    const list = record(B, A);
    appendBlock(list, { type: "list-item", text: "First choice", list: "ordered" });
    appendBlock(list, { type: "list-item", inline: [{ text: "Second choice", marks: { italic: true } }], indent: 2 });
    appendBlock(list, { type: "code", text: "stop" });
    appendBlock(list, { type: "list-item", text: "Ignored later run" });
    expect(decisionDirectoryFields(list).answerPreview).toBe("First choice; Second choice");
  });

  it("distinguishes no prose preview, empty prose, and previews truncated to 300 characters", () => {
    const doc = record();
    expect(decisionDirectoryFields(doc).answerPreview).toBeNull();
    appendBlock(doc, { type: "code", text: "Only source" });
    appendBlock(doc, { type: "table", text: "| Value |\n| --- |\n| Only table |" });
    setTldr(doc, "A legacy summary is no answer prose.");
    expect(decisionDirectoryFields(doc).answerPreview).toBeNull();
    const short = record(B, A);
    const id = appendBlock(short, { type: "paragraph", text: " \n\t " });
    expect(decisionDirectoryFields(short).answerPreview).toBe("");
    deleteBlock(short, id);
    appendBlock(short, { type: "paragraph", text: "x".repeat(300) });
    expect(decisionDirectoryFields(short).answerPreview).toBe("x".repeat(300));
    const long = record(C, A);
    appendBlock(long, { type: "paragraph", text: "😀".repeat(301) });
    expect(decisionDirectoryFields(long).answerPreview).toBe(`${"😀".repeat(299)}…`);
  });

  it("treats missing preview caches as unknown and repairs old-client rewrites", () => {
    const doc = record();
    const block = appendBlock(doc, { type: "paragraph", text: "Current answer" });
    const directory = new Y.Doc();
    stub(directory, A, { governs: PAGE });
    expect(getDirectoryEntry(directory, A)).not.toHaveProperty("answerPreview");
    const fields = decisionDirectoryFields(doc);
    expect(directoryStubDiffers(getDirectoryEntry(directory, A), getMeta(doc), fields)).toBe(true);
    upsertDirectoryEntry(directory, { ...getMeta(doc), description: "", ...fields });
    expect(getDirectoryEntry(directory, A)?.answerPreview).toBe("Current answer");
    expect(getDirectoryEntry(directory, A)).not.toHaveProperty("tldr");
    expect(directoryStubDiffers(getDirectoryEntry(directory, A), getMeta(doc), fields)).toBe(false);
    upsertDirectoryEntry(directory, { uuid: A, title: "A choice" });
    expect(getDirectoryEntry(directory, A)?.answerPreview).toBe("Current answer");
    const cached = getDirectoryMap(directory).get(A) as Record<string, unknown>;
    const oldClientRewrite = { ...cached };
    delete oldClientRewrite.answerPreview;
    getDirectoryMap(directory).set(A, oldClientRewrite);
    expect(getDirectoryEntry(directory, A)).not.toHaveProperty("answerPreview");
    expect(directoryStubDiffers(getDirectoryEntry(directory, A), getMeta(doc), fields)).toBe(true);
    upsertDirectoryEntry(directory, { ...getMeta(doc), description: "", ...fields });
    expect(getDirectoryEntry(directory, A)?.answerPreview).toBe("Current answer");
    tombstoneDirectoryEntry(directory, A);
    restoreDirectoryEntry(directory, A);
    expect(getDirectoryEntry(directory, A)?.answerPreview).toBe("Current answer");
    editBlock(doc, block, "Current answer", "Changed answer");
    const updatedFields = decisionDirectoryFields(doc);
    expect(directoryStubDiffers(getDirectoryEntry(directory, A), getMeta(doc), updatedFields)).toBe(true);
    upsertDirectoryEntry(directory, { ...getMeta(doc), description: "", ...updatedFields });
    expect(getDirectoryEntry(directory, A)?.answerPreview).toBe("Changed answer");
    expect(directoryStubDiffers(getDirectoryEntry(directory, A), getMeta(doc), updatedFields)).toBe(false);
  });

  it("repairs missing discussion caches and carries the reference through stub rewrites and topic archival", () => {
    const doc = record(B, A);
    const directory = new Y.Doc();
    stub(directory, A);
    stub(directory, B, { governs: PAGE, supersedes: A });
    const repair = () => upsertDirectoryEntry(directory, { ...getMeta(doc), description: "", ...decisionDirectoryFields(doc) });
    expect(getDirectoryEntry(directory, B)).not.toHaveProperty("discussion");
    expect(directoryStubDiffers(getDirectoryEntry(directory, B), getMeta(doc), decisionDirectoryFields(doc))).toBe(true);
    repair();
    expect(getDirectoryEntry(directory, B)?.discussion).toBeNull();
    expect(directoryStubDiffers(getDirectoryEntry(directory, B), getMeta(doc), decisionDirectoryFields(doc))).toBe(false);
    setDiscussion(doc, E);
    expect(directoryStubDiffers(getDirectoryEntry(directory, B), getMeta(doc), decisionDirectoryFields(doc))).toBe(true);
    repair();
    upsertDirectoryEntry(directory, { uuid: B, title: "Renamed" });
    tombstoneDirectoryEntry(directory, A);
    expect(getDirectoryEntry(directory, B)?.discussion).toBe(E);
    restoreDirectoryEntry(directory, A);
    expect(getDirectoryEntry(directory, B)?.discussion).toBe(E);
    const cached = getDirectoryMap(directory).get(B) as Record<string, unknown>;
    const oldClientRewrite = { ...cached };
    delete oldClientRewrite.discussion;
    getDirectoryMap(directory).set(B, oldClientRewrite);
    expect(getDirectoryEntry(directory, B)).not.toHaveProperty("discussion");
    expect(directoryStubDiffers(getDirectoryEntry(directory, B), getMeta(doc), decisionDirectoryFields(doc))).toBe(true);
    repair();
    expect(getDirectoryEntry(directory, B)?.discussion).toBe(E);
    setDiscussion(doc, null);
    expect(directoryStubDiffers(getDirectoryEntry(directory, B), getMeta(doc), decisionDirectoryFields(doc))).toBe(true);
    repair();
    expect(getDirectoryEntry(directory, B)?.discussion).toBeNull();
    expect(directoryStubDiffers(getDirectoryEntry(directory, B), getMeta(doc), decisionDirectoryFields(doc))).toBe(false);
    doc.destroy();
    directory.destroy();
  });

  it("keeps decision-only cache fields out of regular and stored requirement stubs", () => {
    const directory = new Y.Doc();
    upsertDirectoryEntry(directory, { uuid: A, title: "Ordinary", topic: A, governs: PAGE, discussion: E, answerPreview: "No", agentStance: true, approvalChanged: true, commentCount: 10 });
    getDirectoryMap(directory).set(B, { title: "Stored proposal", tags: [], kind: "requirement", status: "planned", topic: A, discussion: null, answerPreview: null, commentCount: 10 });
    expect(getDirectoryEntry(directory, A)).toEqual({ uuid: A, title: "Ordinary", tags: [] });
    expect(getDirectoryEntry(directory, B)).toEqual({ uuid: B, title: "Stored proposal", tags: [] });
    getDirectoryMap(directory).set(C, { title: "Malformed", kind: "decision", topic: false, discussion: "not-a-uuid", commentCount: -1, decidedBy: {}, answerPreview: 42, agentStance: "true", approvalChanged: "true" });
    expect(getDirectoryEntry(directory, C)).toEqual({ uuid: C, title: "Malformed", tags: [], kind: "decision" });
    upsertDirectoryEntry(directory, { uuid: C, title: "No prose", answerPreview: null });
    expect(getDirectoryEntry(directory, C)?.answerPreview).toBeNull();
    upsertDirectoryEntry(directory, { uuid: C, title: "Discussion", discussion: E.toUpperCase() });
    expect(getDirectoryEntry(directory, C)?.discussion).toBe(E);
  });
});

describe("stubs-only topic resolution", () => {
  it("hides archived intermediates without changing supersession or the topic authority", () => {
    const directory = new Y.Doc();
    stub(directory, A, { createdAt: 10 });
    stub(directory, B, { supersedes: A, createdAt: 20 });
    stub(directory, C, { supersedes: B, createdAt: 30 });
    expect(tombstoneDecisionRecord(directory, B)).toBe(true);
    expect(tombstoneDecisionRecord(directory, A)).toBe(true);
    const topic = resolveDecisionTopics(directory)[0]!;
    expect(ids(topic.records)).toEqual([C]);
    expect(ids(topic.archivedRecords)).toEqual([A, B]);
    expect(ids(topic.allRecords)).toEqual([A, B, C]);
    expect(topic.first?.uuid).toBe(A);
    expect(topic.archived).toBe(false);
    expect(topic.inForce?.uuid).toBe(C);
    expect(topic.conflicts).toEqual([]);
    expect(ids(decisionRelations(directory, C).predecessors)).toEqual([B, A]);
    expect(isDirectoryEntryArchived(directory, A)).toBe(true);
    expect(decisionTopicArchived(directory, A)).toBe(false);
    expect(ids(listDirectory(directory))).toEqual([C]);
    expect(restoreDirectoryEntry(directory, B)).toEqual([B]);
    expect(ids(resolveDecisionTopics(directory)[0]!.records)).toEqual([B, C]);
    expect(ids(resolveDecisionTopics(directory)[0]!.superseded)).toEqual([B]);
  });

  it("removes archived proposals from pending without hiding other proposals", () => {
    const directory = new Y.Doc();
    stub(directory, A, { createdAt: 10 });
    stub(directory, B, { status: "open", supersedes: A, createdAt: 20 });
    stub(directory, C, { status: "open", supersedes: A, createdAt: 30 });
    expect(tombstoneDecisionRecord(directory, B)).toBe(true);
    let topic = resolveDecisionTopics(directory)[0]!;
    expect(ids(topic.pending)).toEqual([C]);
    expect(decisionTopicState(topic)).toBe("under-review");
    expect(tombstoneDecisionRecord(directory, C)).toBe(true);
    topic = resolveDecisionTopics(directory)[0]!;
    expect(topic.pending).toEqual([]);
    expect(topic.inForce?.uuid).toBe(A);
    expect(decisionTopicState(topic)).toBe("in-force");
  });

  it.each(["rejected", "withdrawn"] as const)("archives a %s intermediary without changing the remaining states", (status) => {
    const directory = new Y.Doc();
    stub(directory, A, { createdAt: 10 });
    stub(directory, B, { status, supersedes: A, createdAt: 20 });
    stub(directory, C, { supersedes: B, createdAt: 30 });
    expect(tombstoneDecisionRecord(directory, B)).toBe(true);
    const topic = resolveDecisionTopics(directory)[0]!;
    expect(ids(topic.records)).toEqual([A, C]);
    expect(ids(topic.superseded)).toEqual([A]);
    expect(topic.inForce?.uuid).toBe(C);
    expect(ids(topic.archivedRecords)).toEqual([B]);
    expect(restoreDirectoryEntry(directory, B)).toEqual([B]);
    expect(ids(resolveDecisionTopics(directory)[0]![status])).toEqual([B]);
  });

  it("refuses current and conflicting answers and ignores marks when a proposal is approved", () => {
    const directory = new Y.Doc();
    stub(directory, A);
    stub(directory, B, { status: "open", supersedes: A });
    expect(tombstoneDecisionRecord(directory, A)).toBe(false);
    expect(tombstoneDecisionRecord(directory, B)).toBe(true);
    stub(directory, B, { status: "decided" });
    expect(getDirectoryEntry(directory, B)?.recordArchived).toBeUndefined();
    expect(isDirectoryEntryArchived(directory, B)).toBe(false);
    expect(resolveDecisionTopics(directory)[0]!.inForce?.uuid).toBe(B);
    stub(directory, C, { status: "decided", supersedes: A });
    directory.getMap(DIRECTORY_ARCHIVED_RECORDS_KEY).set(C, true);
    const topic = resolveDecisionTopics(directory)[0]!;
    expect(ids(topic.conflicts)).toEqual([B, C]);
    expect(topic.archivedRecords).toEqual([]);
    expect(tombstoneDecisionRecord(directory, B)).toBe(false);
    expect(tombstoneDecisionRecord(directory, C)).toBe(false);
    expect(ids(listDirectory(directory))).toEqual([A, B, C]);
  });

  it.each([1, 3])("keeps concurrently approved archived proposals visible on every replica (client %i)", (archiverId) => {
    const directory = new Y.Doc();
    directory.clientID = archiverId;
    const approver = new Y.Doc();
    approver.clientID = 2;
    stub(directory, A, { createdAt: 10 });
    stub(directory, B, { status: "open", supersedes: A, createdAt: 20 });
    stub(directory, C, { status: "open", supersedes: A, createdAt: 30 });
    syncDocs(directory, approver);
    expect(tombstoneDecisionRecord(directory, B)).toBe(true);
    // An older replica accepts approvals without seeing the record's archive.
    stub(approver, B, { status: "decided" });
    syncDocs(directory, approver);
    for (const replica of [directory, approver]) {
      expect(replica.getMap(DIRECTORY_ARCHIVED_RECORDS_KEY).get(B)).toBe(true);
      expect(isDirectoryEntryArchived(replica, B)).toBe(false);
      expect(resolveDecisionTopics(replica)[0]!.inForce?.uuid).toBe(B);
    }
    expect(tombstoneDecisionRecord(directory, C)).toBe(true);
    stub(approver, C, { status: "decided" });
    syncDocs(directory, approver);
    for (const replica of [directory, approver]) {
      expect(ids(resolveDecisionTopics(replica)[0]!.conflicts)).toEqual([B, C]);
      expect(isDirectoryEntryArchived(replica, B)).toBe(false);
      expect(isDirectoryEntryArchived(replica, C)).toBe(false);
    }
    expect(resolveDecisionTopics(directory)).toEqual(resolveDecisionTopics(approver));
  });

  it("keeps a topic reachable when concurrent archives hide its final live records", () => {
    const directory = new Y.Doc();
    stub(directory, A, { status: "open", createdAt: 10 });
    stub(directory, B, { status: "open", createdAt: 20 });
    const peer = new Y.Doc(); syncDocs(directory, peer);
    expect(tombstoneDecisionRecord(directory, A)).toBe(true);
    expect(tombstoneDecisionRecord(peer, B)).toBe(true);
    syncDocs(directory, peer);
    const topic = resolveDecisionTopics(directory)[0]!;
    expect(topic.records).toEqual([]);
    expect(topic.first?.uuid).toBe(A);
    expect(topic.archived).toBe(false);
    expect(decisionCurrentRecord(topic)?.uuid).toBe(B);
    expect(restoreDirectoryEntry(directory, A)).toEqual([A]);
    expect(ids(resolveDecisionTopics(directory)[0]!.records)).toEqual([A]);
  });

  it("derives topic states with conflict precedence and preserves the answer during review", () => {
    const directory = new Y.Doc();
    stub(directory, A, { createdAt: 10, agentStance: true });
    expect(decisionTopicState(resolveDecisionTopics(directory)[0]!)).toBe("agent-stance");
    stub(directory, A, { agentStance: false });
    expect(decisionTopicState(resolveDecisionTopics(directory)[0]!)).toBe("in-force");
    stub(directory, B, { status: "open", supersedes: A, createdAt: 20 });
    const underReview = resolveDecisionTopics(directory)[0]!;
    expect(decisionTopicState(underReview)).toBe("under-review");
    expect(decisionCurrentRecord(underReview)?.uuid).toBe(A);
    stub(directory, C, { supersedes: A, createdAt: 30 });
    stub(directory, D, { supersedes: A, createdAt: 40 });
    const conflict = resolveDecisionTopics(directory)[0]!;
    expect(conflict.pending).toHaveLength(1);
    expect(decisionTopicState(conflict)).toBe("conflict");
    expect(decisionCurrentRecord(conflict)?.uuid).toBe(D);
  });

  it("shows unanswered topics as not yet decided and opens the latest stored record", () => {
    const directory = new Y.Doc();
    stub(directory, A, { status: "open", createdAt: 10 });
    stub(directory, B, { status: "rejected", supersedes: A, createdAt: 20 });
    stub(directory, C, { status: "withdrawn", supersedes: B, createdAt: 30 });
    const topic = resolveDecisionTopics(directory)[0]!;
    expect(decisionTopicState(topic)).toBe("not-yet-decided");
    expect(topic.pending).toHaveLength(1);
    expect(topic.representative.uuid).toBe(A);
    expect(decisionCurrentRecord(topic)?.uuid).toBe(C);
    expect(decisionCurrentRecord({ ...topic, records: [], archivedRecords: [] })).toBeNull();
  });

  it("preserves the B/C/D fork and resolves through rejected intermediates without timestamp winners", () => {
    const directory = fork();
    const topic = resolveDecisionTopics(directory)[0]!;
    expect(topic.inForce).toBeNull();
    expect(ids(topic.conflicts).sort()).toEqual([C, D]);
    expect(topic.representative.uuid).toBe(A);
    expect(ids(topic.superseded).sort()).toEqual([A, B]);
    stub(directory, B, { supersedes: A, status: "rejected" });
    expect(ids(resolveDecisionTopics(directory)[0]!.conflicts).sort()).toEqual([C, D]);
    stub(directory, C, { supersedes: A, status: "withdrawn" });
    expect(resolveDecisionTopics(directory)[0]!.inForce?.uuid).toBe(D);
    expect(ids(resolveDecisionTopics(directory)[0]!.rejected)).toEqual([B]);
    expect(ids(resolveDecisionTopics(directory)[0]!.withdrawn)).toEqual([C]);
    const relation = decisionRelations(directory, A);
    expect(ids(relation.successors).sort()).toEqual([B, C]);
    expect(relation.successors.map((entry) => entry.status)).toEqual(["rejected", "withdrawn"]);
    expect(ids(decisionRelations(directory, D).predecessors)).toEqual([B, A]);
  });

  it("keeps the earlier answer while reconsiderations are open, and pending excludes superseded proposals", () => {
    const directory = new Y.Doc();
    stub(directory, A);
    stub(directory, B, { status: "open", supersedes: A });
    stub(directory, C, { status: "open", supersedes: A });
    stub(directory, D, { status: "open", supersedes: B });
    expect(resolveDecisionTopics(directory)[0]!.inForce?.uuid).toBe(A);
    expect(ids(resolveDecisionTopics(directory)[0]!.pending).sort()).toEqual([C, D]);
    stub(directory, D, { status: "withdrawn", supersedes: B });
    expect(ids(resolveDecisionTopics(directory)[0]!.pending).sort()).toEqual([B, C]);
  });

  it("reports nothing in force for only-open, rejected or withdrawn topics", () => {
    const directory = new Y.Doc();
    stub(directory, A, { status: "rejected" });
    stub(directory, B, { topic: B, status: "withdrawn" });
    stub(directory, C, { topic: C, status: "open" });
    const topics = resolveDecisionTopics(directory);
    expect(topics.map((topic) => topic.inForce)).toEqual([null, null, null]);
    expect(topics.map((topic) => topic.representative.uuid)).toEqual([A, B, C]);
  });

  it("terminates foreign cycles and never joins topics through a cross-topic predecessor", () => {
    const directory = new Y.Doc();
    stub(directory, A, { supersedes: B });
    stub(directory, B, { supersedes: A });
    stub(directory, C, { topic: C, supersedes: A });
    const topics = resolveDecisionTopics(directory);
    expect(topics[0]!.inForce).toBeNull();
    expect(ids(topics[0]!.superseded)).toEqual([A, B]);
    expect(topics[1]!.inForce?.uuid).toBe(C);
    expect(ids(decisionRelations(directory, A).predecessors)).toEqual([B]);
  });

  it("uses first-record archive authority even with partial and concurrent mirrors", () => {
    const directory = fork();
    // Foreign partial archive: newest record is tombstoned, authority remains live.
    const d = getDirectoryMap(directory).get(D) as Record<string, unknown>;
    getDirectoryMap(directory).set(D, { ...d, deleted: true });
    expect(ids(listDirectory(directory))).toContain(D);
    expect(resolveDecisionTopics(directory)[0]!.archived).toBe(false);
    expect(decisionTopicArchived(directory, D)).toBe(false);
    const resolution = ids(resolveDecisionTopics(directory)[0]!.conflicts);
    expect(tombstoneDirectoryEntry(directory, B)).toEqual([A, B, C, D]);
    expect(listDirectory(directory)).toEqual([]);
    expect(ids(resolveDecisionTopics(directory)[0]!.conflicts)).toEqual(resolution);
    expect(decisionTopicArchived(directory, D)).toBe(true);
    expect(restoreDirectoryEntry(directory, C)).toEqual([A, B, C, D]);
    expect(listDirectory(directory)).toHaveLength(4);
    const other = new Y.Doc(); syncDocs(directory, other);
    tombstoneDirectoryEntry(directory, D);
    restoreDirectoryEntry(other, B);
    syncDocs(directory, other);
    expect(resolveDecisionTopics(directory)).toEqual(resolveDecisionTopics(other));
    expect(ids(resolveDecisionTopics(directory)[0]!.conflicts)).toEqual(resolution);
  });

  it("archives and restores a foreign topic with a missing first stub without an ordinary phantom", () => {
    const directory = new Y.Doc();
    stub(directory, B, { supersedes: A });
    expect(resolveDecisionTopics(directory)[0]!.archived).toBe(false);
    tombstoneDirectoryEntry(directory, B);
    expect(decisionTopicArchived(directory, B)).toBe(true);
    expect(resolveDecisionTopics(directory)[0]!.archived).toBe(true);
    expect(listDirectory(directory)).toEqual([]);
    expect(getDirectoryEntry(directory, A)).toMatchObject({ kind: "decision", topic: A });
    expect(restoreDirectoryEntry(directory, A)).toEqual([A, B]);
    expect(listDirectory(directory)).toHaveLength(2);
    expect(listDirectory(directory).every((entry) => entry.kind === "decision")).toBe(true);
    expect(decisionTopicArchived(directory, B)).toBe(false);
    expect(resolveDecisionTopics(directory)[0]!.inForce?.uuid).toBe(B);
    expect(tombstoneDirectoryEntry(directory, A)).toEqual([A, B]);
    expect(listDirectory(directory)).toEqual([]);
  });

  it.each([undefined, "draft", "planned", "implementing", "done"] as const)("derives a regular-page log and Markdown through stored requirement status %s", (status) => {
    const directory = fork();
    stub(directory, E, { topic: E, governs: PAGE, status: "open", createdAt: 0 });
    const page = new Y.Doc();
    initDoc(page, { uuid: PAGE, title: "Regular page" });
    getMetaMap(page).set("kind", "requirement");
    if (status !== undefined) getMetaMap(page).set("status", status);
    // Even a stale foreign legacy root cannot influence a read or export.
    page.getArray("decisions").insert(0, [D]);
    const before = Y.encodeStateAsUpdate(page);
    expect(readDecisions(page, directory).map((topic) => topic.topic)).toEqual([E, A]);
    const markdown = exportMarkdown(page, { frontmatter: false, directory });
    expect(markdown).toContain(`${A} — ${A} — nothing in force; conflict:`);
    expect(markdown).toContain(`${E} — ${E} — nothing in force; pending: ${E}`);
    tombstoneDirectoryEntry(directory, B);
    expect(readDecisions(page, directory).map((topic) => topic.topic)).toEqual([E]);
    expect(exportMarkdown(page, { frontmatter: false, directory })).not.toContain(`- ${A}`);
    expect(readDecisions(page)).toEqual([]);
    expect(Y.encodeStateAsUpdate(page)).toEqual(before);
    expect(getMetaMap(page).get("kind")).toBe("requirement");
    expect(getMetaMap(page).get("status")).toBe(status);
  });

  it("includes related rejected and withdrawn history while never listing decisions on a decision record", () => {
    const directory = new Y.Doc();
    stub(directory, A, { createdAt: 10 });
    stub(directory, B, { supersedes: A, status: "rejected", governs: PAGE });
    stub(directory, C, { topic: C, createdAt: 5 });
    stub(directory, D, { topic: C, supersedes: C, status: "withdrawn", governs: PAGE });
    const page = new Y.Doc();
    initDoc(page, { uuid: PAGE, title: "Regular page" });
    expect(readDecisions(page, directory).map((topic) => topic.topic)).toEqual([C, A]);
    setKind(page, "decision");
    expect(readDecisions(page, directory)).toEqual([]);
  });

  it("shares regular-page membership from resolved stubs without writes or linked-only topics", () => {
    const directory = new Y.Doc();
    stub(directory, A, { topic: A, governs: PAGE, createdAt: 10 });
    stub(directory, B, { supersedes: A, governs: E, createdAt: 20 });
    stub(directory, C, { topic: C, governs: PAGE, createdAt: 5 });
    stub(directory, D, { topic: D, discussion: PAGE, createdAt: 1 });
    const before = Y.encodeStateAsUpdate(directory);
    const topics = resolveDecisionTopics(listDirectory(directory, { includeDeleted: true }));
    expect(relatedDecisionTopics(topics, { uuid: PAGE }).map((topic) => topic.topic)).toEqual([C, A]);
    expect(relatedDecisionTopics(topics, { uuid: E }).map((topic) => topic.topic)).toEqual([A]);
    expect(relatedDecisionTopics(topics, { uuid: PAGE, kind: "decision" })).toEqual([]);
    expect(Y.encodeStateAsUpdate(directory)).toEqual(before);
    const page = new Y.Doc();
    initDoc(page, { uuid: PAGE, title: "Regular page" });
    expect(relatedDecisionTopics(topics, getMeta(page))).toEqual(readDecisions(page, directory));
    tombstoneDirectoryEntry(directory, C);
    const archived = resolveDecisionTopics(listDirectory(directory, { includeDeleted: true }));
    expect(relatedDecisionTopics(archived, getMeta(page))).toEqual(readDecisions(page, directory));
    expect(relatedDecisionTopics(archived, getMeta(page)).map((topic) => topic.topic)).toEqual([A]);
  });
});

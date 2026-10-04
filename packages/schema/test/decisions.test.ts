import { describe, expect, it } from "vitest";
import * as Y from "yjs";
import {
  InvalidSupersedesReferenceError,
  addComment,
  appendBlock,
  createAnnotation,
  deleteBlock,
  setAnnotationResolved,
  decisionDirectoryFields,
  decisionRelations,
  decisionTopicArchived,
  directoryStubDiffers,
  exportMarkdown,
  getDirectoryEntry,
  getDirectoryMap,
  getMeta,
  getMetaMap,
  initDoc,
  listDirectory,
  readDecisions,
  resolveDecisionTopics,
  restoreDirectoryEntry,
  setKind,
  setLinks,
  setStatus,
  setTldr,
  tombstoneDirectoryEntry,
  upsertDirectoryEntry,
} from "../src/index.js";
import type { DirectoryUpsert } from "../src/index.js";
import { syncDocs } from "./helpers.js";

const REQUIREMENT = "11111111-1111-4111-8111-111111111111";
const A = "22222222-2222-4222-8222-222222222222";
const B = "33333333-3333-4333-8333-333333333333";
const C = "44444444-4444-4444-8444-444444444444";
const D = "55555555-5555-4555-8555-555555555555";
const E = "66666666-6666-4666-8666-666666666666";

function record(uuid = A, supersedes?: string, topic = A): Y.Doc {
  const doc = new Y.Doc();
  initDoc(doc, { uuid, title: "A choice", governs: REQUIREMENT, topic, ...(supersedes === undefined ? {} : { supersedes }) });
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
  stub(directory, A, { governs: REQUIREMENT, createdAt: 10 });
  stub(directory, B, { supersedes: A, createdAt: 20 });
  stub(directory, C, { supersedes: A, createdAt: 9999 });
  stub(directory, D, { supersedes: B, createdAt: 1 });
  return directory;
}

describe("decision metadata and caches", () => {
  it("stores own links and fixes both topic and predecessor at creation", () => {
    const doc = record(B, A);
    setLinks(doc, [REQUIREMENT.toUpperCase(), REQUIREMENT, E, A.toUpperCase()]);
    expect(getMeta(doc)).toMatchObject({ topic: A, governs: REQUIREMENT, supersedes: A, links: [REQUIREMENT, E, A] });
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
    expect(fields).toEqual({ governs: REQUIREMENT, topic: A, supersedes: A, tldr: "Use durable rooms.", agentStance: false, decidedBy: "a-person", decidedAt: "2026-10-03T12:00:00Z", approvalChanged: false, commentCount: 3 });
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

  it("converges a foreign whitespace TL;DR instead of repeatedly repairing it", () => {
    const doc = record();
    getMetaMap(doc).set("tldr", "   ");
    const directory = new Y.Doc();
    upsertDirectoryEntry(directory, { ...getMeta(doc), description: "", ...decisionDirectoryFields(doc) });
    expect(getDirectoryEntry(directory, A)?.tldr).toBe("   ");
    expect(directoryStubDiffers(getDirectoryEntry(directory, A), getMeta(doc), decisionDirectoryFields(doc))).toBe(false);
  });

  it("keeps decision-only cache fields out of ordinary and requirement stubs", () => {
    const directory = new Y.Doc();
    upsertDirectoryEntry(directory, { uuid: A, title: "Ordinary", topic: A, governs: REQUIREMENT, tldr: "No", agentStance: true, approvalChanged: true, commentCount: 10 });
    upsertDirectoryEntry(directory, { uuid: B, title: "Product", kind: "requirement", topic: A, commentCount: 10 });
    expect(getDirectoryEntry(directory, A)).toEqual({ uuid: A, title: "Ordinary", tags: [] });
    expect(getDirectoryEntry(directory, B)).toEqual({ uuid: B, title: "Product", tags: [], kind: "requirement" });
    getDirectoryMap(directory).set(C, { title: "Malformed", kind: "decision", topic: false, commentCount: -1, decidedBy: {}, agentStance: "true", approvalChanged: "true" });
    expect(getDirectoryEntry(directory, C)).toEqual({ uuid: C, title: "Malformed", tags: [], kind: "decision" });
  });
});

describe("stubs-only topic resolution", () => {
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

  it("derives a requirement log and Markdown from any governing history record, oldest topics first", () => {
    const directory = fork();
    stub(directory, E, { topic: E, governs: REQUIREMENT, status: "open", createdAt: 0 });
    const requirement = new Y.Doc();
    initDoc(requirement, { uuid: REQUIREMENT, title: "Product" }); setKind(requirement, "requirement");
    // Even a stale foreign legacy root cannot influence a read or export.
    requirement.getArray("decisions").insert(0, [D]);
    expect(readDecisions(requirement, directory).map((topic) => topic.topic)).toEqual([E, A]);
    const markdown = exportMarkdown(requirement, { frontmatter: false, directory });
    expect(markdown).toContain(`${A} — ${A} — nothing in force; conflict:`);
    expect(markdown).toContain(`${E} — ${E} — nothing in force; pending: ${E}`);
    tombstoneDirectoryEntry(directory, B);
    expect(readDecisions(requirement, directory).map((topic) => topic.topic)).toEqual([E]);
    expect(exportMarkdown(requirement, { frontmatter: false, directory })).not.toContain(`- ${A}`);
    expect(readDecisions(requirement)).toEqual([]);
  });
});

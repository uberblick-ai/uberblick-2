import { describe, expect, it } from "vitest";
import * as Y from "yjs";
import {
  addComment,
  appendBlock,
  createAnnotation,
  decisionApprovalChanged,
  decisionApprovalFingerprint,
  decisionDirectoryFields,
  deleteAnnotation,
  deleteBlock,
  directoryStubDiffers,
  editBlock,
  getBlocks,
  getDirectoryEntry,
  getMeta,
  getMetaMap,
  initDoc,
  listDirectory,
  restoreDirectoryEntry,
  setAnnotationResolved,
  setChangelogSuggestion,
  setDescription,
  setInlineLink,
  setKind,
  setLinks,
  setStatus,
  setTags,
  setTitle,
  setTldr,
  tombstoneDirectoryEntry,
  upsertDirectoryEntry,
} from "../src/index.js";
import { syncDocs } from "./helpers.js";

const UUID = "22222222-2222-4222-8222-222222222222";
const TARGET = "33333333-3333-4333-8333-333333333333";

function decision(texts = ["First reason", "Second reason"]): Y.Doc {
  const doc = new Y.Doc();
  initDoc(doc, { uuid: UUID, title: "The topic" });
  setKind(doc, "decision");
  setStatus(doc, "decided");
  setTldr(doc, "The decision.");
  for (const text of texts) appendBlock(doc, { type: "paragraph", text });
  return doc;
}

function approve(doc: Y.Doc): void {
  const meta = getMetaMap(doc);
  doc.transact(() => {
    meta.set("decidedBy", "a-person");
    meta.set("decidedAt", "2026-10-03T12:00:00Z");
    meta.set("decidedWhere", "An owner answer");
    meta.set("approvalFingerprint", decisionApprovalFingerprint(doc));
  });
}

function repair(directory: Y.Doc, doc: Y.Doc): void {
  upsertDirectoryEntry(directory, {
    ...getMeta(doc),
    ...decisionDirectoryFields(doc),
    description: getMeta(doc).description ?? "",
  });
}

describe("decision approval content", () => {
  it.each([
    ["title", (doc: Y.Doc) => setTitle(doc, "Changed topic")],
    ["decision line", (doc: Y.Doc) => setTldr(doc, "Changed decision.")],
    ["block text", (doc: Y.Doc) => editBlock(doc, getBlocks(doc)[0]!.id, "First reason", "Changed reason")],
    ["inserted block", (doc: Y.Doc) => appendBlock(doc, { type: "paragraph", text: "New reason" })],
    ["deleted block", (doc: Y.Doc) => deleteBlock(doc, getBlocks(doc)[0]!.id)],
  ] as const)("detects changed %s and approves the current content again", (_field, change) => {
    const doc = decision();
    expect(decisionApprovalChanged(doc)).toBe(false);
    approve(doc);
    expect(decisionApprovalChanged(doc)).toBe(false);
    change(doc);
    expect(decisionApprovalChanged(doc)).toBe(true);
    approve(doc);
    expect(decisionApprovalChanged(doc)).toBe(false);
  });

  it("ignores discussion, anchors and metadata outside approved content", () => {
    const doc = decision();
    approve(doc);
    const fingerprint = decisionApprovalFingerprint(doc);
    const block = getBlocks(doc)[0]!;
    const thread = createAnnotation(doc, block.id, 0, 5, "a-person", "Discussion");
    addComment(doc, thread.id, "another-person", "A reply");
    setAnnotationResolved(doc, thread.id, true);
    expect(decisionApprovalChanged(doc)).toBe(false);
    deleteAnnotation(doc, thread.id);
    setInlineLink(doc, block.id, { start: 0, end: 5 }, TARGET);
    setDescription(doc, "Changed description");
    setTags(doc, ["another-tag"]);
    setLinks(doc, [TARGET]);
    setChangelogSuggestion(doc, "A release note");
    const meta = getMetaMap(doc);
    meta.set("agentStance", false);
    meta.set("decidedBy", "another-person");
    meta.set("decidedAt", "2026-10-04T12:00:00Z");
    meta.set("decidedWhere", "Another answer");
    meta.set("rejectionReason", "Foreign bookkeeping");
    expect(decisionApprovalFingerprint(doc)).toBe(fingerprint);
    expect(decisionApprovalChanged(doc)).toBe(false);
  });

  it("preserves block order and boundaries, without including block identity", () => {
    expect(decisionApprovalFingerprint(decision(["a", "bc"]))).not.toBe(decisionApprovalFingerprint(decision(["ab", "c"])));
    expect(decisionApprovalFingerprint(decision(["a", "b"]))).not.toBe(decisionApprovalFingerprint(decision(["b", "a"])));
    expect(decisionApprovalFingerprint(decision())).toBe(decisionApprovalFingerprint(decision()));
  });

  it("detects an offline merge and stores its derived state for directory-only readers", () => {
    const doc = decision();
    const offline = new Y.Doc();
    syncDocs(doc, offline);
    const directory = new Y.Doc();
    approve(doc);
    repair(directory, doc);
    expect(getDirectoryEntry(directory, UUID)?.approvalChanged).toBe(false);
    const block = getBlocks(offline)[0]!;
    editBlock(offline, block.id, block.text, "Offline reason");
    syncDocs(doc, offline);
    expect(decisionApprovalChanged(doc)).toBe(true);
    expect(decisionApprovalChanged(offline)).toBe(true);
    expect(directoryStubDiffers(getDirectoryEntry(directory, UUID), getMeta(doc), decisionDirectoryFields(doc))).toBe(true);
    repair(directory, doc);
    expect(listDirectory(directory)[0]?.approvalChanged).toBe(true);
    upsertDirectoryEntry(directory, { uuid: UUID, title: "Directory-only rename" });
    tombstoneDirectoryEntry(directory, UUID);
    restoreDirectoryEntry(directory, UUID);
    expect(getDirectoryEntry(directory, UUID)?.approvalChanged).toBe(true);
    approve(doc);
    repair(directory, doc);
    expect(getDirectoryEntry(directory, UUID)?.approvalChanged).toBe(false);
    expect(directoryStubDiffers(getDirectoryEntry(directory, UUID), getMeta(doc), decisionDirectoryFields(doc))).toBe(false);
    const restored = new Y.Doc();
    Y.applyUpdate(restored, Y.encodeStateAsUpdate(directory));
    expect(listDirectory(restored)[0]?.approvalChanged).toBe(false);
  });
});

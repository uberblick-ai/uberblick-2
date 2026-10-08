import { describe, expect, it } from "vitest";
import * as Y from "yjs";
import {
  addComment,
  appendBlock,
  blockRev,
  createAnnotation,
  decisionApprovalChanged,
  decisionApprovalFingerprint,
  decisionDirectoryFields,
  deleteAnnotation,
  deleteBlock,
  directoryStubDiffers,
  editBlock,
  getBlocks,
  getBlockText,
  findBlockElement,
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
  setBlockType,
  setKind,
  setLinks,
  setStatus,
  setTags,
  setTitle,
  setTldr,
  tombstoneDirectoryEntry,
  upsertDirectoryEntry,
  tableCellText,
  tableRows,
  writeGfmTable,
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
  it("preserves the historical fingerprint with absent or empty structured data", () => {
    const doc = decision();
    const historical = blockRev({
      type: "paragraph",
      text: JSON.stringify(["The topic", "The decision.", ["First reason", "Second reason"]]),
    });
    expect(decisionApprovalFingerprint(doc)).toBe(historical);
    doc.getMap("data");
    expect(decisionApprovalFingerprint(doc)).toBe(historical);
    doc.destroy();
  });

  it("approves all data content, including invalid records and unknown schema versions", () => {
    const doc = decision();
    const data = doc.getMap("data");
    const schemaKey = JSON.stringify(["schema", "observations"]);
    const recordKey = JSON.stringify(["record", "observations", "row-a"]);
    data.set(schemaKey, { version: 1, schema: { type: "object" } });
    data.set(recordKey, { value: 1 });
    approve(doc);
    const fingerprint = decisionApprovalFingerprint(doc);
    data.set(recordKey, { value: 2 });
    expect(decisionApprovalChanged(doc)).toBe(true);
    data.set(recordKey, { value: 1 });
    expect(decisionApprovalFingerprint(doc)).toBe(fingerprint);
    data.set(schemaKey, { version: 99, schema: { type: "object" } });
    expect(decisionApprovalChanged(doc)).toBe(true);
    approve(doc);
    data.set(recordKey, "invalid merged record");
    expect(decisionApprovalChanged(doc)).toBe(true);
    approve(doc);
    data.delete(recordKey);
    expect(decisionApprovalChanged(doc)).toBe(true);
    doc.destroy();
  });

  it("fingerprints equivalent structured JSON independently of property insertion order", () => {
    const first = decision();
    const second = decision();
    const key = JSON.stringify(["record", "observations", "row-a"]);
    first.getMap("data").set(key, { a: 1, b: { c: 2, d: 3 } });
    second.getMap("data").set(key, { b: { d: 3, c: 2 }, a: 1 });
    expect(decisionApprovalFingerprint(first)).toBe(decisionApprovalFingerprint(second));
    first.destroy();
    second.destroy();
  });

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

  it("retains historical plain table approval when cell marks and document links change", () => {
    const doc = decision([]);
    const source = writeGfmTable([["Header"], ["**Alpha** <tag> & \\|"], ["Beta"]]);
    const id = appendBlock(doc, { type: "paragraph", text: source });
    setBlockType(doc, id, "table");
    const historical = blockRev({
      type: "paragraph", text: JSON.stringify(["The topic", "The decision.", [source]]),
    });
    getMetaMap(doc).set("approvalFingerprint", historical);
    expect(getBlockText(doc, id)).not.toBe(source);
    expect(decisionApprovalFingerprint(doc)).toBe(historical);
    expect(decisionApprovalChanged(doc)).toBe(false);
    const table = findBlockElement(doc, id)!;
    const text = tableCellText(tableRows(table)[1]![0]!)!;
    text.format(2, 5, { bold: {}, docLink: { docId: TARGET } });
    expect(decisionApprovalFingerprint(doc)).toBe(historical);
    expect(decisionApprovalChanged(doc)).toBe(false);
    text.format(2, 5, { bold: null, docLink: { docId: UUID } });
    expect(decisionApprovalChanged(doc)).toBe(false);
    const before = getBlockText(doc, id);
    editBlock(doc, id, before, before.replace("Beta", "Gamma"));
    expect(decisionApprovalChanged(doc)).toBe(true);
    doc.destroy();
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

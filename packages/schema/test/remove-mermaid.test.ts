import { describe, expect, it } from "vitest";
import * as Y from "yjs";
import {
  addComment,
  appendBlock,
  blockRev,
  createAnnotation,
  decisionApprovalChanged,
  decisionApprovalFingerprint,
  documentDirectoryFields,
  exportMarkdown,
  getAnnotation,
  getBlocks,
  getBlocksFragment,
  getMetaMap,
  initDoc,
  isBlockType,
  listAnnotations,
  removeLegacyMermaidBlocks,
  resolveAnnotationRange,
  setAnnotationResolved,
  setKind,
  setStatus,
} from "../src/index.js";
import { syncDocs } from "./helpers.js";

const UUID = "22222222-2222-4222-8222-222222222222";
const SOURCE = "flowchart LR\n  A --> B";

function seeded(): Y.Doc {
  const doc = new Y.Doc();
  initDoc(doc, { uuid: UUID, title: "Legacy content" });
  return doc;
}

/** Model a client that still writes the retired stored element name. */
function legacy(doc: Y.Doc, id: string = crypto.randomUUID(), text = SOURCE): Y.XmlElement {
  const element = new Y.XmlElement("mermaid");
  element.setAttribute("id", id);
  element.insert(0, [new Y.XmlText(text)]);
  getBlocksFragment(doc).push([element]);
  return element;
}

describe("retired Mermaid blocks", () => {
  it("deletes every raw Mermaid element and leaves other blocks unchanged", () => {
    const doc = seeded();
    appendBlock(doc, { type: "paragraph", inline: [{ text: "Kept", marks: { bold: true } }] });
    appendBlock(doc, { type: "code", language: "mermaid", text: SOURCE });
    const before = getBlocks(doc);
    legacy(doc, before[0]!.id);
    legacy(doc, before[0]!.id, "A shadowed copy");
    legacy(doc, "", "An element without identity");
    const malformed = new Y.XmlElement("mermaid");
    getBlocksFragment(doc).push([malformed]);
    const otherElements = getBlocksFragment(doc).toArray().slice(0, 2);
    const otherContent = otherElements.map((element) => element.toString());

    expect(isBlockType("mermaid")).toBe(false);
    expect(removeLegacyMermaidBlocks(doc)).toBe(4);
    expect(getBlocks(doc)).toEqual(before);
    expect(getBlocksFragment(doc).toArray()).toEqual(otherElements);
    expect(otherElements.map((element) => element.toString())).toEqual(otherContent);
    expect(exportMarkdown(doc, { frontmatter: false })).toBe(`**Kept**\n\n\`\`\`mermaid\n${SOURCE}\n\`\`\`\n`);
    const removedState = Y.encodeStateAsUpdate(doc);
    expect(removeLegacyMermaidBlocks(doc)).toBe(0);
    expect(Y.encodeStateAsUpdate(doc)).toEqual(removedState);
    doc.destroy();
  });

  it("keeps an anchored thread orphaned, counted and writable after source deletion", () => {
    const doc = seeded();
    const element = legacy(doc);
    const id = element.getAttribute("id")!;
    const thread = createAnnotation(doc, id, 0, 9, "a-person", "Discuss the diagram");
    expect(resolveAnnotationRange(doc, thread.id)).not.toBeNull();

    removeLegacyMermaidBlocks(doc);

    expect(getBlocks(doc)).toEqual([]);
    expect(resolveAnnotationRange(doc, thread.id)).toBeNull();
    expect(listAnnotations(doc)).toEqual([thread]);
    expect(documentDirectoryFields(doc).openThreadCount).toBe(1);
    addComment(doc, thread.id, "another-person", "Reply after removal");
    expect(getAnnotation(doc, thread.id)?.comments).toHaveLength(2);
    setAnnotationResolved(doc, thread.id, true);
    expect(documentDirectoryFields(doc).openThreadCount).toBe(0);
    expect(setAnnotationResolved(doc, thread.id, false)).toBeNull();
    expect(documentDirectoryFields(doc).openThreadCount).toBe(0);

    const restored = new Y.Doc();
    Y.applyUpdate(restored, Y.encodeStateAsUpdate(doc));
    expect(getBlocks(restored)).toEqual([]);
    expect(resolveAnnotationRange(restored, thread.id)).toBeNull();
    expect(getAnnotation(restored, thread.id)?.comments).toHaveLength(2);
    expect(getBlocksFragment(restored).toString()).not.toContain(SOURCE);
    doc.destroy();
    restored.destroy();
  });

  it("invalidates an affected decision approval without modifying approval bookkeeping", () => {
    const doc = seeded();
    setKind(doc, "decision");
    appendBlock(doc, { type: "paragraph", text: "The answer" });
    legacy(doc);
    setStatus(doc, "decided");
    const meta = getMetaMap(doc);
    const historical = blockRev({
      type: "paragraph", text: JSON.stringify(["Legacy content", null, ["The answer", SOURCE]]),
    });
    meta.set("approvalFingerprint", historical);
    meta.set("decidedBy", "a-person");
    meta.set("decidedAt", "2026-10-03T12:00:00Z");
    meta.set("decidedWhere", "An owner answer");
    const before = meta.toJSON();
    expect(decisionApprovalChanged(doc)).toBe(false);

    expect(removeLegacyMermaidBlocks(doc)).toBe(1);

    expect(meta.toJSON()).toEqual(before);
    expect(decisionApprovalChanged(doc)).toBe(true);
    expect(documentDirectoryFields(doc).approvalChanged).toBe(true);
    doc.destroy();
  });

  it.each([false, true])("preserves an unaffected decision's fingerprint and changed=%s", (changed) => {
    const doc = seeded();
    setKind(doc, "decision");
    appendBlock(doc, { type: "paragraph", text: "The answer" });
    appendBlock(doc, { type: "code", language: "mermaid", text: SOURCE });
    setStatus(doc, "decided");
    getMetaMap(doc).set("approvalFingerprint", decisionApprovalFingerprint(doc));
    if (changed) appendBlock(doc, { type: "paragraph", text: "Unapproved answer change" });
    const before = Y.encodeStateAsUpdate(doc);
    const fingerprint = decisionApprovalFingerprint(doc);

    expect(removeLegacyMermaidBlocks(doc)).toBe(0);

    expect(decisionApprovalFingerprint(doc)).toBe(fingerprint);
    expect(decisionApprovalChanged(doc)).toBe(changed);
    expect(Y.encodeStateAsUpdate(doc)).toEqual(before);
    doc.destroy();
  });

  it("converges concurrent deletions and discards delayed old-client source edits", () => {
    const first = seeded();
    appendBlock(first, { type: "paragraph", text: "Keep this" });
    const element = legacy(first);
    const second = new Y.Doc();
    const offline = new Y.Doc();
    syncDocs(first, second);
    syncDocs(first, offline);
    const offlineElement = getBlocksFragment(offline).toArray()[1] as Y.XmlElement;
    const offlineText = offlineElement.firstChild as Y.XmlText;
    offlineText.insert(offlineText.length, "\n  B --> C");
    const thread = createAnnotation(offline, element.getAttribute("id")!, 0, 9, "a-person", "Offline comment");

    expect(removeLegacyMermaidBlocks(first)).toBe(1);
    expect(removeLegacyMermaidBlocks(second)).toBe(1);
    syncDocs(first, second);
    syncDocs(first, offline);
    syncDocs(first, second);

    for (const doc of [first, second, offline]) {
      expect(getBlocks(doc)).toMatchObject([{ type: "paragraph", text: "Keep this" }]);
      expect(getBlocksFragment(doc).toString()).not.toContain("B --> C");
      expect(getAnnotation(doc, thread.id)?.comments).toHaveLength(1);
      expect(resolveAnnotationRange(doc, thread.id)).toBeNull();
      expect(removeLegacyMermaidBlocks(doc)).toBe(0);
    }
    first.destroy();
    second.destroy();
    offline.destroy();
  });

  it("removes a new old-client block on reconnect and syncs its deletion back", () => {
    const updated = seeded();
    const offline = new Y.Doc();
    syncDocs(updated, offline);
    legacy(offline);
    syncDocs(updated, offline);
    expect(removeLegacyMermaidBlocks(updated)).toBe(1);
    syncDocs(updated, offline);
    expect(getBlocksFragment(updated).length).toBe(0);
    expect(getBlocksFragment(offline).length).toBe(0);
    updated.destroy();
    offline.destroy();
  });
});

/** Chart mappings remain ordinary source content, including during version skew. */
import { afterEach, describe, expect, it, vi } from "vitest";
import * as Y from "yjs";
import {
  appendBlock,
  createAnnotation,
  decisionApprovalChanged,
  decisionApprovalFingerprint,
  editBlock,
  exportMarkdown,
  findBlockElement,
  getBlock,
  getMetaMap,
  importMarkdown,
  initDoc,
  resolveAnnotationRange,
  setKind,
  setStatus,
} from "../src/index.js";
import * as vocabulary from "../src/types.js";
import type { BlockType } from "../src/types.js";

const UUID = "66666666-6666-4666-8666-666666666666";
const mapping = JSON.stringify({
  version: 1, type: "line", collection: "observations",
  x: { field: "day", type: "date" },
  y: [{ field: "count", label: "Count", unit: "issues" }],
  title: "A ``` fence inside a label",
});
const docs: Y.Doc[] = [];

function document(): Y.Doc {
  const doc = new Y.Doc();
  initDoc(doc, { uuid: UUID, title: "Chart source" });
  docs.push(doc);
  return doc;
}

afterEach(() => {
  vi.restoreAllMocks();
  for (const doc of docs.splice(0)) doc.destroy();
});

describe("chart block content", () => {
  it("exports and imports mapping source without exposing document records", () => {
    const doc = document();
    const id = appendBlock(doc, { type: "chart", text: mapping });
    doc.getMap("data").set(JSON.stringify(["record", "observations", "row-a"]), {
      day: "2026-10-08", count: 4, privateObservation: "DATA_SENTINEL",
    });
    const before = Y.encodeStateAsUpdate(doc);
    const markdown = exportMarkdown(doc, { frontmatter: false });
    expect(markdown).toContain(`\`\`\`\`chart\n${mapping}\n\`\`\`\``);
    expect(markdown).toContain("> Structured document data is omitted from this Markdown export.");
    expect(markdown).not.toContain("DATA_SENTINEL");
    expect(importMarkdown(markdown).blocks[0]).toEqual({ type: "chart", text: mapping });
    expect(Y.encodeStateAsUpdate(doc)).toEqual(before);
    // An incomplete edit is durable source too; render validation owns its error.
    editBlock(doc, id, mapping, "{ incomplete");
    expect(importMarkdown(exportMarkdown(doc, { frontmatter: false })).blocks[0]).toEqual({
      type: "chart", text: "{ incomplete",
    });
  });

  it("includes the mapping in approval content and retains source annotations on an edit", () => {
    const doc = document();
    const id = appendBlock(doc, { type: "chart", text: mapping });
    const start = mapping.indexOf("observations");
    const thread = createAnnotation(doc, id, start, start + "observations".length, "reader", "Data source");
    setKind(doc, "decision");
    setStatus(doc, "decided");
    getMetaMap(doc).set("approvalFingerprint", decisionApprovalFingerprint(doc));
    const next = mapping.replace('"Count"', '"Total"');
    editBlock(doc, id, mapping, next);
    expect(decisionApprovalChanged(doc)).toBe(true);
    expect(resolveAnnotationRange(doc, thread.id)).toMatchObject({ start, end: start + "observations".length });
    expect(getBlock(doc, id)).toMatchObject({ type: "chart", text: next });
  });

  it("preserves chart identity and shared text when read and edited by an older vocabulary", () => {
    const doc = document();
    const id = appendBlock(doc, { type: "chart", text: mapping });
    const element = findBlockElement(doc, id)!;
    const text = element.firstChild;
    const currentIsBlockType = vocabulary.isBlockType;
    // The older schema differs at the vocabulary classifier: its existing
    // paragraph fallback and diff-and-splice writer run unchanged here.
    vi.spyOn(vocabulary, "isBlockType").mockImplementation(
      (value: string): value is BlockType => value !== "chart" && currentIsBlockType(value),
    );
    const olderRead = getBlock(doc, id)!;
    expect(olderRead).toMatchObject({ type: "paragraph", text: mapping });
    const next = mapping.replace('"Count"', '"Total"');
    editBlock(doc, id, olderRead.text, next, { rev: olderRead.rev });
    expect(findBlockElement(doc, id)).toBe(element);
    expect(element.firstChild).toBe(text);
    expect(element.nodeName).toBe("chart");
    vi.restoreAllMocks();
    expect(getBlock(doc, id)).toMatchObject({ type: "chart", text: next });
  });
});

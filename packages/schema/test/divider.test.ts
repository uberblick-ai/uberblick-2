import * as Y from "yjs";
import { describe, expect, it } from "vitest";
import {
  BLOCK_TYPES, appendBlock, blockRev, compareRevisions, createAnnotation,
  decisionDocAnswerFailure, deleteBlock, docRev, editBlock, findBlockElement,
  getBlock, getBlockInline, getBlocks, getBlocksWithInline, initDoc, insertBlock,
  isProseBlockType, moveBlocks, setInlineLink, snapshotRevision,
} from "../src/index.js";
import { snapshotBlocks } from "../src/revision-blocks.js";
import type { RevInput } from "../src/rev.js";

function document(): Y.Doc {
  const doc = new Y.Doc();
  initDoc(doc, { uuid: "88888888-8888-4888-8888-888888888888", title: "Dividers" });
  return doc;
}

function copy(doc: Y.Doc): Y.Doc {
  const result = new Y.Doc();
  Y.applyUpdate(result, Y.encodeStateAsUpdate(doc));
  return result;
}

describe("divider storage", () => {
  it("stores a childless element, moves and deletes it, and refuses decision answers", () => {
    const doc = document();
    const paragraph = appendBlock(doc, { type: "paragraph", text: "Text" });
    const id = appendBlock(doc, { type: "divider", text: "", inline: [] });
    expect(BLOCK_TYPES).toContain("divider");
    expect(isProseBlockType("divider")).toBe(false);
    expect(findBlockElement(doc, id)?.getAttributes()).toEqual({ id });
    expect(findBlockElement(doc, id)?.toArray()).toEqual([]);
    expect(getBlock(doc, id)).toEqual({ id, type: "divider", text: "", rev: blockRev({ type: "divider", text: "" }) });
    expect(decisionDocAnswerFailure(doc)).toBe("decision_block_unsupported");
    const rev = getBlock(doc, id)?.rev;
    moveBlocks(doc, [id]);
    expect(getBlocks(doc).map((block) => block.id)).toEqual([id, paragraph]);
    expect(getBlock(doc, id)?.rev).toBe(rev);
    expect(findBlockElement(doc, id)?.toArray()).toEqual([]);
    deleteBlock(doc, id);
    expect(getBlock(doc, id)).toBeNull();
    doc.destroy();
  });

  it.each([{ text: "text" }, { text: " " }, { inline: [{ text: "", marks: {} }] }])("refuses content before mutation: %j", (content) => {
    const doc = document();
    const before = Y.encodeStateAsUpdate(doc);
    expect(() => appendBlock(doc, { type: "divider", ...content })).toThrow(expect.objectContaining({ code: "invalid_divider" }));
    expect(() => insertBlock(doc, null, { type: "divider", ...content })).toThrow(expect.objectContaining({ code: "invalid_divider" }));
    expect(Y.encodeStateAsUpdate(doc)).toEqual(before);
    doc.destroy();
  });

  it("ignores text and marks added by an older writer in all projections and comparisons", () => {
    const doc = document();
    const id = appendBlock(doc, { type: "divider" });
    const before = copy(doc);
    const rev = docRev(doc);
    const text = new Y.XmlText("older writer's text");
    findBlockElement(doc, id)!.insert(0, [text]);
    text.format(0, text.length, { bold: {}, docLink: { docId: "11111111-1111-4111-8111-111111111111" } });
    expect(getBlock(doc, id)?.text).toBe("");
    expect(getBlockInline(doc, id)).toEqual([]);
    expect(getBlocksWithInline(doc)[0]?.inline).toEqual([]);
    expect(docRev(doc)).toBe(rev);
    expect(snapshotBlocks(doc)).toEqual(snapshotBlocks(before));
    expect(compareRevisions(before, doc).changed).toBe(false);
    const stored = Y.encodeStateAsUpdate(doc);
    expect(() => editBlock(doc, id, "", "text")).toThrow(expect.objectContaining({ code: "divider_not_editable" }));
    expect(() => editBlock(doc, id, "", "")).toThrow(/divider/);
    expect(() => createAnnotation(doc, id, 0, 4, "reviewer", "Comment")).toThrow(expect.objectContaining({ code: "divider_annotation" }));
    expect(() => setInlineLink(doc, id, { start: 0, end: 4 }, "11111111-1111-4111-8111-111111111111")).toThrow(/divider/);
    expect(Y.encodeStateAsUpdate(doc)).toEqual(stored);
    before.destroy(); doc.destroy();
  });

  it("includes dividers in revision snapshots and reports additions, removals and moves without word spans", () => {
    const before = document();
    const id = appendBlock(before, { type: "divider" });
    appendBlock(before, { type: "paragraph", text: "A" });
    const last = appendBlock(before, { type: "paragraph", text: "B" });
    const restored = new Y.Doc();
    Y.applyUpdate(restored, snapshotRevision(before).state);
    expect(getBlocks(restored)[0]).toMatchObject({ id, type: "divider", text: "" });
    expect(findBlockElement(restored, id)?.toArray()).toEqual([]);
    const after = copy(before);
    moveBlocks(after, [id], last);
    expect(compareRevisions(before, after).blocks.filter((block) => block.kind !== "unchanged")).toEqual([
      { kind: "removed", beforeIndex: 0, fields: [], spans: [] },
      { kind: "added", afterIndex: 2, fields: [], spans: [] },
    ]);
    deleteBlock(after, id);
    expect(compareRevisions(before, after).blocks[0]).toEqual({ kind: "removed", beforeIndex: 0, fields: [], spans: [] });
    expect(compareRevisions(after, before).blocks[0]).toEqual({ kind: "added", afterIndex: 0, fields: [], spans: [] });
    restored.destroy(); before.destroy(); after.destroy();
  });

  it("keeps the revision hash contract for every existing block type", () => {
    const fixtures: Array<[RevInput, string]> = [
      [{ type: "paragraph", text: "Text" }, "1d41a29c43d4e748"],
      [{ type: "heading", text: "Title", level: 2 }, "ce55e22e5dad8eb6"],
      [{ type: "code", text: "x", language: "ts" }, "b460817edabfb9f0"],
      [{ type: "list-item", text: "Item", list: "ordered", indent: 2 }, "f2b6bfed49136a19"],
      [{ type: "quote", text: "Quote" }, "6344e6718d129fe9"],
      [{ type: "callout", text: "Note", variant: "note", icon: "💡" }, "514494bbd1eeca4b"],
      [{ type: "table", text: "| A |\n| --- |\n| B |" }, "35939ce3c5b972db"],
      [{ type: "terminal", text: "echo hi" }, "8cf58f414d87c2d9"],
      [{ type: "chart", text: "{}" }, "a743442517861557"],
      [{ type: "card", text: "title: Title" }, "17df90c1fbfe70e5"],
      [{ type: "figma", text: "url: https://figma.com/design/key" }, "ea6b04477429283b"],
    ];
    for (const [input, expected] of fixtures) expect(blockRev(input)).toBe(expected);
    expect(blockRev({ type: "divider", text: "old client text" })).toBe(blockRev({ type: "divider", text: "" }));
  });
});

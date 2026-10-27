import * as Y from "yjs";
import { describe, expect, it } from "vitest";
import {
  appendBlock, applyDocData, compareRevisions, createAnnotation, deleteBlock, editBlock,
  findBlockElement, getBlocks, getBlocksFragment, getMetaMap, initDoc,
  insertBlock, moveBlocks, setAnnotationResolved, setInlineLink, setTitle,
} from "../src/index.js";
import type { BlockInput, CollectionSchema, TextSpan } from "../src/index.js";
import { diffWords } from "../src/revision-sequence.js";
import { retype } from "./helpers.js";

const UUID = "11111111-1111-4111-8111-111111111111";
const SCHEMA: CollectionSchema = { version: 1, schema: { type: "object" } };

function doc(): Y.Doc {
  const result = new Y.Doc();
  initDoc(result, { uuid: UUID, title: "Old title" });
  return result;
}

function copy(before: Y.Doc): Y.Doc {
  const result = new Y.Doc();
  Y.applyUpdate(result, Y.encodeStateAsUpdate(before));
  return result;
}

function reconstruct(spans: TextSpan[], side: "before" | "after"): string {
  return spans.filter((span) => span.kind !== (side === "before" ? "added" : "removed")).map((span) => span.text).join("");
}

describe("document revision comparison", () => {
  it.each<BlockInput>([
    { type: "paragraph" }, { type: "heading", level: 2 }, { type: "list-item" },
    { type: "quote" }, { type: "code", language: "typescript" }, { type: "terminal" },
  ])("compares words in a $type and preserves the unchanged text", (input) => {
    const before = doc();
    const id = appendBlock(before, { ...input, text: "The old words stay here." });
    const after = copy(before);
    editBlock(after, id, "The old words stay here.", "The new phrase stays here.");
    const change = compareRevisions(before, after).blocks[0]!;
    expect(change.kind).toBe("changed");
    expect(reconstruct(change.spans, "before")).toBe("The old words stay here.");
    expect(reconstruct(change.spans, "after")).toBe("The new phrase stays here.");
    expect(change.spans).toContainEqual({ kind: "unchanged", text: "The " });
    expect(change.spans.filter((span) => span.kind === "removed").map((span) => span.text).join("")).toContain("old");
    before.destroy(); after.destroy();
  });

  it.each([3, 5000])("aligns block marks with the displayed spans across %i rewritten words", (count) => {
    const oldText = `Start ${"old ".repeat(count)}end`;
    const newText = `Start ${"new ".repeat(count)}end`;
    const before = doc();
    const id = appendBlock(before, { type: "paragraph", inline: [{ text: oldText, marks: { bold: true } }] });
    const after = copy(before);
    const text = findBlockElement(after, id)!.firstChild as Y.XmlText;
    text.delete(0, text.length);
    text.insert(0, newText, { bold: {} });
    const spans = diffWords(oldText, newText);
    const changed = compareRevisions(before, after).blocks[0]!;
    expect(changed.spans).toEqual(spans);
    expect(changed.fields).toEqual([]);
    expect(reconstruct(changed.spans, "before")).toBe(oldText);
    expect(reconstruct(changed.spans, "after")).toBe(newText);
    if (count === 5000) expect(spans).toEqual([
      { kind: "unchanged", text: "Start " },
      { kind: "removed", text: "old ".repeat(count).trimEnd() },
      { kind: "added", text: "new ".repeat(count).trimEnd() },
      { kind: "unchanged", text: " end" },
    ]);
    else expect(spans).toContainEqual({ kind: "unchanged", text: " " });
    text.format(0, 5, { italic: {} });
    text.format(newText.length - 3, 3, { link: { href: "https://example.test" } });
    const marked = compareRevisions(before, after).blocks[0]!;
    expect(marked.spans).toEqual(spans);
    expect(marked.fields).toEqual(["formatting", "link"]);
    before.destroy(); after.destroy();
  });

  it("ignores adding and resolving comments across prose, table cells, card parts and captions", () => {
    const before = doc();
    const prose = appendBlock(before, { type: "paragraph", inline: [{ text: "before marked after", marks: { bold: true } }] });
    const table = appendBlock(before, { type: "table", text: "| Name |\n| --- |\n| before **marked** after |" });
    const card = appendBlock(before, { type: "card", text: "label: label text\ntitle: title text\nfooter: footer text\n\nbody text" });
    const figma = appendBlock(before, { type: "figma", text: "url: https://www.figma.com/design/abc/Design\n\nbefore **marked** after" });
    const after = copy(before);
    const threads = [
      createAnnotation(after, prose, 8, 11, "author", "prose"),
      createAnnotation(after, table, 8, 11, "author", "cell", { row: 1, column: 0 }),
      ...(["label", "title", "body", "footer"] as const).map((part) => createAnnotation(after, card, 1, 3, "author", part, { part })),
      createAnnotation(after, figma, 8, 11, "author", "caption", { part: "caption" }),
    ];
    expect(compareRevisions(before, after).changed).toBe(false);
    for (const thread of threads) setAnnotationResolved(after, thread.id, true);
    expect(compareRevisions(before, after).changed).toBe(false);
    // Hash matching must normalize the split runs too, with no ID match available.
    for (const element of getBlocksFragment(after).toArray()) {
      if (element instanceof Y.XmlElement) element.setAttribute("id", crypto.randomUUID());
    }
    expect(compareRevisions(before, after).blocks.map((block) => block.kind)).toEqual(Array(4).fill("unchanged"));
    before.destroy(); after.destroy();
  });

  it("keeps removals in old order and treats a move as removal plus addition", () => {
    const before = doc();
    const ids = ["A", "B", "C", "D"].map((text) => appendBlock(before, { type: "paragraph", text }));
    const after = copy(before);
    moveBlocks(after, [ids[0]!], ids[3]!);
    expect(compareRevisions(before, after).blocks).toMatchObject([
      { kind: "removed", beforeIndex: 0 },
      { kind: "unchanged", beforeIndex: 1, afterIndex: 0 },
      { kind: "unchanged", beforeIndex: 2, afterIndex: 1 },
      { kind: "unchanged", beforeIndex: 3, afterIndex: 2 },
      { kind: "added", afterIndex: 3 },
    ]);
    const deleted = copy(before);
    deleteBlock(deleted, ids[1]!);
    insertBlock(deleted, ids[2]!, { type: "paragraph", text: "New" });
    expect(compareRevisions(before, deleted).blocks).toMatchObject([
      { kind: "unchanged", beforeIndex: 0, afterIndex: 0 }, { kind: "removed", beforeIndex: 1 },
      { kind: "unchanged", beforeIndex: 2, afterIndex: 1 }, { kind: "added", afterIndex: 2 },
      { kind: "unchanged", beforeIndex: 3, afterIndex: 3 },
    ]);
    before.destroy(); after.destroy(); deleted.destroy();
  });

  it("matches regenerated IDs by authored content, with the documented edited-content limit", () => {
    const before = doc();
    appendBlock(before, { type: "paragraph", text: "Same" });
    appendBlock(before, { type: "paragraph", text: "Old" });
    const after = doc();
    appendBlock(after, { type: "paragraph", text: "Same" });
    appendBlock(after, { type: "paragraph", text: "New" });
    expect(compareRevisions(before, after).blocks.map((block) => block.kind)).toEqual(["unchanged", "removed", "added"]);
    before.destroy(); after.destroy();
  });

  it("names formatting, external and document links, list attributes, type, level and language without spans", () => {
    const before = doc();
    const ids = [
      appendBlock(before, { type: "paragraph", text: "format me" }),
      appendBlock(before, { type: "paragraph", text: "link me" }),
      appendBlock(before, { type: "list-item", text: "item" }),
      appendBlock(before, { type: "paragraph", text: "quote" }),
      appendBlock(before, { type: "heading", text: "heading", level: 1 }),
      appendBlock(before, { type: "code", text: "source", language: "json" }),
      appendBlock(before, { type: "paragraph", text: "external" }),
    ];
    const after = copy(before);
    (findBlockElement(after, ids[0]!)!.firstChild as Y.XmlText).format(0, 6, { italic: {} });
    setInlineLink(after, ids[1]!, { start: 0, end: 4 }, "22222222-2222-4222-8222-222222222222");
    editBlock(after, ids[2]!, "item", "item", { list: "ordered", indent: 2 });
    retype(after, ids[3]!, "quote");
    findBlockElement(after, ids[4]!)!.setAttribute("level", "3");
    findBlockElement(after, ids[5]!)!.setAttribute("language", "typescript");
    (findBlockElement(after, ids[6]!)!.firstChild as Y.XmlText).format(0, 8, { link: { href: "https://example.com" } });
    const changes = compareRevisions(before, after).blocks;
    expect(changes.map((block) => block.fields)).toEqual([
      ["formatting"], ["link"], ["indent", "list"], ["type"], ["level"], ["language"], ["link"],
    ]);
    expect(changes.every((block) => block.kind === "changed" && block.spans.length === 0)).toBe(true);
    before.destroy(); after.destroy();
  });

  it("reports changed title words, omits metadata, and never writes updates to either document", () => {
    const before = doc();
    appendBlock(before, { type: "paragraph", text: "same" });
    const after = copy(before);
    getMetaMap(after).set("description", "only agents see this");
    getMetaMap(after).set("tldr", "A summary");
    getMetaMap(after).set("tags", ["tag"]);
    getMetaMap(after).set("updatedAt", 123);
    expect(compareRevisions(before, after).changed).toBe(false);
    setTitle(after, "New title");
    const oldState = Y.encodeStateAsUpdate(before);
    const newState = Y.encodeStateAsUpdate(after);
    let updates = 0;
    before.on("update", () => { updates++; }); after.on("update", () => { updates++; });
    const comparison = compareRevisions(before, after);
    expect(comparison.title!.spans).toEqual([
      { kind: "removed", text: "Old" }, { kind: "added", text: "New" }, { kind: "unchanged", text: " title" },
    ]);
    expect(comparison.changed).toBe(true);
    expect(updates).toBe(0);
    expect(Y.encodeStateAsUpdate(before)).toEqual(oldState);
    expect(Y.encodeStateAsUpdate(after)).toEqual(newState);
    before.destroy(); after.destroy();
  });

  it("names card, Figma and each top-level chart or data-table mapping field", () => {
    const before = doc();
    const card = appendBlock(before, { type: "card", text: "label: First\ntitle: Title\nfooter: Footer\nbutton: [Open](https://example.com)\n\nBody" });
    const figma = appendBlock(before, { type: "figma", text: "url: https://www.figma.com/design/abc/Design\ntitle: Title\nheight: 480\n\nCaption" });
    const chart = appendBlock(before, { type: "chart", text: '{"version":1,"type":"line","collection":"old","x":{"field":"day","type":"date"},"y":[{"field":"count"}]}' });
    const table = appendBlock(before, { type: "chart", text: '{"version":1,"type":"table","collection":"old","columns":[{"field":"count"}],"limit":5}' });
    const after = copy(before);
    const oldTexts = getBlocks(before).map((block) => block.text);
    editBlock(after, card, oldTexts[0]!, "label: Next\ntitle: **Title**\nfooter: [Footer](https://example.com)\nbutton: [Open](https://example.com/new) filled blue\n\nNew body");
    editBlock(after, figma, oldTexts[1]!, "url: https://www.figma.com/design/def/Design\ntitle: New title\nheight: 560\n\nNew caption");
    editBlock(after, chart, oldTexts[2]!, '{"version":1,"type":"line","collection":"new","x":{"field":"day","type":"date"},"y":[{"field":"total"}],"title":"New"}');
    editBlock(after, table, oldTexts[3]!, '{"version":1,"type":"table","collection":"old","columns":[{"field":"total"}],"sort":{"field":"total","direction":"desc"}}');
    expect(compareRevisions(before, after).blocks.map((block) => [...block.fields].sort())).toEqual([
      ["body", "buttons", "footer", "label", "title"], ["caption", "height", "title", "url"],
      ["collection", "title", "y"], ["columns", "limit", "sort"],
    ]);
    expect(compareRevisions(before, after).blocks.every((block) => block.kind === "changed" && block.spans.length === 0)).toBe(true);
    const reordered = copy(before);
    editBlock(reordered, chart, oldTexts[2]!, '{ "y": [{"field":"count"}], "x":{"type":"date","field":"day"},"collection":"old","type":"line","version":1 }');
    expect(compareRevisions(before, reordered).changed).toBe(false);
    before.destroy(); after.destroy(); reordered.destroy();
  });

  it("reports collections, schemas, records and literal top-level fields when blocks do not change", () => {
    const before = doc();
    const directory = new Y.Doc();
    appendBlock(before, { type: "paragraph", text: "unchanged" });
    applyDocData(before, directory, [
      { collection: "measurements", schema: SCHEMA, upsert: [
        { id: "changed", value: { count: 1, nested: { x: 1 }, absentNext: null, same: "x" } },
        { id: "removed", value: { count: 0 } },
      ] },
      { collection: "removed", schema: SCHEMA },
    ]);
    const after = copy(before);
    applyDocData(after, directory, [
      { collection: "measurements", schema: { version: 1, schema: { type: "object", properties: { count: { type: "number" } } } }, upsert: [
        { id: "changed", value: { count: 2, nested: { x: 2 }, newNull: null, same: "x" } },
        { id: "added", value: { count: 3 } },
      ], deleteRecords: ["removed"] },
      { collection: "added", schema: SCHEMA, upsert: [{ id: "empty", value: {} }] },
      { collection: "removed", deleteCollection: true },
    ]);
    const comparison = compareRevisions(before, after);
    expect(comparison.blocks[0]!.kind).toBe("unchanged");
    expect(comparison.data.map(({ name, kind, schemaChanged }) => ({ name, kind, schemaChanged }))).toEqual([
      { name: "added", kind: "added", schemaChanged: true },
      { name: "measurements", kind: "changed", schemaChanged: true },
      { name: "removed", kind: "removed", schemaChanged: true },
    ]);
    const records = comparison.data[1]!.records;
    expect(records.map(({ id, kind }) => ({ id, kind }))).toEqual([
      { id: "added", kind: "added" }, { id: "changed", kind: "changed" }, { id: "removed", kind: "removed" },
    ]);
    expect(records[1]!.fields).toEqual([
      { field: "absentNext", kind: "removed", before: null },
      { field: "count", kind: "changed", before: 1, after: 2 },
      { field: "nested", kind: "changed", before: { x: 1 }, after: { x: 2 } },
      { field: "newNull", kind: "added", after: null },
    ]);
    expect(compareRevisions(after, after).data).toEqual([]);
    before.destroy(); after.destroy(); directory.destroy();
  });

  it("compares thousands of regenerated blocks with scattered edits", () => {
    const before = doc();
    const after = doc();
    for (let index = 0; index < 6000; index++) {
      appendBlock(before, { type: "paragraph", text: `Paragraph ${index}` });
      appendBlock(after, { type: "paragraph", text: index % 1000 === 500 ? `Edited ${index}` : `Paragraph ${index}` });
    }
    const result = compareRevisions(before, after);
    expect(result.blocks.filter((block) => block.kind === "unchanged")).toHaveLength(5994);
    expect(result.blocks.filter((block) => block.kind === "added")).toHaveLength(6);
    expect(result.blocks.filter((block) => block.kind === "removed")).toHaveLength(6);
    expect(getBlocks(after)).toHaveLength(6000);
    before.destroy(); after.destroy();
  }, 15000);

  it("compares nested constructor properties as authored JSON rather than as Yjs root values", () => {
    const before = doc();
    const directory = new Y.Doc();
    applyDocData(before, directory, [{ collection: "items", schema: SCHEMA, upsert: [
      { id: "one", value: { nested: { constructor: "before" } } },
    ] }]);
    const chart = appendBlock(before, { type: "chart", text: '{"x":{"constructor":"before","__proto__":"literal"}}' });
    const after = copy(before);
    applyDocData(after, directory, [{ collection: "items", upsert: [
      { id: "one", value: { nested: { constructor: "after" } } },
    ] }]);
    editBlock(after, chart, getBlocks(before)[0]!.text, '{"x":{"constructor":"after","__proto__":"literal"}}');
    const comparison = compareRevisions(before, after);
    expect(comparison.blocks[0]!.fields).toEqual(["x"]);
    expect(comparison.data[0]!.records[0]!.fields).toEqual([
      { field: "nested", kind: "changed", before: { constructor: "before" }, after: { constructor: "after" } },
    ]);
    before.destroy(); after.destroy(); directory.destroy();
  });

  it("detects reordered columns with duplicate headers even when the table was rebuilt", () => {
    const before = doc();
    const id = appendBlock(before, { type: "table", text: "| Value | Value |\n| --- | --- |\n| A | B |\n| C | D |" });
    const after = doc();
    const rebuilt = appendBlock(after, { type: "table", text: "| Value | Value |\n| --- | --- |\n| B | A |\n| D | C |" });
    findBlockElement(after, rebuilt)!.setAttribute("id", id);
    const result = compareRevisions(before, after).blocks[0]!;
    expect(result.kind).toBe("changed");
    expect(result.fields).toEqual(["columns"]);
    expect(result.spans).toEqual([]);
    expect(result.rows).toEqual([]);
    before.destroy(); after.destroy();
  });
});

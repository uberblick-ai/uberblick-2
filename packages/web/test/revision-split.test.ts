import { afterEach, describe, expect, it } from "vitest";
import * as Y from "yjs";
import type { JSONContent } from "@tiptap/core";
import { appendBlock, applyDocData, deleteBlock, editBlock, getBlock, getBlocksFragment, moveBlocks } from "@uberblick/schema";
import { createRevisionSplit, revisionSplitModel } from "../src/editor/revision-split.js";

const documents: Y.Doc[] = [];
afterEach(() => { for (const doc of documents.splice(0)) doc.destroy(); document.body.replaceChildren(); });

function doc(): Y.Doc {
  const created = new Y.Doc();
  documents.push(created);
  return created;
}

function clone(source: Y.Doc): Y.Doc {
  const copy = doc();
  Y.applyUpdate(copy, Y.encodeStateAsUpdate(source));
  return copy;
}

function texts(content: JSONContent, mark: "removed" | "revisionAdded"): string[] {
  const found: string[] = [];
  const visit = (node: JSONContent): void => {
    if (node.type === "text" && node.marks?.some((entry) => entry.type === mark)) found.push(node.text ?? "");
    node.content?.forEach(visit);
  };
  visit(content);
  return found;
}

const top = (content: JSONContent): string[] => (content.content ?? []).map((node) => node.type ?? "");

describe("the side-by-side revision model", () => {
  it("pairs rows, fills the empty side, and marks each side's own words only", () => {
    const before = doc();
    const fox = appendBlock(before, { type: "paragraph", text: "The amber fox stays." });
    const gone = appendBlock(before, { type: "quote", text: "Removed block" });
    appendBlock(before, { type: "paragraph", text: "Kept" });
    const after = clone(before);
    editBlock(after, fox, "The amber fox stays.", "The blue fox stays.");
    deleteBlock(after, gone);
    appendBlock(after, { type: "paragraph", text: "Added at the end" });
    const model = revisionSplitModel(before, after);
    expect(model.rows.map((row) => row.kind)).toEqual(["changed", "removed", "unchanged", "added"]);
    expect(model.rows.map((row) => row.changed)).toEqual([true, true, false, true]);
    expect(top(model.before)).toEqual(["paragraph", "quote", "paragraph", "revisionFiller"]);
    expect(top(model.after)).toEqual(["paragraph", "revisionFiller", "paragraph", "paragraph"]);
    expect(texts(model.before, "removed")).toEqual(["amber", "Removed block"]);
    expect(texts(model.before, "revisionAdded")).toEqual([]);
    expect(texts(model.after, "revisionAdded")).toEqual(["blue", "Added at the end"]);
    expect(texts(model.after, "removed")).toEqual([]);
    expect(model.rows[1]?.before.labels).toEqual(["Removed block"]);
    expect(model.rows[3]?.after.labels).toEqual(["Added block"]);
  });

  it("keeps field-only, formatting and moved-block changes visible on both sides", () => {
    const before = doc();
    appendBlock(before, { type: "paragraph", text: "Same words" });
    const card = appendBlock(before, { type: "card", text: "title: Before\n\nBody" });
    const first = appendBlock(before, { type: "paragraph", text: "First" });
    const second = appendBlock(before, { type: "paragraph", text: "Second" });
    const after = clone(before);
    ((getBlocksFragment(after).get(0) as Y.XmlElement).firstChild as Y.XmlText).format(0, 4, { bold: {} });
    editBlock(after, card, "title: Before\n\nBody", "title: After\n\nBody");
    moveBlocks(after, [first], second);
    const model = revisionSplitModel(before, after);
    expect(model.rows[0]).toMatchObject({ kind: "changed", changed: true, before: { labels: ["Changed: formatting"] }, after: { labels: ["Changed: formatting"] } });
    expect(model.rows[1]).toMatchObject({ before: { labels: ["Changed: title"] }, after: { labels: ["Changed: title"] } });
    const kinds = model.rows.slice(2).map((row) => row.kind);
    expect(kinds).toContain("added");
    expect(kinds).toContain("removed");
  });

  it("marks table cells per side and marks a structural change whole", () => {
    const before = doc();
    const table = appendBlock(before, { type: "table", text: "| Header |\n| --- |\n| old cell |\n| gone row |\n| tail |" });
    const after = clone(before);
    editBlock(after, table, getBlock(after, table)?.text ?? "", "| Header |\n| --- |\n| new cell |\n| tail |", { tableMapping: { rows: [0, 1, 3], columns: [0] } });
    const model = revisionSplitModel(before, after);
    expect(texts(model.before, "removed")).toEqual(["old", "gone row"]);
    expect(texts(model.after, "revisionAdded")).toEqual(["new"]);
    const rows = (side: JSONContent) => side.content?.[0]?.content?.length;
    expect(rows(model.before)).toBe(4);
    expect(rows(model.after)).toBe(3);
  });

  it("reports a data-only chart change on both sides, each with its own collection", () => {
    const before = doc();
    const directory = doc();
    appendBlock(before, { type: "chart", text: '{"version":1,"type":"table","collection":"values","columns":[{"field":"value"}]}' });
    const after = clone(before);
    applyDocData(after, directory, [{ collection: "values", schema: { version: 1, schema: { type: "object", properties: { value: { type: "number" } } } }, upsert: [{ id: "one", value: { value: 7 } }] }]);
    const model = revisionSplitModel(before, after);
    expect(model.rows[0]).toMatchObject({ kind: "unchanged", changed: true });
    expect(model.rows[0]?.after.labels).toEqual(["Data changed: values"]);
    expect(model.rows[0]?.before.labels).toEqual(["Data changed: values"]);
  });

  it("mounts two independent read-only sides whose copies drop revision styling and fillers", () => {
    const before = doc();
    appendBlock(before, { type: "paragraph", text: "Kept" });
    const gone = appendBlock(before, { type: "paragraph", text: "Gone" });
    const after = clone(before);
    deleteBlock(after, gone);
    const [left, right] = [document.createElement("div"), document.createElement("div")];
    document.body.append(left, right);
    const split = createRevisionSplit({ beforeElement: left, afterElement: right, before, after });
    try {
      expect(split.before.isEditable).toBe(false);
      expect(split.after.isEditable).toBe(false);
      expect(left.querySelectorAll(".ub-revision-row-start")).toHaveLength(2);
      expect(right.querySelector(".ub-revision-row-filler")).not.toBeNull();
      const state = split.after.state;
      split.after.view.dispatch(state.tr.insertText("mutation", 1));
      expect(split.after.state.doc.textContent).toBe("Kept");
      // Projected identities never repeat the live document's block ids.
      expect(split.before.getJSON().content?.map((node) => node.attrs?.id)).toEqual([expect.stringMatching(/^revision-0-/), expect.stringMatching(/^revision-1-/)]);
    } finally { split.destroy(); }
  });
});

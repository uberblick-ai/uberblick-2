import { afterEach, describe, expect, it } from "vitest";
import * as Y from "yjs";
import type { JSONContent } from "@tiptap/core";
import { DOMParser } from "@tiptap/pm/model";
import { appendBlock, applyDocData, deleteBlock, editBlock, getBlock, getBlocksFragment, moveBlocks, tableCellText, tableRows } from "@uberblick/schema";
import { uberblickSchema } from "../src/editor/create-editor.js";
import { createRevisionSplit, revisionSplitModel, unchangedRuns } from "../src/editor/revision-split.js";

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

function firstColumnWidth(source: Y.Doc, width: number): void {
  const table = getBlocksFragment(source).toArray().find((block) => block instanceof Y.XmlElement && block.nodeName === "table") as Y.XmlElement;
  for (const row of tableRows(table)) {
    (row[0] as unknown as { setAttribute(name: string, value: unknown): void }).setAttribute("colwidth", [width]);
  }
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
  it.each([
    { field: "variant", options: { variant: "tip" as const }, afterLabel: "Tip", afterIcon: "💡" },
    { field: "icon", options: { icon: ":claude:" }, afterLabel: "Note", afterIcon: null },
  ])("keeps the old and new callout appearances for a changed $field", ({ field, options, afterLabel, afterIcon }) => {
    const before = doc();
    const id = appendBlock(before, { type: "callout", variant: "note", icon: "💡", text: "Unchanged body" });
    const after = clone(before);
    editBlock(after, id, "Unchanged body", "Unchanged body", options);
    const left = document.body.appendChild(document.createElement("div"));
    const right = document.body.appendChild(document.createElement("div"));
    const split = createRevisionSplit({ beforeElement: left, afterElement: right, before, after });
    try {
      expect(split.model.rows[0]).toMatchObject({ kind: "changed", changed: true,
        before: { labels: [`Changed: ${field}`] }, after: { labels: [`Changed: ${field}`] } });
      for (const [element, label, icon] of [[left, "Note", "💡"], [right, afterLabel, afterIcon]] as const) {
        const callout = element.querySelector('[role="note"]');
        expect(callout?.getAttribute("aria-label")).toBe(label);
        expect(callout?.querySelector(".ub-block-caption")?.textContent).toContain(label);
        if (icon === null) expect(callout?.querySelector(".ub-block-caption .ub-inline-icon")).not.toBeNull();
        else expect(callout?.querySelector(".ub-block-caption")?.textContent).toContain(icon);
        expect(callout?.querySelector(".ub-callout-body")?.textContent).toBe("Unchanged body");
        expect(callout?.querySelector("[data-revision-change]")).toBeNull();
        expect(element.querySelector(".ub-revision-fields")?.textContent).toBe(`Changed: ${field}`);
      }
    } finally { split.destroy(); }
  });

  it.each(["quote", "callout"] as const)("marks callout body changes per side after a %s and copies only authored prose", (type) => {
    const before = doc();
    const id = appendBlock(before, type === "quote" ? { type, text: "The amber fox stays." }
      : { type, variant: "note", text: "The amber fox stays." });
    const after = clone(before);
    if (type === "quote") {
      const fragment = getBlocksFragment(after);
      const old = fragment.get(0) as Y.XmlElement;
      const callout = new Y.XmlElement("callout");
      callout.setAttribute("id", id);
      callout.setAttribute("variant", "note");
      callout.insert(0, [(old.firstChild as Y.XmlText).clone()]);
      after.transact(() => { fragment.delete(0, 1); fragment.insert(0, [callout]); });
    }
    editBlock(after, id, "The amber fox stays.", "The blue fox stays.");
    const left = document.body.appendChild(document.createElement("div"));
    const right = document.body.appendChild(document.createElement("div"));
    const split = createRevisionSplit({ beforeElement: left, afterElement: right, before, after });
    try {
      expect(texts(split.model.before, "removed")).toEqual(["amber"]);
      expect(texts(split.model.after, "revisionAdded")).toEqual(["blue"]);
      expect(texts(split.model.before, "revisionAdded")).toEqual([]);
      expect(texts(split.model.after, "removed")).toEqual([]);
      expect(right.querySelector('[role="note"]')?.getAttribute("aria-label")).toBe("Note");
      expect(left.querySelector(type === "quote" ? ".ub-quote" : '[role="note"]')).not.toBeNull();
      for (const [editor, text] of [[split.before, "The amber fox stays."], [split.after, "The blue fox stays."]] as const) {
        editor.commands.selectAll();
        const copied = editor.view.serializeForClipboard(editor.state.selection.content());
        expect(copied.text).toBe(text);
        expect(copied.dom.textContent).toBe(text);
        expect(copied.dom.querySelector(".ub-block-caption, [data-revision-change]")).toBeNull();
        expect(DOMParser.fromSchema(uberblickSchema).parse(copied.dom).textContent).toBe(text);
      }
    } finally { split.destroy(); }
  });

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

  it("explains a width-only table on After while retaining each side's widths and changed classification", () => {
    const before = doc();
    appendBlock(before, { type: "paragraph", text: "Opening" });
    appendBlock(before, { type: "paragraph", text: "Quiet" });
    appendBlock(before, { type: "table", text: "| Header | Other |\n| --- | --- |\n| Same cell | Value |" });
    appendBlock(before, { type: "paragraph", text: "Context" });
    appendBlock(before, { type: "paragraph", text: "Closing" });
    firstColumnWidth(before, 180);
    const after = clone(before);
    firstColumnWidth(after, 260);
    const originalBefore = Y.encodeStateAsUpdate(before);
    const originalAfter = Y.encodeStateAsUpdate(after);
    const left = document.body.appendChild(document.createElement("div"));
    const right = document.body.appendChild(document.createElement("div"));
    const split = createRevisionSplit({ beforeElement: left, afterElement: right, before, after });
    try {
      expect(split.model.comparison.blocks[2]).toMatchObject({ kind: "changed", fields: ["columnWidths"] });
      expect(split.model.rows[2]).toMatchObject({ kind: "changed", changed: true,
        before: { labels: [] }, after: { labels: ["Only column widths changed"] } });
      expect(left.querySelector(".ub-revision-fields")).toBeNull();
      const note = right.querySelector(".ub-revision-fields.ub-revision-widths-only");
      expect(note?.textContent).toBe("Only column widths changed");
      expect(note?.closest('[aria-hidden="true"], [hidden]')).toBeNull();
      for (const [element, editor, width] of [[left, split.before, 180], [right, split.after, 260]] as const) {
        expect(element.querySelector('[data-revision-row="changed"]')).not.toBeNull();
        expect(element.querySelector("[data-revision-mark]")).toBeNull();
        expect(element.querySelector("table col")?.getAttribute("style")).toContain(`width: ${width}px`);
        expect(editor.state.doc.child(2).child(0).child(0).attrs.colwidth).toEqual([width]);
        expect(element.querySelector("[data-revision-change]")).toBeNull();
        expect(element.textContent).not.toContain("columnWidths");
      }
      const folded = revisionSplitModel(before, after, { collapse: true, expanded: new Set() });
      expect(folded.rows.find((row) => row.at === 2)).toMatchObject({ kind: "changed", changed: true });
      expect(Y.encodeStateAsUpdate(before)).toEqual(originalBefore);
      expect(Y.encodeStateAsUpdate(after)).toEqual(originalAfter);
    } finally { split.destroy(); }
  });

  it.each(["cell text", "added row", "removed row", "columns", "cell formatting"] as const)(
    "keeps ordinary marks and human width captions when widths change with %s", (change) => {
      const before = doc();
      const source = "| Header | Other |\n| --- | --- |\n| old cell | Value |\n| tail | Last |";
      const id = appendBlock(before, { type: "table", text: source });
      firstColumnWidth(before, 180);
      const after = clone(before);
      if (change === "cell text") editBlock(after, id, source, source.replace("old cell", "new cell"));
      if (change === "added row") editBlock(after, id, source, `${source}\n| extra | Added |`, { tableMapping: { rows: [0, 1, 2, null], columns: [0, 1] } });
      if (change === "removed row") editBlock(after, id, source, source.replace("\n| tail | Last |", ""), { tableMapping: { rows: [0, 1], columns: [0, 1] } });
      if (change === "columns") editBlock(after, id, source, "| Header |\n| --- |\n| old cell |\n| tail |", { tableMapping: { rows: [0, 1, 2], columns: [0] } });
      if (change === "cell formatting") tableCellText(tableRows(getBlocksFragment(after).get(0) as Y.XmlElement)[1]![0]!)?.format(0, 3, { bold: {} });
      firstColumnWidth(after, 260);
      const model = revisionSplitModel(before, after);
      const label = change === "columns" ? "Changed: columns, column widths"
        : change === "cell formatting" ? "Changed: column widths, row 2, column 1: formatting" : "Changed: column widths";
      expect(model.comparison.blocks[0]?.fields).toContain("columnWidths");
      expect(model.rows[0]).toMatchObject({ kind: "changed", changed: true,
        before: { labels: [label] }, after: { labels: [label] } });
      if (change === "cell text") {
        expect(texts(model.before, "removed")).toEqual(["old"]);
        expect(texts(model.after, "revisionAdded")).toEqual(["new"]);
      } else if (change === "added row") expect(texts(model.after, "revisionAdded")).toEqual(["extra", "Added"]);
      else if (change === "removed row") expect(texts(model.before, "removed")).toEqual(["tail", "Last"]);
      else if (change === "columns") {
        expect(texts(model.before, "removed")).toContain("Other");
        expect(texts(model.after, "revisionAdded")).toContain("Header");
      }
    },
  );

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

  it("pairs only the changed source of the same Ablauf block, never a neighboring or different-language drawing", () => {
    const before = doc();
    const oldSource = 'flow v0\ncolumns main\nbox draft "Draft"';
    const newSource = oldSource.replace("Draft", "Approved");
    const changed = appendBlock(before, { type: "code", language: "ablauf", text: oldSource });
    appendBlock(before, { type: "code", language: "ablauf", text: "unchanged" });
    const removed = appendBlock(before, { type: "code", language: "ablauf", text: "removed" });
    appendBlock(before, { type: "code", language: "ablauf", text: "switch away" });
    appendBlock(before, { type: "code", language: "wireframe", text: "switch into" });
    const otherCode = appendBlock(before, { type: "code", language: "typescript", text: "old code" });
    const after = clone(before);
    editBlock(after, changed, oldSource, newSource);
    deleteBlock(after, removed);
    (getBlocksFragment(after).get(2) as Y.XmlElement).setAttribute("language", "wireframe");
    (getBlocksFragment(after).get(3) as Y.XmlElement).setAttribute("language", "ablauf");
    editBlock(after, otherCode, "old code", "new code");
    appendBlock(after, { type: "code", language: "ablauf", text: "added" });
    const model = revisionSplitModel(before, after);
    expect(model.before.content?.[0]?.attrs).toMatchObject({ revisionSource: oldSource, revisionOtherSource: newSource, revisionSide: "before" });
    expect(model.after.content?.[0]?.attrs).toMatchObject({ revisionSource: newSource, revisionOtherSource: oldSource, revisionSide: "after" });
    for (const side of [model.before, model.after]) {
      const otherBlocks = side.content?.slice(1).filter(node => node.type === "code") ?? [];
      expect(otherBlocks).toHaveLength(5);
      for (const block of otherBlocks) {
        expect(block.attrs?.revisionOtherSource).toBeNull();
        expect(block.attrs?.revisionSide).toBeNull();
      }
    }
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

  it.each([
    { language: "json-tree", oldSource: '{\n  "version": "old",\n  "nested": { "a": 1, "b": 2 }\n}', newSource: '{\n  "version": "new",\n  "nested": { "a": 1, "b": 2 }\n}' },
    { language: "ablauf", oldSource: 'flow v0\ncolumns main\nbox draft "Draft"', newSource: 'flow v0\ncolumns main\nbox draft "Approved"' },
  ])("copies each revision's changed $language with surrounding prose as plain text and authored HTML", ({ language, oldSource, newSource }) => {
    const before = doc();
    appendBlock(before, { type: "paragraph", text: "Opening paragraph" });
    const block = appendBlock(before, { type: "code", language, text: oldSource });
    appendBlock(before, { type: "paragraph", text: "Closing paragraph" });
    const after = clone(before);
    editBlock(after, block, oldSource, newSource);
    const left = document.body.appendChild(document.createElement("div"));
    const right = document.body.appendChild(document.createElement("div"));
    const originalFonts = Object.getOwnPropertyDescriptor(document, "fonts");
    if (language === "ablauf") Object.defineProperty(document, "fonts", { configurable: true,
      value: Object.assign(new EventTarget(), { load: async () => [], ready: Promise.resolve() }) });
    let split: ReturnType<typeof createRevisionSplit> | undefined;
    try {
      split = createRevisionSplit({ beforeElement: left, afterElement: right, before, after });
      for (const [editor, source] of [[split.before, oldSource], [split.after, newSource]] as const) {
        editor.commands.selectAll();
        const copied = editor.view.serializeForClipboard(editor.state.selection.content());
        expect(copied.text).toBe(`Opening paragraph\n\n${source}\n\nClosing paragraph`);
        const pasted = DOMParser.fromSchema(uberblickSchema).parse(copied.dom);
        expect(pasted.childCount).toBe(3);
        expect(pasted.child(0).textContent).toBe("Opening paragraph");
        expect(pasted.child(1).type.name).toBe("code");
        expect(pasted.child(1).attrs.language).toBe(language);
        expect(pasted.child(1).textContent).toBe(source);
        expect(pasted.child(2).textContent).toBe("Closing paragraph");
        expect(copied.dom.innerHTML).not.toContain("ub-json-compare");
      }
    } finally {
      split?.destroy();
      if (originalFonts !== undefined) Object.defineProperty(document, "fonts", originalFonts);
      else Reflect.deleteProperty(document, "fonts");
    }
  });

  it("folds runs of two or more quiet rows, keeping the row next to a change as context", () => {
    const rows = (pattern: string) => [...pattern].map((mark) => ({ changed: mark === "x" }));
    expect(unchangedRuns(rows("x....x"))).toEqual([{ start: 2, end: 3 }]);
    expect(unchangedRuns(rows("x...x"))).toEqual([]);
    expect(unchangedRuns(rows("....x....."))).toEqual([{ start: 0, end: 2 }, { start: 6, end: 9 }]);
    expect(unchangedRuns(rows("x.x"))).toEqual([]);
  });

  it("replaces a folded run on both sides with one bar naming its headings, and shows it again when expanded", () => {
    const before = doc();
    const first = appendBlock(before, { type: "paragraph", text: "Opening" });
    appendBlock(before, { type: "paragraph", text: "Context" });
    appendBlock(before, { type: "heading", level: 2, text: "Middle" });
    appendBlock(before, { type: "paragraph", text: "Quiet one" });
    appendBlock(before, { type: "paragraph", text: "Quiet two" });
    const after = clone(before);
    editBlock(after, first, "Opening", "Opened");
    const folded = revisionSplitModel(before, after, { collapse: true, expanded: new Set() });
    expect(folded.rows.map((row) => row.kind)).toEqual(["changed", "unchanged", "folded"]);
    expect(folded.rows[2]?.fold).toEqual({ run: 2, count: 3 });
    for (const side of [folded.before, folded.after]) {
      expect(top(side)).toEqual(["paragraph", "paragraph", "revisionFold"]);
      expect(side.content?.[2]?.attrs).toMatchObject({ run: 2, count: 3, headings: "Middle" });
    }
    expect(folded.runs).toEqual([2]);
    // Each row keeps its place in the full comparison, so it can be followed across folding.
    expect(folded.rows.map((row) => row.at)).toEqual([0, 1, 2]);
    const open = revisionSplitModel(before, after, { collapse: true, expanded: new Set([2]) });
    expect(open.rows).toHaveLength(5);
    expect(open.rows.map((row) => row.at)).toEqual([0, 1, 2, 3, 4]);
    expect(revisionSplitModel(before, after).rows).toHaveLength(5);
  });

  it("opens multiple runs in place, retaining surrounding drawings and read-only sides", () => {
    const before = doc();
    const first = appendBlock(before, { type: "paragraph", text: "Opening" });
    appendBlock(before, { type: "code", language: "wireframe", text: 'page "Before the runs"\n  text "Context"' });
    for (let index = 0; index < 4; index += 1) appendBlock(before, { type: "paragraph", text: `First run ${index}` });
    const middle = appendBlock(before, { type: "paragraph", text: "Middle" });
    for (let index = 0; index < 4; index += 1) appendBlock(before, { type: "paragraph", text: `Second run ${index}` });
    appendBlock(before, { type: "code", language: "wireframe", text: 'page "After the runs"\n  text "Context"' });
    const last = appendBlock(before, { type: "paragraph", text: "Closing" });
    const after = clone(before);
    editBlock(after, first, "Opening", "Opened");
    editBlock(after, middle, "Middle", "Changed middle");
    editBlock(after, last, "Closing", "Closed");
    const left = document.body.appendChild(document.createElement("div"));
    const right = document.body.appendChild(document.createElement("div"));
    const split = createRevisionSplit({ beforeElement: left, afterElement: right, before, after,
      folding: { collapse: true, expanded: new Set() } });
    try {
      const sides = [split.before, split.after];
      const retained = sides.map((editor) => [...editor.view.dom.querySelectorAll(".ub-wireframe")]);
      expect(retained.map((drawings) => drawings.length)).toEqual([2, 2]);
      expect(split.model.runs).toEqual([2, 8]);
      for (const run of split.model.runs) {
        const previous = split.model;
        split.expand(run);
        expect(split.model).not.toBe(previous);
        expect(split.model.rows.some((row) => row.fold?.run === run)).toBe(false);
        sides.forEach((editor, side) => {
          const drawings = [...editor.view.dom.querySelectorAll(".ub-wireframe")];
          expect(drawings).toHaveLength(2);
          drawings.forEach((drawing, index) => { expect(drawing).toBe(retained[side]?.[index]); });
          expect([...editor.view.dom.querySelectorAll<HTMLElement>(".ub-revision-row-start")].map((element) => [element.dataset.row, element.dataset.key]))
            .toEqual(split.model.rows.map((row, index) => [String(index), `${row.kind === "folded" ? "fold" : "row"}-${row.at}`]));
          expect(editor.getJSON().content?.filter((node) => node.type === "code").map((node) => node.attrs?.id))
            .toEqual([expect.stringMatching(/^revision-1-/), expect.stringMatching(/^revision-11-/)]);
          const content = editor.state.doc;
          editor.view.dispatch(editor.state.tr.insertText("Unwanted edit", 1));
          expect(editor.state.doc).toBe(content);
        });
      }
      expect(split.model.rows).toHaveLength(13);
      expect(left.querySelectorAll(".ub-revision-fold-button")).toHaveLength(0);
      expect(right.querySelectorAll(".ub-revision-fold-button")).toHaveLength(0);
      const opened = split.model;
      split.expand(2);
      expect(split.model).toBe(opened);
    } finally { split.destroy(); }
  });

  it.each([1, 2] as const)("retains a level %i section boundary when its heading is folded away", (level) => {
    const before = doc();
    appendBlock(before, { type: "heading", level: 2, text: "> Details" });
    const inside = appendBlock(before, { type: "paragraph", text: "Inside section" });
    appendBlock(before, { type: "paragraph", text: "Context after first change" });
    appendBlock(before, { type: "heading", level, text: "Outside section" });
    appendBlock(before, { type: "heading", level: 3, text: "Deeper heading" });
    appendBlock(before, { type: "paragraph", text: "Quiet block" });
    appendBlock(before, { type: "paragraph", text: "Context before second change" });
    const outside = appendBlock(before, { type: "paragraph", text: "Outside section change" });
    appendBlock(before, { type: "paragraph", text: "Tail" });
    const after = clone(before);
    editBlock(after, inside, "Inside section", "Inside section changed");
    editBlock(after, outside, "Outside section change", "Outside section change changed");
    const left = document.body.appendChild(document.createElement("div"));
    const right = document.body.appendChild(document.createElement("div"));
    const split = createRevisionSplit({ beforeElement: left, afterElement: right, before, after,
      folding: { collapse: true, expanded: new Set() } });
    try {
      for (const side of [left, right]) {
        expect(side.querySelector(".ub-revision-fold-button")?.textContent).toBe("3 unchanged blocks · Outside section, Deeper heading");
        expect(side.textContent).not.toContain("Quiet block");
        expect(side.querySelector(".ub-revision-fold")?.hasAttribute("data-toggle-folded")).toBe(false);
        const changed = [...side.querySelectorAll("p")].find((node) => node.textContent?.startsWith("Outside section change"));
        expect(changed).toBeDefined();
        expect(changed?.hasAttribute("data-toggle-folded")).toBe(false);
        const hidden = [...side.querySelectorAll("p")].find((node) => node.textContent?.startsWith("Inside section"));
        expect(hidden?.getAttribute("data-toggle-folded")).toBe("true");
      }
    } finally { split.destroy(); }
  });
});

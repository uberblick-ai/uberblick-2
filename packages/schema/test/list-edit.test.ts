import { describe, expect, it } from "vitest";
import * as Y from "yjs";
import {
  InvalidListAttributesError,
  InvalidTableMappingError,
  OldTextMismatchError,
  StaleBlockError,
  appendBlock,
  editBlock,
  getBlock,
  getBlockRev,
  initDoc,
} from "../src/index.js";
import type { BlockInput, ListIndent } from "../src/index.js";
import type { EditBlockOptions } from "../src/blocks.js";

function seeded(input: BlockInput = { type: "list-item", text: "item" }): { doc: Y.Doc; id: string } {
  const doc = new Y.Doc();
  initDoc(doc, { uuid: "88888888-8888-4888-8888-888888888888", title: "List edits" });
  return { doc, id: appendBlock(doc, input) };
}

describe("editBlock list attributes", () => {
  it("changes only supplied attributes, alone or together with a text splice", () => {
    const { doc, id } = seeded();
    const initialRev = getBlockRev(doc, id);
    editBlock(doc, id, "item", "item", { rev: initialRev, list: "ordered" });
    expect(getBlock(doc, id)).toMatchObject({ id, text: "item", list: "ordered", indent: 0 });
    expect(getBlockRev(doc, id)).not.toBe(initialRev);

    const styleRev = getBlockRev(doc, id);
    editBlock(doc, id, "item", "item", { rev: styleRev, indent: 3 });
    expect(getBlock(doc, id)).toMatchObject({ list: "ordered", indent: 3 });
    expect(getBlockRev(doc, id)).not.toBe(styleRev);

    editBlock(doc, id, "item", "item revised", { list: "bullet", indent: 2 });
    expect(getBlock(doc, id)).toMatchObject({ text: "item revised", list: "bullet", indent: 2 });
    editBlock(doc, id, "item revised", "item revised again");
    expect(getBlock(doc, id)).toMatchObject({ text: "item revised again", list: "bullet", indent: 2 });
  });

  it("refuses stale revisions and mismatched old text without changing attributes or text", () => {
    const { doc, id } = seeded();
    const oldRev = getBlockRev(doc, id);
    editBlock(doc, id, "item", "item", { rev: oldRev, indent: 1 });
    const before = Y.encodeStateVector(doc);
    expect(() => editBlock(doc, id, "item", "changed", { rev: oldRev, list: "ordered" })).toThrow(StaleBlockError);
    expect(() => editBlock(doc, id, "wrong", "changed", { rev: getBlockRev(doc, id), indent: 2 })).toThrow(OldTextMismatchError);
    expect(Y.encodeStateVector(doc)).toEqual(before);
    expect(getBlock(doc, id)).toMatchObject({ text: "item", list: "bullet", indent: 1 });
  });

  it.each<BlockInput>([
    { type: "paragraph", text: "item" },
    { type: "table", text: "| Header |\n| --- |\n| Cell |" },
  ])("refuses list attributes on a $type before any write", (input) => {
    const { doc, id } = seeded(input);
    const block = getBlock(doc, id);
    const before = Y.encodeStateVector(doc);
    expect(() => editBlock(doc, id, block?.text ?? "", "changed", { list: "ordered", indent: 1 })).toThrow(InvalidListAttributesError);
    expect(Y.encodeStateVector(doc)).toEqual(before);
    expect(getBlock(doc, id)).toEqual(block);
  });

  it.each([-1, 4, 1.5, Number.NaN, Number.POSITIVE_INFINITY])("refuses invalid indent %s before any write", (indent) => {
    const { doc, id } = seeded();
    const before = Y.encodeStateVector(doc);
    expect(() => editBlock(doc, id, "item", "changed", { list: "ordered", indent: indent as ListIndent })).toThrow(InvalidListAttributesError);
    expect(Y.encodeStateVector(doc)).toEqual(before);
  });

  it("refuses an unsupported marker and a misplaced table mapping without applying valid attributes", () => {
    const { doc, id } = seeded();
    const before = Y.encodeStateVector(doc);
    const invalidList = { list: "task", indent: 2 } as unknown as EditBlockOptions;
    expect(() => editBlock(doc, id, "item", "changed", invalidList)).toThrow(InvalidListAttributesError);
    expect(() => editBlock(doc, id, "item", "changed", { list: "ordered", tableMapping: { rows: [], columns: [] } })).toThrow(InvalidTableMappingError);
    expect(Y.encodeStateVector(doc)).toEqual(before);
  });
});

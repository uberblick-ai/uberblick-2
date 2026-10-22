import { appendBlock, createTagCatalogEntry, deleteTagCatalogEntry, getMeta, initDoc } from "@uberblick/schema";
import { describe, expect, it } from "vitest";
import * as Y from "yjs";
import { writeDocument } from "../src/collab/document-write.js";

describe("explicit document write cleanup", () => {
  it("keeps delayed references and cleans confirmed deletions in the authored transaction", () => {
    const catalog = new Y.Doc();
    const tag = createTagCatalogEntry(catalog, "research");
    const delayed = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
    const doc = new Y.Doc();
    initDoc(doc, { uuid: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", title: "Notes", tags: [tag.id, delayed] });
    const before = Y.encodeStateAsUpdate(doc);
    deleteTagCatalogEntry(catalog, tag.id);
    expect(Y.encodeStateAsUpdate(doc)).toEqual(before);
    writeDocument(doc, catalog, () => undefined);
    expect(Y.encodeStateAsUpdate(doc)).toEqual(before);
    expect(() => writeDocument(doc, catalog, () => { throw new Error("Refused"); })).toThrow("Refused");
    expect(Y.encodeStateAsUpdate(doc)).toEqual(before);

    let updates = 0;
    doc.on("update", () => { updates += 1; });
    writeDocument(doc, catalog, () => appendBlock(doc, { type: "paragraph", text: "An explicit edit" }));
    expect(getMeta(doc).tags).toEqual([delayed]);
    expect(updates).toBe(1);
    doc.destroy();
    catalog.destroy();
  });
});

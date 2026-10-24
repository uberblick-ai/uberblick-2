import { expect, it } from "vitest";
import * as Y from "yjs";
import { appendBlock, createTagCatalogEntry, deleteTagCatalogEntry, getMeta, initDoc, isDirectoryEntryArchived, tombstoneDirectoryEntry, upsertDirectoryEntry } from "@uberblick/schema";
import { deleteTableColumn, tableColumnTargets } from "../src/editor/table-controls.js";
import { mountEditor, typeText } from "./helpers.js";

function fixture(table = false, canCleanupTags: () => boolean = () => true) {
  const doc = new Y.Doc();
  const catalog = new Y.Doc();
  const tag = createTagCatalogEntry(catalog, "deleted");
  const unknown = "90000000-0000-4000-8000-000000000001";
  initDoc(doc, { uuid: "editor-tags", title: "Editor tags", tags: [tag.id, unknown] });
  const block = appendBlock(doc, table
    ? { type: "table", text: "| A | B |\n| --- | --- |\n| one | two |" }
    : { type: "paragraph", text: "Original" });
  deleteTagCatalogEntry(catalog, tag.id);
  const { editor } = mountEditor(doc, { workspaceSettings: catalog, canCleanupTags });
  return { doc, catalog, editor, block, tag, unknown };
}

it("typing cleans confirmed deletions while binding, remote edits and maintenance leave references stored", () => {
  const { doc, catalog, editor, tag, unknown } = fixture();
  try {
    expect(getMeta(doc).tags).toContain(tag.id);
    const peer = new Y.Doc();
    Y.applyUpdate(peer, Y.encodeStateAsUpdate(doc));
    appendBlock(peer, { type: "paragraph", text: "Incoming" });
    Y.applyUpdate(doc, Y.encodeStateAsUpdate(peer));
    editor.view.dispatch(editor.state.tr.setMeta("uberblick:writable", true));
    expect(getMeta(doc).tags).toContain(tag.id);
    typeText(editor, "Authored");
    expect(getMeta(doc).tags).toEqual([unknown]);
    peer.destroy();
  } finally { editor.destroy(); doc.destroy(); catalog.destroy(); }
});

it("a direct table control cleans inside its permitted shared write", () => {
  const { doc, catalog, editor, block, unknown } = fixture(true);
  try {
    const target = tableColumnTargets(editor, block)?.[1];
    expect(target).toBeDefined();
    if (target === undefined) throw new Error("Missing table column");
    expect(deleteTableColumn(editor, target)).toBe(true);
    expect(getMeta(doc).tags).toEqual([unknown]);
  } finally { editor.destroy(); doc.destroy(); catalog.destroy(); }
});

it.each([false, true])("rechecks the cleanup gate before a stale editor control writes, table=%s", (table) => {
  const directory = new Y.Doc();
  upsertDirectoryEntry(directory, { uuid: "editor-tags", title: "Editor tags" });
  const { doc, catalog, editor, block, tag } = fixture(table, () => !isDirectoryEntryArchived(directory, "editor-tags"));
  try {
    tombstoneDirectoryEntry(directory, "editor-tags");
    expect(editor.isEditable).toBe(true);
    if (table) {
      const target = tableColumnTargets(editor, block)?.[1];
      if (target === undefined) throw new Error("Missing table column");
      expect(deleteTableColumn(editor, target)).toBe(true);
    } else typeText(editor, "Stale control");
    expect(getMeta(doc).tags).toContain(tag.id);
  } finally { editor.destroy(); doc.destroy(); catalog.destroy(); directory.destroy(); }
});

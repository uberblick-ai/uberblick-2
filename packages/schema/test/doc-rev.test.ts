import { describe, expect, it } from "vitest";
import * as Y from "yjs";
import {
  appendBlock,
  blockRev,
  createAnnotation,
  deleteBlock,
  docRev,
  editBlock,
  getBlocks,
  getBlocksFragment,
  initDoc,
  observeDocRev,
  repairDuplicateBlocks,
  setBlockType,
  setTitle,
} from "../src/index.js";

function seeded(): Y.Doc {
  const doc = new Y.Doc();
  initDoc(doc, { uuid: "88888888-8888-4888-8888-888888888888", title: "Revs" });
  return doc;
}

function foreignBlock(text: string, id?: string): Y.XmlElement {
  const element = new Y.XmlElement("paragraph");
  if (id !== undefined) element.setAttribute("id", id);
  element.insert(0, [new Y.XmlText(text)]);
  return element;
}

describe("docRev", () => {
  it("keeps the existing visible-block fold and follows content and structure", () => {
    const doc = seeded();
    const alpha = appendBlock(doc, { type: "paragraph", text: "alpha" });
    const bravo = appendBlock(doc, { type: "paragraph", text: "bravo" });
    const original = docRev(doc);
    expect(original).toBe(blockRev({
      type: "paragraph",
      text: getBlocks(doc).map((block) => `${block.id} ${block.rev}`).join("\n"),
    }));
    const observed: string[] = [];
    const stop = observeDocRev(doc, (rev) => observed.push(rev));
    try {
      editBlock(doc, bravo, "bravo", "bravo edited");
      expect(observed.at(-1)).not.toBe(original);
      expect(observed.at(-1)).toBe(docRev(doc));
      const afterEdit = docRev(doc);
      setBlockType(doc, alpha, "heading", { level: 2 });
      expect(docRev(doc)).not.toBe(afterEdit);
      expect(observed.at(-1)).toBe(docRev(doc));
      const afterType = docRev(doc);
      deleteBlock(doc, bravo);
      expect(docRev(doc)).not.toBe(afterType);
      expect(observed.at(-1)).toBe(docRev(doc));
      const afterDelete = docRev(doc);
      appendBlock(doc, { type: "paragraph", text: "charlie" });
      expect(docRev(doc)).not.toBe(afterDelete);
      expect(observed.at(-1)).toBe(docRev(doc));
    } finally {
      stop();
    }
  });

  it("reads each visible ID-less block independently before and after edits", () => {
    const doc = seeded();
    const fragment = getBlocksFragment(doc);
    const missing = foreignBlock("missing identity");
    const empty = foreignBlock("empty identity", "");
    fragment.insert(0, [missing, empty]);
    const observed: string[] = [];
    const stop = observeDocRev(doc, (rev) => observed.push(rev));
    try {
      expect(observed.at(-1)).toBe(docRev(doc));
      const original = docRev(doc);
      (missing.firstChild as Y.XmlText).insert(0, "edited ");
      expect(docRev(doc)).not.toBe(original);
      expect(observed.at(-1)).toBe(docRev(doc));
      const firstEdit = docRev(doc);
      (empty.firstChild as Y.XmlText).insert(0, "edited ");
      expect(docRev(doc)).not.toBe(firstEdit);
      expect(observed.at(-1)).toBe(docRev(doc));
      fragment.insert(2, [foreignBlock("another missing identity")]);
      expect(observed.at(-1)).not.toBe(firstEdit);
      expect(observed.at(-1)).toBe(docRev(doc));
    } finally {
      stop();
    }
  });

  it("ignores metadata, prose marks and shadowed duplicate repairs", () => {
    const doc = seeded();
    const id = appendBlock(doc, { type: "paragraph", text: "alpha" });
    const original = docRev(doc);
    const observed: string[] = [];
    const stop = observeDocRev(doc, (rev) => observed.push(rev));
    try {
      setTitle(doc, "Another title");
      createAnnotation(doc, id, 0, 2, "reviewer", "check");
      const text = (getBlocksFragment(doc).get(0) as Y.XmlElement).firstChild as Y.XmlText;
      text.format(0, 2, { bold: {} });
      getBlocksFragment(doc).insert(1, [foreignBlock("shadowed", id)]);
      repairDuplicateBlocks(doc);
      expect(docRev(doc)).toBe(original);
      expect(observed.every((rev) => rev === original)).toBe(true);
    } finally {
      stop();
    }
  });

  it("changes with document order and agrees across replicas", () => {
    const doc = seeded();
    appendBlock(doc, { type: "paragraph", text: "alpha" });
    appendBlock(doc, { type: "paragraph", text: "bravo" });
    const replica = new Y.Doc();
    Y.applyUpdate(replica, Y.encodeStateAsUpdate(doc));
    const original = docRev(doc);
    expect(docRev(replica)).toBe(original);
    const fragment = getBlocksFragment(doc);
    const first = (fragment.get(0) as Y.XmlElement).clone();
    doc.transact(() => {
      fragment.delete(0, 1);
      fragment.insert(1, [first]);
    });
    expect(docRev(doc)).not.toBe(original);
    Y.applyUpdate(replica, Y.encodeStateAsUpdate(doc));
    expect(docRev(replica)).toBe(docRev(doc));
  });
});

import * as Y from "yjs";
import { expect, it } from "vitest";
import {
  appendBlock, compareRevisions, createAnnotation, DATA_KEY, getBlocksFragment,
  getDocDataEntries, getMetaMap, initDoc, snapshotRevision,
} from "../src/index.js";

it("copies authored content without comment marks, excluded metadata or deleted content", () => {
  const document = new Y.Doc({ gc: false });
  const copy = new Y.Doc();
  try {
    initDoc(document, { uuid: "11111111-1111-4111-8111-111111111111", title: "Title", description: "private-description" });
    getMetaMap(document).set("tldr", "private-summary");
    const prose = appendBlock(document, { type: "paragraph", inline: [{ text: "marked text", marks: { bold: true } }] });
    const table = appendBlock(document, { type: "table", text: "| Name |\n| --- |\n| **marked** text |" });
    const card = appendBlock(document, { type: "card", text: "label: Label\ntitle: Title\nfooter: Footer\nbutton: [Open](https://example.com)\n\nBody" });
    const figma = appendBlock(document, { type: "figma", text: "url: https://www.figma.com/design/abc/Design\n\nCaption" });
    appendBlock(document, { type: "chart", text: '{"version":1,"type":"line","collection":"values"}' });
    const fragment = getBlocksFragment(document);
    const removed = new Y.XmlElement("paragraph");
    fragment.insert(fragment.length, [removed]);
    const removedText = new Y.XmlText();
    removed.insert(0, [removedText]);
    removedText.insert(0, "deleted-private-content");
    fragment.delete(fragment.length - 1, 1);
    document.getMap(DATA_KEY).set("unsupported-raw-key", { nested: { constructor: "raw" }, count: 4 });
    const baseline = snapshotRevision(document).checksum;
    createAnnotation(document, prose, 1, 4, "person", "private-comment");
    createAnnotation(document, table, 1, 4, "person", "table-comment", { row: 1, column: 0 });
    createAnnotation(document, card, 1, 3, "person", "card-comment", { part: "body" });
    createAnnotation(document, figma, 1, 4, "person", "figma-comment", { part: "caption" });
    const sourceBytes = Y.encodeStateAsUpdate(document);
    const snapshot = snapshotRevision(document);
    expect(snapshot.checksum).toBe(baseline);
    Y.applyUpdate(copy, snapshot.state);
    expect(compareRevisions(document, copy).changed).toBe(false);
    expect(getDocDataEntries(copy)).toEqual(getDocDataEntries(document));
    expect([...getMetaMap(copy).keys()]).toEqual(["title"]);
    expect(copy.getMap("annotations").size).toBe(0);
    const encodedText = new TextDecoder().decode(snapshot.state);
    for (const excluded of ["private-description", "private-summary", "private-comment", "deleted-private-content", "commentMark"]) {
      expect(encodedText).not.toContain(excluded);
    }
    expect(Y.encodeStateAsUpdate(document)).toEqual(sourceBytes);
    copy.getMap(DATA_KEY).set("unsupported-raw-key", { count: 5 });
    expect(snapshotRevision(copy).checksum).not.toBe(snapshot.checksum);
  } finally { document.destroy(); copy.destroy(); }
});

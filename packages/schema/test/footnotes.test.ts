import * as Y from "yjs";
import { describe, expect, it } from "vitest";
import {
  appendBlock, compareRevisions, decisionAnswerShapeFailure, deleteBlock, editBlock,
  findBlockElement, getBlock, getBlockInline, getBlocks, getBlocksWithInline,
  initDoc, moveBlocks, referenceInline, restoreRevisionContent, setKind, snapshotRevision,
} from "../src/index.js";
import type { BlockInput } from "../src/index.js";

function doc(): Y.Doc {
  const result = new Y.Doc();
  initDoc(result, { uuid: "11111111-1111-4111-8111-111111111111", title: "Footnotes" });
  return result;
}

function copy(source: Y.Doc): Y.Doc {
  const result = new Y.Doc();
  Y.applyUpdate(result, Y.encodeStateAsUpdate(source));
  return result;
}

function ref(text: string) { return { text, marks: { footnoteRef: true } }; }

describe("footnote storage and edits", () => {
  it("stores labels in block revisions and splits adjacent reference flags on reads", () => {
    const page = doc();
    const body = appendBlock(page, { type: "paragraph", inline: [ref("[^A]"), ref("[^b]")] });
    const note = appendBlock(page, { type: "footnote", label: "A", inline: [{ text: "marked note", marks: { italic: true } }] });
    expect(getBlockInline(page, body)).toEqual([ref("[^A]"), ref("[^b]")]);
    expect(getBlocksWithInline(page)[0]!.inline).toEqual([ref("[^A]"), ref("[^b]")]);
    const old = getBlock(page, note)!;
    editBlock(page, note, old.text, old.text, { label: "renamed", rev: old.rev });
    expect(getBlock(page, note)).toMatchObject({ type: "footnote", label: "renamed", text: "marked note" });
    expect(getBlock(page, note)!.rev).not.toBe(old.rev);
    expect(getBlockInline(page, note)).toEqual([{ text: "marked note", marks: { italic: true } }]);
    page.destroy();
  });

  it("refuses invalid labels and explicit reference runs without writing", () => {
    const page = doc();
    for (const input of [
      { type: "footnote", text: "note" },
      ...["", "a b", "a[b", "a]b", "a\\b"].map((label) => ({ type: "footnote", label, text: "note" })),
      { type: "paragraph", label: "a", text: "body" },
      ...["[^a][^b]", "[^a] tail", "[^]", "prefix[^a]"].map((text) => ({ type: "paragraph", inline: [ref(text)] })),
      ...["footnote", "code", "table", "terminal", "chart", "card", "figma"].map((type) => ({ type, label: type === "footnote" ? "a" : undefined, inline: [ref("[^a]")] })),
      { type: "paragraph", inline: [{ text: "[^a]", marks: { footnoteRef: true, inlineCode: true } }] },
      { type: "paragraph", inline: [{ text: "[^a]", marks: { footnoteRef: true, link: "https://example.com" } }] },
    ] as BlockInput[]) {
      const before = Y.encodeStateAsUpdate(page);
      expect(() => appendBlock(page, input)).toThrow();
      expect(Y.encodeStateAsUpdate(page)).toEqual(before);
    }
    const note = appendBlock(page, { type: "footnote", label: "a", text: "note" });
    const before = Y.encodeStateAsUpdate(page);
    expect(() => editBlock(page, note, "note", "changed", { label: "bad label" })).toThrow();
    expect(Y.encodeStateAsUpdate(page)).toEqual(before);
    expect(decisionAnswerShapeFailure([{ type: "paragraph", inline: [ref("[^a]")] }])).toBe("decision_block_unsupported");
    page.destroy();
  });

  it("marks newly written prose while preserving untouched literals and protected text", () => {
    const page = doc();
    const body = appendBlock(page, { type: "paragraph", inline: [
      { text: "literal[^old] ", marks: {} },
      { text: "code", marks: { inlineCode: true } },
      { text: " link", marks: { link: "https://example.com" } },
    ] });
    editBlock(page, body, "literal[^old] code link", "literal[^old] code[^code] link[^link]");
    expect(getBlockInline(page, body).some((run) => run.marks.footnoteRef)).toBe(false);
    editBlock(page, body, "literal[^old] code[^code] link[^link]", "new[^one] literal[^old] code[^code] link[^link]");
    expect(getBlockInline(page, body).filter((run) => run.marks.footnoteRef)).toEqual([ref("[^one]")]);
    const noted = appendBlock(page, { type: "footnote", label: "n", text: "old" });
    editBlock(page, noted, "old", "note[^literal]");
    expect(getBlockInline(page, noted)).toEqual([{ text: "note[^literal]", marks: {} }]);
    const decision = doc();
    setKind(decision, "decision");
    const answer = appendBlock(decision, { type: "paragraph", text: "old" });
    editBlock(decision, answer, "old", "answer[^literal]");
    expect(getBlockInline(decision, answer)).toEqual([{ text: "answer[^literal]", marks: {} }]);
    expect(referenceInline([{ text: "escaped\\[^a] [^b]", marks: {} }])).toEqual([
      { text: "escaped\\[^a] ", marks: {} }, ref("[^b]"),
    ]);
    page.destroy(); decision.destroy();
  });

  it("clears inherited reference tails and reads partial released-client edits as literal", () => {
    const page = doc();
    const body = appendBlock(page, { type: "paragraph", inline: [ref("[^a]")] });
    editBlock(page, body, "[^a]", "[^a] tail[^b]");
    expect(getBlockInline(page, body)).toEqual([ref("[^a]"), { text: " tail", marks: {} }, ref("[^b]")]);
    const text = findBlockElement(page, body)!.firstChild as Y.XmlText;
    text.delete(0, 1);
    expect(getBlockInline(page, body)).toEqual([{ text: "^a] tail", marks: {} }, ref("[^b]")]);
    page.destroy();
  });
});

describe("footnote history compatibility", () => {
  it("detects note labels, text, additions, removals and reference-only changes and restores them", () => {
    const before = doc();
    const body = appendBlock(before, { type: "paragraph", text: "body[^a]" });
    const note = appendBlock(before, { type: "footnote", label: "a", text: "old note" });
    const after = copy(before);
    const text = findBlockElement(after, body)!.firstChild as Y.XmlText;
    text.format(4, 4, { footnoteRef: {} });
    editBlock(after, note, "old note", "new note", { label: "b" });
    const change = compareRevisions(before, after);
    expect(change.blocks[0]).toMatchObject({ kind: "changed", fields: ["formatting"] });
    expect(change.blocks[1]).toMatchObject({ kind: "changed", fields: ["label"] });
    expect(change.blocks[1]!.spans.length).toBeGreaterThan(0);
    const snapshot = snapshotRevision(after);
    const revision = new Y.Doc();
    Y.applyUpdate(revision, snapshot.state);
    expect(snapshotRevision(revision).checksum).toBe(snapshot.checksum);
    expect(snapshotRevision(before).checksum).not.toBe(snapshot.checksum);
    restoreRevisionContent(before, revision);
    expect(getBlocks(before).map(({ type, text, label }) => ({ type, text, label }))).toEqual([
      { type: "paragraph", text: "body[^a]", label: undefined }, { type: "footnote", text: "new note", label: "b" },
    ]);
    expect(getBlockInline(before, body).filter((run) => run.marks.footnoteRef)).toEqual([ref("[^a]")]);
    deleteBlock(after, note);
    expect(compareRevisions(revision, after).blocks[1]!.kind).toBe("removed");
    expect(compareRevisions(after, revision).blocks[1]!.kind).toBe("added");
    before.destroy(); after.destroy(); revision.destroy();
  });

  it("keeps released live reads, edits and moves while their history checksum differs", () => {
    const page = doc();
    const body = appendBlock(page, { type: "paragraph", inline: [ref("[^a]")] });
    const note = appendBlock(page, { type: "footnote", label: "a", text: "note" });
    const releasedProjection = (): Y.Doc => {
      const released = doc();
      for (const block of getBlocksWithInline(page)) {
        appendBlock(released, {
          type: block.block.type === "footnote" ? "paragraph" : block.block.type,
          inline: block.inline.map((run) => { const marks = { ...run.marks }; delete marks.footnoteRef; return { text: run.text, marks }; }),
        });
      }
      return released;
    };
    const released = releasedProjection();
    const legacyChecksum = snapshotRevision(released).checksum;
    expect(getBlocks(released).map(({ type, text }) => ({ type, text }))).toEqual([
      { type: "paragraph", text: "[^a]" }, { type: "paragraph", text: "note" },
    ]);
    expect(legacyChecksum).not.toBe(snapshotRevision(page).checksum);
    const noteText = findBlockElement(page, note)!.firstChild as Y.XmlText;
    noteText.insert(noteText.length, " edited");
    moveBlocks(page, [note], null);
    expect(getBlock(page, note)).toMatchObject({ type: "footnote", label: "a", text: "note edited" });
    expect(getBlockInline(page, body)).toEqual([ref("[^a]")]);
    const old = releasedProjection();
    const checksum = snapshotRevision(old).checksum;
    findBlockElement(page, note)!.setAttribute("label", "changed");
    (findBlockElement(page, body)!.firstChild as Y.XmlText).format(0, 4, { footnoteRef: null });
    const updated = releasedProjection();
    expect(snapshotRevision(updated).checksum).toBe(checksum);
    expect(snapshotRevision(page).checksum).not.toBe(checksum);
    page.destroy(); released.destroy(); old.destroy(); updated.destroy();
  });
});

/**
 * What a bridge is allowed to call "the same document".
 *
 * `docFingerprint` gates every refusal and the whole of verification, so the
 * property worth defending is narrow and total: a replica that received
 * everything fingerprints the same, and a replica missing *anything the schema
 * can hold* does not. `Block.rev` covers type, text and attributes and would
 * pass a replica that received every character and none of the formatting or
 * comment threads — which is the state a half-finished sync leaves behind, and
 * what a user would not notice until they opened the document.
 *
 * Every pair here is built by replicating a document and then diverging one
 * side, rather than by constructing two documents that look alike. Block ids
 * are identity, so two independently built documents are genuinely different
 * ones; replication is also what the bridge is actually comparing.
 */

import {
  COMMENT_MARK,
  addComment,
  appendBlock,
  createAnnotation,
  findBlockElement,
  getBlocks,
  getMeta,
  initDoc,
  listAnnotationRanges,
  listAnnotations,
  setChangelogSuggestion,
  setDescription,
  setKind,
  setLinks,
  setStatus,
  setTags,
  setTldr,
  setTitle,
  tableCellText,
  tableRows,
} from "@uberblick/schema";
import * as Y from "yjs";
import { describe, expect, it } from "vitest";
import { compareCorpus, docFingerprint, isIdentical } from "../src/remote.js";
import type { CorpusDoc } from "../src/remote.js";

const UUID = "3f0a3d4c-6f6c-4e5f-9b9a-1f2e3d4c5b6a";
const DECISION_A = "11111111-1111-4111-8111-111111111111";
const DECISION_B = "22222222-2222-4222-8222-222222222222";
const DECISION_C = "33333333-3333-4333-8333-333333333333";

function source(): Y.Doc {
  const ydoc = new Y.Doc();
  initDoc(ydoc, { uuid: UUID, title: "A note", tags: ["one"] });
  appendBlock(ydoc, { type: "paragraph", text: "hello there" });
  return ydoc;
}

/** What a fresh client that received everything ends up holding. */
function replicate(from: Y.Doc): Y.Doc {
  const copy = new Y.Doc();
  Y.applyUpdate(copy, Y.encodeStateAsUpdate(from));
  return copy;
}

function firstBlock(ydoc: Y.Doc): { id: string; text: Y.XmlText } {
  const element = ydoc.getXmlFragment("blocks").toArray()[0];
  if (!(element instanceof Y.XmlElement)) throw new Error("no block");
  const id = element.getAttribute("id");
  const text = element.firstChild;
  if (id === undefined || !(text instanceof Y.XmlText)) {
    throw new Error("no block text");
  }
  return { id, text };
}

function entry(ydoc: Y.Doc, overrides: Partial<CorpusDoc> = {}): CorpusDoc {
  return {
    uuid: UUID,
    title: "A note",
    tags: ["one"],
    deleted: false,
    fingerprint: docFingerprint(ydoc),
    stateVector: Y.encodeStateVector(ydoc),
    ...overrides,
  };
}

describe("docFingerprint", () => {
  it("covers table cell text, formatting and anchors while remaining stable after replication", () => {
    const doc = source();
    const id = appendBlock(doc, { type: "table", text: "| Header |\n| --- |\n| Cell |" });
    const copy = replicate(doc);
    const cells = tableRows(findBlockElement(doc, id)!);
    const text = tableCellText(cells[1]![0]!)!;
    expect(docFingerprint(copy)).toBe(docFingerprint(doc));
    text.insert(text.length, " changed");
    expect(docFingerprint(copy)).not.toBe(docFingerprint(doc));
    Y.applyUpdate(copy, Y.encodeStateAsUpdate(doc));
    expect(docFingerprint(copy)).toBe(docFingerprint(doc));
    const rev = getBlocks(doc).find(block => block.id === id)!.rev;
    text.format(0, 4, { bold: true, [COMMENT_MARK]: { threadId: "synthetic-cell-anchor" } });
    expect(getBlocks(doc).find(block => block.id === id)!.rev).toBe(rev);
    expect(docFingerprint(copy)).not.toBe(docFingerprint(doc));
    Y.applyUpdate(copy, Y.encodeStateAsUpdate(doc));
    text.format(0, 4, { [COMMENT_MARK]: null });
    expect(docFingerprint(copy)).not.toBe(docFingerprint(doc));
    Y.applyUpdate(copy, Y.encodeStateAsUpdate(doc));
    expect(docFingerprint(copy)).toBe(docFingerprint(doc));
    doc.destroy();
    copy.destroy();
  });
  it("is stable across replication", () => {
    const doc = source();
    expect(docFingerprint(replicate(doc))).toBe(docFingerprint(doc));
  });

  it("is stable across tag request order", () => {
    const doc = source();
    setTags(doc, ["one", "two"]);
    const copy = replicate(doc);
    setTags(copy, ["two", "one"]);

    expect(getMeta(doc).tags).toEqual(getMeta(copy).tags);
    expect(docFingerprint(doc)).toBe(docFingerprint(copy));
  });

  it("is unmoved by link order", () => {
    const doc = source();
    setLinks(doc, [DECISION_A, DECISION_B]);
    const copy = replicate(doc);
    setLinks(copy, [DECISION_B, DECISION_A]);

    expect(getMeta(doc).links).not.toEqual(getMeta(copy).links);
    expect(docFingerprint(doc)).toBe(docFingerprint(copy));
  });

  it("changes when a block's text changes", () => {
    const doc = source();
    const copy = replicate(doc);
    firstBlock(doc).text.insert(0, "not ");
    expect(docFingerprint(copy)).not.toBe(docFingerprint(doc));
  });

  it("changes when only the inline marks change", () => {
    // Same block id, same characters, same attributes — so `Block.rev` is
    // identical on both sides and only the marks tell them apart.
    const doc = source();
    const copy = replicate(doc);
    firstBlock(doc).text.format(0, 5, { bold: true });
    expect(docFingerprint(copy)).not.toBe(docFingerprint(doc));
  });

  it("changes when only an annotation is added", () => {
    const doc = source();
    const copy = replicate(doc);
    createAnnotation(doc, firstBlock(doc).id, 0, 5, "someone", "is this right?");
    expect(docFingerprint(copy)).not.toBe(docFingerprint(doc));
  });

  // The case nothing else here can see: `getBlockInline` strips the comment
  // mark, the annotations map holds no positions, and a state vector says
  // nothing about a delete set. Undo the anchor and the text, the state vector
  // and the thread record are all still identical.
  it("changes when only an annotation's anchor is removed", () => {
    const doc = source();
    const { id } = firstBlock(doc);
    createAnnotation(doc, id, 0, 5, "someone", "is this right?");

    const copy = replicate(doc);
    // The thread survives in the annotations map; only its anchoring mark goes.
    firstBlock(doc).text.format(0, 5, { [COMMENT_MARK]: null });

    expect(listAnnotationRanges(doc, id)).toHaveLength(0);
    expect(listAnnotationRanges(copy, firstBlock(copy).id)).toHaveLength(1);
    // The things that would have had to catch it, and do not:
    expect(getBlocks(doc)[0]?.text).toBe(getBlocks(copy)[0]?.text);
    expect(listAnnotations(doc)).toEqual(listAnnotations(copy));

    expect(docFingerprint(copy)).not.toBe(docFingerprint(doc));
  });

  // A reply is an insert into a Y.Array nested inside the thread's map value,
  // so a fingerprint that canonicalised that value without `toJSON()` would call
  // a replica missing every reply identical to one holding them.
  it("changes when only a reply is added to an existing thread", () => {
    const doc = source();
    const thread = createAnnotation(
      doc,
      firstBlock(doc).id,
      0,
      5,
      "someone",
      "is this right?",
    );

    const copy = replicate(doc);
    addComment(doc, thread.id, "someone else", "no");

    expect(docFingerprint(copy)).not.toBe(docFingerprint(doc));
  });

  it("changes when only the title changes", () => {
    const doc = source();
    const copy = replicate(doc);
    setTitle(doc, "Another note");
    expect(docFingerprint(copy)).not.toBe(docFingerprint(doc));
  });

  // The three `meta` fields the hand-written field list never grew to include:
  // each landed in `DocMeta` after the fingerprint was written, and each left
  // the schema-level half of verification blind on it.
  it("changes when only the description changes", () => {
    const doc = source();
    const copy = replicate(doc);
    setDescription(doc, "what this note is for");
    expect(docFingerprint(copy)).not.toBe(docFingerprint(doc));
  });

  it("changes when only the TL;DR changes", () => {
    const doc = source();
    const copy = replicate(doc);
    setTldr(doc, "A short person-facing summary.");
    expect(docFingerprint(copy)).not.toBe(docFingerprint(doc));
  });

  // All three states of one key, because a suggestion nobody wrote and a
  // deliberate "no user-facing entry" are different documents — and only the
  // absent one is invisible to JSON.
  it("changes when only the changelog suggestion changes", () => {
    const doc = source();
    const unwritten = replicate(doc);
    setChangelogSuggestion(doc, "Documents now carry a changelog suggestion.");
    expect(docFingerprint(unwritten)).not.toBe(docFingerprint(doc));

    const written = replicate(doc);
    setChangelogSuggestion(doc, null);
    expect(docFingerprint(written)).not.toBe(docFingerprint(doc));

    // Clearing returns the document to the one it was, rather than leaving a
    // residue a bridge would keep failing closed on.
    setChangelogSuggestion(doc, "");
    expect(docFingerprint(doc)).toBe(docFingerprint(unwritten));
  });

  it("changes when only the kind changes", () => {
    const doc = source();
    const copy = replicate(doc);
    setKind(doc, "requirement");
    expect(docFingerprint(copy)).not.toBe(docFingerprint(doc));
  });

  it("changes when only the status changes", () => {
    const doc = source();
    setKind(doc, "requirement");
    const copy = replicate(doc);
    setStatus(doc, "planned");
    expect(docFingerprint(copy)).not.toBe(docFingerprint(doc));
  });

  // The other direction, and the reason the hash reads `getMeta` rather than
  // the meta map: clearing writes the empty string where an untouched document
  // has no key at all. Both read back as no kind and no status, so a bridge
  // that fails closed must not call them different documents.
  it("is unmoved by a cleared kind and status the other side never set", () => {
    const doc = source();
    const copy = replicate(doc);
    setKind(doc, "requirement");
    setStatus(doc, "planned");
    setStatus(doc, "");
    setKind(doc, "");

    expect(getMeta(doc)).toEqual(getMeta(copy));
    expect(docFingerprint(doc)).toBe(docFingerprint(copy));
  });

  it("changes when a decision's own links or approval metadata change", () => {
    const doc = source();
    const copy = replicate(doc);
    doc.getMap("meta").set("kind", "decision");
    for (const [key, value] of Object.entries({
      governs: DECISION_A, topic: DECISION_B, supersedes: DECISION_C,
      agentStance: true, decidedBy: "A person", decidedAt: "2026-10-04T12:00:00Z",
    })) {
      const before = docFingerprint(doc);
      doc.getMap("meta").set(key, value);
      expect(docFingerprint(doc)).not.toBe(before);
    }
    expect(docFingerprint(doc)).not.toBe(docFingerprint(copy));
  });

});

describe("compareCorpus", () => {
  it("reports a formatting-only difference as differing, not identical", () => {
    const doc = source();
    const copy = replicate(doc);
    firstBlock(doc).text.format(0, 5, { bold: true });

    const diff = compareCorpus([entry(doc)], [entry(copy)]);
    expect(isIdentical(diff)).toBe(false);
    expect(diff.differing).toHaveLength(1);
  });

  it("finds a fully replicated corpus identical", () => {
    const doc = source();
    expect(isIdentical(compareCorpus([entry(doc)], [entry(replicate(doc))]))).toBe(
      true,
    );
  });

  it("counts a tombstone as something the far side holds", () => {
    // A hub holding only a tombstone has been used. It is not an empty hub, and
    // a promotion into it is not a promotion into a blank one.
    const diff = compareCorpus(
      [],
      [
        {
          uuid: UUID,
          title: "A note",
          tags: ["one"],
          deleted: true,
          fingerprint: null,
          stateVector: null,
        },
      ],
    );
    expect(diff.extra).toHaveLength(1);
    expect(isIdentical(diff)).toBe(false);
  });

  it("treats an archived document and a live one as different", () => {
    const doc = source();
    expect(
      compareCorpus([entry(doc)], [entry(doc, { deleted: true })]).differing,
    ).toHaveLength(1);
  });

  // For a tombstone the stub is the only metadata left — its room is never
  // opened and never moved, so nothing else can catch a stale title or tag.
  it("compares the directory stub of an archived document", () => {
    const archived = entry(source(), {
      deleted: true,
      fingerprint: null,
      stateVector: null,
    });
    expect(
      compareCorpus([archived], [{ ...archived, title: "Renamed" }]).differing,
    ).toHaveLength(1);
    expect(
      compareCorpus([archived], [{ ...archived, tags: ["other"] }]).differing,
    ).toHaveLength(1);
    expect(
      isIdentical(compareCorpus([archived], [{ ...archived, tags: ["one"] }])),
    ).toBe(true);
  });
});

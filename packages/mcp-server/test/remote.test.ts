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
  addDecision,
  appendBlock,
  createAnnotation,
  getDecisionsArray,
  getBlocks,
  getMeta,
  initDoc,
  listAnnotationRanges,
  listAnnotations,
  readDecisions,
  reorderDecisions,
  setDescription,
  setKind,
  setStatus,
  setTitle,
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
  it("is stable across replication", () => {
    const doc = source();
    expect(docFingerprint(replicate(doc))).toBe(docFingerprint(doc));
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

  it("changes when only the effective decision order changes", () => {
    const doc = source();
    addDecision(doc, DECISION_A);
    addDecision(doc, DECISION_B);
    addDecision(doc, DECISION_C);
    const concurrent = replicate(doc);

    reorderDecisions(doc, DECISION_C, 0);
    reorderDecisions(concurrent, DECISION_C, 1);
    Y.applyUpdate(doc, Y.encodeStateAsUpdate(concurrent));
    Y.applyUpdate(concurrent, Y.encodeStateAsUpdate(doc));

    const copy = replicate(doc);
    const decisions = getDecisionsArray(doc);
    const firstC = decisions.toArray().indexOf(DECISION_C);
    decisions.delete(firstC, 1);

    expect(readDecisions(doc)).not.toEqual(readDecisions(copy));
    expect(Y.encodeStateVector(doc)).toEqual(Y.encodeStateVector(copy));
    expect(docFingerprint(doc)).not.toBe(docFingerprint(copy));
    expect(isIdentical(compareCorpus([entry(doc)], [entry(copy)]))).toBe(false);
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

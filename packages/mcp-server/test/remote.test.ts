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

import { appendBlock, createAnnotation, initDoc, setTitle } from "@uberblick/schema";
import * as Y from "yjs";
import { describe, expect, it } from "vitest";
import { compareCorpus, docFingerprint, isIdentical } from "../src/remote.js";
import type { CorpusDoc } from "../src/remote.js";

const UUID = "3f0a3d4c-6f6c-4e5f-9b9a-1f2e3d4c5b6a";

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

  it("changes when only the title changes", () => {
    const doc = source();
    const copy = replicate(doc);
    setTitle(doc, "Another note");
    expect(docFingerprint(copy)).not.toBe(docFingerprint(doc));
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
});

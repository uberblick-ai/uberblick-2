import { describe, expect, it } from "vitest";
import * as Y from "yjs";
import {
  AnnotationRangeError,
  BlockNotFoundError,
  COMMENT_MARK,
  addComment,
  appendBlock,
  createAnnotation,
  deleteAnnotation,
  deleteBlock,
  editBlock,
  exportMarkdown,
  getAnnotation,
  getBlockText,
  getBlocksFragment,
  initDoc,
  listAnnotationRanges,
  listAnnotations,
  listAnnotationsForBlock,
  resolveAnnotationRange,
  setAnnotationResolved,
  setBlockType,
} from "../src/index.js";
import { replicaPair, syncDocs } from "./helpers.js";

const UUID = "55555555-5555-4555-8555-555555555555";
const SENTENCE = "Hello brave world";

function annotated(): { doc: Y.Doc; blockId: string; threadId: string } {
  const doc = new Y.Doc();
  initDoc(doc, { uuid: UUID, title: "Annotations" });
  const blockId = appendBlock(doc, { type: "paragraph", text: SENTENCE });
  // "brave" is at [6, 11).
  const thread = createAnnotation(doc, blockId, 6, 11, "reviewer", "Too much?");
  return { doc, blockId, threadId: thread.id };
}

/** The text a thread currently covers, or null when it is no longer anchored. */
function annotatedText(
  doc: Y.Doc,
  blockId: string,
  threadId: string,
): string | null {
  const range = resolveAnnotationRange(doc, threadId);
  if (range === null) return null;
  return getBlockText(doc, blockId).slice(range.start, range.end);
}

/** The raw formatting attributes Yjs holds, to prove the anchor is a mark. */
function deltaOf(doc: Y.Doc, blockId: string): Array<[string, unknown]> {
  const element = getBlocksFragment(doc).toArray().find((child) => {
    return child instanceof Y.XmlElement && child.getAttribute("id") === blockId;
  }) as Y.XmlElement;
  const text = element.firstChild as Y.XmlText;
  return (
    text.toDelta() as Array<{ insert: string; attributes?: unknown }>
  ).map((op) => [op.insert, op.attributes ?? null]);
}

describe("annotations", () => {
  it("anchors the range as a comment mark on the block's text", () => {
    const { doc, blockId, threadId } = annotated();

    // The thread JSON carries no positions at all — the range is in the text.
    expect(getAnnotation(doc, threadId)).toEqual({
      id: threadId,
      blockId,
      comments: [
        {
          author: "reviewer",
          text: "Too much?",
          createdAt: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/) as unknown as string,
        },
      ],
    });

    expect(deltaOf(doc, blockId)).toEqual([
      ["Hello ", null],
      ["brave", { [COMMENT_MARK]: { threadId } }],
      [" world", null],
    ]);
    expect(resolveAnnotationRange(doc, threadId)).toEqual({
      start: 6,
      end: 11,
      collapsed: false,
    });
    expect(annotatedText(doc, blockId, threadId)).toBe("brave");
  });

  it("shifts with the text when characters before it change", () => {
    const { doc, blockId, threadId } = annotated();

    editBlock(doc, blockId, SENTENCE, `Say: ${SENTENCE}`);
    expect(resolveAnnotationRange(doc, threadId)).toEqual({
      start: 11,
      end: 16,
      collapsed: false,
    });
    expect(annotatedText(doc, blockId, threadId)).toBe("brave");

    editBlock(doc, blockId, `Say: ${SENTENCE}`, SENTENCE);
    expect(annotatedText(doc, blockId, threadId)).toBe("brave");
  });

  it("stays put when text after it changes", () => {
    const { doc, blockId, threadId } = annotated();
    editBlock(doc, blockId, SENTENCE, "Hello brave new world");
    expect(resolveAnnotationRange(doc, threadId)).toEqual({
      start: 6,
      end: 11,
      collapsed: false,
    });
    expect(annotatedText(doc, blockId, threadId)).toBe("brave");
  });

  it("grows with text inserted strictly inside", () => {
    const { doc, blockId, threadId } = annotated();
    editBlock(doc, blockId, SENTENCE, "Hello braXve world");
    expect(annotatedText(doc, blockId, threadId)).toBe("braXve");
  });

  it("takes in text typed at its end boundary but not at its start boundary", () => {
    // Documented mark semantics: a Yjs insert inherits the formatting to its
    // left, so an annotated span is start-exclusive and end-inclusive. This is
    // the behaviour a comment mark has in ProseMirror too.
    const atEnd = annotated();
    editBlock(atEnd.doc, atEnd.blockId, SENTENCE, "Hello braveE world");
    expect(annotatedText(atEnd.doc, atEnd.blockId, atEnd.threadId)).toBe(
      "braveE",
    );

    const atStart = annotated();
    editBlock(atStart.doc, atStart.blockId, SENTENCE, "Hello Sbrave world");
    expect(annotatedText(atStart.doc, atStart.blockId, atStart.threadId)).toBe(
      "brave",
    );
  });

  it("shrinks when part of the annotated text is deleted", () => {
    const { doc, blockId, threadId } = annotated();
    editBlock(doc, blockId, SENTENCE, "Hello be world");
    expect(annotatedText(doc, blockId, threadId)).toBe("be");
  });

  it("resolves to null once every annotated character is deleted, keeping the thread", () => {
    const { doc, blockId, threadId } = annotated();

    editBlock(doc, blockId, SENTENCE, "Hello world");

    // A mark cannot mark nothing: deleting the whole span removes the anchor,
    // so the range is gone rather than collapsed (the round-1 relative-position
    // model collapsed to a point here). The conversation is never
    // cascade-deleted with it — the thread JSON stays readable and listable.
    expect(resolveAnnotationRange(doc, threadId)).toBeNull();
    expect(annotatedText(doc, blockId, threadId)).toBeNull();
    expect(getAnnotation(doc, threadId)?.comments).toHaveLength(1);
    expect(listAnnotations(doc)).toHaveLength(1);
    expect(listAnnotationRanges(doc, blockId)).toEqual([]);
  });

  it("resolves to null when the anchoring block is deleted, keeping the thread", () => {
    const { doc, blockId, threadId } = annotated();
    deleteBlock(doc, blockId);
    expect(getAnnotation(doc, threadId)).not.toBeNull();
    expect(resolveAnnotationRange(doc, threadId)).toBeNull();
  });

  it("resolves to null for an unknown thread id", () => {
    const { doc } = annotated();
    expect(resolveAnnotationRange(doc, "not-a-thread")).toBeNull();
  });

  it("survives a block re-type, marks and all", () => {
    const { doc, blockId, threadId } = annotated();

    setBlockType(doc, blockId, "heading", { level: 2 });

    expect(deltaOf(doc, blockId)).toEqual([
      ["Hello ", null],
      ["brave", { [COMMENT_MARK]: { threadId } }],
      [" world", null],
    ]);
    expect(annotatedText(doc, blockId, threadId)).toBe("brave");
    // …and still tracks edits after the re-type.
    editBlock(doc, blockId, SENTENCE, `Say: ${SENTENCE}`);
    expect(annotatedText(doc, blockId, threadId)).toBe("brave");
  });

  it("clamps out-of-range and reversed indices", () => {
    const doc = new Y.Doc();
    initDoc(doc, { uuid: UUID, title: "Annotations" });
    const blockId = appendBlock(doc, { type: "paragraph", text: "short" });
    const wide = createAnnotation(doc, blockId, -5, 500, "a", "whole block");
    expect(resolveAnnotationRange(doc, wide.id)).toEqual({
      start: 0,
      end: 5,
      collapsed: false,
    });

    const other = appendBlock(doc, { type: "paragraph", text: "second" });
    const reversed = createAnnotation(doc, other, 4, 1, "a", "backwards");
    expect(resolveAnnotationRange(doc, reversed.id)).toEqual({
      start: 1,
      end: 4,
      collapsed: false,
    });
  });

  it("rejects an empty range", () => {
    const { doc, blockId } = annotated();
    let caught: unknown;
    try {
      createAnnotation(doc, blockId, 3, 3, "a", "nothing to point at");
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(AnnotationRangeError);
    expect((caught as AnnotationRangeError).reason).toBe("empty");
    // An out-of-text range clamps to empty and is refused the same way.
    expect(() => createAnnotation(doc, blockId, 99, 120, "a", "past end")).toThrow(
      AnnotationRangeError,
    );
  });

  it("rejects a range that overlaps another thread, naming the conflict", () => {
    const { doc, blockId, threadId } = annotated();

    let caught: unknown;
    try {
      // Overlaps "brave" by one character.
      createAnnotation(doc, blockId, 10, 16, "second", "me too");
    } catch (error) {
      caught = error;
    }

    // Marks cannot nest: a second thread over the same characters would steal
    // them from the first, so the write is refused instead.
    expect(caught).toBeInstanceOf(AnnotationRangeError);
    const error = caught as AnnotationRangeError;
    expect(error.reason).toBe("overlap");
    expect(error.conflictingThreadId).toBe(threadId);
    expect(listAnnotations(doc)).toHaveLength(1);

    // Adjacent, non-overlapping ranges are fine, including one that starts
    // exactly where the other ends.
    const after = createAnnotation(doc, blockId, 11, 17, "second", "the world");
    expect(annotatedText(doc, blockId, after.id)).toBe(" world");
    expect(annotatedText(doc, blockId, threadId)).toBe("brave");
    expect(listAnnotationRanges(doc, blockId)).toEqual([
      { threadId, start: 6, end: 11 },
      { threadId: after.id, start: 11, end: 17 },
    ]);
  });

  it("rejects annotations on unknown blocks", () => {
    const { doc } = annotated();
    expect(() => createAnnotation(doc, "nope", 0, 1, "a", "b")).toThrow(
      BlockNotFoundError,
    );
  });

  it("appends comments and resolves threads without touching the mark", () => {
    const { doc, blockId, threadId } = annotated();
    expect(addComment(doc, threadId, "author", "Fixed.")?.comments).toHaveLength(
      2,
    );
    expect(setAnnotationResolved(doc, threadId, true)?.resolved).toBe(true);
    expect(getAnnotation(doc, threadId)?.comments).toHaveLength(2);
    expect(listAnnotationsForBlock(doc, blockId)).toHaveLength(1);
    // A resolved thread stays anchored so the editor can still show it in place.
    expect(annotatedText(doc, blockId, threadId)).toBe("brave");
    expect(addComment(doc, "unknown", "a", "b")).toBeNull();
    expect(setAnnotationResolved(doc, "unknown", true)).toBeNull();
  });

  it("clears the mark when the thread is deleted", () => {
    const { doc, blockId, threadId } = annotated();

    expect(deleteAnnotation(doc, threadId)).toBe(true);
    expect(deleteAnnotation(doc, threadId)).toBe(false);
    expect(listAnnotations(doc)).toEqual([]);
    expect(listAnnotationRanges(doc, blockId)).toEqual([]);
    expect(deltaOf(doc, blockId)).toEqual([[SENTENCE, null]]);
    expect(getBlockText(doc, blockId)).toBe(SENTENCE);

    // The freed range can be annotated again.
    const again = createAnnotation(doc, blockId, 6, 11, "reviewer", "again");
    expect(annotatedText(doc, blockId, again.id)).toBe("brave");
  });

  it("tracks the range through a concurrent edit from another replica", () => {
    let blockId = "";
    const [a, b] = replicaPair((doc) => {
      initDoc(doc, { uuid: UUID, title: "Annotations" });
      blockId = appendBlock(doc, { type: "paragraph", text: SENTENCE });
    });

    // A annotates while B, unaware, both prepends text and edits inside the
    // range that is about to be annotated.
    const thread = createAnnotation(a, blockId, 6, 11, "reviewer", "Too much?");
    editBlock(b, blockId, SENTENCE, "Say: Hello braZZve world");
    syncDocs(a, b);

    expect(getBlockText(a, blockId)).toBe("Say: Hello braZZve world");
    expect(getBlockText(b, blockId)).toBe(getBlockText(a, blockId));
    // The concurrently inserted characters land inside the annotated span, and
    // both replicas agree on where the span is.
    expect(annotatedText(a, blockId, thread.id)).toBe("braZZve");
    expect(annotatedText(b, blockId, thread.id)).toBe("braZZve");
    expect(resolveAnnotationRange(a, thread.id)).toEqual(
      resolveAnnotationRange(b, thread.id),
    );
  });

  it("converges when two replicas annotate different ranges of one block", () => {
    let blockId = "";
    const [a, b] = replicaPair((doc) => {
      initDoc(doc, { uuid: UUID, title: "Annotations" });
      blockId = appendBlock(doc, { type: "paragraph", text: SENTENCE });
    });

    const fromA = createAnnotation(a, blockId, 0, 5, "a", "greeting");
    const fromB = createAnnotation(b, blockId, 12, 17, "b", "place");
    syncDocs(a, b);

    expect(listAnnotationRanges(a, blockId)).toEqual([
      { threadId: fromA.id, start: 0, end: 5 },
      { threadId: fromB.id, start: 12, end: 17 },
    ]);
    expect(listAnnotationRanges(b, blockId)).toEqual(
      listAnnotationRanges(a, blockId),
    );
    expect(listAnnotations(a)).toEqual(listAnnotations(b));
  });

  it("keeps both threads readable when two replicas annotate the SAME range", () => {
    let blockId = "";
    const [a, b] = replicaPair((doc) => {
      initDoc(doc, { uuid: UUID, title: "Annotations" });
      blockId = appendBlock(doc, { type: "paragraph", text: SENTENCE });
    });

    // Neither replica can see the other's mark yet, so neither can refuse the
    // overlap: this is the one case the overlap check cannot catch.
    const fromA = createAnnotation(a, blockId, 6, 11, "a", "first");
    const fromB = createAnnotation(b, blockId, 6, 11, "b", "second");
    syncDocs(a, b);

    // Documented outcome: the mark is one value per character, so exactly one
    // thread keeps the anchor (Yjs picks deterministically) and the other
    // resolves to null — but both conversations survive as JSON, on both
    // replicas, which is what stops a comment from being silently destroyed.
    const winners = [fromA.id, fromB.id].filter(
      (id) => resolveAnnotationRange(a, id) !== null,
    );
    expect(winners).toHaveLength(1);
    expect(listAnnotations(a)).toHaveLength(2);
    expect(listAnnotations(b)).toEqual(listAnnotations(a));
    expect(listAnnotationRanges(b, blockId)).toEqual(
      listAnnotationRanges(a, blockId),
    );
    expect(resolveAnnotationRange(b, winners[0] as string)).toEqual(
      resolveAnnotationRange(a, winners[0] as string),
    );
  });

  it("exports annotations as adjacent HTML comments, or drops them", () => {
    const { doc, threadId } = annotated();
    setAnnotationResolved(doc, threadId, true);

    expect(exportMarkdown(doc, { frontmatter: false })).toBe(
      "Hello brave world\n",
    );
    expect(
      exportMarkdown(doc, { frontmatter: false, annotations: "html-comments" }),
    ).toBe(
      [
        "Hello brave world",
        "",
        `<!-- annotation ${threadId} range=6-11 resolved reviewer: "Too much?" -->`,
        "",
      ].join("\n"),
    );
  });

  it("omits unanchored threads from the markdown export", () => {
    const { doc, blockId } = annotated();
    appendBlock(doc, { type: "paragraph", text: "still here" });
    deleteBlock(doc, blockId);
    expect(
      exportMarkdown(doc, { frontmatter: false, annotations: "html-comments" }),
    ).toBe("still here\n");
  });
});

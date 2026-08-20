import { describe, expect, it } from "vitest";
import * as Y from "yjs";
import {
  BlockNotFoundError,
  addComment,
  appendBlock,
  createAnnotation,
  deleteAnnotation,
  deleteBlock,
  editBlock,
  exportMarkdown,
  getAnnotation,
  getBlockText,
  initDoc,
  listAnnotations,
  listAnnotationsForBlock,
  resolveAnnotationRange,
  setAnnotationResolved,
} from "../src/index.js";
import { replicaPair, syncDocs } from "./helpers.js";

const UUID = "55555555-5555-4555-8555-555555555555";
const SENTENCE = "Hello brave world";

function annotated(): {
  doc: Y.Doc;
  blockId: string;
  threadId: string;
} {
  const doc = new Y.Doc();
  initDoc(doc, { uuid: UUID, title: "Annotations" });
  const blockId = appendBlock(doc, { type: "paragraph", text: SENTENCE });
  // "brave" is at [6, 11).
  const thread = createAnnotation(doc, blockId, 6, 11, "reviewer", "Too much?");
  return { doc, blockId, threadId: thread.id };
}

function annotatedText(doc: Y.Doc, blockId: string, threadId: string): string | null {
  const range = resolveAnnotationRange(doc, threadId);
  if (range === null) return null;
  return getBlockText(doc, blockId).slice(range.start, range.end);
}

describe("annotations", () => {
  it("stores a thread with encoded relative positions and one comment", () => {
    const { doc, blockId, threadId } = annotated();
    const annotation = getAnnotation(doc, threadId);
    expect(annotation).not.toBeNull();
    expect(annotation?.blockId).toBe(blockId);
    expect(annotation?.comments).toHaveLength(1);
    expect(annotation?.comments[0]?.author).toBe("reviewer");
    expect(annotation?.comments[0]?.text).toBe("Too much?");
    expect(annotation?.comments[0]?.createdAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    // Anchors are opaque base64, not offsets.
    expect(annotation?.anchor).toMatch(/^[A-Za-z0-9+/]+=*$/);
    expect(annotation?.anchor).not.toBe(annotation?.head);

    expect(resolveAnnotationRange(doc, threadId)).toEqual({
      start: 6,
      end: 11,
      collapsed: false,
    });
    expect(annotatedText(doc, blockId, threadId)).toBe("brave");
  });

  it("shifts the resolved range when text before the anchor changes", () => {
    const { doc, blockId, threadId } = annotated();

    editBlock(doc, blockId, SENTENCE, `Say: ${SENTENCE}`);
    expect(resolveAnnotationRange(doc, threadId)).toEqual({
      start: 11,
      end: 16,
      collapsed: false,
    });
    expect(annotatedText(doc, blockId, threadId)).toBe("brave");

    // Deleting text before the anchor shifts it back.
    editBlock(doc, blockId, `Say: ${SENTENCE}`, SENTENCE);
    expect(annotatedText(doc, blockId, threadId)).toBe("brave");
  });

  it("leaves the range alone when text after it changes", () => {
    const { doc, blockId, threadId } = annotated();
    editBlock(doc, blockId, SENTENCE, "Hello brave new world");
    expect(resolveAnnotationRange(doc, threadId)).toEqual({
      start: 6,
      end: 11,
      collapsed: false,
    });
    expect(annotatedText(doc, blockId, threadId)).toBe("brave");
  });

  it("grows with text typed strictly inside and ignores text typed at the boundaries", () => {
    const { doc, blockId, threadId } = annotated();
    editBlock(doc, blockId, SENTENCE, "Hello braXve world");
    expect(annotatedText(doc, blockId, threadId)).toBe("braXve");

    // A boundary insertion (right at the end of the range) stays outside it:
    // the head is left-associated by design.
    editBlock(doc, blockId, "Hello braXve world", "Hello braXveZ world");
    expect(annotatedText(doc, blockId, threadId)).toBe("braXve");
  });

  it("collapses to a point when the annotated text is deleted", () => {
    const { doc, blockId, threadId } = annotated();

    editBlock(doc, blockId, SENTENCE, "Hello world");

    // Documented behaviour: the thread is not lost when its text is deleted —
    // it collapses to the point where the text used to be, so the UI can still
    // show it and a caller can still resolve or delete it.
    const range = resolveAnnotationRange(doc, threadId);
    expect(range).toEqual({ start: 6, end: 6, collapsed: true });
    expect(annotatedText(doc, blockId, threadId)).toBe("");
    expect(getBlockText(doc, blockId)).toBe("Hello world");
  });

  it("resolves to null when the anchoring block is deleted", () => {
    const { doc, blockId, threadId } = annotated();
    deleteBlock(doc, blockId);
    // The thread JSON survives (it is independent data), but it no longer
    // points anywhere.
    expect(getAnnotation(doc, threadId)).not.toBeNull();
    expect(resolveAnnotationRange(doc, threadId)).toBeNull();
  });

  it("resolves to null for an unknown thread id", () => {
    const { doc } = annotated();
    expect(resolveAnnotationRange(doc, "not-a-thread")).toBeNull();
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
    const reversed = createAnnotation(doc, blockId, 4, 1, "a", "backwards");
    expect(resolveAnnotationRange(doc, reversed.id)).toEqual({
      start: 1,
      end: 4,
      collapsed: false,
    });
  });

  it("rejects annotations on unknown blocks", () => {
    const { doc } = annotated();
    expect(() => createAnnotation(doc, "nope", 0, 1, "a", "b")).toThrow(
      BlockNotFoundError,
    );
  });

  it("appends comments, resolves threads and deletes them", () => {
    const { doc, blockId, threadId } = annotated();
    expect(addComment(doc, threadId, "author", "Fixed.")?.comments).toHaveLength(
      2,
    );
    expect(setAnnotationResolved(doc, threadId, true)?.resolved).toBe(true);
    expect(getAnnotation(doc, threadId)?.comments).toHaveLength(2);
    expect(listAnnotationsForBlock(doc, blockId)).toHaveLength(1);
    expect(addComment(doc, "unknown", "a", "b")).toBeNull();
    expect(setAnnotationResolved(doc, "unknown", true)).toBeNull();

    expect(deleteAnnotation(doc, threadId)).toBe(true);
    expect(deleteAnnotation(doc, threadId)).toBe(false);
    expect(listAnnotations(doc)).toEqual([]);
  });

  it("tracks the range through a concurrent edit from another replica", () => {
    let blockId = "";
    const [a, b] = replicaPair((doc) => {
      initDoc(doc, { uuid: UUID, title: "Annotations" });
      blockId = appendBlock(doc, { type: "paragraph", text: SENTENCE });
    });

    const thread = createAnnotation(a, blockId, 6, 11, "reviewer", "Too much?");
    // B prepends text without knowing about the annotation.
    editBlock(b, blockId, SENTENCE, `Say: ${SENTENCE}`);
    syncDocs(a, b);

    expect(getBlockText(a, blockId)).toBe("Say: Hello brave world");
    expect(annotatedText(a, blockId, thread.id)).toBe("brave");
    expect(annotatedText(b, blockId, thread.id)).toBe("brave");
    expect(resolveAnnotationRange(a, thread.id)).toEqual(
      resolveAnnotationRange(b, thread.id),
    );
  });

  it("exports annotations as adjacent HTML comments, or drops them", () => {
    const { doc, threadId } = annotated();
    setAnnotationResolved(doc, threadId, true);

    const dropped = exportMarkdown(doc, { frontmatter: false });
    expect(dropped).toBe("Hello brave world\n");

    const withComments = exportMarkdown(doc, {
      frontmatter: false,
      annotations: "html-comments",
    });
    expect(withComments).toBe(
      [
        "Hello brave world",
        "",
        `<!-- annotation ${threadId} range=6-11 resolved reviewer: "Too much?" -->`,
        "",
      ].join("\n"),
    );
  });

  it("omits annotations whose block is gone from the markdown export", () => {
    const { doc, blockId } = annotated();
    appendBlock(doc, { type: "paragraph", text: "still here" });
    deleteBlock(doc, blockId);
    expect(
      exportMarkdown(doc, { frontmatter: false, annotations: "html-comments" }),
    ).toBe("still here\n");
  });
});

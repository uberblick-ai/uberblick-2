import { describe, expect, it, vi } from "vitest";
import * as Y from "yjs";
import {
  CARD_PARTS, COMMENT_MARK, addComment, annotationAnchors, appendBlock,
  cardPartTexts, createAnnotation, deleteComment, documentDirectoryFields,
  editComment, exportMarkdown, figmaCaptionTexts, findBlockElement,
  getAnnotation, getAnnotationCommentId, getAnnotationCommentIds,
  getAnnotationsMap, getBlocksFragment, getCommentDeleteEligibility, initDoc,
  listAnnotationRanges, listAnnotations, moveAnnotation, resolveAnnotationRange,
  setAnnotationResolved, tableCellTexts, tableRows,
  type CommentDeleteRefusal,
} from "../src/index.js";
import { syncDocs } from "./helpers.js";

const UUID = "55555555-5555-4555-8555-555555555555";

function fixture() {
  const doc = new Y.Doc();
  initDoc(doc, { uuid: UUID, title: "Comment deletion" });
  const blockId = appendBlock(doc, { type: "paragraph", text: "Hello brave world" });
  const threadId = createAnnotation(doc, blockId, 6, 11, "Display name", "Opening", undefined,
    { kind: "agent", account: "Octocat", agent: "codex" }).id;
  const openingId = getAnnotationCommentId(doc, threadId, 0)!;
  return { doc, blockId, threadId, openingId };
}

function clone(doc: Y.Doc) {
  const peer = new Y.Doc();
  Y.applyUpdate(peer, Y.encodeStateAsUpdate(doc));
  return peer;
}

function storedRows(doc: Y.Doc, threadId: string): Y.Array<unknown> {
  return (getAnnotationsMap(doc).get(threadId) as Y.Map<unknown>).get("comments") as Y.Array<unknown>;
}

describe("comment deletion", () => {
  it("deletes an account's agent reply by stable id without changing its siblings or mark", () => {
    const { doc, blockId, threadId } = fixture();
    addComment(doc, threadId, "Another person", "Keep this", { kind: "person", account: "someone" });
    addComment(doc, threadId, "Agent", "Remove this", { kind: "agent", account: "OCTOCAT", agent: "claude" });
    addComment(doc, threadId, "Agent", "Keep that", { kind: "agent", account: "Octocat", agent: "codex" });
    const before = getAnnotation(doc, threadId)!;
    const ids = getAnnotationCommentIds(doc, threadId);
    const marks = listAnnotationRanges(doc, blockId);
    const updates = vi.fn();
    doc.on("update", updates);

    expect(deleteComment(doc, threadId, ids[2]!, "octocat")).toEqual({
      ok: true, removed: "comment", replyCount: 3,
      annotation: { ...before, comments: before.comments.filter((_, index) => index !== 2) },
    });
    expect(updates).toHaveBeenCalledTimes(1);
    expect(getAnnotationCommentIds(doc, threadId)).toEqual([ids[0], ids[1], ids[3]]);
    expect(listAnnotationRanges(doc, blockId)).toEqual(marks);
    expect(documentDirectoryFields(doc).openThreadCount).toBe(1);
    expect(exportMarkdown(doc, { frontmatter: false, annotations: "html-comments" })).not.toContain("Remove this");
    expect(deleteComment(doc, threadId, ids[3]!, "Octocat").ok).toBe(true);
    expect(getAnnotationCommentIds(doc, threadId)).toEqual([ids[0], ids[1]]);
    doc.destroy();
  });

  it.each([0, 2])("deletes an opening comment and its %i own replies in one update", (replies) => {
    const { doc, threadId, openingId, blockId } = fixture();
    for (let index = 0; index < replies; index++) addComment(doc, threadId, "Agent", "My reply", { kind: "agent", account: "oCTOcat" });
    const beforeEligibility = Y.encodeStateAsUpdate(doc);
    expect(getCommentDeleteEligibility(doc, threadId, openingId, "octocat")).toEqual({
      ok: true, removed: "thread", replyCount: replies,
    });
    expect(Y.encodeStateAsUpdate(doc)).toEqual(beforeEligibility);
    const updates = vi.fn();
    doc.on("update", updates);

    expect(deleteComment(doc, threadId, openingId, "octocat")).toEqual({
      ok: true, removed: "thread", replyCount: replies,
    });
    expect(updates).toHaveBeenCalledTimes(1);
    expect(getAnnotation(doc, threadId)).toBeNull();
    expect(listAnnotations(doc)).toEqual([]);
    expect(listAnnotationRanges(doc, blockId)).toEqual([]);
    expect(resolveAnnotationRange(doc, threadId)).toBeNull();
    expect(documentDirectoryFields(doc).openThreadCount).toBe(0);
    expect(exportMarkdown(doc, { frontmatter: false, annotations: "html-comments" })).toBe("Hello brave world\n");
    doc.destroy();
  });

  const refusals: CommentDeleteRefusal[] = [
    "thread_not_found", "comment_not_found", "thread_resolved", "account_required",
    "comment_account_missing", "comment_not_owned", "reply_account_missing", "reply_not_owned",
  ];
  it.each(refusals)("reports %s and makes no write", (reason) => {
    const { doc, threadId, openingId } = fixture();
    let addressedThread = threadId;
    let addressedComment = openingId;
    let account: string | undefined = "Octocat";
    if (reason === "thread_not_found") addressedThread = "gone";
    if (reason === "comment_not_found") addressedComment = "999:999";
    if (reason === "thread_resolved") setAnnotationResolved(doc, threadId, true);
    if (reason === "account_required") account = undefined;
    if (reason === "comment_not_owned") account = "someone";
    if (reason === "comment_account_missing") {
      addComment(doc, threadId, "Legacy", "No account");
      addressedComment = getAnnotationCommentId(doc, threadId, 1)!;
    }
    if (reason === "reply_account_missing") addComment(doc, threadId, "Legacy", "No account");
    if (reason === "reply_not_owned") addComment(doc, threadId, "Another person", "Their reply", { kind: "person", account: "someone" });
    const before = Y.encodeStateAsUpdate(doc);
    const updates = vi.fn();
    doc.on("update", updates);

    expect(getCommentDeleteEligibility(doc, addressedThread, addressedComment, account)).toEqual({ ok: false, reason });
    expect(deleteComment(doc, addressedThread, addressedComment, account)).toEqual({ ok: false, reason });
    expect(updates).not.toHaveBeenCalled();
    expect(Y.encodeStateAsUpdate(doc)).toEqual(before);
    doc.destroy();
  });

  it("rechecks ownership and existence when the writer runs", () => {
    const { doc, threadId, openingId } = fixture();
    expect(getCommentDeleteEligibility(doc, threadId, openingId, "Octocat").ok).toBe(true);
    addComment(doc, threadId, "Someone else", "Keep my contribution", { kind: "person", account: "someone" });
    const before = Y.encodeStateAsUpdate(doc);
    expect(deleteComment(doc, threadId, openingId, "Octocat")).toEqual({ ok: false, reason: "reply_not_owned" });
    expect(Y.encodeStateAsUpdate(doc)).toEqual(before);
    const reply = getAnnotationCommentId(doc, threadId, 1)!;
    deleteComment(doc, threadId, reply, "someone");
    expect(deleteComment(doc, threadId, reply, "someone")).toEqual({ ok: false, reason: "comment_not_found" });
    deleteComment(doc, threadId, openingId, "Octocat");
    expect(deleteComment(doc, threadId, openingId, "Octocat")).toEqual({ ok: false, reason: "thread_not_found" });
    doc.destroy();
  });

  it("removes every stored replacement row left by concurrent edits", () => {
    const { doc, threadId } = fixture();
    addComment(doc, threadId, "Agent", "Reply", { kind: "agent", account: "Octocat" });
    const replyId = getAnnotationCommentId(doc, threadId, 1)!;
    const peer = clone(doc);
    editComment(doc, threadId, replyId, "Octocat", "First edit");
    editComment(peer, threadId, replyId, "octocat", "Second edit");
    syncDocs(doc, peer);
    expect(storedRows(doc, threadId).length).toBe(3);
    expect(getAnnotationCommentIds(doc, threadId)).toHaveLength(2);

    deleteComment(doc, threadId, replyId, "octocat");
    syncDocs(doc, peer);
    expect(storedRows(doc, threadId).length).toBe(1);
    expect(getAnnotationCommentIds(peer, threadId)).toHaveLength(1);
    doc.destroy();
    peer.destroy();
  });

  it("clears marks in prose, every card part, table cells, Figma captions and shadowed blocks", () => {
    const { doc, blockId, threadId, openingId } = fixture();
    const tableId = appendBlock(doc, { type: "table", text: "| H |\n| --- |\n| Cell |" });
    const cardId = appendBlock(doc, { type: "card", text: "label: Label\ntitle: Title\nfooter: Footer\n\nBody" });
    const figmaId = appendBlock(doc, { type: "figma", text: "url: https://www.figma.com/design/Abc123/File\n\nCaption" });
    const table = findBlockElement(doc, tableId)!;
    const card = findBlockElement(doc, cardId)!;
    const figma = findBlockElement(doc, figmaId)!;
    const texts = [
      ...tableRows(table).flatMap((row) => row.flatMap((cell) => tableCellTexts(cell))),
      ...CARD_PARTS.flatMap((part) => cardPartTexts(card, part)),
      ...figmaCaptionTexts(figma),
    ];
    for (const text of texts) text.format(0, text.length, { [COMMENT_MARK]: { threadId } });
    const shadow = findBlockElement(doc, blockId)!.clone();
    getBlocksFragment(doc).insert(getBlocksFragment(doc).length, [shadow]);
    const other = createAnnotation(doc, blockId, 12, 17, "Other", "Keep this", undefined, { kind: "person", account: "other" });
    const updates = vi.fn();
    doc.on("update", updates);

    deleteComment(doc, threadId, openingId, "Octocat");

    expect(updates).toHaveBeenCalledTimes(1);
    expect(annotationAnchors(doc)).toEqual(new Map([[other.id, "world"]]));
    for (const id of [tableId, cardId, figmaId]) expect(listAnnotationRanges(doc, id)).toEqual([]);
    for (const text of [...texts, shadow.firstChild as Y.XmlText]) {
      expect((text.toDelta() as Array<{ attributes?: Record<string, unknown> }>).every((op) => op.attributes?.[COMMENT_MARK] === undefined)).toBe(true);
    }
    doc.destroy();
  });

  it("allows a new comment over marks restored by editor undo after thread deletion", () => {
    const { doc, blockId, threadId, openingId } = fixture();
    const text = findBlockElement(doc, blockId)!.firstChild as Y.XmlText;
    const undo = new Y.UndoManager(text);
    text.delete(6, 5);
    undo.stopCapturing();
    deleteComment(doc, threadId, openingId, "Octocat");
    undo.undo();
    expect(text.toDelta().map((op: { insert: string }) => op.insert).join("")).toBe("Hello brave world");
    expect(listAnnotationRanges(doc, blockId)).toEqual([{ threadId, start: 6, end: 11 }]);
    expect(getAnnotation(doc, threadId)).toBeNull();
    expect(resolveAnnotationRange(doc, threadId)).toBeNull();
    const next = createAnnotation(doc, blockId, 6, 11, "Person", "New question");
    expect(resolveAnnotationRange(doc, next.id)).toEqual({ start: 6, end: 11, collapsed: false });
    undo.destroy();
    doc.destroy();
  });
});

describe("comment deletion convergence", () => {
  it.each(["reply", "resolve", "move"] as const)("thread removal wins over concurrent %s in both delivery orders", (write) => {
    const seed = fixture();
    const target = appendBlock(seed.doc, { type: "paragraph", text: "Another anchor" });
    const baseline = Y.encodeStateAsUpdate(seed.doc);
    const a = clone(seed.doc);
    const b = clone(seed.doc);
    const vector = Y.encodeStateVector(seed.doc);
    deleteComment(a, seed.threadId, seed.openingId, "Octocat");
    if (write === "reply") addComment(b, seed.threadId, "Someone else", "Concurrent reply", { kind: "person", account: "someone" });
    if (write === "resolve") setAnnotationResolved(b, seed.threadId, true);
    if (write === "move") moveAnnotation(b, seed.threadId, target, 0, 7, "Someone else", "Moved", undefined, { kind: "person", account: "someone" });
    const x = Y.encodeStateAsUpdate(a, vector);
    const y = Y.encodeStateAsUpdate(b, vector);
    const verify = (doc: Y.Doc) => {
      expect(getAnnotation(doc, seed.threadId)).toBeNull();
      expect(listAnnotations(doc)).toEqual([]);
      expect(resolveAnnotationRange(doc, seed.threadId)).toBeNull();
      expect(documentDirectoryFields(doc).openThreadCount).toBe(0);
      expect(exportMarkdown(doc, { frontmatter: false, annotations: "html-comments" })).not.toContain("annotation");
    };
    for (const updates of [[x, y], [y, x]]) {
      const reader = new Y.Doc();
      Y.applyUpdate(reader, baseline);
      for (const update of updates) Y.applyUpdate(reader, update);
      verify(reader);
      if (write === "move") {
        const next = createAnnotation(reader, target, 0, 7, "Person", "Fresh");
        expect(resolveAnnotationRange(reader, next.id)).not.toBeNull();
      }
      reader.destroy();
    }
    Y.applyUpdate(a, y);
    Y.applyUpdate(b, x);
    verify(a);
    verify(b);
    a.destroy();
    b.destroy();
    seed.doc.destroy();
  });

  it("deletes only the addressed reply while concurrent replies keep their converged order", () => {
    const { doc, threadId } = fixture();
    addComment(doc, threadId, "Agent", "Target", { kind: "agent", account: "Octocat" });
    addComment(doc, threadId, "Other", "Existing sibling", { kind: "person", account: "someone" });
    const target = getAnnotationCommentId(doc, threadId, 1)!;
    const peer = clone(doc);
    deleteComment(doc, threadId, target, "Octocat");
    addComment(doc, threadId, "Agent", "Concurrent A", { kind: "agent", account: "Octocat" });
    addComment(peer, threadId, "Other", "Concurrent B", { kind: "person", account: "someone" });
    syncDocs(doc, peer);

    const texts = getAnnotation(doc, threadId)!.comments.map((comment) => comment.text);
    expect(texts.slice(0, 2)).toEqual(["Opening", "Existing sibling"]);
    expect(texts.slice(2)).toEqual(expect.arrayContaining(["Concurrent A", "Concurrent B"]));
    expect(texts).toHaveLength(4);
    expect(getAnnotation(peer, threadId)).toEqual(getAnnotation(doc, threadId));
    expect(getAnnotationCommentIds(peer, threadId)).toEqual(getAnnotationCommentIds(doc, threadId));
    doc.destroy();
    peer.destroy();
  });

  it("retains a concurrent same-author edit, which the author can delete again", () => {
    const { doc, threadId } = fixture();
    addComment(doc, threadId, "Agent", "Target", { kind: "agent", account: "Octocat" });
    const target = getAnnotationCommentId(doc, threadId, 1)!;
    const peer = clone(doc);
    deleteComment(doc, threadId, target, "Octocat");
    editComment(peer, threadId, target, "octocat", "Edited concurrently");
    syncDocs(doc, peer);
    expect(getAnnotation(doc, threadId)?.comments.map((comment) => comment.text)).toEqual(["Opening", "Edited concurrently"]);
    expect(getAnnotation(peer, threadId)).toEqual(getAnnotation(doc, threadId));
    expect(getAnnotationCommentId(doc, threadId, 1)).toBe(target);
    expect(deleteComment(doc, threadId, target, "Octocat").ok).toBe(true);
    syncDocs(doc, peer);
    expect(getAnnotation(peer, threadId)?.comments).toHaveLength(1);
    doc.destroy();
    peer.destroy();
  });
});

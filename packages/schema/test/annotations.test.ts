import { describe, expect, it, vi } from "vitest";
import * as Y from "yjs";
import {
  AnnotationRangeError,
  BlockNotFoundError,
  COMMENT_MARK,
  addComment,
  annotationAnchors,
  appendBlock,
  createAnnotation,
  editComment,
  deleteBlock,
  editBlock,
  exportMarkdown,
  getAnnotation,
  getAnnotationCommentId,
  getAnnotationsMap,
  getBlock,
  getBlocksFragment,
  findBlockElement,
  cardPartTexts,
  figmaCaptionTexts,
  initDoc,
  insertBlock,
  listAnnotationRanges,
  listAnnotations,
  moveAnnotation,
  resolveAnnotationAnchors,
  resolveAnnotationRange,
  tableCellTexts,
  tableRows,
  setAnnotationResolved,
  setKind,
  documentDirectoryFields,
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
  return getBlock(doc, blockId)!.text.slice(range.start, range.end);
}

/** Two replicas already sharing one block and one open thread. */
function threadedPair(): { a: Y.Doc; b: Y.Doc; threadId: string } {
  let threadId = "";
  const [a, b] = replicaPair((doc) => {
    initDoc(doc, { uuid: UUID, title: "Annotations" });
    const blockId = appendBlock(doc, { type: "paragraph", text: SENTENCE });
    threadId = createAnnotation(doc, blockId, 6, 11, "reviewer", "Too much?").id;
  });
  return { a, b, threadId };
}

function editablePair(): { a: Y.Doc; b: Y.Doc; threadId: string } {
  let threadId = "";
  const [a, b] = replicaPair((doc) => {
    initDoc(doc, { uuid: UUID, title: "Editable comments" });
    const blockId = appendBlock(doc, { type: "paragraph", text: SENTENCE });
    threadId = createAnnotation(doc, blockId, 6, 11, "Display name", "Original", undefined,
      { kind: "agent", account: "Octocat", agent: "codex", clientName: "Codex desktop", principalId: UUID }).id;
  });
  return { a, b, threadId };
}

function storedComments(doc: Y.Doc, threadId: string): Y.Array<unknown> {
  return (getAnnotationsMap(doc).get(threadId) as Y.Map<unknown>).get("comments") as Y.Array<unknown>;
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
  it("edits an account's agent comment in place, preserving attribution and identity", () => {
    const { a, b, threadId } = editablePair();
    addComment(a, threadId, "Someone else", "Later reply", { kind: "person", account: "someone" });
    const original = getAnnotation(a, threadId)!.comments[0]!;
    const id = getAnnotationCommentId(a, threadId, 0)!;
    const transaction = vi.fn();
    a.on("update", transaction);

    expect(editComment(a, threadId, id, "octocat", "Corrected")?.comments).toEqual([
      { ...original, text: "Corrected", editedAt: expect.any(String) },
      expect.objectContaining({ text: "Later reply" }),
    ]);
    expect(transaction).toHaveBeenCalledTimes(1);
    expect(getAnnotationCommentId(a, threadId, 0)).toBe(id);
    syncDocs(a, b);
    expect(getAnnotation(b, threadId)).toEqual(getAnnotation(a, threadId));
    expect(getAnnotationCommentId(b, threadId, 0)).toBe(id);
    a.destroy();
    b.destroy();
  });

  it.each(["other account", "legacy", "empty", "missing thread", "missing comment", "resolved"])(
    "refuses %s edits without changing the document", (reason) => {
      const { a, b, threadId } = editablePair();
      let id = getAnnotationCommentId(a, threadId, 0)!;
      if (reason === "legacy") {
        addComment(a, threadId, "Legacy", "No account");
        id = getAnnotationCommentId(a, threadId, 1)!;
      }
      if (reason === "missing thread") getAnnotationsMap(a).delete(threadId);
      if (reason === "missing comment") storedComments(a, threadId).delete(0, 1);
      if (reason === "resolved") setAnnotationResolved(a, threadId, true);
      const before = Y.encodeStateAsUpdate(a);

      expect(editComment(a, threadId, id, reason === "other account" ? "someone" : "octocat",
        reason === "empty" ? " \n\t " : "Correction")).toBeNull();
      expect(Y.encodeStateAsUpdate(a)).toEqual(before);
      a.destroy();
      b.destroy();
    },
  );

  it.each([0, 1])("keeps an edit at comment %s while concurrent replies retain converged order", (index) => {
    const { a, b, threadId } = editablePair();
    addComment(a, threadId, "Display name", "Second", { kind: "person", account: "octocat" });
    syncDocs(a, b);
    const id = getAnnotationCommentId(a, threadId, index)!;
    editComment(a, threadId, id, "octocat", "Corrected");
    addComment(b, threadId, "Other", "First concurrent reply");
    addComment(b, threadId, "Other", "Second concurrent reply");
    syncDocs(a, b);

    const expected = ["Original", "Second", "First concurrent reply", "Second concurrent reply"];
    expected[index] = "Corrected";
    expect(getAnnotation(a, threadId)!.comments.map((comment) => comment.text)).toEqual(expected);
    expect(getAnnotation(a, threadId)).toEqual(getAnnotation(b, threadId));
    expect(getAnnotationCommentId(a, threadId, index)).toBe(id);
    a.destroy();
    b.destroy();
  });

  it.each([false, true])("collapses concurrent edits deterministically (same edit time: %s) in every shared reader", (sameTime) => {
    const { a, b, threadId } = editablePair();
    setKind(a, "decision");
    syncDocs(a, b);
    const id = getAnnotationCommentId(a, threadId, 0)!;
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date("2026-10-27T10:00:00.000Z"));
      editComment(a, threadId, id, "octocat", "Edit from A");
      vi.setSystemTime(new Date(sameTime ? "2026-10-27T10:00:00.000Z" : "2026-10-27T10:00:01.000Z"));
      editComment(b, threadId, id, "OCTOCAT", "Edit from B");
      syncDocs(a, b);
      const winningText = !sameTime || b.clientID > a.clientID ? "Edit from B" : "Edit from A";

      expect(storedComments(a, threadId)).toHaveLength(2);
      expect(getAnnotation(a, threadId)!.comments).toHaveLength(1);
      expect(getAnnotation(a, threadId)!.comments[0]!.text).toBe(winningText);
      expect(getAnnotation(a, threadId)).toEqual(getAnnotation(b, threadId));
      expect(listAnnotations(a)[0]!.comments).toHaveLength(1);
      expect(documentDirectoryFields(a).openThreadCount).toBe(1);
      expect(documentDirectoryFields(a).commentCount).toBe(1);
      expect(documentDirectoryFields(b).commentCount).toBe(1);
      const markdown = exportMarkdown(a, { annotations: "html-comments" });
      expect(markdown.split(winningText)).toHaveLength(2);
      expect(markdown).not.toContain("editedAt");
      expect(markdown).not.toContain("(edited)");

      // A subsequent edit deletes every known replacement, even with clock skew.
      vi.setSystemTime(new Date("2026-10-27T09:00:00.000Z"));
      expect(editComment(a, threadId, id, "octocat", "Final edit")?.comments).toHaveLength(1);
      expect(storedComments(a, threadId)).toHaveLength(1);
      syncDocs(a, b);
      expect(getAnnotation(b, threadId)!.comments.map((comment) => comment.text)).toEqual(["Final edit"]);
      expect(getAnnotationCommentId(b, threadId, 0)).toBe(id);
    } finally {
      vi.useRealTimers();
      a.destroy();
      b.destroy();
    }
  });

  it("keeps distinct comments with identical metadata separate, including after collapsed rows", () => {
    const { a, b, threadId } = editablePair();
    const rows = storedComments(a, threadId);
    rows.push([{ ...rows.get(0) as object }]);
    const firstId = getAnnotationCommentId(a, threadId, 0)!;
    const secondId = getAnnotationCommentId(a, threadId, 1)!;
    expect(secondId).not.toBe(firstId);
    syncDocs(a, b);
    editComment(a, threadId, firstId, "octocat", "First A");
    editComment(b, threadId, firstId, "octocat", "First B");
    syncDocs(a, b);
    expect(storedComments(a, threadId)).toHaveLength(3);
    expect(getAnnotation(a, threadId)!.comments).toHaveLength(2);
    expect(getAnnotationCommentId(a, threadId, 1)).toBe(secondId);
    editComment(a, threadId, secondId, "octocat", "Second only");
    syncDocs(a, b);
    expect(getAnnotation(a, threadId)!.comments.map((comment) => comment.text)).toEqual([
      expect.stringMatching(/^First [AB]$/), "Second only",
    ]);
    expect(getAnnotation(a, threadId)).toEqual(getAnnotation(b, threadId));
    a.destroy();
    b.destroy();
  });

  it("collapses a late edit from a third stale replica after known duplicates were cleaned", () => {
    const { a, b, threadId } = editablePair();
    const c = new Y.Doc();
    syncDocs(a, c);
    const id = getAnnotationCommentId(a, threadId, 0)!;
    editComment(a, threadId, id, "octocat", "A");
    editComment(b, threadId, id, "octocat", "B");
    syncDocs(a, b);
    editComment(a, threadId, id, "octocat", "Cleanup");
    editComment(c, threadId, id, "octocat", "Late edit");
    syncDocs(a, c);
    syncDocs(a, b);
    expect(getAnnotation(a, threadId)!.comments).toHaveLength(1);
    expect(getAnnotation(a, threadId)).toEqual(getAnnotation(b, threadId));
    expect(getAnnotation(a, threadId)).toEqual(getAnnotation(c, threadId));
    a.destroy();
    b.destroy();
    c.destroy();
  });

  it.each([42, null, "yesterday", "2026-02-30T10:00:00.000Z", "2026-10-27", "2026-10-27T25:00:00Z"])(
    "omits malformed editedAt %s without losing a comment, attribution or siblings", (editedAt) => {
      const { a, b, threadId } = editablePair();
      const rows = storedComments(a, threadId);
      const comment = rows.get(0) as object;
      rows.delete(0, 1);
      rows.push([{ ...comment, editedAt }, null, { author: "Malformed" }]);
      addComment(a, threadId, "Legacy", "Sibling");
      const comments = getAnnotation(a, threadId)!.comments;
      expect(comments).toHaveLength(2);
      expect(comments[0]).toEqual(comment);
      expect(comments[0]).not.toHaveProperty("editedAt");
      expect(comments[1]).toMatchObject({ text: "Sibling" });
      expect(getAnnotationCommentId(a, threadId, 1)).not.toBeNull();
      a.destroy();
      b.destroy();
    },
  );

  it.each(["2026-10-27T10:00:00.000Z", "2026-10-27T10:00:00Z", "2026-10-27T12:00:00+02:00"])(
    "reads valid ISO editedAt %s", (editedAt) => {
      const { a, b, threadId } = editablePair();
      const rows = storedComments(a, threadId);
      const comment = rows.get(0) as object;
      rows.delete(0, 1);
      rows.push([{ ...comment, editedAt }]);
      expect(getAnnotation(a, threadId)!.comments[0]).toHaveProperty("editedAt", editedAt);
      a.destroy();
      b.destroy();
    },
  );

  it("keeps the hub-v0.4.10 isComment/readThread shape and replying compatible with edited rows", () => {
    const { a, b, threadId } = editablePair();
    const original = getAnnotation(a, threadId)!;
    editComment(a, threadId, getAnnotationCommentId(a, threadId, 0)!, "octocat", "New text");
    syncDocs(a, b);
    const rows = storedComments(b, threadId);
    const releasedIsComment = (value: unknown): value is { author: string; text: string; createdAt: string } => {
      if (typeof value !== "object" || value === null) return false;
      const candidate = value as Record<string, unknown>;
      return typeof candidate.author === "string" && typeof candidate.text === "string" && typeof candidate.createdAt === "string";
    };
    const releasedReadThread = (thread: Y.Map<unknown>) => {
      const comments: Array<{ author: string; text: string; createdAt: string }> = [];
      for (const value of (thread.get("comments") as Y.Array<unknown>).toArray()) {
        if (!releasedIsComment(value)) continue;
        const { author, text, createdAt } = value;
        comments.push({ author, text, createdAt });
      }
      const resolved = thread.get("resolved");
      return {
        id: thread.get("id") as string,
        blockId: thread.get("blockId") as string,
        ...(typeof resolved === "boolean" ? { resolved } : {}),
        comments,
      };
    };
    const oldRead = () => releasedReadThread(getAnnotationsMap(b).get(threadId) as Y.Map<unknown>);
    expect(oldRead()).toEqual({
      id: threadId,
      blockId: original.blockId,
      comments: [{ author: "Display name", text: "New text", createdAt: original.comments[0]!.createdAt }],
    });
    expect(oldRead().comments[0]).not.toHaveProperty("editedAt");
    rows.push([{ author: "Old release", text: "Reply", createdAt: "2026-10-27T10:00:00.000Z" }]);
    syncDocs(a, b);
    expect(getAnnotation(a, threadId)!.comments.map((comment) => comment.text)).toEqual(["New text", "Reply"]);
    expect(oldRead().comments).toHaveLength(2);
    setAnnotationResolved(a, threadId, true);
    syncDocs(a, b);
    expect(oldRead()).toMatchObject({ resolved: true });
    a.destroy();
    b.destroy();
  });

  it("keeps browser, MCP and legacy attribution on each stored comment through a document round trip", () => {
    const doc = new Y.Doc();
    initDoc(doc, { uuid: UUID, title: "Comment attribution" });
    const blockId = appendBlock(doc, { type: "paragraph", text: SENTENCE });
    const person = { kind: "person", account: "octo-cat", principalId: UUID } as const;
    const claude = { kind: "agent", account: "octo-cat", principalId: UUID, agent: "claude", clientName: "CLAUDE Code" } as const;
    const thread = createAnnotation(doc, blockId, 6, 11, "Presence name", "Browser opener", undefined, person);
    addComment(doc, thread.id, "Presence name", "Unsigned browser reply", { kind: "person" });
    addComment(doc, thread.id, "Explicit agent author", "Claude reply", claude);
    moveAnnotation(doc, thread.id, blockId, 0, 5, "Other client", "Agent move", undefined, { kind: "agent", clientName: "Cursor <client>" });
    addComment(doc, thread.id, "Old release", "Legacy reply");

    const stored = getAnnotationsMap(doc).get(thread.id) as Y.Map<unknown>;
    expect((stored.get("comments") as Y.Array<unknown>).toArray()).toEqual([
      { author: "Presence name", text: "Browser opener", createdAt: expect.any(String), ...person },
      { author: "Presence name", text: "Unsigned browser reply", createdAt: expect.any(String), kind: "person" },
      { author: "Explicit agent author", text: "Claude reply", createdAt: expect.any(String), ...claude },
      { author: "Other client", text: "Agent move", createdAt: expect.any(String), kind: "agent", clientName: "Cursor <client>" },
      { author: "Old release", text: "Legacy reply", createdAt: expect.any(String) },
    ]);
    const replica = new Y.Doc();
    Y.applyUpdate(replica, Y.encodeStateAsUpdate(doc));
    const read = getAnnotation(replica, thread.id)!;
    expect(read.comments).toEqual((stored.get("comments") as Y.Array<unknown>).toArray());
    expect(listAnnotations(replica)).toEqual([read]);
    expect(read.comments[3]).toHaveProperty("kind", "agent");
    expect(read.comments[3]).not.toHaveProperty("agent");
    expect(read.comments[4]).not.toHaveProperty("kind");
    replica.destroy();
    doc.destroy();
  });

  it.each(["claude", "codex"] as const)("stores %s attribution on openers, replies and moves", (agent) => {
    const doc = new Y.Doc();
    initDoc(doc, { uuid: UUID, title: "MCP attribution" });
    const blockId = appendBlock(doc, { type: "paragraph", text: SENTENCE });
    const attribution = { kind: "agent", account: "octocat", principalId: UUID, agent } as const;
    const thread = createAnnotation(doc, blockId, 6, 11, "Agent name", "Open", undefined, attribution);
    addComment(doc, thread.id, "Agent name", "Reply", attribution);
    const moved = moveAnnotation(doc, thread.id, blockId, 0, 5, "Agent name", "Move", undefined, attribution);

    expect(moved?.comments).toEqual(["Open", "Reply", "Move"].map((text) => ({
      author: "Agent name", text, createdAt: expect.any(String), ...attribution,
    })));
    expect(getAnnotation(doc, thread.id)).toEqual(moved);
    doc.destroy();
  });

  it.each([
    { field: "account", invalid: "../octocat" },
    { field: "account", invalid: 42 },
    { field: "agent", invalid: "other-product" },
    { field: "agent", invalid: 42 },
    { field: "clientName", invalid: 42 },
    { field: "clientName", invalid: null },
    { field: "clientName", invalid: { name: "Cursor" } },
    { field: "clientName", invalid: ["Cursor"] },
    { field: "principalId", invalid: "octocat" },
    { field: "principalId", invalid: 42 },
    { field: "kind", invalid: "human" },
    { field: "kind", invalid: 42 },
  ])("omits only invalid $field attribution ($invalid), preserving comments and their siblings", ({ field, invalid }) => {
    const { doc, threadId } = annotated();
    const stored = getAnnotationsMap(doc).get(threadId) as Y.Map<unknown>;
    const rows = stored.get("comments") as Y.Array<unknown>;
    const attribution = { kind: "agent", account: "octocat", principalId: UUID, agent: "codex", clientName: "Codex desktop" };
    const comment = { author: "Author", text: "Foreign comment", createdAt: "2026-10-26T00:00:00.000Z" };
    rows.push([{ ...comment, ...attribution, [field]: invalid }, null, { author: "Malformed" }]);
    addComment(doc, threadId, "Legacy author", "Sibling");
    const validAttribution = Object.fromEntries(Object.entries(attribution).filter(([key]) => key !== field));

    const comments = getAnnotation(doc, threadId)!.comments;
    expect(comments).toHaveLength(3);
    expect(comments[0]).toMatchObject({ author: "reviewer", text: "Too much?" });
    expect(comments[1]).toEqual({ ...comment, ...validAttribution });
    expect(comments[1]).not.toHaveProperty(field);
    expect(comments[2]).toEqual({ author: "Legacy author", text: "Sibling", createdAt: expect.any(String) });
    expect(listAnnotations(doc)[0]?.comments).toEqual(comments);
    doc.destroy();
  });

  it.each(["paragraph", "table", "card", "figma"] as const)("resolves moved marks in a %s block without rewriting the thread", (type) => {
    const { doc, blockId, threadId } = annotated();
    const text = type === "table" ? "| brave gap world | Later |\n| --- | --- |\n| Later | Last |"
      : type === "card" ? "title: brave gap world\n\nLater"
        : type === "figma" ? "url: https://www.figma.com/design/Abc123/File\n\nbrave gap world"
          : "brave gap world";
    const target = appendBlock(doc, { type, text });
    const element = findBlockElement(doc, target)!;
    const texts = type === "table" ? [
      tableCellTexts(tableRows(element)[0]![0]!)[0]!,
      tableCellTexts(tableRows(element)[1]![0]!)[0]!,
    ] : type === "card" ? [...cardPartTexts(element, "title"), ...cardPartTexts(element, "body")]
      : type === "figma" ? figmaCaptionTexts(element)
        : [element.firstChild as Y.XmlText];
    texts[0]!.format(0, 5, { [COMMENT_MARK]: { threadId } });
    texts[0]!.format(10, 5, { [COMMENT_MARK]: { threadId } });
    for (const later of texts.slice(1)) later.format(0, later.length, { [COMMENT_MARK]: { threadId } });
    (findBlockElement(doc, blockId)!.firstChild as Y.XmlText).format(6, 5, { [COMMENT_MARK]: null });
    const coordinates = type === "table" ? { row: 0, column: 0 }
      : type === "card" ? { part: "title" }
        : type === "figma" ? { part: "caption" } : {};
    const range = { ...coordinates, start: 0, end: 15, collapsed: false };

    expect(resolveAnnotationAnchors(doc).get(threadId)).toEqual({ blockId: target, range, text: "brave gap world" });
    expect(resolveAnnotationRange(doc, threadId)).toEqual(range);
    expect(getAnnotation(doc, threadId)?.blockId).toBe(blockId);
    expect(listAnnotationRanges(doc, blockId)).toEqual([]);
    doc.destroy();
  });

  it("prefers a marked recorded block over an earlier copy, then falls back in document order", () => {
    const { doc, blockId, threadId } = annotated();
    const earlier = insertBlock(doc, null, { type: "paragraph", text: "Earlier copy" });
    const later = appendBlock(doc, { type: "paragraph", text: "Later copy" });
    (findBlockElement(doc, earlier)!.firstChild as Y.XmlText).format(0, 7, { [COMMENT_MARK]: { threadId } });
    (findBlockElement(doc, later)!.firstChild as Y.XmlText).format(0, 5, { [COMMENT_MARK]: { threadId } });

    expect(resolveAnnotationAnchors(doc).get(threadId)).toEqual({
      blockId, range: { start: 6, end: 11, collapsed: false }, text: "brave",
    });
    (findBlockElement(doc, blockId)!.firstChild as Y.XmlText).format(6, 5, { [COMMENT_MARK]: null });
    expect(resolveAnnotationAnchors(doc).get(threadId)).toEqual({
      blockId: earlier, range: { start: 0, end: 7, collapsed: false }, text: "Earlier",
    });
    deleteBlock(doc, earlier);
    expect(resolveAnnotationAnchors(doc).get(threadId)).toEqual({
      blockId: later, range: { start: 0, end: 5, collapsed: false }, text: "Later",
    });
    doc.destroy();
  });

  it("excludes missing and malformed stored threads from resolved anchors", () => {
    const { doc, blockId, threadId } = annotated();
    const missing = appendBlock(doc, { type: "paragraph", text: "Missing" });
    const malformed = appendBlock(doc, { type: "paragraph", text: "Malformed" });
    (findBlockElement(doc, missing)!.firstChild as Y.XmlText).format(0, 7, { [COMMENT_MARK]: { threadId: "missing" } });
    (findBlockElement(doc, malformed)!.firstChild as Y.XmlText).format(0, 9, { [COMMENT_MARK]: { threadId: "malformed" } });
    getAnnotationsMap(doc).set("malformed", new Y.Map<unknown>([["id", "malformed"], ["blockId", malformed]]));

    expect(resolveAnnotationAnchors(doc)).toEqual(new Map([[threadId, {
      blockId, range: { start: 6, end: 11, collapsed: false }, text: "brave",
    }]]));
    expect(resolveAnnotationRange(doc, "missing")).toBeNull();
    expect(resolveAnnotationRange(doc, "malformed")).toBeNull();
    expect(annotationAnchors(doc).get("missing")).toBe("Missing");
    doc.destroy();
  });

  it("moves all copies of an anchor with one reply while preserving the thread's metadata", () => {
    const { doc, blockId, threadId } = annotated();
    addComment(doc, threadId, "owner", "Earlier reply");
    setAnnotationResolved(doc, threadId, true);
    const previous = getAnnotation(doc, threadId)!;
    const target = appendBlock(doc, { type: "paragraph", text: "New anchor" });
    const table = appendBlock(doc, { type: "table", text: "| H |\n| --- |\n| Cell |" });
    const card = appendBlock(doc, { type: "card", text: "title: Card\n\nBody" });
    const figma = appendBlock(doc, { type: "figma", text: "url: https://www.figma.com/design/Abc123/File\n\nCaption" });
    const tableElement = findBlockElement(doc, table)!;
    const cardElement = findBlockElement(doc, card)!;
    const figmaElement = findBlockElement(doc, figma)!;
    for (const text of [
      tableCellTexts(tableRows(tableElement)[1]![0]!)[0]!,
      ...cardPartTexts(cardElement, "body"),
      ...figmaCaptionTexts(figmaElement),
    ]) text.format(0, text.length, { [COMMENT_MARK]: { threadId } });
    const shadow = findBlockElement(doc, blockId)!.clone();
    getBlocksFragment(doc).insert(getBlocksFragment(doc).length, [shadow]);
    const before = annotationAnchors(doc);
    expect(before.get(threadId)).toBe("brave … Cell … Body … Caption");
    let updates = 0;
    doc.on("update", () => { updates += 1; });

    const moved = moveAnnotation(doc, threadId, target, 0, 3, "agent", "Moved context");

    expect(updates).toBe(1);
    expect(moved).toMatchObject({ id: threadId, blockId: target, resolved: true });
    expect(moved?.comments.slice(0, -1)).toEqual(previous.comments);
    expect(moved?.comments.at(-1)).toMatchObject({ author: "agent", text: "Moved context" });
    expect(resolveAnnotationRange(doc, threadId)).toEqual({ start: 0, end: 3, collapsed: false });
    expect(annotationAnchors(doc)).toEqual(new Map([[threadId, "New"]]));
    expect((shadow.firstChild as Y.XmlText).toDelta()).toEqual([{ insert: SENTENCE }]);
    for (const id of [blockId, table, card, figma]) expect(listAnnotationRanges(doc, id)).toEqual([]);
  });

  it("moves onto its own current anchor and restores an orphaned thread", () => {
    const { doc, blockId, threadId } = annotated();
    moveAnnotation(doc, threadId, blockId, 4, 13, "agent", "Wider context");
    expect(resolveAnnotationRange(doc, threadId)).toEqual({ start: 4, end: 13, collapsed: false });
    deleteBlock(doc, blockId);
    const target = appendBlock(doc, { type: "paragraph", text: "Restored context" });
    moveAnnotation(doc, threadId, target, 8, 16, "agent", "Found context");
    expect(getAnnotation(doc, threadId)?.blockId).toBe(target);
    expect(annotationAnchors(doc).get(threadId)).toBe(" context");
  });

  it("validates a move before changing any anchor or reply", () => {
    const { doc, blockId, threadId } = annotated();
    createAnnotation(doc, blockId, 12, 17, "other", "Other thread");
    const empty = appendBlock(doc, { type: "paragraph", text: "" });
    findBlockElement(doc, empty)!.delete(0, 1);
    const state = Y.encodeStateAsUpdate(doc);
    let updates = 0;
    doc.on("update", () => { updates += 1; });
    expect(() => moveAnnotation(doc, threadId, blockId, 12, 14, "a", "Overlap")).toThrow(AnnotationRangeError);
    expect(() => moveAnnotation(doc, threadId, blockId, 2, 2, "a", "Empty")).toThrow(AnnotationRangeError);
    expect(() => moveAnnotation(doc, threadId, empty, 0, 3, "a", "Missing text")).toThrow(AnnotationRangeError);
    expect(() => moveAnnotation(doc, threadId, "unknown", 0, 1, "a", "Missing")).toThrow(BlockNotFoundError);
    expect(moveAnnotation(doc, "unknown", blockId, 0, 1, "a", "Missing thread")).toBeNull();
    expect(updates).toBe(0);
    expect(Y.encodeStateAsUpdate(doc)).toEqual(state);
  });

  it("ignores shadowed and unidentified block marks when reading document-wide anchors", () => {
    const { doc, blockId, threadId } = annotated();
    const shadow = findBlockElement(doc, blockId)!.clone();
    const unidentified = shadow.clone();
    unidentified.removeAttribute("id");
    getBlocksFragment(doc).insert(getBlocksFragment(doc).length, [shadow, unidentified]);
    expect(annotationAnchors(doc)).toEqual(new Map([[threadId, "brave"]]));
    expect(resolveAnnotationAnchors(doc).get(threadId)?.blockId).toBe(blockId);
    (findBlockElement(doc, blockId)!.firstChild as Y.XmlText).format(6, 5, { [COMMENT_MARK]: null });
    expect(annotationAnchors(doc).has(threadId)).toBe(false);
    expect(resolveAnnotationAnchors(doc).has(threadId)).toBe(false);
    expect(resolveAnnotationRange(doc, threadId)).toBeNull();
  });

  it("keeps anchor excerpts aligned when foreign embeds precede the marked text", () => {
    const { doc, blockId, threadId } = annotated();
    (findBlockElement(doc, blockId)!.firstChild as Y.XmlText).insertEmbed(0, { foreign: true });
    expect(annotationAnchors(doc).get(threadId)).toBe("brave");
    expect(resolveAnnotationAnchors(doc).get(threadId)).toEqual({
      blockId, range: { start: 7, end: 12, collapsed: false }, text: "brave",
    });
    const text = findBlockElement(doc, blockId)!.firstChild as Y.XmlText;
    text.insertEmbed(9, { foreign: true });
    text.format(9, 1, { [COMMENT_MARK]: { threadId } });
    expect(resolveAnnotationAnchors(doc).get(threadId)).toEqual({
      blockId, range: { start: 7, end: 13, collapsed: false }, text: "br\uFFFCave",
    });
  });

  it("anchors the range as a comment mark on the block's text", () => {
    const { doc, blockId, threadId } = annotated();

    // The thread record carries no positions at all — the range is in the text.
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

  it("tracks the range through edits before, after, inside and across it", () => {
    // The mark IS the anchor, so an edit anywhere in the block moves the range
    // rather than invalidating it. One table, one behaviour: what "brave"
    // covers after each kind of edit, and where the range lands.
    const cases: Array<{
      what: string;
      newText: string;
      covers: string;
      range?: { start: number; end: number };
    }> = [
      {
        what: "shifts when characters before it are inserted",
        newText: `Say: ${SENTENCE}`,
        covers: "brave",
        range: { start: 11, end: 16 },
      },
      {
        what: "stays put when text after it changes",
        newText: "Hello brave new world",
        covers: "brave",
        range: { start: 6, end: 11 },
      },
      {
        what: "grows with text inserted strictly inside",
        newText: "Hello braXve world",
        covers: "braXve",
      },
      {
        what: "shrinks when part of the annotated text is deleted",
        newText: "Hello be world",
        covers: "be ",
      },
    ];

    for (const { what, newText, covers, range } of cases) {
      const { doc, blockId, threadId } = annotated();
      editBlock(doc, blockId, SENTENCE, newText);
      expect(annotatedText(doc, blockId, threadId), what).toBe(covers);
      if (range !== undefined) {
        expect(resolveAnnotationRange(doc, threadId), what).toEqual({
          ...range,
          collapsed: false,
        });
      }
    }

    // …and an edit that puts the text back leaves the range where it started.
    const { doc, blockId, threadId } = annotated();
    editBlock(doc, blockId, SENTENCE, `Say: ${SENTENCE}`);
    editBlock(doc, blockId, `Say: ${SENTENCE}`, SENTENCE);
    expect(annotatedText(doc, blockId, threadId)).toBe("brave");
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

  it("resolves to null once every annotated character is deleted, keeping the thread", () => {
    const { doc, blockId, threadId } = annotated();

    editBlock(doc, blockId, SENTENCE, "Hello world");

    // A mark cannot mark nothing: deleting the whole span removes the anchor,
    // so the range is gone rather than collapsed (the round-1 relative-position
    // model collapsed to a point here). The conversation is never
    // cascade-deleted with it — the thread record stays readable and listable.
    expect(resolveAnnotationRange(doc, threadId)).toBeNull();
    expect(annotatedText(doc, blockId, threadId)).toBeNull();
    expect(getAnnotation(doc, threadId)?.comments).toHaveLength(1);
    expect(listAnnotations(doc)).toHaveLength(1);
    expect(listAnnotationRanges(doc, blockId)).toEqual([]);
  });

  it("resolves to null when the anchoring block is deleted, or the thread is unknown", () => {
    const { doc, blockId, threadId } = annotated();
    expect(resolveAnnotationRange(doc, "not-a-thread")).toBeNull();

    deleteBlock(doc, blockId);
    expect(getAnnotation(doc, threadId)).not.toBeNull();
    expect(resolveAnnotationRange(doc, threadId)).toBeNull();
  });

  it("clamps out-of-range and reversed indices, and refuses unknown blocks", () => {
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

    expect(() => createAnnotation(doc, "nope", 0, 1, "a", "b")).toThrow(
      BlockNotFoundError,
    );
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

  it("appends comments and resolves threads without touching the mark", () => {
    const { doc, blockId, threadId } = annotated();
    expect(addComment(doc, threadId, "author", "Fixed.")?.comments).toHaveLength(
      2,
    );
    expect(setAnnotationResolved(doc, threadId, true)?.resolved).toBe(true);
    expect(getAnnotation(doc, threadId)?.comments).toHaveLength(2);
    // A resolved thread stays anchored so the editor can still show it in place.
    expect(annotatedText(doc, blockId, threadId)).toBe("brave");
    expect(addComment(doc, "unknown", "a", "b")).toBeNull();
    expect(setAnnotationResolved(doc, "unknown", true)).toBeNull();
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

    expect(getBlock(a, blockId)!.text).toBe("Say: Hello braZZve world");
    expect(getBlock(b, blockId)!.text).toBe(getBlock(a, blockId)!.text);
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
    // resolves to null — but both conversations survive, on both replicas,
    // which is what stops a comment from being silently destroyed.
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

  it("keeps both replies when two replicas comment on one thread offline", () => {
    const { a, b, threadId } = threadedPair();

    // Neither replica can see the other's reply; both inserts must survive.
    addComment(a, threadId, "owner", "Yes, cut it.");
    addComment(b, threadId, "agent", "Shortened.");
    syncDocs(a, b);

    const onA = getAnnotation(a, threadId)?.comments ?? [];
    expect(onA.map((comment) => comment.text)).toHaveLength(3);
    expect(onA.map((comment) => comment.text)).toEqual(
      expect.arrayContaining(["Yes, cut it.", "Shortened."]),
    );
    // The opening comment was already shared, so it stays first; which reply
    // follows it is Yjs's to decide. The contract is that both replicas decide
    // it the same way — a position, not a timestamp.
    expect(onA[0]?.text).toBe("Too much?");
    expect(getAnnotation(b, threadId)?.comments).toEqual(onA);
  });

  it("keeps a reply made concurrently with a resolve", () => {
    const { a, b, threadId } = threadedPair();

    setAnnotationResolved(a, threadId, true);
    addComment(b, threadId, "agent", "One more thing.");
    syncDocs(a, b);

    // The two writes touch different keys, so neither can clobber the other.
    for (const replica of [a, b]) {
      const thread = getAnnotation(replica, threadId);
      expect(thread?.resolved).toBe(true);
      expect(thread?.comments.map((comment) => comment.text)).toEqual([
        "Too much?",
        "One more thing.",
      ]);
    }
  });

  it("exports annotations as adjacent HTML comments, or drops them", () => {
    const { doc, blockId, threadId } = annotated();
    // A reply, so the exported body is the joined list and not one stored field.
    addComment(doc, threadId, "author", "Cut.");
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
        `<!-- annotation ${threadId} range=6-11 resolved reviewer: "Too much?" | author: "Cut." -->`,
        "",
      ].join("\n"),
    );

    // An unanchored thread has no range to point at, so it is omitted even when
    // annotations are requested.
    appendBlock(doc, { type: "paragraph", text: "still here" });
    deleteBlock(doc, blockId);
    expect(
      exportMarkdown(doc, { frontmatter: false, annotations: "html-comments" }),
    ).toBe("still here\n");
  });
});

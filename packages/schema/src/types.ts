/**
 * The vocabulary of the uberblick document model.
 *
 * Terminology is stable and shared by every package: block, block id, block
 * type, annotation thread, directory entry, sidebar group.
 */

/** Block types. The set is closed; a block type is a Y.XmlElement nodeName. */
export const BLOCK_TYPES = ["paragraph", "heading", "code", "mermaid"] as const;

export type BlockType = (typeof BLOCK_TYPES)[number];

export type HeadingLevel = 1 | 2 | 3 | 4 | 5 | 6;

export function isBlockType(value: string): value is BlockType {
  return (BLOCK_TYPES as readonly string[]).includes(value);
}

/**
 * Inline formatting marks. The set is closed; a mark name is a Yjs text
 * formatting key on a block's Y.XmlText — see `marks.ts`.
 *
 * `comment` is not in here: it is the annotation anchor, not formatting, and it
 * is the one mark a `code` or `mermaid` block may carry.
 *
 * Inline code is `inlineCode`, not `code`, and the reason is structural rather
 * than stylistic: ProseMirror refuses a schema where one name is both a node and
 * a mark ("code can not be both a node and a mark"), and `code` is a block type.
 * A mark's name *is* its Yjs formatting key — y-prosemirror derives one from the
 * other in both directions — so the mark is what has to give way.
 */
export const INLINE_MARKS = [
  "bold",
  "italic",
  "strike",
  "inlineCode",
  "link",
] as const;

export type InlineMarkName = (typeof INLINE_MARKS)[number];

export function isInlineMark(value: string): value is InlineMarkName {
  return (INLINE_MARKS as readonly string[]).includes(value);
}

/**
 * The inline marks covering one run of text.
 *
 * Four of them are flags; `link` carries its href, which is always an external
 * `http(s)` URL. Doc-to-doc references are `meta.links` by UUID and never a
 * link mark.
 */
export interface InlineMarkSet {
  bold?: boolean;
  italic?: boolean;
  strike?: boolean;
  inlineCode?: boolean;
  /** External http(s) URL. */
  link?: string;
}

/** A maximal run of a block's text carrying one set of inline marks. */
export interface InlineRun {
  text: string;
  marks: InlineMarkSet;
}

/**
 * A block as read out of the document.
 *
 * `level` is present exactly for `heading`, `language` exactly for `code`
 * (possibly the empty string when no language was set).
 */
export interface Block {
  id: string;
  type: BlockType;
  /**
   * The block's plain-text source, marks excluded. Rich blocks render this; they
   * do not replace it. Inline marks are read separately with `getBlockInline`.
   */
  text: string;
  /**
   * Content hash of type + text + attributes, for optimistic concurrency.
   * Pass it back to `editBlock` to assert nothing changed since this read.
   */
  rev: string;
  level?: HeadingLevel;
  language?: string;
}

/** The shape accepted when creating a block. */
export interface BlockInput {
  type: BlockType;
  text?: string;
  /** Headings only. Defaults to 1. Ignored for other types. */
  level?: HeadingLevel;
  /** Code blocks only, e.g. "ts". Ignored for other types. */
  language?: string;
  /**
   * Formatted content, for `paragraph` and `heading` only — the two block types
   * that carry inline marks. When present it *replaces* `text`, so a caller
   * setting both must keep them consistent; `importMarkdown` does.
   *
   * `code` and `mermaid` hold source, so this is ignored for them.
   */
  inline?: InlineRun[];
}

/** Document metadata. Identity is the uuid; title and tags are display data. */
export interface DocMeta {
  uuid: string;
  title: string;
  tags: string[];
  /** Outbound links, by target document UUID. Never paths or titles. */
  links: string[];
}

export interface AnnotationComment {
  author: string;
  text: string;
  /** ISO-8601 timestamp. */
  createdAt: string;
}

/**
 * An annotation thread, stored as plain JSON in the `annotations` Y.Map.
 *
 * The thread carries no positions. Its range lives in the document text as a
 * `comment` formatting mark holding this thread's id, so the range survives
 * concurrent edits, block splits and re-types — see `annotations.ts`.
 */
export interface Annotation {
  id: string;
  blockId: string;
  comments: AnnotationComment[];
  resolved?: boolean;
}

/**
 * The formatting-mark key that anchors annotation ranges.
 *
 * Not one of {@link INLINE_MARKS}: it is the one mark every block type may
 * carry, formatting or not. It lives here rather than in `annotations.ts` because
 * the marks module has to know the name to tell an anchor apart from formatting,
 * and vocabulary belongs in the vocabulary module.
 */
export const COMMENT_MARK = "comment";

/** The value of a `comment` mark: ProseMirror-shaped mark attributes. */
export interface CommentMark {
  threadId: string;
}

/** Whether a delta attribute's value is a `comment` mark a reader can use. */
export function isCommentMark(value: unknown): value is CommentMark {
  if (typeof value !== "object" || value === null) return false;
  const threadId = (value as Partial<CommentMark>).threadId;
  return typeof threadId === "string" && threadId !== "";
}

/** A resolved absolute range inside a block's text. */
export interface AnnotationRange {
  start: number;
  end: number;
  /**
   * True when the marked span resolves to zero length. Not reachable through
   * this package's own writers — a fully deleted span loses its mark and
   * resolves to `null` instead — but a foreign writer can leave one behind.
   */
  collapsed: boolean;
}

/** An entry in the directory doc: a discovery stub for one document. */
export interface DirectoryEntry {
  uuid: string;
  title: string;
  tags: string[];
  deleted?: boolean;
}

/** One group in the sidebar doc: a stable id, a name, and what it pins. */
export interface SidebarGroup {
  id: string;
  name: string;
  /** Pinned document uuids, in stored order. */
  docs: string[];
}

/**
 * The vocabulary of the uberblick document model.
 *
 * Terminology is stable and shared by every package: block, block id, block
 * type, annotation thread, directory entry, sidebar group.
 */

/** Block types. The set is closed; a block type is a Y.XmlElement nodeName. */
export const BLOCK_TYPES = [
  "paragraph",
  "heading",
  "code",
  "mermaid",
  "list-item",
  "quote",
  "table",
] as const;

export type BlockType = (typeof BLOCK_TYPES)[number];

export type HeadingLevel = 1 | 2 | 3 | 4 | 5 | 6;

export function isBlockType(value: string): value is BlockType {
  return (BLOCK_TYPES as readonly string[]).includes(value);
}

/**
 * The block types whose text is prose: they carry the inline mark set, and the
 * markdown reader resolves inline syntax inside them.
 *
 * The complement is source text — `code`, `mermaid` and `table` — which carries
 * only the `comment` anchor. Everything that has to tell the two apart asks
 * here, so the distinction is stated once.
 */
export const PROSE_BLOCK_TYPES = [
  "paragraph",
  "heading",
  "list-item",
  "quote",
] as const;

export type ProseBlockType = (typeof PROSE_BLOCK_TYPES)[number];

export function isProseBlockType(value: string): value is ProseBlockType {
  return (PROSE_BLOCK_TYPES as readonly string[]).includes(value);
}

/**
 * What a `list-item` block's marker looks like. A "list" is a run of adjacent
 * list-item blocks — markdown's own model, and the reason the document stays
 * flat: there is no list node to nest into.
 */
export const LIST_STYLES = ["bullet", "ordered"] as const;

export type ListStyle = (typeof LIST_STYLES)[number];

export function isListStyle(value: string): value is ListStyle {
  return (LIST_STYLES as readonly string[]).includes(value);
}

/** How deep a list item may sit. Four levels, counted from zero. */
export type ListIndent = 0 | 1 | 2 | 3;

export const MAX_LIST_INDENT = 3;

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
 * (possibly the empty string when no language was set), and `list`/`indent`
 * exactly for `list-item`.
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
  /** List items only: the marker their run is written with. */
  list?: ListStyle;
  /** List items only: nesting depth, 0–3. */
  indent?: ListIndent;
}

/** The shape accepted when creating a block. */
export interface BlockInput {
  type: BlockType;
  text?: string;
  /** Headings only. Defaults to 1. Ignored for other types. */
  level?: HeadingLevel;
  /** Code blocks only, e.g. "ts". Ignored for other types. */
  language?: string;
  /** List items only. Defaults to "bullet". Ignored for other types. */
  list?: ListStyle;
  /** List items only. Clamped to 0–3, defaults to 0. Ignored for other types. */
  indent?: number;
  /**
   * Formatted content, for the prose block types only — see
   * {@link PROSE_BLOCK_TYPES}. When present it *replaces* `text`, so a caller
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
  /**
   * When the document was created, epoch ms on the creating replica's clock.
   * Absent for stubs written before the field existed, until something
   * backfills them.
   */
  createdAt?: number;
  /**
   * When a replica last observed the document change, epoch ms on that
   * replica's clock — coarse by design, and cache-quality: a freshness hint to
   * sort by, never history. Absent until something stamps it.
   */
  updatedAt?: number;
}

/** One group in the sidebar doc: a stable id, a name, and what it pins. */
export interface SidebarGroup {
  id: string;
  name: string;
  /** Pinned document uuids, in stored order. */
  docs: string[];
}

/**
 * What an agent session reported about a document: that it used it, or how it
 * rated it. Self-reported and advisory — see `feedback.ts`.
 */
export type FeedbackKind = "used" | "helpful" | "unhelpful";

/** The two verdicts. Abstaining is legal, and is its own bucket in a report. */
export type FeedbackVerdict = Exclude<FeedbackKind, "used">;

/** One stored feedback event. Plain data, never a nested Y type. */
export interface FeedbackEvent {
  docUuid: string;
  /** The reporting session's id — one MCP server process. */
  session: string;
  /** The session's self-asserted display name. Never identity. */
  agent: string;
  kind: FeedbackKind;
  /** Why, in the rater's own words. Verdicts only, and always optional. */
  reason?: string;
  /** Epoch ms on the reporting replica's clock. Display only. */
  at: number;
}

/** Folded counts for one document. Sessions, never calls. */
export interface FeedbackTotals {
  sessionsUsed: number;
  helpful: number;
  unhelpful: number;
  /** Sessions that used the document and gave no verdict. */
  unrated: number;
}

/** One rater's words, carried into a report. */
export interface FeedbackReason {
  session: string;
  agent: string;
  verdict: FeedbackVerdict;
  reason: string;
  at: number;
}

/** One document's row in a feedback report. */
export interface DocFeedback extends FeedbackTotals {
  uuid: string;
  /** helpful / (helpful + unhelpful), or null when nobody rated it. */
  helpfulRatio: number | null;
  /** The most recent reasons, newest first. Compaction does not keep them. */
  reasons: FeedbackReason[];
}

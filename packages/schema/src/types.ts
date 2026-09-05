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
  "docLink",
] as const;

export type InlineMarkName = (typeof INLINE_MARKS)[number];

export function isInlineMark(value: string): value is InlineMarkName {
  return (INLINE_MARKS as readonly string[]).includes(value);
}

/**
 * The inline marks covering one run of text.
 *
 * Four of them are flags; the two link marks carry a target. `link` is always
 * an external `http(s)` URL, and `docLink` is always a document uuid — an
 * inline doc-to-doc reference. They are the same affordance over two disjoint
 * target spaces, which is why nothing carries both: a write refuses the pair,
 * and a read resolves it in `docLink`'s favour (see `marks.ts`).
 */
export interface InlineMarkSet {
  bold?: boolean;
  italic?: boolean;
  strike?: boolean;
  inlineCode?: boolean;
  /** External http(s) URL. */
  link?: string;
  /** A document uuid, lowercase — never a path, a title or a URL. */
  docLink?: string;
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

/**
 * How long a document description may be.
 *
 * One or two sentences is the shape asked for; this is the ceiling that keeps a
 * listing readable, not a target. A description is written for an agent scanning
 * `list_docs` or `search` — it has to fit beside the title, or it stops being
 * cheaper than opening the document.
 */
export const MAX_DESCRIPTION_LENGTH = 300;

/** How long a person-facing document summary may be. */
export const MAX_TLDR_LENGTH = 300;

/** The document shapes whose lifecycle the schema records. */
export const DOCUMENT_KINDS = ["requirement", "decision"] as const;
export type DocumentKind = (typeof DOCUMENT_KINDS)[number];

/** The states of a requirement record, in lifecycle order. */
export const REQUIREMENT_STATUSES = [
  "draft",
  "planned",
  "implementing",
  "done",
] as const;
export type RequirementStatus = (typeof REQUIREMENT_STATUSES)[number];

/** The states of a decision record, in lifecycle order. */
export const DECISION_STATUSES = ["open", "decided"] as const;
export type DecisionStatus = (typeof DECISION_STATUSES)[number];

export type DocumentStatus = RequirementStatus | DecisionStatus;

export function isDocumentKind(value: unknown): value is DocumentKind {
  return value === "requirement" || value === "decision";
}

/** Whether `status` belongs to `kind`'s closed lifecycle. */
export function isDocumentStatusForKind(
  kind: DocumentKind,
  status: unknown,
): status is DocumentStatus {
  const statuses =
    kind === "requirement" ? REQUIREMENT_STATUSES : DECISION_STATUSES;
  return statuses.some((candidate) => candidate === status);
}

/**
 * The tolerant lifecycle read shared by a document and its directory stub.
 *
 * `kind` is valid on its own, while `status` is meaningful only for that kind.
 * A malformed or merged-mismatched status therefore disappears without hiding
 * a valid kind.
 */
export function readDocumentLifecycle(
  kind: unknown,
  status: unknown,
): { kind?: DocumentKind; status?: DocumentStatus } {
  if (!isDocumentKind(kind)) return {};
  return {
    kind,
    ...(isDocumentStatusForKind(kind, status) ? { status } : {}),
  };
}

/** Document metadata. Identity is the uuid; title and tags are display data. */
export interface DocMeta {
  uuid: string;
  title: string;
  /**
   * Deterministic tag assignment view. Catalog-aware writes use UUIDs;
   * provisional strings are omitted by catalog-aware reads.
   */
  tags: string[];
  /**
   * One or two sentences saying what this document is for, so a reader can
   * judge relevance from a listing without opening it. Null when nobody has
   * written one — documents created in the web UI start that way, and MCP's
   * `create_doc` refuses to.
   */
  description: string | null;
  /**
   * One or two plain-English sentences for a person opening the document.
   * Optional for additive consumers; `getMeta` normalizes an unwritten value to
   * null.
   */
  tldr?: string | null;
  /**
   * Draft release-note copy for the work this document records: one short
   * sentence of simple English about the user-visible outcome.
   *
   * Three states, one key. Absent means nobody has written one; `null` means
   * this change deliberately needs no user-facing entry; a non-empty string is
   * the suggestion. Absent and null are kept apart on purpose — collapsing them
   * would make every internal-only change look unfinished.
   *
   * The three are not equally durable under concurrency. Going back to absent
   * deletes the key, which takes back only the value the deleting replica has
   * already seen, so a concurrent write of `null` or a sentence outlives it and
   * both replicas converge on that write. `null` and a sentence compete
   * normally, converging on one of the two.
   */
  changelogSuggestion?: string | null;
  /** The record shape. Absent means an ordinary document. */
  kind?: DocumentKind;
  /** The lifecycle state, present only when it is legal for {@link kind}. */
  status?: DocumentStatus;
  /** Outbound links, by target document UUID. Never paths or titles. */
  links: string[];
}

/**
 * One entry of a document's decision log — a reference to a decision document,
 * resolved against the directory.
 *
 * The reference is the record, so a uuid whose document is missing or archived
 * is still reported, flagged unavailable. Dropping it would forget that the
 * decision governed this document at all, which is the one thing the log exists
 * to remember.
 */
export interface DecisionReference {
  /** The referenced document's uuid, lowercase. */
  uuid: string;
  /** Its title, from the directory stub. Null when no stub was resolvable. */
  title: string | null;
  /** Its cached lifecycle state, null when unknown. */
  status: DocumentStatus | null;
  /** True only where the directory carries a live, untombstoned entry. */
  available: boolean;
}

export interface AnnotationComment {
  author: string;
  text: string;
  /** ISO-8601 timestamp. */
  createdAt: string;
}

/**
 * One annotation thread as a reader sees it: the materialised view of the
 * thread's own Y.Map in the `annotations` Y.Map, with the comments Yjs holds
 * nested inside it flattened into a plain array. Reading this shape is not
 * writing it — `annotations.ts` owns the stored layout and the rules that come
 * with it.
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
  /** Stored catalog UUIDs, or provisional strings awaiting the clean cut. */
  tags: string[];
  deleted?: boolean;
  /**
   * When the document was created, epoch ms on the creating replica's clock.
   * Absent for stubs written before the field existed, until something
   * backfills them.
   */
  createdAt?: number;
  /**
   * When a replica authored a document change, epoch ms on that replica's
   * clock. Concurrent candidates resolve to the greater finite stamp. Coarse
   * by design and cache-quality: a freshness hint to sort by, never history.
   * Absent until something stamps it.
   */
  updatedAt?: number;
  /**
   * The document's description, mirrored here like the title so a listing can
   * answer with it without opening a single room. `meta.description` in the
   * document is authoritative; this is a cache repaired on write and on
   * connect. Absent when the document has none.
   */
  description?: string;
  /** Cached record shape; absent means an ordinary document. */
  kind?: DocumentKind;
  /** Cached lifecycle state, present only when it is legal for {@link kind}. */
  status?: DocumentStatus;
}

/** One canonical entry in the workspace's tag catalog. */
export interface TagCatalogEntry {
  /** Stable canonical UUID. A converged duplicate identity resolves to this one. */
  id: string;
  /** Validated human-facing name. It is display data, never document identity. */
  name: string;
  /** Retired entries remain visible on documents but cannot be newly assigned. */
  state: "active" | "retired";
}

/** A stored catalog UUID this replica cannot resolve from its current catalog. */
export interface UnresolvedTagAssignment {
  id: string;
  /** No display name is available until the catalog entry hydrates. */
  name: null;
  state: "unresolved";
}

/** One stored tag assignment as the current catalog replica can read it. */
export type TagAssignment = TagCatalogEntry | UnresolvedTagAssignment;

/** One group in the sidebar doc: a stable id, a name, and what it pins. */
export interface SidebarGroup {
  id: string;
  name: string;
  /** Pinned document uuids, in stored order. */
  docs: string[];
}

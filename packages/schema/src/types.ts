import type { FigmaFields } from "./providers/figma.js";

/** Block types. The set is closed; a block type is a Y.XmlElement nodeName. */
export const BLOCK_TYPES = [
  "paragraph",
  "heading",
  "code",
  "list-item",
  "quote",
  "callout",
  "table",
  "terminal",
  "chart",
  "card",
  "figma",
  "divider",
] as const;

export type BlockType = (typeof BLOCK_TYPES)[number];

export type HeadingLevel = 1 | 2 | 3 | 4 | 5 | 6;

export function isBlockType(value: string): value is BlockType {
  return (BLOCK_TYPES as readonly string[]).includes(value);
}

/**
 * Prose admits inline marks and Markdown syntax; source blocks admit only comment.
 * Tables, cards and Figma captions admit marks per cell or part, with no block-level offsets.
 * Dividers have no text or marks.
 */
export const PROSE_BLOCK_TYPES = [
  "paragraph",
  "heading",
  "list-item",
  "quote",
  "callout",
] as const;

export type ProseBlockType = (typeof PROSE_BLOCK_TYPES)[number];

export function isProseBlockType(value: string): value is ProseBlockType {
  return (PROSE_BLOCK_TYPES as readonly string[]).includes(value);
}

export const CALLOUT_VARIANTS = ["note", "tip", "important", "warning", "caution"] as const;

export type CalloutVariant = (typeof CALLOUT_VARIANTS)[number];

/**
 * A list is adjacent flat list-item blocks; no list container node is stored.
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
 * Closed Yjs formatting keys, matching editor mark names. comment is an anchor,
 * excluded from formatting; it alone is allowed on source blocks. Use inlineCode
 * because ProseMirror disallows a node and mark sharing the name code.
 */
export const INLINE_MARKS = [
  "bold",
  "italic",
  "strike",
  "inlineCode",
  "link",
  "docLink",
] as const;

/**
 * Flags and disjoint link targets for one run. Writers refuse link/docLink
 * pairs; merged pairs read as docLink (see marks.ts).
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
 * Read attributes appear only for their type: heading level, code language
 * (empty if unset), list-item list/indent, or callout variant/icon.
 */
export interface Block {
  id: string;
  type: BlockType;
  /**
   * Prose is plain text, marks excluded. Tables, cards and Figma blocks are
   * canonical Markdown projections from cell or part text and inline marks.
   * Dividers always project empty text, including after writes by older clients.
   */
  text: string;
  /**
   * Type/text/attribute hash for the local-replica edit guard; see rev.ts.
   */
  rev: string;
  level?: HeadingLevel;
  language?: string;
  /** List items only: the marker their run is written with. */
  list?: ListStyle;
  /** List items only: nesting depth, 0–3. */
  indent?: ListIndent;
  /** Callouts only: the display variant, defaulting to note. */
  variant?: CalloutVariant;
  /** Callouts only: a valid stored override of the variant's default icon. */
  icon?: string;
  /** Figma blocks only: read-only view identity derived from the stored link. */
  figma?: FigmaFields;
}

/** The shape accepted when creating a block. */
export interface BlockInput {
  type: BlockType;
  /** Dividers accept only empty text and empty inline runs. */
  text?: string;
  /** Headings only. Defaults to 1. Ignored for other types. */
  level?: HeadingLevel;
  /** Code blocks only, e.g. "ts". Ignored for other types. */
  language?: string;
  /** List items only. Defaults to "bullet". Ignored for other types. */
  list?: ListStyle;
  /** List items only. Clamped to 0–3, defaults to 0. Ignored for other types. */
  indent?: number;
  /** Callouts only. Defaults to note. Ignored for other types. */
  variant?: CalloutVariant;
  /** Callouts only: one emoji or a curated :name: icon. Ignored for other types. */
  icon?: string;
  /**
   * Overrides text for prose only; callers setting both must keep them consistent.
   * Source blocks ignore it. Tables, cards and Figma blocks use Markdown from text instead.
   */
  inline?: InlineRun[];
}

/**
 * Listing-description ceiling, not a target; the text is for agents' discovery, so terms beat prose.
 */
export const MAX_DESCRIPTION_LENGTH = 300;

/** Ceiling for a person-facing summary of one or two plain-English sentences. */
export const MAX_TLDR_LENGTH = 300;

/** The document shapes whose lifecycle the schema records. */
export const DOCUMENT_KINDS = ["decision"] as const;
export type DocumentKind = (typeof DOCUMENT_KINDS)[number];

/** The states of a decision record, in lifecycle order. */
export const DECISION_STATUSES = ["open", "decided", "rejected", "withdrawn"] as const;
export type DecisionStatus = (typeof DECISION_STATUSES)[number];

export type DocumentStatus = DecisionStatus;

export function isDocumentKind(value: unknown): value is DocumentKind {
  return value === "decision";
}

/** Whether `status` belongs to `kind`'s closed lifecycle. */
export function isDocumentStatusForKind(
  kind: DocumentKind,
  status: unknown,
): status is DocumentStatus {
  return kind === "decision" && DECISION_STATUSES.some((candidate) => candidate === status);
}

/**
 * Drop malformed or mismatched status without hiding a valid kind, in both
 * document metadata and directory stubs.
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

export interface CodeCheck {
  repository: string;
  commit: string;
  /** UTC time recorded by the writing replica. */
  checked_at: string;
  result: "matches" | "ahead" | "drift";
  /** Page content revision compared by the checker; absent on legacy entries. */
  rev?: string;
  /** Repository-relative hints, not a complete dependency list. */
  paths?: string[];
}

export type CodeCheckInput = Omit<CodeCheck, "checked_at">;

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
   * Null if unwritten: the web allows it, while MCP create_doc requires one.
   */
  description: string | null;
  /**
   * Optional for additive consumers; getMeta normalizes unwritten values to null.
   */
  tldr?: string | null;
  /** Present only for a regular document with no summary on purpose. */
  tldrOptOut?: true;
  /** Latest check per repository; regular document reads include an empty list. */
  code_check?: CodeCheck[];
  /** The record shape. Absent means an ordinary document. */
  kind?: DocumentKind;
  /** The lifecycle state, present only when it is legal for {@link kind}. */
  status?: DocumentStatus;
  /** First related page, retained for older clients. */
  governs?: string;
  /** Regular pages this decision shapes; fixed at creation. */
  related?: string[];
  /** First record's UUID, shared by this topic; immutable after creation. */
  topic?: string;
  /** Earlier decision this decision replaces, by immutable document UUID. */
  supersedes?: string;
  /** Explicit discussion document; null means this record has none. */
  discussion?: string | null;
  /** Whether the answer records an agent's initial stance. */
  agentStance?: boolean;
  /** Person whose answer was recorded. */
  decidedBy?: string;
  /** When the person's answer was given, conventionally ISO-8601. */
  decidedAt?: string;
  /** Where the person's answer was given. */
  decidedWhere?: string;
  /** Approved title, decision line, ordered block text and structured data; a change detector. */
  approvalFingerprint?: string;
  /** Why a person rejected the proposal. */
  rejectionReason?: string;
  /** Outbound links, by target document UUID. Never paths or titles. */
  links: string[];
}

/** The shared, stubs-only answer for a decision topic. */
export interface DecisionTopicResolution {
  topic: string;
  /** First record; absent only where a foreign stub omitted it. */
  first: DirectoryEntry | null;
  /** Record in force, otherwise a pending record, otherwise the first record. */
  representative: DirectoryEntry;
  inForce: DirectoryEntry | null;
  pending: DirectoryEntry[];
  conflicts: DirectoryEntry[];
  superseded: DirectoryEntry[];
  rejected: DirectoryEntry[];
  withdrawn: DirectoryEntry[];
  /** Visible records, with archived intermediates retained separately for graph resolution. */
  records: DirectoryEntry[];
  archivedRecords: DirectoryEntry[];
  allRecords: DirectoryEntry[];
  /** Only the first record's tombstone controls topic visibility. */
  archived: boolean;
}

/** One topic in a regular page's derived decision log. */
export type DecisionReference = DecisionTopicResolution;

/** Display attribution supplied by the writing client, never proof of identity. */
export interface CommentAttribution {
  kind: "person" | "agent";
  account?: string;
  principalId?: string;
  agent?: "claude" | "codex";
}

export interface AnnotationComment extends Partial<CommentAttribution> {
  author: string;
  text: string;
  /** ISO-8601 timestamp. */
  createdAt: string;
  /** ISO-8601 timestamp of the latest edit, when present and valid. */
  editedAt?: string;
}

/**
 * Materialized read, not the stored write shape; annotations.ts owns the nested
 * Y.Map/Y.Array layout. Positions live in text marks, never in this thread value.
 */
export interface Annotation {
  id: string;
  blockId: string;
  comments: AnnotationComment[];
  resolved?: boolean;
}

/**
 * Shared anchor key, distinct from INLINE_MARKS and allowed on every block type.
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

/** A resolved range inside block, table-cell, card-part or Figma-caption text. */
export interface AnnotationRange {
  /** Structured prose part; absent for prose and table ranges. */
  part?: "label" | "title" | "body" | "footer" | "caption";
  /** Table-cell coordinates in the GFM projection; absent for prose ranges. */
  row?: number;
  column?: number;
  start: number;
  end: number;
  /**
   * Foreign zero-length span. Local full deletions lose the mark and resolve to null.
   */
  collapsed: boolean;
}

/** An entry in the directory doc: a discovery stub for one document. */
export interface DirectoryEntry {
  uuid: string;
  title: string;
  /** Catalog tag UUIDs, or provisional name strings that catalog-aware reads omit. */
  tags: string[];
  deleted?: boolean;
  /** Effective individual record archive, derived independently of replaceable stubs. */
  recordArchived?: true;
  /**
   * Epoch ms on the creating replica's clock; absent until supplied or backfilled.
   */
  createdAt?: number;
  /**
   * Authoring replica's epoch ms; greater finite concurrent stamps win. A coarse
   * freshness hint, never history; absent until stamped.
   */
  updatedAt?: number;
  /**
   * Listing cache of authoritative meta.description, repaired on write/connect.
   * Absent when the document has no description.
   */
  description?: string;
  /** Cached record shape; absent means an ordinary document. */
  kind?: DocumentKind;
  /** Cached lifecycle state, present only when it is legal for {@link kind}. */
  status?: DocumentStatus;
  /** Cached unresolved thread count; absent when the cache is unknown. */
  openThreadCount?: number;
  /** Regular-only check cache; absence means it has not been cached yet. */
  code_check?: CodeCheck[];
  /** Decision-only metadata caches. Other document kinds carry none of these. */
  governs?: string;
  related?: string[];
  topic?: string;
  supersedes?: string;
  /** Explicit discussion; absence means an older client has not cached it. */
  discussion?: string | null;
  /** Derived answer text; absence means an older client has not cached it. */
  answerPreview?: string | null;
  agentStance?: boolean;
  decidedBy?: string;
  decidedAt?: string;
  /** Whether approved content differs from the recorded approval. */
  approvalChanged?: boolean;
  commentCount?: number;
}

/** One canonical entry in the workspace's tag catalog. */
export interface TagCatalogEntry {
  /** Stable canonical UUID. A converged duplicate identity resolves to this one. */
  id: string;
  /** Validated human-facing name. It is display data, never document identity. */
  name: string;
  /** Optional one-line explanation of this workspace-specific purpose. */
  description?: string;
}

/** Only existing catalog entries are exposed as document assignments. */
export type TagAssignment = TagCatalogEntry;

/** One group in the sidebar doc: a stable id, a name, and what it pins. */
export interface SidebarGroup {
  id: string;
  name: string;
  /** Pinned document uuids, in stored order. */
  docs: string[];
}

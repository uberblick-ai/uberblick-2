/**
 * The vocabulary of the uberblick document model.
 *
 * Terminology is stable and shared by every package: block, block id, block
 * type, annotation thread, directory entry.
 */

/** Block types. The set is closed; a block type is a Y.XmlElement nodeName. */
export const BLOCK_TYPES = ["paragraph", "heading", "code", "mermaid"] as const;

export type BlockType = (typeof BLOCK_TYPES)[number];

export type HeadingLevel = 1 | 2 | 3 | 4 | 5 | 6;

export function isBlockType(value: string): value is BlockType {
  return (BLOCK_TYPES as readonly string[]).includes(value);
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
  /** The block's plain-text source. Rich blocks render this; they do not replace it. */
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

/** The value of a `comment` mark: ProseMirror-shaped mark attributes. */
export interface CommentMark {
  threadId: string;
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

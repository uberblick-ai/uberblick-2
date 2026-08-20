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
 * `anchor` and `head` are base64-encoded Yjs RelativePositions pointing into
 * the anchored block's Y.XmlText, so they survive concurrent edits.
 */
export interface Annotation {
  id: string;
  blockId: string;
  anchor: string;
  head: string;
  comments: AnnotationComment[];
  resolved?: boolean;
}

/** A resolved absolute range inside a block's text. */
export interface AnnotationRange {
  start: number;
  end: number;
  /** True when the annotated text is gone and the range collapsed to a point. */
  collapsed: boolean;
}

/** An entry in the directory doc: a discovery stub for one document. */
export interface DirectoryEntry {
  uuid: string;
  title: string;
  tags: string[];
  deleted?: boolean;
}

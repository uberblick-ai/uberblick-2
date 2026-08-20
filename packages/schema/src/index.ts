/**
 * @uberblick/schema — the keystone package.
 *
 * Owns the Y.Doc layout for an uberblick document:
 *   - `meta`        Y.Map: uuid, title, tags, links-by-UUID
 *   - `blocks`      Y.XmlFragment: one Y.XmlElement per block, each holding a
 *                   single Y.XmlText of plain-text source
 *                   (types: paragraph, heading, code, mermaid)
 *   - `annotations` Y.Map of threads anchored via Yjs relative positions
 *
 * …plus the directory doc (room `_directory`) that makes discovery a synced doc,
 * and one-way markdown export.
 *
 * Runtime dependencies are limited to `yjs` and `fast-diff`.
 *
 * Two rules hold everywhere: identity is UUIDs (titles and paths are display
 * data), and writes are block-scoped. There is no whole-document replace, by
 * construction — see `blocks.ts`.
 */

export {
  ANNOTATIONS_KEY,
  BLOCKS_KEY,
  META_KEY,
  getAnnotationsMap,
  getBlocksFragment,
  getMeta,
  getMetaMap,
  initDoc,
  setLinks,
  setTags,
  setTitle,
} from "./doc.js";
export type { InitDocOptions } from "./doc.js";

export {
  appendBlock,
  deleteBlock,
  editBlock,
  getBlock,
  getBlockText,
  getBlocks,
  insertBlock,
  setBlockLanguage,
  setBlockLevel,
} from "./blocks.js";

export {
  addComment,
  createAnnotation,
  deleteAnnotation,
  getAnnotation,
  listAnnotations,
  listAnnotationsForBlock,
  resolveAnnotationRange,
  setAnnotationResolved,
} from "./annotations.js";

export { exportMarkdown, importMarkdown } from "./markdown.js";
export type {
  ExportMarkdownOptions,
  ImportedBlock,
  ImportedDoc,
} from "./markdown.js";

export {
  DIRECTORY_DOCS_KEY,
  DIRECTORY_ROOM,
  getDirectoryEntry,
  getDirectoryMap,
  listDirectory,
  tombstoneDirectoryEntry,
  upsertDirectoryEntry,
} from "./directory.js";
export type { DirectoryUpsert, ListDirectoryOptions } from "./directory.js";

export { BlockNotFoundError, StaleBlockError } from "./errors.js";

export { BLOCK_TYPES, isBlockType } from "./types.js";
export type {
  Annotation,
  AnnotationComment,
  AnnotationRange,
  Block,
  BlockInput,
  BlockType,
  DirectoryEntry,
  DocMeta,
  HeadingLevel,
} from "./types.js";

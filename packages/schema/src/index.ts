/**
 * @uberblick/schema — the keystone package.
 *
 * Owns the Y.Doc layout for an uberblick document:
 *   - `meta`        Y.Map: uuid, title, tags, links-by-UUID
 *   - `blocks`      Y.XmlFragment: one Y.XmlElement per block, each holding a
 *                   single Y.XmlText of plain-text source
 *                   (types: paragraph, heading, code, mermaid, list-item,
 *                   quote), formatted by the closed inline-mark set (bold,
 *                   italic, strike, inlineCode, link) on prose blocks
 *   - `annotations` Y.Map of thread JSON, anchored by `comment` formatting
 *                   marks on the block's text
 *
 * …plus workspace ids (a uuid, optionally slug-decorated for display), room
 * names (`<workspaceId>/<uuid>`), the directory doc that makes discovery a
 * synced doc, the sidebar doc that makes curation one, and one-way markdown
 * export.
 *
 * Runtime dependencies are limited to `yjs` and `fast-diff`.
 *
 * Three rules hold everywhere: identity is UUIDs (titles and paths are display
 * data); writes are block-scoped, so there is no whole-document replace, by
 * construction; and a block's type changes only through `setBlockType`, which
 * keeps the id and the text delta.
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
  getBlockInline,
  getBlockRev,
  getBlockText,
  getBlocks,
  insertBlock,
  repairDuplicateBlocks,
  setBlockLanguage,
  setBlockLevel,
  setBlockType,
} from "./blocks.js";
export type { BlockTypeAttrs, EditBlockOptions } from "./blocks.js";

export { isExternalHref, readsAsMark } from "./marks.js";

export { blockRev } from "./rev.js";
export type { RevInput } from "./rev.js";

export {
  COMMENT_MARK,
  addComment,
  createAnnotation,
  deleteAnnotation,
  getAnnotation,
  listAnnotationRanges,
  listAnnotations,
  listAnnotationsForBlock,
  resolveAnnotationRange,
  setAnnotationResolved,
} from "./annotations.js";
export type { CommentRun } from "./annotations.js";

export { listNumbers } from "./lists.js";
export type { ListMarkerInput } from "./lists.js";

export { exportMarkdown, importMarkdown } from "./markdown.js";
export type {
  ExportMarkdownOptions,
  ImportedBlock,
  ImportedDoc,
} from "./markdown.js";

export {
  DIRECTORY_SUFFIX,
  SIDEBAR_SUFFIX,
  directoryRoom,
  parseRoom,
  roomForDoc,
  sidebarRoom,
} from "./rooms.js";
export type { ParsedRoom } from "./rooms.js";

export { parseWorkspaceId } from "./workspace.js";
export type { WorkspaceId } from "./workspace.js";

export {
  SIDEBAR_FLAGS_KEY,
  SIDEBAR_GROUPS_KEY,
  SIDEBAR_ORDER_KEY,
  SIDEBAR_UNPINNED_KEY,
  createGroup,
  deleteGroup,
  getSidebarFlags,
  getSidebarGroups,
  getSidebarOrder,
  getSidebarUnpinned,
  isSidebarSeeded,
  markSidebarSeeded,
  moveDoc,
  moveGroup,
  pinDoc,
  readSidebar,
  renameGroup,
  unpinDoc,
} from "./sidebar.js";

export {
  DIRECTORY_DOCS_KEY,
  getDirectoryEntry,
  getDirectoryMap,
  listDirectory,
  restoreDirectoryEntry,
  tombstoneDirectoryEntry,
  upsertDirectoryEntry,
} from "./directory.js";
export type { DirectoryUpsert, ListDirectoryOptions } from "./directory.js";

export {
  AnnotationRangeError,
  BlockNotFoundError,
  InvalidLinkHrefError,
  InvalidRoomError,
  InvalidWorkspaceIdError,
  MarksNotAllowedError,
  StaleBlockError,
} from "./errors.js";
export type {
  AnnotationRangeErrorReason,
  StaleBlockDetails,
} from "./errors.js";

export {
  BLOCK_TYPES,
  INLINE_MARKS,
  LIST_STYLES,
  MAX_LIST_INDENT,
  PROSE_BLOCK_TYPES,
  isBlockType,
  isInlineMark,
  isListStyle,
  isProseBlockType,
} from "./types.js";
export type {
  Annotation,
  AnnotationComment,
  AnnotationRange,
  Block,
  BlockInput,
  BlockType,
  CommentMark,
  DirectoryEntry,
  DocMeta,
  HeadingLevel,
  InlineMarkName,
  InlineMarkSet,
  InlineRun,
  ListIndent,
  ListStyle,
  ProseBlockType,
  SidebarGroup,
} from "./types.js";

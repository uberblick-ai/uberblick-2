/**
 * @uberblick/schema — the keystone package.
 *
 * Owns the Y.Doc layout for an uberblick document:
 *   - `meta`        Y.Map: uuid, title, description, TL;DR, changelog suggestion,
 *                        `tag-assigned:<identity>` presence entries,
 *                        links-by-UUID, kind, status, supersedes and internal
 *                        decision remove/add levels
 *   - `blocks`      Y.XmlFragment: one Y.XmlElement per block, each holding a
 *                   single Y.XmlText of plain-text source
 *                   (types: paragraph, heading, code, mermaid, list-item,
 *                   quote, table, terminal), formatted by the closed inline-mark set
 *                   (bold, italic, strike, inlineCode, link, docLink) on
 *                   prose blocks
 *   - `annotations` Y.Map of one Y.Map per thread — anchor, resolved flag and
 *                   the conversation as a nested Y.Array — anchored by
 *                   `comment` formatting marks on the block's text
 *   - `decisions`   Y.Array of decision-document uuids: the ordered log of
 *                   which decisions govern this document
 *
 * …plus workspace ids (a uuid, optionally slug-decorated for display), room
 * names (`<workspaceId>/<uuid>`), the directory doc that makes discovery a
 * synced doc, the sidebar doc that makes curation one, the settings doc that
 * owns the workspace tag catalog, and one-way markdown export.
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
  DECISIONS_KEY,
  META_KEY,
  addDecision,
  getAnnotationsMap,
  getBlocksFragment,
  getDecisionsArray,
  getMeta,
  getMetaMap,
  initDoc,
  readDecisions,
  removeDecision,
  reorderDecisions,
  setChangelogSuggestion,
  setDescription,
  setTldr,
  setKind,
  setLinks,
  setStatus,
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
  getBlocksWithInline,
  insertBlock,
  repairDuplicateBlocks,
  setBlockLanguage,
  setBlockLevel,
  setBlockType,
  setInlineLink,
} from "./blocks.js";
export type {
  BlockTypeAttrs,
  EditBlockOptions,
  InlineLinkRange,
  SetInlineLinkOptions,
} from "./blocks.js";

export { isDocId, isExternalHref, readsAsMark } from "./marks.js";

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

export { parseGfmTable } from "./table.js";
export type { ColumnAlign, GfmTable } from "./table.js";

export { exportMarkdown, importMarkdown } from "./markdown.js";
export type {
  ExportMarkdownOptions,
  ImportedBlock,
  ImportedDoc,
} from "./markdown.js";

export {
  DIRECTORY_SUFFIX,
  SETTINGS_SUFFIX,
  SIDEBAR_SUFFIX,
  assertCanonicalRoom,
  canonicalDocumentUuid,
  directoryRoom,
  isCanonicalRoom,
  parseRoom,
  roomForDoc,
  settingsRoom,
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
  getOrCreateGroup,
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
  EXAMPLE_TAGS,
  MAX_TAG_NAME_LENGTH,
  TAG_CATALOG_FLAGS_KEY,
  TAG_CATALOG_IDENTITIES_KEY,
  TAG_CATALOG_RESTORED_KEY,
  TAG_CATALOG_RETIRED_KEY,
  assignDocumentTags,
  createTagCatalogEntry,
  getTagCatalogEntry,
  getTagCatalogFlags,
  getTagCatalogIdentities,
  isTagCatalogSeeded,
  isTagName,
  listTagCatalog,
  readDirectoryTags,
  readDocumentTags,
  resolveTagAssignments,
  restoreTagCatalogEntry,
  retireTagCatalogEntry,
  seedTagCatalog,
} from "./tags.js";

export {
  AnnotationRangeError,
  BlockNotFoundError,
  ConflictingLinkMarksError,
  InvalidDecisionReferenceError,
  InvalidDocumentLifecycleError,
  InvalidSupersedesReferenceError,
  InvalidTagAssignmentError,
  InvalidTagIdentityError,
  InvalidTagNameError,
  InlineLinkRangeError,
  InvalidDocLinkTargetError,
  InvalidLinkHrefError,
  InvalidRoomError,
  InvalidWorkspaceIdError,
  MarksNotAllowedError,
  OldTextMismatchError,
  StaleBlockError,
} from "./errors.js";
export type {
  AnnotationRangeErrorReason,
  DecisionReferenceErrorReason,
  SupersedesReferenceErrorReason,
  InlineLinkRangeErrorReason,
  OldTextMismatchDetails,
  StaleBlockDetails,
  InvalidTagIdentityReason,
} from "./errors.js";

export {
  BLOCK_TYPES,
  DECISION_STATUSES,
  DOCUMENT_KINDS,
  INLINE_MARKS,
  LIST_STYLES,
  MAX_DESCRIPTION_LENGTH,
  MAX_TLDR_LENGTH,
  MAX_LIST_INDENT,
  PROSE_BLOCK_TYPES,
  REQUIREMENT_STATUSES,
  isDocumentKind,
  isDocumentStatusForKind,
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
  DecisionReference,
  DirectoryEntry,
  DecisionStatus,
  DocMeta,
  DocumentKind,
  DocumentStatus,
  HeadingLevel,
  InlineMarkName,
  InlineMarkSet,
  InlineRun,
  ListIndent,
  ListStyle,
  ProseBlockType,
  RequirementStatus,
  SidebarGroup,
  TagAssignment,
  TagCatalogEntry,
  UnresolvedTagAssignment,
} from "./types.js";

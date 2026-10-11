/** Schema runtime primitives remain limited to Yjs and fast-diff. */

export {
  ANNOTATIONS_KEY,
  BLOCKS_KEY,
  META_KEY,
  getAnnotationsMap,
  getBlocksFragment,
  getMeta,
  getMetaMap,
  initDoc,
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
  DATA_KEY, DATA_LIMITS, applyDocData, getDocDataEntries, hasDocData, readDocData, summarizeDocData,
} from "./data.js";
export type { DataCollection, DataIssue, DataOperation, DataRecord, DocData } from "./data.js";
export { DataError, canonicalJson, compareCodePoints, validateCollectionSchema, validateDataRecord } from "./data-schema.js";
export type { CollectionSchema, DataSchema, JSONObject, JSONValue } from "./data-schema.js";
export { decisionRelations, readDecisions, resolveDecisionTopics } from "./decisions.js";
export { decisionApprovalChanged, decisionApprovalFingerprint } from "./approval.js";

export {
  appendBlock,
  deleteBlock,
  editBlock,
  findBlockElement,
  getBlock,
  getBlockInline,
  getBlockRev,
  getBlockText,
  getBlocks,
  getBlocksWithInline,
  insertBlock,
  normalizeLegacyTables,
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

export {
  TABLE_CELL_MARKS, buildTableCell, buildTableElement, buildTableRow,
  isSupportedTable, parseGfmTable, parseTableInput, parseTableCell, plainXmlText,
  seedNewTableCells, tableCellText, tableCellTexts, tableRows, tableText, writeGfmTable,
} from "./table.js";
export type { ColumnAlign, GfmTable, TableMapping } from "./table.js";

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
  MAX_WORKSPACE_NAME_LENGTH,
  WORKSPACE_SETTINGS_KEY,
  getWorkspaceName,
  setWorkspaceName,
  validateWorkspaceName,
} from "./workspace-settings.js";

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
  unpinDocIncludingUnseen,
} from "./sidebar.js";

export {
  DIRECTORY_DOCS_KEY,
  decisionDirectoryFields,
  decisionTopicArchived,
  directoryStubDiffers,
  getDirectoryEntry,
  getDirectoryMap,
  listDirectory,
  restoreDirectoryEntry,
  tombstoneDirectoryEntry,
  upsertDirectoryEntry,
} from "./directory.js";
export type { DecisionDirectoryFields, DirectoryUpsert, ListDirectoryOptions } from "./directory.js";

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
  AnnotationCellError,
  AnnotationRangeError,
  BlockNotFoundError,
  ConflictingLinkMarksError,
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
  InvalidTableError,
  InvalidTableMappingError,
  TableMappingRequiredError,
  TableAnnotationError,
} from "./errors.js";
export type {
  AnnotationRangeErrorReason,
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
  DecisionTopicResolution,
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

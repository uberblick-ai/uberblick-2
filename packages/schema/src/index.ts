/** Schema runtime primitives remain limited to Yjs and fast-diff. */

export {
  decisionContentLocked,
  getAnnotationsMap,
  getBlocksFragment,
  getMeta,
  getMetaMap,
  initDoc,
  isCodeCheckOnlyTransaction,
  setCodeCheck,
  setDescription,
  setDiscussion,
  setTldr,
  setTldrOptOut,
  setKind,
  setLinks,
  setStatus,
  setTags,
  setTitle,
} from "./doc.js";
export { CODE_CHECK_RESULTS, normalizeCodeCheck } from "./code-check.js";
export {
  DATA_KEY, DATA_LIMITS, applyDocData, prepareDocData, getDocDataEntries, readDocData, summarizeDocData,
} from "./data.js";
export type { DataCollection, DataCollectionChange, DataOperation, DataRecord, DocData } from "./data.js";
export { DataError, canonicalJson, compareCodePoints, validateCollectionSchema } from "./data-schema.js";
export type { CollectionSchema, DataSchema, JSONObject, JSONValue } from "./data-schema.js";
export { decisionCurrentRecord, decisionRelations, decisionTopicState, decisionTopicTitle, readDecisions, relatedDecisionTopics, resolveDecisionTopics } from "./decisions.js";
export type { DecisionTopicState } from "./decisions.js";
export {
  decisionAnswerFailure, decisionAnswerShapeFailure, decisionDocAnswerFailure,
} from "./decision-answer.js";
export { decisionApprovalChanged, decisionApprovalFingerprint } from "./approval.js";
export { archiveDecisionRecord, archiveDocument } from "./lifecycle.js";

export {
  appendBlock,
  deleteBlock,
  docRev,
  editBlock,
  findBlockElement,
  getBlock,
  getBlockInline,
  getBlockRev,
  getBlocks,
  getBlocksWithInline,
  insertBlock,
  moveBlocks,
  normalizeLegacyTables,
  observeDocRev,
  removeLegacyMermaidBlocks,
  repairDuplicateBlocks,
  setInlineLink,
} from "./blocks.js";

export { EXTERNAL_HREF, isDocId, isExternalHref, readsAsMark } from "./marks.js";
export { readSyncedDocId } from "./synced-doc-id.js";
export { githubItemUrl, githubReference, githubRepository } from "./github-reference.js";
export type { GitHubItem } from "./github-reference.js";
export { INLINE_ICONS } from "./inline-icons.js";
export type { InlineIconName } from "./inline-icons.js";

export { blockRev } from "./rev.js";
export type { RevInput } from "./rev.js";

export { compareRevisions } from "./revisions.js";
export { snapshotRevision } from "./revision-snapshot.js";
export type { RevisionSnapshot } from "./revision-snapshot.js";
export { encodeRevisionRequest, readRevisionRequest, encodeRevisionResponse, encodeRevisionResponseFrames,
  readRevisionResponse, createRevisionResponseReader } from "./revision-protocol.js";
export { validRevisionName } from "./revision-protocol.js";
export type { RevisionEntry, RevisionName, RevisionRequest, RevisionResponse } from "./revision-protocol.js";
export type {
  RevisionBlockComparison, RevisionChangeKind, RevisionCollectionComparison,
  RevisionComparison, RevisionFieldComparison, RevisionRecordComparison,
} from "./revisions.js";
export type { RevisionCellComparison, RevisionRowComparison } from "./revision-blocks.js";
export type { TextSpan } from "./revision-sequence.js";

export {
  COMMENT_MARK,
  addComment,
  annotationAnchors,
  createAnnotation,
  getAnnotation,
  listAnnotationRanges,
  listAnnotations,
  moveAnnotation,
  resolveAnnotationAnchors,
  resolveAnnotationRange,
  setAnnotationResolved,
} from "./annotations.js";
export type { AnnotationAnchor } from "./annotations.js";

export { listNumbers } from "./lists.js";
export type { ListMarkerInput } from "./lists.js";

export { INLINE_PART_MARKS, plainXmlText, seedNewInlineParts, structuredInlineParts } from "./inline-parts.js";
export type { StructuredInlinePart } from "./inline-parts.js";

export {
  TABLE_CELL_MARKS,
  isSupportedTable, isSupportedColumnWidth, parseGfmTable, parseTableInput, parseTableCell,
  seedNewTableCells, tableCellText, tableCellTexts, tableRows, tableText, writeGfmTable,
} from "./table.js";
export type { GfmTable, TableMapping } from "./table.js";

export {
  CARD_PARTS, CARD_NODE_NAMES, CARD_BUTTON_STYLES, CARD_BUTTON_COLORS, cardButtons, cardPartElement,
  cardPartTexts, isCardButtonHref, isSupportedCard, parseCardButtons, parseCardInput,
  seedNewCardParts, writeCardButton, writeCardButtons,
} from "./card.js";
export type { CardButton, CardButtonStyle, CardButtonColor, CardPart } from "./card.js";
export {
  FIGMA_DEFAULT_HEIGHT, FIGMA_MAX_HEIGHT, FIGMA_MIN_HEIGHT,
  figmaCaptionElement, figmaCaptionTexts,
  isSupportedFigma, parseFigmaHeight, parseFigmaInput,
  seedNewFigmaCaptions,
} from "./figma.js";
export { FIGMA_PROVIDER, normalizeFigmaLink } from "./providers/figma.js";

export { exportMarkdown, importMarkdown, parseInline } from "./markdown.js";
export type {
  ImportedBlock,
  ImportedDoc,
} from "./markdown.js";

export {
  DIRECTORY_SUFFIX,
  MAX_ROOM_NAME_LENGTH,
  SETTINGS_SUFFIX,
  SIDEBAR_SUFFIX,
  canonicalDocumentUuid,
  directoryRoom,
  isCanonicalRoom,
  isRoomNameWithinBounds,
  parseRoom,
  roomForDoc,
  settingsRoom,
  sidebarRoom,
} from "./rooms.js";

export { isUuid, parseWorkspaceId } from "./workspace.js";

export {
  WORKSPACE_SETTINGS_KEY,
  getWorkspaceMainRepository,
  getWorkspaceName,
  setWorkspaceMainRepository,
  setWorkspaceName,
  validateWorkspaceName,
} from "./workspace-settings.js";

export {
  createGroup,
  deleteGroup,
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
  DIRECTORY_DELETED_KEY,
  DIRECTORY_ARCHIVED_RECORDS_KEY,
  DIRECTORY_RELATED_PAGES_KEY,
  compareDirectoryEntries,
  deleteDirectoryEntry,
  enforceDeletedDirectoryEntries,
  decisionDirectoryFields,
  decisionTopicArchived,
  directoryStubDiffers,
  documentDirectoryFields,
  documentStubFields,
  getDirectoryEntry,
  getDirectoryMap,
  isDirectoryEntryArchived,
  isDirectoryEntryDeleted,
  listDeletedDirectoryUuids,
  listDirectory,
  repairDirectoryStub,
  restoreDirectoryEntry,
  tombstoneDecisionRecord,
  tombstoneDirectoryEntry,
  upsertDirectoryEntry,
  UPDATED_AT_COARSENESS_MS,
} from "./directory.js";

export {
  EXAMPLE_TAGS,
  MAX_TAG_NAME_LENGTH,
  assignDocumentTags,
  cleanupDeletedDocumentTags,
  createTagCatalogEntry,
  deleteTagCatalogEntry,
  getTagCatalogEntry,
  getTagCatalogFlags,
  getTagCatalogIdentities,
  isTagCatalogSeeded,
  isTagDeleted,
  isTagName,
  listTagCatalog,
  listDeletedTagCatalogEntries,
  migrateRetiredTagCatalogEntries,
  readDirectoryTags,
  readDocumentTags,
  resolveTagAssignments,
  setTagCatalogDescription,
  seedTagCatalog,
} from "./tags.js";

export {
  AnnotationCellError,
  AnnotationRangeError,
  BlockNotFoundError,
  InvalidBlockMoveError,
  ConflictingLinkMarksError,
  InvalidDocumentLifecycleError,
  InvalidTagAssignmentError,
  InvalidTagDescriptionError,
  InlineLinkRangeError,
  InvalidListAttributesError,
  InvalidWorkspaceIdError,
  OldTextMismatchError,
  SchemaError,
  StaleBlockError,
  InvalidTableError,
  InvalidCardError,
  InvalidFigmaError,
  InvalidTableMappingError,
  TableMappingRequiredError,
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
  isDocumentStatusForKind,
  isBlockType,
  isProseBlockType,
} from "./types.js";
export type {
  Annotation,
  AnnotationComment,
  Block,
  BlockInput,
  BlockType,
  CommentMark,
  CodeCheck,
  DecisionTopicResolution,
  DirectoryEntry,
  DecisionStatus,
  DocMeta,
  DocumentKind,
  DocumentStatus,
  HeadingLevel,
  InlineMarkSet,
  InlineRun,
  ListIndent,
  ListStyle,
  SidebarGroup,
  TagAssignment,
  TagCatalogEntry,
} from "./types.js";
export { encodeOriginUpdate, readOriginUpdate, encodeOriginAck, readOriginAck } from "./origin.js";
export type { UpdateSurface, UpdateOriginMetadata, OriginUpdate, OriginUpdateAck } from "./origin.js";
export { parseJsonSource, formatJsonSource, jsonPathStep, JSON_SOURCE_MAX_DEPTH } from "./json-source.js";
export type { JsonSourceNode, JsonSourceEntry, JsonSourceResult } from "./json-source.js";

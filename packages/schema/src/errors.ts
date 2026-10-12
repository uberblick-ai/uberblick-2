/** Thrown when a block id does not resolve to a live block in the document. */
export class BlockNotFoundError extends Error {
  readonly blockId: string;

  constructor(blockId: string) {
    super(`Block not found: ${blockId}`);
    this.name = "BlockNotFoundError";
    this.blockId = blockId;
  }
}

/** A table write did not contain exactly one supported GFM table. */
export class InvalidTableError extends Error {
  constructor() {
    super("Table text must be exactly one GFM table");
    this.name = "InvalidTableError";
  }
}

/** A card write does not match the closed header and required title grammar. */
export class InvalidCardError extends Error {
  constructor(reason = "A nonempty title is required") {
    super(`Invalid card: ${reason}`);
    this.name = "InvalidCardError";
  }
}

/** Block-level offsets cannot address one of a card's separate prose parts. */
export class CardAnnotationError extends Error {
  readonly blockId: string;
  constructor(blockId: string) {
    super("New comment threads on cards require a part and are available in the web editor");
    this.name = "CardAnnotationError";
    this.blockId = blockId;
  }
}

/** Cards have no sanctioned conversion to or from another block type. */
export class CardConversionError extends Error {
  constructor() {
    super("Cards cannot be converted to or from another block type; insert a new block instead");
    this.name = "CardConversionError";
  }
}

/** Structural or batched table edits need the caller's surviving identities. */
export class TableMappingRequiredError extends Error {
  constructor() {
    super("Table structure or multiple cell changes require a table mapping of surviving old rows and columns");
    this.name = "TableMappingRequiredError";
  }
}

/** The table mapping cannot describe this asserted old and requested new table. */
export class InvalidTableMappingError extends Error {
  constructor(reason: string) {
    super(`Invalid table mapping: ${reason}`);
    this.name = "InvalidTableMappingError";
  }
}

/** Block-level text offsets cannot address a structured table's cell text. */
export class TableAnnotationError extends Error {
  readonly blockId: string;
  constructor(blockId: string) {
    super("New comment threads on tables are unavailable");
    this.name = "TableAnnotationError";
    this.blockId = blockId;
  }
}

/** A new annotation names no usable cell in the table's GFM projection. */
export class AnnotationCellError extends Error {
  readonly reason: "missing" | "not-table" | "out-of-bounds";
  readonly blockId: string;

  constructor(reason: "missing" | "not-table" | "out-of-bounds", blockId: string) {
    super(
      reason === "missing"
        ? "A table comment requires both row and column coordinates"
        : reason === "not-table"
          ? "Row and column coordinates apply only to table comments"
          : "The comment cell is outside the table's GFM projection",
    );
    this.name = "AnnotationCellError";
    this.reason = reason;
    this.blockId = blockId;
  }
}

export interface StaleBlockDetails {
  blockId: string;
  /**
   * Asserted text, absent for rev-only writes such as setInlineLink.
   */
  expectedText?: string | undefined;
  /** The rev the caller asserted, when it passed one. */
  expectedRev?: string | undefined;
  /** The text actually in the document right now. */
  currentText: string;
  /** The content hash of the block right now. */
  currentRev: string;
}

/**
 * Stale rev, or mismatched oldText without a rev to distinguish a bad argument.
 * Current text/rev allow retry without another read. The check prevents
 * overwriting changes already seen locally; it is no cross-replica CAS and
 * cannot detect unseen remote edits, including while this replica is offline.
 */
export class StaleBlockError extends Error {
  readonly blockId: string;
  readonly expectedText: string | undefined;
  readonly expectedRev: string | undefined;
  readonly currentText: string;
  readonly currentRev: string;

  constructor(details: StaleBlockDetails) {
    super(
      `Stale edit for block ${details.blockId}: the block has changed since it was read`,
    );
    this.name = "StaleBlockError";
    this.blockId = details.blockId;
    this.expectedText = details.expectedText;
    this.expectedRev = details.expectedRev;
    this.currentText = details.currentText;
    this.currentRev = details.currentRev;
  }
}

export interface OldTextMismatchDetails {
  blockId: string;
  /** The incorrect text the caller passed as `old_text`. */
  expectedText: string;
  /** The matching rev that establishes which block content the caller meant. */
  expectedRev: string;
  /** The text actually in the document right now. */
  currentText: string;
  /** The content hash of the block right now. */
  currentRev: string;
}

/**
 * Current rev with wrong oldText is an argument mismatch. Current text/rev
 * allow correcting the argument and retrying without another read.
 */
export class OldTextMismatchError extends Error {
  readonly blockId: string;
  readonly expectedText: string;
  readonly expectedRev: string;
  readonly currentText: string;
  readonly currentRev: string;

  constructor(details: OldTextMismatchDetails) {
    super(
      `Old text mismatch for block ${details.blockId}: old_text does not match the current block text`,
    );
    this.name = "OldTextMismatchError";
    this.blockId = details.blockId;
    this.expectedText = details.expectedText;
    this.expectedRev = details.expectedRev;
    this.currentText = details.currentText;
    this.currentRev = details.currentRev;
  }
}

export type AnnotationRangeErrorReason = "empty" | "overlap";

/**
 * Empty spans have no anchor; overlaps would replace another thread's anchor,
 * since Yjs and ProseMirror permit one comment mark per character.
 */
export class AnnotationRangeError extends Error {
  readonly reason: AnnotationRangeErrorReason;
  readonly blockId: string;
  /** For `"overlap"`, the thread already anchored over the requested range. */
  readonly conflictingThreadId: string | undefined;

  constructor(
    reason: AnnotationRangeErrorReason,
    blockId: string,
    conflictingThreadId?: string,
  ) {
    super(
      reason === "empty"
        ? `Cannot annotate an empty range in block ${blockId}`
        : `Range in block ${blockId} already carries thread ${conflictingThreadId ?? "unknown"}`,
    );
    this.name = "AnnotationRangeError";
    this.reason = reason;
    this.blockId = blockId;
    this.conflictingThreadId = conflictingThreadId;
  }
}

/**
 * Refuse before mutation when preserving marks would violate the destination
 * type or editor binding. Source blocks allow only comment; table/flat
 * conversions refuse all marks. Callers can clear named marks before retrying.
 */
export class MarksNotAllowedError extends Error {
  readonly blockId: string;
  /** The block type that cannot hold the marks. */
  readonly blockType: string;
  /** The offending mark names, in the document's order, deduplicated. */
  readonly marks: string[];

  constructor(blockId: string, blockType: string, marks: string[]) {
    super(
      `Block ${blockId} cannot become ${blockType} without dropping marks ` +
        `(${marks.join(", ")}). Clear the marks before changing its type.`,
    );
    this.name = "MarksNotAllowedError";
    this.blockId = blockId;
    this.blockType = blockType;
    this.marks = marks;
  }
}

/**
 * Only http(s) link targets reach the CRDT and its renderers. UUID hrefs are
 * never reinterpreted as docLink; document references use that separate mark.
 */
export class InvalidLinkHrefError extends Error {
  readonly href: string;

  constructor(href: string) {
    super(
      `Not an external link target: ${JSON.stringify(href)}. Inline links are ` +
        `http(s) URLs only; an inline reference to another document is the ` +
        `docLink mark, which carries a document uuid.`,
    );
    this.name = "InvalidLinkHrefError";
    this.href = href;
  }
}

/**
 * Refuse URL, path, title and reserved-room targets before CRDT insertion.
 * Uppercase UUIDs are canonicalized to lowercase so one id has one spelling.
 */
export class InvalidDocLinkTargetError extends Error {
  readonly docId: string;

  constructor(docId: string) {
    super(
      `Not a document reference: ${JSON.stringify(docId)}. A docLink mark ` +
        `carries a document uuid; an external link is the link mark.`,
    );
    this.name = "InvalidDocLinkTargetError";
    this.docId = docId;
  }
}

/**
 * Writers refuse link/docLink pairs. Yjs merges can still produce both keys;
 * readers resolve them as docLink (see marks.ts).
 */
export class ConflictingLinkMarksError extends Error {
  readonly href: string;
  readonly docId: string;

  constructor(href: string, docId: string) {
    super(
      `One range cannot be both an external link (${JSON.stringify(href)}) and ` +
        `a reference to document ${JSON.stringify(docId)}. Write one or the other.`,
    );
    this.name = "ConflictingLinkMarksError";
    this.href = href;
    this.docId = docId;
  }
}

/**
 * Refuse illegal kind/status before either write. Retain unknown values so
 * malformed foreign or stale metadata can also be reported.
 */
export class InvalidDocumentLifecycleError extends Error {
  readonly kind: unknown;
  readonly status: unknown;

  constructor(kind: unknown, status: unknown) {
    super(
      `Invalid document lifecycle: kind=${renderUnknown(kind)} and ` +
        `status=${renderUnknown(status)} are not a legal pair`,
    );
    this.name = "InvalidDocumentLifecycleError";
    this.kind = kind;
    this.status = status;
  }
}

export class InvalidTagNameError extends Error {
  readonly tagName: string;

  constructor(tagName: string) {
    super(
      `Invalid tag name ${JSON.stringify(tagName)}: use lowercase letters and ` +
        `numbers separated by hyphens, at most 30 characters`,
    );
    this.name = "InvalidTagNameError";
    this.tagName = tagName;
  }
}

export type InvalidTagIdentityReason = "not-a-uuid" | "unknown" | "in-use";

export class InvalidTagIdentityError extends Error {
  readonly reason: InvalidTagIdentityReason;
  readonly identity: string;

  constructor(reason: InvalidTagIdentityReason, identity: string) {
    super(
      reason === "not-a-uuid"
        ? `Invalid tag identity ${JSON.stringify(identity)}: tag identities are canonical UUIDs`
        : reason === "in-use"
          ? `Tag identity ${identity} already names another catalog entry`
          : `Unknown tag identity ${JSON.stringify(identity)}`,
    );
    this.name = "InvalidTagIdentityError";
    this.reason = reason;
    this.identity = identity;
  }
}

/** A whole-request refusal from the catalog-aware document assignment boundary. */
export class InvalidTagAssignmentError extends Error {
  readonly unknown: string[];

  constructor(unknown: string[]) {
    super(`Invalid tag assignment (unknown: ${unknown.join(", ")})`);
    this.name = "InvalidTagAssignmentError";
    this.unknown = [...unknown];
  }
}

export class InvalidTagDescriptionError extends Error {
  constructor() {
    super("A tag description must be one line of at most 300 characters");
    this.name = "InvalidTagDescriptionError";
  }
}

export type SupersedesReferenceErrorReason =
  | "not-a-document"
  | "self-reference"
  | "immutable";

/**
 * Thrown when a decision's immutable supersession reference is not one valid,
 * different document UUID, or when re-initialisation would replace it.
 */
export class InvalidSupersedesReferenceError extends Error {
  readonly reason: SupersedesReferenceErrorReason;
  readonly uuid: unknown;

  constructor(reason: SupersedesReferenceErrorReason, uuid: unknown) {
    super(
      reason === "not-a-document"
        ? `Not a document reference: ${renderUnknown(uuid)}. supersedes carries a document uuid.`
        : reason === "self-reference"
          ? `A decision cannot supersede itself (${renderUnknown(uuid)}).`
          : `A decision's supersedes reference is immutable after creation.`,
    );
    this.name = "InvalidSupersedesReferenceError";
    this.reason = reason;
    this.uuid = uuid;
  }
}

/** Render foreign Yjs values without letting error construction throw. */
function renderUnknown(value: unknown): string {
  if (typeof value === "bigint") return `${value}n`;
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return `<${typeof value}>`;
  }
}

export type InlineLinkRangeErrorReason = "empty" | "not-prose";

/**
 * Empty clamped ranges have no label/anchor; source blocks and tables admit no
 * block-level docLink range. Cell offsets differ from GFM projection offsets.
 * External-link conflicts use ConflictingLinkMarksError to name both targets.
 */
export class InlineLinkRangeError extends Error {
  readonly reason: InlineLinkRangeErrorReason;
  readonly blockId: string;
  /** For `"not-prose"`, the block type that cannot hold the mark. */
  readonly blockType: string | undefined;

  constructor(
    reason: InlineLinkRangeErrorReason,
    blockId: string,
    blockType?: string,
  ) {
    super(
      reason === "empty"
        ? `Cannot link an empty range in block ${blockId}`
        : `Block ${blockId} is a ${blockType ?? "source"} block and cannot carry ` +
          "document links. Link a prose block instead.",
    );
    this.name = "InlineLinkRangeError";
    this.reason = reason;
    this.blockId = blockId;
    this.blockType = blockType;
  }
}

/** Thrown when a room name is not `<workspaceId>/<uuid>`-shaped. */
export class InvalidRoomError extends Error {
  readonly room: string;

  constructor(room: string, detail: string) {
    super(`Invalid room name ${JSON.stringify(room)}: ${detail}`);
    this.name = "InvalidRoomError";
    this.room = room;
  }
}

/**
 * Report the invalid workspace id's source label, never its rejected value;
 * see parseWorkspaceId.
 */
export class InvalidWorkspaceIdError extends Error {
  /** Where the value came from, as named by the caller. */
  readonly label: string;

  constructor(label: string) {
    super(
      `${label} must be a workspace id: a lowercase uuid, optionally prefixed ` +
        "for display as <slug>-<uuid>, where the slug is made of lowercase " +
        "letters, digits and hyphens, starts and ends with a letter or digit, " +
        "and is joined to the uuid by a single hyphen. Run `ub workspace create <name>` to " +
        "create one.",
    );
    this.name = "InvalidWorkspaceIdError";
    this.label = label;
  }
}

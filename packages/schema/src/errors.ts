/**
 * Typed failures for block-scoped operations.
 *
 * These are part of the MCP tool contract: `edit_block` fails safely and tells
 * a caller whether its revision is stale or its asserted text is wrong.
 */

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
   * The text the caller expected to find, as passed to `editBlock` — absent
   * when the caller asserted only a `rev`, which is the whole of what
   * `setInlineLink` has to go on.
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
 * Thrown by `editBlock` when an asserted `rev` is stale, or when `oldText`
 * mismatches without a rev that could distinguish a bad argument from a stale
 * read; and by `setInlineLink`, whose only assertion is the `rev`.
 *
 * `currentText` and `currentRev` carry the live state so the caller can
 * re-read, re-diff and retry without a second round trip.
 *
 * Scope of the guarantee, stated plainly: this is a check against the local
 * replica at the moment of the call. There is no cross-replica
 * compare-and-swap — a remote edit that has not yet reached this replica cannot
 * be detected, and the window widens the longer a replica stays offline. What
 * the check buys is that an edit never silently overwrites a change this
 * replica has already seen.
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
 * Thrown by `editBlock` when the caller asserted the current `rev`, but its
 * `oldText` does not match that revision's plain text. This is an argument
 * mismatch, not a stale read: the current text and rev are attached so the
 * caller can correct the argument and re-diff without another read.
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
 * Thrown when an annotation range cannot be anchored as a `comment` mark.
 *
 * `"empty"`: a zero-length range carries no characters, so there is nothing to
 * mark and the thread would be born orphaned.
 *
 * `"overlap"`: the range already carries another thread's `comment` mark. A Yjs
 * formatting key holds exactly one value per character (and a ProseMirror mark
 * type likewise applies once per position), so a second thread would silently
 * steal characters from the first instead of nesting.
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
 * Thrown when a write would put a mark where the block type cannot hold it.
 *
 * A re-type into `code` or `mermaid` is one case: those blocks are
 * source text and carry only `comment`, so re-typing formatted prose into one
 * has no honest outcome. Stripping the marks would contradict `setBlockType`'s
 * whole promise (it preserves the delta), and keeping them would write a
 * document the web editor refuses to bind. So the re-type is refused *before* it
 * mutates anything, and `marks` names what is in the way — a caller that means
 * it can clear the formatting first and re-type after. Table-to-flat and
 * flat-to-table conversions also refuse any marks rather than dropping them.
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
 * Thrown when a `link` mark's target is not an external `http(s)` URL.
 *
 * A `link` is external only — an inline reference to another document is the
 * `docLink` mark, and a bare uuid in an href is never reinterpreted as one —
 * and this is the model-level door, not a UI nicety: refusing here is what
 * keeps a `javascript:` target out of the CRDT, and therefore out of every
 * renderer downstream of it.
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
 * Thrown when a `docLink` mark's target is not a document uuid.
 *
 * The mirror of {@link InvalidLinkHrefError}, and the same door: a docLink
 * names a document by uuid, so a URL, a path, a title or a reserved room name
 * (`_directory` and its siblings are not documents) is refused before it
 * reaches the CRDT. An upper-cased uuid is not refused — it is canonicalized
 * down, because two spellings of one id would be two documents to everything
 * that compares them.
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
 * Thrown when one range of text would carry both `link` and `docLink`.
 *
 * They are one affordance over two target spaces, and a range that is both has
 * no honest rendering. Writing refuses; reading cannot, because two Yjs keys
 * have no cross-key exclusion and a merge of two replicas that formatted the
 * same range differently can leave both behind. So a reader resolves in
 * `docLink`'s favour instead of breaking (see `marks.ts`), and this error keeps
 * writers from creating the situation on purpose.
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
 * Thrown when a sanctioned metadata write would store an illegal kind/status
 * pair.
 *
 * Both values are retained as `unknown` because the error also reports foreign
 * or stale values already present in the Y.Map. The refusal always happens
 * before either key is written.
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
  readonly retired: string[];

  constructor(unknown: string[], retired: string[]) {
    const details = [
      ...(unknown.length === 0 ? [] : [`unknown: ${unknown.join(", ")}`]),
      ...(retired.length === 0 ? [] : [`retired: ${retired.join(", ")}`]),
    ].join("; ");
    super(`Invalid tag assignment (${details})`);
    this.name = "InvalidTagAssignmentError";
    this.unknown = [...unknown];
    this.retired = [...retired];
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
 * Thrown when a `docLink` cannot be written over a range of a block's text —
 * see `setInlineLink`, the one write that marks text that is already there.
 *
 * `"empty"`: the clamped range carries no characters, so the link would have no
 * label and nothing to anchor to. The same rule {@link AnnotationRangeError}
 * has, for the same reason.
 *
 * `"not-prose"`: source blocks and tables do not admit document links.
 * Table-cell offsets are distinct from the block's GFM projection.
 *
 * A range already carrying an external `link` is refused with
 * {@link ConflictingLinkMarksError} instead — that error names both targets,
 * and it is the boundary the invariant already lives at.
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
 * Thrown when a value is not a workspace id.
 *
 * `label` names the source — `WORKSPACE_ID`, a config key, a URL segment — so
 * the message points at the thing to fix. The rejected value is never included:
 * see `parseWorkspaceId`.
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

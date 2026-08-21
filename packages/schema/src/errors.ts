/**
 * Typed failures for block-scoped operations.
 *
 * These are part of the MCP tool contract: `edit_block` fails safely and the
 * caller is expected to re-read and retry rather than force a write.
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

export interface StaleBlockDetails {
  blockId: string;
  /** The text the caller expected to find, as passed to `editBlock`. */
  expectedText: string;
  /** The rev the caller asserted, when it passed one. */
  expectedRev?: string | undefined;
  /** The text actually in the document right now. */
  currentText: string;
  /** The content hash of the block right now. */
  currentRev: string;
}

/**
 * Thrown by `editBlock` when the block no longer matches what the caller
 * believed it was editing — either `oldText` or an asserted `rev` is stale.
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
  readonly expectedText: string;
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
 * The case that exists today is a re-type: `code` and `mermaid` blocks are
 * source text and carry only `comment`, so re-typing formatted prose into one
 * has no honest outcome. Stripping the marks would contradict `setBlockType`'s
 * whole promise (it preserves the delta), and keeping them would write a
 * document the web editor refuses to bind. So the re-type is refused *before* it
 * mutates anything, and `marks` names what is in the way — a caller that means
 * it can clear the formatting first and re-type after.
 */
export class MarksNotAllowedError extends Error {
  readonly blockId: string;
  /** The block type that cannot hold the marks. */
  readonly blockType: string;
  /** The offending mark names, in the document's order, deduplicated. */
  readonly marks: string[];

  constructor(blockId: string, blockType: string, marks: string[]) {
    super(
      `Block ${blockId} cannot become ${blockType}: its text carries inline ` +
        `formatting (${marks.join(", ")}), and a ${blockType} block holds source ` +
        `text — only the comment mark. Clear the formatting first.`,
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
 * Inline links are external URLs only — a doc-to-doc reference is `meta.links`
 * by UUID — and this is the model-level door, not a UI nicety: refusing here is
 * what keeps a `javascript:` target out of the CRDT, and therefore out of every
 * renderer downstream of it.
 */
export class InvalidLinkHrefError extends Error {
  readonly href: string;

  constructor(href: string) {
    super(
      `Not an external link target: ${JSON.stringify(href)}. Inline links are ` +
        `http(s) URLs only; a reference to another document is meta.links by UUID.`,
    );
    this.name = "InvalidLinkHrefError";
    this.href = href;
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

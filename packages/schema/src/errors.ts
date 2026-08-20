/**
 * Typed failures for block-scoped operations.
 *
 * Both errors are part of the MCP tool contract: `edit_block` fails safely and
 * the caller is expected to re-read and retry rather than force a write.
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

/**
 * Thrown by {@link editBlock} when the block's current text does not match the
 * `oldText` the caller believed it was editing. `currentText` carries the live
 * text so the caller can re-read, re-diff and retry without a second round trip.
 */
export class StaleBlockError extends Error {
  readonly blockId: string;
  /** The text the caller expected to find. */
  readonly expectedText: string;
  /** The text actually in the document right now. */
  readonly currentText: string;

  constructor(blockId: string, expectedText: string, currentText: string) {
    super(
      `Stale old_text for block ${blockId}: the block has changed since it was read`,
    );
    this.name = "StaleBlockError";
    this.blockId = blockId;
    this.expectedText = expectedText;
    this.currentText = currentText;
  }
}

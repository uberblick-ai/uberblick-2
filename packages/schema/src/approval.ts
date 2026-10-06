/** Approval content is narrower than replica agreement: discussion stays open. */

import type * as Y from "yjs";
import { getBlocksWithInline } from "./blocks.js";
import { inlinePlainText } from "./marks.js";
import { writeGfmTable } from "./table.js";
import { getMeta } from "./doc.js";
import { blockRev } from "./rev.js";

/**
 * Browser-safe change detector for the approved title, decision line and block
 * text in document order. JSON preserves field and block boundaries. Block
 * identities, attributes, marks, comments and approval bookkeeping are outside
 * this content; the shared non-cryptographic revision hash detects changes,
 * rather than proving who approved them.
 */
export function decisionApprovalFingerprint(doc: Y.Doc): string {
  const meta = getMeta(doc);
  return blockRev({
    type: "paragraph",
    // Approval excludes formatting and retains the historical plain table
    // projection, even though the agent-facing text now includes inline marks.
    text: JSON.stringify([meta.title, meta.tldr, getBlocksWithInline(doc).map(({ block, table }) =>
      table !== undefined && table.length > 0
        ? writeGfmTable(table.map((row) => row.map(inlinePlainText)))
        : block.text,
    )]),
  });
}

/** No recorded fingerprint means there is no approval to invalidate. */
export function decisionApprovalChanged(doc: Y.Doc): boolean {
  const meta = getMeta(doc);
  return meta.kind === "decision" && meta.approvalFingerprint !== undefined &&
    meta.approvalFingerprint !== decisionApprovalFingerprint(doc);
}

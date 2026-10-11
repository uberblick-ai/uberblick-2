// Decision approval model: b4e616bb-10f6-460d-a13b-9c21354ca80b

import type * as Y from "yjs";
import { getBlocksWithInline } from "./blocks.js";
import { inlinePlainText } from "./marks.js";
import { writeGfmTable } from "./table.js";
import { getMeta } from "./doc.js";
import { getDocDataEntries } from "./data.js";
import { blockRev } from "./rev.js";

/**
 * Hash title, decision line, ordered block text and raw data with JSON boundaries.
 * Identities, attributes, marks, comments and approval bookkeeping are excluded.
 * The browser-safe revision hash detects changes; it does not prove attribution.
 */
export function decisionApprovalFingerprint(doc: Y.Doc): string {
  const meta = getMeta(doc);
  // Approval includes invalid merged records and unsupported schemas.
  const data = getDocDataEntries(doc);
  // Use plain table text so formatting alone cannot invalidate approval.
  const content: unknown[] = [meta.title, meta.tldr, getBlocksWithInline(doc).map(({ block, table }) =>
    table !== undefined && table.length > 0
      ? writeGfmTable(table.map((row) => row.map(inlinePlainText)))
      : block.text,
  )];
  // Omit empty data to preserve fingerprints for documents without a data area.
  if (data.length > 0) content.push(data);
  return blockRev({
    type: "paragraph",
    text: JSON.stringify(content),
  });
}

/** No recorded fingerprint means there is no approval to invalidate. */
export function decisionApprovalChanged(doc: Y.Doc): boolean {
  const meta = getMeta(doc);
  return meta.kind === "decision" && meta.approvalFingerprint !== undefined &&
    meta.approvalFingerprint !== decisionApprovalFingerprint(doc);
}


import type * as Y from "yjs";
import { getBlocksWithInline } from "./blocks.js";
import { inlinePlainText } from "./marks.js";
import { writeGfmTable } from "./table.js";
import { CARD_PARTS, writeCardText } from "./card.js";
import type { CardInline, CardPart } from "./card.js";
import { getMeta } from "./doc.js";
import { getDocDataEntries } from "./data.js";
import { blockRev } from "./rev.js";

/**
 * Hash title, decision line, ordered block text and raw data with JSON boundaries.
 * Identities, layout attributes, marks, comments, link targets and approval
 * bookkeeping are excluded.
 * The browser-safe revision hash detects changes; it does not prove attribution.
 */
export function decisionApprovalFingerprint(doc: Y.Doc): string {
  const meta = getMeta(doc);
  // Approval includes invalid merged records and unsupported schemas.
  const data = getDocDataEntries(doc);
  // Use plain table text so formatting alone cannot invalidate approval.
  const content: unknown[] = [meta.title, meta.tldr, getBlocksWithInline(doc).map(({ block, table, card, cardButtons }) =>
    card !== undefined
      ? cardApprovalText(card, cardButtons?.map((button) => button.text) ?? [])
      : table !== undefined && table.length > 0
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

function cardApprovalText(card: CardInline, buttonTexts: string[]): unknown {
  const parts = writeCardText(Object.fromEntries(CARD_PARTS.map((part) => [part, inlinePlainText(card[part])])) as Record<CardPart, string>);
  return buttonTexts.length === 0 ? parts : [parts, ...buttonTexts];
}

/** No recorded fingerprint means there is no approval to invalidate. */
export function decisionApprovalChanged(doc: Y.Doc): boolean {
  const meta = getMeta(doc);
  return meta.kind === "decision" && meta.approvalFingerprint !== undefined &&
    meta.approvalFingerprint !== decisionApprovalFingerprint(doc);
}

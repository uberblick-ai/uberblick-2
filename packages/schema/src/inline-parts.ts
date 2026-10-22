import * as Y from "yjs";
import { readsAsMark } from "./marks.js";

/** The closed inline vocabulary shared by prose containers and table cells. */
export const INLINE_PART_MARKS = ["bold", "italic", "strike", "inlineCode", "link", "docLink", "comment"] as const;

export const CARD_PARTS = ["label", "title", "body", "footer"] as const;
export type CardPart = (typeof CARD_PARTS)[number];
export const CARD_NODE_NAMES: Record<CardPart, string> = {
  label: "cardLabel", title: "cardTitle", body: "cardBody", footer: "cardFooter",
};

/** First writes into an empty paragraph can concurrently create several texts. */
export function inlinePartTexts(part: Y.XmlElement | null): Y.XmlText[] {
  const paragraph = part?.firstChild;
  if (!(paragraph instanceof Y.XmlElement) || paragraph.nodeName !== "paragraph") return [];
  return paragraph.toArray().filter((text): text is Y.XmlText => text instanceof Y.XmlText);
}

/** Read plain text without rendering XmlText's formatting as XML tags. */
export function plainXmlText(text: Y.XmlText | null): string {
  return text === null ? "" : (text.toDelta() as Array<{ insert?: unknown }>).map((op) =>
    typeof op.insert === "string" ? op.insert : "",
  ).join("");
}

/** Bindable part → paragraph → text grammar; tables additionally forbid newlines. */
export function isSupportedInlinePart(part: Y.XmlElement, allowNewlines: boolean): boolean {
  if (part.length !== 1) return false;
  const paragraph = part.firstChild;
  if (!(paragraph instanceof Y.XmlElement) || paragraph.nodeName !== "paragraph" ||
    Object.keys(paragraph.getAttributes()).length !== 0 || paragraph.length > 1) return false;
  return paragraph.toArray().every((text) => text instanceof Y.XmlText &&
    (text.toDelta() as Array<{ insert?: unknown; attributes?: Record<string, unknown> }>).every((op) =>
      typeof op.insert === "string" && (allowNewlines || !/[\r\n]/.test(op.insert)) &&
      Object.entries(op.attributes ?? {}).every(([key, value]) =>
        (INLINE_PART_MARKS as readonly string[]).includes(key) && readsAsMark(key, value),
      ),
    ),
  );
}

/** Seed before the first writers; merging concurrently inserted texts can lose edits. */
export function buildInlinePart(nodeName: string, value = ""): Y.XmlElement {
  const part = new Y.XmlElement(nodeName);
  const paragraph = new Y.XmlElement("paragraph");
  paragraph.insert(0, [new Y.XmlText(value)]);
  part.insert(0, [paragraph]);
  return part;
}

/** Called only after the containing edit has validated every part. */
export function ensureInlinePartText(part: Y.XmlElement | null): Y.XmlText | null {
  const text = inlinePartTexts(part)[0];
  if (text !== undefined) return text;
  const paragraph = part?.firstChild;
  if (!(paragraph instanceof Y.XmlElement) || paragraph.nodeName !== "paragraph") return null;
  const created = new Y.XmlText();
  paragraph.insert(0, [created]);
  return created;
}

/** Direct row cells. Readers retain uneven rows produced by concurrent edits. */
export function tableRows(element: Y.XmlElement): Y.XmlElement[][] {
  return element.toArray().filter((node): node is Y.XmlElement =>
    node instanceof Y.XmlElement && node.nodeName === "tableRow",
  ).map((row) => row.toArray().filter((cell): cell is Y.XmlElement =>
    cell instanceof Y.XmlElement && (cell.nodeName === "tableCell" || cell.nodeName === "tableHeader"),
  ));
}

export function inlinePartElement(element: Y.XmlElement, nodeName: string): Y.XmlElement | null {
  return element.toArray().find((node): node is Y.XmlElement =>
    node instanceof Y.XmlElement && node.nodeName === nodeName,
  ) ?? null;
}

export type StructuredInlinePart = { element: Y.XmlElement | null; texts: Y.XmlText[] } & (
  { kind: "table"; row: number; column: number } |
  { kind: "card"; part: CardPart } |
  { kind: "figma"; part: "caption" }
);

/** Each address has its own offsets; missing card/caption parts remain readable. */
export function structuredInlineParts(element: Y.XmlElement): StructuredInlinePart[] {
  if (element.nodeName === "table") {
    return tableRows(element).flatMap((cells, row) => cells.map((cell, column) => ({
      kind: "table", row, column, element: cell, texts: inlinePartTexts(cell),
    })));
  }
  if (element.nodeName === "card") {
    return CARD_PARTS.map((part) => {
      const node = inlinePartElement(element, CARD_NODE_NAMES[part]);
      return { kind: "card", part, element: node, texts: inlinePartTexts(node) };
    });
  }
  if (element.nodeName === "figma") {
    const caption = inlinePartElement(element, "figmaCaption");
    return [{ kind: "figma", part: "caption", element: caption, texts: inlinePartTexts(caption) }];
  }
  return [];
}

/** Seed only the creator's new empty paragraphs, inside their creating transaction. */
export function seedNewInlineParts(transaction: Y.Transaction): void {
  seedNewInlinePartsOfKind(transaction);
}

export function seedNewInlinePartsOfKind(transaction: Y.Transaction, kind?: StructuredInlinePart["kind"]): void {
  if (!transaction.local) return;
  const doc = transaction.doc;
  const start = transaction.beforeState.get(doc.clientID) ?? 0;
  for (const block of doc.getXmlFragment("blocks").toArray()) {
    if (!(block instanceof Y.XmlElement) || (kind !== undefined && block.nodeName !== kind)) continue;
    for (const part of structuredInlineParts(block)) {
      const paragraph = part.element?.firstChild;
      if (!(paragraph instanceof Y.XmlElement) || paragraph.nodeName !== "paragraph" || paragraph.length !== 0) continue;
      const id = Y.createRelativePositionFromTypeIndex(paragraph, 0).type;
      if (id?.client === doc.clientID && id.clock >= start) paragraph.insert(0, [new Y.XmlText()]);
    }
  }
}

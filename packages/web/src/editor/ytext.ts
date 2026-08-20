/**
 * Reading a Y.XmlText as plain text.
 *
 * `Y.XmlText.prototype.toString()` is an XML serialiser, not a text accessor: a
 * formatting mark comes back as a tag, so an annotated block reads as
 * `The <comment threadId="…">quick</comment> brown fox`. Every place that wants
 * the block's source scans the delta instead — the same thing the schema
 * package's internal `readText` does.
 */

import * as Y from "yjs";

export function plainText(ytext: Y.XmlText | null): string {
  if (ytext === null) return "";
  let out = "";
  for (const op of ytext.toDelta() as Array<{ insert?: unknown }>) {
    if (typeof op.insert === "string") out += op.insert;
  }
  return out;
}

/** The single Y.XmlText child of a block element, or null. */
export function blockText(element: Y.XmlElement): Y.XmlText | null {
  const first = element.firstChild;
  return first instanceof Y.XmlText ? first : null;
}

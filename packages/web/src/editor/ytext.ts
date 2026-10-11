/**
 * Read delta string inserts for source text. Y.XmlText.toString serializes XML,
 * so formatting would otherwise leak into copied or parsed source as tags.
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

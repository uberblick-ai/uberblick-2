import * as Y from "yjs";

export { plainXmlText as plainText } from "@uberblick/schema";

/** The single Y.XmlText child of a block element, or null. */
export function blockText(element: Y.XmlElement): Y.XmlText | null {
  const first = element.firstChild;
  return first instanceof Y.XmlText ? first : null;
}

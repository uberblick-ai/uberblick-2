import { docLinkFromTarget } from "../../editor/doc-links.js";
import type { DocLinkContext } from "../../editor/doc-links.js";
import { isPlainClick } from "../route.js";

/** Live and historical document references share navigation and browser modifier behavior. */
export function handleDocLinkClick(event: MouseEvent, docLinks: DocLinkContext | null): boolean {
  const docId = docLinkFromTarget(event.target);
  if (docId === null) return false;
  if (docLinks?.lookup(docId).state === "deleted") {
    event.preventDefault();
    return true;
  }
  // Modified clicks keep the real anchor address and the browser's own behavior.
  if (isPlainClick(event) && docLinks !== null) {
    event.preventDefault();
    docLinks.open(docId);
  }
  return true;
}

/** Tag cleanup belongs to an explicit, already-permitted document write. */
import type * as Y from "yjs";
import { cleanupDeletedDocumentTags } from "@uberblick/schema";

export function writeDocument<T>(doc: Y.Doc, catalog: Y.Doc | null, write: () => T, origin?: unknown, canCleanup?: () => boolean): T {
  return doc.transact((transaction) => {
    const result = write();
    if (catalog !== null && transaction.changed.size > 0 && canCleanup?.() !== false) cleanupDeletedDocumentTags(doc, catalog);
    return result;
  }, origin);
}

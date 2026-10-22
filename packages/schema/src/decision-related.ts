import { canonicalDocumentUuid } from "./rooms.js";

/** Non-empty UUID sets preserve their first page for the legacy scalar view. */
export function canonicalRelatedPages(value: unknown): string[] | null {
  if (!Array.isArray(value) || value.length === 0) return null;
  const pages: string[] = [];
  for (const item of value) {
    const uuid = canonicalDocumentUuid(item);
    if (uuid === null) return null;
    if (!pages.includes(uuid)) pages.push(uuid);
  }
  return pages;
}

/** Old records need no migration; malformed additions retain their scalar edge. */
export function readRelatedPages(value: unknown, governs: unknown): string[] {
  const pages = canonicalRelatedPages(value);
  if (pages !== null) return pages;
  const legacy = canonicalDocumentUuid(governs);
  return legacy === null ? [] : [legacy];
}

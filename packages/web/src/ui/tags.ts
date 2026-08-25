/**
 * The three pure reads behind tag editing in the doc header (#122).
 *
 * Tags are a plain array on `meta.tags`, written wholesale — the same semantics
 * `set_tags` has — so every edit here is "compute the next array, hand it to
 * `setTags`". Nothing is stored for the editor itself: the chips are the
 * document's own tags, and the suggestions are the tags the directory already
 * carries.
 *
 * Case matters for what is *stored* (a tag is written the way it was typed) and
 * not for what counts as the same tag: "Feature" and "feature" would group as
 * two things in a sidebar that knows one, so they are one tag here, and the
 * first spelling the workspace used is the one offered.
 */

import type { DirectoryEntry } from "@uberblick/schema";

/** Compare two tags the way the workspace does: same word, whatever the case. */
function same(a: string, b: string): boolean {
  return a.toLowerCase() === b.toLowerCase();
}

/**
 * Every tag the workspace already uses, from the directory stubs alone.
 *
 * Stubs, never the documents: the stub carries the tags precisely so discovery
 * costs one synced room, and opening every document in the workspace to collect
 * a suggestion list would be the thing the directory exists to avoid.
 */
export function workspaceTags(entries: readonly DirectoryEntry[]): string[] {
  const seen = new Map<string, string>();
  for (const entry of entries) {
    for (const tag of entry.tags) {
      const key = tag.toLowerCase();
      if (tag !== "" && !seen.has(key)) seen.set(key, tag);
    }
  }
  return [...seen.values()].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
}

/**
 * The document's tags as the workspace counts them: one entry per distinct tag.
 *
 * `meta.tags` is a plain array and nothing enforces uniqueness — `set_tags`
 * writes what it is given — so a document can arrive carrying a tag twice. It is
 * one tag, and the strip draws it once.
 */
export function distinctTags(tags: readonly string[]): string[] {
  const seen = new Set<string>();
  return tags.filter((tag) => {
    const key = tag.toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/**
 * The tag list after adding `raw`, or null when there is nothing to add.
 *
 * Null is the quiet rejection the issue asks for: an empty string and a tag the
 * document already carries are both "no write", and neither earns an error
 * message — the reader typed something that is already true.
 */
export function withTag(tags: readonly string[], raw: string): string[] | null {
  const tag = raw.trim();
  if (tag === "") return null;
  if (tags.some((existing) => same(existing, tag))) return null;
  return [...tags, tag];
}

/** The tag list after removing `tag`. */
export function withoutTag(tags: readonly string[], tag: string): string[] {
  return tags.filter((existing) => !same(existing, tag));
}

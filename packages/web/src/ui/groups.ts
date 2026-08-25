/**
 * The sidebar's one-level grouping: a pure derivation of the directory listing.
 *
 * Tags are the grouping key because every directory stub already carries them —
 * no schema change, no path semantics, identity stays UUID-only. Nothing is
 * stored for the grouping itself, so a retag that reaches the directory doc
 * moves a document between groups with no extra plumbing.
 *
 * Deeper or custom hierarchy is typed-properties territory, not this.
 */

import type { DirectoryEntry } from "@uberblick/schema";

/**
 * The known tags, in the order the sidebar shows them. A document carrying more
 * than one of them belongs to the first one here — the order is the tie-break,
 * not the document's own tag order, so two replicas group identically.
 */
export const GROUP_TAGS = [
  "start-here",
  "feature",
  "verify",
  "implementation-reference",
  "reference",
] as const;

export type GroupTag = (typeof GROUP_TAGS)[number];

/** Key of the trailing group: documents carrying none of the known tags. */
export const UNGROUPED_KEY = "other";

export type GroupKey = GroupTag | typeof UNGROUPED_KEY;

const LABELS: Record<GroupKey, string> = {
  "start-here": "Start here",
  feature: "Features",
  verify: "Verify",
  "implementation-reference": "Implementation reference",
  reference: "Reference",
  [UNGROUPED_KEY]: "Other",
};

export interface DocGroup {
  key: GroupKey;
  label: string;
  entries: DirectoryEntry[];
}

/** The group a single entry belongs to. */
export function groupKeyFor(entry: DirectoryEntry): GroupKey {
  return GROUP_TAGS.find((tag) => entry.tags.includes(tag)) ?? UNGROUPED_KEY;
}

/**
 * The directory listing as groups, in canonical order with the untagged group
 * last. Entries keep the order `listDirectory` gave them; empty groups are
 * omitted, so the sidebar never shows a header with nothing under it.
 */
export function groupEntries(entries: DirectoryEntry[]): DocGroup[] {
  const buckets = new Map<GroupKey, DirectoryEntry[]>();
  for (const entry of entries) {
    const key = groupKeyFor(entry);
    const bucket = buckets.get(key);
    if (bucket === undefined) buckets.set(key, [entry]);
    else bucket.push(entry);
  }
  const keys: GroupKey[] = [...GROUP_TAGS, UNGROUPED_KEY];
  return keys.flatMap((key) => {
    const bucket = buckets.get(key);
    return bucket === undefined ? [] : [{ key, label: LABELS[key], entries: bucket }];
  });
}

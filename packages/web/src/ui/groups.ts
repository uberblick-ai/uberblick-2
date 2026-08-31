/**
 * The document's group, derived from its tags: what the breadcrumb and the
 * identity line's badge call the open document's neighbourhood.
 *
 * This used to group the sidebar as well. It does not any more — the sidebar is
 * the `_sidebar` document, explicitly curated (#115) — so what is left is one
 * derivation over `meta.tags`, which is why a retag still reaches the breadcrumb
 * on the write itself with nothing stored in between.
 */

/**
 * The known tags, in canonical order. A document carrying more than one of them
 * belongs to the first one here — the order is the tie-break, not the
 * document's own tag order, so two replicas name the same group.
 */
export const GROUP_TAGS = [
  "start-here",
  "feature",
  "verify",
  "implementation-reference",
  "reference",
] as const;

export type GroupTag = (typeof GROUP_TAGS)[number];

/** The group of documents carrying none of the known tags. */
export const UNGROUPED_KEY = "other";

export type GroupKey = GroupTag | typeof UNGROUPED_KEY;

const LABELS: Record<GroupKey, string | null> = {
  "start-here": "Start here",
  feature: "Features",
  verify: "Verify",
  "implementation-reference": "Implementation reference",
  reference: "Reference",
  // Deliberately nameless (#535). A document carrying none of the canonical
  // tags is not in a group called "Other" — the word is only this derivation's
  // fallback, it says nothing about the document, and beside the title it read
  // like a kind of document rather than the absence of a group.
  [UNGROUPED_KEY]: null,
};

/** The group a set of tags belongs to: the first known tag, in canonical order. */
export function groupKeyForTags(tags: readonly string[]): GroupKey {
  return GROUP_TAGS.find((tag) => tags.includes(tag)) ?? UNGROUPED_KEY;
}

/**
 * The label the breadcrumb and the identity-line badge show for a group, or
 * `null` where a group has no name to show. Both read the document's own
 * `meta.tags` rather than its directory stub, because the stub is a cache of
 * them: a retag lands here on the write itself instead of waiting for the
 * repair that follows it.
 */
export function groupLabel(key: GroupKey): string | null {
  return LABELS[key];
}

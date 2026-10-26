import type { DocLinkCandidate } from "./editor/doc-links.js";
import { foldForTitleMatch } from "./title-fold.js";

export type MentionCandidate =
  | { kind: "person"; username: string; label: string }
  | { kind: "document"; docId: string; label: string };

/** The directory supplies live, title-ordered documents; membership never uses presence. */
export function mentionCandidates(
  documents: readonly DocLinkCandidate[],
  members: readonly string[],
  query: string,
  openDocId: string | null,
): MentionCandidate[] {
  const needle = query.toLowerCase();
  const people = [...new Map(members.map((username) => [username.toLowerCase(), username])).values()]
    .filter((username) => username.toLowerCase().includes(needle))
    .sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase()))
    .map((username): MentionCandidate => ({ kind: "person", username, label: `@${username}` }));
  const found = people.slice(0, 8);
  if (found.length === 8) return found;
  const titleNeedle = foldForTitleMatch(query);
  for (const doc of documents) {
    if (doc.docId === openDocId || !foldForTitleMatch(doc.label).includes(titleNeedle)) continue;
    found.push({ kind: "document", ...doc });
    if (found.length === 8) break;
  }
  return found;
}

export interface PersonMentionToken {
  from: number;
  to: number;
  username: string;
  /** Keep the writer's spelling in the pill and all stored-text read paths. */
  text: string;
}

/** Whole usernames only: an email address or a longer unknown handle stays literal. */
export function personMentionTokens(text: string, members: readonly string[]): PersonMentionToken[] {
  if (members.length === 0) return [];
  const current = new Map(members.map((username) => [username.toLowerCase(), username]));
  const result: PersonMentionToken[] = [];
  for (const match of text.matchAll(/(^|[^\p{L}\p{N}_@.+-])@([\p{L}\p{N}_-]+)/giu)) {
    const username = current.get((match[2] ?? "").toLowerCase());
    if (username === undefined) continue;
    const from = match.index + (match[1]?.length ?? 0);
    const to = match.index + match[0].length;
    result.push({ from, to, username, text: text.slice(from, to) });
  }
  return result;
}

import type * as Y from "yjs";
import { isGitHubItemState, type GitHubItemState } from "./github-item-state.js";

export interface GitHubItemObservation {
  state: GitHubItemState;
  seenAt: number;
  isPublic: boolean;
}

const OBSERVATIONS = "githubItems";
const DAY = 24 * 60 * 60 * 1_000;

function observation(value: unknown): GitHubItemObservation | null {
  if (value === null || typeof value !== "object") return null;
  const entry = value as Record<string, unknown>;
  return isGitHubItemState(entry.state) && typeof entry.seenAt === "number" &&
    Number.isSafeInteger(entry.seenAt) && entry.seenAt >= 0 && typeof entry.isPublic === "boolean"
    ? { state: entry.state, seenAt: entry.seenAt, isPublic: entry.isPublic } : null;
}

function newer(left: GitHubItemObservation, right: GitHubItemObservation): boolean {
  return left.seenAt > right.seenAt || left.seenAt === right.seenAt &&
    (left.state > right.state || left.state === right.state && !left.isPublic && right.isPublic);
}

/** Keep concurrent writers' values so Yjs client ids cannot defeat observation time. */
export function readGitHubItemObservations(doc: Y.Doc): ReadonlyMap<string, GitHubItemObservation> {
  const result = new Map<string, GitHubItemObservation>();
  for (const [slot, value] of doc.getMap<unknown>(OBSERVATIONS)) {
    const separator = slot.lastIndexOf("|");
    if (separator === -1) continue;
    const key = slot.slice(0, separator);
    const entry = observation(value);
    if (entry === null) continue;
    const current = result.get(key);
    // known limit: a fast writer clock can pin a reading until it catches up; revisit when GitHub observations use a trusted shared clock.
    if (current === undefined || newer(entry, current)) result.set(key, entry);
  }
  return result;
}

/** A quiet repeat within a day creates no Yjs update, log entry or undo step. */
export function writeGitHubItemObservation(doc: Y.Doc, key: string, value: GitHubItemObservation): boolean {
  const entry = observation(value);
  if (entry === null || !/^[a-z0-9-]+\/[a-z0-9_.-]+#[1-9][0-9]*:(issue|pull-request)$/.test(key) ||
    !entry.state.startsWith(key.endsWith(":issue") ? "issue-" : "pull-")) return false;
  const current = readGitHubItemObservations(doc).get(key);
  if (current !== undefined && (entry.seenAt < current.seenAt ||
    entry.state === current.state && entry.seenAt - current.seenAt < DAY)) return false;
  const entries = doc.getMap<unknown>(OBSERVATIONS);
  // known limit: daily refreshes retain Yjs tombstones and old writer slot keys; revisit when GitHub metadata approaches workspace storage limits.
  doc.transact(() => {
    // Each writer owns a slot; remove only older slots already observed here.
    for (const [slot, candidate] of entries) {
      if (slot.startsWith(`${key}|`) && (observation(candidate)?.seenAt ?? Infinity) <= entry.seenAt) entries.delete(slot);
    }
    entries.set(`${key}|${doc.clientID}`, entry);
  });
  return true;
}

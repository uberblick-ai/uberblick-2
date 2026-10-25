import type { RevisionEntry } from "@uberblick/schema";
import { revisionSurface } from "../../revision-attribution.js";

const DAY = 24 * 60 * 60 * 1000;
const MONTH = new Intl.DateTimeFormat(undefined, { month: "long", year: "numeric" });

export interface RevisionAuthor {
  name: string;
  /** Edit attribution, or empty when nothing is known. */
  surface: string;
  /** Agent surfaces draw a rounded square avatar; people a circle. */
  agent: boolean;
  initial: string;
}

export function revisionAuthor(entry: RevisionEntry, earliest: boolean): RevisionAuthor {
  const author = entry.author;
  // Content that predates attribution has no author and no predecessor.
  if (author === null) return earliest ? { name: "Earlier content", surface: "", agent: false, initial: "·" }
    : { name: "Unknown author", surface: "", agent: false, initial: "?" };
  const browser = author.surface.kind === "browser";
  return {
    name: author.githubUsername,
    surface: revisionSurface(author.surface, "author"),
    agent: !browser,
    initial: author.githubUsername.slice(0, 1).toUpperCase() || "?",
  };
}

/** The moment a revision stands for: when it ended, or when the open head started. */
export function revisionTime(entry: RevisionEntry): number | null {
  return entry.endedAt ?? entry.startedAt;
}

export interface RevisionGroup {
  label: string;
  items: { entry: RevisionEntry; index: number }[];
}

function startOfDay(value: number): number {
  const date = new Date(value);
  date.setHours(0, 0, 0, 0);
  return date.getTime();
}

function groupLabel(time: number | null, now: number): string {
  if (time === null) return "Unknown date";
  const today = startOfDay(now);
  if (time >= today) return "Today";
  if (time >= today - DAY) return "Yesterday";
  if (time >= today - 6 * DAY) return "Earlier this week";
  return MONTH.format(time);
}

/** Newest first, in the hub's order; consecutive entries share a day bucket. */
export function revisionGroups(entries: readonly RevisionEntry[], now: number, named = false): RevisionGroup[] {
  const groups: RevisionGroup[] = [];
  entries.forEach((entry, index) => {
    if (named && entry.name == null) return;
    const label = groupLabel(revisionTime(entry), now);
    const last = groups.at(-1);
    if (last?.label === label) last.items.push({ entry, index });
    else groups.push({ label, items: [{ entry, index }] });
  });
  return groups;
}

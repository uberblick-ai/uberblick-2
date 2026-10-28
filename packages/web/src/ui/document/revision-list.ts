import type { RevisionEntry } from "@uberblick/schema";
import { revisionSurface } from "../../revision-attribution.js";
import { formatExactTimestamp } from "../timestamps.js";

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

/** Account and surface together identify an author, just as they do in the hub. */
export function revisionAuthors(entries: readonly RevisionEntry[]): (RevisionAuthor & { key: string })[] {
  const seen = new Set<string>();
  return entries.flatMap(entry => {
    const key = entry.author === null ? "null" : JSON.stringify([entry.author.githubUsername, entry.author.surface.kind, entry.author.surface.name]);
    if (seen.has(key)) return [];
    seen.add(key);
    return [{ ...revisionAuthor(entry, false), key }];
  });
}

const SPAN = new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" });

/** Newest-first revisions, excluding the comparison's baseline. */
export function revisionSpan(entries: readonly RevisionEntry[], now: number): { label: string; title: string } {
  const newest = entries[0];
  const start = entries.at(-1)?.startedAt;
  const endTime = newest?.endedAt ?? now;
  // An open revision's hub start can be ahead of this browser's clock.
  const end = Math.max(start ?? endTime, endTime);
  const endLabel = formatExactTimestamp(end)?.label ?? "Unknown time";
  const title = start == null ? `Unknown start – ${endLabel}` : SPAN.formatRange(new Date(start), new Date(end));
  const label = newest?.endedAt == null ? `${start == null ? "Unknown start" : formatExactTimestamp(start)?.label} – now` : title;
  return { label, title };
}

export interface RevisionItem {
  entry: RevisionEntry;
  index: number;
  /** Multi-revision sessions only; individual rows keep their original shape. */
  revisions?: { entry: RevisionEntry; index: number }[];
  before?: RevisionEntry;
}

export interface RevisionGroup {
  label: string;
  items: RevisionItem[];
}

/** Group before assigning days, so a session crossing midnight stays together. */
function revisionSessions(entries: readonly RevisionEntry[]): RevisionItem[] {
  const items: RevisionItem[] = [];
  for (let index = 0; index < entries.length; index++) {
    const entry = entries[index];
    if (entry === undefined) continue;
    const first = { entry, index };
    const revisions = [first];
    let newer = entry;
    while (index + 1 < entries.length - 1 && newer.startedAt !== null) {
      const older = entries[index + 1];
      if (older === undefined || older.startedAt === null || older.endedAt === null || newer.startedAt - older.endedAt > 2 * 60_000) break;
      index++;
      revisions.push({ entry: older, index });
      newer = older;
    }
    const before = entries[index + 1];
    items.push(revisions.length > 1 && before !== undefined ? { ...first, revisions, before } : first);
  }
  return items;
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
  const items = named ? entries.flatMap((entry, index) => entry.name == null ? [] : [{ entry, index }]) : revisionSessions(entries);
  items.forEach(item => {
    const { entry } = item;
    const label = groupLabel(revisionTime(entry), now);
    const last = groups.at(-1);
    if (last?.label === label) last.items.push(item);
    else groups.push({ label, items: [item] });
  });
  return groups;
}

import type { RevisionEntry } from "@uberblick/schema";
import type { HistoryRetention } from "./local-settings.js";

export interface HistoryRetentionPage {
  /** The complete known catalog, newest first, including undownloaded revisions. */
  revisions: readonly RevisionEntry[];
  downloaded: ReadonlySet<string>;
  /** Snapshots displayed or being downloaded by any live process. */
  held?: ReadonlySet<string>;
  currentHeadId?: string;
}

/** Select snapshot ids without changing the catalog or the supplied sets. */
export function selectHistorySnapshots(page: HistoryRetentionPage, retention: HistoryRetention, now: number): Set<string> {
  const keep = new Set(page.held);
  const cutoff = retention.mode === "recent" ? now - retention.days * 24 * 60 * 60 * 1000 : 0;
  for (const revision of page.revisions) {
    if (retention.mode === "everything" ||
      (retention.mode === "named" && revision.name != null) ||
      (retention.mode === "recent" && ((retention.keepNamed && revision.name != null) ||
        revision.final === false || (revision.final === undefined && revision.endedAt === null && revision.startedAt !== null) ||
        (revision.endedAt !== null && revision.endedAt >= cutoff)))) keep.add(revision.id);
  }

  const newestDownloaded = page.revisions.find(revision => page.downloaded.has(revision.id));
  if (newestDownloaded !== undefined) keep.add(newestDownloaded.id);
  if (page.currentHeadId !== undefined && page.downloaded.has(page.currentHeadId)) keep.add(page.currentHeadId);

  // Take one comparison step from the original selection, never from added predecessors.
  const selected = new Set(keep);
  for (const [index, revision] of page.revisions.entries()) {
    const predecessor = page.revisions[index + 1];
    if (selected.has(revision.id) && predecessor !== undefined) keep.add(predecessor.id);
  }
  return keep;
}

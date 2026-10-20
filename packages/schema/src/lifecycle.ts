import type * as Y from "yjs";
import { getDirectoryEntry, tombstoneDecisionRecord, tombstoneDirectoryEntry } from "./directory.js";
import { unpinDocIncludingUnseen } from "./sidebar.js";

/**
 * Tombstone the whole topic before applying the archive unpin to each record.
 * The caller must run each stage's write exactly once, synchronously;
 * throwing stops the next room.
 */
export function archiveDocument(
  directory: Y.Doc,
  sidebar: Y.Doc,
  uuid: string,
  stage: (purpose: "directory" | "sidebar", write: () => void) => void = (_purpose, write) => write(),
): string[] {
  let records: string[] = [];
  stage("directory", () => {
    records = tombstoneDirectoryEntry(directory, uuid);
  });
  stage("sidebar", () => {
    sidebar.transact(() => {
      for (const record of records) unpinDocIncludingUnseen(sidebar, record);
    });
  });
  return records;
}

/** The first record's pin addresses the live topic and remains pinned. */
export function archiveDecisionRecord(directory: Y.Doc, sidebar: Y.Doc, uuid: string): boolean {
  const entry = getDirectoryEntry(directory, uuid);
  if (!tombstoneDecisionRecord(directory, uuid)) return false;
  if (uuid !== (entry?.topic ?? uuid)) unpinDocIncludingUnseen(sidebar, uuid);
  return true;
}

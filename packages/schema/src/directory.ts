/**
 * The directory document.
 *
 * Discovery is itself a synced doc: one Y.Doc per workspace, in the well-known
 * room `<workspaceId>/_directory` (see `rooms.ts`), holding a Y.Map of
 * uuid → {title, tags, deleted?} stubs. It travels over the same sync channel
 * as every other document, so a fresh client with empty local state learns the
 * corpus by joining one more room. There is no other discovery mechanism —
 * never enumerate locally-observed creations.
 *
 * The stub is a cache, not the truth: `meta.title` inside the document itself
 * is authoritative, and the stub is repaired on write and on connect.
 *
 * Entries are whole-object writes, so concurrent upserts to the same uuid
 * converge last-write-wins per key while different uuids never conflict.
 */

import type * as Y from "yjs";
import { DIRECTORY_SUFFIX } from "./rooms.js";
import type { DirectoryEntry } from "./types.js";

/**
 * The bare directory room name, without a workspace.
 *
 * @deprecated Rooms carry a workspace: use `directoryRoom(workspaceId)` from
 * `rooms.ts`. Kept as the document-id suffix for pre-tenancy callers.
 */
export const DIRECTORY_ROOM = DIRECTORY_SUFFIX;

/** The key of the directory Y.Map inside the directory doc. */
export const DIRECTORY_DOCS_KEY = "docs";

interface StoredEntry {
  title: string;
  tags: string[];
  deleted?: boolean;
}

export function getDirectoryMap(dirDoc: Y.Doc): Y.Map<unknown> {
  return dirDoc.getMap<unknown>(DIRECTORY_DOCS_KEY);
}

function readStored(value: unknown): StoredEntry | null {
  if (typeof value !== "object" || value === null) return null;
  const candidate = value as Partial<StoredEntry>;
  const tags = Array.isArray(candidate.tags)
    ? candidate.tags.filter((tag): tag is string => typeof tag === "string")
    : [];
  const title = typeof candidate.title === "string" ? candidate.title : "";
  return candidate.deleted === true
    ? { title, tags, deleted: true }
    : { title, tags };
}

export interface DirectoryUpsert {
  uuid: string;
  title: string;
  tags?: string[];
}

/**
 * Create or update a directory stub. Call this on document create, rename and
 * retag.
 *
 * A tombstone is sticky: upserting an entry that is already tombstoned keeps
 * `deleted: true`, so a late-arriving rename cannot resurrect a deleted doc.
 * Lifting one is deliberate and explicit — see `restoreDirectoryEntry`.
 */
export function upsertDirectoryEntry(
  dirDoc: Y.Doc,
  entry: DirectoryUpsert,
): void {
  const docs = getDirectoryMap(dirDoc);
  dirDoc.transact(() => {
    const existing = readStored(docs.get(entry.uuid));
    const next: StoredEntry =
      existing?.deleted === true
        ? { title: entry.title, tags: [...(entry.tags ?? [])], deleted: true }
        : { title: entry.title, tags: [...(entry.tags ?? [])] };
    docs.set(entry.uuid, next);
  });
}

/**
 * Tombstone a directory entry: sets `deleted: true` and keeps the entry, so the
 * deletion itself replicates. Entries are never removed from the map.
 */
export function tombstoneDirectoryEntry(dirDoc: Y.Doc, uuid: string): void {
  const docs = getDirectoryMap(dirDoc);
  dirDoc.transact(() => {
    const existing = readStored(docs.get(uuid));
    docs.set(uuid, {
      title: existing?.title ?? "",
      tags: existing?.tags ?? [],
      deleted: true,
    } satisfies StoredEntry);
  });
}

/**
 * Lift a tombstone: clears `deleted` and keeps title and tags as they stand.
 *
 * This is the one sanctioned way back. `upsertDirectoryEntry` deliberately
 * cannot do it — a rename that raced a delete must not resurrect the document —
 * so restoring has to be an act of its own, never a side effect of a write that
 * meant something else.
 *
 * Restoring a uuid that was never tombstoned is a no-op in effect, and
 * restoring one the directory has never seen creates a live, untitled stub;
 * both mirror how `tombstoneDirectoryEntry` treats an unknown uuid.
 *
 * Entries are whole-object writes, so a restore concurrent with a tombstone
 * converges on whichever update Yjs orders last — not on whichever human meant
 * it more recently.
 */
export function restoreDirectoryEntry(dirDoc: Y.Doc, uuid: string): void {
  const docs = getDirectoryMap(dirDoc);
  dirDoc.transact(() => {
    const existing = readStored(docs.get(uuid));
    docs.set(uuid, {
      title: existing?.title ?? "",
      tags: existing?.tags ?? [],
    } satisfies StoredEntry);
  });
}

export interface ListDirectoryOptions {
  /** Include tombstoned entries. Default false. */
  includeDeleted?: boolean;
}

/** One entry by uuid, or null when unknown. Tombstones are returned as-is. */
export function getDirectoryEntry(
  dirDoc: Y.Doc,
  uuid: string,
): DirectoryEntry | null {
  const stored = readStored(getDirectoryMap(dirDoc).get(uuid));
  if (stored === null) return null;
  return stored.deleted === true
    ? { uuid, title: stored.title, tags: stored.tags, deleted: true }
    : { uuid, title: stored.title, tags: stored.tags };
}

/**
 * List directory entries, sorted by title then uuid so every replica produces
 * the same order.
 */
export function listDirectory(
  dirDoc: Y.Doc,
  options: ListDirectoryOptions = {},
): DirectoryEntry[] {
  const includeDeleted = options.includeDeleted ?? false;
  const out: DirectoryEntry[] = [];
  for (const [uuid, value] of getDirectoryMap(dirDoc).entries()) {
    const stored = readStored(value);
    if (stored === null) continue;
    if (stored.deleted === true && !includeDeleted) continue;
    out.push(
      stored.deleted === true
        ? { uuid, title: stored.title, tags: stored.tags, deleted: true }
        : { uuid, title: stored.title, tags: stored.tags },
    );
  }
  out.sort((a, b) => {
    if (a.title !== b.title) return a.title < b.title ? -1 : 1;
    return a.uuid < b.uuid ? -1 : a.uuid > b.uuid ? 1 : 0;
  });
  return out;
}

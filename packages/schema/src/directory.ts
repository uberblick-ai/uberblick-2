/**
 * The directory document.
 *
 * Discovery is itself a synced doc: one Y.Doc per workspace, in the well-known
 * room `<workspaceId>/_directory` (see `rooms.ts`), holding a Y.Map of
 * uuid → {title, tags, deleted?, createdAt?, updatedAt?, description?, kind?,
 * status?} stubs.
 * It travels over the same sync channel as every other document, so a fresh
 * client with empty local state learns the corpus by joining one more room.
 * There is no other discovery mechanism — never enumerate locally-observed
 * creations.
 *
 * The stub is a cache, not the truth: metadata inside the document itself is
 * authoritative, and the stub is repaired on write and on connect. Caching the
 * description and lifecycle is what lets a listing answer without opening a
 * single room — the whole point of having one.
 *
 * Entries are whole-object writes, so concurrent upserts to the same uuid
 * converge last-write-wins per key while different uuids never conflict.
 *
 * `createdAt` and `updatedAt` are epoch milliseconds read from the clock of
 * whichever replica wrote them, and they are cache-quality like the rest of the
 * stub: freshness hints good enough to sort a listing, never history and never
 * an audit trail. Two replicas stamping concurrently converge on whichever
 * update Yjs orders last — not on the later wall-clock reading — and a replica
 * with a skewed clock writes skewed stamps. Both fields are optional: an entry
 * written before they existed simply has none, so anything sorting on them must
 * tolerate `undefined` rather than assume a number.
 */

import type * as Y from "yjs";
import { readDocumentLifecycle } from "./types.js";
import type {
  DirectoryEntry,
  DocumentKind,
  DocumentStatus,
} from "./types.js";

/** The key of the directory Y.Map inside the directory doc. */
export const DIRECTORY_DOCS_KEY = "docs";

interface StoredEntry {
  title: string;
  tags: string[];
  deleted?: boolean;
  createdAt?: number;
  updatedAt?: number;
  description?: string;
  kind?: DocumentKind;
  status?: DocumentStatus;
}

/** A stored epoch-millisecond stamp, or undefined when absent or malformed. */
function readStamp(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value)
    ? value
    : undefined;
}

/**
 * A stored description, or undefined when absent, blank or malformed. Blank and
 * absent are one fact here as they are in `getMeta`, so nothing has to carry an
 * empty string around to mean "none".
 */
function readDescription(value: unknown): string | undefined {
  return typeof value === "string" && value !== "" ? value : undefined;
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
  const createdAt = readStamp(candidate.createdAt);
  const updatedAt = readStamp(candidate.updatedAt);
  const description = readDescription(candidate.description);
  const lifecycle = readDocumentLifecycle(candidate.kind, candidate.status);
  return {
    title,
    tags,
    ...(candidate.deleted === true ? { deleted: true as const } : {}),
    ...(createdAt === undefined ? {} : { createdAt }),
    ...(updatedAt === undefined ? {} : { updatedAt }),
    ...(description === undefined ? {} : { description }),
    ...lifecycle,
  };
}

/**
 * Carry the fields of an entry that is being rewritten but not restated: its
 * timestamps and its description.
 *
 * Every writer here replaces the whole object, so a field that is not copied
 * forward is a field that is erased.
 */
function carryForward(next: StoredEntry, from: StoredEntry | null): StoredEntry {
  return {
    ...next,
    ...(from?.createdAt === undefined ? {} : { createdAt: from.createdAt }),
    ...(from?.updatedAt === undefined ? {} : { updatedAt: from.updatedAt }),
    ...(from?.description === undefined
      ? {}
      : { description: from.description }),
    ...(from?.kind === undefined ? {} : { kind: from.kind }),
    ...(from?.status === undefined ? {} : { status: from.status }),
  };
}

export interface DirectoryUpsert {
  uuid: string;
  title: string;
  tags?: string[];
  /**
   * When the document was created, epoch ms. Set once: an entry that already
   * carries one keeps it, so passing this on every write is safe — and is how a
   * stub written before the field existed gets backfilled.
   */
  createdAt?: number;
  /**
   * When the document was last seen to change, epoch ms. Written when given and
   * carried forward untouched otherwise, so a writer that only means to fix a
   * title does not have to know the freshness stamp in order to preserve it.
   */
  updatedAt?: number;
  /**
   * The document's description, cached here for listings. Written when given and
   * carried forward untouched otherwise — the web client repairs stubs without
   * knowing this field exists, and must not erase it by writing a title.
   *
   * The empty string is the one way to clear it, which is how a document whose
   * description was removed stops advertising the old one.
   */
  description?: string;
  /**
   * The document's record shape. Omission carries the cached value forward;
   * the empty string clears both kind and status.
   */
  kind?: DocumentKind | "";
  /**
   * The document's lifecycle state. Omission carries it forward; the empty
   * string clears only status. Pair validation belongs to the document setters.
   */
  status?: DocumentStatus | "";
}

/**
 * Create or update a directory stub. Call this on document create, rename and
 * retag.
 *
 * A tombstone is sticky: upserting an entry that is already tombstoned keeps
 * `deleted: true`, so a late-arriving rename cannot resurrect a deleted doc.
 * Lifting one is deliberate and explicit — see `restoreDirectoryEntry`.
 *
 * That stickiness is observed state, not a merge rule, and the difference
 * matters. It holds against a writer that has seen the tombstone. An upsert
 * made *concurrently* on a replica that has not seen it — an offline rename
 * racing an archive — is an ordinary whole-entry write, converges by update
 * order like any other, and can therefore bring the document back with nobody
 * calling `restoreDirectoryEntry`. `directory.test.ts` pins that outcome:
 * it is the contract, not the preference.
 */
export function upsertDirectoryEntry(
  dirDoc: Y.Doc,
  entry: DirectoryUpsert,
): void {
  const docs = getDirectoryMap(dirDoc);
  dirDoc.transact(() => {
    const existing = readStored(docs.get(entry.uuid));
    const createdAt = existing?.createdAt ?? entry.createdAt;
    const updatedAt = entry.updatedAt ?? existing?.updatedAt;
    const description = readDescription(
      entry.description ?? existing?.description,
    );
    const kind =
      entry.kind === "" ? undefined : (entry.kind ?? existing?.kind);
    const status =
      entry.kind === "" || entry.status === ""
        ? undefined
        : (entry.status ?? existing?.status);
    const next: StoredEntry = {
      title: entry.title,
      tags: [...(entry.tags ?? [])],
      ...(existing?.deleted === true ? { deleted: true as const } : {}),
      ...(createdAt === undefined ? {} : { createdAt }),
      ...(updatedAt === undefined ? {} : { updatedAt }),
      ...(description === undefined ? {} : { description }),
      ...(kind === undefined ? {} : { kind }),
      ...(status === undefined ? {} : { status }),
    };
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
    docs.set(
      uuid,
      carryForward(
        {
          title: existing?.title ?? "",
          tags: existing?.tags ?? [],
          deleted: true,
        },
        existing,
      ) satisfies StoredEntry,
    );
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
 * Nothing happens unless there is a tombstone to lift. An entry that is already
 * live is left alone rather than rewritten, so restoring twice does not publish
 * a second, identical update; and a uuid the directory has never seen stays
 * unknown, because there is nothing to bring back and inventing a live stub
 * would announce a document that does not exist. (`tombstoneDirectoryEntry`
 * does create an entry for an unseen uuid — it has to, since a delete must
 * replicate even when it overtakes the create it deletes.)
 *
 * Entries are whole-object writes, so a restore concurrent with a tombstone
 * converges on whichever update Yjs orders last — not on whichever human meant
 * it more recently.
 */
export function restoreDirectoryEntry(dirDoc: Y.Doc, uuid: string): void {
  const docs = getDirectoryMap(dirDoc);
  const existing = readStored(docs.get(uuid));
  if (existing?.deleted !== true) {
    return;
  }
  dirDoc.transact(() => {
    docs.set(
      uuid,
      carryForward(
        { title: existing.title, tags: existing.tags },
        existing,
      ) satisfies StoredEntry,
    );
  });
}

export interface ListDirectoryOptions {
  /** Include tombstoned entries. Default false. */
  includeDeleted?: boolean;
}

function toEntry(uuid: string, stored: StoredEntry): DirectoryEntry {
  return {
    uuid,
    title: stored.title,
    tags: stored.tags,
    ...(stored.deleted === true ? { deleted: true as const } : {}),
    ...(stored.createdAt === undefined ? {} : { createdAt: stored.createdAt }),
    ...(stored.updatedAt === undefined ? {} : { updatedAt: stored.updatedAt }),
    ...(stored.description === undefined
      ? {}
      : { description: stored.description }),
    ...(stored.kind === undefined ? {} : { kind: stored.kind }),
    ...(stored.status === undefined ? {} : { status: stored.status }),
  };
}

/** One entry by uuid, or null when unknown. Tombstones are returned as-is. */
export function getDirectoryEntry(
  dirDoc: Y.Doc,
  uuid: string,
): DirectoryEntry | null {
  const stored = readStored(getDirectoryMap(dirDoc).get(uuid));
  if (stored === null) return null;
  return toEntry(uuid, stored);
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
    out.push(toEntry(uuid, stored));
  }
  out.sort((a, b) => {
    if (a.title !== b.title) return a.title < b.title ? -1 : 1;
    return a.uuid < b.uuid ? -1 : a.uuid > b.uuid ? 1 : 0;
  });
  return out;
}

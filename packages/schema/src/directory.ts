/**
 * The directory document.
 *
 * Discovery is itself a synced doc: one Y.Doc per workspace, in the well-known
 * room `<workspaceId>/_directory` (see `rooms.ts`), holding a Y.Map of
 * uuid → {title, tags, deleted?, createdAt?, updatedAt?, description?, kind?,
 * status?} stubs, plus decision-only relationship and history display caches.
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
 * converge last-write-wins per key while different uuids never conflict. The
 * one exception is `updatedAt`: one max candidate per Yjs client is kept in a
 * sibling map, so a losing whole-entry write cannot discard the greater stamp.
 * Those candidates are never pruned, so state grows by one key per
 * `(uuid, Yjs client)` and resolving one entry scans the full candidate map.
 *
 * `createdAt` and `updatedAt` are epoch milliseconds read from the clock of
 * whichever replica wrote them, and they are cache-quality like the rest of the
 * stub: freshness hints good enough to sort a listing, never history and never
 * an audit trail. Concurrent `updatedAt` candidates resolve to the greater
 * finite number. A replica with a clock in the future therefore pins the stamp
 * until another authored write exceeds it; the clock merely catching up writes
 * nothing. Both fields are optional: an entry written before they existed
 * simply has none, so anything sorting on them must tolerate `undefined`
 * rather than assume a number.
 */

import type * as Y from "yjs";
import { readDocumentLifecycle } from "./types.js";
import { canonicalDocumentUuid } from "./rooms.js";
import { getMeta } from "./doc.js";
import { listAnnotations } from "./annotations.js";
import type {
  DirectoryEntry,
  DocMeta,
  DocumentKind,
  DocumentStatus,
} from "./types.js";

/** The key of the directory Y.Map inside the directory doc. */
export const DIRECTORY_DOCS_KEY = "docs";

/** Max-register candidates for directory `updatedAt`, keyed by uuid + client. */
const DIRECTORY_UPDATED_AT_KEY = "updatedAt";

interface StoredEntry {
  title: string;
  tags: string[];
  deleted?: boolean;
  createdAt?: number;
  updatedAt?: number;
  description?: string;
  kind?: DocumentKind;
  status?: DocumentStatus;
  governs?: string;
  topic?: string;
  supersedes?: string;
  tldr?: string;
  agentStance?: boolean;
  decidedBy?: string;
  decidedAt?: string;
  commentCount?: number;
}

function sameSet(a: readonly string[], b: readonly string[]): boolean {
  if (a.length !== b.length) return false;
  const left = new Set(a);
  for (const value of b) {
    if (!left.has(value)) return false;
  }
  return true;
}

/**
 * Shared web/MCP cache-repair rule: the document's metadata is authoritative.
 * A missing stub or different metadata or decision cache needs repair. Tag order is immaterial; absent and empty descriptions agree.
 * Each repair states all these fields from its replica's document, even if that
 * copy lags another replica's stub: the cache heals on observed updates rather
 * than arbitrating which copy is newer.
 *
 * Callers leave non-decision tombstones alone; decision caches still repair.
 * They also write a stub missing `createdAt`, even when its metadata agrees.
 * Every repair supplies that stamp;
 * `upsertDirectoryEntry` preserves an existing one. Authorship, clocks,
 * `updatedAt` coarseness and write gates remain the writer's responsibility.
 */
export function directoryStubDiffers(
  stub: DirectoryEntry | null,
  meta: DocMeta,
  fields?: DecisionDirectoryFields,
): boolean {
  return (
    stub === null ||
    stub.title !== meta.title ||
    !sameSet(stub.tags, meta.tags) ||
    (stub.description ?? "") !== (meta.description ?? "") ||
    stub.kind !== meta.kind ||
    stub.status !== meta.status ||
    (meta.kind === "decision" && (
      stub.governs !== meta.governs ||
      stub.topic !== meta.topic ||
      stub.supersedes !== meta.supersedes ||
      (stub.tldr ?? null) !== (meta.tldr ?? null) ||
      stub.agentStance !== meta.agentStance ||
      stub.decidedBy !== meta.decidedBy ||
      stub.decidedAt !== meta.decidedAt ||
      (fields !== undefined && stub.commentCount !== fields.commentCount)
    ))
  );
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

function getUpdatedAtMap(dirDoc: Y.Doc): Y.Map<unknown> {
  return dirDoc.getMap<unknown>(DIRECTORY_UPDATED_AT_KEY);
}

function greaterStamp(
  left: number | undefined,
  right: number | undefined,
): number | undefined {
  if (left === undefined) return right;
  if (right === undefined) return left;
  return Math.max(left, right);
}

function candidateKey(uuid: string, clientId: number): string {
  return `${uuid}:${clientId}`;
}

/**
 * The maximum candidate recorded for one entry. A flat map avoids a race to
 * install a nested shared type on legacy entries: concurrent writers use
 * distinct client keys, so both candidates survive their first exchange.
 */
function recordedUpdatedAt(dirDoc: Y.Doc, uuid: string): number | undefined {
  const prefix = `${uuid}:`;
  let resolved: number | undefined;
  for (const [key, value] of getUpdatedAtMap(dirDoc).entries()) {
    if (!key.startsWith(prefix)) continue;
    resolved = greaterStamp(resolved, readStamp(value));
  }
  return resolved;
}

function recordedUpdatedAts(dirDoc: Y.Doc): Map<string, number> {
  const resolved = new Map<string, number>();
  for (const [key, value] of getUpdatedAtMap(dirDoc).entries()) {
    const separator = key.lastIndexOf(":");
    const stamp = readStamp(value);
    if (separator < 1 || stamp === undefined) continue;
    const uuid = key.slice(0, separator);
    const greater = greaterStamp(resolved.get(uuid), stamp);
    if (greater !== undefined) resolved.set(uuid, greater);
  }
  return resolved;
}

function withResolvedUpdatedAt(
  stored: StoredEntry | null,
  recorded: number | undefined,
): StoredEntry | null {
  if (stored === null) return null;
  const updatedAt = greaterStamp(stored.updatedAt, recorded);
  return {
    ...stored,
    ...(updatedAt === undefined ? {} : { updatedAt }),
  };
}

const DECISION_CACHE_KEYS = [
  "governs", "topic", "supersedes", "tldr", "agentStance", "decidedBy",
  "decidedAt", "commentCount",
] as const;

/** Tolerant reads of the decision-only cache; unknown foreign values vanish. */
function readDecisionFields(value: Record<string, unknown>): Partial<StoredEntry> {
  const fields: Partial<StoredEntry> = {};
  for (const key of ["governs", "topic", "supersedes"] as const) {
    const uuid = canonicalDocumentUuid(value[key]);
    if (uuid !== null) fields[key] = uuid;
  }
  if (typeof value.tldr === "string" && value.tldr !== "") fields.tldr = value.tldr;
  for (const key of ["decidedBy", "decidedAt"] as const) {
    const text = value[key];
    if (typeof text === "string" && text.trim() !== "") fields[key] = text;
  }
  if (typeof value.agentStance === "boolean") fields.agentStance = value.agentStance;
  if (typeof value.commentCount === "number" && Number.isSafeInteger(value.commentCount) && value.commentCount >= 0) {
    fields.commentCount = value.commentCount;
  }
  return fields;
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
    ...(lifecycle.kind === "decision" ? readDecisionFields(value as Record<string, unknown>) : {}),
  };
}

/**
 * Carry the fields of an entry that is being rewritten but not restated: its
 * timestamps, description, lifecycle and decision caches.
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
    ...(from?.kind === "decision" ? readDecisionFields(from as unknown as Record<string, unknown>) : {}),
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
   * When this replica authored a document change, epoch ms. The greater finite
   * stamp wins; a lower, missing or malformed value cannot lower the resolved
   * one. A writer that only means to fix another field may omit it.
   */
  updatedAt?: number;
  /**
   * The document's description, cached here for listings. Written when given and
   * carried forward untouched otherwise. Document repairs state it explicitly;
   * writers changing only other fields can omit it to preserve the cache.
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
  /** Decision-only fields: omission preserves, null/empty clears. */
  governs?: string | null;
  topic?: string | null;
  supersedes?: string | null;
  tldr?: string | null;
  agentStance?: boolean | null;
  decidedBy?: string | null;
  decidedAt?: string | null;
  commentCount?: number | null;
}

export type DecisionDirectoryFields = Pick<DirectoryUpsert,
  "governs" | "topic" | "supersedes" | "tldr" | "agentStance" |
  "decidedBy" | "decidedAt" | "commentCount">;

/** Hydrated writers restate every decision cache, including deliberate clears. */
export function decisionDirectoryFields(doc: Y.Doc): DecisionDirectoryFields {
  const meta = getMeta(doc);
  if (meta.kind !== "decision") return {};
  return {
    governs: meta.governs ?? null,
    topic: meta.topic ?? meta.uuid,
    supersedes: meta.supersedes ?? null,
    tldr: meta.tldr ?? null,
    agentStance: meta.agentStance ?? null,
    decidedBy: meta.decidedBy ?? null,
    decidedAt: meta.decidedAt ?? null,
    commentCount: listAnnotations(doc).reduce((count, thread) => count + thread.comments.length, 0),
  };
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
    const existing = withResolvedUpdatedAt(
      readStored(docs.get(entry.uuid)),
      recordedUpdatedAt(dirDoc, entry.uuid),
    );
    const createdAt = existing?.createdAt ?? entry.createdAt;
    const candidate = readStamp(entry.updatedAt);
    const updatedAt = greaterStamp(existing?.updatedAt, candidate);
    if (
      candidate !== undefined &&
      (existing?.updatedAt === undefined || candidate > existing.updatedAt)
    ) {
      getUpdatedAtMap(dirDoc).set(
        candidateKey(entry.uuid, dirDoc.clientID),
        candidate,
      );
    }
    const description = readDescription(
      entry.description ?? existing?.description,
    );
    const kind =
      entry.kind === "" ? undefined : (entry.kind ?? existing?.kind);
    const status =
      entry.kind === "" || entry.status === ""
        ? undefined
        : (entry.status ?? existing?.status);
    const cache: Record<string, unknown> = {};
    for (const key of DECISION_CACHE_KEYS) cache[key] = entry[key] === undefined ? existing?.[key] : entry[key];
    const next: StoredEntry = {
      title: entry.title,
      tags: [...(entry.tags ?? [])],
      ...(existing?.deleted === true ? { deleted: true as const } : {}),
      ...(createdAt === undefined ? {} : { createdAt }),
      ...(updatedAt === undefined ? {} : { updatedAt }),
      ...(description === undefined ? {} : { description }),
      ...(kind === undefined ? {} : { kind }),
      ...(status === undefined ? {} : { status }),
      ...(kind === "decision" ? readDecisionFields(cache) : {}),
    };
    docs.set(entry.uuid, next);
  });
}

/**
 * Tombstone a directory entry: sets `deleted: true` and keeps the entry, so the
 * deletion itself replicates. Entries are never removed from the map.
 */
function tombstoneOneDirectoryEntry(dirDoc: Y.Doc, uuid: string, topic?: string): void {
  const docs = getDirectoryMap(dirDoc);
  dirDoc.transact(() => {
    const existing = withResolvedUpdatedAt(
      readStored(docs.get(uuid)),
      recordedUpdatedAt(dirDoc, uuid),
    );
    docs.set(
      uuid,
      carryForward(
        {
          title: existing?.title ?? "",
          tags: existing?.tags ?? [],
          deleted: true,
          // A missing first record still owns its decision topic's lifecycle.
          ...(existing === null && topic !== undefined ? { kind: "decision" as const, topic } : {}),
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
function restoreOneDirectoryEntry(dirDoc: Y.Doc, uuid: string): void {
  const docs = getDirectoryMap(dirDoc);
  const existing = withResolvedUpdatedAt(
    readStored(docs.get(uuid)),
    recordedUpdatedAt(dirDoc, uuid),
  );
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

/** First-record authority for a decision topic; ordinary records own their state. */
export function decisionTopicArchived(dirDoc: Y.Doc, uuid: string): boolean {
  const entry = getDirectoryEntry(dirDoc, uuid);
  if (entry?.kind !== "decision") return entry?.deleted === true;
  return getDirectoryEntry(dirDoc, entry.topic ?? entry.uuid)?.deleted === true;
}

/** All observed topic records, including the authority even if its stub is missing. */
function archiveTargets(dirDoc: Y.Doc, uuid: string): string[] {
  const entry = getDirectoryEntry(dirDoc, uuid);
  if (entry?.kind !== "decision") return [uuid];
  const topic = entry.topic ?? entry.uuid;
  const records = listDirectory(dirDoc, { includeDeleted: true })
    .filter((record) => record.kind === "decision" && (record.topic ?? record.uuid) === topic)
    .map((record) => record.uuid).sort();
  return [topic, ...records.filter((record) => record !== topic)];
}

/** Archive a decision's whole topic; directory-only writes retain all caches. */
export function tombstoneDirectoryEntry(dirDoc: Y.Doc, uuid: string): string[] {
  const targets = archiveTargets(dirDoc, uuid);
  const entry = getDirectoryEntry(dirDoc, uuid);
  const topic = entry?.kind === "decision" ? (entry.topic ?? entry.uuid) : undefined;
  dirDoc.transact(() => { for (const target of targets) tombstoneOneDirectoryEntry(dirDoc, target, topic); });
  return targets;
}

/** Restore a decision's whole topic; no document room needs hydration. */
export function restoreDirectoryEntry(dirDoc: Y.Doc, uuid: string): string[] {
  const targets = archiveTargets(dirDoc, uuid);
  dirDoc.transact(() => { for (const target of targets) restoreOneDirectoryEntry(dirDoc, target); });
  return targets;
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
    ...(stored.kind === "decision" ? readDecisionFields(stored as unknown as Record<string, unknown>) : {}),
  };
}

/** One entry by uuid, or null when unknown. Tombstones are returned as-is. */
export function getDirectoryEntry(
  dirDoc: Y.Doc,
  uuid: string,
): DirectoryEntry | null {
  const stored = withResolvedUpdatedAt(
    readStored(getDirectoryMap(dirDoc).get(uuid)),
    recordedUpdatedAt(dirDoc, uuid),
  );
  if (stored === null) return null;
  return toEntry(uuid, stored);
}

/**
 * List entries in replica-stable code-unit order: title, then uuid.
 *
 * Deliberately `<` / `>`, not locale collation: this order is mirrored by the
 * web pane so it and `list_docs` produce the same sequence on every replica.
 */
export function listDirectory(
  dirDoc: Y.Doc,
  options: ListDirectoryOptions = {},
): DirectoryEntry[] {
  const includeDeleted = options.includeDeleted ?? false;
  const out: DirectoryEntry[] = [];
  const updatedAts = recordedUpdatedAts(dirDoc);
  for (const [uuid, value] of getDirectoryMap(dirDoc).entries()) {
    const stored = withResolvedUpdatedAt(
      readStored(value),
      updatedAts.get(uuid),
    );
    if (stored === null) continue;
    if (!includeDeleted) {
      const archived = stored.kind === "decision"
        ? readStored(getDirectoryMap(dirDoc).get(stored.topic ?? uuid))?.deleted === true
        : stored.deleted === true;
      if (archived) continue;
    }
    out.push(toEntry(uuid, stored));
  }
  out.sort((a, b) => {
    if (a.title !== b.title) return a.title < b.title ? -1 : 1;
    return a.uuid < b.uuid ? -1 : a.uuid > b.uuid ? 1 : 0;
  });
  return out;
}

/**
 * Discovery comes from this synced workspace room, never local create history.
 * Stubs cache document metadata; hydrated writers repair them on write/connect.
 */

import type * as Y from "yjs";
import { readDocumentLifecycle } from "./types.js";
import { canonicalDocumentUuid } from "./rooms.js";
import { getMeta } from "./doc.js";
import { listAnnotations } from "./annotations.js";
import { decisionApprovalChanged } from "./approval.js";
import { decisionAnswerPreview } from "./decision-answer.js";
import { readCodeChecks } from "./code-check.js";
import type {
  CodeCheck,
  DirectoryEntry,
  DocMeta,
  DocumentKind,
  DocumentStatus,
} from "./types.js";

/** Whole-object per-uuid writes merge independently; same-key writes use Yjs order. */
export const DIRECTORY_DOCS_KEY = "docs";

/** Grow-only deletion evidence, independent of whole-entry metadata writes. */
export const DIRECTORY_DELETED_KEY = "deleted-docs";

/**
 * Per-client max candidates survive losing whole-stub writes. Retained until
 * permanent deletion: one key per uuid/client; a resolution scans the map.
 */
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
  openThreadCount?: number;
  code_check?: CodeCheck[];
  governs?: string;
  topic?: string;
  supersedes?: string;
  discussion?: string | null;
  answerPreview?: string | null;
  agentStance?: boolean;
  decidedBy?: string;
  decidedAt?: string;
  approvalChanged?: boolean;
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

function sameCodeChecks(a: CodeCheck[] | undefined, b: CodeCheck[]): boolean {
  if (a === undefined || a.length !== b.length) return false;
  const checks = new Map(a.map((check) => [check.repository, check]));
  return b.every((check) => {
    const cached = checks.get(check.repository);
    return cached?.commit === check.commit && cached.checked_at === check.checked_at && cached.result === check.result;
  });
}

/**
 * Repair from the hydrated document even when it lags the stub; tag order and
 * empty descriptions do not differ. Callers preserve ordinary tombstones,
 * repair document caches, and backfill createdAt. They own clocks, authorship,
 * timestamp coarseness and write gates; cache-only repairs may omit updatedAt.
 */
export function directoryStubDiffers(
  stub: DirectoryEntry | null,
  meta: DocMeta,
  fields?: Partial<DocumentDirectoryFields>,
): boolean {
  return (
    stub === null ||
    stub.title !== meta.title ||
    !sameSet(stub.tags, meta.tags) ||
    (stub.description ?? "") !== (meta.description ?? "") ||
    stub.kind !== meta.kind ||
    stub.status !== meta.status ||
    (fields?.openThreadCount !== undefined && stub.openThreadCount !== fields.openThreadCount) ||
    (meta.kind !== "decision" && fields?.code_check !== undefined && !sameCodeChecks(stub.code_check, fields.code_check)) ||
    (meta.kind === "decision" && (
      stub.governs !== meta.governs ||
      stub.topic !== meta.topic ||
      stub.supersedes !== meta.supersedes ||
      stub.discussion !== (meta.discussion ?? null) ||
      stub.agentStance !== meta.agentStance ||
      stub.decidedBy !== meta.decidedBy ||
      stub.decidedAt !== meta.decidedAt ||
      (fields !== undefined && stub.approvalChanged !== fields.approvalChanged) ||
      (fields !== undefined && stub.answerPreview !== fields.answerPreview) ||
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
 * Blank, malformed and absent descriptions share the same public absence.
 */
function readDescription(value: unknown): string | undefined {
  return typeof value === "string" && value !== "" ? value : undefined;
}

function readCount(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0
    ? value
    : undefined;
}

function readRegularCodeChecks(kind: DocumentKind | undefined, value: unknown, cached?: CodeCheck[]): CodeCheck[] | undefined {
  if (kind === "decision") return undefined;
  return readCodeChecks(value === undefined ? cached : value);
}

export function getDirectoryMap(dirDoc: Y.Doc): Y.Map<unknown> {
  return dirDoc.getMap<unknown>(DIRECTORY_DOCS_KEY);
}

function getUpdatedAtMap(dirDoc: Y.Doc): Y.Map<unknown> {
  return dirDoc.getMap<unknown>(DIRECTORY_UPDATED_AT_KEY);
}

/** Absence is never deletion evidence; only an explicit permanent mark is. */
export function isDirectoryEntryDeleted(dirDoc: Y.Doc, uuid: string): boolean {
  return dirDoc.getMap<unknown>(DIRECTORY_DELETED_KEY).get(uuid) === true;
}

/** Deleted UUIDs remain discoverable for physical replica and hub cleanup. */
export function listDeletedDirectoryUuids(dirDoc: Y.Doc): string[] {
  return [...dirDoc.getMap<unknown>(DIRECTORY_DELETED_KEY).entries()]
    .filter(([uuid, value]) => canonicalDocumentUuid(uuid) === uuid && value === true)
    .map(([uuid]) => uuid)
    .sort();
}

/** Remove metadata that an unseen whole-entry writer may have reintroduced. */
export function enforceDeletedDirectoryEntries(dirDoc: Y.Doc): void {
  const deleted = new Set(listDeletedDirectoryUuids(dirDoc));
  if (deleted.size === 0) return;
  dirDoc.transact(() => {
    const docs = getDirectoryMap(dirDoc);
    for (const uuid of deleted) {
      if (docs.has(uuid)) docs.delete(uuid);
    }
    const stamps = getUpdatedAtMap(dirDoc);
    for (const key of stamps.keys()) {
      const separator = key.lastIndexOf(":");
      if (separator > 0 && deleted.has(key.slice(0, separator))) stamps.delete(key);
    }
  });
}

/** The caller owns access and archive checks; permanent deletion applies to any UUID. */
export function deleteDirectoryEntry(dirDoc: Y.Doc, uuid: string): void {
  dirDoc.transact(() => {
    if (!isDirectoryEntryDeleted(dirDoc, uuid)) {
      dirDoc.getMap<unknown>(DIRECTORY_DELETED_KEY).set(uuid, true);
    }
    enforceDeletedDirectoryEntries(dirDoc);
  });
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
 * A flat map avoids racing to install a nested type; distinct client keys keep
 * both first writes. Future clock stamps persist until an authored write exceeds them.
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
  "governs", "topic", "supersedes", "agentStance", "decidedBy",
  "decidedAt", "approvalChanged", "commentCount", "answerPreview", "discussion",
] as const;

/** Tolerant reads of the decision-only cache; unknown foreign values vanish. */
function readDecisionFields(value: Record<string, unknown>): Partial<StoredEntry> {
  const fields: Partial<StoredEntry> = {};
  for (const key of ["governs", "topic", "supersedes"] as const) {
    const uuid = canonicalDocumentUuid(value[key]);
    if (uuid !== null) fields[key] = uuid;
  }
  const discussion = canonicalDocumentUuid(value.discussion);
  if (value.discussion === null || discussion !== null) fields.discussion = discussion;
  if (value.answerPreview === null || typeof value.answerPreview === "string") fields.answerPreview = value.answerPreview;
  for (const key of ["decidedBy", "decidedAt"] as const) {
    const text = value[key];
    if (typeof text === "string" && text.trim() !== "") fields[key] = text;
  }
  if (typeof value.agentStance === "boolean") fields.agentStance = value.agentStance;
  if (typeof value.approvalChanged === "boolean") fields.approvalChanged = value.approvalChanged;
  const commentCount = readCount(value.commentCount);
  if (commentCount !== undefined) fields.commentCount = commentCount;
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
  const openThreadCount = readCount(candidate.openThreadCount);
  const codeCheck = readRegularCodeChecks(lifecycle.kind, candidate.code_check);
  return {
    title,
    tags,
    ...(candidate.deleted === true ? { deleted: true as const } : {}),
    ...(createdAt === undefined ? {} : { createdAt }),
    ...(updatedAt === undefined ? {} : { updatedAt }),
    ...(description === undefined ? {} : { description }),
    ...lifecycle,
    ...(openThreadCount === undefined ? {} : { openThreadCount }),
    ...(codeCheck === undefined ? {} : { code_check: codeCheck }),
    ...(lifecycle.kind === "decision" ? readDecisionFields(value as Record<string, unknown>) : {}),
  };
}

/**
 * Whole-object rewrites must carry timestamps, description and lifecycle/cache
 * fields they do not restate, or those fields are erased.
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
    ...(from?.openThreadCount === undefined ? {} : { openThreadCount: from.openThreadCount }),
    ...(from?.kind === "decision" || from?.code_check === undefined ? {} : { code_check: from.code_check }),
    ...(from?.kind === "decision" ? readDecisionFields(from as unknown as Record<string, unknown>) : {}),
  };
}

export interface DirectoryUpsert {
  uuid: string;
  title: string;
  tags?: string[];
  /**
   * Optional replica-clock epoch ms, a display hint rather than audit history.
   * Existing values survive repeat writes; omitted values may be backfilled.
   */
  createdAt?: number;
  /**
   * Optional authored-change epoch ms; clocks are display hints, not history.
   * Lower, missing or malformed candidates cannot lower the resolved maximum.
   * Cache-only repairs may omit it; clock catch-up alone produces no update.
   */
  updatedAt?: number;
  /**
   * Omission preserves the cache; empty string clears it. Hydrated repairs
   * state the description explicitly to propagate deliberate removal.
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
  /** Omission preserves the cache; null clears it to unknown. */
  openThreadCount?: number | null;
  /** Regular-only cache: omission preserves it, null clears it to unknown. */
  code_check?: CodeCheck[] | null;
  /** Decision-only fields: omission preserves, null/empty clears. */
  governs?: string | null;
  topic?: string | null;
  supersedes?: string | null;
  discussion?: string | null;
  answerPreview?: string | null;
  agentStance?: boolean | null;
  decidedBy?: string | null;
  decidedAt?: string | null;
  approvalChanged?: boolean | null;
  commentCount?: number | null;
}

export type DecisionDirectoryFields = Pick<DirectoryUpsert,
  "governs" | "topic" | "supersedes" | "agentStance" |
  "decidedBy" | "decidedAt" | "approvalChanged" | "commentCount" | "answerPreview" | "discussion">;

export type DocumentDirectoryFields = DecisionDirectoryFields & { openThreadCount: number; code_check?: CodeCheck[] };

/** Hydrated writers recompute every document cache instead of carrying stale values. */
export function documentDirectoryFields(doc: Y.Doc): DocumentDirectoryFields {
  const meta = getMeta(doc);
  return {
    ...decisionDirectoryFields(doc),
    openThreadCount: listAnnotations(doc).filter((thread) => thread.resolved !== true).length,
    ...(meta.kind === "decision" ? {} : { code_check: meta.code_check ?? [] }),
  };
}

/** Hydrated writers restate every decision cache, including deliberate clears. */
export function decisionDirectoryFields(doc: Y.Doc): DecisionDirectoryFields {
  const meta = getMeta(doc);
  if (meta.kind !== "decision") return {};
  return {
    governs: meta.governs ?? null,
    topic: meta.topic ?? meta.uuid,
    supersedes: meta.supersedes ?? null,
    discussion: meta.discussion ?? null,
    answerPreview: decisionAnswerPreview(doc),
    agentStance: meta.agentStance ?? null,
    decidedBy: meta.decidedBy ?? null,
    decidedAt: meta.decidedAt ?? null,
    approvalChanged: decisionApprovalChanged(doc),
    commentCount: listAnnotations(doc).reduce((count, thread) => count + thread.comments.length, 0),
  };
}

/**
 * Upserts on create/rename/retag retain observed tombstones. An offline upsert
 * that has not seen an archive can win the whole-entry conflict and resurrect
 * the document; stickiness is observed state, not a concurrent merge rule.
 */
export function upsertDirectoryEntry(
  dirDoc: Y.Doc,
  entry: DirectoryUpsert,
): void {
  if (isDirectoryEntryDeleted(dirDoc, entry.uuid)) return;
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
    const openThreadCount = readCount(
      entry.openThreadCount === undefined ? existing?.openThreadCount : entry.openThreadCount,
    );
    const codeCheck = readRegularCodeChecks(kind, entry.code_check, existing?.code_check);
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
      ...(openThreadCount === undefined ? {} : { openThreadCount }),
      ...(codeCheck === undefined ? {} : { code_check: codeCheck }),
      ...(kind === "decision" ? readDecisionFields(cache) : {}),
    };
    docs.set(entry.uuid, next);
  });
}

/**
 * Keep entries in the map so deletion replicates, even when it overtakes creation.
 */
function tombstoneOneDirectoryEntry(dirDoc: Y.Doc, uuid: string, topic?: string): void {
  if (isDirectoryEntryDeleted(dirDoc, uuid)) return;
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
 * Only an observed tombstone is lifted; live/unknown entries produce no update.
 * Preserve all cached fields. Concurrent restore/archive writes follow Yjs key
 * order, which does not represent the recency of a person's intent.
 */
function restoreOneDirectoryEntry(dirDoc: Y.Doc, uuid: string): void {
  if (isDirectoryEntryDeleted(dirDoc, uuid)) return;
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
    ...(stored.openThreadCount === undefined ? {} : { openThreadCount: stored.openThreadCount }),
    ...(stored.kind === "decision" || stored.code_check === undefined ? {} : { code_check: stored.code_check }),
    ...(stored.kind === "decision" ? readDecisionFields(stored as unknown as Record<string, unknown>) : {}),
  };
}

/** One entry by uuid, or null when unknown or permanently deleted. Archives remain readable. */
export function getDirectoryEntry(
  dirDoc: Y.Doc,
  uuid: string,
): DirectoryEntry | null {
  if (isDirectoryEntryDeleted(dirDoc, uuid)) return null;
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
    if (isDirectoryEntryDeleted(dirDoc, uuid)) continue;
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

/**
 * Document layout and metadata.
 *
 * A document is one Y.Doc (room name = document UUID) with exactly four
 * top-level shared types:
 *
 *   - `meta`        Y.Map     — uuid, title, description, TL;DR, changelog
 *                              suggestion, `tag-assigned:<identity>` presence
 *                              entries, links, kind, status and decision
 *                              remove/add levels
 *   - `blocks`      Y.XmlFragment — one Y.XmlElement per block
 *   - `annotations` Y.Map     — threadId → that thread's own Y.Map
 *   - `decisions`   Y.Array   — decision-document uuids, in stored order
 *
 * ## The decision log
 *
 * `decisions` is a fixed slot, not a block: which decision documents govern
 * this one, in the order a reader should scan them. Order is stored rather than
 * derived, because a list assembled from backlinks is unordered and its
 * membership shifts as links change.
 *
 * It holds plain uuid strings and nothing else, for the reason `sidebar.ts`
 * already gives for its group order: Yjs has no move, so reordering is
 * delete-then-insert, and moving an element that carried its own content would
 * clone-and-destroy it — dropping whatever another replica wrote into that
 * element concurrently. A string reorders losslessly.
 *
 * The slot is not a substitute for `meta.links`. A document referencing a
 * decision carries it in both: the slot is the ordered log a reader scans, and
 * `links` is the graph edge `backlinks` answers from.
 *
 * Every writer here runs inside `ydoc.transact`. Callers that want their own
 * transaction origin (agent attribution, undo scoping) can wrap any call in
 * their own `ydoc.transact(fn, origin)`: Yjs merges the nested transaction into
 * the outer one and keeps the outer origin.
 */

import type * as Y from "yjs";
import { getDirectoryEntry } from "./directory.js";
import {
  InvalidDecisionReferenceError,
  InvalidDocumentLifecycleError,
} from "./errors.js";
import { canonicalDocumentUuid } from "./rooms.js";
import {
  isDocumentKind,
  isDocumentStatusForKind,
  readDocumentLifecycle,
} from "./types.js";
import type {
  DecisionReference,
  DocMeta,
  DocumentKind,
  DocumentStatus,
} from "./types.js";

export const META_KEY = "meta";
export const BLOCKS_KEY = "blocks";
export const ANNOTATIONS_KEY = "annotations";
export const DECISIONS_KEY = "decisions";

/**
 * One flat presence key per tag keeps independent toggles independent. A
 * same-key set/delete conflict follows Yjs's set-wins semantics.
 */
const TAG_ASSIGNED_PREFIX = "tag-assigned:";

/** Flat `meta` keys keep each replica's decision-removal level independent. */
const DECISION_REMOVED_PREFIX = "decision-removed:";

/** The matching deliberate re-add level; absent means the original add. */
const DECISION_ADDED_PREFIX = "decision-added:";

/** Separates a decision uuid from the Y.Doc client id that owns one counter. */
const DECISION_LEVEL_SEPARATOR = "#";

/** The `meta` Y.Map. Created on first access, as Yjs root types are. */
export function getMetaMap(ydoc: Y.Doc): Y.Map<unknown> {
  return ydoc.getMap<unknown>(META_KEY);
}

/**
 * The `blocks` Y.XmlFragment.
 *
 * Exposed because the web client binds this fragment directly to
 * Tiptap/y-prosemirror — the block shape exists to make that binding native.
 */
export function getBlocksFragment(ydoc: Y.Doc): Y.XmlFragment {
  return ydoc.getXmlFragment(BLOCKS_KEY);
}

/**
 * The `annotations` Y.Map: threadId → that thread's own Y.Map.
 *
 * The value is a Y type and not plain JSON, because a thread's conversation is
 * a Y.Array nested inside it — see `annotations.ts` for why the conversation
 * must not be a field of a replaced JSON value.
 */
export function getAnnotationsMap(ydoc: Y.Doc): Y.Map<unknown> {
  return ydoc.getMap<unknown>(ANNOTATIONS_KEY);
}

/** The `decisions` Y.Array: decision-document uuids, in stored order. */
export function getDecisionsArray(ydoc: Y.Doc): Y.Array<string> {
  return ydoc.getArray<string>(DECISIONS_KEY);
}

export interface InitDocOptions {
  uuid: string;
  title: string;
  tags?: string[];
  /**
   * One or two sentences saying what the document is for. Optional here because
   * the web UI creates documents without one; MCP's `create_doc` requires it.
   */
  description?: string;
}

/**
 * Initialise a fresh document: write identity metadata and materialise the
 * four root types.
 *
 * Idempotent for uuid/title/tags (they are overwritten with what is passed);
 * `links` is only seeded when absent, so re-initialising never drops links.
 * `description` is written only when one is given, so re-initialising a
 * document without one does not erase the description it since acquired.
 */
export function initDoc(ydoc: Y.Doc, options: InitDocOptions): void {
  const meta = getMetaMap(ydoc);
  ydoc.transact(() => {
    meta.set("uuid", options.uuid);
    meta.set("title", options.title);
    replaceTags(meta, options.tags ?? []);
    if (options.description !== undefined) {
      meta.set("description", options.description);
    }
    if (!meta.has("links")) meta.set("links", []);
    // Touch the other roots so they exist in the update stream from the start.
    getBlocksFragment(ydoc);
    getAnnotationsMap(ydoc);
    getDecisionsArray(ydoc);
  });
}

function readStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((entry): entry is string => typeof entry === "string");
}

/** Deterministic public view over the flat per-tag presence entries. */
function storedTags(meta: Y.Map<unknown>): string[] {
  const tags: string[] = [];
  for (const [key, value] of meta.entries()) {
    if (key.startsWith(TAG_ASSIGNED_PREFIX) && value === true) {
      tags.push(key.slice(TAG_ASSIGNED_PREFIX.length));
    }
  }
  return tags.sort();
}

/**
 * Make the assignment equal to `tags`, writing only the tags whose presence
 * changed. An unchanged tag must not compete with another replica's toggle.
 */
function replaceTags(meta: Y.Map<unknown>, tags: readonly string[]): void {
  const next = new Set(tags);
  for (const key of meta.keys()) {
    if (
      key.startsWith(TAG_ASSIGNED_PREFIX) &&
      !next.has(key.slice(TAG_ASSIGNED_PREFIX.length))
    ) {
      meta.delete(key);
    }
  }
  for (const tag of next) {
    const key = `${TAG_ASSIGNED_PREFIX}${tag}`;
    if (meta.get(key) !== true) meta.set(key, true);
  }
}

/** Highest per-client level recorded for one decision and one operation. */
function decisionLevel(
  meta: Y.Map<unknown>,
  prefix: string,
  uuid: string,
): number {
  const keyPrefix = `${prefix}${uuid}${DECISION_LEVEL_SEPARATOR}`;
  let level = 0;
  for (const [key, value] of meta.entries()) {
    if (
      key.startsWith(keyPrefix) &&
      typeof value === "number" &&
      Number.isSafeInteger(value) &&
      value > level
    ) {
      level = value;
    }
  }
  return level;
}

/** A remove hides every older add; an add at the same level restores it. */
function decisionIsVisible(ydoc: Y.Doc, uuid: string): boolean {
  const meta = getMetaMap(ydoc);
  return (
    decisionLevel(meta, DECISION_ADDED_PREFIX, uuid) >=
    decisionLevel(meta, DECISION_REMOVED_PREFIX, uuid)
  );
}

/**
 * Read metadata, with defaults for anything not yet written.
 *
 * `description` is null rather than empty when there is none: absent and blank
 * are the same fact — nobody has said what this document is for — and one shape
 * for it keeps every reader from having to test for both.
 */
export function getMeta(ydoc: Y.Doc): DocMeta & { tldr: string | null } {
  const meta = getMetaMap(ydoc);
  const uuid = meta.get("uuid");
  const title = meta.get("title");
  const description = meta.get("description");
  const tldr = meta.get("tldr");
  const lifecycle = readDocumentLifecycle(meta.get("kind"), meta.get("status"));
  return {
    uuid: typeof uuid === "string" ? uuid : "",
    title: typeof title === "string" ? title : "",
    tags: storedTags(meta),
    description:
      typeof description === "string" && description !== "" ? description : null,
    tldr: typeof tldr === "string" && tldr !== "" ? tldr : null,
    ...readChangelogSuggestion(meta.get("changelogSuggestion")),
    ...lifecycle,
    links: effectiveLinks(ydoc, readStringArray(meta.get("links"))),
  };
}

/**
 * The three states of {@link DocMeta.changelogSuggestion}, read tolerantly.
 *
 * One key carries all three, so concurrent writers converge on one state rather
 * than on an invalid pair. Stored null is the deliberate "no user-facing entry";
 * a non-empty string is the suggestion; anything else — no key at all, or a
 * value only a foreign writer could have left — is nobody having written one.
 */
function readChangelogSuggestion(
  value: unknown,
): { changelogSuggestion?: string | null } {
  if (value === null) return { changelogSuggestion: null };
  if (typeof value === "string" && value !== "") {
    return { changelogSuggestion: value };
  }
  return {};
}

export function setTitle(ydoc: Y.Doc, title: string): void {
  const meta = getMetaMap(ydoc);
  ydoc.transact(() => {
    meta.set("title", title);
  });
}

/**
 * Replace the description wholesale — there is no partial edit of it, because
 * one or two sentences are rewritten, not patched.
 *
 * The document is authoritative; whoever writes here is responsible for
 * bringing the directory stub along, exactly as a rename is. Length is not
 * enforced here, as it is not for a title: {@link MAX_DESCRIPTION_LENGTH} is the
 * number the write boundaries check against.
 *
 * The empty string is how a description is removed: `getMeta` reads it back as
 * null, and a stub upsert given it drops the cached copy.
 */
export function setDescription(ydoc: Y.Doc, description: string): void {
  const meta = getMetaMap(ydoc);
  ydoc.transact(() => {
    meta.set("description", description);
  });
}

/**
 * Replace or clear the person-facing summary wholesale.
 *
 * Length is enforced by write boundaries through `MAX_TLDR_LENGTH`, not here.
 * A clear stores null so it competes with concurrent whole-value writes like
 * the document's other metadata rather than behaving like key deletion.
 */
export function setTldr(ydoc: Y.Doc, tldr: string | null): void {
  const meta = getMetaMap(ydoc);
  ydoc.transact(() => {
    meta.set("tldr", tldr);
  });
}

/**
 * Write the changelog suggestion, or clear it back to absent.
 *
 * `null` is the deliberate decision that this work needs no user-facing entry,
 * and is stored as null. The empty string removes the key instead, so the field
 * reads as nobody having written one rather than as that decision — the two are
 * different answers and only the key distinguishes them.
 *
 * Length is not enforced here, exactly as it is not for a description: the write
 * boundary checks it against {@link MAX_DESCRIPTION_LENGTH}. The directory stub
 * does not cache the field, so nothing follows this write.
 */
export function setChangelogSuggestion(
  ydoc: Y.Doc,
  suggestion: string | null,
): void {
  const meta = getMetaMap(ydoc);
  ydoc.transact(() => {
    if (suggestion === "") {
      meta.delete("changelogSuggestion");
    } else {
      meta.set("changelogSuggestion", suggestion);
    }
  });
}

/**
 * Set the document's record shape, validating it against the stored status.
 *
 * The empty string clears both keys: a status cannot outlive its kind. A
 * non-empty write never clears or masks an incompatible status on the caller's
 * behalf; it refuses before the transaction instead.
 */
export function setKind(ydoc: Y.Doc, kind: DocumentKind | ""): void {
  const meta = getMetaMap(ydoc);
  const storedStatus = meta.get("status");
  if (
    kind !== "" &&
    (!isDocumentKind(kind) ||
      (meta.has("status") &&
        storedStatus !== "" &&
        !isDocumentStatusForKind(kind, storedStatus)))
  ) {
    throw new InvalidDocumentLifecycleError(kind, storedStatus);
  }

  ydoc.transact(() => {
    meta.set("kind", kind);
    if (kind === "") meta.set("status", "");
  });
}

/**
 * Set the lifecycle state, validating it against the kind stored right now.
 * The empty string clears only the status and leaves the kind intact.
 */
export function setStatus(ydoc: Y.Doc, status: DocumentStatus | ""): void {
  const meta = getMetaMap(ydoc);
  const storedKind = meta.get("kind");
  if (
    status !== "" &&
    (!isDocumentKind(storedKind) ||
      !isDocumentStatusForKind(storedKind, status))
  ) {
    throw new InvalidDocumentLifecycleError(storedKind, status);
  }

  ydoc.transact(() => {
    meta.set("status", status);
  });
}

/**
 * The stored references, canonicalized, in stored order.
 *
 * Two read-side rules, both the same ones `readSidebar` applies and for the
 * same reason — every replica computes the same answer from the same state,
 * without agreeing on anything first. A value that is not a document uuid is
 * skipped, because only a foreign writer could have put one there; and a uuid
 * appearing more than once keeps its first occurrence, because two replicas
 * reordering concurrently each delete-and-insert and storage ends up holding it
 * twice. The write side refuses duplicates, which a merge can still produce.
 * Ordinarily the first occurrence wins, matching sidebar order. After an
 * explicit remove and re-add, the last occurrence wins instead: `addDecision`
 * appends, so an unseen reorder of the removed occurrence cannot pull that
 * deliberate restoration back to its stale position when the replicas merge.
 */
function storedDecisions(ydoc: Y.Doc): string[] {
  const meta = getMetaMap(ydoc);
  const values = getDecisionsArray(ydoc)
    .toArray()
    .map((value) => canonicalDocumentUuid(value));
  const restoredLastIndex = new Map<string, number>();
  for (const [index, uuid] of values.entries()) {
    if (
      uuid !== null &&
      decisionLevel(meta, DECISION_ADDED_PREFIX, uuid) > 0
    ) {
      restoredLastIndex.set(uuid, index);
    }
  }

  const seen = new Set<string>();
  const out: string[] = [];
  for (const [index, uuid] of values.entries()) {
    if (uuid === null || seen.has(uuid)) continue;
    if (!decisionIsVisible(ydoc, uuid)) continue;
    const restoredAt = restoredLastIndex.get(uuid);
    if (restoredAt !== undefined && restoredAt !== index) continue;
    seen.add(uuid);
    out.push(uuid);
  }
  return out;
}

/**
 * The public graph edges: curated replacements plus every active decision.
 *
 * `setLinks` remains the sole writer of the curated array, so it keeps its
 * replacement and CRDT last-writer semantics. Decision edges derive from the
 * authoritative ordered slot instead of racing that whole-array write. Where a
 * curated spelling already names an active decision, keep its first position
 * but canonicalize and deduplicate it.
 */
function effectiveLinks(ydoc: Y.Doc, curated: string[]): string[] {
  const decisions = storedDecisions(ydoc);
  if (decisions.length === 0) return curated;

  const decisionSet = new Set(decisions);
  const seenDecisions = new Set<string>();
  const out: string[] = [];
  for (const link of curated) {
    const canonical = canonicalDocumentUuid(link);
    if (canonical === null || !decisionSet.has(canonical)) {
      out.push(link);
      continue;
    }
    if (seenDecisions.has(canonical)) continue;
    seenDecisions.add(canonical);
    out.push(canonical);
  }
  for (const decision of decisions) {
    if (!seenDecisions.has(decision)) out.push(decision);
  }
  return out;
}

/**
 * The decision log in stored order, resolved against `dirDoc` where one is
 * given — without it nothing resolves and every entry reads unavailable.
 *
 * A reference whose document does not exist, or whose stub is tombstoned, is
 * **kept** and flagged rather than pruned: the reference is the record, and a
 * reader shows it as unavailable rather than silently forgetting that the
 * decision governed this document.
 */
export function readDecisions(ydoc: Y.Doc, dirDoc?: Y.Doc): DecisionReference[] {
  return storedDecisions(ydoc).map((uuid) => {
    const entry = dirDoc === undefined ? null : getDirectoryEntry(dirDoc, uuid);
    if (entry === null) {
      return { uuid, title: null, status: null, available: false };
    }
    return {
      uuid,
      title: entry.title,
      status: entry.status ?? null,
      available: entry.deleted !== true,
    };
  });
}

/**
 * Append a decision document to the log. Its graph edge is derived from this
 * authoritative slot by `getMeta`, so a concurrent curated-link replacement
 * cannot drop it and `setLinks` remains the sole writer of its plain array.
 *
 * Validated through the same door a `docLink` target goes through, so the slot
 * can never hold a room name, a title or a malformed id, and an upper-cased
 * spelling is canonicalized down rather than becoming a second reference to one
 * document.
 *
 * @throws InvalidDecisionReferenceError when the value is not a document uuid,
 * or when the document is already referenced.
 */
export function addDecision(ydoc: Y.Doc, uuid: string): void {
  const canonical = canonicalDocumentUuid(uuid);
  if (canonical === null) {
    throw new InvalidDecisionReferenceError("not-a-document", uuid);
  }
  if (storedDecisions(ydoc).includes(canonical)) {
    throw new InvalidDecisionReferenceError("duplicate", canonical);
  }
  const decisions = getDecisionsArray(ydoc);
  const meta = getMetaMap(ydoc);
  const removedAt = decisionLevel(meta, DECISION_REMOVED_PREFIX, canonical);
  const addedAt = decisionLevel(meta, DECISION_ADDED_PREFIX, canonical);

  ydoc.transact(() => {
    // A deliberate add after a removal is the only operation that clears the
    // removal level. Reorder never writes this key, so it cannot resurrect a
    // reference removed concurrently on another replica.
    if (addedAt < removedAt) {
      deleteEveryReference(decisions, canonical);
      meta.set(
        `${DECISION_ADDED_PREFIX}${canonical}${DECISION_LEVEL_SEPARATOR}${ydoc.clientID}`,
        removedAt,
      );
    }
    decisions.push([canonical]);
  });
}

/**
 * Remove a document's reference from the log. The referenced document itself is
 * untouched — the log only ever held its uuid.
 *
 * Every occurrence goes, so a duplicate a concurrent reorder left in storage
 * clears with it. A per-client level in `meta` also hides an insert made by a
 * reorder that this replica has not seen yet; only a later explicit
 * `addDecision` advances the matching add level and restores the reference.
 * Removing a reference that is not there does nothing: another replica can
 * always have removed it first, so a throw here would fire on ordinary merges
 * rather than on caller mistakes.
 */
export function removeDecision(ydoc: Y.Doc, uuid: string): void {
  const canonical = canonicalDocumentUuid(uuid);
  if (canonical === null) return;
  if (!storedDecisions(ydoc).includes(canonical)) return;
  const decisions = getDecisionsArray(ydoc);
  const meta = getMetaMap(ydoc);
  const next =
    Math.max(
      decisionLevel(meta, DECISION_REMOVED_PREFIX, canonical),
      decisionLevel(meta, DECISION_ADDED_PREFIX, canonical),
    ) + 1;
  ydoc.transact(() => {
    deleteEveryReference(decisions, canonical);
    meta.set(
      `${DECISION_REMOVED_PREFIX}${canonical}${DECISION_LEVEL_SEPARATOR}${ydoc.clientID}`,
      next,
    );
  });
}

/** Delete every entry naming `canonical`, back to front so indexes stay valid. */
function deleteEveryReference(
  decisions: Y.Array<string>,
  canonical: string,
): void {
  const items = decisions.toArray();
  for (let i = items.length - 1; i >= 0; i -= 1) {
    if (canonicalDocumentUuid(items[i]) === canonical) decisions.delete(i, 1);
  }
}

/**
 * Move a reference to `index`, counting positions *after* it has been taken
 * out. An index past the end appends; a negative one moves to the front.
 *
 * Only ever moves a reference that is there — a uuid the log does not carry is
 * left alone rather than added, which keeps a reorder from resurrecting a
 * reference another replica has removed.
 */
export function reorderDecisions(
  ydoc: Y.Doc,
  uuid: string,
  index: number,
): void {
  const canonical = canonicalDocumentUuid(uuid);
  if (canonical === null) return;
  if (!storedDecisions(ydoc).includes(canonical)) return;
  const decisions = getDecisionsArray(ydoc);
  ydoc.transact(() => {
    deleteEveryReference(decisions, canonical);
    const target = Number.isFinite(index)
      ? Math.min(Math.max(Math.trunc(index), 0), decisions.length)
      : decisions.length;
    decisions.insert(target, [canonical]);
  });
}

/**
 * Replace the local tag set through independent per-tag presence writes.
 *
 * This is the provisional free-form boundary. Catalog-aware clients use
 * `assignDocumentTags`, which validates identities before calling this writer.
 */
export function setTags(ydoc: Y.Doc, tags: string[]): void {
  const meta = getMetaMap(ydoc);
  ydoc.transact(() => {
    replaceTags(meta, tags);
  });
}

/** Replace the outbound link set. Values are target document UUIDs. */
export function setLinks(ydoc: Y.Doc, links: string[]): void {
  const meta = getMetaMap(ydoc);
  ydoc.transact(() => {
    meta.set("links", [...links]);
  });
}

/**
 * A document has three fixed Y.Doc roots: metadata, blocks and annotations,
 * and an optional flat structured-data root (see `data.ts`).
 * Decision relationships live in the record's own metadata; topic answers and
 * requirement logs derive from the directory stubs, never another room.
 * Writers transact so callers may supply attribution through an outer origin.
 */

import type * as Y from "yjs";
import {
  InvalidDocumentLifecycleError,
  InvalidSupersedesReferenceError,
} from "./errors.js";
import { canonicalDocumentUuid } from "./rooms.js";
import {
  isDocumentKind,
  isDocumentStatusForKind,
  readDocumentLifecycle,
} from "./types.js";
import type {
  DocMeta,
  DocumentKind,
  DocumentStatus,
} from "./types.js";

export const META_KEY = "meta";
export const BLOCKS_KEY = "blocks";
export const ANNOTATIONS_KEY = "annotations";

/**
 * One flat presence key per tag keeps independent toggles independent. A
 * same-key set/delete conflict follows Yjs's set-wins semantics.
 */
const TAG_ASSIGNED_PREFIX = "tag-assigned:";

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

export interface InitDocOptions {
  uuid: string;
  title: string;
  tags?: string[];
  /** Product document this decision shapes. */
  governs?: string;
  /** Internal creation input, copied from the predecessor; never a MCP argument. */
  topic?: string;
  /** Earlier decision this decision replaces; immutable after creation. */
  supersedes?: string;
  /**
   * One or two sentences saying what the document is for. Optional here because
   * the web UI creates documents without one; MCP's `create_doc` requires it.
   */
  description?: string;
}

/**
 * Initialise a fresh document: write identity metadata and materialise the
 * three root types.
 *
 * Idempotent for title/tags (they are overwritten with what is passed);
 * `links` is only seeded when absent, so re-initialising never drops links.
 * `description` is written only when one is given, so re-initialising a
 * document without one does not erase the description it since acquired. A
 * supplied `supersedes` is canonicalized and written once. A successor must
 * carry the topic copied from its predecessor; re-initialisation may repeat
 * immutable fields, but cannot add a predecessor or change identity or topic.
 */
export function initDoc(ydoc: Y.Doc, options: InitDocOptions): void {
  const supersedes =
    options.supersedes === undefined
      ? undefined
      : canonicalDocumentUuid(options.supersedes);
  if (options.supersedes !== undefined && supersedes === null) {
    throw new InvalidSupersedesReferenceError(
      "not-a-document",
      options.supersedes,
    );
  }
  if (
    supersedes !== undefined &&
    canonicalDocumentUuid(options.uuid) === supersedes
  ) {
    throw new InvalidSupersedesReferenceError("self-reference", supersedes);
  }

  const meta = getMetaMap(ydoc);
  const initialized = meta.has("uuid");
  if (!initialized && supersedes !== undefined && options.topic === undefined) {
    throw new Error("A successor must copy the predecessor's topic at creation");
  }
  const governs = options.governs === undefined
    ? undefined : canonicalDocumentUuid(options.governs);
  const topic = options.topic === undefined
    ? (initialized
      ? undefined
      : options.governs !== undefined
        ? canonicalDocumentUuid(options.uuid)
        : undefined)
    : canonicalDocumentUuid(options.topic);
  if (governs === null || topic === null) {
    throw new Error("Decision links must be document UUIDs");
  }
  if (!initialized && topic !== undefined && supersedes === undefined && topic !== canonicalDocumentUuid(options.uuid)) {
    throw new Error("A first decision record is its own topic");
  }
  if ((meta.get("kind") === "decision" || meta.has("topic")) && meta.has("uuid") && meta.get("uuid") !== options.uuid) {
    throw new Error("A decision record's identity and topic are immutable");
  }
  // Absence is also fixed at creation: a later reinitialisation cannot add a
  // predecessor or change an adopted decision's implicit self topic.
  if (meta.has("uuid")) {
    if (supersedes !== undefined && canonicalDocumentUuid(meta.get("supersedes")) !== supersedes) {
      throw new InvalidSupersedesReferenceError("immutable", supersedes);
    }
    if (topic !== undefined && (canonicalDocumentUuid(meta.get("topic")) ?? canonicalDocumentUuid(meta.get("uuid"))) !== topic) {
      throw new Error("Decision topic is immutable after creation");
    }
  }
  ydoc.transact(() => {
    meta.set("uuid", options.uuid);
    meta.set("title", options.title);
    replaceTags(meta, options.tags ?? []);
    if (options.description !== undefined) {
      meta.set("description", options.description);
    }
    if (!meta.has("links")) meta.set("links", []);
    if (governs !== undefined) meta.set("governs", governs);
    if (topic !== undefined && !meta.has("topic")) meta.set("topic", topic);
    if (supersedes !== undefined && !meta.has("supersedes")) {
      meta.set("supersedes", supersedes);
    }
    // Touch the other roots so they exist in the update stream from the start.
    getBlocksFragment(ydoc);
    getAnnotationsMap(ydoc);
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
  const decision = lifecycle.kind === "decision";
  const supersedes = decision ? readSupersedes(meta, uuid) : undefined;
  const governs = decision ? canonicalDocumentUuid(meta.get("governs")) : null;
  const topic = decision ? (canonicalDocumentUuid(meta.get("topic")) ?? canonicalDocumentUuid(uuid)) : null;
  const agentStance = meta.get("agentStance");
  const decidedBy = readDecisionString(meta.get("decidedBy"));
  const decidedAt = readDecisionString(meta.get("decidedAt"));
  const decidedWhere = readDecisionString(meta.get("decidedWhere"));
  const approvalFingerprint = readDecisionString(meta.get("approvalFingerprint"));
  const rejectionReason = readDecisionString(meta.get("rejectionReason"));
  return {
    uuid: typeof uuid === "string" ? uuid : "",
    title: typeof title === "string" ? title : "",
    tags: storedTags(meta),
    description:
      typeof description === "string" && description !== "" ? description : null,
    tldr: typeof tldr === "string" && tldr !== "" ? tldr : null,
    ...readChangelogSuggestion(meta.get("changelogSuggestion")),
    ...lifecycle,
    ...(supersedes === undefined ? {} : { supersedes }),
    ...(governs === null ? {} : { governs }),
    ...(topic === null ? {} : { topic }),
    ...(decision && typeof agentStance === "boolean" ? { agentStance } : {}),
    ...(decision && decidedBy !== undefined ? { decidedBy } : {}),
    ...(decision && decidedAt !== undefined ? { decidedAt } : {}),
    ...(decision && decidedWhere !== undefined ? { decidedWhere } : {}),
    ...(decision && approvalFingerprint !== undefined ? { approvalFingerprint } : {}),
    ...(decision && rejectionReason !== undefined ? { rejectionReason } : {}),
    links: effectiveLinks(
      readStringArray(meta.get("links")),
      [governs, supersedes].filter((link): link is string => typeof link === "string"),
    ),
  };
}

/** A tolerant public read of the immutable new-decision → old-decision edge. */
function readSupersedes(
  meta: Y.Map<unknown>,
  documentUuid: unknown,
): string | undefined {
  const supersedes = canonicalDocumentUuid(meta.get("supersedes"));
  if (supersedes === null) return undefined;
  return supersedes === canonicalDocumentUuid(documentUuid)
    ? undefined
    : supersedes;
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

/** Nonblank decision attribution fields, read without inventing an author. */
function readDecisionString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() !== "" ? value : undefined;
}

/** Curated edges plus the record's own governing and predecessor references. */
function effectiveLinks(curated: string[], derived: string[]): string[] {
  if (derived.length === 0) return curated;
  const derivedSet = new Set(derived);
  const seen = new Set<string>();
  const out: string[] = [];
  for (const link of curated) {
    const canonical = canonicalDocumentUuid(link);
    if (canonical === null || !derivedSet.has(canonical)) out.push(link);
    else if (!seen.has(canonical)) { seen.add(canonical); out.push(canonical); }
  }
  for (const link of derived) {
    if (!seen.has(link)) { seen.add(link); out.push(link); }
  }
  return out;
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

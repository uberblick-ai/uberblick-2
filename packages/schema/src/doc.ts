/**
 * Fixed metadata, block and annotation roots share one document room; data is
 * optional. Decision relationships stay in metadata, with logs derived from
 * stubs. Writers transact so outer origins can carry attribution.
 */

import type * as Y from "yjs";
import { normalizeCodeCheck, readCodeCheck } from "./code-check.js";
import {
  InvalidDocumentLifecycleError,
  InvalidSupersedesReferenceError,
} from "./errors.js";
import { canonicalDocumentUuid } from "./rooms.js";
import { readSyncedDocId } from "./synced-doc-id.js";
import {
  isDocumentKind,
  isDocumentStatusForKind,
  readDocumentLifecycle,
} from "./types.js";
import type {
  CodeCheck,
  CodeCheckInput,
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
/** Repository keys merge independently even when two replicas first write a check. */
const CODE_CHECK_PREFIX = "code-check:";

export function getMetaMap(ydoc: Y.Doc): Y.Map<unknown> {
  return ydoc.getMap<unknown>(META_KEY);
}

/**
 * Tiptap/y-prosemirror binds directly to this fragment; preserve its native shape.
 */
export function getBlocksFragment(ydoc: Y.Doc): Y.XmlFragment {
  return ydoc.getXmlFragment(BLOCKS_KEY);
}

/**
 * Each thread owns a nested Y.Array so concurrent replies append independently
 * rather than replacing a whole JSON conversation.
 */
export function getAnnotationsMap(ydoc: Y.Doc): Y.Map<unknown> {
  return ydoc.getMap<unknown>(ANNOTATIONS_KEY);
}

export interface InitDocOptions {
  uuid: string;
  title: string;
  tags?: string[];
  /** Related page; its presence and target are fixed at creation. */
  governs?: string;
  /** Internal creation input, copied from the predecessor; never a MCP argument. */
  topic?: string;
  /** Earlier decision this decision replaces; immutable after creation. */
  supersedes?: string;
  /**
   * Optional for web creation; MCP create requires a nonblank description.
   */
  description?: string;
}

/**
 * Reinitialisation restates title/tags, preserves existing links and omitted
 * descriptions, and cannot add/change related page, predecessor, decision identity or topic.
 * A successor supplies its predecessor's topic; first records own their topic.
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
    if (governs !== undefined && canonicalDocumentUuid(meta.get("governs")) !== governs) {
      throw new Error("Decision related page is immutable after creation");
    }
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

function storedCodeChecks(meta: Y.Map<unknown>): CodeCheck[] {
  const checks: CodeCheck[] = [];
  for (const [key, value] of meta.entries()) {
    if (!key.startsWith(CODE_CHECK_PREFIX)) continue;
    const check = readCodeCheck(value);
    if (check !== null && key === `${CODE_CHECK_PREFIX}${check.repository}`) checks.push(check);
  }
  return checks.sort((a, b) => a.repository < b.repository ? -1 : a.repository > b.repository ? 1 : 0);
}

/** A check changes only its repository's metadata and never a content root. */
export function setCodeCheck(ydoc: Y.Doc, input: CodeCheckInput): void {
  const check = normalizeCodeCheck(input);
  if (check === null) throw new Error("Invalid code check");
  if (getMeta(ydoc).kind === "decision") throw new Error("Decision records do not carry code checks");
  ydoc.transact(() => {
    getMetaMap(ydoc).set(`${CODE_CHECK_PREFIX}${check.repository}`, {
      ...check,
      checked_at: new Date().toISOString(),
    });
  });
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

/** This lock leaves comments and discovery metadata writable. */
export function decisionContentLocked(meta: Pick<DocMeta, "kind" | "status">): boolean {
  return meta.kind === "decision" && meta.status === "decided";
}

/**
 * Tolerant defaults make incomplete replicas readable; blank and absent
 * descriptions/summaries both read as null.
 */
export function getMeta(ydoc: Y.Doc, authoritativeUuid?: string): DocMeta & { tldr: string | null } {
  const meta = getMetaMap(ydoc);
  const storedUuid = meta.get("uuid");
  const uuid = typeof storedUuid === "string" && storedUuid !== ""
    ? authoritativeUuid ?? storedUuid : "";
  const title = meta.get("title");
  const description = meta.get("description");
  const storedTldr = meta.get("tldr");
  const lifecycle = readDocumentLifecycle(meta.get("kind"), meta.get("status"));
  const decision = lifecycle.kind === "decision";
  const tldr = !decision && typeof storedTldr === "string" && storedTldr !== "" ? storedTldr : null;
  const supersedes = decision ? readSupersedes(meta, uuid) : undefined;
  const governs = decision ? canonicalDocumentUuid(meta.get("governs")) : null;
  const discussion = decision ? canonicalDocumentUuid(meta.get("discussion")) : null;
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
    tldr,
    ...(!decision ? { code_check: storedCodeChecks(meta) } : {}),
    // Summary text wins over a separately merged mark, including older writers.
    ...(!decision && tldr === null && meta.get("tldrOptOut") === true ? { tldrOptOut: true as const } : {}),
    ...lifecycle,
    ...(supersedes === undefined ? {} : { supersedes }),
    ...(governs === null ? {} : { governs }),
    ...(decision ? { discussion } : {}),
    ...(topic === null ? {} : { topic }),
    ...(decision && typeof agentStance === "boolean" ? { agentStance } : {}),
    ...(decision && decidedBy !== undefined ? { decidedBy } : {}),
    ...(decision && decidedAt !== undefined ? { decidedAt } : {}),
    ...(decision && decidedWhere !== undefined ? { decidedWhere } : {}),
    ...(decision && approvalFingerprint !== undefined ? { approvalFingerprint } : {}),
    ...(decision && rejectionReason !== undefined ? { rejectionReason } : {}),
    links: effectiveLinks(
      meta.get("links"),
      [governs, supersedes, discussion].filter((link): link is string => typeof link === "string"),
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

export function setTitle(ydoc: Y.Doc, title: string): void {
  const meta = getMetaMap(ydoc);
  ydoc.transact(() => {
    // Freeze the old hash input before renaming; never re-approve answer content.
    if (meta.get("kind") === "decision" && typeof meta.get("approvalTitle") !== "string") {
      meta.set("approvalTitle", getMeta(ydoc).title);
    }
    meta.set("title", title);
  });
}

/**
 * Whole-value writer; callers validate length and update the directory cache.
 * Empty string clears the description, read as null by getMeta and cache readers.
 */
export function setDescription(ydoc: Y.Doc, description: string): void {
  const meta = getMetaMap(ydoc);
  ydoc.transact(() => {
    meta.set("description", description);
  });
}

/**
 * Write boundaries enforce length. Clearing writes null so it competes with
 * whole-value writes rather than Y.Map key deletion.
 */
export function setTldr(ydoc: Y.Doc, tldr: string | null): void {
  const meta = getMetaMap(ydoc);
  ydoc.transact(() => {
    meta.set("tldr", tldr);
    if (tldr !== null) meta.set("tldrOptOut", false);
  });
}

/** Marking clears the summary atomically; opting back in leaves it untouched. */
export function setTldrOptOut(ydoc: Y.Doc, optOut: boolean): void {
  const meta = getMetaMap(ydoc);
  ydoc.transact(() => {
    if (optOut) meta.set("tldr", null);
    meta.set("tldrOptOut", optOut);
  });
}

/** The MCP boundary validates targets and permits changes only while open. */
export function setDiscussion(ydoc: Y.Doc, discussion: string | null): void {
  const meta = getMetaMap(ydoc);
  ydoc.transact(() => {
    meta.set("discussion", discussion);
  });
}

/**
 * Empty kind clears both keys; nonempty kind refuses an incompatible stored
 * status before transacting rather than silently clearing it.
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

/** Curated edges plus the record's related page, predecessor and discussion. */
function effectiveLinks(curated: unknown, derived: string[]): string[] {
  const valid = (Array.isArray(curated) ? curated : []).flatMap((value) => {
    const link = readSyncedDocId(value, "curated link");
    return link === null ? [] : [link];
  });
  if (derived.length === 0) return valid;
  const derivedSet = new Set(derived);
  const seen = new Set<string>();
  const out: string[] = [];
  for (const link of valid) {
    if (!derivedSet.has(link)) out.push(link);
    else if (!seen.has(link)) { seen.add(link); out.push(link); }
  }
  for (const link of derived) {
    if (!seen.has(link)) { seen.add(link); out.push(link); }
  }
  return out;
}

/**
 * Low-level presence writer; catalog-aware clients validate identities through
 * assignDocumentTags before calling it.
 */
export function setTags(ydoc: Y.Doc, tags: string[]): void {
  const meta = getMetaMap(ydoc);
  ydoc.transact(() => {
    replaceTags(meta, tags);
  });
}

/** Whole-value replacement; link targets are document UUIDs. */
export function setLinks(ydoc: Y.Doc, links: string[]): void {
  const meta = getMetaMap(ydoc);
  ydoc.transact(() => {
    meta.set("links", [...links]);
  });
}

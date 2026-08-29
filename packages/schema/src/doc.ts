/**
 * Document layout and metadata.
 *
 * A document is one Y.Doc (room name = document UUID) with exactly three
 * top-level shared types:
 *
 *   - `meta`        Y.Map     — uuid, title, description, tags, links,
 *                              kind and status
 *   - `blocks`      Y.XmlFragment — one Y.XmlElement per block
 *   - `annotations` Y.Map     — threadId → annotation JSON
 *
 * Every writer here runs inside `ydoc.transact`. Callers that want their own
 * transaction origin (agent attribution, undo scoping) can wrap any call in
 * their own `ydoc.transact(fn, origin)`: Yjs merges the nested transaction into
 * the outer one and keeps the outer origin.
 */

import type * as Y from "yjs";
import { InvalidDocumentLifecycleError } from "./errors.js";
import {
  isDocumentKind,
  isDocumentStatusForKind,
  readDocumentLifecycle,
} from "./types.js";
import type { DocMeta, DocumentKind, DocumentStatus } from "./types.js";

export const META_KEY = "meta";
export const BLOCKS_KEY = "blocks";
export const ANNOTATIONS_KEY = "annotations";

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

/** The `annotations` Y.Map. */
export function getAnnotationsMap(ydoc: Y.Doc): Y.Map<unknown> {
  return ydoc.getMap<unknown>(ANNOTATIONS_KEY);
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
 * three root types.
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
    meta.set("tags", [...(options.tags ?? [])]);
    if (options.description !== undefined) {
      meta.set("description", options.description);
    }
    if (!meta.has("links")) meta.set("links", []);
    // Touch the other roots so they exist in the update stream from the start.
    getBlocksFragment(ydoc);
    getAnnotationsMap(ydoc);
  });
}

function readStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((entry): entry is string => typeof entry === "string");
}

/**
 * Read metadata, with defaults for anything not yet written.
 *
 * `description` is null rather than empty when there is none: absent and blank
 * are the same fact — nobody has said what this document is for — and one shape
 * for it keeps every reader from having to test for both.
 */
export function getMeta(ydoc: Y.Doc): DocMeta {
  const meta = getMetaMap(ydoc);
  const uuid = meta.get("uuid");
  const title = meta.get("title");
  const description = meta.get("description");
  const lifecycle = readDocumentLifecycle(meta.get("kind"), meta.get("status"));
  return {
    uuid: typeof uuid === "string" ? uuid : "",
    title: typeof title === "string" ? title : "",
    tags: readStringArray(meta.get("tags")),
    description:
      typeof description === "string" && description !== "" ? description : null,
    ...lifecycle,
    links: readStringArray(meta.get("links")),
  };
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

/** Replace the tag set. Tags are a plain array; last write wins. */
export function setTags(ydoc: Y.Doc, tags: string[]): void {
  const meta = getMetaMap(ydoc);
  ydoc.transact(() => {
    meta.set("tags", [...tags]);
  });
}

/** Replace the outbound link set. Values are target document UUIDs. */
export function setLinks(ydoc: Y.Doc, links: string[]): void {
  const meta = getMetaMap(ydoc);
  ydoc.transact(() => {
    meta.set("links", [...links]);
  });
}

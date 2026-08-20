/**
 * Document layout and metadata.
 *
 * A document is one Y.Doc (room name = document UUID) with exactly three
 * top-level shared types:
 *
 *   - `meta`        Y.Map     — uuid, title, tags, links (all by UUID)
 *   - `blocks`      Y.XmlFragment — one Y.XmlElement per block
 *   - `annotations` Y.Map     — threadId → annotation JSON
 *
 * Every writer here runs inside `ydoc.transact`. Callers that want their own
 * transaction origin (agent attribution, undo scoping) can wrap any call in
 * their own `ydoc.transact(fn, origin)`: Yjs merges the nested transaction into
 * the outer one and keeps the outer origin.
 */

import * as Y from "yjs";
import type { DocMeta } from "./types.js";

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
}

/**
 * Initialise a fresh document: write identity metadata and materialise the
 * three root types.
 *
 * Idempotent for uuid/title/tags (they are overwritten with what is passed);
 * `links` is only seeded when absent, so re-initialising never drops links.
 */
export function initDoc(ydoc: Y.Doc, options: InitDocOptions): void {
  const meta = getMetaMap(ydoc);
  ydoc.transact(() => {
    meta.set("uuid", options.uuid);
    meta.set("title", options.title);
    meta.set("tags", [...(options.tags ?? [])]);
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

/** Read metadata, with defaults for anything not yet written. */
export function getMeta(ydoc: Y.Doc): DocMeta {
  const meta = getMetaMap(ydoc);
  const uuid = meta.get("uuid");
  const title = meta.get("title");
  return {
    uuid: typeof uuid === "string" ? uuid : "",
    title: typeof title === "string" ? title : "",
    tags: readStringArray(meta.get("tags")),
    links: readStringArray(meta.get("links")),
  };
}

export function setTitle(ydoc: Y.Doc, title: string): void {
  const meta = getMetaMap(ydoc);
  ydoc.transact(() => {
    meta.set("title", title);
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

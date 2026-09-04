/**
 * The workspace tag catalog.
 *
 * One settings Y.Doc owns one flat, synced vocabulary. `identities` maps each
 * UUID ever minted for a valid name to that immutable name. Concurrent offline
 * creates can therefore leave two UUIDs for one name without leaving two tags:
 * readers group by name, choose the lexicographically first UUID as the
 * canonical identity, and keep every other UUID as a resolvable alias. A
 * document assigned through either replica before the merge is still readable;
 * its next assignment write stores the canonical identity.
 *
 * Retirement and restoration are monotone per-client levels keyed by the
 * immutable name. Creation and seeding never write those levels, so a stale
 * replica materialising an example cannot reactivate a retirement it has not
 * seen. A deliberate restore advances the level instead.
 */

import type * as Y from "yjs";
import { getMetaMap } from "./doc.js";
import {
  InvalidTagAssignmentError,
  InvalidTagIdentityError,
  InvalidTagNameError,
} from "./errors.js";
import { canonicalDocumentUuid } from "./rooms.js";
import type { DirectoryEntry, TagCatalogEntry } from "./types.js";

/** UUID -> immutable display name. */
export const TAG_CATALOG_IDENTITIES_KEY = "tag-identities";

/** `<name>#<clientID>` -> retirement level. */
export const TAG_CATALOG_RETIRED_KEY = "tag-retired";

/** `<name>#<clientID>` -> restoration level. */
export const TAG_CATALOG_RESTORED_KEY = "tag-restored";

/** Set-once facts about the catalog itself. */
export const TAG_CATALOG_FLAGS_KEY = "tag-flags";

export const MAX_TAG_NAME_LENGTH = 30;

const SEEDED_FLAG = "examples-seeded";
const CLIENT_SEPARATOR = "#";
const TAG_NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/** Stable identities make two independent first-use seeds write one catalog. */
export const EXAMPLE_TAGS = [
  { id: "00000000-0000-4000-8000-000000000001", name: "auth" },
  { id: "00000000-0000-4000-8000-000000000002", name: "billing" },
  { id: "00000000-0000-4000-8000-000000000003", name: "mcp" },
  { id: "00000000-0000-4000-8000-000000000004", name: "permissions" },
  { id: "00000000-0000-4000-8000-000000000005", name: "sync" },
] as const;

export function isTagName(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length <= MAX_TAG_NAME_LENGTH &&
    TAG_NAME.test(value)
  );
}

export function getTagCatalogIdentities(
  catalogDoc: Y.Doc,
): Y.Map<string> {
  return catalogDoc.getMap<string>(TAG_CATALOG_IDENTITIES_KEY);
}

function getRetiredLevels(catalogDoc: Y.Doc): Y.Map<number> {
  return catalogDoc.getMap<number>(TAG_CATALOG_RETIRED_KEY);
}

function getRestoredLevels(catalogDoc: Y.Doc): Y.Map<number> {
  return catalogDoc.getMap<number>(TAG_CATALOG_RESTORED_KEY);
}

export function getTagCatalogFlags(catalogDoc: Y.Doc): Y.Map<boolean> {
  return catalogDoc.getMap<boolean>(TAG_CATALOG_FLAGS_KEY);
}

function levelFor(map: Y.Map<number>, name: string): number {
  const prefix = `${name}${CLIENT_SEPARATOR}`;
  let level = 0;
  for (const [key, value] of map.entries()) {
    if (
      key.startsWith(prefix) &&
      Number.isSafeInteger(value) &&
      value > level
    ) {
      level = value;
    }
  }
  return level;
}

function stateFor(catalogDoc: Y.Doc, name: string): "active" | "retired" {
  return levelFor(getRestoredLevels(catalogDoc), name) >=
    levelFor(getRetiredLevels(catalogDoc), name)
    ? "active"
    : "retired";
}

interface CatalogIndex {
  entries: TagCatalogEntry[];
  byIdentity: Map<string, TagCatalogEntry>;
}

/** Materialise the deterministic view over possibly duplicated identities. */
function catalogIndex(catalogDoc: Y.Doc): CatalogIndex {
  const identitiesByName = new Map<string, string[]>();
  for (const [id, name] of getTagCatalogIdentities(catalogDoc).entries()) {
    if (canonicalDocumentUuid(id) !== id || !isTagName(name)) continue;
    const identities = identitiesByName.get(name);
    if (identities === undefined) identitiesByName.set(name, [id]);
    else identities.push(id);
  }

  const entries: TagCatalogEntry[] = [];
  const byIdentity = new Map<string, TagCatalogEntry>();
  for (const [name, identities] of identitiesByName) {
    identities.sort();
    const id = identities[0];
    if (id === undefined) continue;
    const entry: TagCatalogEntry = {
      id,
      name,
      state: stateFor(catalogDoc, name),
    };
    entries.push(entry);
    for (const identity of identities) byIdentity.set(identity, entry);
  }
  entries.sort((left, right) =>
    left.name < right.name ? -1 : left.name > right.name ? 1 : 0,
  );
  return { entries, byIdentity };
}

/** Every catalog entry, active and retired, in replica-stable name order. */
export function listTagCatalog(catalogDoc: Y.Doc): TagCatalogEntry[] {
  return catalogIndex(catalogDoc).entries;
}

/** Resolve a canonical identity or one of its converged aliases. */
export function getTagCatalogEntry(
  catalogDoc: Y.Doc,
  identity: unknown,
): TagCatalogEntry | null {
  const canonical = canonicalDocumentUuid(identity);
  if (canonical === null) return null;
  return catalogIndex(catalogDoc).byIdentity.get(canonical) ?? null;
}

/**
 * Create one active entry, or return the existing entry with this name.
 *
 * `identity` is injectable for a seed and deterministic tests. Ordinary callers
 * omit it and get a random UUID. Names never change; rename is deliberately not
 * part of the first catalog.
 */
export function createTagCatalogEntry(
  catalogDoc: Y.Doc,
  name: string,
  identity?: string,
): TagCatalogEntry {
  if (!isTagName(name)) throw new InvalidTagNameError(name);
  const existing = listTagCatalog(catalogDoc).find((entry) => entry.name === name);
  if (existing !== undefined) return existing;

  const id = identity ?? crypto.randomUUID();
  if (canonicalDocumentUuid(id) !== id) {
    throw new InvalidTagIdentityError("not-a-uuid", id);
  }
  const identities = getTagCatalogIdentities(catalogDoc);
  if (identities.has(id)) throw new InvalidTagIdentityError("in-use", id);
  identities.set(id, name);
  return { id, name, state: "active" };
}

function requireEntry(catalogDoc: Y.Doc, identity: string): TagCatalogEntry {
  const entry = getTagCatalogEntry(catalogDoc, identity);
  if (entry === null) throw new InvalidTagIdentityError("unknown", identity);
  return entry;
}

function nextLifecycleLevel(catalogDoc: Y.Doc, name: string): number {
  return (
    Math.max(
      levelFor(getRetiredLevels(catalogDoc), name),
      levelFor(getRestoredLevels(catalogDoc), name),
    ) + 1
  );
}

export function retireTagCatalogEntry(
  catalogDoc: Y.Doc,
  identity: string,
): void {
  const entry = requireEntry(catalogDoc, identity);
  if (entry.state === "retired") return;
  getRetiredLevels(catalogDoc).set(
    `${entry.name}${CLIENT_SEPARATOR}${catalogDoc.clientID}`,
    nextLifecycleLevel(catalogDoc, entry.name),
  );
}

export function restoreTagCatalogEntry(
  catalogDoc: Y.Doc,
  identity: string,
): void {
  const entry = requireEntry(catalogDoc, identity);
  if (entry.state === "active") return;
  getRestoredLevels(catalogDoc).set(
    `${entry.name}${CLIENT_SEPARATOR}${catalogDoc.clientID}`,
    nextLifecycleLevel(catalogDoc, entry.name),
  );
}

export function isTagCatalogSeeded(catalogDoc: Y.Doc): boolean {
  return getTagCatalogFlags(catalogDoc).get(SEEDED_FLAG) === true;
}

/** Materialise the ordinary example entries once, without writing lifecycle. */
export function seedTagCatalog(catalogDoc: Y.Doc): void {
  if (isTagCatalogSeeded(catalogDoc)) return;
  catalogDoc.transact(() => {
    for (const example of EXAMPLE_TAGS) {
      createTagCatalogEntry(catalogDoc, example.name, example.id);
    }
    getTagCatalogFlags(catalogDoc).set(SEEDED_FLAG, true);
  });
}

/**
 * Resolve stored identities in their document order. Unknown identities and
 * provisional name strings are omitted; aliases converge on one canonical ID.
 */
export function resolveTagAssignments(
  catalogDoc: Y.Doc,
  identities: readonly unknown[],
): TagCatalogEntry[] {
  const index = catalogIndex(catalogDoc);
  const seen = new Set<string>();
  const resolved: TagCatalogEntry[] = [];
  for (const identity of identities) {
    const canonical = canonicalDocumentUuid(identity);
    if (canonical === null) continue;
    const entry = index.byIdentity.get(canonical);
    if (entry === undefined || seen.has(entry.id)) continue;
    seen.add(entry.id);
    resolved.push(entry);
  }
  return resolved;
}

function storedTags(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

export function readDocumentTags(
  document: Y.Doc,
  catalogDoc: Y.Doc,
): TagCatalogEntry[] {
  return resolveTagAssignments(
    catalogDoc,
    storedTags(getMetaMap(document).get("tags")),
  );
}

export function readDirectoryTags(
  entry: Pick<DirectoryEntry, "tags">,
  catalogDoc: Y.Doc,
): TagCatalogEntry[] {
  return resolveTagAssignments(catalogDoc, entry.tags);
}

/**
 * Atomically replace a document's tag identities after validating the complete
 * request. An already-assigned retired tag may remain; a retired tag may not be
 * added. The first successful call naturally replaces every provisional value.
 */
export function assignDocumentTags(
  document: Y.Doc,
  catalogDoc: Y.Doc,
  identities: readonly string[],
): void {
  const index = catalogIndex(catalogDoc);
  const existing = new Set(
    resolveTagAssignments(
      catalogDoc,
      storedTags(getMetaMap(document).get("tags")),
    ).map((entry) => entry.id),
  );
  const unknown: string[] = [];
  const retired: string[] = [];
  const next: string[] = [];
  const seen = new Set<string>();

  for (const requested of identities) {
    const canonical = canonicalDocumentUuid(requested);
    const entry =
      canonical === null ? undefined : index.byIdentity.get(canonical);
    if (entry === undefined) {
      unknown.push(requested);
      continue;
    }
    if (entry.state === "retired" && !existing.has(entry.id)) {
      retired.push(requested);
      continue;
    }
    if (!seen.has(entry.id)) {
      seen.add(entry.id);
      next.push(entry.id);
    }
  }

  if (unknown.length > 0 || retired.length > 0) {
    throw new InvalidTagAssignmentError(unknown, retired);
  }
  document.transact(() => {
    getMetaMap(document).set("tags", next);
  });
}

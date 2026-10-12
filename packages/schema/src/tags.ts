import type * as Y from "yjs";
import { getMeta, setTags } from "./doc.js";
import {
  InvalidTagAssignmentError,
  InvalidTagDescriptionError,
  InvalidTagIdentityError,
  InvalidTagNameError,
} from "./errors.js";
import { canonicalDocumentUuid } from "./rooms.js";
import type {
  DirectoryEntry,
  TagAssignment,
  TagCatalogEntry,
} from "./types.js";
import { MAX_DESCRIPTION_LENGTH } from "./types.js";

/** One settings Y.Doc holds a flat vocabulary of UUIDs mapped to immutable names. */
export const TAG_CATALOG_IDENTITIES_KEY = "tag-identities";

/** `<name>#<clientID>` -> retirement level. */
export const TAG_CATALOG_RETIRED_KEY = "tag-retired";

/** `<name>#<clientID>` -> restoration level. */
export const TAG_CATALOG_RESTORED_KEY = "tag-restored";

/** Identity tombstones are set-once and survive stale catalog writes. */
export const TAG_CATALOG_DELETED_KEY = "tag-deleted";

/** Descriptions replace independently of immutable identity and name. */
export const TAG_CATALOG_DESCRIPTIONS_KEY = "tag-descriptions";

/** Explicit new identities do not inherit a legacy name's lifecycle levels. */
export const TAG_CATALOG_CREATED_KEY = "tag-created-v2";

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
  { id: "00000000-0000-4000-8000-000000000006", name: "rfc" },
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

// Per-client levels are monotone; restoration wins a tie with retirement.
function legacyNameIsRetired(catalogDoc: Y.Doc, name: string): boolean {
  return levelFor(getRestoredLevels(catalogDoc), name) <
    levelFor(getRetiredLevels(catalogDoc), name);
}

function getDeletedIdentities(catalogDoc: Y.Doc): Y.Map<boolean> {
  return catalogDoc.getMap<boolean>(TAG_CATALOG_DELETED_KEY);
}

function getCreatedIdentities(catalogDoc: Y.Doc): Y.Map<boolean> {
  return catalogDoc.getMap<boolean>(TAG_CATALOG_CREATED_KEY);
}

function getDescriptions(catalogDoc: Y.Doc): Y.Map<string> {
  return catalogDoc.getMap<string>(TAG_CATALOG_DESCRIPTIONS_KEY);
}

export function isTagCatalogIdentityDeleted(
  catalogDoc: Y.Doc,
  identity: unknown,
): boolean {
  const canonical = canonicalDocumentUuid(identity);
  return canonical !== null && getDeletedIdentities(catalogDoc).get(canonical) === true;
}

export function listDeletedTagIdentities(catalogDoc: Y.Doc): string[] {
  return [...getDeletedIdentities(catalogDoc).entries()]
    .filter(([id, deleted]) => deleted === true && canonicalDocumentUuid(id) === id)
    .map(([id]) => id)
    .sort();
}

function legacyIdentityIsRetired(catalogDoc: Y.Doc, id: string, name: string): boolean {
  return getCreatedIdentities(catalogDoc).get(id) !== true && legacyNameIsRetired(catalogDoc, name);
}

/** Materialize legacy retirement as identity deletion, including delayed aliases. */
export function migrateTagCatalog(catalogDoc: Y.Doc): void {
  const deleted = getDeletedIdentities(catalogDoc);
  catalogDoc.transact(() => {
    for (const [id, name] of getTagCatalogIdentities(catalogDoc).entries()) {
      if (canonicalDocumentUuid(id) === id && isTagName(name) &&
        deleted.get(id) !== true && legacyIdentityIsRetired(catalogDoc, id, name)) {
        deleted.set(id, true);
      }
    }
  });
}

interface CatalogIndex {
  entries: TagCatalogEntry[];
  byIdentity: Map<string, TagCatalogEntry>;
}

/** Group by name: the least UUID is canonical and every other UUID remains an alias. */
function catalogIndex(catalogDoc: Y.Doc): CatalogIndex {
  const identitiesByName = new Map<string, string[]>();
  for (const [id, name] of getTagCatalogIdentities(catalogDoc).entries()) {
    if (canonicalDocumentUuid(id) !== id || !isTagName(name)) continue;
    if (isTagCatalogIdentityDeleted(catalogDoc, id) || legacyIdentityIsRetired(catalogDoc, id, name)) continue;
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
    };
    const description = getDescriptions(catalogDoc).get(id);
    if (typeof description === "string" && description !== "") entry.description = description;
    entries.push(entry);
    for (const identity of identities) byIdentity.set(identity, entry);
  }
  entries.sort((left, right) =>
    left.name < right.name ? -1 : left.name > right.name ? 1 : 0,
  );
  return { entries, byIdentity };
}

/** Existing catalog entries in replica-stable name order. */
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

function normalizeDescription(description: string | null | undefined): string | undefined {
  if (description === null || description === undefined) return undefined;
  if (typeof description !== "string") throw new InvalidTagDescriptionError();
  const trimmed = description.trim();
  if (trimmed.length > MAX_DESCRIPTION_LENGTH || /[\r\n\u2028\u2029]/.test(trimmed)) {
    throw new InvalidTagDescriptionError();
  }
  return trimmed === "" ? undefined : trimmed;
}

/** Existing names keep their entry; deleted names require a new identity. */
export function createTagCatalogEntry(
  catalogDoc: Y.Doc,
  name: string,
  identity?: string,
  description?: string | null,
): TagCatalogEntry {
  if (!isTagName(name)) throw new InvalidTagNameError(name);
  const normalizedDescription = normalizeDescription(description);
  const existing = listTagCatalog(catalogDoc).find((entry) => entry.name === name);
  if (existing !== undefined) return existing;

  const id = identity ?? crypto.randomUUID();
  if (canonicalDocumentUuid(id) !== id) {
    throw new InvalidTagIdentityError("not-a-uuid", id);
  }
  const identities = getTagCatalogIdentities(catalogDoc);
  if (identities.has(id) || isTagCatalogIdentityDeleted(catalogDoc, id)) {
    throw new InvalidTagIdentityError("in-use", id);
  }
  catalogDoc.transact(() => {
    identities.set(id, name);
    getCreatedIdentities(catalogDoc).set(id, true);
    if (normalizedDescription !== undefined) getDescriptions(catalogDoc).set(id, normalizedDescription);
  });
  return { id, name, ...(normalizedDescription === undefined ? {} : { description: normalizedDescription }) };
}

function requireEntry(catalogDoc: Y.Doc, identity: string): TagCatalogEntry {
  const entry = getTagCatalogEntry(catalogDoc, identity);
  if (entry === null) throw new InvalidTagIdentityError("unknown", identity);
  return entry;
}

export function setTagCatalogDescription(
  catalogDoc: Y.Doc,
  identity: string,
  description?: string | null,
): void {
  const normalized = normalizeDescription(description);
  const entry = requireEntry(catalogDoc, identity);
  // An empty register value clears the description under Yjs's convergent map semantics.
  getDescriptions(catalogDoc).set(entry.id, normalized ?? "");
}

export function deleteTagCatalogEntry(
  catalogDoc: Y.Doc,
  identity: string,
): void {
  if (isTagCatalogIdentityDeleted(catalogDoc, identity)) return;
  const entry = requireEntry(catalogDoc, identity);
  const deleted = getDeletedIdentities(catalogDoc);
  catalogDoc.transact(() => {
    for (const [id, name] of getTagCatalogIdentities(catalogDoc).entries()) {
      if (name === entry.name && canonicalDocumentUuid(id) === id) deleted.set(id, true);
    }
  });
}

export function isTagCatalogSeeded(catalogDoc: Y.Doc): boolean {
  return getTagCatalogFlags(catalogDoc).get(SEEDED_FLAG) === true;
}

/** Materialise the ordinary example entries once, without writing lifecycle. */
export function seedTagCatalog(catalogDoc: Y.Doc): void {
  if (isTagCatalogSeeded(catalogDoc)) return;
  catalogDoc.transact(() => {
    for (const example of EXAMPLE_TAGS) {
      if (isTagCatalogIdentityDeleted(catalogDoc, example.id) ||
        listTagCatalog(catalogDoc).some((entry) => entry.name === example.name)) continue;
      // Fixed examples remain legacy identities so delayed retirement can migrate them.
      if (!getTagCatalogIdentities(catalogDoc).has(example.id)) {
        getTagCatalogIdentities(catalogDoc).set(example.id, example.name);
      }
    }
    getTagCatalogFlags(catalogDoc).set(SEEDED_FLAG, true);
  });
}

/** Show only existing tags, canonicalizing aliases without changing stored references. */
export function resolveTagAssignments(
  catalogDoc: Y.Doc,
  identities: readonly unknown[],
): TagAssignment[] {
  const index = catalogIndex(catalogDoc);
  const seen = new Set<string>();
  const resolved: TagAssignment[] = [];
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

export function readDocumentTags(
  document: Y.Doc,
  catalogDoc: Y.Doc,
): TagAssignment[] {
  return resolveTagAssignments(catalogDoc, getMeta(document).tags);
}

export function readDirectoryTags(
  entry: Pick<DirectoryEntry, "tags">,
  catalogDoc: Y.Doc,
): TagAssignment[] {
  return resolveTagAssignments(catalogDoc, entry.tags);
}

/**
 * Validate the whole request before replacing assignments with canonical UUIDs.
 * Replace existing-tag assignments while retaining unresolved stored references.
 * Only positive identity tombstones permit removing hidden references.
 */
export function assignDocumentTags(
  document: Y.Doc,
  catalogDoc: Y.Doc,
  identities: readonly string[],
): void {
  const index = catalogIndex(catalogDoc);
  const unknown: string[] = [];
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
    if (!seen.has(entry.id)) {
      seen.add(entry.id);
      next.push(entry.id);
    }
  }

  if (unknown.length > 0) {
    throw new InvalidTagAssignmentError(unknown);
  }
  for (const stored of getMeta(document).tags) {
    const identity = canonicalDocumentUuid(stored);
    if ((identity === null || !index.byIdentity.has(identity)) && !isTagCatalogIdentityDeleted(catalogDoc, stored) && !seen.has(stored)) {
      seen.add(stored);
      next.push(stored);
    }
  }
  setTags(document, next);
}

/** Call only inside a permitted authored write; reads and synchronization never clean. */
export function cleanupDocumentTags(document: Y.Doc, catalogDoc: Y.Doc): void {
  const stored = getMeta(document).tags;
  const retained = stored.filter((id) => !isTagCatalogIdentityDeleted(catalogDoc, id));
  if (retained.length !== stored.length) setTags(document, retained);
}

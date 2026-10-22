import type * as Y from "yjs";
import { getMeta, setTags } from "./doc.js";
import {
  InvalidTagAssignmentError,
  InvalidTagDescriptionError,
  InvalidTagIdentityError,
  InvalidTagNameError,
} from "./errors.js";
import { canonicalDocumentUuid } from "./rooms.js";
import { MAX_DESCRIPTION_LENGTH, type DirectoryEntry, type TagCatalogEntry } from "./types.js";

/** Immutable UUID-to-name identities; converged duplicate names share one display entry. */
export const TAG_CATALOG_IDENTITIES_KEY = "tag-identities";
/** Legacy per-client lifecycle levels, read only until an authorized migration. */
export const TAG_CATALOG_RETIRED_KEY = "tag-retired";
export const TAG_CATALOG_RESTORED_KEY = "tag-restored";
export const TAG_CATALOG_FLAGS_KEY = "tag-flags";
export const TAG_CATALOG_DESCRIPTIONS_KEY = "tag-descriptions";
/** Separate deletion facts cannot be undone by writes to identity or description registers. */
export const TAG_CATALOG_DELETED_KEY = "tag-deleted";
export const MAX_TAG_NAME_LENGTH = 30;

const SEEDED_FLAG = "examples-seeded";
const MIGRATED_FLAG = "legacy-lifecycle-migrated";
const CREATED_PREFIX = "created:";
const TAG_NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

export const EXAMPLE_TAGS = [
  { id: "00000000-0000-4000-8000-000000000001", name: "auth" },
  { id: "00000000-0000-4000-8000-000000000002", name: "billing" },
  { id: "00000000-0000-4000-8000-000000000003", name: "mcp" },
  { id: "00000000-0000-4000-8000-000000000004", name: "permissions" },
  { id: "00000000-0000-4000-8000-000000000006", name: "rfc" },
  { id: "00000000-0000-4000-8000-000000000005", name: "sync" },
] as const;

export function isTagName(value: unknown): value is string {
  return typeof value === "string" && value.length <= MAX_TAG_NAME_LENGTH && TAG_NAME.test(value);
}

export function getTagCatalogIdentities(catalogDoc: Y.Doc): Y.Map<string> {
  return catalogDoc.getMap<string>(TAG_CATALOG_IDENTITIES_KEY);
}

export function getTagCatalogFlags(catalogDoc: Y.Doc): Y.Map<boolean> {
  return catalogDoc.getMap<boolean>(TAG_CATALOG_FLAGS_KEY);
}

function descriptions(catalogDoc: Y.Doc): Y.Map<string> {
  return catalogDoc.getMap<string>(TAG_CATALOG_DESCRIPTIONS_KEY);
}

function deletions(catalogDoc: Y.Doc): Y.Map<string> {
  return catalogDoc.getMap<string>(TAG_CATALOG_DELETED_KEY);
}

export function isTagDeleted(catalogDoc: Y.Doc, identity: string): boolean {
  const canonical = canonicalDocumentUuid(identity);
  return canonical !== null && isTagName(deletions(catalogDoc).get(canonical));
}

/** Includes facts for identities that no longer occur in the visible catalog. */
export function listDeletedTagCatalogEntries(catalogDoc: Y.Doc): { id: string; name: string }[] {
  return [...deletions(catalogDoc).entries()]
    .filter(([id, name]) => canonicalDocumentUuid(id) === id && isTagName(name))
    .map(([id, name]) => ({ id, name }))
    .sort((left, right) => left.id < right.id ? -1 : left.id > right.id ? 1 : 0);
}

function levelFor(map: Y.Map<number>, name: string): number {
  let level = 0;
  for (const [key, value] of map.entries()) {
    if (key.startsWith(`${name}#`) && Number.isSafeInteger(value) && value > level) level = value;
  }
  return level;
}

function legacyRetired(catalogDoc: Y.Doc, name: string): boolean {
  if (getTagCatalogFlags(catalogDoc).get(MIGRATED_FLAG) === true) return false;
  return levelFor(catalogDoc.getMap<number>(TAG_CATALOG_RETIRED_KEY), name) >
    levelFor(catalogDoc.getMap<number>(TAG_CATALOG_RESTORED_KEY), name);
}

function isNewIdentity(catalogDoc: Y.Doc, identity: string): boolean {
  return getTagCatalogFlags(catalogDoc).get(`${CREATED_PREFIX}${identity}`) === true;
}

interface CatalogIndex {
  entries: TagCatalogEntry[];
  byIdentity: Map<string, TagCatalogEntry>;
}

function normalizeDescription(description: string | null): string {
  if (description === null) return "";
  const normalized = description.trim();
  if (/[\r\n\u2028\u2029]/.test(description) || normalized.length > MAX_DESCRIPTION_LENGTH) {
    throw new InvalidTagDescriptionError();
  }
  return normalized;
}

/** Deleted identities leave name grouping before a canonical UUID is selected. */
function catalogIndex(catalogDoc: Y.Doc): CatalogIndex {
  const identitiesByName = new Map<string, string[]>();
  for (const [id, name] of getTagCatalogIdentities(catalogDoc).entries()) {
    if (canonicalDocumentUuid(id) !== id || !isTagName(name) || isTagDeleted(catalogDoc, id) ||
      (!isNewIdentity(catalogDoc, id) && legacyRetired(catalogDoc, name))) continue;
    const identities = identitiesByName.get(name);
    if (identities === undefined) identitiesByName.set(name, [id]);
    else identities.push(id);
  }
  const entries: TagCatalogEntry[] = [];
  const byIdentity = new Map<string, TagCatalogEntry>();
  const storedDescriptions = descriptions(catalogDoc);
  for (const [name, identities] of identitiesByName) {
    identities.sort();
    const id = identities[0];
    if (id === undefined) continue;
    // An explicit empty register clears a description, including alias fallback.
    const stored = identities.map((identity) => storedDescriptions.get(identity)).find((value) => typeof value === "string");
    const description = typeof stored === "string" && stored.length <= MAX_DESCRIPTION_LENGTH && !/[\r\n\u2028\u2029]/.test(stored) ? stored.trim() : "";
    const entry: TagCatalogEntry = { id, name, ...(description === "" ? {} : { description }) };
    entries.push(entry);
    for (const identity of identities) byIdentity.set(identity, entry);
  }
  entries.sort((left, right) => left.name < right.name ? -1 : left.name > right.name ? 1 : 0);
  return { entries, byIdentity };
}

export function listTagCatalog(catalogDoc: Y.Doc): TagCatalogEntry[] {
  return catalogIndex(catalogDoc).entries;
}

export function getTagCatalogEntry(catalogDoc: Y.Doc, identity: unknown): TagCatalogEntry | null {
  const canonical = canonicalDocumentUuid(identity);
  return canonical === null ? null : catalogIndex(catalogDoc).byIdentity.get(canonical) ?? null;
}

export function createTagCatalogEntry(catalogDoc: Y.Doc, name: string, identity?: string, description?: string | null): TagCatalogEntry {
  if (!isTagName(name)) throw new InvalidTagNameError(name);
  const normalized = description === undefined ? "" : normalizeDescription(description);
  const existing = listTagCatalog(catalogDoc).find((entry) => entry.name === name);
  if (existing !== undefined) return existing;
  const id = identity ?? crypto.randomUUID();
  if (canonicalDocumentUuid(id) !== id) throw new InvalidTagIdentityError("not-a-uuid", id);
  if (getTagCatalogIdentities(catalogDoc).has(id) || isTagDeleted(catalogDoc, id) ||
    EXAMPLE_TAGS.some((example) => example.id === id && legacyRetired(catalogDoc, example.name))) throw new InvalidTagIdentityError("in-use", id);
  catalogDoc.transact(() => {
    getTagCatalogIdentities(catalogDoc).set(id, name);
    getTagCatalogFlags(catalogDoc).set(`${CREATED_PREFIX}${id}`, true);
    if (normalized !== "") descriptions(catalogDoc).set(id, normalized);
  });
  return { id, name, ...(normalized === "" ? {} : { description: normalized }) };
}

function requireEntry(catalogDoc: Y.Doc, identity: string): TagCatalogEntry {
  const entry = getTagCatalogEntry(catalogDoc, identity);
  if (entry === null) throw new InvalidTagIdentityError("unknown", identity);
  return entry;
}

export function setTagCatalogDescription(catalogDoc: Y.Doc, identity: string, description: string | null): void {
  const normalized = normalizeDescription(description);
  const entry = requireEntry(catalogDoc, identity);
  if ((entry.description ?? "") === normalized) return;
  descriptions(catalogDoc).set(entry.id, normalized);
}

function deleteName(catalogDoc: Y.Doc, name: string, legacyOnly = false): void {
  const deleted = deletions(catalogDoc);
  for (const [id, candidate] of getTagCatalogIdentities(catalogDoc).entries()) {
    if (candidate === name && canonicalDocumentUuid(id) === id &&
      (!legacyOnly || !isNewIdentity(catalogDoc, id)) && !deleted.has(id)) deleted.set(id, name);
  }
  // A stale first-use seed must not reintroduce a curated example's name.
  for (const example of EXAMPLE_TAGS) {
    if (example.name === name && (!legacyOnly || !isNewIdentity(catalogDoc, example.id)) && !deleted.has(example.id)) deleted.set(example.id, name);
  }
}

export function deleteTagCatalogEntry(catalogDoc: Y.Doc, identity: string): void {
  const entry = requireEntry(catalogDoc, identity);
  catalogDoc.transact(() => {
    deleteName(catalogDoc, entry.name);
  });
}

/** Call only with workspace-settings authority after the authoritative catalog arrives. */
export function migrateRetiredTagCatalogEntries(catalogDoc: Y.Doc): boolean {
  if (getTagCatalogFlags(catalogDoc).get(MIGRATED_FLAG) === true) return false;
  const names = [...getTagCatalogIdentities(catalogDoc).entries()]
    .filter(([id, name]) => canonicalDocumentUuid(id) === id && isTagName(name) && !isNewIdentity(catalogDoc, id))
    .map(([, name]) => name);
  const retiredLevels = catalogDoc.getMap<number>(TAG_CATALOG_RETIRED_KEY);
  const restoredLevels = catalogDoc.getMap<number>(TAG_CATALOG_RESTORED_KEY);
  // Wait for legacy identity and lifecycle evidence rather than manufacturing
  // a settings write on new or empty catalogs.
  if (!names.some((name) => levelFor(retiredLevels, name) > 0 || levelFor(restoredLevels, name) > 0)) return false;
  const retired = new Set(names.filter((name) => legacyRetired(catalogDoc, name)));
  catalogDoc.transact(() => {
    for (const name of retired) deleteName(catalogDoc, name, true);
    getTagCatalogFlags(catalogDoc).set(MIGRATED_FLAG, true);
  });
  return true;
}

export function isTagCatalogSeeded(catalogDoc: Y.Doc): boolean {
  return getTagCatalogFlags(catalogDoc).get(SEEDED_FLAG) === true;
}

export function seedTagCatalog(catalogDoc: Y.Doc): void {
  if (isTagCatalogSeeded(catalogDoc)) return;
  catalogDoc.transact(() => {
    const deletedNames = new Set(listDeletedTagCatalogEntries(catalogDoc).map((entry) => entry.name));
    for (const example of EXAMPLE_TAGS) {
      if (deletedNames.has(example.name) || legacyRetired(catalogDoc, example.name) ||
        listTagCatalog(catalogDoc).some((entry) => entry.name === example.name)) continue;
      const identities = getTagCatalogIdentities(catalogDoc);
      if (identities.has(example.id)) throw new InvalidTagIdentityError("in-use", example.id);
      // Seeding reuses an existing fixed identity, rather than explicitly
      // creating a fresh identity that supersedes legacy name lifecycle.
      identities.set(example.id, example.name);
    }
    getTagCatalogFlags(catalogDoc).set(SEEDED_FLAG, true);
  });
}

export function resolveTagAssignments(catalogDoc: Y.Doc, identities: readonly unknown[]): TagCatalogEntry[] {
  const index = catalogIndex(catalogDoc);
  const seen = new Set<string>();
  const resolved: TagCatalogEntry[] = [];
  for (const identity of identities) {
    const canonical = canonicalDocumentUuid(identity);
    const entry = canonical === null ? undefined : index.byIdentity.get(canonical);
    if (entry === undefined || seen.has(entry.id)) continue;
    seen.add(entry.id);
    resolved.push(entry);
  }
  return resolved;
}

export function readDocumentTags(document: Y.Doc, catalogDoc: Y.Doc): TagCatalogEntry[] {
  return resolveTagAssignments(catalogDoc, getMeta(document).tags);
}

export function readDirectoryTags(entry: Pick<DirectoryEntry, "tags">, catalogDoc: Y.Doc): TagCatalogEntry[] {
  return resolveTagAssignments(catalogDoc, entry.tags);
}

/** Call only inside a permitted authored document write; catalog absence is never deletion evidence. */
export function cleanupDeletedDocumentTags(document: Y.Doc, catalogDoc: Y.Doc): void {
  const stored = getMeta(document).tags;
  const next = stored.filter((id) => !isTagDeleted(catalogDoc, id));
  if (next.length !== stored.length) setTags(document, next);
}

/** Replace visible assignments while retaining stored UUIDs whose catalog entries have not arrived. */
export function assignDocumentTags(document: Y.Doc, catalogDoc: Y.Doc, identities: readonly string[]): void {
  const index = catalogIndex(catalogDoc);
  const unknown: string[] = [];
  const next = new Set<string>();
  for (const requested of identities) {
    const canonical = canonicalDocumentUuid(requested);
    const entry = canonical === null ? undefined : index.byIdentity.get(canonical);
    if (entry === undefined) unknown.push(requested);
    else next.add(entry.id);
  }
  if (unknown.length > 0) throw new InvalidTagAssignmentError(unknown);
  for (const stored of getMeta(document).tags) {
    const canonical = canonicalDocumentUuid(stored);
    if (canonical !== null && !index.byIdentity.has(canonical) && !isTagDeleted(catalogDoc, canonical)) next.add(canonical);
  }
  setTags(document, [...next]);
}

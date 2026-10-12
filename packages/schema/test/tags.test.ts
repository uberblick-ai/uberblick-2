import { describe, expect, it } from "vitest";
import * as Y from "yjs";
import {
  EXAMPLE_TAGS, InvalidTagAssignmentError, InvalidTagDescriptionError,
  InvalidTagIdentityError, InvalidTagNameError, TAG_CATALOG_DELETED_KEY, TAG_CATALOG_RESTORED_KEY,
  TAG_CATALOG_RETIRED_KEY, assignDocumentTags, cleanupDocumentTags,
  createTagCatalogEntry, deleteTagCatalogEntry, exportMarkdown, getDirectoryEntry,
  getMeta, getMetaMap, getTagCatalogFlags, getTagCatalogIdentities, initDoc,
  isTagCatalogIdentityDeleted, isTagCatalogSeeded, listDeletedTagIdentities,
  listTagCatalog, migrateTagCatalog, readDirectoryTags, readDocumentTags,
  seedTagCatalog, setTagCatalogDescription, setTags, upsertDirectoryEntry,
} from "../src/index.js";
import { replicaPair, syncDocs } from "./helpers.js";

const DOCUMENT = "11111111-1111-4111-8111-111111111111";
const AUTH = "22222222-2222-4222-8222-222222222222";
const BILLING = "33333333-3333-4333-8333-333333333333";
const DELETED = "44444444-4444-4444-8444-444444444444";
const UNKNOWN = "55555555-5555-4555-8555-555555555555";

function document(tags: string[] = []): Y.Doc {
  const doc = new Y.Doc();
  initDoc(doc, { uuid: DOCUMENT, title: "Tagged", tags });
  return doc;
}

function legacyTag(catalog: Y.Doc, id: string, name: string): void {
  getTagCatalogIdentities(catalog).set(id, name);
}

function legacyRetire(catalog: Y.Doc, name: string): void {
  catalog.getMap<number>(TAG_CATALOG_RETIRED_KEY).set(`${name}#${catalog.clientID}`, 1);
}

describe("workspace tag catalog", () => {
  it("stores complete tag sets as deterministic flat presence entries", () => {
    const catalog = new Y.Doc();
    createTagCatalogEntry(catalog, "auth", AUTH);
    createTagCatalogEntry(catalog, "billing", BILLING);
    const doc = document([BILLING, AUTH, BILLING]);
    const meta = getMetaMap(doc);
    expect(meta.has("tags")).toBe(false);
    expect(getMeta(doc).tags).toEqual([AUTH, BILLING]);
    expect([...meta.entries()].filter(([key]) => key.startsWith("tag-assigned:")).sort(([left], [right]) => left.localeCompare(right))).toEqual([
      [`tag-assigned:${AUTH}`, true], [`tag-assigned:${BILLING}`, true],
    ]);
    assignDocumentTags(doc, catalog, [BILLING, AUTH]);
    expect(getMeta(doc).tags).toEqual([AUTH, BILLING]);
    expect(meta.has("tags")).toBe(false);
  });

  it("merges concurrent additions and removals independently per tag", () => {
    const [left, right] = replicaPair((doc) => {
      initDoc(doc, { uuid: DOCUMENT, title: "Tagged", tags: [AUTH, BILLING] });
    });
    setTags(left, [BILLING, DELETED]);
    setTags(right, [AUTH, UNKNOWN]);
    syncDocs(left, right);
    expect(getMeta(left).tags).toEqual([DELETED, UNKNOWN]);
    expect(getMeta(right).tags).toEqual(getMeta(left).tags);
    const [first, second] = replicaPair((doc) => {
      initDoc(doc, { uuid: DOCUMENT, title: "First assignment" });
    });
    setTags(first, [AUTH]);
    setTags(second, [BILLING]);
    syncDocs(first, second);
    expect(getMeta(first).tags).toEqual([AUTH, BILLING]);
    expect(getMeta(second).tags).toEqual(getMeta(first).tags);
  });

  it("converges same-tag toggles to one assignment", () => {
    const [left, right] = replicaPair((doc) => {
      initDoc(doc, { uuid: DOCUMENT, title: "Same tag" });
    });
    setTags(left, [AUTH, AUTH]);
    setTags(right, [AUTH]);
    syncDocs(left, right);
    expect(getMeta(left).tags).toEqual([AUTH]);
    expect(getMeta(right).tags).toEqual([AUTH]);
    setTags(left, []);
    setTags(right, []);
    syncDocs(left, right);
    expect(getMeta(left).tags).toEqual([]);
    expect(getMeta(right).tags).toEqual([]);
  });

  it("does not read the replaced array shape", () => {
    const legacy = new Y.Doc();
    getMetaMap(legacy).set("tags", [AUTH]);
    expect(getMeta(legacy).tags).toEqual([]);
  });

  it("validates names and descriptions before writing and never manufactures descriptions", () => {
    const catalog = new Y.Doc();
    expect(createTagCatalogEntry(catalog, "auth", AUTH)).toEqual({ id: AUTH, name: "auth" });
    expect(createTagCatalogEntry(catalog, "auth", BILLING).id).toBe(AUTH);
    expect(createTagCatalogEntry(catalog, "billing", BILLING, "  Invoices and payments  ")).toEqual({ id: BILLING, name: "billing", description: "Invoices and payments" });
    expect(createTagCatalogEntry(catalog, "empty", DELETED, "   ")).toEqual({ id: DELETED, name: "empty" });
    const before = Y.encodeStateAsUpdate(catalog);
    for (const name of ["Auth", "two words", "two--words", "a".repeat(31)]) {
      expect(() => createTagCatalogEntry(catalog, name)).toThrow(InvalidTagNameError);
    }
    for (const description of ["a".repeat(301), "one\ntwo", "one\rtwo", "one\u2028two"]) {
      expect(() => createTagCatalogEntry(catalog, "new", UNKNOWN, description)).toThrow(InvalidTagDescriptionError);
      expect(() => setTagCatalogDescription(catalog, AUTH, description)).toThrow(InvalidTagDescriptionError);
    }
    expect(Y.encodeStateAsUpdate(catalog)).toEqual(before);
    setTagCatalogDescription(catalog, AUTH, "😀".repeat(150));
    expect(listTagCatalog(catalog)[0]?.description).toHaveLength(300);
    expect(() => setTagCatalogDescription(catalog, AUTH, "😀".repeat(151))).toThrow(InvalidTagDescriptionError);
    setTagCatalogDescription(catalog, AUTH, " Updated purpose ");
    expect(listTagCatalog(catalog)[0]?.description).toBe("Updated purpose");
    setTagCatalogDescription(catalog, AUTH, " \t ");
    expect(listTagCatalog(catalog)[0]).toEqual({ id: AUTH, name: "auth" });
  });

  it("converges concurrent description replacement and clearing to one value", () => {
    const [left, right] = replicaPair((catalog) => {
      createTagCatalogEntry(catalog, "auth", AUTH, "Original purpose");
    });
    setTagCatalogDescription(left, AUTH, "Left purpose");
    setTagCatalogDescription(right, AUTH, "Right purpose");
    syncDocs(left, right);
    expect(listTagCatalog(left)).toEqual(listTagCatalog(right));
    expect(["Left purpose", "Right purpose"]).toContain(listTagCatalog(left)[0]?.description);
    setTagCatalogDescription(left, AUTH, null);
    setTagCatalogDescription(right, AUTH, "Replaced again");
    syncDocs(left, right);
    expect(listTagCatalog(left)).toEqual(listTagCatalog(right));
    expect([undefined, "Replaced again"]).toContain(listTagCatalog(left)[0]?.description);
  });

  it("converges same-name offline creates and deletes every converged alias", () => {
    const left = new Y.Doc();
    const right = new Y.Doc();
    createTagCatalogEntry(left, "auth", BILLING, "Later identity");
    createTagCatalogEntry(right, "auth", AUTH, "Canonical identity");
    const doc = document([BILLING]);
    syncDocs(left, right);
    expect(listTagCatalog(left)).toEqual([{ id: AUTH, name: "auth", description: "Canonical identity" }]);
    expect(readDocumentTags(doc, left)).toEqual(listTagCatalog(left));
    deleteTagCatalogEntry(left, BILLING);
    syncDocs(left, right);
    expect(listTagCatalog(left)).toEqual([]);
    expect(listTagCatalog(right)).toEqual([]);
    expect(listDeletedTagIdentities(left)).toEqual([EXAMPLE_TAGS[0].id, AUTH, BILLING]);
    expect(readDocumentTags(doc, left)).toEqual([]);
    expect(getMeta(doc).tags).toEqual([BILLING]);
  });

  it("deletion dominates stale description, identity and legacy restoration writes", () => {
    const [current, stale] = replicaPair((catalog) => {
      legacyTag(catalog, AUTH, "auth");
    });
    deleteTagCatalogEntry(current, AUTH);
    setTagCatalogDescription(stale, AUTH, "Stale edit");
    const staleAssignment = document();
    assignDocumentTags(staleAssignment, stale, [AUTH]);
    const assigned = Y.encodeStateAsUpdate(staleAssignment);
    getTagCatalogIdentities(stale).set(AUTH, "auth");
    stale.getMap<number>(TAG_CATALOG_RESTORED_KEY).set(`auth#${stale.clientID}`, 99);
    syncDocs(current, stale);
    expect(listTagCatalog(current)).toEqual([]);
    expect(listTagCatalog(stale)).toEqual([]);
    expect(isTagCatalogIdentityDeleted(current, AUTH)).toBe(true);
    expect(readDocumentTags(staleAssignment, current)).toEqual([]);
    expect(Y.encodeStateAsUpdate(staleAssignment)).toEqual(assigned);
    cleanupDocumentTags(staleAssignment, current);
    expect(getMeta(staleAssignment).tags).toEqual([]);
    expect(() => setTagCatalogDescription(current, AUTH, "Cannot revive")).toThrow(InvalidTagIdentityError);
    expect(createTagCatalogEntry(current, "auth", BILLING)).toEqual({ id: BILLING, name: "auth" });
    expect(readDocumentTags(document([AUTH]), current)).toEqual([]);
    expect(() => createTagCatalogEntry(new Y.Doc(), "auth", "not-a-uuid")).toThrow(InvalidTagIdentityError);
  });

  it("migrates retired names and delayed aliases without document writes or retiring recreations", () => {
    const catalog = new Y.Doc();
    legacyTag(catalog, AUTH, "auth");
    legacyTag(catalog, BILLING, "billing");
    legacyRetire(catalog, "auth");
    const doc = document([AUTH, BILLING]);
    const before = Y.encodeStateAsUpdate(doc);
    expect(listTagCatalog(catalog)).toEqual([{ id: BILLING, name: "billing" }]);
    expect(listDeletedTagIdentities(catalog)).toEqual([]);
    cleanupDocumentTags(doc, catalog);
    expect(Y.encodeStateAsUpdate(doc)).toEqual(before);
    migrateTagCatalog(catalog);
    expect(listDeletedTagIdentities(catalog)).toEqual([AUTH]);
    expect(Y.encodeStateAsUpdate(doc)).toEqual(before);
    createTagCatalogEntry(catalog, "auth", UNKNOWN);
    legacyTag(catalog, DELETED, "auth");
    migrateTagCatalog(catalog);
    expect(listDeletedTagIdentities(catalog)).toEqual([AUTH, DELETED]);
    expect(listTagCatalog(catalog)).toEqual([{ id: UNKNOWN, name: "auth" }, { id: BILLING, name: "billing" }]);
    const migrated = Y.encodeStateAsUpdate(catalog);
    migrateTagCatalog(catalog);
    expect(Y.encodeStateAsUpdate(catalog)).toEqual(migrated);
    cleanupDocumentTags(doc, catalog);
    expect(getMeta(doc).tags).toEqual([BILLING]);
  });

  it("keeps restored legacy tags and valid assignments unchanged during migration", () => {
    const catalog = new Y.Doc();
    legacyTag(catalog, AUTH, "auth");
    legacyRetire(catalog, "auth");
    catalog.getMap<number>(TAG_CATALOG_RESTORED_KEY).set(`auth#${catalog.clientID}`, 1);
    const doc = document([AUTH]);
    const before = Y.encodeStateAsUpdate(doc);
    migrateTagCatalog(catalog);
    expect(listTagCatalog(catalog)).toEqual([{ id: AUTH, name: "auth" }]);
    expect(listDeletedTagIdentities(catalog)).toEqual([]);
    expect(Y.encodeStateAsUpdate(doc)).toEqual(before);
  });

  it("never revives deleted fixed examples through a stale seed", () => {
    const current = new Y.Doc();
    const stale = new Y.Doc();
    seedTagCatalog(current);
    const rfc = EXAMPLE_TAGS.find((entry) => entry.name === "rfc")!;
    deleteTagCatalogEntry(current, rfc.id);
    seedTagCatalog(stale);
    syncDocs(current, stale);
    expect(isTagCatalogSeeded(current)).toBe(true);
    expect(listTagCatalog(current)).toEqual(listTagCatalog(stale));
    expect(listTagCatalog(current)).toHaveLength(EXAMPLE_TAGS.length - 1);
    expect(listTagCatalog(current).some((entry) => entry.name === "rfc")).toBe(false);
    expect(isTagCatalogIdentityDeleted(stale, rfc.id)).toBe(true);
    getTagCatalogFlags(current).delete("examples-seeded");
    seedTagCatalog(current);
    expect(listTagCatalog(current).some((entry) => entry.name === "rfc")).toBe(false);
    expect(() => createTagCatalogEntry(current, "rfc", rfc.id)).toThrow(InvalidTagIdentityError);
  });

  it("migrates legacy retirement despite a fresh replica's fixed example seed", () => {
    const current = new Y.Doc();
    const stale = new Y.Doc();
    seedTagCatalog(current);
    legacyRetire(current, "billing");
    migrateTagCatalog(current);
    seedTagCatalog(stale);
    syncDocs(current, stale);
    migrateTagCatalog(stale);
    const billing = EXAMPLE_TAGS.find((entry) => entry.name === "billing")!;
    expect(isTagCatalogIdentityDeleted(stale, billing.id)).toBe(true);
    expect(listTagCatalog(stale).some((entry) => entry.name === "billing")).toBe(false);
  });

  it("never revives a deleted curated example through a fresh offline seed", () => {
    const current = new Y.Doc();
    const fresh = new Y.Doc();
    const rfc = EXAMPLE_TAGS.find((entry) => entry.name === "rfc")!;
    createTagCatalogEntry(current, "rfc", AUTH, "Proposal discussions");
    deleteTagCatalogEntry(current, AUTH);
    seedTagCatalog(fresh);
    expect(listTagCatalog(fresh).some((entry) => entry.name === "rfc")).toBe(true);
    syncDocs(current, fresh);
    expect(listTagCatalog(current)).toEqual(listTagCatalog(fresh));
    expect(listTagCatalog(current).some((entry) => entry.name === "rfc")).toBe(false);
    expect(isTagCatalogIdentityDeleted(fresh, AUTH)).toBe(true);
    expect(isTagCatalogIdentityDeleted(fresh, rfc.id)).toBe(true);
    const staleAssignment = document([AUTH, rfc.id]);
    expect(readDocumentTags(staleAssignment, current)).toEqual([]);
    createTagCatalogEntry(current, "rfc", BILLING, "New proposals");
    syncDocs(current, fresh);
    expect(listTagCatalog(fresh).find((entry) => entry.name === "rfc")).toEqual({ id: BILLING, name: "rfc", description: "New proposals" });
    expect(readDocumentTags(staleAssignment, fresh)).toEqual([]);
    cleanupDocumentTags(staleAssignment, fresh);
    expect(getMeta(staleAssignment).tags).toEqual([]);
  });

  it("does not seed an example whose curated identity is already deleted", () => {
    const catalog = new Y.Doc();
    legacyTag(catalog, AUTH, "rfc");
    catalog.getMap<boolean>(TAG_CATALOG_DELETED_KEY).set(AUTH, true);
    seedTagCatalog(catalog);
    const rfc = EXAMPLE_TAGS.find((entry) => entry.name === "rfc")!;
    expect(getTagCatalogIdentities(catalog).has(rfc.id)).toBe(false);
    expect(listTagCatalog(catalog).some((entry) => entry.name === "rfc")).toBe(false);
    expect(isTagCatalogSeeded(catalog)).toBe(true);
  });

  it("does not add examples to an already seeded catalog", () => {
    const older = new Y.Doc();
    for (const example of EXAMPLE_TAGS.filter((entry) => entry.name !== "rfc")) {
      legacyTag(older, example.id, example.name);
    }
    getTagCatalogFlags(older).set("examples-seeded", true);
    const before = Y.encodeStateAsUpdate(older);
    seedTagCatalog(older);
    expect(Y.encodeStateAsUpdate(older)).toEqual(before);
    expect(listTagCatalog(older).some((entry) => entry.name === "rfc")).toBe(false);
  });

  it("shows only existing tags in document, directory and Markdown reads without writing", () => {
    const catalog = new Y.Doc();
    createTagCatalogEntry(catalog, "auth", AUTH, "Access control");
    createTagCatalogEntry(catalog, "deleted", DELETED);
    const doc = document([AUTH, DELETED, UNKNOWN]);
    const directory = new Y.Doc();
    upsertDirectoryEntry(directory, { uuid: DOCUMENT, title: "Tagged", tags: getMeta(doc).tags });
    const before = Y.encodeStateAsUpdate(doc);
    const directoryBefore = Y.encodeStateAsUpdate(directory);
    deleteTagCatalogEntry(catalog, DELETED);
    const expected = [{ id: AUTH, name: "auth", description: "Access control" }];
    expect(readDocumentTags(doc, catalog)).toEqual(expected);
    expect(readDirectoryTags(getDirectoryEntry(directory, DOCUMENT)!, catalog)).toEqual(expected);
    const markdown = exportMarkdown(doc, { tagCatalog: catalog });
    expect(markdown).toContain("tags: [auth]");
    expect(markdown).not.toContain("Access control");
    expect(markdown).not.toContain(DELETED);
    expect(markdown).not.toContain(UNKNOWN);
    expect(Y.encodeStateAsUpdate(doc)).toEqual(before);
    expect(Y.encodeStateAsUpdate(directory)).toEqual(directoryBefore);
  });

  it("preserves unresolved references across whole-set writes and drops only positive deletions", () => {
    const catalog = new Y.Doc();
    createTagCatalogEntry(catalog, "auth", AUTH);
    createTagCatalogEntry(catalog, "deleted", DELETED);
    deleteTagCatalogEntry(catalog, DELETED);
    const doc = document([AUTH, DELETED, UNKNOWN]);
    assignDocumentTags(doc, catalog, []);
    expect(getMeta(doc).tags).toEqual([UNKNOWN]);
    assignDocumentTags(doc, catalog, [AUTH, AUTH]);
    expect(getMeta(doc).tags).toEqual([AUTH, UNKNOWN]);
    expect(readDocumentTags(doc, catalog)).toEqual([{ id: AUTH, name: "auth" }]);
    cleanupDocumentTags(doc, catalog);
    expect(getMeta(doc).tags).toEqual([AUTH, UNKNOWN]);
    createTagCatalogEntry(catalog, "arrived", UNKNOWN);
    expect(readDocumentTags(doc, catalog)).toEqual([{ id: AUTH, name: "auth" }, { id: UNKNOWN, name: "arrived" }]);
    assignDocumentTags(doc, catalog, []);
    expect(getMeta(doc).tags).toEqual([]);
  });

  it("clears provisional strings on whole-set writes while retaining unresolved UUIDs", () => {
    const catalog = new Y.Doc();
    createTagCatalogEntry(catalog, "auth", AUTH);
    const empty = document(["provisional", UNKNOWN]);
    assignDocumentTags(empty, catalog, []);
    expect(getMeta(empty).tags).toEqual([UNKNOWN]);
    const assigned = document(["provisional", UNKNOWN]);
    assignDocumentTags(assigned, catalog, [AUTH]);
    expect(getMeta(assigned).tags).toEqual([AUTH, UNKNOWN]);
  });

  it("refuses unknown and deleted assignments atomically even when already stored", () => {
    const catalog = new Y.Doc();
    createTagCatalogEntry(catalog, "auth", AUTH);
    createTagCatalogEntry(catalog, "deleted", DELETED);
    deleteTagCatalogEntry(catalog, DELETED);
    const doc = document([DELETED, UNKNOWN, "provisional"]);
    const before = Y.encodeStateAsUpdate(doc);
    expect(() => assignDocumentTags(doc, catalog, [AUTH, DELETED, UNKNOWN])).toThrow(InvalidTagAssignmentError);
    expect(Y.encodeStateAsUpdate(doc)).toEqual(before);
  });

  it("replaces resolved mixed-case stored identities without keeping a hidden duplicate", () => {
    const catalog = new Y.Doc();
    const id = "abcdefab-2222-4222-8222-222222222222";
    createTagCatalogEntry(catalog, "auth", id);
    const doc = document([id.toUpperCase(), UNKNOWN]);
    expect(readDocumentTags(doc, catalog)).toEqual([{ id, name: "auth" }]);
    assignDocumentTags(doc, catalog, []);
    expect(getMeta(doc).tags).toEqual([UNKNOWN]);
  });
});

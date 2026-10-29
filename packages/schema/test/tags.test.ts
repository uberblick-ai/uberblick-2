import { describe, expect, it } from "vitest";
import * as Y from "yjs";
import {
  EXAMPLE_TAGS,
  InvalidTagAssignmentError,
  InvalidTagDescriptionError,
  assignDocumentTags,
  cleanupDeletedDocumentTags,
  createTagCatalogEntry,
  deleteTagCatalogEntry,
  getDirectoryEntry,
  getMeta,
  getMetaMap,
  getTagCatalogEntry,
  getTagCatalogIdentities,
  initDoc,
  isTagCatalogSeeded,
  isTagDeleted,
  listDeletedTagCatalogEntries,
  listTagCatalog,
  migrateRetiredTagCatalogEntries,
  readDirectoryTags,
  readDocumentTags,
  seedTagCatalog,
  setTagCatalogDescription,
  setTags,
  upsertDirectoryEntry,
} from "../src/index.js";
import { InvalidTagNameError } from "../src/errors.js";
import { getTagCatalogFlags, TAG_CATALOG_DESCRIPTIONS_KEY, TAG_CATALOG_RESTORED_KEY, TAG_CATALOG_RETIRED_KEY } from "../src/tags.js";
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

function retireLegacy(catalog: Y.Doc, name: string): void {
  catalog.getMap<number>(TAG_CATALOG_RETIRED_KEY).set(`${name}#legacy`, 1);
}

describe("workspace tag catalog", () => {
  it("stores complete tag sets as deterministic flat presence entries", () => {
    const catalog = new Y.Doc();
    createTagCatalogEntry(catalog, "auth", AUTH);
    createTagCatalogEntry(catalog, "billing", BILLING);
    const doc = document([BILLING, AUTH, BILLING]);
    expect(getMetaMap(doc).has("tags")).toBe(false);
    expect(getMeta(doc).tags).toEqual([AUTH, BILLING]);
    expect([...getMetaMap(doc).keys()].filter((key) => key.startsWith("tag-assigned:")).sort()).toEqual([
      `tag-assigned:${AUTH}`, `tag-assigned:${BILLING}`,
    ]);
    setTags(doc, [DELETED, DELETED]);
    expect(getMeta(doc).tags).toEqual([DELETED]);
    assignDocumentTags(doc, catalog, [BILLING, AUTH]);
    expect(getMeta(doc).tags).toEqual([AUTH, BILLING, DELETED]);
  });

  it("merges concurrent additions and removals independently per tag", () => {
    const [left, right] = replicaPair((doc) => { initDoc(doc, { uuid: DOCUMENT, title: "Tagged", tags: [AUTH, BILLING] }); });
    setTags(left, [BILLING, DELETED]);
    setTags(right, [AUTH, UNKNOWN]);
    syncDocs(left, right);
    expect(getMeta(left).tags).toEqual([DELETED, UNKNOWN]);
    expect(getMeta(right).tags).toEqual(getMeta(left).tags);
    const [first, second] = replicaPair((doc) => { initDoc(doc, { uuid: DOCUMENT, title: "First" }); });
    setTags(first, [AUTH]);
    setTags(second, [BILLING]);
    syncDocs(first, second);
    expect(getMeta(first).tags).toEqual([AUTH, BILLING]);
    expect(getMeta(second).tags).toEqual(getMeta(first).tags);
  });

  it("converges same-tag toggles to one assignment", () => {
    const [left, right] = replicaPair((doc) => { initDoc(doc, { uuid: DOCUMENT, title: "Same" }); });
    setTags(left, [AUTH, AUTH]);
    setTags(right, [AUTH]);
    syncDocs(left, right);
    expect(getMeta(left).tags).toEqual([AUTH]);
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

  it("validates unique names without writing", () => {
    const catalog = new Y.Doc();
    expect(createTagCatalogEntry(catalog, "auth", AUTH)).toEqual({ id: AUTH, name: "auth" });
    expect(createTagCatalogEntry(catalog, "auth", BILLING).id).toBe(AUTH);
    const before = Y.encodeStateAsUpdate(catalog);
    for (const name of ["Auth", "two words", "two--words", "a".repeat(31)]) {
      expect(() => createTagCatalogEntry(catalog, name)).toThrow(InvalidTagNameError);
    }
    expect(Y.encodeStateAsUpdate(catalog)).toEqual(before);
  });

  it("stores, replaces and clears optional trimmed descriptions", () => {
    const catalog = new Y.Doc();
    expect(createTagCatalogEntry(catalog, "auth", AUTH, "  Sign in  ")).toEqual({ id: AUTH, name: "auth", description: "Sign in" });
    setTagCatalogDescription(catalog, AUTH, "x".repeat(300));
    expect(listTagCatalog(catalog)[0]?.description).toHaveLength(300);
    setTagCatalogDescription(catalog, AUTH, "  Replaced  ");
    expect(listTagCatalog(catalog)[0]?.description).toBe("Replaced");
    setTagCatalogDescription(catalog, AUTH, "   ");
    expect(listTagCatalog(catalog)).toEqual([{ id: AUTH, name: "auth" }]);
    setTagCatalogDescription(catalog, AUTH, "Another");
    setTagCatalogDescription(catalog, AUTH, null);
    expect(listTagCatalog(catalog)).toEqual([{ id: AUTH, name: "auth" }]);
    expect(createTagCatalogEntry(catalog, "billing", BILLING, "  ")).toEqual({ id: BILLING, name: "billing" });
  });

  it("refuses long and multiline descriptions atomically using document-description counting", () => {
    const catalog = new Y.Doc();
    createTagCatalogEntry(catalog, "auth", AUTH);
    const before = Y.encodeStateAsUpdate(catalog);
    for (const description of ["x".repeat(301), "😀".repeat(151), "one\ntwo", "one\rtwo", "\ntrimmed", "one\u2028two"]) {
      expect(() => setTagCatalogDescription(catalog, AUTH, description)).toThrow(InvalidTagDescriptionError);
      expect(() => createTagCatalogEntry(catalog, "billing", BILLING, description)).toThrow(InvalidTagDescriptionError);
    }
    expect(Y.encodeStateAsUpdate(catalog)).toEqual(before);
    setTagCatalogDescription(catalog, AUTH, "😀".repeat(150));
    expect(listTagCatalog(catalog)[0]?.description).toHaveLength(300);
  });

  it("converges concurrent description edits and clears", () => {
    const [left, right] = replicaPair((catalog) => { createTagCatalogEntry(catalog, "auth", AUTH, "Original"); });
    setTagCatalogDescription(left, AUTH, "From left");
    setTagCatalogDescription(right, AUTH, "From right");
    syncDocs(left, right);
    expect(listTagCatalog(left)).toEqual(listTagCatalog(right));
    expect(["From left", "From right"]).toContain(listTagCatalog(left)[0]?.description);
    setTagCatalogDescription(left, AUTH, null);
    setTagCatalogDescription(right, AUTH, "Concurrent");
    syncDocs(left, right);
    expect(listTagCatalog(left)).toEqual(listTagCatalog(right));
    expect([undefined, "Concurrent"]).toContain(listTagCatalog(left)[0]?.description);
  });

  it("converges duplicate names, resolves aliases and deletes every converged identity", () => {
    const first = new Y.Doc();
    const second = new Y.Doc();
    createTagCatalogEntry(first, "auth", BILLING, "Later identity");
    createTagCatalogEntry(second, "auth", AUTH, "Earlier identity");
    const doc = document([BILLING]);
    syncDocs(first, second);
    expect(listTagCatalog(first)).toEqual([{ id: AUTH, name: "auth", description: "Earlier identity" }]);
    expect(readDocumentTags(doc, first)).toEqual(listTagCatalog(first));
    setTagCatalogDescription(first, BILLING, null);
    expect(listTagCatalog(first)).toEqual([{ id: AUTH, name: "auth" }]);
    deleteTagCatalogEntry(first, BILLING);
    syncDocs(first, second);
    expect(listTagCatalog(first)).toEqual([]);
    expect(listTagCatalog(second)).toEqual([]);
    expect(isTagDeleted(first, AUTH)).toBe(true);
    expect(isTagDeleted(first, BILLING)).toBe(true);
    expect(getMeta(doc).tags).toEqual([BILLING]);
    expect(readDocumentTags(doc, first)).toEqual([]);
  });

  it("never revives deleted identities after stale description, identity, legacy restore or seed writes", () => {
    const [deleted, stale] = replicaPair((catalog) => { createTagCatalogEntry(catalog, "rfc", AUTH, "Original"); });
    deleteTagCatalogEntry(deleted, AUTH);
    setTagCatalogDescription(stale, AUTH, "Stale");
    getTagCatalogIdentities(stale).set(AUTH, "rfc");
    stale.getMap<number>(TAG_CATALOG_RESTORED_KEY).set("rfc#legacy", 10);
    seedTagCatalog(stale);
    syncDocs(deleted, stale);
    expect(listTagCatalog(deleted).some((entry) => entry.name === "rfc")).toBe(false);
    expect(listTagCatalog(stale)).toEqual(listTagCatalog(deleted));
    expect(isTagDeleted(deleted, "00000000-0000-4000-8000-000000000006")).toBe(true);
    expect(() => createTagCatalogEntry(deleted, "rfc", AUTH)).toThrow();
    const recreated = createTagCatalogEntry(deleted, "rfc", BILLING);
    expect(recreated).toEqual({ id: BILLING, name: "rfc" });
    expect(readDocumentTags(document([AUTH]), deleted)).toEqual([]);
    expect(readDocumentTags(document([BILLING]), deleted)).toEqual([recreated]);
  });

  it("seeds eight fixed identities with exactly three starting descriptions", () => {
    const first = new Y.Doc();
    const second = new Y.Doc();
    seedTagCatalog(first);
    seedTagCatalog(second);
    syncDocs(first, second);
    expect(isTagCatalogSeeded(first)).toBe(true);
    expect(listTagCatalog(first)).toEqual(listTagCatalog(second));
    expect(listTagCatalog(first)).toEqual([
      { id: "00000000-0000-4000-8000-000000000001", name: "auth" },
      { id: "00000000-0000-4000-8000-000000000002", name: "billing" },
      {
        id: "00000000-0000-4000-8000-000000000007", name: "guidance",
        description: "Workspace rules for writing and editing pages; agents are pointed to these at startup and read them before their first write.",
      },
      { id: "00000000-0000-4000-8000-000000000003", name: "mcp" },
      { id: "00000000-0000-4000-8000-000000000004", name: "permissions" },
      {
        id: "00000000-0000-4000-8000-000000000006", name: "rfc",
        description: "The discussion behind a decision record: options, evidence and the detail developers need to align; the decision record holds the answer.",
      },
      { id: "00000000-0000-4000-8000-000000000005", name: "sync" },
      {
        id: "00000000-0000-4000-8000-000000000008", name: "technical-reference",
        description: "Readers act on exact names, fields, codes or formats, such as API clients or agents.",
      },
    ]);
  });

  it.each(["rfc", "guidance", "technical-reference"])("never recreates deleted example %s", (name) => {
    const fresh = new Y.Doc();
    createTagCatalogEntry(fresh, name, AUTH);
    deleteTagCatalogEntry(fresh, AUTH);
    seedTagCatalog(fresh);
    expect(listTagCatalog(fresh).some((entry) => entry.name === name)).toBe(false);
    const before = Y.encodeStateAsUpdate(fresh);
    seedTagCatalog(fresh);
    expect(Y.encodeStateAsUpdate(fresh)).toEqual(before);
  });

  it.each(["rfc", "guidance", "technical-reference"])("does not add %s or descriptions to an already seeded catalog", (newName) => {
    const older = new Y.Doc();
    for (const example of EXAMPLE_TAGS.filter((entry) => entry.name !== newName)) createTagCatalogEntry(older, example.name, example.id);
    getTagCatalogFlags(older).set("examples-seeded", true);
    const before = Y.encodeStateAsUpdate(older);
    seedTagCatalog(older);
    expect(Y.encodeStateAsUpdate(older)).toEqual(before);
    expect(listTagCatalog(older).some((entry) => entry.name === newName)).toBe(false);
    expect(listTagCatalog(older).every((entry) => entry.description === undefined)).toBe(true);
  });

  it.each(["rfc", "guidance", "technical-reference"])("preserves an existing %s tag's identity and description when first seeding", (name) => {
    for (const description of [undefined, "Workspace-specific guidance"]) {
      const catalog = new Y.Doc();
      const existing = createTagCatalogEntry(catalog, name, AUTH, description);
      seedTagCatalog(catalog);
      expect(listTagCatalog(catalog).find((entry) => entry.name === name)).toEqual(existing);
      expect(getTagCatalogIdentities(catalog).size).toBe(EXAMPLE_TAGS.length);
      expect(catalog.getMap<string>(TAG_CATALOG_DESCRIPTIONS_KEY).has(AUTH)).toBe(description !== undefined);
    }
  });

  it("does not restore edited or cleared seed descriptions when seeded again", () => {
    const catalog = new Y.Doc();
    seedTagCatalog(catalog);
    setTagCatalogDescription(catalog, "00000000-0000-4000-8000-000000000007", "Workspace-specific guidance");
    setTagCatalogDescription(catalog, "00000000-0000-4000-8000-000000000006", null);
    const before = Y.encodeStateAsUpdate(catalog);
    seedTagCatalog(catalog);
    expect(Y.encodeStateAsUpdate(catalog)).toEqual(before);
  });

  it("does not write catalogs without legacy state or consume lifecycle before its identity arrives", () => {
    const catalog = new Y.Doc();
    const empty = Y.encodeStateAsUpdate(catalog);
    migrateRetiredTagCatalogEntries(catalog);
    expect(Y.encodeStateAsUpdate(catalog)).toEqual(empty);
    seedTagCatalog(catalog);
    const seeded = Y.encodeStateAsUpdate(catalog);
    migrateRetiredTagCatalogEntries(catalog);
    expect(Y.encodeStateAsUpdate(catalog)).toEqual(seeded);

    const delayedCatalog = new Y.Doc();
    retireLegacy(delayedCatalog, "delayed");
    const delayed = Y.encodeStateAsUpdate(delayedCatalog);
    migrateRetiredTagCatalogEntries(delayedCatalog);
    expect(Y.encodeStateAsUpdate(delayedCatalog)).toEqual(delayed);
    getTagCatalogIdentities(delayedCatalog).set(AUTH, "delayed");
    migrateRetiredTagCatalogEntries(delayedCatalog);
    expect(isTagDeleted(delayedCatalog, AUTH)).toBe(true);
  });

  it("freezes restored legacy state so late old lifecycle edits cannot delete active identities", () => {
    const catalog = new Y.Doc();
    getTagCatalogIdentities(catalog).set(AUTH, "auth");
    retireLegacy(catalog, "auth");
    catalog.getMap<number>(TAG_CATALOG_RESTORED_KEY).set("auth#legacy", 2);
    migrateRetiredTagCatalogEntries(catalog);
    catalog.getMap<number>(TAG_CATALOG_RETIRED_KEY).set("auth#stale", 3);
    migrateRetiredTagCatalogEntries(catalog);
    expect(listTagCatalog(catalog)).toEqual([{ id: AUTH, name: "auth" }]);
    expect(isTagDeleted(catalog, AUTH)).toBe(false);
  });

  it("hides legacy retired tags without writing, then migrates every alias without touching documents", () => {
    const catalog = new Y.Doc();
    getTagCatalogIdentities(catalog).set(AUTH, "auth");
    getTagCatalogIdentities(catalog).set(BILLING, "auth");
    getTagCatalogIdentities(catalog).set(UNKNOWN, "keep");
    retireLegacy(catalog, "auth");
    const doc = document([AUTH, BILLING, UNKNOWN]);
    const catalogBefore = Y.encodeStateAsUpdate(catalog);
    const docBefore = Y.encodeStateAsUpdate(doc);
    expect(listTagCatalog(catalog)).toEqual([{ id: UNKNOWN, name: "keep" }]);
    expect(readDocumentTags(doc, catalog)).toEqual([{ id: UNKNOWN, name: "keep" }]);
    expect(Y.encodeStateAsUpdate(catalog)).toEqual(catalogBefore);
    cleanupDeletedDocumentTags(doc, catalog);
    expect(Y.encodeStateAsUpdate(doc)).toEqual(docBefore);
    migrateRetiredTagCatalogEntries(catalog);
    expect(isTagDeleted(catalog, AUTH)).toBe(true);
    expect(isTagDeleted(catalog, BILLING)).toBe(true);
    expect(Y.encodeStateAsUpdate(doc)).toEqual(docBefore);
    expect(createTagCatalogEntry(catalog, "auth", DELETED)).toEqual({ id: DELETED, name: "auth" });
    catalog.getMap<number>(TAG_CATALOG_RESTORED_KEY).set("auth#legacy", 20);
    retireLegacy(catalog, "keep");
    expect(listTagCatalog(catalog)).toEqual([{ id: DELETED, name: "auth" }, { id: UNKNOWN, name: "keep" }]);
    const migrated = Y.encodeStateAsUpdate(catalog);
    migrateRetiredTagCatalogEntries(catalog);
    expect(Y.encodeStateAsUpdate(catalog)).toEqual(migrated);
  });

  it("keeps a recreated identity existing when a late legacy retirement arrives", () => {
    const catalog = new Y.Doc();
    getTagCatalogIdentities(catalog).set(AUTH, "auth");
    expect(migrateRetiredTagCatalogEntries(catalog)).toBe(false);
    deleteTagCatalogEntry(catalog, AUTH);
    createTagCatalogEntry(catalog, "auth", BILLING);
    retireLegacy(catalog, "auth");
    migrateRetiredTagCatalogEntries(catalog);
    expect(listTagCatalog(catalog)).toEqual([{ id: BILLING, name: "auth" }]);
    expect(isTagDeleted(catalog, AUTH)).toBe(true);
    expect(isTagDeleted(catalog, BILLING)).toBe(false);
  });

  it.each(["create", "describe", "delete", "seed"] as const)("does not migrate unrelated legacy identities during a %s write", (action) => {
    const catalog = new Y.Doc();
    getTagCatalogIdentities(catalog).set(AUTH, "auth");
    getTagCatalogIdentities(catalog).set(DELETED, "billing");
    retireLegacy(catalog, "billing");
    if (action === "create") createTagCatalogEntry(catalog, "new", UNKNOWN);
    if (action === "describe") setTagCatalogDescription(catalog, AUTH, "Purpose");
    if (action === "delete") deleteTagCatalogEntry(catalog, AUTH);
    if (action === "seed") seedTagCatalog(catalog);
    expect(isTagDeleted(catalog, DELETED)).toBe(false);
    expect(listTagCatalog(catalog).some((entry) => entry.name === "billing")).toBe(false);
    expect(isTagDeleted(catalog, AUTH)).toBe(action === "delete");
  });

  it("keeps modern-only identities existing despite late legacy name levels without manufacturing migration writes", () => {
    const catalog = new Y.Doc();
    createTagCatalogEntry(catalog, "auth", AUTH);
    retireLegacy(catalog, "auth");
    const before = Y.encodeStateAsUpdate(catalog);
    expect(migrateRetiredTagCatalogEntries(catalog)).toBe(false);
    expect(Y.encodeStateAsUpdate(catalog)).toEqual(before);
    expect(listTagCatalog(catalog)).toEqual([{ id: AUTH, name: "auth" }]);
  });

  it("migrates retired legacy identities while preserving a modern recreation with the same name", () => {
    const catalog = new Y.Doc();
    getTagCatalogIdentities(catalog).set(AUTH, "auth");
    retireLegacy(catalog, "auth");
    createTagCatalogEntry(catalog, "auth", BILLING);
    expect(listTagCatalog(catalog)).toEqual([{ id: BILLING, name: "auth" }]);
    migrateRetiredTagCatalogEntries(catalog);
    expect(isTagDeleted(catalog, AUTH)).toBe(true);
    expect(isTagDeleted(catalog, BILLING)).toBe(false);
    expect(listTagCatalog(catalog)).toEqual([{ id: BILLING, name: "auth" }]);
  });

  it("keeps a restored hub identity when stale cached curation occurs before the restoration arrives", () => {
    const [hub, cached] = replicaPair((catalog) => {
      getTagCatalogIdentities(catalog).set(AUTH, "auth");
      retireLegacy(catalog, "auth");
    });
    hub.getMap<number>(TAG_CATALOG_RESTORED_KEY).set("auth#hub", 2);
    createTagCatalogEntry(cached, "unrelated", UNKNOWN);
    expect(isTagDeleted(cached, AUTH)).toBe(false);
    syncDocs(hub, cached);
    migrateRetiredTagCatalogEntries(cached);
    syncDocs(hub, cached);
    expect(listTagCatalog(cached)).toEqual([{ id: AUTH, name: "auth" }, { id: UNKNOWN, name: "unrelated" }]);
    expect(listTagCatalog(hub)).toEqual(listTagCatalog(cached));
    expect(isTagDeleted(cached, AUTH)).toBe(false);
  });

  it("distinguishes an explicit new fixed identity from a stale fixed-identity seed during migration", () => {
    const legacy = new Y.Doc();
    getTagCatalogIdentities(legacy).set(AUTH, "auth");
    retireLegacy(legacy, "auth");
    const explicit = new Y.Doc();
    createTagCatalogEntry(explicit, "auth", EXAMPLE_TAGS[0].id);
    syncDocs(legacy, explicit);
    migrateRetiredTagCatalogEntries(legacy);
    expect(isTagDeleted(legacy, AUTH)).toBe(true);
    expect(isTagDeleted(legacy, EXAMPLE_TAGS[0].id)).toBe(false);
    expect(listTagCatalog(legacy)).toEqual([{ id: EXAMPLE_TAGS[0].id, name: "auth" }]);

    const retired = new Y.Doc();
    getTagCatalogIdentities(retired).set(AUTH, "auth");
    retireLegacy(retired, "auth");
    const seeded = new Y.Doc();
    seedTagCatalog(seeded);
    syncDocs(retired, seeded);
    migrateRetiredTagCatalogEntries(retired);
    expect(isTagDeleted(retired, EXAMPLE_TAGS[0].id)).toBe(true);
    expect(listTagCatalog(retired).some((entry) => entry.name === "auth")).toBe(false);
  });

  it("does not migrate on refused or unchanged catalog curation", () => {
    const catalog = new Y.Doc();
    getTagCatalogIdentities(catalog).set(AUTH, "auth");
    getTagCatalogIdentities(catalog).set(DELETED, "billing");
    retireLegacy(catalog, "billing");
    const before = Y.encodeStateAsUpdate(catalog);
    createTagCatalogEntry(catalog, "auth", BILLING);
    setTagCatalogDescription(catalog, AUTH, " ");
    expect(() => createTagCatalogEntry(catalog, "new", AUTH)).toThrow();
    expect(() => createTagCatalogEntry(catalog, "new", EXAMPLE_TAGS[1].id)).toThrow();
    expect(() => setTagCatalogDescription(catalog, AUTH, "bad\nvalue")).toThrow();
    expect(() => deleteTagCatalogEntry(catalog, DELETED)).toThrow();
    expect(Y.encodeStateAsUpdate(catalog)).toEqual(before);
    expect(isTagDeleted(catalog, DELETED)).toBe(false);
  });

  it("omits provisional, absent and deleted tags from document and directory reads without writing", () => {
    const catalog = new Y.Doc();
    createTagCatalogEntry(catalog, "auth", AUTH, "Identity");
    createTagCatalogEntry(catalog, "deleted", DELETED);
    const doc = document([AUTH, DELETED, UNKNOWN, "provisional"]);
    const directory = new Y.Doc();
    upsertDirectoryEntry(directory, { uuid: DOCUMENT, title: "Tagged", tags: getMeta(doc).tags });
    const before = Y.encodeStateAsUpdate(doc);
    deleteTagCatalogEntry(catalog, DELETED);
    expect(readDocumentTags(doc, catalog)).toEqual([{ id: AUTH, name: "auth", description: "Identity" }]);
    expect(readDirectoryTags(getDirectoryEntry(directory, DOCUMENT)!, catalog)).toEqual(readDocumentTags(doc, catalog));
    expect(Y.encodeStateAsUpdate(doc)).toEqual(before);
    cleanupDeletedDocumentTags(doc, catalog);
    expect(getMeta(doc).tags).toEqual([AUTH, UNKNOWN, "provisional"]);
    expect(getTagCatalogEntry(catalog, DELETED)).toBeNull();
    expect(listDeletedTagCatalogEntries(catalog)).toContainEqual({ id: DELETED, name: "deleted" });
  });

  it("validates a complete assignment before any cleanup and preserves delayed UUIDs on whole-set writes", () => {
    const catalog = new Y.Doc();
    createTagCatalogEntry(catalog, "auth", AUTH);
    createTagCatalogEntry(catalog, "deleted", DELETED);
    deleteTagCatalogEntry(catalog, DELETED);
    const doc = document([AUTH, DELETED, UNKNOWN, "provisional"]);
    const before = Y.encodeStateAsUpdate(doc);
    for (const requested of [[AUTH, DELETED], [AUTH, UNKNOWN], [AUTH, "provisional"]]) {
      expect(() => assignDocumentTags(doc, catalog, requested)).toThrow(InvalidTagAssignmentError);
      expect(Y.encodeStateAsUpdate(doc)).toEqual(before);
    }
    assignDocumentTags(doc, catalog, []);
    expect(getMeta(doc).tags).toEqual([UNKNOWN]);
    expect(readDocumentTags(doc, catalog)).toEqual([]);
    createTagCatalogEntry(catalog, "arrived", UNKNOWN);
    expect(readDocumentTags(doc, catalog)).toEqual([{ id: UNKNOWN, name: "arrived" }]);
    assignDocumentTags(doc, catalog, [AUTH]);
    expect(getMeta(doc).tags).toEqual([AUTH]);
  });

  it("ignores malformed foreign description registers", () => {
    const catalog = new Y.Doc();
    createTagCatalogEntry(catalog, "auth", AUTH);
    catalog.getMap<string>(TAG_CATALOG_DESCRIPTIONS_KEY).set(AUTH, "bad\nvalue");
    expect(listTagCatalog(catalog)).toEqual([{ id: AUTH, name: "auth" }]);
  });
});

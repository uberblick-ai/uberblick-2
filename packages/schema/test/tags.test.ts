import { describe, expect, it } from "vitest";
import * as Y from "yjs";
import {
  EXAMPLE_TAGS,
  InvalidTagAssignmentError,
  InvalidTagNameError,
  assignDocumentTags,
  createTagCatalogEntry,
  getMeta,
  initDoc,
  isTagCatalogSeeded,
  listTagCatalog,
  readDirectoryTags,
  readDocumentTags,
  restoreTagCatalogEntry,
  retireTagCatalogEntry,
  seedTagCatalog,
  upsertDirectoryEntry,
  getDirectoryEntry,
} from "../src/index.js";
import { syncDocs } from "./helpers.js";

const DOCUMENT = "11111111-1111-4111-8111-111111111111";
const AUTH = "22222222-2222-4222-8222-222222222222";
const BILLING = "33333333-3333-4333-8333-333333333333";
const RETIRED = "44444444-4444-4444-8444-444444444444";
const UNKNOWN = "55555555-5555-4555-8555-555555555555";

function document(tags: string[] = []): Y.Doc {
  const doc = new Y.Doc();
  initDoc(doc, { uuid: DOCUMENT, title: "Tagged", tags });
  return doc;
}

describe("workspace tag catalog", () => {
  it("validates unique names and exposes ordinary active and retired entries", () => {
    const catalog = new Y.Doc();
    expect(createTagCatalogEntry(catalog, "auth", AUTH)).toEqual({
      id: AUTH,
      name: "auth",
      state: "active",
    });
    expect(createTagCatalogEntry(catalog, "auth", BILLING).id).toBe(AUTH);
    expect(listTagCatalog(catalog)).toHaveLength(1);

    const before = Y.encodeStateAsUpdate(catalog);
    for (const name of ["Auth", "two words", "two--words", "a".repeat(31)]) {
      expect(() => createTagCatalogEntry(catalog, name)).toThrow(
        InvalidTagNameError,
      );
    }
    expect(Y.encodeStateAsUpdate(catalog)).toEqual(before);

    retireTagCatalogEntry(catalog, AUTH);
    expect(listTagCatalog(catalog)[0]?.state).toBe("retired");
    restoreTagCatalogEntry(catalog, AUTH);
    expect(listTagCatalog(catalog)[0]?.state).toBe("active");
  });

  it("converges same-name offline creates without orphaning either identity", () => {
    const a = new Y.Doc();
    const b = new Y.Doc();
    const later = createTagCatalogEntry(a, "auth", BILLING);
    const earlier = createTagCatalogEntry(b, "auth", AUTH);
    const assignedBeforeMerge = document();
    assignDocumentTags(assignedBeforeMerge, a, [later.id]);

    syncDocs(a, b);
    expect(listTagCatalog(a)).toEqual(listTagCatalog(b));
    expect(listTagCatalog(a)).toEqual([
      { id: earlier.id, name: "auth", state: "active" },
    ]);
    expect(readDocumentTags(assignedBeforeMerge, a)).toEqual([
      { id: earlier.id, name: "auth", state: "active" },
    ]);
  });

  it("seeds one editable example set without reviving a retired example", () => {
    const retired = new Y.Doc();
    const stale = new Y.Doc();
    seedTagCatalog(retired);
    retireTagCatalogEntry(retired, EXAMPLE_TAGS[0].id);

    // This replica has seen neither the seed flag nor the retirement.
    seedTagCatalog(stale);
    syncDocs(retired, stale);

    expect(isTagCatalogSeeded(retired)).toBe(true);
    expect(listTagCatalog(retired)).toEqual(listTagCatalog(stale));
    expect(listTagCatalog(retired)).toHaveLength(EXAMPLE_TAGS.length);
    expect(listTagCatalog(retired).find((entry) => entry.name === "auth")?.state)
      .toBe("retired");
    expect(listTagCatalog(retired).map((entry) => entry.name)).toEqual([
      "auth",
      "billing",
      "mcp",
      "permissions",
      "sync",
    ]);

    restoreTagCatalogEntry(retired, EXAMPLE_TAGS[0].id);
    expect(listTagCatalog(retired).find((entry) => entry.name === "auth")?.state)
      .toBe("active");
  });

  it("resolves UUID assignments for documents and directory stubs", () => {
    const catalog = new Y.Doc();
    createTagCatalogEntry(catalog, "auth", AUTH);
    const doc = document(["auth"]);
    const directory = new Y.Doc();
    upsertDirectoryEntry(directory, {
      uuid: DOCUMENT,
      title: "Tagged",
      tags: ["auth"],
    });

    // Provisional names are neither accepted nor exposed as identities.
    expect(readDocumentTags(doc, catalog)).toEqual([]);
    expect(readDirectoryTags(getDirectoryEntry(directory, DOCUMENT)!, catalog))
      .toEqual([]);

    assignDocumentTags(doc, catalog, [AUTH]);
    upsertDirectoryEntry(directory, {
      uuid: DOCUMENT,
      title: "Tagged",
      tags: getMeta(doc).tags,
    });
    retireTagCatalogEntry(catalog, AUTH);
    const resolved = [{ id: AUTH, name: "auth", state: "retired" }] as const;
    expect(getMeta(doc).tags).toEqual([AUTH]);
    expect(readDocumentTags(doc, catalog)).toEqual(resolved);
    expect(readDirectoryTags(getDirectoryEntry(directory, DOCUMENT)!, catalog))
      .toEqual(resolved);
  });

  it("validates a complete assignment before replacing provisional values", () => {
    const catalog = new Y.Doc();
    createTagCatalogEntry(catalog, "auth", AUTH);
    createTagCatalogEntry(catalog, "billing", BILLING);
    createTagCatalogEntry(catalog, "retired", RETIRED);
    retireTagCatalogEntry(catalog, RETIRED);
    const doc = document(["provisional"]);

    const before = Y.encodeStateAsUpdate(doc);
    expect(() => assignDocumentTags(doc, catalog, [AUTH, RETIRED, UNKNOWN]))
      .toThrow(InvalidTagAssignmentError);
    expect(Y.encodeStateAsUpdate(doc)).toEqual(before);

    // A valid identity-based write is a wholesale clean cut from old strings.
    assignDocumentTags(doc, catalog, [AUTH, BILLING, AUTH]);
    expect(getMeta(doc).tags).toEqual([AUTH, BILLING]);

    // Retirement after assignment permits keeping or removing that identity.
    retireTagCatalogEntry(catalog, BILLING);
    assignDocumentTags(doc, catalog, [BILLING, AUTH]);
    expect(getMeta(doc).tags).toEqual([BILLING, AUTH]);
    assignDocumentTags(doc, catalog, [AUTH]);
    expect(getMeta(doc).tags).toEqual([AUTH]);

    expect(() => assignDocumentTags(doc, catalog, [AUTH, BILLING])).toThrow(
      InvalidTagAssignmentError,
    );
    expect(getMeta(doc).tags).toEqual([AUTH]);
  });
});

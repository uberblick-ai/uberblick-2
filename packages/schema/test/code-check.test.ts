import { describe, expect, it } from "vitest";
import * as Y from "yjs";
import {
  appendBlock,
  directoryStubDiffers,
  documentDirectoryFields,
  editBlock,
  exportMarkdown,
  getBlocks,
  getDirectoryEntry,
  getDirectoryMap,
  getMeta,
  getMetaMap,
  initDoc,
  listDirectory,
  normalizeCodeCheck,
  restoreDirectoryEntry,
  setCodeCheck,
  setDescription,
  setKind,
  setTags,
  setTitle,
  tombstoneDirectoryEntry,
  upsertDirectoryEntry,
} from "../src/index.js";
import { replicaPair, syncDocs } from "./helpers.js";

const UUID = "11111111-1111-4111-8111-111111111111";
const COMMIT = "a".repeat(40);
const CHECK = { repository: "uberblick-ai/uberblick-2", commit: COMMIT, result: "matches" } as const;

function seeded(): Y.Doc {
  const doc = new Y.Doc();
  initDoc(doc, { uuid: UUID, title: "Code checks" });
  return doc;
}

describe("document code checks", () => {
  it("normalizes identities, stamps UTC and replaces only the named repository", () => {
    const doc = seeded();
    expect(getMeta(doc).code_check).toEqual([]);
    const before = Date.now();
    setCodeCheck(doc, CHECK);
    const initial = getMeta(doc).code_check?.[0];
    expect(initial).toMatchObject(CHECK);
    expect(Date.parse(initial?.checked_at ?? "")).toBeGreaterThanOrEqual(before);
    expect(Date.parse(initial?.checked_at ?? "")).toBeLessThanOrEqual(Date.now());
    expect(initial?.checked_at).toMatch(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/);
    setCodeCheck(doc, { repository: "another/project", commit: "b".repeat(64), result: "ahead" });
    const another = getMeta(doc).code_check?.[0];
    setCodeCheck(doc, { repository: "Uberblick-AI/Uberblick-2", commit: "C".repeat(40), result: "drift" });
    expect(getMeta(doc).code_check).toEqual([
      another,
      { repository: CHECK.repository, commit: "c".repeat(40), result: "drift", checked_at: expect.any(String) },
    ]);
    doc.destroy();
  });

  it.each([
    { ...CHECK, repository: "https://github.com/owner/repo" },
    { ...CHECK, repository: "owner/repo/" },
    { ...CHECK, repository: "owner/repo.git" },
    { ...CHECK, repository: " owner/repo" },
    { ...CHECK, repository: "owner/.." },
    { ...CHECK, repository: "owner/repo/other" },
    { ...CHECK, commit: "main" },
    { ...CHECK, commit: "abcdef0" },
    { ...CHECK, commit: "z".repeat(40) },
    { ...CHECK, result: "aligned" },
    { ...CHECK, checked_at: "2026-01-01T00:00:00.000Z" },
    null,
  ])("rejects a malformed or caller-stamped input %j", (value) => {
    expect(normalizeCodeCheck(value)).toBeNull();
  });

  it("preserves simultaneous first checks for different repositories after sync", () => {
    const [a, b] = replicaPair((doc) => initDoc(doc, { uuid: UUID, title: "Code checks" }));
    setCodeCheck(a, CHECK);
    setCodeCheck(b, { repository: "another/project", commit: "b".repeat(40), result: "ahead" });
    syncDocs(a, b);
    expect(getMeta(a).code_check?.map((check) => check.repository)).toEqual(["another/project", CHECK.repository]);
    expect(getMeta(b).code_check).toEqual(getMeta(a).code_check);
    a.destroy();
    b.destroy();
  });

  it("keeps checks unchanged through content and other metadata edits without exporting them", () => {
    const doc = seeded();
    const block = appendBlock(doc, { type: "paragraph", text: "Before" });
    setCodeCheck(doc, CHECK);
    const checks = getMeta(doc).code_check;
    editBlock(doc, block, "Before", "After");
    setTitle(doc, "Renamed");
    setDescription(doc, "Edited description");
    setTags(doc, ["changed"]);
    initDoc(doc, { uuid: UUID, title: "Reinitialized" });
    expect(getMeta(doc).code_check).toEqual(checks);
    expect(getBlocks(doc)).toMatchObject([{ text: "After" }]);
    expect(exportMarkdown(doc, { frontmatter: false })).toBe("After\n");
    expect(exportMarkdown(doc)).not.toContain("code_check");
    expect(exportMarkdown(doc)).not.toContain(CHECK.repository);
    doc.destroy();
  });

  it("refuses decision writes and hides any foreign check without changing storage", () => {
    const doc = seeded();
    setCodeCheck(doc, CHECK);
    setKind(doc, "decision");
    const before = getMetaMap(doc).toJSON();
    expect(() => setCodeCheck(doc, CHECK)).toThrow("Decision records");
    expect(getMeta(doc)).not.toHaveProperty("code_check");
    expect(getMetaMap(doc).toJSON()).toEqual(before);
    expect(documentDirectoryFields(doc)).not.toHaveProperty("code_check");
    doc.destroy();
  });
});

describe("directory code-check cache", () => {
  it("distinguishes unknown from known empty and detects each entry change on hydrated repair", () => {
    const doc = seeded();
    const directory = new Y.Doc();
    upsertDirectoryEntry(directory, { uuid: UUID, title: "Code checks" });
    expect(listDirectory(directory)[0]).not.toHaveProperty("code_check");
    expect(directoryStubDiffers(getDirectoryEntry(directory, UUID), getMeta(doc), documentDirectoryFields(doc))).toBe(true);
    upsertDirectoryEntry(directory, { uuid: UUID, title: "Code checks", ...documentDirectoryFields(doc) });
    expect(listDirectory(directory)[0]?.code_check).toEqual([]);
    expect(directoryStubDiffers(getDirectoryEntry(directory, UUID), getMeta(doc), documentDirectoryFields(doc))).toBe(false);
    setCodeCheck(doc, CHECK);
    expect(directoryStubDiffers(getDirectoryEntry(directory, UUID), getMeta(doc), documentDirectoryFields(doc))).toBe(true);
    upsertDirectoryEntry(directory, { uuid: UUID, title: "Code checks", ...documentDirectoryFields(doc) });
    const cached = getDirectoryEntry(directory, UUID);
    const check = getMeta(doc).code_check?.[0];
    expect(cached?.code_check).toEqual(getMeta(doc).code_check);
    expect(directoryStubDiffers(cached, getMeta(doc), documentDirectoryFields(doc))).toBe(false);
    if (check === undefined) throw new Error("Missing recorded check");
    for (const change of [
      { commit: "b".repeat(40) }, { result: "ahead" as const },
      { checked_at: "2026-01-01T00:00:00.000Z" }, { repository: "another/project" },
    ]) {
      expect(directoryStubDiffers(cached, getMeta(doc), { code_check: [{ ...check, ...change }] })).toBe(true);
    }
    doc.destroy();
    directory.destroy();
  });

  it("preserves caches through omitted writes, archive and restore and drops decision caches", () => {
    const doc = seeded();
    const directory = new Y.Doc();
    setCodeCheck(doc, CHECK);
    upsertDirectoryEntry(directory, { uuid: UUID, title: "Code checks", ...documentDirectoryFields(doc) });
    const checks = getMeta(doc).code_check;
    upsertDirectoryEntry(directory, { uuid: UUID, title: "Renamed" });
    tombstoneDirectoryEntry(directory, UUID);
    expect(getDirectoryEntry(directory, UUID)).toMatchObject({ deleted: true, code_check: checks });
    restoreDirectoryEntry(directory, UUID);
    expect(listDirectory(directory)[0]?.code_check).toEqual(checks);
    upsertDirectoryEntry(directory, { uuid: UUID, title: "Renamed", kind: "decision" });
    expect(getDirectoryEntry(directory, UUID)).not.toHaveProperty("code_check");
    getDirectoryMap(directory).set(UUID, { title: "Foreign decision", tags: [], kind: "decision", code_check: checks });
    expect(listDirectory(directory)[0]).not.toHaveProperty("code_check");
    doc.destroy();
    directory.destroy();
  });

  it("repairs an older writer's dropped cache without opening other rooms", () => {
    const doc = seeded();
    const directory = new Y.Doc();
    setCodeCheck(doc, CHECK);
    for (const unknown of [undefined, null, "not a cache"]) {
      getDirectoryMap(directory).set(UUID, { title: "Code checks", tags: [], code_check: unknown });
      expect(listDirectory(directory)[0]).not.toHaveProperty("code_check");
      expect(directoryStubDiffers(getDirectoryEntry(directory, UUID), getMeta(doc), documentDirectoryFields(doc))).toBe(true);
      upsertDirectoryEntry(directory, { uuid: UUID, title: "Code checks", ...documentDirectoryFields(doc) });
      expect(listDirectory(directory)[0]?.code_check).toEqual(getMeta(doc).code_check);
    }
    doc.destroy();
    directory.destroy();
  });
});

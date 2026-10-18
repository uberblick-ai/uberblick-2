import { describe, expect, it, vi } from "vitest";
import * as Y from "yjs";
import {
  createGroup,
  documentDirectoryFields,
  exportMarkdown,
  getDirectoryEntry,
  getDirectoryMap,
  getMeta,
  getMetaMap,
  initDoc,
  isDocId,
  listDeletedDirectoryUuids,
  listDirectory,
  readDecisions,
  readSidebar,
  readSyncedDocId,
  resolveDecisionTopics,
  setKind,
  upsertDirectoryEntry,
} from "../src/index.js";

const ALPHA = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const BETA = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const GAMMA = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";

describe("synced document identities", () => {
  it("accepts only canonical strings and warns once per rejected source and value", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    const invalid = [null, undefined, 42, {}, cyclic, "", "x/y", "..", ALPHA.toUpperCase(), "not-a-uuid"];
    try {
      expect(isDocId(ALPHA)).toBe(true);
      expect(isDocId("dddddddd-dddd-dddd-dddd-dddddddddddd")).toBe(true);
      expect(readSyncedDocId(ALPHA, "test boundary")).toBe(ALPHA);
      for (const value of invalid) {
        expect(isDocId(value)).toBe(false);
        expect(readSyncedDocId(value, "test boundary")).toBeNull();
        expect(readSyncedDocId(value, "test boundary")).toBeNull();
      }
      expect(warn).toHaveBeenCalledTimes(invalid.length);
    } finally {
      warn.mockRestore();
    }
  });

  it("skips malformed directory and deletion keys without mutating their stored entries", () => {
    const directory = new Y.Doc();
    const invalid = ["", "x/y", "..", ALPHA.toUpperCase(), "not-a-uuid"];
    for (const uuid of invalid) {
      getDirectoryMap(directory).set(uuid, { title: "Crafted decision", tags: [], kind: "decision", topic: BETA, status: "decided" });
      directory.getMap("deleted-docs").set(uuid, true);
    }
    upsertDirectoryEntry(directory, { uuid: ALPHA, title: "Page" });
    upsertDirectoryEntry(directory, { uuid: BETA, title: "Decision", kind: "decision", topic: BETA, status: "decided" });
    directory.getMap("deleted-docs").set(GAMMA, true);
    const before = Y.encodeStateAsUpdate(directory);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      for (let pass = 0; pass < 2; pass++) {
        expect(listDirectory(directory).map((entry) => entry.uuid)).toEqual([BETA, ALPHA]);
        expect(listDeletedDirectoryUuids(directory)).toEqual([GAMMA]);
        for (const uuid of invalid) expect(getDirectoryEntry(directory, uuid)).toBeNull();
        expect(resolveDecisionTopics(directory).map((topic) => topic.records.map((record) => record.uuid))).toEqual([[BETA]]);
      }
      expect(warn).toHaveBeenCalledTimes(invalid.length);
      expect(Y.encodeStateAsUpdate(directory)).toEqual(before);
    } finally {
      warn.mockRestore();
      directory.destroy();
    }
  });

  it("keeps valid pins and curated links while warning once for malformed ids", () => {
    const sidebar = new Y.Doc();
    const group = createGroup(sidebar, "Work");
    const document = new Y.Doc();
    initDoc(document, { uuid: ALPHA, title: "Page" });
    const invalid = ["", "x/y", "..", ALPHA.toUpperCase(), "not-a-uuid", null, 42];
    sidebar.getArray<unknown>(`pins:${group}`).insert(0, [
      { uuid: ALPHA, since: 0 },
      ...invalid.map((uuid) => ({ uuid, since: 0 })),
      { uuid: BETA, since: 0 },
    ]);
    getMetaMap(document).set("links", [BETA, ...invalid, BETA, GAMMA]);
    const before = Y.encodeStateAsUpdate(document);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      for (let pass = 0; pass < 2; pass++) {
        expect(readSidebar(sidebar)).toEqual([{ id: group, name: "Work", docs: [ALPHA, BETA] }]);
        expect(getMeta(document).links).toEqual([BETA, BETA, GAMMA]);
      }
      expect(warn).toHaveBeenCalledTimes(invalid.length * 2);
      expect(Y.encodeStateAsUpdate(document)).toEqual(before);
    } finally {
      warn.mockRestore();
      sidebar.destroy();
      document.destroy();
    }
  });

  it("uses room identity for caches, related decisions and exports while preserving hydration", () => {
    const doc = new Y.Doc();
    initDoc(doc, { uuid: BETA, title: "Page" });
    const directory = new Y.Doc();
    upsertDirectoryEntry(directory, { uuid: GAMMA, title: "Choice", kind: "decision", topic: GAMMA, governs: ALPHA, status: "decided" });
    expect(getMeta(doc, ALPHA).uuid).toBe(ALPHA);
    expect(readDecisions(doc, directory, ALPHA).map((topic) => topic.topic)).toEqual([GAMMA]);
    expect(exportMarkdown(doc, { uuid: ALPHA, directory })).toContain(`uuid: ${ALPHA}`);
    expect(exportMarkdown(doc, { uuid: ALPHA, directory })).toContain(GAMMA);

    setKind(doc, "decision");
    getMetaMap(doc).set("supersedes", ALPHA);
    expect(getMeta(doc, ALPHA)).toMatchObject({ uuid: ALPHA, topic: ALPHA });
    expect(getMeta(doc, ALPHA)).not.toHaveProperty("supersedes");
    expect(documentDirectoryFields(doc, ALPHA)).toMatchObject({ topic: ALPHA, supersedes: null });

    getMetaMap(doc).set("uuid", "");
    expect(getMeta(doc, ALPHA).uuid).toBe("");
    doc.destroy();
    directory.destroy();
  });
});

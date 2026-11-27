import { describe, expect, it } from "vitest";
import * as Y from "yjs";
import {
  InvalidDocumentLifecycleError,
  appendBlock,
  archiveDocument,
  createAnnotation,
  directoryStubDiffers,
  documentDirectoryFields,
  documentStubFields,
  getBlocks,
  getDirectoryEntry,
  getDirectoryMap,
  getMeta,
  getMetaMap,
  initDoc,
  listDirectory,
  repairDirectoryStub,
  restoreDirectoryEntry,
  restoreRevisionContent,
  setCodeCheck,
  setKind,
  setMemoryAgent,
  setMemoryRepository,
  setStatus,
  setTitle,
  snapshotRevision,
  upsertDirectoryEntry,
} from "../src/index.js";
import { syncDocs } from "./helpers.js";

const UUID = "11111111-1111-4111-8111-111111111111";
const REPAIR = { now: 100, changedAt: null, coarsenessMs: 1000 };

function memory(): Y.Doc {
  const doc = new Y.Doc();
  initDoc(doc, { uuid: UUID, title: "A useful lesson" });
  setKind(doc, "memory");
  return doc;
}

describe("memory metadata", () => {
  it("syncs optional scope independently and clears it back to a general memory", () => {
    const a = memory();
    const b = new Y.Doc();
    syncDocs(a, b);
    expect(getMeta(a)).toMatchObject({ kind: "memory" });
    expect(getMeta(a)).not.toHaveProperty("agent");
    expect(getMeta(a)).not.toHaveProperty("repository");

    setMemoryAgent(a, "a new rôle 42");
    setMemoryRepository(b, "Uberblick-AI/Uberblick-2");
    syncDocs(a, b);
    for (const doc of [a, b]) {
      expect(getMeta(doc)).toMatchObject({
        kind: "memory", agent: "a new rôle 42", repository: "uberblick-ai/uberblick-2",
      });
    }

    setMemoryAgent(a, " \t ");
    setMemoryRepository(b, "\n");
    syncDocs(a, b);
    for (const doc of [a, b]) {
      expect(getMeta(doc)).toMatchObject({ kind: "memory" });
      expect(getMeta(doc)).not.toHaveProperty("agent");
      expect(getMeta(doc)).not.toHaveProperty("repository");
      doc.destroy();
    }
  });

  it("refuses invalid scope and scope writes on other kinds before changing state", () => {
    const doc = memory();
    setMemoryAgent(doc, "reviewer");
    setMemoryRepository(doc, "owner/repo");
    const before = Y.encodeStateAsUpdate(doc);
    for (const agent of ["Reviewer", "réviseur É", "𝐀", "ǅ", " reviewer", "reviewer ", "\treviewer"]) {
      expect(() => setMemoryAgent(doc, agent), agent).toThrow();
      expect(Y.encodeStateAsUpdate(doc)).toEqual(before);
    }
    for (const repository of ["repo", "owner/repo/path", "https://github.com/owner/repo", "owner/repo.git", "owner/repo/", " owner/repo", "owner/repo "]) {
      expect(() => setMemoryRepository(doc, repository), repository).toThrow();
      expect(Y.encodeStateAsUpdate(doc)).toEqual(before);
    }
    for (const kind of ["", "decision"] as const) {
      setKind(doc, kind);
      const otherKind = Y.encodeStateAsUpdate(doc);
      expect(() => setMemoryAgent(doc, "reviewer")).toThrow();
      expect(() => setMemoryRepository(doc, "owner/repo")).toThrow();
      expect(Y.encodeStateAsUpdate(doc)).toEqual(otherKind);
      expect(getMeta(doc)).not.toHaveProperty("agent");
      expect(getMeta(doc)).not.toHaveProperty("repository");
    }
    doc.destroy();
  });

  it("has no status, including foreign stored statuses, and refuses setting one", () => {
    const doc = memory();
    const stored = getMetaMap(doc);
    for (const status of ["open", "decided", "rejected", "withdrawn"] as const) {
      const before = Y.encodeStateAsUpdate(doc);
      expect(() => setStatus(doc, status)).toThrow(InvalidDocumentLifecycleError);
      expect(Y.encodeStateAsUpdate(doc)).toEqual(before);
      stored.set("status", status);
      const foreign = Y.encodeStateAsUpdate(doc);
      expect(getMeta(doc)).toMatchObject({ kind: "memory" });
      expect(getMeta(doc)).not.toHaveProperty("status");
      expect(Y.encodeStateAsUpdate(doc)).toEqual(foreign);
    }
    setStatus(doc, "");
    expect(getMeta(doc)).toMatchObject({ kind: "memory" });
    expect(getMeta(doc)).not.toHaveProperty("status");
    doc.destroy();
  });

  it("reads malformed scope tolerantly and exposes scope only for memories", () => {
    const doc = memory();
    const stored = getMetaMap(doc);
    for (const [agent, repository] of [[42, []], ["Reviewer", "repo"], [" reviewer", "owner/repo/"], ["", ""]]) {
      stored.set("agent", agent);
      stored.set("repository", repository);
      const before = Y.encodeStateAsUpdate(doc);
      expect(getMeta(doc)).toMatchObject({ kind: "memory" });
      expect(getMeta(doc)).not.toHaveProperty("agent");
      expect(getMeta(doc)).not.toHaveProperty("repository");
      expect(Y.encodeStateAsUpdate(doc)).toEqual(before);
    }
    stored.set("agent", "reviewer");
    stored.set("repository", "OWNER/REPO");
    expect(getMeta(doc)).toMatchObject({ agent: "reviewer", repository: "owner/repo" });
    for (const kind of [undefined, "decision", "unknown"]) {
      stored.set("kind", kind);
      expect(getMeta(doc)).not.toHaveProperty("agent");
      expect(getMeta(doc)).not.toHaveProperty("repository");
    }
    doc.destroy();
  });

  it("restores revision content while keeping the current memory kind and scope", () => {
    const doc = memory();
    setMemoryAgent(doc, "implementer");
    setMemoryRepository(doc, "owner/first");
    appendBlock(doc, { type: "paragraph", text: "Earlier lesson." });
    const revision = new Y.Doc();
    Y.applyUpdate(revision, snapshotRevision(doc).state);

    setTitle(doc, "Revised title");
    appendBlock(doc, { type: "paragraph", text: "Later addition." });
    setMemoryAgent(doc, "reviewer");
    setMemoryRepository(doc, "owner/current");
    restoreRevisionContent(doc, revision);

    expect(getMeta(doc)).toMatchObject({
      title: "A useful lesson", kind: "memory", agent: "reviewer", repository: "owner/current",
    });
    expect(getMeta(doc)).not.toHaveProperty("status");
    expect(getBlocks(doc).map((block) => block.text)).toEqual(["Earlier lesson."]);
    doc.destroy();
    revision.destroy();
  });
});

describe("memory directory entries", () => {
  it("carries scope through cache rewrites, sync, archive and restore", () => {
    const doc = memory();
    setMemoryAgent(doc, "implementer");
    setMemoryRepository(doc, "owner/repo");
    const directory = new Y.Doc();
    const replica = new Y.Doc();
    const sidebar = new Y.Doc();
    repairDirectoryStub(doc, directory, UUID, REPAIR);
    upsertDirectoryEntry(directory, { uuid: UUID, title: "Renamed", tags: ["lesson"] });
    syncDocs(directory, replica);
    const expected = { kind: "memory", agent: "implementer", repository: "owner/repo", title: "Renamed" };
    expect(getDirectoryEntry(replica, UUID)).toMatchObject(expected);
    expect(archiveDocument(directory, sidebar, UUID)).toEqual([UUID]);
    syncDocs(directory, replica);
    expect(listDirectory(replica)).toEqual([]);
    expect(listDirectory(replica, { includeDeleted: true })[0]).toMatchObject({ ...expected, deleted: true });
    restoreDirectoryEntry(replica, UUID);
    syncDocs(directory, replica);
    expect(listDirectory(directory)[0]).toMatchObject(expected);
    expect(getMeta(doc)).toMatchObject({ kind: "memory", agent: "implementer", repository: "owner/repo" });
    for (const current of [doc, directory, replica, sidebar]) current.destroy();
  });

  it("rejects invalid directory scope before any metadata or timestamp write", () => {
    const directory = new Y.Doc();
    upsertDirectoryEntry(directory, { uuid: UUID, title: "Lesson", kind: "memory", agent: "reviewer", repository: "owner/repo" });
    const before = Y.encodeStateAsUpdate(directory);
    for (const scope of [{ agent: "Reviewer" }, { agent: " reviewer" }, { repository: "owner/repo/" }, { repository: "https://github.com/owner/repo" }]) {
      expect(() => upsertDirectoryEntry(directory, {
        uuid: UUID, title: "Changed", updatedAt: 100, ...scope,
      })).toThrow();
      expect(Y.encodeStateAsUpdate(directory)).toEqual(before);
    }
    directory.destroy();
  });

  it("gates foreign cached scope by kind and ignores a memory's stored status without writes", () => {
    const directory = new Y.Doc();
    for (const kind of ["memory", "decision", undefined]) {
      getDirectoryMap(directory).set(UUID, { title: "Lesson", tags: [], kind, status: "open", agent: "reviewer", repository: "OWNER/REPO" });
      const before = Y.encodeStateAsUpdate(directory);
      const entry = getDirectoryEntry(directory, UUID);
      if (kind === "memory") {
        expect(entry).toMatchObject({ kind, agent: "reviewer", repository: "owner/repo" });
        expect(entry).not.toHaveProperty("status");
      } else {
        expect(entry).not.toHaveProperty("agent");
        expect(entry).not.toHaveProperty("repository");
      }
      expect(Y.encodeStateAsUpdate(directory)).toEqual(before);
    }
    directory.destroy();
  });

  it("repairs changes and deliberate clears of either scope and clears both on a kind change", () => {
    const doc = memory();
    const directory = new Y.Doc();
    setMemoryAgent(doc, "implementer");
    setMemoryRepository(doc, "owner/first");
    repairDirectoryStub(doc, directory, UUID, REPAIR);
    setMemoryAgent(doc, "reviewer");
    setMemoryRepository(doc, "owner/current");
    expect(directoryStubDiffers(getDirectoryEntry(directory, UUID), getMeta(doc), documentDirectoryFields(doc))).toBe(true);
    repairDirectoryStub(doc, directory, UUID, REPAIR);
    expect(getDirectoryEntry(directory, UUID)).toMatchObject({ agent: "reviewer", repository: "owner/current" });

    setMemoryAgent(doc, "");
    repairDirectoryStub(doc, directory, UUID, REPAIR);
    expect(getDirectoryEntry(directory, UUID)).not.toHaveProperty("agent");
    expect(getDirectoryEntry(directory, UUID)).toMatchObject({ repository: "owner/current" });
    setMemoryRepository(doc, "");
    repairDirectoryStub(doc, directory, UUID, REPAIR);
    expect(getDirectoryEntry(directory, UUID)).not.toHaveProperty("repository");
    setMemoryAgent(doc, "reviewer");
    setMemoryRepository(doc, "owner/repo");
    repairDirectoryStub(doc, directory, UUID, REPAIR);
    setKind(doc, "");
    repairDirectoryStub(doc, directory, UUID, REPAIR);
    const regular = getDirectoryEntry(directory, UUID);
    expect(regular).not.toHaveProperty("kind");
    expect(regular).not.toHaveProperty("agent");
    expect(regular).not.toHaveProperty("repository");
    expect(getDirectoryMap(directory).get(UUID)).not.toHaveProperty("agent");
    expect(getDirectoryMap(directory).get(UUID)).not.toHaveProperty("repository");
    doc.destroy();
    directory.destroy();
  });

  it("repairs a legacy whole-entry rewrite and retains the regular caches needed for convergence", () => {
    const doc = memory();
    const directory = new Y.Doc();
    setMemoryAgent(doc, "reviewer");
    setMemoryRepository(doc, "owner/repo");
    const block = appendBlock(doc, { type: "paragraph", text: "Watch for this failure." });
    createAnnotation(doc, block, 0, 5, "reviewer", "Still relevant.");
    setCodeCheck(doc, { repository: "owner/repo", commit: "a".repeat(40), result: "matches" });
    const fields = documentDirectoryFields(doc);
    repairDirectoryStub(doc, directory, UUID, REPAIR);
    expect(getDirectoryEntry(directory, UUID)).toMatchObject({ openThreadCount: 1, code_check: getMeta(doc).code_check });

    // A pre-kind client replaces the whole row with its regular-document view.
    getDirectoryMap(directory).set(UUID, {
      title: getMeta(doc).title, tags: [], createdAt: 100,
      openThreadCount: fields.openThreadCount, code_check: fields.code_check,
    });
    expect(getDirectoryEntry(directory, UUID)).not.toHaveProperty("kind");
    repairDirectoryStub(doc, directory, UUID, REPAIR);
    const repaired = getDirectoryEntry(directory, UUID);
    expect(repaired).toMatchObject({ kind: "memory", agent: "reviewer", repository: "owner/repo" });
    expect(directoryStubDiffers(repaired, getMeta(doc), fields)).toBe(false);

    // The older client's projection still has every regular-document cache.
    const { kind: _kind, agent: _agent, repository: _repository, ...oldView } = repaired!;
    const { kind: _metaKind, agent: _metaAgent, repository: _metaRepository, ...oldMeta } = getMeta(doc);
    expect(directoryStubDiffers(oldView, oldMeta, fields)).toBe(false);
    const before = Y.encodeStateAsUpdate(directory);
    repairDirectoryStub(doc, directory, UUID, REPAIR);
    expect(Y.encodeStateAsUpdate(directory)).toEqual(before);
    expect(documentStubFields(doc)).toMatchObject({
      kind: "memory", agent: "reviewer", repository: "owner/repo", openThreadCount: 1,
    });

    getDirectoryMap(directory).set(UUID, { ...oldView, deleted: true });
    repairDirectoryStub(doc, directory, UUID, REPAIR);
    expect(listDirectory(directory)).toEqual([]);
    expect(getDirectoryEntry(directory, UUID)).toMatchObject({
      kind: "memory", agent: "reviewer", repository: "owner/repo", deleted: true,
    });
    restoreDirectoryEntry(directory, UUID);
    expect(listDirectory(directory)[0]).toMatchObject({
      kind: "memory", agent: "reviewer", repository: "owner/repo",
    });
    doc.destroy();
    directory.destroy();
  });
});

// @vitest-environment node
/**
 * `updatedAt` on the directory stub, written by a web client.
 *
 * The shared schema suite defends the repair and stamp rules. This suite
 * defends the web's attachment, local-versus-peer authorship and write gate.
 *
 * Every assertion is read off a **peer** replica of the `_directory` room, and
 * the volume assertions count the updates that actually crossed to it. What
 * this client believes locally is not the thing at stake — what the workspace is
 * made to carry is.
 *
 * The clock is faked (`toFake: ["Date"]`) and the timers are not: a window is
 * crossed by moving the clock, never by shrinking the window to something
 * untrue.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as Y from "yjs";
import {
  appendBlock,
  addComment,
  createAnnotation,
  getDirectoryEntry,
  getDirectoryMap,
  initDoc,
  setAnnotationResolved,
  setDescription,
  setKind,
  setStatus,
  setTitle,
  tombstoneDirectoryEntry,
  upsertDirectoryEntry,
  UPDATED_AT_COARSENESS_MS,
} from "@uberblick/schema";
import { watchDocumentStub } from "../src/collab/directory-stub.js";

/** Midnight of a day that is not now, so a real clock could never pass for it. */
const T0 = Date.UTC(2031, 0, 1, 0, 0, 0);
const WINDOW = UPDATED_AT_COARSENESS_MS;
const UUID = "b4e6f1c2-9d3a-4f57-8c21-5e0a7b9d4c31";

/** A second client holding the same document: updates flow both ways. */
function peerOf(local: Y.Doc): Y.Doc {
  const peer = new Y.Doc();
  Y.applyUpdate(peer, Y.encodeStateAsUpdate(local));
  local.on("update", (update: Uint8Array) => Y.applyUpdate(peer, update));
  peer.on("update", (update: Uint8Array) => Y.applyUpdate(local, update));
  return peer;
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(T0);
});

afterEach(() => {
  vi.useRealTimers();
});

describe("directory stamps from the web", () => {
  it("repairs only the room's stub when metadata claims another document", () => {
    const other = "b5ae329f-d53d-44b2-829f-fb180c00aaca";
    const document = new Y.Doc();
    const directory = new Y.Doc();
    upsertDirectoryEntry(directory, { uuid: other, title: "Other document" });
    const otherBefore = getDirectoryEntry(directory, other);
    const stop = watchDocumentStub(document, directory, UUID);
    try {
      expect(getDirectoryEntry(directory, UUID)).toBeNull();
      initDoc(document, { uuid: other, title: "This room's document" });
      expect(getDirectoryEntry(directory, UUID)?.title).toBe("This room's document");
      setTitle(document, "Edited here");
      expect(getDirectoryEntry(directory, UUID)?.title).toBe("Edited here");
      expect(getDirectoryEntry(directory, other)).toEqual(otherBefore);
      expect([...getDirectoryMap(directory).keys()].sort()).toEqual([UUID, other].sort());
    } finally {
      stop();
      document.destroy();
      directory.destroy();
    }
  });

  it("backfills known counts on attach and hydration, then repairs peer thread changes without stamping", () => {
    const source = new Y.Doc();
    initDoc(source, { uuid: UUID, title: "Existing comments" });
    const block = appendBlock(source, { type: "paragraph", text: "open done" });
    const open = createAnnotation(source, block, 0, 4, "Author", "Open");
    const resolved = createAnnotation(source, block, 5, 9, "Author", "Done");
    setAnnotationResolved(source, resolved.id, true);

    for (const hydrate of [false, true]) {
      const doc = new Y.Doc();
      if (!hydrate) Y.applyUpdate(doc, Y.encodeStateAsUpdate(source));
      const directory = new Y.Doc();
      upsertDirectoryEntry(directory, {
        uuid: UUID, title: "Existing comments", createdAt: T0, updatedAt: T0,
      });
      const peer = peerOf(directory);
      const stop = watchDocumentStub(doc, directory, UUID);
      try {
        vi.setSystemTime(T0 + WINDOW * 3);
        if (hydrate) Y.applyUpdate(doc, Y.encodeStateAsUpdate(source));
        expect(getDirectoryEntry(peer, UUID)).toMatchObject({
          openThreadCount: 1, createdAt: T0, updatedAt: T0,
        });

        const remote = peerOf(doc);
        const added = createAnnotation(remote, block, 4, 5, "Reviewer", "New");
        expect(getDirectoryEntry(peer, UUID)?.openThreadCount).toBe(2);
        addComment(remote, added.id, "Author", "Reply");
        expect(getDirectoryEntry(peer, UUID)?.openThreadCount).toBe(2);
        setAnnotationResolved(remote, open.id, true);
        expect(getDirectoryEntry(peer, UUID)?.openThreadCount).toBe(1);
        setAnnotationResolved(remote, open.id, false);
        expect(getDirectoryEntry(peer, UUID)).toMatchObject({
          openThreadCount: 2, createdAt: T0, updatedAt: T0,
        });
      } finally {
        stop();
      }
    }
  });

  it("defers stub repair and its authored stamp until the directory is writable", () => {
    const doc = new Y.Doc();
    initDoc(doc, { uuid: UUID, title: "Before" });
    const directory = new Y.Doc();
    upsertDirectoryEntry(directory, {
      uuid: UUID,
      title: "Stale",
      updatedAt: T0,
    });
    let writable = false;
    const listeners = new Set<() => void>();
    const stop = watchDocumentStub(doc, directory, UUID, {
      writable: () => writable,
      synchronized: () => true,
      subscribe: (listener) => {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
    });

    vi.setSystemTime(T0 + 1_000);
    setTitle(doc, "After");
    expect(getDirectoryEntry(directory, UUID)?.title).toBe("Stale");
    expect(getDirectoryEntry(directory, UUID)?.createdAt).toBeUndefined();

    vi.setSystemTime(T0 + 5_000);
    writable = true;
    for (const listener of listeners) listener();
    expect(getDirectoryEntry(directory, UUID)).toMatchObject({
      title: "After",
      createdAt: T0 + 5_000,
      updatedAt: T0 + 1_000,
    });
    stop();
  });

  it("waits for directory sync before repairing a missing stub", () => {
    const converge = (browserClientId: number, archiverClientId: number): void => {
      const doc = new Y.Doc();
      initDoc(doc, { uuid: UUID, title: "Archived elsewhere" });

      const archived = new Y.Doc();
      archived.clientID = archiverClientId;
      upsertDirectoryEntry(archived, {
        uuid: UUID,
        title: "Archived elsewhere",
      });
      tombstoneDirectoryEntry(archived, UUID);

      const browser = new Y.Doc();
      browser.clientID = browserClientId;
      let synchronized = false;
      const listeners = new Set<() => void>();
      const stop = watchDocumentStub(doc, browser, UUID, {
        // Admission precedes the first sync, which is the race this guards.
        writable: () => true,
        synchronized: () => synchronized,
        subscribe: (listener) => {
          listeners.add(listener);
          return () => listeners.delete(listener);
        },
      });

      expect(getDirectoryEntry(browser, UUID)).toBeNull();
      Y.applyUpdate(browser, Y.encodeStateAsUpdate(archived));
      synchronized = true;
      for (const listener of listeners) listener();
      Y.applyUpdate(archived, Y.encodeStateAsUpdate(browser));

      expect(getDirectoryEntry(browser, UUID)?.deleted).toBe(true);
      expect(getDirectoryEntry(archived, UUID)?.deleted).toBe(true);
      stop();
    };

    // Concurrent whole-entry writes resolve by client id. No repair is
    // allowed before hydration, so the tombstone wins in either ordering.
    converge(2, 3);
    converge(3, 2);
  });

  it("publishes an absent stub once the directory has synchronized", () => {
    const doc = new Y.Doc();
    initDoc(doc, { uuid: UUID, title: "Publish after sync" });
    const directory = new Y.Doc();
    let synchronized = false;
    const listeners = new Set<() => void>();
    const stop = watchDocumentStub(doc, directory, UUID, {
      writable: () => true,
      synchronized: () => synchronized,
      subscribe: (listener) => {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
    });

    expect(getDirectoryEntry(directory, UUID)).toBeNull();
    synchronized = true;
    for (const listener of listeners) listener();
    expect(getDirectoryEntry(directory, UUID)).toEqual({
      uuid: UUID,
      title: "Publish after sync",
      tags: [],
      openThreadCount: 0,
      code_check: [],
      createdAt: T0,
    });
    stop();
  });

  it("bumps nothing when a document is opened, hydrated or edited elsewhere", () => {
    // The shape of an open: the room's Y.Doc is empty when the watcher attaches
    // and the content arrives afterwards from the server.
    const source = new Y.Doc();
    initDoc(source, { uuid: UUID, title: "Arrived" });
    appendBlock(source, { type: "paragraph", text: "written elsewhere" });

    const doc = new Y.Doc();
    const directory = new Y.Doc();
    upsertDirectoryEntry(directory, {
      uuid: UUID,
      title: "Arrived",
      openThreadCount: 0,
      code_check: [],
      createdAt: T0,
      updatedAt: T0,
    });
    const peer = peerOf(directory);
    let crossed = 0;
    peer.on("update", () => {
      crossed += 1;
    });
    const stop = watchDocumentStub(doc, directory, UUID);

    vi.setSystemTime(T0 + WINDOW * 3);
    Y.applyUpdate(doc, Y.encodeStateAsUpdate(source));
    // A peer's edit, arriving over the same channel long after the window: that
    // peer stamps for itself, and reading it here is not a change.
    appendBlock(source, { type: "paragraph", text: "and again" });
    Y.applyUpdate(doc, Y.encodeStateAsUpdate(source));

    expect(getDirectoryEntry(peer, UUID)).toMatchObject({
      title: "Arrived",
      createdAt: T0,
      updatedAt: T0,
    });
    expect(crossed).toBe(0);
    stop();
  });

  it("repairs description alone on attach and arrived updates without stamping", () => {
    const doc = new Y.Doc();
    initDoc(doc, {
      uuid: UUID,
      title: "Described",
      description: "Current description",
    });
    const directory = new Y.Doc();
    upsertDirectoryEntry(directory, {
      uuid: UUID,
      title: "Described",
      description: "Stale description",
      createdAt: T0,
      updatedAt: T0,
    });
    const peer = peerOf(directory);
    let crossed = 0;
    peer.on("update", () => {
      crossed += 1;
    });
    vi.setSystemTime(T0 + WINDOW * 3);
    const stop = watchDocumentStub(doc, directory, UUID);

    expect(getDirectoryEntry(peer, UUID)).toMatchObject({
      description: "Current description",
      createdAt: T0,
      updatedAt: T0,
    });
    expect(crossed).toBe(1);

    const remote = peerOf(doc);
    setDescription(remote, "Arrived description");
    expect(getDirectoryEntry(peer, UUID)).toMatchObject({
      description: "Arrived description",
      createdAt: T0,
      updatedAt: T0,
    });
    expect(crossed).toBe(2);

    setDescription(remote, "");
    expect(getDirectoryEntry(peer, UUID)?.description).toBeUndefined();
    expect(getDirectoryEntry(peer, UUID)?.updatedAt).toBe(T0);
    expect(crossed).toBe(3);

    // Blank and absent agree, so observing content writes publishes nothing.
    appendBlock(remote, { type: "paragraph", text: "Arrived content" });
    expect(crossed).toBe(3);
    stop();
  });

  it("repairs and clears lifecycle metadata on attach and later remote updates", () => {
    const doc = new Y.Doc();
    initDoc(doc, { uuid: UUID, title: "Lifecycle" });
    setKind(doc, "decision");
    setStatus(doc, "open");

    const directory = new Y.Doc();
    upsertDirectoryEntry(directory, {
      uuid: UUID,
      title: "Lifecycle",
      updatedAt: T0,
    });
    const directoryPeer = peerOf(directory);
    const stop = watchDocumentStub(doc, directory, UUID);
    expect(getDirectoryEntry(directoryPeer, UUID)).toMatchObject({
      kind: "decision",
      status: "open",
      updatedAt: T0,
    });

    const remote = peerOf(doc);
    vi.setSystemTime(T0 + 1_000);
    setKind(remote, "");
    const repaired = getDirectoryEntry(directoryPeer, UUID);
    expect(repaired?.kind).toBeUndefined();
    expect(repaired?.status).toBeUndefined();
    // Repairing a cache from an update authored elsewhere is not a document
    // change and must not claim a new updatedAt.
    expect(repaired?.updatedAt).toBe(T0);
    stop();
  });

});

/**
 * `updatedAt` on the directory stub, written by a web client (#257).
 *
 * What this suite defends is the bargain, the same one
 * `packages/mcp-server/test/timestamps.test.ts` defends for the server: the
 * directory is broadcast to every client in the workspace, so a stamp per
 * keystroke would turn one person typing into traffic for everyone. The
 * contract is "at most one bump per window, immediately on a title or tag
 * change, and never for merely opening or receiving a document".
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
  editBlock,
  getDirectoryEntry,
  initDoc,
  setTags,
  setTitle,
  upsertDirectoryEntry,
} from "@uberblick/schema";
import type { DirectoryEntry } from "@uberblick/schema";
import {
  UPDATED_AT_COARSENESS_MS,
  watchDocumentStub,
} from "../src/collab/directory-stub.js";

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

interface Rig {
  /** The document this client has open. */
  doc: Y.Doc;
  /** Another client's copy of the directory — what the workspace sees. */
  peer: Y.Doc;
  /** Directory updates that have reached the peer since the watcher attached. */
  crossed: () => number;
  stop: () => void;
}

/**
 * A client with `title` open, whose stub the workspace already carries, stamped
 * at T0 — the steady state every question here is asked from.
 */
function open(title: string, options: { stub?: string } = {}): Rig {
  const doc = new Y.Doc();
  initDoc(doc, { uuid: UUID, title });
  const directory = new Y.Doc();
  upsertDirectoryEntry(directory, {
    uuid: UUID,
    title: options.stub ?? title,
    createdAt: T0,
    updatedAt: T0,
  });
  const peer = peerOf(directory);
  let crossed = 0;
  peer.on("update", () => {
    crossed += 1;
  });
  return {
    doc,
    peer,
    crossed: () => crossed,
    stop: watchDocumentStub(doc, directory),
  };
}

function stub(rig: Rig): DirectoryEntry {
  const entry = getDirectoryEntry(rig.peer, UUID);
  if (entry === null) throw new Error(`no directory entry for ${UUID}`);
  return entry;
}

/** One keystroke's worth of writing, through the same schema op the editor uses. */
function type(rig: Rig, id: string, before: string, after: string): void {
  editBlock(rig.doc, id, before, after);
}

const rigs: Rig[] = [];

function rig(...args: Parameters<typeof open>): Rig {
  const created = open(...args);
  rigs.push(created);
  return created;
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(T0);
});

afterEach(() => {
  for (const created of rigs.splice(0)) created.stop();
  vi.useRealTimers();
});

describe("directory stamps from the web", () => {
  it("bumps updatedAt at most once per window under a typing burst", () => {
    const client = rig("Burst");
    vi.setSystemTime(T0 + 500);
    const block = appendBlock(client.doc, { type: "paragraph", text: "" });
    // A block appended inside the stamped window is still inside it: no write.
    expect(client.crossed()).toBe(0);

    // Twenty edits spread over twenty seconds — a plausible minute of someone
    // writing — all inside the first window.
    let text = "";
    for (let index = 0; index < 20; index += 1) {
      vi.setSystemTime(T0 + 1_000 + index * 1_000);
      const next = `${text}x`;
      type(client, block, text, next);
      text = next;
    }
    expect(stub(client).updatedAt).toBe(T0);
    // The point of the coarseness: the whole burst cost the workspace nothing.
    expect(client.crossed()).toBe(0);

    // The first edit past the window stamps, and one more inside the new window
    // does not.
    vi.setSystemTime(T0 + WINDOW);
    type(client, block, text, `${text}y`);
    text = `${text}y`;
    expect(stub(client).updatedAt).toBe(T0 + WINDOW);
    expect(client.crossed()).toBe(1);

    vi.setSystemTime(T0 + WINDOW + 1_000);
    type(client, block, text, `${text}z`);
    expect(stub(client).updatedAt).toBe(T0 + WINDOW);
    expect(client.crossed()).toBe(1);

    // Created-at is a fact about the document, not a moving stamp.
    expect(stub(client).createdAt).toBe(T0);
  });

  it("bumps nothing when a document is opened, hydrated or edited elsewhere", () => {
    // The shape of an open: the room's Y.Doc is empty when the watcher attaches
    // and the content arrives afterwards, from IndexedDB or from the hub.
    const source = new Y.Doc();
    initDoc(source, { uuid: UUID, title: "Arrived" });
    appendBlock(source, { type: "paragraph", text: "written elsewhere" });

    const doc = new Y.Doc();
    const directory = new Y.Doc();
    upsertDirectoryEntry(directory, {
      uuid: UUID,
      title: "Arrived",
      createdAt: T0,
      updatedAt: T0,
    });
    const peer = peerOf(directory);
    let crossed = 0;
    peer.on("update", () => {
      crossed += 1;
    });
    const stop = watchDocumentStub(doc, directory);

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

  it("bumps updatedAt immediately on a title change", () => {
    const client = rig("Before");

    vi.setSystemTime(T0 + 1_000);
    setTitle(client.doc, "After");
    expect(stub(client)).toMatchObject({
      title: "After",
      createdAt: T0,
      updatedAt: T0 + 1_000,
    });
  });

  it("bumps updatedAt immediately on a tag change", () => {
    const client = rig("Retagged");

    vi.setSystemTime(T0 + 1_000);
    setTags(client.doc, ["reference"]);
    expect(stub(client)).toMatchObject({
      tags: ["reference"],
      updatedAt: T0 + 1_000,
    });
  });

  it("repairs a stub that disagrees with the document on connect, without stamping", () => {
    // `meta.title` in the document is authoritative and the stub is a cache, so
    // opening the document republishes the title — but catching a cache up is
    // not the document changing, and must not claim it changed now.
    vi.setSystemTime(T0 + WINDOW * 3);
    const client = rig("Authoritative", { stub: "Stale" });

    expect(stub(client)).toMatchObject({
      title: "Authoritative",
      createdAt: T0,
      updatedAt: T0,
    });
  });

  it("converges last-write-wins when a second replica stamps the same entry", () => {
    // Two writers on one cache-quality field, no arbitration and no new
    // mechanism: entries are whole-object writes, so the winner is whichever
    // update Yjs orders last — not the later wall-clock reading.
    const web = new Y.Doc();
    upsertDirectoryEntry(web, { uuid: UUID, title: "Shared", createdAt: T0 });
    const mcp = new Y.Doc();
    Y.applyUpdate(mcp, Y.encodeStateAsUpdate(web));

    upsertDirectoryEntry(web, { uuid: UUID, title: "Shared", updatedAt: T0 + 2_000 });
    upsertDirectoryEntry(mcp, { uuid: UUID, title: "Shared", updatedAt: T0 + 1_000 });

    Y.applyUpdate(web, Y.encodeStateAsUpdate(mcp));
    Y.applyUpdate(mcp, Y.encodeStateAsUpdate(web));

    const settled = getDirectoryEntry(web, UUID);
    expect(getDirectoryEntry(mcp, UUID)).toEqual(settled);
    expect([T0 + 1_000, T0 + 2_000]).toContain(settled?.updatedAt);
  });
});

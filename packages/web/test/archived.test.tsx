/**
 * Archived documents in the web UI (#146).
 *
 * One story, because the feature is one claim told three ways: **the directory
 * stub is the only source of archived-ness, and the pane follows it live.**
 * Everything asserted here hangs off that — a deep link to a document that was
 * already tombstoned, a tombstone arriving under an open pane, and the restore
 * that lifts it — so they are one test over one mounted app rather than three
 * mounts of three pieces.
 *
 * The archive and the restore travel as Yjs updates between two directory
 * documents, which is what makes this a claim about *sync* rather than about a
 * React prop: nothing in the app is told the document was archived, it observes
 * the same map `list_docs` and `archive_doc` read. A second client is the only
 * honest way to write that, since a tombstone the app itself wrote would prove
 * only that the app can re-render its own state.
 *
 * Deliberately not here: that ProseMirror's `editable=false` really turns away
 * a keystroke, a paste and a drop. That is ProseMirror's own contract, tested
 * by ProseMirror, and jsdom cannot dispatch the input events that would
 * exercise it anyway — what this pins is that the app *sets* it, and unsets it
 * again, and that no chrome remains that would write around it.
 *
 * `acquireRoom` is mocked: rooms here are plain shared Y.Docs, because the
 * transport is not what is under test (see `reconnect.test.ts` for that).
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot } from "react-dom/client";
import type { Root } from "react-dom/client";
import * as Y from "yjs";
import {
  appendBlock,
  directoryRoom,
  getDirectoryEntry,
  initDoc,
  listDirectory,
  roomForDoc,
  tombstoneDirectoryEntry,
  upsertDirectoryEntry,
} from "@uberblick/schema";
import type { RoomConnection, RoomStatus } from "../src/collab/rooms.js";

const WORKSPACE = "main";
const UUID = "b4e6f1c2-9d3a-4f57-8c21-5e0a7b9d4c31";

const OFFLINE: RoomStatus = {
  connected: false,
  synced: false,
  unsyncedChanges: 0,
  localReplicaLoaded: false,
};

/**
 * The rooms this test's app joins, one shared Y.Doc each — so the test can hold
 * the very document the app holds, exactly as two tabs of the real client do.
 */
const rooms = new Map<string, RoomConnection>();

function room(name: string): RoomConnection {
  const existing = rooms.get(name);
  if (existing !== undefined) return existing;
  const connection = {
    room: name,
    ydoc: new Y.Doc(),
    provider: { awareness: null },
    status: OFFLINE,
    onStatusChange: (listener: (next: RoomStatus) => void) => {
      listener(OFFLINE);
      return () => {};
    },
    whenLocalReplicaLoaded: Promise.resolve(),
  } as unknown as RoomConnection;
  rooms.set(name, connection);
  return connection;
}

vi.mock("../src/collab/rooms.js", () => ({
  acquireRoom: (name: string) => ({ connection: room(name), release: () => {} }),
}));

const { App } = await import("../src/ui/App.js");

/** A second client holding the same directory: updates flow both ways. */
function peerDirectory(local: Y.Doc): Y.Doc {
  const peer = new Y.Doc();
  Y.applyUpdate(peer, Y.encodeStateAsUpdate(local));
  local.on("update", (update: Uint8Array) => Y.applyUpdate(peer, update));
  peer.on("update", (update: Uint8Array) => Y.applyUpdate(local, update));
  return peer;
}

let mounted: { root: Root; host: HTMLElement } | null = null;

afterEach(() => {
  const open = mounted;
  mounted = null;
  if (open !== null) {
    act(() => open.root.unmount());
    open.host.remove();
  }
  rooms.clear();
});

function openApp(path: string): HTMLElement {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
    true;
  window.history.replaceState(null, "", path);
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  mounted = { root, host };
  act(() => root.render(<App />));
  return host;
}

/** The bound editor's own element, or null when nothing is bound. */
function prose(host: HTMLElement): HTMLElement | null {
  return host.querySelector(".ub-editor .ProseMirror");
}

function banner(host: HTMLElement): HTMLElement | null {
  return host.querySelector(".ub-archived-banner");
}

function restoreButton(host: HTMLElement): HTMLButtonElement | null {
  return host.querySelector(".ub-archived-banner button");
}

describe("an archived document is readable, says so, and offers one way back", () => {
  it("follows the directory tombstone in both directions, under an open pane", () => {
    const directory = room(directoryRoom(WORKSPACE)).ydoc;
    const ydoc = room(roomForDoc(WORKSPACE, UUID)).ydoc;
    initDoc(ydoc, { uuid: UUID, title: "Retired protocol" });
    appendBlock(ydoc, { type: "paragraph", text: "still every byte of it" });
    upsertDirectoryEntry(directory, { uuid: UUID, title: "Retired protocol" });

    const peer = peerDirectory(directory);
    // Archived before anyone opens the link — the deep-link case.
    tombstoneDirectoryEntry(peer, UUID);

    const host = openApp(`/${WORKSPACE}/${UUID}`);

    // ---- the deep link says what it opened ----
    expect(banner(host)?.textContent).toContain("Archived");
    expect(restoreButton(host)?.textContent).toBe("Restore");
    // The document itself is here and rendered: archiving is a tombstone on the
    // stub, not a deletion, and hiding the content would be a different feature.
    expect(prose(host)?.textContent).toContain("still every byte of it");
    // Read-only, and no chrome left that would write around it.
    expect(prose(host)?.getAttribute("contenteditable")).toBe("false");
    expect(host.querySelector<HTMLInputElement>(".ub-title")?.readOnly).toBe(true);
    expect(host.querySelector(".ub-gutter-add")).toBeNull();

    // ---- Restore is the one action, and it is a real restore ----
    act(() => restoreButton(host)?.click());
    expect(banner(host)).toBeNull();
    expect(prose(host)?.getAttribute("contenteditable")).toBe("true");
    expect(host.querySelector<HTMLInputElement>(".ub-title")?.readOnly).toBe(false);
    expect(host.querySelector(".ub-gutter-add")).not.toBeNull();
    // Lifted on the *other* client too, which is what "reappears in listings"
    // means: the second replica lists it again without asking for it.
    expect(getDirectoryEntry(peer, UUID)?.deleted).toBeUndefined();
    expect(listDirectory(peer).map((entry) => entry.uuid)).toEqual([UUID]);

    // ---- and it flips live when someone else archives it ----
    // No remount, no reload: the same editor element goes read-only in place.
    const bound = prose(host);
    act(() => tombstoneDirectoryEntry(peer, UUID));
    expect(banner(host)).not.toBeNull();
    expect(prose(host)).toBe(bound);
    expect(bound?.getAttribute("contenteditable")).toBe("false");
    expect(host.querySelector(".ub-gutter-add")).toBeNull();
  });
});

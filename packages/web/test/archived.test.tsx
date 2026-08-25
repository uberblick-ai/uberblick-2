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

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot } from "react-dom/client";
import type { Root } from "react-dom/client";
import type { ReactNode } from "react";
import * as Y from "yjs";
import {
  appendBlock,
  directoryRoom,
  getDirectoryEntry,
  getMeta,
  initDoc,
  listDirectory,
  roomForDoc,
  tombstoneDirectoryEntry,
  upsertDirectoryEntry,
} from "@uberblick/schema";
import type { RoomConnection, RoomStatus } from "../src/collab/rooms.js";

const WORKSPACE = "main";
const UUID = "b4e6f1c2-9d3a-4f57-8c21-5e0a7b9d4c31";
/** A second, live document — the "switched away from" half of the route test. */
const OTHER = "1f77c0d9-6b42-4a18-9e35-2c8d0f6a1b73";

const OFFLINE: RoomStatus = {
  connected: false,
  synced: false,
  unsyncedChanges: 0,
  localReplicaLoaded: false,
  hasLocalCache: false,
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
const { useArchived } = await import("../src/ui/hooks.js");

/** A second client holding the same directory: updates flow both ways. */
function peerDirectory(local: Y.Doc): Y.Doc {
  const peer = new Y.Doc();
  Y.applyUpdate(peer, Y.encodeStateAsUpdate(local));
  local.on("update", (update: Uint8Array) => Y.applyUpdate(peer, update));
  peer.on("update", (update: Uint8Array) => Y.applyUpdate(local, update));
  return peer;
}

let mounted: { root: Root; host: HTMLElement } | null = null;

// No served configuration document: the client falls back to its build-time
// endpoint, which is the deployment every other test in this suite assumes.
// Answered here rather than left to a real `fetch` so the gate settles on this
// suite's own terms and not on what the sandbox does with a relative URL.
beforeEach(() => {
  vi.spyOn(globalThis, "fetch").mockResolvedValue(
    new Response("", { status: 404 }),
  );
});

afterEach(() => {
  const open = mounted;
  mounted = null;
  if (open !== null) {
    act(() => open.root.unmount());
    open.host.remove();
  }
  rooms.clear();
  vi.restoreAllMocks();
});

/**
 * Render, and let the hub endpoint settle before anything is asserted.
 *
 * `await act(async …)`, not `act(…)`: since #155 the app reads its endpoint
 * from a served document and `useHubEndpoint` holds every room acquisition back
 * until that read resolves. A synchronous render therefore commits the shell
 * with no rooms and no pane at all — every assertion here would be about an
 * empty document. Awaiting is what the app itself waits for.
 */
async function mount(node: ReactNode): Promise<{ host: HTMLElement; root: Root }> {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
    true;
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  mounted = { root, host };
  await act(async () => {
    root.render(node);
  });
  return { host, root };
}

async function openApp(path: string): Promise<HTMLElement> {
  window.history.replaceState(null, "", path);
  return (await mount(<App />)).host;
}

/**
 * Change an input the way a keystroke does, so React's `onChange` runs.
 *
 * Assigning `.value` is not enough: React installs its own setter on the
 * prototype to track the last value it saw, so a plain assignment updates that
 * record too and the event that follows is dismissed as "nothing changed" —
 * which would make an assertion about the handler pass without ever reaching
 * it. Writing through the *native* setter leaves React's record behind, which
 * is exactly the state a real keystroke leaves it in.
 */
function typeInto(input: HTMLInputElement | null, value: string): void {
  if (input === null) return;
  const native = Object.getOwnPropertyDescriptor(
    HTMLInputElement.prototype,
    "value",
  )?.set;
  native?.call(input, value);
  input.dispatchEvent(new Event("input", { bubbles: true }));
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
  it("follows the directory tombstone in both directions, under an open pane", async () => {
    const directory = room(directoryRoom(WORKSPACE)).ydoc;
    const ydoc = room(roomForDoc(WORKSPACE, UUID)).ydoc;
    initDoc(ydoc, { uuid: UUID, title: "Retired protocol" });
    appendBlock(ydoc, { type: "paragraph", text: "still every byte of it" });
    upsertDirectoryEntry(directory, { uuid: UUID, title: "Retired protocol" });

    const peer = peerDirectory(directory);
    // Archived before anyone opens the link — the deep-link case.
    tombstoneDirectoryEntry(peer, UUID);

    const host = await openApp(`/${WORKSPACE}/${UUID}`);

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

    // The title's *write* is guarded, not just its field. `readOnly` is a
    // statement to the browser about typing; a change event that reaches the
    // handler by another route must still not reach the document.
    const title = host.querySelector<HTMLInputElement>(".ub-title");
    act(() => typeInto(title, "typed anyway"));
    expect(getMeta(ydoc).title).toBe("Retired protocol");
  });

  /**
   * The flag has to be right on the *first* render, not one effect later.
   *
   * Read into state, `useArchived` would report "not archived" until a passive
   * effect corrected it — and a passive effect can run after paint, so a deep
   * link to an archived document, and every switch from a live one, would put
   * an editable title and an editable editor on screen first and take them
   * away afterwards. A frame that accepts a keystroke is not a cosmetic slip.
   *
   * Asserted over every render rather than at the end, because the offending
   * render is the one in the middle: `act` flushes effects, so a check after it
   * is exactly the check that cannot see the bug.
   */
  it("reports the tombstone from its first render, never a frame late", async () => {
    const directory = room(directoryRoom(WORKSPACE));
    upsertDirectoryEntry(directory.ydoc, { uuid: OTHER, title: "Still live" });
    upsertDirectoryEntry(directory.ydoc, { uuid: UUID, title: "Retired protocol" });
    tombstoneDirectoryEntry(directory.ydoc, UUID);

    const seen: boolean[] = [];
    function Probe({ uuid }: { uuid: string }): null {
      seen.push(useArchived(directory, uuid));
      return null;
    }

    // A deep link straight to the archived document: the very first value.
    const { root } = await mount(<Probe uuid={UUID} />);
    expect(seen[0]).toBe(true);
    expect(seen).not.toContain(false);

    // And the route switch from a live document to an archived one, which is
    // the same hazard with a stale previous value in place of the initial one.
    act(() => root.render(<Probe uuid={OTHER} />));
    expect(seen.at(-1)).toBe(false);
    const switched = seen.length;
    act(() => root.render(<Probe uuid={UUID} />));
    expect(seen.slice(switched)).not.toContain(false);
  });
});

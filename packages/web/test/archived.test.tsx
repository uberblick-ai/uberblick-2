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
  createGroup,
  directoryRoom,
  getDirectoryMap,
  getDirectoryEntry,
  getMeta,
  getMetaMap,
  initDoc,
  listDirectory,
  pinDoc,
  readSidebar,
  restoreDirectoryEntry,
  roomForDoc,
  setKind,
  sidebarRoom,
  tombstoneDirectoryEntry,
  upsertDirectoryEntry,
} from "@uberblick/schema";
import type { RoomConnection, RoomStatus } from "../src/collab/rooms.js";
import * as guardedBinding from "../src/editor/guarded-binding.js";

const WORKSPACE = "6f4c8a51-2b7d-4e39-9a06-c81d3f572be4";
const UUID = "b4e6f1c2-9d3a-4f57-8c21-5e0a7b9d4c31";
/** A second, live document — the "switched away from" half of the route test. */
const OTHER = "1f77c0d9-6b42-4a18-9e35-2c8d0f6a1b73";

/**
 * What every stubbed room reports: connected, admitted and synchronized. The
 * transport is mocked away, so this is the state the app is meant to be read
 * against — and archiving now asks the sidebar room for it (#957), because an
 * admitted room that has not received the sidebar yet reads as carrying no pins
 * at all, and unpinning nothing would look exactly like success.
 */
const LIVE: RoomStatus = {
  connected: true,
  synced: true,
  hasReceivedServerState: true,
  writable: true,
  storeRefused: false,
  unsyncedChanges: 0,
  hasAnswered: true,
  protocolMismatch: null,
  authFailed: false,
  tokenMissing: false,
};

/**
 * The rooms this test's app joins, one shared Y.Doc each — so the test can hold
 * the very document the app holds, exactly as two tabs of the real client do.
 */
const rooms = new Map<string, RoomConnection>();

/**
 * What one named room reports, where `LIVE` is not what a test is about. Set
 * before the room is first acquired, and cleared with the rooms: archiving asks
 * the *sidebar* room for its own state, so this suite has to be able to say
 * that one room is behind while the rest of the app is live.
 */
const roomStatus = new Map<string, RoomStatus>();

/** Who is listening to each room, so a test can move it after the app mounted. */
const statusListeners = new Map<string, Set<(next: RoomStatus) => void>>();

function room(name: string): RoomConnection {
  const existing = rooms.get(name);
  if (existing !== undefined) return existing;
  if (!roomStatus.has(name)) roomStatus.set(name, LIVE);
  const listeners = new Set<(next: RoomStatus) => void>();
  statusListeners.set(name, listeners);
  const connection = {
    room: name,
    ydoc: new Y.Doc(),
    provider: { awareness: null },
    get status(): RoomStatus {
      return roomStatus.get(name) ?? LIVE;
    },
    onStatusChange: (listener: (next: RoomStatus) => void) => {
      listener(roomStatus.get(name) ?? LIVE);
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  } as unknown as RoomConnection;
  rooms.set(name, connection);
  return connection;
}

/**
 * One room's status changes under the mounted app — a reconnect, a lost write
 * grant — the way the provider announces it.
 */
function emitStatus(name: string, change: Partial<RoomStatus>): void {
  const next = { ...(roomStatus.get(name) ?? LIVE), ...change };
  roomStatus.set(name, next);
  act(() => {
    for (const listener of statusListeners.get(name) ?? []) listener(next);
  });
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
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe(): void {}
      unobserve(): void {}
      disconnect(): void {}
    },
  );
  Element.prototype.scrollIntoView = function scrollIntoView() {};
});

afterEach(() => {
  const open = mounted;
  mounted = null;
  if (open !== null) {
    act(() => open.root.unmount());
    open.host.remove();
  }
  rooms.clear();
  roomStatus.clear();
  statusListeners.clear();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
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

function openActions(host: HTMLElement): void {
  act(() => {
    const trigger = host.querySelector<HTMLButtonElement>(".ub-actions-trigger");
    trigger?.focus();
    trigger?.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Enter", bubbles: true }),
    );
  });
}

function action(label: string): HTMLElement | undefined {
  return [
    ...document.querySelectorAll<HTMLElement>("[data-slot=dropdown-menu-item]"),
  ].find((item) => item.textContent === label);
}

describe("an archived document is readable, says so, and offers one way back", () => {
  it("archives and restores a whole decision topic from a successor, with first-record authority", async () => {
    const directory = room(directoryRoom(WORKSPACE)).ydoc;
    const sidebar = room(sidebarRoom(WORKSPACE)).ydoc;
    const ydoc = room(roomForDoc(WORKSPACE, UUID)).ydoc;
    initDoc(ydoc, { uuid: UUID, title: "New lease" });
    setKind(ydoc, "decision");
    getMetaMap(ydoc).set("topic", OTHER);
    getMetaMap(ydoc).set("supersedes", OTHER);
    appendBlock(ydoc, { type: "paragraph", text: "The proposed lease." });
    for (const uuid of [OTHER, UUID]) {
      upsertDirectoryEntry(directory, {
        uuid, title: uuid === UUID ? "New lease" : "Original lease",
        kind: "decision", status: "open", topic: OTHER,
        ...(uuid === UUID ? { supersedes: OTHER } : {}),
      });
    }
    const group = createGroup(sidebar, "Reading");
    pinDoc(sidebar, group, OTHER);
    pinDoc(sidebar, group, UUID);
    const host = await openApp(`/${WORKSPACE}/${UUID}`);

    // A foreign/partial write to a mirror cannot make the record read-only.
    const map = getDirectoryMap(directory);
    act(() => {
      map.set(UUID, { ...(map.get(UUID) as object), deleted: true });
    });
    expect(banner(host)).toBeNull();
    expect(prose(host)?.getAttribute("contenteditable")).toBe("true");
    openActions(host);
    act(() => action("Archive document")?.click());
    act(() => document.querySelector<HTMLButtonElement>(
      '[data-slot=alert-dialog-action]',
    )?.click());
    expect(getDirectoryEntry(directory, OTHER)?.deleted).toBe(true);
    expect(getDirectoryEntry(directory, UUID)?.deleted).toBe(true);
    expect(readSidebar(sidebar)[0]?.docs).toEqual([]);
    expect(prose(host)?.getAttribute("contenteditable")).toBe("false");

    act(() => restoreButton(host)?.click());
    expect(getDirectoryEntry(directory, OTHER)?.deleted).toBeUndefined();
    expect(getDirectoryEntry(directory, UUID)?.deleted).toBeUndefined();
    expect(banner(host)).toBeNull();
    expect(prose(host)?.getAttribute("contenteditable")).toBe("true");

    // A first-record tombstone alone closes the successor's editing surface.
    act(() => map.set(OTHER, { ...(map.get(OTHER) as object), deleted: true }));
    expect(getDirectoryEntry(directory, UUID)?.deleted).toBeUndefined();
    expect(banner(host)).not.toBeNull();
    expect(prose(host)?.getAttribute("contenteditable")).toBe("false");
    expect(host.querySelector<HTMLInputElement>(".ub-title")?.readOnly).toBe(true);
    act(() => typeInto(host.querySelector<HTMLInputElement>(".ub-title"), "changed"));
    expect(getMeta(ydoc).title).toBe("New lease");
    act(() => restoreButton(host)?.click());
    expect(banner(host)).toBeNull();
  });

  it("curates and archives from the identity-row menu, taking the pin with it", async () => {
    const directory = room(directoryRoom(WORKSPACE)).ydoc;
    const ydoc = room(roomForDoc(WORKSPACE, UUID)).ydoc;
    const sidebar = room(sidebarRoom(WORKSPACE)).ydoc;
    initDoc(ydoc, { uuid: UUID, title: "Retired protocol" });
    appendBlock(ydoc, { type: "paragraph", text: "still every byte of it" });
    upsertDirectoryEntry(directory, { uuid: UUID, title: "Retired protocol" });
    pinDoc(sidebar, createGroup(sidebar, "Reading"), UUID);

    const host = await openApp(`/${WORKSPACE}/${UUID}`);
    const trigger = host.querySelector<HTMLButtonElement>(".ub-actions-trigger");
    expect(trigger?.getAttribute("aria-label")).toBe("Document actions");

    openActions(host);
    act(() => action("Unpin from sidebar")?.click());
    expect(readSidebar(sidebar)[0]?.docs).toEqual([]);
    // The dropdown returns focus to its trigger a macrotask after it closes, so
    // this waits a timer; a microtask flush would ask before Radix answers.
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(document.activeElement).toBe(trigger);

    openActions(host);
    act(() => action("Pin to sidebar")?.click());
    expect(readSidebar(sidebar)[0]?.docs).toEqual([UUID]);

    act(() => trigger?.click());
    expect(document.querySelector('[role="alertdialog"]')).toBeNull();
    openActions(host);
    act(() => action("Archive document")?.click());
    const dialog = document.querySelector('[role="alertdialog"]');
    expect(dialog?.textContent).toContain("Archive Retired protocol?");
    expect(dialog?.textContent).toContain("read-only");
    expect(dialog?.textContent).toContain("Restore");

    act(() => {
      [...(dialog?.querySelectorAll("button") ?? [])]
        .find((button) => button.textContent === "Cancel")
        ?.click();
    });
    // Dialog restores its trigger after the content's unmount autofocus runs.
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(getDirectoryEntry(directory, UUID)?.deleted).toBeUndefined();
    expect(document.activeElement).toBe(trigger);

    openActions(host);
    act(() => action("Archive document")?.click());
    act(() => {
      document
        .querySelector<HTMLButtonElement>('[data-slot=alert-dialog-action]')
        ?.click();
    });
    expect(getDirectoryEntry(directory, UUID)?.deleted).toBe(true);
    expect(host.querySelector(".ub-actions-trigger")).toBeNull();
    expect(document.activeElement).toBe(restoreButton(host));
    // The archive took the pin with it (#957): a document that has left every
    // other listing is not an entry point, so it leaves the sidebar too.
    expect(readSidebar(sidebar)[0]?.docs).toEqual([]);

    // The confirmed archive owns exactly one focus transfer. A later restore
    // and remote re-archive must not replay that stale local intent.
    act(() => restoreDirectoryEntry(directory, UUID));
    // The same write the Restore action makes (`onRestore`), and it lifts the
    // tombstone only: coming back is not being an entry point again, and
    // re-pinning stays the reader's deliberate act.
    expect(readSidebar(sidebar)[0]?.docs).toEqual([]);
    const title = host.querySelector<HTMLInputElement>(".ub-title");
    title?.focus();
    act(() => tombstoneDirectoryEntry(directory, UUID));
    expect(document.activeElement).toBe(title);

    // The same remote transition must repair focus when what it removes is the
    // confirmation itself, without broadening that repair to the title above.
    act(() => restoreDirectoryEntry(directory, UUID));
    openActions(host);
    act(() => action("Archive document")?.click());
    expect(document.activeElement?.textContent).toBe("Cancel");
    act(() => tombstoneDirectoryEntry(directory, UUID));
    expect(document.activeElement).toBe(restoreButton(host));
  });

  // The condition is the sidebar room's own state, not an observed pin: an
  // admitted room that has not received the sidebar yet reads as carrying no
  // pins at all, so archiving through it would report success having silently
  // unpinned nothing. Both readings refuse in place, the way a read-only
  // directory already does.
  for (const [why, sidebarState] of [
    ["is read-only", { writable: false }],
    ["has not arrived yet", { synced: false }],
  ] as const) {
    it(`refuses to archive while the sidebar room ${why}`, async () => {
      roomStatus.set(sidebarRoom(WORKSPACE), { ...LIVE, ...sidebarState });
      const directory = room(directoryRoom(WORKSPACE)).ydoc;
      const ydoc = room(roomForDoc(WORKSPACE, UUID)).ydoc;
      const sidebar = room(sidebarRoom(WORKSPACE)).ydoc;
      initDoc(ydoc, { uuid: UUID, title: "Retired protocol" });
      upsertDirectoryEntry(directory, { uuid: UUID, title: "Retired protocol" });
      pinDoc(sidebar, createGroup(sidebar, "Reading"), UUID);

      const host = await openApp(`/${WORKSPACE}/${UUID}`);
      openActions(host);
      expect(action("Archive document")).toBeUndefined();
      const unavailable = [
        ...document.querySelectorAll<HTMLElement>(
          "[data-slot=dropdown-menu-item]",
        ),
      ].find((item) => item.textContent?.startsWith("Archive unavailable"));
      expect(unavailable?.getAttribute("aria-disabled")).toBe("true");

      // Saying so in place means saying so instead of doing it: no
      // confirmation, no tombstone, and the pin the archive would have taken is
      // still there.
      act(() => {
        unavailable?.dispatchEvent(
          new KeyboardEvent("keydown", { key: "Enter", bubbles: true }),
        );
      });
      expect(document.querySelector('[role="alertdialog"]')).toBeNull();
      expect(getDirectoryEntry(directory, UUID)?.deleted).toBeUndefined();
      expect(readSidebar(sidebar)[0]?.docs).toEqual([UUID]);
    });
  }

  // The same refusal has to hold when readiness is lost *inside* the open
  // confirmation, which is the ordinary disconnect boundary: the red button
  // would otherwise close the dialog exactly as a successful archive does and
  // write nothing. Both rooms, because either one going unwritable removes the
  // action, and the reader cannot tell which.
  for (const [which, roomName] of [
    ["directory", directoryRoom(WORKSPACE)],
    ["sidebar", sidebarRoom(WORKSPACE)],
  ] as const) {
    it(`says so in the open confirmation when the ${which} room stops being ready`, async () => {
      const directory = room(directoryRoom(WORKSPACE)).ydoc;
      const ydoc = room(roomForDoc(WORKSPACE, UUID)).ydoc;
      const sidebar = room(sidebarRoom(WORKSPACE)).ydoc;
      initDoc(ydoc, { uuid: UUID, title: "Retired protocol" });
      upsertDirectoryEntry(directory, { uuid: UUID, title: "Retired protocol" });
      pinDoc(sidebar, createGroup(sidebar, "Reading"), UUID);

      const host = await openApp(`/${WORKSPACE}/${UUID}`);
      openActions(host);
      act(() => action("Archive document")?.click());
      expect(document.querySelector('[role="alertdialog"]')).not.toBeNull();

      emitStatus(roomName, { writable: false });
      act(() => {
        document
          .querySelector<HTMLButtonElement>('[data-slot=alert-dialog-action]')
          ?.click();
      });

      // In place: the confirmation is still there, and it now explains itself
      // instead of pretending the archive happened.
      const dialog = document.querySelector('[role="alertdialog"]');
      expect(dialog?.textContent).toContain("Archive unavailable");
      expect(getDirectoryEntry(directory, UUID)?.deleted).toBeUndefined();
      expect(readSidebar(sidebar)[0]?.docs).toEqual([UUID]);

      // And it goes back to being the archive it was once the room returns.
      emitStatus(roomName, { writable: true });
      act(() => {
        document
          .querySelector<HTMLButtonElement>('[data-slot=alert-dialog-action]')
          ?.click();
      });
      expect(getDirectoryEntry(directory, UUID)?.deleted).toBe(true);
      expect(readSidebar(sidebar)[0]?.docs).toEqual([]);
    });
  }

  it("visibly explains unavailable Restore for offline and connected read-only directories", async () => {
    const directoryName = directoryRoom(WORKSPACE);
    const directory = room(directoryName).ydoc;
    const ydoc = room(roomForDoc(WORKSPACE, UUID)).ydoc;
    initDoc(ydoc, { uuid: UUID, title: "Retired protocol" });
    upsertDirectoryEntry(directory, { uuid: UUID, title: "Retired protocol" });
    tombstoneDirectoryEntry(directory, UUID);
    const host = await openApp(`/${WORKSPACE}/${UUID}`);

    expect(host.querySelector(".ub-restore-unavailable")).toBeNull();
    for (const connected of [true, false]) {
      emitStatus(directoryName, { writable: false, connected });
      expect(restoreButton(host)?.disabled).toBe(true);
      expect(host.querySelector(".ub-restore-unavailable")?.textContent).toContain(
        "Restore is unavailable while the directory is not ready to write.",
      );
      act(() => restoreButton(host)?.click());
      expect(getDirectoryEntry(directory, UUID)?.deleted).toBe(true);
    }

    emitStatus(directoryName, { writable: true, connected: true });
    expect(restoreButton(host)?.disabled).toBe(false);
    expect(host.querySelector(".ub-restore-unavailable")).toBeNull();
  });

  it("follows the directory tombstone in both directions, under an open pane", async () => {
    const binding = vi.spyOn(guardedBinding, "bindGuardedEditor");
    const directory = room(directoryRoom(WORKSPACE)).ydoc;
    const ydoc = room(roomForDoc(WORKSPACE, UUID)).ydoc;
    initDoc(ydoc, { uuid: UUID, title: "Retired protocol" });
    appendBlock(ydoc, { type: "paragraph", text: "still every byte of it" });
    upsertDirectoryEntry(directory, { uuid: UUID, title: "Retired protocol" });

    const peer = peerDirectory(directory);
    // Archived before anyone opens the link — the deep-link case.
    tombstoneDirectoryEntry(peer, UUID);

    const host = await openApp(`/${WORKSPACE}/${UUID}`);
    expect(binding).toHaveBeenCalledOnce();
    expect(binding.mock.calls[0]?.[0].editable).toBe(false);

    // ---- the deep link says what it opened ----
    expect(banner(host)?.textContent).toContain("Archived");
    expect(restoreButton(host)?.textContent).toBe("Restore");
    // The document itself is here and rendered: archiving is a tombstone on the
    // stub, not a deletion, and hiding the content would be a different feature.
    expect(prose(host)?.textContent).toContain("still every byte of it");
    // Read-only, and no chrome left that would write around it.
    expect(prose(host)?.getAttribute("contenteditable")).toBe("false");
    expect(prose(host)?.getAttribute("aria-readonly")).toBe("true");
    expect(host.querySelector<HTMLInputElement>(".ub-title")?.readOnly).toBe(true);
    expect(host.querySelector('[aria-label="Insert block below"]')).toBeNull();

    // ---- Restore is the one action, and it is a real restore ----
    act(() => restoreButton(host)?.click());
    expect(binding).toHaveBeenCalledOnce();
    expect(banner(host)).toBeNull();
    expect(prose(host)?.getAttribute("contenteditable")).toBe("true");
    expect(prose(host)?.getAttribute("aria-readonly")).toBe("false");
    expect(host.querySelector<HTMLInputElement>(".ub-title")?.readOnly).toBe(false);
    expect(host.querySelector('[aria-label="Insert block below"]')).not.toBeNull();
    // Lifted on the *other* client too, which is what "reappears in listings"
    // means: the second replica lists it again without asking for it.
    expect(getDirectoryEntry(peer, UUID)?.deleted).toBeUndefined();
    expect(listDirectory(peer).map((entry) => entry.uuid)).toEqual([UUID]);

    // ---- and it flips live when someone else archives it ----
    // No remount, no reload: the same editor element goes read-only in place.
    const bound = prose(host);
    act(() => tombstoneDirectoryEntry(peer, UUID));
    expect(binding).toHaveBeenCalledOnce();
    expect(banner(host)).not.toBeNull();
    expect(prose(host)).toBe(bound);
    expect(bound?.getAttribute("contenteditable")).toBe("false");
    expect(bound?.getAttribute("aria-readonly")).toBe("true");
    expect(host.querySelector('[aria-label="Insert block below"]')).toBeNull();

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

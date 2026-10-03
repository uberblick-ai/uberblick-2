/** Sidebar visibility and room admission cancel previews without shared writes. */
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { act, useEffect } from "react";
import { createRoot } from "react-dom/client";
import type { Root } from "react-dom/client";
import { useDragDropManager } from "@dnd-kit/react";
import type { DragDropManager } from "@dnd-kit/react";
import { useSortable } from "@dnd-kit/react/sortable";
import { Feedback } from "@dnd-kit/dom";
import * as Y from "yjs";
import { createGroup, pinDoc, readSidebar, sidebarRoom } from "@uberblick/schema";
import type { RoomConnection, RoomStatus } from "../src/collab/rooms.js";
import { SidebarDragProvider } from "../src/ui/sidebar-drag.js";

const WORKSPACE = "6f4c8a51-2b7d-4e39-9a06-c81d3f572be4";
const ONE = "b4e6f1c2-9d3a-4f57-8c21-5e0a7b9d4c31";
const TWO = "1f77c0d9-6b42-4a18-9e35-2c8d0f6a1b73";
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

type Sortable = ReturnType<typeof useSortable>["sortable"];
interface ProbeState {
  manager: DragDropManager | null;
  rows: Map<string, Sortable>;
}

function Row({ uuid, index, group, probe }: {
  uuid: string;
  index: number;
  group: string;
  probe: ProbeState;
}) {
  const sortable = useSortable({
    id: `doc:${uuid}`, index, group, type: "doc", accept: "doc",
    data: { kind: "doc", id: uuid, label: uuid },
    // Layout and visual feedback need a browser; these checks exercise only
    // the public manager's state transitions and the provider's write gate.
    plugins: [Feedback.configure({ feedback: "none" })],
    transition: null,
  });
  useEffect(() => {
    probe.rows.set(uuid, sortable.sortable);
    return () => { probe.rows.delete(uuid); };
  }, [probe, sortable.sortable, uuid]);
  return <li ref={sortable.ref} data-doc={uuid}><button type="button" ref={sortable.handleRef}>{uuid}</button></li>;
}

function Rows({ group, probe }: { group: string; probe: ProbeState }) {
  const manager = useDragDropManager();
  useEffect(() => { probe.manager = manager; }, [manager, probe]);
  return <ul>{[ONE, TWO].map((uuid, index) => <Row key={uuid} uuid={uuid} index={index} group={group} probe={probe} />)}</ul>;
}

let mounted: { root: Root; host: HTMLElement } | null = null;
beforeEach(() => {
  vi.stubGlobal("IntersectionObserver", class {
    observe(): void {}
    unobserve(): void {}
    disconnect(): void {}
  });
  Object.defineProperty(document, "elementFromPoint", { configurable: true, value: () => null });
});
afterEach(() => {
  if (mounted !== null) {
    act(() => mounted?.root.unmount());
    mounted.host.remove();
    mounted = null;
  }
  Reflect.deleteProperty(document, "elementFromPoint");
  vi.unstubAllGlobals();
});

it.each(["hidden", "read-only"] as const)(
  "cancels a preview when the sidebar becomes %s and refuses another pickup",
  async (change) => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    const ydoc = new Y.Doc();
    const group = createGroup(ydoc, "Reading");
    pinDoc(ydoc, group, ONE);
    pinDoc(ydoc, group, TWO);
    const peer = new Y.Doc();
    Y.applyUpdate(peer, Y.encodeStateAsUpdate(ydoc));
    ydoc.on("update", (update: Uint8Array) => Y.applyUpdate(peer, update));
    const before = readSidebar(peer);
    const listeners = new Set<(status: RoomStatus) => void>();
    const connection = {
      room: sidebarRoom(WORKSPACE), ydoc, provider: { awareness: null }, status: { ...LIVE },
      onStatusChange: (listener: (status: RoomStatus) => void) => {
        listeners.add(listener);
        listener(connection.status);
        return () => listeners.delete(listener);
      },
    } as unknown as RoomConnection;
    const onDraggingChange = vi.fn();
    const probe: ProbeState = { manager: null, rows: new Map() };
    const host = document.createElement("div");
    document.body.appendChild(host);
    const root = createRoot(host);
    mounted = { root, host };
    const render = (active: boolean) => root.render(
      <SidebarDragProvider connection={connection} active={active} onDraggingChange={onDraggingChange}>
        <Rows group={group} probe={probe} />
      </SidebarDragProvider>,
    );
    await act(async () => render(true));
    const manager = probe.manager;
    if (manager === null) throw new Error("public drag manager was not mounted");
    const writes = vi.fn();
    ydoc.on("update", writes);
    const drawnOrder = () => [...host.querySelectorAll<HTMLElement>("[data-doc]")].map((row) => row.dataset.doc);

    await act(async () => {
      manager.actions.start({ source: `doc:${ONE}`, coordinates: { x: 0, y: 0 } });
    });
    expect(manager.dragOperation.status.dragging).toBe(true);
    expect(onDraggingChange).toHaveBeenLastCalledWith(true);
    await act(async () => { void manager.actions.setDropTarget(`doc:${TWO}`); });
    expect(drawnOrder()).toEqual([TWO, ONE]);
    expect(probe.rows.get(ONE)?.index).toBe(1);
    expect(writes).not.toHaveBeenCalled();

    await act(async () => {
      if (change === "hidden") render(false);
      else {
        connection.status = { ...LIVE, writable: false };
        for (const listener of listeners) listener(connection.status);
      }
    });
    expect(manager.dragOperation.status.idle).toBe(true);
    expect(onDraggingChange).toHaveBeenLastCalledWith(false);
    expect(drawnOrder()).toEqual([ONE, TWO]);
    expect(probe.rows.get(ONE)?.index).toBe(0);
    expect(readSidebar(peer)).toEqual(before);
    expect(writes).not.toHaveBeenCalled();

    onDraggingChange.mockClear();
    await act(async () => {
      const start = manager.actions.start({ source: `doc:${ONE}`, coordinates: { x: 0, y: 0 } });
      expect(start.signal.aborted).toBe(true);
    });
    expect(manager.dragOperation.status.idle).toBe(true);
    expect(onDraggingChange).not.toHaveBeenCalledWith(true);
    expect(readSidebar(peer)).toEqual(before);
    expect(writes).not.toHaveBeenCalled();
  },
);

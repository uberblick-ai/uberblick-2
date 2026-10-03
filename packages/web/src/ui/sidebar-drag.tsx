/** dnd-kit owns gestures and visual sorting; Yjs owns the committed order. */
import { createContext, useCallback, useContext, useEffect, useId, useRef } from "react";
import type { MouseEvent, ReactElement, ReactNode } from "react";
import { DragDropProvider } from "@dnd-kit/react";
import type { DragDropManager, DragStartEvent, DragOverEvent, DragEndEvent } from "@dnd-kit/react";
import { isSortable } from "@dnd-kit/react/sortable";
import { Accessibility, KeyboardSensor, PointerActivationConstraints, PointerSensor } from "@dnd-kit/dom";
import { announce, cleanup } from "@atlaskit/pragmatic-drag-and-drop-live-region";
import { OptimisticSortingPlugin } from "@dnd-kit/dom/sortable";
import { moveDoc, moveGroup, readSidebar } from "@uberblick/schema";
import type * as Y from "yjs";
import type { RoomConnection } from "../collab/rooms.js";

// The row is both the activator and a navigation/disclosure button. A mouse
// hold must never pick it up; touch must leave early swipes to native scrolling.
export const sidebarRowSensors = [
  PointerSensor.configure({
    activationConstraints: (event) => event.pointerType === "touch"
      ? [new PointerActivationConstraints.Delay({ value: 250, tolerance: 5 })]
      : [new PointerActivationConstraints.Distance({ value: 5 })],
  }),
  KeyboardSensor.configure({
    keyboardCodes: { ...KeyboardSensor.defaults.keyboardCodes, start: ["Space"] },
  }),
];

const Instructions = createContext<string | undefined>(undefined);
export function useSidebarDragInstructions(): string | undefined {
  return useContext(Instructions);
}

const RowClickGuard = createContext<{
  onPointerDownCapture: () => void;
  onKeyDownCapture: () => void;
  onClickCapture: (event: MouseEvent<HTMLButtonElement>) => void;
} | undefined>(undefined);
export function useSidebarRowClickGuard() {
  return useContext(RowClickGuard);
}

function endAnnouncement({ canceled, operation: { source, target } }: DragEndEvent): string {
  const label = source?.data.label ?? "item";
  if (canceled || !target) return `Cancelled moving ${label}.`;
  if (isSortable(source) && source.id === target.id && source.index === source.initialIndex) {
    return `Kept ${label} in place.`;
  }
  return `Moved ${label}.`;
}

type SidebarDrop =
  | { kind: "group"; id: string; index: number }
  | { kind: "doc"; id: string; group: string; index: number };

/** Final indices are after removal, exactly the schema move functions' contract. */
function commitSidebarDrop(doc: Y.Doc, drop: SidebarDrop): void {
  const groups = readSidebar(doc);
  if (drop.kind === "group") {
    const at = groups.findIndex((group) => group.id === drop.id);
    if (at !== -1 && at !== drop.index) moveGroup(doc, drop.id, drop.index);
    return;
  }
  const source = groups.find((group) => group.docs.includes(drop.id));
  const target = groups.find((group) => group.id === drop.group);
  if (!source || !target) return;
  if (source.id === target.id && source.docs.indexOf(drop.id) === drop.index) return;
  moveDoc(doc, drop.id, drop.group, drop.index);
}

function order(doc: Y.Doc): string {
  return JSON.stringify(readSidebar(doc).map(({ id, docs }) => [id, docs]));
}

/** Keep optimistic sorting within a React-owned list, never between parents. */
class SidebarSortingPlugin extends OptimisticSortingPlugin {
  constructor(manager: DragDropManager) {
    // Register before the upstream plugin: its cancellation listener must see
    // targetless drops as canceled so it restores any optimistic in-list sort.
    const stop = manager.monitor.addEventListener("dragend", (event) => {
      if (event.operation.target === null) {
        event.canceled = true;
        manager.dragOperation.canceled = true;
      }
    });
    const over = manager.monitor.addEventListener("dragover", (event) => {
      const { source, target } = event.operation;
      if (isSortable(source) && isSortable(target) && source.group !== target.group) {
        event.preventDefault();
      }
    });
    super(manager);
    const destroy = this.destroy;
    this.destroy = () => { stop(); over(); destroy(); };
  }
}

export function SidebarDragProvider({
  connection,
  active,
  onDraggingChange,
  children,
}: {
  connection: RoomConnection | null;
  active: boolean;
  onDraggingChange?: (active: boolean) => void;
  children: ReactNode;
}): ReactElement {
  const instructionsId = useId();
  const dragging = useRef<DragDropManager | null>(null);
  const touchDrag = useRef(false);
  const initialOrder = useRef<string | null>(null);
  // dnd-kit removes its click guard at pointerup, before a stationary touch's
  // native click. Keep this handoff armed through drop/cancel, without timers.
  const resetRowClickGuard = (): void => {
    // Escape during a touch drag belongs to that gesture, not the next one.
    if (dragging.current === null) touchDrag.current = false;
  };
  const rowClickGuard = {
    onPointerDownCapture: resetRowClickGuard,
    onKeyDownCapture: resetRowClickGuard,
    onClickCapture: (event: MouseEvent<HTMLButtonElement>): void => {
      // Keyboard and assistive activations have no pointer click count.
      if (!touchDrag.current || event.detail === 0) return;
      touchDrag.current = false;
      event.preventDefault();
      event.stopPropagation();
    },
  };
  const cancel = useCallback((): void => {
    dragging.current?.actions.stop({ canceled: true });
    onDraggingChange?.(false);
  }, [onDraggingChange]);

  // Cancel before a shared update renders over dnd-kit's optimistic DOM order.
  // There is no snapshot rollback: the observer always renders current Yjs data.
  useEffect(() => {
    if (connection === null) return;
    const changed = (): void => {
      if (order(connection.ydoc) !== initialOrder.current) cancel();
    };
    connection.ydoc.on("update", changed);
    const stopStatus = connection.onStatusChange((status) => {
      if (!status.writable) cancel();
    });
    return () => {
      cancel();
      connection.ydoc.off("update", changed);
      stopStatus();
    };
  }, [connection, cancel]);
  useEffect(() => {
    if (!active) cancel();
  }, [active, cancel]);
  useEffect(() => cleanup, []);

  return (
    <DragDropProvider
      plugins={(defaults) => [
        SidebarSortingPlugin,
        // This plugin unconditionally turns its activator into a pressed/
        // disabled draggable. Native row buttons keep their own semantics;
        // the live-region helper emits the same product announcements.
        ...defaults.filter((plugin) => plugin !== Accessibility),
      ]}
      onBeforeDragStart={(event) => {
        if (!active || connection?.status.writable !== true) event.preventDefault();
      }}
      onDragStart={(event: DragStartEvent, manager) => {
        const activator = event.operation.activatorEvent;
        if (activator && "pointerType" in activator && activator.pointerType === "touch") {
          touchDrag.current = true;
        }
        announce(`Moving ${event.operation.source?.data.label ?? "item"}.`);
        dragging.current = manager;
        onDraggingChange?.(true);
        initialOrder.current = connection === null ? null : order(connection.ydoc);
      }}
      onDragOver={({ operation: { source, target } }: DragOverEvent) => {
        // The initial collision is the row itself, not a newly chosen position.
        // Keep the pickup instruction instead of replacing it with "Over" itself.
        if (source?.id === target?.id) return;
        announce(target ? `Over ${target.data.label ?? "item"}.` : "No drop target. Release to cancel.");
      }}
      onDragEnd={(event) => {
        announce(endAnnouncement(event));
        dragging.current = null;
        onDraggingChange?.(false);
        const expectedOrder = initialOrder.current;
        initialOrder.current = null;
        if (event.canceled || !active || connection?.status.writable !== true) return;
        if (order(connection.ydoc) !== expectedOrder) return;
        const { source, target } = event.operation;
        if (!isSortable(source) || target === null) return;
        const id = source.data.id;
        if (typeof id !== "string") return;
        if (source.data.kind === "group") {
          commitSidebarDrop(connection.ydoc, { kind: "group", id, index: source.index });
        } else if (source.data.kind === "doc") {
          const group = target.data.kind === "append" ? target.data.group
            : isSortable(target) ? target.group : source.group;
          if (typeof group !== "string") return;
          const index = target.data.kind === "append"
            ? readSidebar(connection.ydoc).find((item) => item.id === group)?.docs.filter((uuid) => uuid !== id).length
            : isSortable(target) && target.group !== source.group ? target.index : source.index;
          if (index === undefined) return;
          commitSidebarDrop(connection.ydoc, { kind: "doc", id, group, index });
        }
      }}
    >
      <Instructions.Provider value={instructionsId}>
        <p id={instructionsId} hidden>
          Press Enter to open the document or toggle the group. Press Space to pick up the row.
          While dragging, use the arrow keys to move, Space or Enter to drop, or Escape to cancel.
        </p>
        <RowClickGuard.Provider value={rowClickGuard}>{children}</RowClickGuard.Provider>
      </Instructions.Provider>
    </DragDropProvider>
  );
}

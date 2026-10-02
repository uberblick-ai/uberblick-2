/** dnd-kit owns gestures and visual sorting; Yjs owns the committed order. */
import { useCallback, useEffect, useRef } from "react";
import type { ReactElement, ReactNode } from "react";
import { DragDropProvider } from "@dnd-kit/react";
import type { DragDropManager, DragStartEvent, DragOverEvent, DragEndEvent } from "@dnd-kit/react";
import { isSortable } from "@dnd-kit/react/sortable";
import { Accessibility } from "@dnd-kit/dom";
import { moveDoc, moveGroup, readSidebar } from "@uberblick/schema";
import type * as Y from "yjs";
import type { RoomConnection } from "../collab/rooms.js";

export type SidebarDrop =
  | { kind: "group"; id: string; index: number }
  | { kind: "doc"; id: string; group: string; index: number };

/** Final indices are after removal, exactly the schema move functions' contract. */
export function commitSidebarDrop(doc: Y.Doc, drop: SidebarDrop): void {
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

export function SidebarDragProvider({
  connection,
  active,
  children,
}: {
  connection: RoomConnection | null;
  active: boolean;
  children: ReactNode;
}): ReactElement {
  const dragging = useRef<DragDropManager | null>(null);
  const initialOrder = useRef<string | null>(null);
  const cancel = useCallback((): void => dragging.current?.actions.stop({ canceled: true }), []);

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

  return (
    <DragDropProvider
      plugins={(defaults) => [
        ...defaults,
        Accessibility.configure({
          announcements: {
            dragstart: ({ operation: { source } }: DragStartEvent) => `Moving ${source?.data.label ?? "item"}.`,
            dragover: ({ operation: { target } }: DragOverEvent) => target ? `Over ${target.data.label ?? "item"}.` : undefined,
            dragend: ({ canceled, operation: { source } }: DragEndEvent) => `${canceled ? "Cancelled moving" : "Moved"} ${source?.data.label ?? "item"}.`,
          },
        }),
      ]}
      onBeforeDragStart={(event) => {
        if (!active || connection?.status.writable !== true) event.preventDefault();
      }}
      onDragStart={(_event, manager) => {
        dragging.current = manager;
        initialOrder.current = connection === null ? null : order(connection.ydoc);
      }}
      onDragEnd={(event) => {
        dragging.current = null;
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
          const group = target.data.kind === "append" ? target.data.group : source.group;
          if (typeof group !== "string") return;
          const index = target.data.kind === "append"
            ? readSidebar(connection.ydoc).find((item) => item.id === group)?.docs.filter((uuid) => uuid !== id).length
            : source.index;
          if (index === undefined) return;
          commitSidebarDrop(connection.ydoc, { kind: "doc", id, group, index });
        }
      }}
    >
      {children}
    </DragDropProvider>
  );
}

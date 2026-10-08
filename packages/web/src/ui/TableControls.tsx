/** Quiet table affordances compose framework gestures and live shared edits. */
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import type { ReactElement, RefObject } from "react";
import type { Editor } from "@tiptap/core";
import { DragDropProvider } from "@dnd-kit/react";
import type { DragDropManager } from "@dnd-kit/react";
import { Accessibility, Feedback } from "@dnd-kit/dom";
import { findBlockById } from "../editor/block-menu.js";
import { isOrdinaryTable } from "../editor/table.js";
import { actOnTable, moveTableRow, resolveTableRow, tableRowTarget, tableRowTargets } from "../editor/table-controls.js";
import type { TableAction, TableRowTarget } from "../editor/table-controls.js";
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem,
} from "./shadcn/dropdown-menu.js";
import { TableRowHandle, tableRowSensors } from "./table-row-drag.js";

interface Geometry {
  tableId: string;
  left: number;
  top: number;
  width: number;
  viewportWidth: number;
  height: number;
  scrollLeft: number;
  scrollWidth: number;
  columns: number[];
  rows: { key: number; target: TableRowTarget; middle: number; bottom: number }[];
  caretRow: number | null;
  touch: boolean;
}

function caretTable(editor: Editor): { id: string; row: number } | null {
  const { $head } = editor.state.selection;
  const id: unknown = $head.depth > 1 && $head.node(1).type.name === "table" ? $head.node(1).attrs.id : null;
  return typeof id === "string" ? { id, row: $head.index(1) } : null;
}

function tableIdAt(target: EventTarget | null): string | null {
  const element = target instanceof Element ? target : target instanceof Node ? target.parentElement : null;
  const controls = element?.closest<HTMLElement>(".ub-table-controls");
  if (controls !== null && controls !== undefined) return controls.dataset.tableId ?? null;
  return element?.closest(".tableWrapper")?.querySelector("table")?.id || null;
}

/** Map the live pointer to a body-row gap, including the reserved end space. */
function rowGap(geometry: Geometry, base: DOMRect, point: { x: number; y: number }): number | null {
  const x = point.x - base.left - geometry.left;
  const y = point.y - base.top - geometry.top;
  const header = geometry.rows[0];
  const last = geometry.rows.at(-1);
  if (header === undefined || last === undefined || x < 0 || x > geometry.width || y < header.bottom || y > last.bottom + 22) return null;
  for (let index = 1; index < geometry.rows.length; index += 1) {
    const row = geometry.rows[index];
    if (row !== undefined && y < row.middle) return index;
  }
  return geometry.rows.length;
}

/** Each eligible table reveals independently, including a hovered second table. */
export function TableControls({ editor, host }: {
  editor: Editor;
  host: RefObject<HTMLElement | null>;
}): ReactElement {
  const ids = (): string[] => {
    const result: string[] = [];
    editor.state.doc.forEach((node) => {
      if (node.type.name === "table" && typeof node.attrs.id === "string") result.push(node.attrs.id);
    });
    return result;
  };
  const [tables, setTables] = useState(ids);
  useEffect(() => {
    const read = (): void => {
      const next: string[] = [];
      editor.state.doc.forEach((node) => {
        if (node.type.name === "table" && typeof node.attrs.id === "string") next.push(node.attrs.id);
      });
      setTables((previous) => previous.length === next.length && previous.every((id, index) => id === next[index]) ? previous : next);
    };
    editor.on("transaction", read);
    return () => { editor.off("transaction", read); };
  }, [editor]);
  return <>{tables.map((tableId) => <TableControlSurface key={tableId} tableId={tableId} editor={editor} host={host} />)}</>;
}

function TableControlSurface({ tableId, editor, host }: {
  tableId: string;
  editor: Editor;
  host: RefObject<HTMLElement | null>;
}): ReactElement | null {
  const [geometry, setGeometry] = useState<Geometry | null>(null);
  const [menu, setMenu] = useState<TableRowTarget | null>(null);
  const menuRef = useRef<TableRowTarget | null>(null);
  const hovered = useRef<string | null>(null);
  const touch = useRef(editor.view.dom.ownerDocument.defaultView?.matchMedia?.("(pointer: coarse)").matches ?? false);
  const pendingFocus = useRef(false);
  const controls = useRef<HTMLDivElement | null>(null);
  const columnStrip = useRef<HTMLDivElement | null>(null);
  const rowKeys = useRef(new WeakMap<TableRowTarget["row"], number>());
  const nextRowKey = useRef(0);
  const refresh = useRef<() => void>(() => {});
  const acted = useRef(false);
  const closing = useRef(false);
  const drag = useRef<{ target: TableRowTarget; manager: DragDropManager; point: { x: number; y: number }; focused: boolean } | null>(null);
  const dragged = useRef(false);
  const [gap, setGap] = useState<number | null>(null);
  const geometryRef = useRef<Geometry | null>(null);
  const cancelDrag = useCallback((): void => {
    drag.current?.manager.actions.stop({ canceled: true });
    drag.current = null;
    setGap(null);
  }, []);
  const setTarget = useCallback((target: TableRowTarget | null): void => {
    if (target === null && menuRef.current !== null) closing.current = true;
    if (target !== null) closing.current = false;
    menuRef.current = target;
    setMenu(target);
  }, []);

  useEffect(() => {
    const frame = host.current;
    if (frame === null) return;
    const dom = editor.view.dom;
    const owner = dom.ownerDocument;
    const win = owner.defaultView;
    const read = (): void => {
      if (editor.isDestroyed) return;
      if (drag.current !== null && resolveTableRow(editor, drag.current.target) === null) cancelDrag();
      let target = menuRef.current;
      if (target !== null && resolveTableRow(editor, target) === null) {
        menuRef.current = null;
        setMenu(null);
        target = null;
      }
      const caret = caretTable(editor);
      const focused = tableIdAt(owner.activeElement);
      const eligible = drag.current !== null || closing.current || target?.tableId === tableId || focused === tableId || editor.isFocused && caret?.id === tableId || hovered.current === tableId;
      const id = tableId;
      const found = eligible ? findBlockById(editor.state.doc, id) : null;
      if (!editor.isEditable || found === null || !isOrdinaryTable(found.node)) {
        menuRef.current = null;
        setMenu(null);
        setGeometry(null);
        return;
      }
      const node = editor.view.nodeDOM(found.pos);
      const wrapper = node instanceof HTMLElement ? node : null;
      const table = wrapper?.querySelector("table");
      if (wrapper === null || table === null || table === undefined) {
        setGeometry(null);
        return;
      }
      const base = frame.getBoundingClientRect();
      const box = wrapper.getBoundingClientRect();
      const width = wrapper.clientWidth;
      const size = touch.current ? 44 : 24;
      const header = table.rows[0];
      const cells = Array.from(header?.cells ?? []);
      const first = cells[0];
      const edges = first === undefined ? [] : [first.getBoundingClientRect().left, ...cells.map((cell) => cell.getBoundingClientRect().right)];
      const targets = tableRowTargets(editor, id);
      if (targets === null) { setGeometry(null); return; }
      const rows: Geometry["rows"] = [];
      for (const [index, row] of Array.from(table.rows).entries()) {
        const target = targets[index];
        if (target === undefined) { setGeometry(null); return; }
        let key = rowKeys.current.get(target.row);
        if (key === undefined) {
          key = nextRowKey.current++;
          rowKeys.current.set(target.row, key);
        }
        const rect = row.getBoundingClientRect();
        rows.push({ key, target, middle: (rect.top + rect.bottom) / 2 - box.top, bottom: rect.bottom - box.top });
      }
      const next: Geometry = {
        tableId: id, left: box.left - base.left, top: box.top - base.top,
        width: width + 88, viewportWidth: width, height: wrapper.clientHeight, scrollLeft: wrapper.scrollLeft, scrollWidth: wrapper.scrollWidth,
        // A native scroll strip keeps every column in keyboard order. Focus
        // scrolls it normally, and its scroll also brings the table along.
        columns: edges.map((edge) => Math.max(0, Math.min(wrapper.scrollWidth - size, edge - box.left + wrapper.scrollLeft - size / 2))),
        rows,
        caretRow: caret?.id === id ? caret.row : null, touch: touch.current,
      };
      geometryRef.current = next;
      setGeometry(next);
      if (drag.current !== null) setGap(rowGap(next, base, drag.current.point));
    };
    const move = (event: PointerEvent): void => {
      if (event.pointerType === "touch") return;
      touch.current = false;
      hovered.current = tableIdAt(event.target);
      read();
    };
    const press = (event: PointerEvent): void => {
      touch.current = event.pointerType === "touch";
      if (touch.current) hovered.current = null;
      else hovered.current = tableIdAt(event.target);
      read();
    };
    const leave = (): void => { hovered.current = null; read(); };
    const focus = (): void => { read(); };
    // During native Tab or a touch press, focusout briefly sees body as the
    // active element. Read after the focus transfer so its destination survives.
    const blur = (): void => { queueMicrotask(read); };
    const scroll = (event: Event): void => {
      if (drag.current !== null || event.target instanceof HTMLElement && event.target.classList.contains("tableWrapper")) read();
    };
    const key = (event: KeyboardEvent): void => {
      if (event.isComposing || !editor.isEditable) return;
      const rowMenu = event.key === "F10" && event.shiftKey || event.ctrlKey && event.altKey && event.code === "KeyR";
      const insertion = event.ctrlKey && event.altKey && event.code === "KeyT";
      const actions: Record<string, TableAction> = {
        ArrowLeft: "column-before", ArrowRight: "column-after", ArrowUp: "row-before", ArrowDown: "row-after",
      };
      const action = event.ctrlKey && event.altKey ? actions[event.key] : undefined;
      if (!rowMenu && !insertion && action === undefined) return;
      const caret = caretTable(editor);
      if (caret?.id !== tableId) return;
      const target = caret === null ? null : tableRowTarget(editor, caret.id, caret.row);
      if (target === null) return;
      // Native button Tab navigation varies on iOS. These caret shortcuts use
      // the same guarded TableKit action and require no custom focus traversal.
      if (action !== undefined) {
        if (actOnTable(editor, target, editor.state.selection.$head.index(2), action)) {
          event.preventDefault();
          editor.view.focus();
        }
        return;
      }
      event.preventDefault();
      if (rowMenu) {
        acted.current = false;
        closing.current = false;
        menuRef.current = target;
        setMenu(target);
      } else pendingFocus.current = true;
      read();
    };
    dom.addEventListener("keydown", key);
    frame.addEventListener("pointermove", move);
    frame.addEventListener("pointerdown", press, true);
    frame.addEventListener("pointerleave", leave);
    owner.addEventListener("scroll", scroll, true);
    owner.addEventListener("focusin", focus);
    owner.addEventListener("focusout", blur);
    win?.addEventListener("resize", read);
    editor.on("transaction", read);
    editor.on("focus", read);
    editor.on("blur", blur);
    // Table text can reflow after fonts load or the pane changes width.
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(read);
    observer?.observe(dom);
    refresh.current = read;
    read();
    return () => {
      dom.removeEventListener("keydown", key);
      frame.removeEventListener("pointermove", move);
      cancelDrag();
      frame.removeEventListener("pointerdown", press, true);
      frame.removeEventListener("pointerleave", leave);
      owner.removeEventListener("scroll", scroll, true);
      owner.removeEventListener("focusin", focus);
      owner.removeEventListener("focusout", blur);
      win?.removeEventListener("resize", read);
      editor.off("transaction", read);
      editor.off("focus", read);
      editor.off("blur", blur);
      observer?.disconnect();
      refresh.current = () => {};
    };
  }, [editor, host, tableId, cancelDrag]);

  useLayoutEffect(() => { menuRef.current = menu; refresh.current(); }, [menu]);

  useLayoutEffect(() => {
    if (columnStrip.current !== null && geometry !== null) columnStrip.current.scrollLeft = geometry.scrollLeft;
    if (!pendingFocus.current || geometry === null) return;
    pendingFocus.current = false;
    controls.current?.querySelector<HTMLButtonElement>("button")?.focus();
  }, [geometry]);

  useEffect(() => {
    const dom = editor.view.dom;
    const context = (event: MouseEvent): void => {
      const element = event.target instanceof Element ? event.target : null;
      const row = element?.closest("tr");
      const table = row?.closest("table");
      if (row === null || row === undefined || table === null || table === undefined) return;
      if (table.id !== tableId) return;
      const target = tableRowTarget(editor, table.id, Array.from(table.rows).indexOf(row));
      if (target === null) return;
      event.preventDefault();
      acted.current = false;
      setTarget(target);
    };
    dom.addEventListener("contextmenu", context);
    return () => dom.removeEventListener("contextmenu", context);
  }, [editor, setTarget, tableId]);

  const size = geometry?.touch ? 44 : 24;
  const openRow = menu === null ? null : resolveTableRow(editor, menu)?.rowIndex;
  const act = (row: number, column: number, action: TableAction, fromMenu = false): void => {
    const target = fromMenu ? menu : geometry?.rows[row]?.target;
    if (target === null || target === undefined) return;
    acted.current = actOnTable(editor, target, column, action);
    setTarget(null);
    if (acted.current) editor.view.focus();
  };
  const moveRow = (direction: -1 | 1): void => {
    const live = menu === null ? null : resolveTableRow(editor, menu);
    if (menu === null || live === null) return;
    acted.current = moveTableRow(editor, menu, live.rowIndex + (direction === -1 ? -1 : 2));
    setTarget(null);
    if (acted.current) editor.view.focus();
  };
  const indicate = (point: { x: number; y: number }): void => {
    if (drag.current === null) return;
    drag.current.point = point;
    const current = geometryRef.current;
    const frame = host.current;
    setGap(current === null || frame === null ? null : rowGap(current, frame.getBoundingClientRect(), point));
  };
  const button = "ub-table-control";
  // Keep the manager alive while controls hide, so pickup listeners are ready
  // and a drop can finish its renderer transition before restoring the caret.
  return (
    <DragDropProvider sensors={tableRowSensors}
      plugins={(defaults) => defaults.filter((plugin) => plugin !== Feedback && plugin !== Accessibility)}
      onBeforeDragStart={(event) => {
        const target = event.operation.source?.data.target as TableRowTarget | undefined;
        const live = target === undefined ? null : resolveTableRow(editor, target);
        if (live === null || live.rowIndex === 0 || menuRef.current !== null) event.preventDefault();
      }}
      onDragStart={(event, manager) => {
        const target = event.operation.source?.data.target as TableRowTarget;
        dragged.current = true;
        drag.current = { target, manager, point: event.operation.position.current, focused: editor.isFocused };
        indicate(event.operation.position.current);
      }}
      onDragMove={(event) => {
        // dnd-kit publishes dragmove before updating position.current.
        if (event.to !== undefined) indicate(event.to);
      }}
      onDragEnd={(event, manager) => {
        const active = drag.current;
        const current = geometryRef.current;
        const frame = host.current;
        drag.current = null;
        setGap(null);
        if (active === null) return;
        let moved = false;
        let caretTarget: TableRowTarget | null = null;
        if (!event.canceled && current !== null && frame !== null) {
          const native = event.nativeEvent;
          const point = native instanceof PointerEvent ? { x: native.clientX, y: native.clientY } : active.point;
          const destination = rowGap(current, frame.getBoundingClientRect(), point);
          const source = resolveTableRow(editor, active.target);
          moved = destination !== null && moveTableRow(editor, active.target, destination);
          if (moved && source !== null && destination !== null) {
            caretTarget = tableRowTarget(editor, tableId, destination > source.rowIndex ? destination - 1 : destination);
          }
        }
        // PreventSelection clears native ranges, but PM retains its selection
        // and maps it through received edits. On a no-op, focus() redraws that
        // selection only if the editor already had focus; only a move needs a
        // new caret in the copied row.
        if (moved || active.focused) {
          const target = caretTarget;
          const win = editor.view.dom.ownerDocument.defaultView;
          const restore = (): void => {
            if (editor.isDestroyed) return;
            // The React renderer completes dropping asynchronously. Waiting
            // for idle avoids restoring a range while its guard is still live.
            if (!manager.dragOperation.status.idle) { win?.requestAnimationFrame(restore); return; }
            if (target !== null) {
              const live = resolveTableRow(editor, target);
              if (live === null) return;
              editor.commands.setTextSelection(live.rowPos + 3);
            }
            editor.view.focus();
          };
          win?.requestAnimationFrame(restore);
        }
      }}>
    {geometry !== null && <div ref={controls} className="ub-table-controls" data-table-id={geometry.tableId} data-touch={geometry.touch}
      style={{ left: geometry.left, top: geometry.top, width: geometry.width, height: geometry.height }}>
      {gap !== null && <div className="ub-table-row-drop" data-gap={gap}
        style={{ top: geometry.rows[gap - 1]?.bottom, width: geometry.viewportWidth }} />}
      <div ref={columnStrip} className="ub-table-column-controls" style={{ width: geometry.viewportWidth }}
        onScroll={(event) => {
          // Only native control focus drives the table back. A programmatic
          // strip scroll follows the table and must never feed an old offset
          // back into it while a cell-formatting field owns focus.
          if (!event.currentTarget.contains(editor.view.dom.ownerDocument.activeElement)) return;
          const found = findBlockById(editor.state.doc, geometry.tableId);
          const wrapper = found === null ? null : editor.view.nodeDOM(found.pos);
          if (wrapper instanceof HTMLElement) {
            wrapper.scrollLeft = event.currentTarget.scrollLeft;
            refresh.current();
          }
        }}>
      <div style={{ position: "relative", width: geometry.scrollWidth, height: 44 }}>
      {geometry.columns.map((left, boundary) => (
        // These buttons name positional boundaries, not persistent cells.
        // biome-ignore lint/suspicious/noArrayIndexKey: boundary is the action's column coordinate.
        <button key={boundary} type="button" className={button}
          style={{ left, top: 0, width: size, height: size }}
          aria-label={boundary === 0 ? "Insert column before 1" : `Insert column after ${boundary}`}
          title="Insert column · Control+Alt+Left/Right from a cell; Control+Alt+T reaches controls"
          aria-keyshortcuts="Control+Alt+T"
          onMouseDown={(event) => event.preventDefault()}
          onClick={() => act(0, boundary === 0 ? 0 : boundary - 1, boundary === 0 ? "column-before" : "column-after")}>
          <span aria-hidden="true">+</span>
        </button>
      ))}
      </div>
      </div>
      {geometry.rows.map((row, index) => (
        <button key={`insert-${row.key}`} type="button" className={button}
          style={{ right: 44, top: row.bottom - size / 2, width: size, height: size }}
          aria-label={`Insert row after ${index + 1}`} title="Insert row · Control+Alt+Up/Down from a cell"
          onMouseDown={(event) => event.preventDefault()}
          onClick={() => act(index, 0, "row-after")}>
          <span aria-hidden="true">+</span>
        </button>
      ))}
      {geometry.rows.map((row, index) => geometry.touch && geometry.caretRow !== index && openRow !== index && drag.current?.target.row !== row.target.row ? null : (
        <DropdownMenu key={row.key} modal={false} open={openRow === index}
          onOpenChange={(open) => {
            if (open) acted.current = false;
            setTarget(open ? row.target : null);
          }}>
          <TableRowHandle target={row.target} index={index} rowKey={row.key} middle={row.middle} size={size}
            resetGuard={() => { if (drag.current === null) dragged.current = false; }}
            clickGuard={(event) => {
              if (!dragged.current || event.detail === 0) return;
              dragged.current = false;
              event.preventDefault();
              event.stopPropagation();
            }}
            open={() => { acted.current = false; setTarget(openRow === index ? null : row.target); }} />
          <DropdownMenuContent align="end" collisionPadding={8}
            onCloseAutoFocus={(event) => {
              // Retain the trigger through Radix's close/focus phase on touch,
              // where neither hover nor editor focus keeps it mounted.
              closing.current = false;
              queueMicrotask(() => refresh.current());
              if (!acted.current) return;
              event.preventDefault();
              editor.view.focus();
              refresh.current();
            }}>
            <DropdownMenuItem className="min-h-11" disabled={index <= 1} onSelect={() => moveRow(-1)}>Move row up</DropdownMenuItem>
            <DropdownMenuItem className="min-h-11" disabled={index === 0 || index === geometry.rows.length - 1} onSelect={() => moveRow(1)}>Move row down</DropdownMenuItem>
            <DropdownMenuItem className="min-h-11" disabled={index === 0} onSelect={() => act(index, 0, "row-before", true)}>Insert row above</DropdownMenuItem>
            <DropdownMenuItem className="min-h-11" onSelect={() => act(index, 0, "row-after", true)}>Insert row below</DropdownMenuItem>
            <DropdownMenuItem className="min-h-11" disabled={index === 0} variant="destructive" onSelect={() => act(index, 0, "row-delete", true)}>Delete row</DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      ))}
    </div>}
    </DragDropProvider>
  );
}

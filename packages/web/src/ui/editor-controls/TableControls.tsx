/** Quiet table affordances compose framework gestures and live shared edits. */
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import type { ReactElement, RefObject } from "react";
import type { Editor } from "@tiptap/core";
import { DragDropProvider } from "@dnd-kit/react";
import type { DragDropManager } from "@dnd-kit/react";
import { Accessibility, Feedback } from "@dnd-kit/dom";
import { findBlockById } from "../../editor/block-menu.js";
import { isOrdinaryTable } from "../../editor/table.js";
import { actOnTable, deleteTableColumn, moveTableColumn, moveTableRow, resolveTableColumn, resolveTableRow, tableColumnTargets, tableRowTarget, tableRowTargets } from "../../editor/table-controls.js";
import type { TableAction, TableColumnTarget, TableRowTarget } from "../../editor/table-controls.js";
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger,
} from "../shadcn/dropdown-menu.js";
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
  columnTargets: { key: number; target: TableColumnTarget }[];
  rows: { key: number; target: TableRowTarget; middle: number; bottom: number }[];
  caretRow: number | null;
  hoveredRow: number | null;
  focusedRow: number | null;
  caretColumn: number | null;
  hoveredColumn: number | null;
  focusedColumn: number | null;
  touch: boolean;
}

function caretTable(editor: Editor): { id: string; row: number; column: number } | null {
  const { $head } = editor.state.selection;
  const id: unknown = $head.depth > 1 && $head.node(1).type.name === "table" ? $head.node(1).attrs.id : null;
  return typeof id === "string" ? { id, row: $head.index(1), column: $head.index(2) } : null;
}

function tableIdAt(target: EventTarget | null): string | null {
  const element = target instanceof Element ? target : target instanceof Node ? target.parentElement : null;
  const controls = element?.closest<HTMLElement>(".ub-table-controls");
  if (controls !== null && controls !== undefined) return controls.dataset.tableId ?? null;
  return element?.closest(".tableWrapper")?.querySelector("table")?.id || null;
}

function rowAt(target: EventTarget | null): number | null {
  const element = target instanceof Element ? target : target instanceof Node ? target.parentElement : null;
  const control = element?.closest<HTMLElement>("[data-table-row]");
  return control === null || control === undefined ? null : Number(control.dataset.tableRow);
}

function columnAt(target: EventTarget | null): number | null {
  const element = target instanceof Element ? target : target instanceof Node ? target.parentElement : null;
  const control = element?.closest<HTMLElement>("[data-table-column]");
  return control === null || control === undefined ? null : Number(control.dataset.tableColumn);
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

// biome-ignore lint/complexity/noExcessiveLinesPerFunction: This function predates the length limit.
function TableControlSurface({ tableId, editor, host }: {
  tableId: string;
  editor: Editor;
  host: RefObject<HTMLElement | null>;
}): ReactElement | null {
  const [geometry, setGeometry] = useState<Geometry | null>(null);
  const [menu, setMenu] = useState<TableRowTarget | null>(null);
  const menuRef = useRef<TableRowTarget | null>(null);
  const [columnMenu, setColumnMenu] = useState<TableColumnTarget | null>(null);
  const columnMenuRef = useRef<TableColumnTarget | null>(null);
  const hovered = useRef<{ id: string; row: number | null; column?: number | null; x?: number | undefined; y?: number | undefined } | null>(null);
  const touch = useRef(editor.view.dom.ownerDocument.defaultView?.matchMedia?.("(pointer: coarse)").matches ?? false);
  const lastTouch = useRef<{ x: number; y: number } | null>(null);
  const pendingFocus = useRef(false);
  const controls = useRef<HTMLDivElement | null>(null);
  const columnStrip = useRef<HTMLDivElement | null>(null);
  const focusDestination = useRef<EventTarget | null>(null);
  const targetKeys = useRef(new WeakMap<TableRowTarget["row"], number>());
  const nextTargetKey = useRef(0);
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
    if (target !== null) { columnMenuRef.current = null; setColumnMenu(null); }
    menuRef.current = target;
    setMenu(target);
  }, []);
  const setColumnTarget = useCallback((target: TableColumnTarget | null): void => {
    if (target === null && columnMenuRef.current !== null) closing.current = true;
    if (target !== null) {
      closing.current = false;
      menuRef.current = null;
      setMenu(null);
    }
    columnMenuRef.current = target;
    setColumnMenu(target);
  }, []);

  // biome-ignore lint/complexity/noExcessiveLinesPerFunction: This function predates the length limit.
  useEffect(() => {
    const frame = host.current;
    if (frame === null) return;
    const dom = editor.view.dom;
    const owner = dom.ownerDocument;
    const win = owner.defaultView;
    // biome-ignore lint/complexity/noExcessiveCognitiveComplexity: This function predates the complexity limit.
    const read = (): void => {
      if (editor.isDestroyed) return;
      if (drag.current !== null && resolveTableRow(editor, drag.current.target) === null) cancelDrag();
      let target = menuRef.current;
      let columnTarget = columnMenuRef.current;
      if (columnTarget !== null && resolveTableColumn(editor, columnTarget) === null) {
        columnMenuRef.current = null;
        setColumnMenu(null);
        columnTarget = null;
        closing.current = true;
      }
      if (target !== null && resolveTableRow(editor, target) === null) {
        menuRef.current = null;
        setMenu(null);
        target = null;
      }
      const caret = caretTable(editor);
      const focusTarget = focusDestination.current ?? owner.activeElement;
      const focused = tableIdAt(focusTarget);
      const eligible = drag.current !== null || closing.current || target?.tableId === tableId || columnTarget?.tableId === tableId || focused === tableId || editor.isFocused && caret?.id === tableId || hovered.current?.id === tableId;
      const id = tableId;
      const found = eligible ? findBlockById(editor.state.doc, id) : null;
      if (!editor.isEditable || found === null || !isOrdinaryTable(found.node)) {
        menuRef.current = null;
        setMenu(null);
        columnMenuRef.current = null;
        setColumnMenu(null);
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
      const width = Math.min(box.width, table.getBoundingClientRect().width);
      const header = table.rows[0];
      const cells = Array.from(header?.cells ?? []);
      const first = cells[0];
      const edges = first === undefined ? [] : [first.getBoundingClientRect().left, ...cells.map((cell) => cell.getBoundingClientRect().right)];
      const targets = tableRowTargets(editor, id);
      const columnTargets = tableColumnTargets(editor, id);
      if (targets === null || columnTargets === null) { setGeometry(null); return; }
      const columns = columnTargets.map((target) => {
        let key = targetKeys.current.get(target.cell);
        if (key === undefined) {
          key = nextTargetKey.current++;
          targetKeys.current.set(target.cell, key);
        }
        return { key, target };
      });
      const rows: Geometry["rows"] = [];
      for (const [index, row] of Array.from(table.rows).entries()) {
        const target = targets[index];
        if (target === undefined) { setGeometry(null); return; }
        let key = targetKeys.current.get(target.row);
        if (key === undefined) {
          key = nextTargetKey.current++;
          targetKeys.current.set(target.row, key);
        }
        const rect = row.getBoundingClientRect();
        rows.push({ key, target, middle: (rect.top + rect.bottom) / 2 - box.top, bottom: rect.bottom - box.top });
      }
      let hoveredColumn = hovered.current?.id === id ? hovered.current.column ?? null : null;
      const pointerX = hovered.current?.id === id ? hovered.current.x : undefined;
      if (pointerX !== undefined) {
        const index = cells.findIndex((cell) => {
          const rect = cell.getBoundingClientRect();
          return pointerX >= rect.left && pointerX < rect.right;
        });
        hoveredColumn = index < 0 ? null : index;
      }
      let hoveredRow = hovered.current?.id === id ? hovered.current.row : null;
      const pointerY = hovered.current?.id === id ? hovered.current.y : undefined;
      if (pointerY !== undefined) {
        // Collapsed borders can hit-test as the next row in Chromium. Resolve
        // the pointer against the fresh boxes that also draw the controls,
        // including the first hover after a hidden table moves or reflows.
        const y = pointerY - box.top;
        const index = rows.findIndex((row) => y >= 2 * row.middle - row.bottom && y <= row.bottom);
        hoveredRow = index < 0 ? null : index;
      }
      const next: Geometry = {
        tableId: id, left: box.left - base.left, top: box.top - base.top,
        width, viewportWidth: width, height: wrapper.clientHeight, scrollLeft: wrapper.scrollLeft,
        // Keep the native scroll range while retaining fractional CSS bounds.
        scrollWidth: wrapper.scrollWidth - wrapper.clientWidth + width,
        // A native scroll strip keeps every column in keyboard order. Focus
        // scrolls it normally, and its scroll also brings the table along.
        columns: edges.map((edge) => edge - box.left + wrapper.scrollLeft),
        columnTargets: columns,
        rows,
        caretRow: caret?.id === id ? caret.row : null,
        hoveredRow,
        focusedRow: focused === id ? rowAt(focusTarget) : null,
        caretColumn: caret?.id === id ? caret.column : null,
        hoveredColumn,
        focusedColumn: focused === id ? columnAt(focusTarget) : null,
        touch: touch.current,
      };
      geometryRef.current = next;
      setGeometry(next);
      if (drag.current !== null) setGap(rowGap(next, base, drag.current.point));
    };
    const move = (event: PointerEvent): void => {
      if (event.pointerType === "touch") {
        lastTouch.current = { x: event.clientX, y: event.clientY };
        return;
      }
      // WebKit can emit stationary compatibility hover at the last touch
      // point during reflow/scroll. It is not a switch to mouse input.
      if (touch.current && event.pointerType === "mouse" && event.movementX === 0 && event.movementY === 0
        && lastTouch.current?.x === event.clientX && lastTouch.current.y === event.clientY) return;
      touch.current = false;
      lastTouch.current = null;
      const id = tableIdAt(event.target);
      const element = event.target instanceof Element ? event.target : null;
      hovered.current = id === null ? null : {
        id, row: rowAt(event.target), column: columnAt(event.target),
        x: element?.closest(".tableWrapper") ? event.clientX : undefined,
        y: element?.closest(".tableWrapper") ? event.clientY : undefined,
      };
      // The column strip straddles the top border without intercepting cell
      // input between its buttons. Keep the short path through that empty
      // space alive using its box, rather than a pointer-catching gutter.
      if (id === null && columnStrip.current !== null) {
        const box = columnStrip.current.getBoundingClientRect();
        if (event.clientX >= box.left && event.clientX <= box.right && event.clientY >= box.top && event.clientY <= box.bottom) {
          hovered.current = { id: tableId, row: null, x: event.clientX };
        }
      }
      read();
    };
    const press = (event: PointerEvent): void => {
      touch.current = event.pointerType === "touch";
      lastTouch.current = touch.current ? { x: event.clientX, y: event.clientY } : null;
      if (touch.current) hovered.current = null;
      else {
        const id = tableIdAt(event.target);
        const element = event.target instanceof Element ? event.target : null;
        hovered.current = id === null ? null : {
          id, row: rowAt(event.target), column: columnAt(event.target),
          x: element?.closest(".tableWrapper") ? event.clientX : undefined,
          y: element?.closest(".tableWrapper") ? event.clientY : undefined,
        };
      }
      read();
    };
    const leave = (): void => { hovered.current = null; read(); };
    const focus = (): void => {
      focusDestination.current = null;
      const strip = columnStrip.current;
      if (strip?.contains(owner.activeElement)) {
        const active = owner.activeElement;
        // Chromium's focus scroll can leave a partially clipped button's
        // centre outside the strip. The browser can reveal the whole target.
        if (active instanceof HTMLElement && columnAt(active) !== null) active.scrollIntoView({ block: "nearest", inline: "nearest" });
        const found = findBlockById(editor.state.doc, tableId);
        const wrapper = found === null ? null : editor.view.nodeDOM(found.pos);
        // Copy the native offset before measuring or its queued scroll event,
        // so a render cannot reset it.
        if (wrapper instanceof HTMLElement) wrapper.scrollLeft = strip.scrollLeft;
      }
      read();
    };
    // A native Tab focusout can run microtasks before focusin. Its related
    // target keeps the destination mounted during that browser-owned transfer.
    const blur = (event?: unknown): void => {
      if (event instanceof FocusEvent) focusDestination.current = event.relatedTarget;
      queueMicrotask(read);
    };
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
        columnMenuRef.current = null;
        setColumnMenu(null);
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
  useLayoutEffect(() => { columnMenuRef.current = columnMenu; refresh.current(); }, [columnMenu]);

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
  const openColumn = columnMenu === null ? null : resolveTableColumn(editor, columnMenu)?.columnIndex;
  const columnVisible = (index: number): boolean => geometry !== null && (
    geometry.hoveredColumn === index || geometry.caretColumn === index || geometry.focusedColumn === index || openColumn === index
  );
  const rowVisible = (index: number): boolean => geometry !== null && (
    geometry.hoveredRow === index || geometry.caretRow === index || geometry.focusedRow === index ||
    openRow === index || drag.current?.target.row === geometry.rows[index]?.target.row
  );
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
  const deleteColumn = (): void => {
    const target = columnMenuRef.current;
    acted.current = target !== null && deleteTableColumn(editor, target);
    setColumnTarget(null);
    if (acted.current) editor.view.focus();
  };
  const moveColumn = (direction: -1 | 1): void => {
    const target = columnMenuRef.current;
    acted.current = target !== null && moveTableColumn(editor, target, direction);
    setColumnTarget(null);
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
        if (live === null || live.rowIndex === 0 || menuRef.current !== null || columnMenuRef.current !== null) event.preventDefault();
      }}
      onDragStart={(event, manager) => {
        const target = event.operation.source?.data.target as TableRowTarget;
        dragged.current = true;
        drag.current = { target, manager, point: event.operation.position.current, focused: editor.isFocused };
        indicate(event.operation.position.current);
        refresh.current();
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
      <div ref={columnStrip} className="ub-table-column-controls"
        style={{ left: "calc(0px - var(--ub-table-control-overhang))", top: -size / 2,
          width: `calc(${geometry.viewportWidth}px + 2 * var(--ub-table-control-overhang))`, height: size }}
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
      <div style={{ position: "relative", width: `calc(${geometry.scrollWidth}px + 2 * var(--ub-table-control-overhang))`, height: size }}>
      {geometry.columns.map((left, boundary) => (
        // These buttons name positional boundaries, not persistent cells.
        // Touch outer targets move inward only where the pane's padding
        // cannot hold half a target; inner boundaries still centre on cells.
        // biome-ignore lint/suspicious/noArrayIndexKey: boundary is the action's column coordinate.
        <button key={boundary} type="button" className={button}
          style={{ left: geometry.touch
            ? `clamp(0px, calc(${left - size / 2}px + var(--ub-table-control-overhang)), calc(100% - ${size}px))`
            : left, top: 0, width: size, height: size }}
          aria-label={boundary === 0 ? "Insert column before 1" : `Insert column after ${boundary}`}
          title="Insert column · Control+Alt+Left/Right from a cell; Control+Alt+T reaches controls"
          aria-keyshortcuts="Control+Alt+T"
          onMouseDown={(event) => event.preventDefault()}
          onClick={() => act(0, boundary === 0 ? 0 : boundary - 1, boundary === 0 ? "column-before" : "column-after")}>
          <span aria-hidden="true">+</span>
        </button>
      ))}
      {geometry.columnTargets.map((column, index) => (
        <DropdownMenu key={column.key} modal={false} open={openColumn === index}
          onOpenChange={(open) => {
            if (open) acted.current = false;
            setColumnTarget(open ? column.target : null);
          }}>
          <DropdownMenuTrigger asChild>
            <button type="button" className={button} data-table-column={index} data-revealed={columnVisible(index)}
              style={{ left: `calc(${((geometry.columns[index] ?? 0) + (geometry.columns[index + 1] ?? 0)) / 2 - size / 2}px + var(--ub-table-control-overhang))`,
                top: 0, width: size, height: size }}
              aria-label={`Column ${index + 1} actions`} title="Column actions · Control+Alt+T reaches controls">
              <span aria-hidden="true">⋯</span>
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="center" collisionPadding={8}
            onCloseAutoFocus={(event) => {
              closing.current = false;
              queueMicrotask(() => refresh.current());
              if (!acted.current && resolveTableColumn(editor, column.target) !== null) return;
              event.preventDefault();
              editor.view.focus();
              refresh.current();
            }}>
            <DropdownMenuItem className="min-h-11" disabled={index === 0}
              onSelect={() => moveColumn(-1)}>Move column left</DropdownMenuItem>
            <DropdownMenuItem className="min-h-11" disabled={index === geometry.columnTargets.length - 1}
              onSelect={() => moveColumn(1)}>Move column right</DropdownMenuItem>
            <DropdownMenuItem className="min-h-11" variant="destructive" disabled={geometry.columnTargets.length === 1}
              onSelect={deleteColumn}>Delete column</DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      ))}
      </div>
      </div>
      {geometry.rows.map((row, index) => (
        <button key={`insert-${row.key}`} type="button" className={button}
          data-table-row={index} data-revealed={rowVisible(index)}
          style={{ right: "calc(0px - var(--ub-table-control-overhang))", top: row.bottom - size / 2, width: size, height: size }}
          aria-label={`Insert row after ${index + 1}`} title="Insert row · Control+Alt+Up/Down from a cell"
          onMouseDown={(event) => event.preventDefault()}
          onClick={() => act(index, 0, "row-after")}>
          <span aria-hidden="true">+</span>
        </button>
      ))}
      {geometry.rows.map((row, index) => (
        <DropdownMenu key={row.key} modal={false} open={openRow === index}
          onOpenChange={(open) => {
            if (open) acted.current = false;
            setTarget(open ? row.target : null);
          }}>
          <TableRowHandle target={row.target} index={index} rowKey={row.key} bottom={row.bottom} size={size}
            revealed={rowVisible(index)}
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

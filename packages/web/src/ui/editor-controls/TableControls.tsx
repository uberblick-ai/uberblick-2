/** Quiet table affordances compose framework gestures and live shared edits. */
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import type { MouseEvent as ReactMouseEvent, ReactElement, RefObject } from "react";
import type { Editor } from "@tiptap/core";
import { DragDropProvider } from "@dnd-kit/react";
import type { DragDropManager } from "@dnd-kit/react";
import { Accessibility, Feedback } from "@dnd-kit/dom";
import { findBlockById } from "../../editor/blocks.js";
import { isOrdinaryTable } from "../../editor/table.js";
import { actOnTable, deleteTableColumn, moveTableColumn, moveTableColumnToGap, moveTableRow, resolveTableColumn, resolveTableRow, tableColumnTargets, tableRowTarget, tableRowTargets } from "../../editor/table-controls.js";
import type { TableAction, TableColumnTarget, TableRowTarget } from "../../editor/table-controls.js";
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger,
} from "../shadcn/dropdown-menu.js";
import { TableHandle, tableRowSensors } from "./table-row-drag.js";
import type { TableDragData } from "./table-row-drag.js";
import { useEditorControlsHost } from "./EditorControlsHost.js";

interface Gap { kind: "row" | "column"; index: number }

interface DragState { data: TableDragData; manager: DragDropManager; point: { x: number; y: number }; focused: boolean }

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

/** Map the live pointer to a column gap, from before the first column to after the last. */
function columnGap(geometry: Geometry, base: DOMRect, point: { x: number; y: number }): number | null {
  // A release beside the visible table cancels, like one above or below it.
  const visible = point.x - base.left - geometry.left;
  const x = visible + geometry.scrollLeft;
  const y = point.y - base.top - geometry.top;
  const last = geometry.rows.at(-1);
  if (last === undefined || geometry.columns.length < 2 || visible < 0 || visible > geometry.width
    || y < -24 || y > last.bottom + 22) return null;
  for (let index = 0; index < geometry.columns.length - 2; index += 1) {
    const left = geometry.columns[index];
    const right = geometry.columns[index + 1];
    if (left !== undefined && right !== undefined && x < (left + right) / 2) return index;
  }
  const left = geometry.columns.at(-2);
  const right = geometry.columns.at(-1);
  return left !== undefined && right !== undefined && x < (left + right) / 2 ? geometry.columns.length - 2 : geometry.columns.length - 1;
}

function dragGap(geometry: Geometry, base: DOMRect, drag: DragState): Gap | null {
  const index = drag.data.kind === "row" ? rowGap(geometry, base, drag.point) : columnGap(geometry, base, drag.point);
  return index === null ? null : { kind: drag.data.kind, index };
}

function resolveDrag(editor: Editor, data: TableDragData): boolean {
  return data.kind === "row" ? resolveTableRow(editor, data.target) !== null : resolveTableColumn(editor, data.target) !== null;
}

type TableMenuIcon = "row-before" | "row-after" | "row-up" | "row-down" | "row-delete"
  | "column-before" | "column-after" | "column-left" | "column-right" | "column-delete";

// Line glyphs on a 16px grid: lines stand for rows or columns, a plus marks
// where one is inserted, an arrow the move and a cross the deletion.
const tableMenuPaths: Record<TableMenuIcon, string> = {
  "row-before": "M8 2v4M6 4h4M2.5 9.5h11M2.5 12.5h11",
  "row-after": "M2.5 3.5h11M2.5 6.5h11M8 10v4M6 12h4",
  "row-up": "M8 13V3M4.5 6.5 8 3l3.5 3.5",
  "row-down": "M8 3v10M4.5 9.5 8 13l3.5-3.5",
  "row-delete": "M2.5 3.5h11M2.5 12.5h11M6.5 6.5l3 3M9.5 6.5l-3 3",
  "column-before": "M4 6v4M2 8h4M9.5 2.5v11M12.5 2.5v11",
  "column-after": "M3.5 2.5v11M6.5 2.5v11M12 6v4M10 8h4",
  "column-left": "M13 8H3M6.5 4.5 3 8l3.5 3.5",
  "column-right": "M3 8h10M9.5 4.5 13 8l-3.5 3.5",
  "column-delete": "M3.5 2.5v11M12.5 2.5v11M6.5 6.5l3 3M9.5 6.5l-3 3",
};

function TableMenuGlyph({ icon }: { icon: TableMenuIcon }): ReactElement {
  return (
    <svg className="ub-table-menu-icon block size-4 shrink-0" viewBox="0 0 16 16" aria-hidden="true">
      <path d={tableMenuPaths[icon]} fill="none" stroke="currentColor" strokeWidth="1.3"
        strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
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
  const controlsHost = useEditorControlsHost();
  const [geometry, setGeometry] = useState<Geometry | null>(null);
  const [menu, setMenu] = useState<TableRowTarget | null>(null);
  const menuRef = useRef<TableRowTarget | null>(null);
  const [columnMenu, setColumnMenu] = useState<TableColumnTarget | null>(null);
  const columnMenuRef = useRef<TableColumnTarget | null>(null);
  // A right click opens one menu for both its cell's row and column.
  const [cellPoint, setCellPoint] = useState<{ x: number; y: number } | null>(null);
  const cellPointRef = useRef<{ x: number; y: number } | null>(null);
  const hovered = useRef<{ id: string; row: number | null; column?: number | null; x?: number | undefined; y?: number | undefined } | null>(null);
  const touch = useRef(editor.view.dom.ownerDocument.defaultView?.matchMedia?.("(pointer: coarse)").matches ?? false);
  const lastTouch = useRef<{ x: number; y: number } | null>(null);
  const columnStrip = useRef<HTMLDivElement | null>(null);
  const focusDestination = useRef<EventTarget | null>(null);
  const targetKeys = useRef(new WeakMap<TableRowTarget["row"], number>());
  const nextTargetKey = useRef(0);
  const refresh = useRef<() => void>(() => {});
  const acted = useRef(false);
  const closing = useRef(false);
  const drag = useRef<DragState | null>(null);
  const dragged = useRef(false);
  const [gap, setGap] = useState<Gap | null>(null);
  const geometryRef = useRef<Geometry | null>(null);
  const cancelDrag = useCallback((): void => {
    drag.current?.manager.actions.stop({ canceled: true });
    drag.current = null;
    setGap(null);
  }, []);
  const clearCell = useCallback((): void => {
    cellPointRef.current = null;
    setCellPoint(null);
  }, []);
  const setTarget = useCallback((target: TableRowTarget | null): void => {
    if (target === null && menuRef.current !== null) closing.current = true;
    if (target !== null) {
      closing.current = false;
      columnMenuRef.current = null;
      setColumnMenu(null);
    }
    clearCell();
    menuRef.current = target;
    setMenu(target);
  }, [clearCell]);
  const setColumnTarget = useCallback((target: TableColumnTarget | null): void => {
    if (target === null && columnMenuRef.current !== null) closing.current = true;
    if (target !== null) {
      closing.current = false;
      menuRef.current = null;
      setMenu(null);
    }
    clearCell();
    columnMenuRef.current = target;
    setColumnMenu(target);
  }, [clearCell]);
  const openCell = useCallback((row: TableRowTarget, column: TableColumnTarget, point: { x: number; y: number }): void => {
    closing.current = false;
    menuRef.current = row;
    setMenu(row);
    columnMenuRef.current = column;
    setColumnMenu(column);
    cellPointRef.current = point;
    setCellPoint(point);
  }, []);
  const closeMenus = useCallback((): void => {
    if (menuRef.current !== null || columnMenuRef.current !== null) closing.current = true;
    menuRef.current = null;
    setMenu(null);
    columnMenuRef.current = null;
    setColumnMenu(null);
    clearCell();
  }, [clearCell]);

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
      if (drag.current !== null && !resolveDrag(editor, drag.current.data)) cancelDrag();
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
      // A cell menu acts on both its row and its column, so it needs both.
      if (cellPointRef.current !== null && (target === null || columnTarget === null)) {
        menuRef.current = null;
        setMenu(null);
        columnMenuRef.current = null;
        setColumnMenu(null);
        cellPointRef.current = null;
        setCellPoint(null);
        target = null;
        columnTarget = null;
        closing.current = true;
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
        cellPointRef.current = null;
        setCellPoint(null);
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
      if (drag.current !== null) setGap(dragGap(next, base, drag.current));
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
      // input between its handles. Keep the short path through that empty
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
        // Chromium's focus scroll can leave a partially clipped handle's
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
  }, [geometry]);

  useEffect(() => {
    const dom = editor.view.dom;
    const context = (event: MouseEvent): void => {
      const element = event.target instanceof Element ? event.target : null;
      let cell = element?.closest<HTMLTableCellElement>("td, th") ?? null;
      // The keyboard's menu key targets the editor itself; use the caret's cell.
      const caret = cell === null && element === dom ? caretTable(editor) : null;
      if (caret !== null && caret.id === tableId) {
        cell = dom.querySelector<HTMLTableElement>(`table[id="${CSS.escape(tableId)}"]`)?.rows[caret.row]?.cells[caret.column] ?? null;
      }
      const row = cell?.closest("tr");
      const table = row?.closest("table");
      if (cell === null || row === null || row === undefined || table === null || table === undefined) return;
      if (table.id !== tableId) return;
      const target = tableRowTarget(editor, table.id, Array.from(table.rows).indexOf(row));
      const column = tableColumnTargets(editor, table.id)?.[cell.cellIndex];
      if (target === null || column === undefined) return;
      event.preventDefault();
      acted.current = false;
      const box = cell.getBoundingClientRect();
      const pointer = event.clientX !== 0 || event.clientY !== 0;
      openCell(target, column, pointer ? { x: event.clientX, y: event.clientY } : { x: box.left, y: box.bottom });
    };
    dom.addEventListener("contextmenu", context);
    return () => dom.removeEventListener("contextmenu", context);
  }, [editor, openCell, tableId]);

  const size = geometry?.touch ? 44 : 24;
  // Mouse handles are thin, so they straddle a border without covering text.
  const thin = geometry?.touch ? 44 : 12;
  const openRow = menu === null ? null : resolveTableRow(editor, menu)?.rowIndex ?? null;
  const openColumn = columnMenu === null ? null : resolveTableColumn(editor, columnMenu)?.columnIndex ?? null;
  const rowCount = geometry?.rows.length ?? 0;
  const columnCount = geometry?.columnTargets.length ?? 0;
  const dragging = drag.current?.data;
  // Pointers reveal by hover alone. Touch has no hover, so its caret reveals.
  const columnVisible = (index: number): boolean => geometry !== null && (
    geometry.hoveredColumn === index || geometry.touch && geometry.caretColumn === index || geometry.focusedColumn === index ||
    cellPoint === null && openColumn === index ||
    dragging?.kind === "column" && dragging.target.cell === geometry.columnTargets[index]?.target.cell
  );
  const rowVisible = (index: number): boolean => geometry !== null && (
    geometry.hoveredRow === index || geometry.touch && geometry.caretRow === index || geometry.focusedRow === index ||
    cellPoint === null && openRow === index ||
    dragging?.kind === "row" && dragging.target.row === geometry.rows[index]?.target.row
  );
  const finish = (): void => {
    closeMenus();
    if (acted.current) editor.view.focus();
  };
  const act = (target: TableRowTarget | null | undefined, column: number, action: TableAction): void => {
    acted.current = target !== null && target !== undefined && actOnTable(editor, target, column, action);
    finish();
  };
  const insertColumn = (action: "column-before" | "column-after"): void => {
    const live = columnMenuRef.current === null ? null : resolveTableColumn(editor, columnMenuRef.current);
    act(menuRef.current ?? geometry?.rows[0]?.target, live?.columnIndex ?? -1, action);
  };
  const moveRow = (direction: -1 | 1): void => {
    const target = menuRef.current;
    const live = target === null ? null : resolveTableRow(editor, target);
    acted.current = target !== null && live !== null && moveTableRow(editor, target, live.rowIndex + (direction === -1 ? -1 : 2));
    finish();
  };
  const deleteColumn = (): void => {
    const target = columnMenuRef.current;
    acted.current = target !== null && deleteTableColumn(editor, target);
    finish();
  };
  const moveColumn = (direction: -1 | 1): void => {
    const target = columnMenuRef.current;
    acted.current = target !== null && moveTableColumn(editor, target, direction);
    finish();
  };
  // Compact rows on a pointer device; touch keeps 44px targets.
  const item = (key: TableMenuIcon, label: string, disabled: boolean, onSelect: () => void, destructive = false): ReactElement =>
    <DropdownMenuItem key={key} className={geometry?.touch === true ? "min-h-11" : "py-1!"}
      variant={destructive ? "destructive" : "default"} disabled={disabled} onSelect={onSelect}>
      <TableMenuGlyph icon={key} />{label}
    </DropdownMenuItem>;
  const rowItems = (index: number | null): ReactElement[] => [
    item("row-before", "Insert row above", index === null || index === 0, () => act(menuRef.current, 0, "row-before")),
    item("row-after", "Insert row below", index === null, () => act(menuRef.current, 0, "row-after")),
  ];
  const rowMoves = (index: number | null): ReactElement[] => [
    item("row-up", "Move row up", index === null || index <= 1, () => moveRow(-1)),
    item("row-down", "Move row down", index === null || index === 0 || index === rowCount - 1, () => moveRow(1)),
  ];
  const rowDelete = (index: number | null): ReactElement =>
    item("row-delete", "Delete row", index === null || index === 0, () => act(menuRef.current, 0, "row-delete"), true);
  const columnItems = (index: number | null): ReactElement[] => [
    item("column-before", "Insert column left", index === null, () => insertColumn("column-before")),
    item("column-after", "Insert column right", index === null, () => insertColumn("column-after")),
  ];
  const columnMoves = (index: number | null): ReactElement[] => [
    item("column-left", "Move column left", index === null || index === 0, () => moveColumn(-1)),
    item("column-right", "Move column right", index === null || index === columnCount - 1, () => moveColumn(1)),
  ];
  const columnDelete = (index: number | null): ReactElement =>
    item("column-delete", "Delete column", index === null || columnCount === 1, deleteColumn, true);
  const closeFocus = (event: Event, keep: boolean): void => {
    closing.current = false;
    queueMicrotask(() => refresh.current());
    if (keep && !acted.current) return;
    event.preventDefault();
    editor.view.focus();
    refresh.current();
  };
  const guards = {
    resetGuard: (): void => { if (drag.current === null) dragged.current = false; },
    clickGuard: (event: ReactMouseEvent<HTMLButtonElement>): void => {
      if (!dragged.current || event.detail === 0) return;
      dragged.current = false;
      event.preventDefault();
      event.stopPropagation();
    },
  };
  const indicate = (point: { x: number; y: number }): void => {
    const active = drag.current;
    if (active === null) return;
    active.point = point;
    const current = geometryRef.current;
    const frame = host.current;
    setGap(current === null || frame === null ? null : dragGap(current, frame.getBoundingClientRect(), active));
  };
  const frameBox = cellPoint === null ? null : host.current?.getBoundingClientRect() ?? null;
  const anchor = frameBox === null || geometry === null || cellPoint === null ? null
    : { left: cellPoint.x - frameBox.left - geometry.left, top: cellPoint.y - frameBox.top - geometry.top };
  const columnDrop = gap?.kind === "column" && geometry !== null ? (geometry.columns[gap.index] ?? 0) - geometry.scrollLeft : null;
  // Keep the manager alive while controls hide, so pickup listeners are ready
  // and a drop can finish its renderer transition before restoring the caret.
  return (
    <DragDropProvider sensors={tableRowSensors}
      plugins={(defaults) => defaults.filter((plugin) => plugin !== Feedback && plugin !== Accessibility)}
      onBeforeDragStart={(event) => {
        const data = event.operation.source?.data as TableDragData | undefined;
        const allowed = data?.kind === "row" ? (resolveTableRow(editor, data.target)?.rowIndex ?? 0) > 0
          : data?.kind === "column" && (resolveTableColumn(editor, data.target)?.node.child(0).childCount ?? 1) > 1;
        if (!allowed || menuRef.current !== null || columnMenuRef.current !== null) event.preventDefault();
      }}
      onDragStart={(event, manager) => {
        const data = event.operation.source?.data as TableDragData;
        dragged.current = true;
        drag.current = { data, manager, point: event.operation.position.current, focused: editor.isFocused };
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
        let caret: (() => number | null) | null = null;
        if (!event.canceled && current !== null && frame !== null) {
          const native = event.nativeEvent;
          active.point = native instanceof PointerEvent ? { x: native.clientX, y: native.clientY } : active.point;
          const destination = dragGap(current, frame.getBoundingClientRect(), active)?.index ?? null;
          if (active.data.kind === "row") {
            const source = resolveTableRow(editor, active.data.target);
            moved = destination !== null && moveTableRow(editor, active.data.target, destination);
            if (moved && source !== null && destination !== null) {
              const target = tableRowTarget(editor, tableId, destination > source.rowIndex ? destination - 1 : destination);
              caret = () => target === null ? null : (resolveTableRow(editor, target)?.rowPos ?? Number.NaN) + 3;
            }
          } else {
            const source = resolveTableColumn(editor, active.data.target);
            moved = destination !== null && moveTableColumnToGap(editor, active.data.target, destination);
            if (moved && source !== null && destination !== null) {
              const column = destination > source.columnIndex ? destination - 1 : destination;
              caret = () => {
                const found = findBlockById(editor.state.doc, tableId);
                if (found === null || !isOrdinaryTable(found.node)) return null;
                const header = found.node.child(0);
                if (column >= header.childCount) return null;
                let position = found.pos + 4;
                for (let index = 0; index < column; index += 1) position += header.child(index).nodeSize;
                return position;
              };
            }
          }
        }
        // PreventSelection clears native ranges, but PM retains its selection
        // and maps it through received edits. On a no-op, focus() redraws that
        // selection only if the editor already had focus; only a move needs a
        // new caret in the moved row or column.
        if (moved || active.focused) {
          const place = caret;
          const win = editor.view.dom.ownerDocument.defaultView;
          const restore = (): void => {
            if (editor.isDestroyed) return;
            // The React renderer completes dropping asynchronously. Waiting
            // for idle avoids restoring a range while its guard is still live.
            if (!manager.dragOperation.status.idle) { win?.requestAnimationFrame(restore); return; }
            if (place !== null) {
              const position = place();
              if (position === null || !Number.isFinite(position)) return;
              editor.commands.setTextSelection(position);
            }
            editor.view.focus();
          };
          win?.requestAnimationFrame(restore);
        }
      }}>
    {geometry !== null && <div className="ub-table-controls" data-table-id={geometry.tableId} data-touch={geometry.touch}
      style={{ left: geometry.left, top: geometry.top, width: geometry.width, height: geometry.height }}>
      {gap?.kind === "row" && <div className="ub-table-row-drop" data-gap={gap.index}
        style={{ top: geometry.rows[gap.index - 1]?.bottom, width: geometry.viewportWidth }} />}
      {gap?.kind === "column" && columnDrop !== null && columnDrop >= -1 && columnDrop <= geometry.viewportWidth + 1 &&
        <div className="ub-table-column-drop" data-gap={gap.index}
          style={{ left: Math.min(Math.max(columnDrop, 0), geometry.viewportWidth), height: geometry.rows.at(-1)?.bottom }} />}
      <div ref={columnStrip} className="ub-table-column-controls"
        style={{ left: "calc(0px - var(--ub-table-control-overhang))", top: -thin / 2,
          width: `calc(${geometry.viewportWidth}px + 2 * var(--ub-table-control-overhang))`, height: thin }}
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
      <div style={{ position: "relative", width: `calc(${geometry.scrollWidth}px + 2 * var(--ub-table-control-overhang))`, height: thin }}>
      {geometry.columnTargets.map((column, index) => (
        <DropdownMenu key={column.key} modal={false} open={cellPoint === null && openColumn === index}
          onOpenChange={(open) => {
            if (open) acted.current = false;
            setColumnTarget(open ? column.target : null);
          }}>
          <TableHandle data={{ kind: "column", target: column.target }} dragKey={column.key} axis="column"
            disabled={columnCount === 1} revealed={columnVisible(index)} data-table-column={index}
            label={`Column ${index + 1} actions`} {...guards}
            style={{ left: `calc(${((geometry.columns[index] ?? 0) + (geometry.columns[index + 1] ?? 0)) / 2 - size / 2}px + var(--ub-table-control-overhang))`,
              top: 0, width: size, height: thin }}
            open={() => { acted.current = false; setColumnTarget(openColumn === index && cellPoint === null ? null : column.target); }} />
          <DropdownMenuContent align="center" collisionPadding={8}
            container={controlsHost?.portalContainer}
            collisionBoundary={controlsHost?.boundary ?? []}
            onCloseAutoFocus={(event) => closeFocus(event, resolveTableColumn(editor, column.target) !== null)}>
            {columnItems(index)}
            <DropdownMenuSeparator />
            {columnMoves(index)}
            <DropdownMenuSeparator />
            {columnDelete(index)}
          </DropdownMenuContent>
        </DropdownMenu>
      ))}
      </div>
      </div>
      {geometry.rows.map((row, index) => (
        <DropdownMenu key={row.key} modal={false} open={cellPoint === null && openRow === index}
          onOpenChange={(open) => {
            if (open) acted.current = false;
            setTarget(open ? row.target : null);
          }}>
          <TableHandle data={{ kind: "row", target: row.target }} dragKey={row.key} axis="row"
            disabled={index === 0} revealed={rowVisible(index)} data-table-row={index}
            label={`Row ${index + 1} actions`} {...guards}
            // Touch targets sit on the right border, clear of the block's own
            // gutter button on the left.
            style={geometry.touch
              ? { right: "calc(0px - var(--ub-table-control-overhang))", top: row.middle - size / 2, width: size, height: size }
              : { left: -4, top: row.middle - size / 2, width: thin, height: size }}
            open={() => { acted.current = false; setTarget(openRow === index && cellPoint === null ? null : row.target); }} />
          <DropdownMenuContent align={geometry.touch ? "end" : "start"} collisionPadding={8}
            container={controlsHost?.portalContainer}
            collisionBoundary={controlsHost?.boundary ?? []}
            onCloseAutoFocus={(event) => closeFocus(event, true)}>
            {rowItems(index)}
            <DropdownMenuSeparator />
            {rowMoves(index)}
            <DropdownMenuSeparator />
            {rowDelete(index)}
          </DropdownMenuContent>
        </DropdownMenu>
      ))}
      {anchor !== null && (
        <DropdownMenu modal={false} open onOpenChange={(open) => { if (!open) closeMenus(); }}>
          <DropdownMenuTrigger asChild>
            <span className="ub-table-menu-anchor" aria-hidden="true" style={{ left: anchor.left, top: anchor.top }} />
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start" sideOffset={2} collisionPadding={8}
            aria-label="Table actions"
            container={controlsHost?.portalContainer}
            collisionBoundary={controlsHost?.boundary ?? []}
            onCloseAutoFocus={(event) => closeFocus(event, false)}>
            {rowItems(openRow)}
            {columnItems(openColumn)}
            <DropdownMenuSeparator />
            {rowMoves(openRow)}
            {columnMoves(openColumn)}
            <DropdownMenuSeparator />
            {rowDelete(openRow)}
            {columnDelete(openColumn)}
          </DropdownMenuContent>
        </DropdownMenu>
      )}
    </div>}
    </DragDropProvider>
  );
}

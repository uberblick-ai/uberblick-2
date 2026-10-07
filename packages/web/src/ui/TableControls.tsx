/** Quiet table affordances; TableKit owns edits and Radix owns the row menus. */
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import type { ReactElement, RefObject } from "react";
import type { Editor } from "@tiptap/core";
import { findBlockById } from "../editor/block-menu.js";
import { isOrdinaryTable } from "../editor/table.js";
import { actOnTable, resolveTableRow, tableRowTarget, tableRowTargets } from "../editor/table-controls.js";
import type { TableAction, TableRowTarget } from "../editor/table-controls.js";
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger,
} from "./shadcn/dropdown-menu.js";

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
  const touch = useRef(editor.view.dom.ownerDocument.defaultView?.matchMedia("(pointer: coarse)").matches ?? false);
  const pendingFocus = useRef(false);
  const controls = useRef<HTMLDivElement | null>(null);
  const columnStrip = useRef<HTMLDivElement | null>(null);
  const rowKeys = useRef(new WeakMap<TableRowTarget["row"], number>());
  const nextRowKey = useRef(0);
  const refresh = useRef<() => void>(() => {});
  const acted = useRef(false);
  const closing = useRef(false);
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
      let target = menuRef.current;
      if (target !== null && resolveTableRow(editor, target) === null) {
        menuRef.current = null;
        setMenu(null);
        target = null;
      }
      const caret = caretTable(editor);
      const focused = tableIdAt(owner.activeElement);
      const eligible = closing.current || target?.tableId === tableId || focused === tableId || editor.isFocused && caret?.id === tableId || hovered.current === tableId;
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
      setGeometry({
        tableId: id, left: box.left - base.left, top: box.top - base.top,
        width: width + 88, viewportWidth: width, height: wrapper.clientHeight, scrollLeft: wrapper.scrollLeft, scrollWidth: wrapper.scrollWidth,
        // A native scroll strip keeps every column in keyboard order. Focus
        // scrolls it normally, and its scroll also brings the table along.
        columns: edges.map((edge) => Math.max(0, Math.min(wrapper.scrollWidth - size, edge - box.left + wrapper.scrollLeft - size / 2))),
        rows,
        caretRow: caret?.id === id ? caret.row : null, touch: touch.current,
      });
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
      if (event.target instanceof HTMLElement && event.target.classList.contains("tableWrapper")) read();
    };
    const key = (event: KeyboardEvent): void => {
      if (event.isComposing || !editor.isEditable) return;
      const rowMenu = event.key === "F10" && event.shiftKey || event.ctrlKey && event.altKey && event.code === "KeyR";
      const insertion = event.ctrlKey && event.altKey && event.code === "KeyT";
      if (!rowMenu && !insertion) return;
      const caret = caretTable(editor);
      if (caret?.id !== tableId) return;
      const target = caret === null ? null : tableRowTarget(editor, caret.id, caret.row);
      if (target === null) return;
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
    frame.addEventListener("pointerdown", press);
    frame.addEventListener("pointerleave", leave);
    frame.addEventListener("scroll", scroll, true);
    owner.addEventListener("focusin", focus);
    owner.addEventListener("focusout", blur);
    win?.addEventListener("resize", read);
    editor.on("transaction", read);
    editor.on("focus", read);
    editor.on("blur", blur);
    // Table text can reflow after fonts load or the pane changes width.
    const observer = new ResizeObserver(read);
    observer.observe(dom);
    refresh.current = read;
    read();
    return () => {
      dom.removeEventListener("keydown", key);
      frame.removeEventListener("pointermove", move);
      frame.removeEventListener("pointerdown", press);
      frame.removeEventListener("pointerleave", leave);
      frame.removeEventListener("scroll", scroll, true);
      owner.removeEventListener("focusin", focus);
      owner.removeEventListener("focusout", blur);
      win?.removeEventListener("resize", read);
      editor.off("transaction", read);
      editor.off("focus", read);
      editor.off("blur", blur);
      observer.disconnect();
      refresh.current = () => {};
    };
  }, [editor, host, tableId]);

  useLayoutEffect(() => { menuRef.current = menu; refresh.current(); }, [menu]);

  useLayoutEffect(() => {
    if (columnStrip.current !== null && geometry !== null) columnStrip.current.scrollLeft = geometry.scrollLeft;
    if (!pendingFocus.current || geometry === null) return;
    pendingFocus.current = false;
    controls.current?.querySelector<HTMLButtonElement>("button")?.focus();
  }, [geometry]);

  useEffect(() => {
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
    editor.view.dom.addEventListener("contextmenu", context);
    return () => editor.view.dom.removeEventListener("contextmenu", context);
  }, [editor, setTarget, tableId]);

  if (geometry === null) return null;
  const size = geometry.touch ? 44 : 24;
  const openRow = menu === null ? null : resolveTableRow(editor, menu)?.rowIndex;
  const act = (row: number, column: number, action: TableAction, fromMenu = false): void => {
    const target = fromMenu ? menu : geometry.rows[row]?.target;
    if (target === null || target === undefined) return;
    acted.current = actOnTable(editor, target, column, action);
    setTarget(null);
    if (acted.current) editor.view.focus();
  };
  const button = "ub-table-control";
  return (
    <div ref={controls} className="ub-table-controls" data-table-id={geometry.tableId} data-touch={geometry.touch}
      style={{ left: geometry.left, top: geometry.top, width: geometry.width, height: geometry.height }}>
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
          title="Insert column · Control+Alt+T reaches table controls"
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
          aria-label={`Insert row after ${index + 1}`} title="Insert row"
          onMouseDown={(event) => event.preventDefault()}
          onClick={() => act(index, 0, "row-after")}>
          <span aria-hidden="true">+</span>
        </button>
      ))}
      {geometry.rows.map((row, index) => geometry.touch && geometry.caretRow !== index && openRow !== index ? null : (
        <DropdownMenu key={row.key} modal={false} open={openRow === index}
          onOpenChange={(open) => {
            if (open) acted.current = false;
            setTarget(open ? row.target : null);
          }}>
          <DropdownMenuTrigger asChild>
            <button type="button" className={button}
              style={{ right: 0, top: row.middle - size / 2, width: size, height: size }}
              aria-label={`Row ${index + 1} actions`} aria-keyshortcuts="Control+Alt+R Shift+F10"
              title="Row actions · Control+Alt+R or Shift+F10">
              <span aria-hidden="true">⋮</span>
            </button>
          </DropdownMenuTrigger>
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
            <DropdownMenuItem className="min-h-11" disabled={index === 0} onSelect={() => act(index, 0, "row-before", true)}>Insert row above</DropdownMenuItem>
            <DropdownMenuItem className="min-h-11" onSelect={() => act(index, 0, "row-after", true)}>Insert row below</DropdownMenuItem>
            <DropdownMenuItem className="min-h-11" disabled={index === 0} variant="destructive" onSelect={() => act(index, 0, "row-delete", true)}>Delete row</DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      ))}
    </div>
  );
}

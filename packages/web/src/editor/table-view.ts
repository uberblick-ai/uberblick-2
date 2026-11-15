/** Native, continuous read-only table. Unchanged rows retain their DOM and cells. */
import type { DataRecord } from "@uberblick/schema";
import { tableCellFormatter, tableAccessibleName, sortTableRows } from "./table-data.js";
import type { TableBarScale, TableCell, TableColumnMapping, TableProjection, TableReady } from "./table-data.js";

type TableViewProjection = TableReady | Pick<Exclude<TableProjection, TableReady>, "status" | "message">;

function renderCell(cell: HTMLTableCellElement, value: TableCell, format: TableColumnMapping["format"] | undefined,
  scale: TableBarScale | null): void {
  if (cell.dataset.state !== value.state) cell.dataset.state = value.state;
  let content = cell.firstElementChild as HTMLElement | null;
  if (content === null) {
    content = document.createElement("div");
    content.className = "ub-data-cell";
    cell.append(content);
  }
  // Scalar formatting stays on one line regardless of length. Short stored
  // text keeps explicit whitespace; only long text/markers/URLs soft-wrap.
  const short = value.text.length <= 20 || (value.text.length <= 40 && [...value.text].length <= 20);
  const wrap = value.state === "valid" && (format === "number" || format === "date")
    ? "scalar" : short ? "short" : "long";
  if (content.dataset.wrap !== wrap) content.dataset.wrap = wrap;
  if (scale !== null) {
    content.dataset.bar = "true";
    if (content.firstElementChild === null) {
      const text = document.createElement("span");
      text.className = "ub-data-value";
      const track = document.createElement("span");
      track.className = "ub-data-bar";
      track.setAttribute("aria-hidden", "true");
      const fill = document.createElement("span");
      fill.className = "ub-data-bar-fill";
      track.append(fill);
      content.append(text, track);
    }
    const text = content.firstElementChild as HTMLElement;
    const track = content.lastElementChild as HTMLElement;
    const fill = track.firstElementChild as HTMLElement;
    if (text.textContent !== value.text) text.textContent = value.text;
    track.dataset.signed = String(scale.signed);
    const fraction = value.barValue === undefined || scale.max === 0 ? 0 : Math.min(Math.abs(value.barValue) / scale.max, 1);
    const width = fraction * (scale.signed ? 50 : 100);
    fill.style.width = `${width}%`;
    fill.style.left = `${scale.signed ? value.barValue !== undefined && value.barValue < 0 ? 50 - width : 50 : 0}%`;
    return;
  }
  if (value.href !== undefined) {
    let anchor = content.firstElementChild as HTMLAnchorElement | null;
    if (anchor === null) {
      anchor = document.createElement("a");
      anchor.className = "ub-data-link";
      anchor.target = "_blank";
      anchor.rel = "noopener noreferrer";
      content.replaceChildren(anchor);
    }
    if (anchor.getAttribute("href") !== value.href) anchor.href = value.href;
    if (anchor.textContent !== value.text) anchor.textContent = value.text;
  } else if (content.firstElementChild !== null || content.textContent !== value.text) content.textContent = value.text;
}

function renderRow(row: HTMLTableRowElement, record: DataRecord, projection: TableReady,
  formatters: Array<ReturnType<typeof tableCellFormatter>>, onlyBars: boolean): void {
  formatters.forEach((format, index) => {
    const column = projection.config.columns[index];
    if (onlyBars && column?.bar === undefined) return;
    const cell = row.cells[index] ?? row.insertCell();
    renderCell(cell, format(record), column?.format, projection.barScales[index] ?? null);
  });
}

export function dataTableView(): {
  element: HTMLElement;
  render: (projection: TableViewProjection) => void;
  clear: () => void;
  resetSort: () => void;
} {
  const element = document.createElement("div");
  element.className = "ub-table-view";
  const scroll = document.createElement("div");
  scroll.className = "ub-table-scroll";
  const table = document.createElement("table");
  table.className = "ub-data-table";
  const caption = document.createElement("caption");
  caption.className = "ub-sr-only";
  const head = document.createElement("thead");
  const body = document.createElement("tbody");
  table.append(caption, head, body);
  scroll.append(table);
  let columns = "";
  let scales = "";
  let projection: TableReady | null = null;
  let readerSort: { index: number; direction: "asc" | "desc" } | null = null;
  let headers: Array<{ cell: HTMLTableCellElement; arrow: HTMLElement }> = [];
  let formatters: Array<ReturnType<typeof tableCellFormatter>> = [];
  const rendered = new Map<string, { element: HTMLTableRowElement; value: string }>();
  const clear = (): void => {
    projection = null;
    element.hidden = true;
    body.replaceChildren();
    rendered.clear();
  };
  const render = (next: TableViewProjection): void => {
    element.hidden = next.status !== "ready";
    if (next.status !== "ready") {
      clear();
      return;
    }
    projection = next;
    const { config } = next;
    const nextScales = JSON.stringify(next.barScales);
    const scaleChanged = scales !== nextScales;
    scales = nextScales;
    const chosenColumn = readerSort === null ? undefined : config.columns[readerSort.index];
    const rows = chosenColumn === undefined ? next.rows : sortTableRows(next.rows, chosenColumn, readerSort?.direction ?? "asc");
    const sort = readerSort ?? (config.sort === undefined ? null : {
      index: config.columns.findIndex(column => column.field === config.sort?.field), direction: config.sort.direction,
    });
    if (element.childElementCount === 0) element.append(scroll);
    const accessibleName = tableAccessibleName(config);
    if (caption.textContent !== accessibleName) caption.textContent = accessibleName;
    const nextColumns = JSON.stringify(config.columns);
    if (columns !== nextColumns) {
      columns = nextColumns;
      formatters = config.columns.map(column => tableCellFormatter(column));
      const row = document.createElement("tr");
      headers = config.columns.map((column, index) => {
        const cell = document.createElement("th");
        cell.scope = "col";
        const button = document.createElement("button");
        button.type = "button";
        button.className = "ub-data-sort";
        button.append(document.createTextNode(column.label?.trim() ? column.label : column.field));
        const arrow = document.createElement("span");
        arrow.setAttribute("aria-hidden", "true");
        button.addEventListener("mousedown", event => event.preventDefault());
        button.addEventListener("click", () => {
          if (projection === null) return;
          const active = cell.getAttribute("aria-sort");
          readerSort = { index, direction: active === "ascending" ? "desc" : "asc" };
          button.focus({ preventScroll: true });
          render(projection);
        });
        cell.append(button);
        row.append(cell);
        return { cell, arrow };
      });
      head.replaceChildren(row);
      body.replaceChildren();
      rendered.clear();
    }
    headers.forEach(({ cell, arrow }, index) => {
      const active = sort?.index === index;
      if (active) cell.setAttribute("aria-sort", sort.direction === "asc" ? "ascending" : "descending");
      else cell.removeAttribute("aria-sort");
      arrow.textContent = active ? sort.direction === "asc" ? "↑" : "↓" : "";
      if (active) cell.firstElementChild?.append(arrow);
      else arrow.remove();
    });
    const ids = new Set(rows.map(record => record.id));
    for (const [id, row] of rendered) {
      if (!ids.has(id)) {
        row.element.remove();
        rendered.delete(id);
      }
    }
    let cursor = body.firstElementChild;
    const additions = document.createDocumentFragment();
    for (const record of rows) {
      // Snapshots are detached anew after data changes, so references cannot
      // identify unchanged records. Compare stored values before formatting.
      const value = JSON.stringify(record.value);
      let row = rendered.get(record.id);
      if (row === undefined) {
        const element = document.createElement("tr");
        renderRow(element, record, next, formatters, false);
        row = { element, value };
        rendered.set(record.id, row);
      } else if (row.value !== value || scaleChanged) {
        renderRow(row.element, record, next, formatters, row.value === value);
        row.value = value;
      }
      if (row.element === cursor) cursor = cursor.nextElementSibling;
      else if (cursor === null) additions.append(row.element);
      else body.insertBefore(row.element, cursor);
    }
    body.append(additions);
  };
  return { element, render, clear, resetSort: () => { readerSort = null; } };
}

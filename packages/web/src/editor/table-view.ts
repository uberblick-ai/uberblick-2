/** Native, continuous read-only table. Unchanged rows retain their DOM and cells. */
import { tableCellFormatter, tableAccessibleName } from "./table-data.js";
import type { TableCell, TableColumnMapping, TableProjection } from "./table-data.js";

function renderCell(cell: HTMLTableCellElement, value: TableCell, format: TableColumnMapping["format"] | undefined): void {
  if (cell.dataset.state !== value.state) cell.dataset.state = value.state;
  let content = cell.firstElementChild as HTMLElement | null;
  if (content === null) {
    content = document.createElement("div");
    content.className = "ub-data-cell";
    cell.append(content);
  }
  // Scalar formatting stays on one line regardless of length. Short stored
  // text keeps explicit whitespace; only long text/markers/URLs soft-wrap.
  const wrap = value.state === "valid" && (format === "number" || format === "date")
    ? "scalar" : [...value.text].length <= 20 ? "short" : "long";
  if (content.dataset.wrap !== wrap) content.dataset.wrap = wrap;
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

export function dataTableView(): {
  element: HTMLElement;
  render: (projection: TableProjection) => void;
  clear: () => void;
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
  let formatters: Array<ReturnType<typeof tableCellFormatter>> = [];
  const rendered = new Map<string, { element: HTMLTableRowElement; value: string }>();
  const clear = (): void => {
    element.hidden = true;
    body.replaceChildren();
    rendered.clear();
  };
  return {
    element,
    clear,
    render: (projection) => {
      element.hidden = projection.status !== "ready";
      if (projection.status !== "ready") {
        clear();
        return;
      }
      const { config, rows } = projection;
      if (element.childElementCount === 0) element.append(scroll);
      const accessibleName = tableAccessibleName(config);
      if (caption.textContent !== accessibleName) caption.textContent = accessibleName;
      const nextColumns = JSON.stringify(config.columns);
      if (columns !== nextColumns) {
        columns = nextColumns;
        formatters = config.columns.map(column => tableCellFormatter(column));
        const headers = document.createElement("tr");
        for (const column of config.columns) {
          const cell = document.createElement("th");
          cell.scope = "col";
          cell.textContent = column.label ?? column.field;
          headers.append(cell);
        }
        head.replaceChildren(headers);
        body.replaceChildren();
        rendered.clear();
      }
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
          for (const [index, format] of formatters.entries()) {
            const cell = document.createElement("td");
            renderCell(cell, format(record), config.columns[index]?.format);
            element.append(cell);
          }
          row = { element, value };
          rendered.set(record.id, row);
        } else if (row.value !== value) {
          const cells = row.element.cells;
          formatters.forEach((format, index) => {
            const cell = cells[index];
            if (cell !== undefined) renderCell(cell, format(record), config.columns[index]?.format);
          });
          row.value = value;
        }
        if (row.element === cursor) cursor = cursor.nextElementSibling;
        else if (cursor === null) additions.append(row.element);
        else body.insertBefore(row.element, cursor);
      }
      body.append(additions);
    },
  };
}

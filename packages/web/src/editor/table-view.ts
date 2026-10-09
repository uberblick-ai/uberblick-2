/** Native, paged read-only table chrome. Only visible cells are formatted. */
import { formatTableCell, tableAccessibleName } from "./table-data.js";
import type { TableProjection } from "./table-data.js";

export function dataTableView(schedule: () => void): {
  element: HTMLElement;
  render: (projection: TableProjection) => void;
} {
  let page = 0;
  let lastPage = 0;
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
  const range = document.createElement("p");
  range.className = "ub-table-range";
  const pager = document.createElement("div");
  pager.className = "ub-table-pager";
  const previous = document.createElement("button");
  previous.type = "button";
  previous.textContent = "Previous page";
  const next = document.createElement("button");
  next.type = "button";
  next.textContent = "Next page";
  previous.addEventListener("click", () => { if (page > 0) { page -= 1; schedule(); } });
  next.addEventListener("click", () => { if (page < lastPage) { page += 1; schedule(); } });
  pager.append(previous, next);
  return {
    element,
    render: (projection) => {
      element.hidden = projection.status !== "ready";
      if (projection.status !== "ready") {
        if (projection.status === "no-records" || projection.status === "collection-absent") page = lastPage = 0;
        body.replaceChildren();
        return;
      }
      if (element.childElementCount === 0) element.append(scroll, range, pager);
      const { config, rows } = projection;
      lastPage = Math.max(0, Math.ceil(rows.length / config.pageSize) - 1);
      page = Math.min(page, lastPage);
      caption.textContent = tableAccessibleName(config);
      const headers = document.createElement("tr");
      for (const column of config.columns) {
        const cell = document.createElement("th");
        cell.scope = "col";
        cell.textContent = column.label ?? column.field;
        headers.append(cell);
      }
      head.replaceChildren(headers);
      const start = page * config.pageSize;
      const rendered = rows.slice(start, start + config.pageSize).map(record => {
        const row = document.createElement("tr");
        for (const column of config.columns) {
          const cell = document.createElement("td");
          const value = formatTableCell(column, record);
          cell.dataset.state = value.state;
          if (value.href !== undefined) {
            const anchor = document.createElement("a");
            anchor.className = "ub-data-link";
            anchor.href = value.href;
            anchor.textContent = value.text;
            anchor.target = "_blank";
            anchor.rel = "noopener noreferrer";
            cell.append(anchor);
          } else cell.textContent = value.text;
          row.append(cell);
        }
        return row;
      });
      body.replaceChildren(...rendered);
      range.hidden = rows.length <= config.pageSize;
      range.textContent = `Records ${(start + 1).toLocaleString()}–${Math.min(start + config.pageSize, rows.length).toLocaleString()} of ${rows.length.toLocaleString()}`;
      pager.hidden = rows.length <= config.pageSize;
      previous.disabled = page === 0;
      next.disabled = page === lastPage;
    },
  };
}

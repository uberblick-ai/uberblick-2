import { describe, expect, it } from "vitest";
import { getAllByRole, getByRole } from "@testing-library/dom";
import type { DataRecord } from "@uberblick/schema";
import { dataTableView } from "../src/editor/table-view.js";
import type { TableConfig, TableReady } from "../src/editor/table-data.js";

const config: TableConfig = {
  version: 1, type: "table", collection: "observations", pageSize: 1,
  columns: [{ field: "value", format: "number" }, { field: "link", format: "link" }],
};
function ready(rows: DataRecord[], mapping = config): TableReady {
  return { status: "ready", config: mapping, rows, recordCount: rows.length, invalidSchema: 0 };
}
function rows(view: ReturnType<typeof dataTableView>): HTMLTableRowElement[] {
  return [...view.element.querySelectorAll<HTMLTableRowElement>("tbody tr")];
}
function record(id: string, value: number): DataRecord {
  return { id, value: { value, link: `https://example.com/${id}` } };
}

describe("continuous native table rendering", () => {
  it.each([1, 5, 7, 100])("renders every row with legacy pageSize %s and retains native naming and headers", (pageSize) => {
    const view = dataTableView();
    view.render(ready(Array.from({ length: 101 }, (_, index) => record(String(index), index)), { ...config, pageSize, title: "Observations" }));
    expect(rows(view)).toHaveLength(101);
    expect(rows(view).map(row => row.cells[0]?.textContent)).toEqual(Array.from({ length: 101 }, (_, index) => String(index)));
    expect(view.element.querySelector("caption")?.textContent).toBe("Observations");
    expect([...view.element.querySelectorAll("th")].map(cell => [cell.scope, cell.textContent])).toEqual([["col", "value"], ["col", "link"]]);
    expect(getAllByRole(view.element, "button").map(button => [button.textContent, (button as HTMLButtonElement).type])).toEqual([["value", "button"], ["link", "button"]]);
    expect(view.element.querySelector("th[aria-sort], .ub-table-range, .ub-table-pager")).toBeNull();
    view.render(ready([record("a", 1)], config));
    expect(view.element.querySelector("caption")?.textContent).toBe("Data table of observations");
  });

  it("sorts each header in both directions while retaining the focused button, rows and cell content", () => {
    const view = dataTableView();
    document.body.append(view.element);
    const projection = ready([record("c", 3), record("a", 1), record("b", 2)]);
    Object.freeze(projection.rows);
    view.render(projection);
    const original = rows(view);
    const content = original[0]?.cells[1]?.firstChild;
    const valueButton = getByRole(view.element, "button", { name: "value" });
    const linkButton = getByRole(view.element, "button", { name: "link" });
    valueButton.focus();
    valueButton.click();
    expect(rows(view)).toEqual([original[1], original[2], original[0]]);
    expect(valueButton.closest("th")?.getAttribute("aria-sort")).toBe("ascending");
    expect(valueButton.querySelector('[aria-hidden="true"]')?.textContent).toBe("↑");
    expect(linkButton.closest("th")?.hasAttribute("aria-sort")).toBe(false);
    expect(linkButton.querySelector('[aria-hidden="true"]')).toBeNull();
    expect(getByRole(view.element, "button", { name: "value" })).toBe(valueButton);
    expect(document.activeElement).toBe(valueButton);
    valueButton.click();
    expect(rows(view)).toEqual([original[0], original[2], original[1]]);
    expect(valueButton.closest("th")?.getAttribute("aria-sort")).toBe("descending");
    expect(valueButton.querySelector('[aria-hidden="true"]')?.textContent).toBe("↓");
    linkButton.focus();
    linkButton.click();
    expect(rows(view)).toEqual([original[1], original[2], original[0]]);
    expect(linkButton.closest("th")?.getAttribute("aria-sort")).toBe("ascending");
    expect(valueButton.closest("th")?.hasAttribute("aria-sort")).toBe(false);
    expect(valueButton.querySelector('[aria-hidden="true"]')).toBeNull();
    linkButton.click();
    expect(rows(view)).toEqual([original[0], original[2], original[1]]);
    expect(linkButton.closest("th")?.getAttribute("aria-sort")).toBe("descending");
    expect(document.activeElement).toBe(linkButton);
    expect(original[0]?.cells[1]?.firstChild).toBe(content);
    expect(projection.rows.map(({ id }) => id)).toEqual(["c", "a", "b"]);
    view.element.remove();
  });

  it.each(["", "   "])("names a sort button by its field when its label is blank (%j)", (label) => {
    const view = dataTableView();
    view.render(ready([record("b", 2), record("a", 1)], {
      ...config, columns: [{ field: "value", label, format: "number" }],
    }));
    getByRole(view.element, "button", { name: "value" }).click();
    expect(rows(view).map(row => row.cells[0]?.textContent)).toEqual(["1", "2"]);
    expect(getByRole(view.element, "button", { name: "value" }).closest("th")?.getAttribute("aria-sort")).toBe("ascending");
  });

  it("initially indicates the first mapped field and sorts a repeated field by its selected column's format", () => {
    const view = dataTableView();
    const mapping: TableConfig = { ...config, sort: { field: "value", direction: "asc" }, columns: [
      { field: "value", label: "Text", format: "text" }, { field: "value", label: "Number", format: "number" },
    ] };
    const projection = ready([record("ten", 10), record("two", 2)], mapping);
    view.render(projection);
    const text = getByRole(view.element, "button", { name: "Text" });
    const number = getByRole(view.element, "button", { name: "Number" });
    expect(text.closest("th")?.getAttribute("aria-sort")).toBe("ascending");
    expect(number.closest("th")?.hasAttribute("aria-sort")).toBe(false);
    number.click();
    expect(rows(view).map(row => row.cells[0]?.textContent)).toEqual(["2", "10"]);
    expect(number.closest("th")?.getAttribute("aria-sort")).toBe("ascending");
    number.click();
    expect(rows(view).map(row => row.cells[0]?.textContent)).toEqual(["10", "2"]);
    expect(number.closest("th")?.getAttribute("aria-sort")).toBe("descending");
    view.resetSort();
    view.render(projection);
    expect(text.closest("th")?.getAttribute("aria-sort")).toBe("ascending");
    expect(number.closest("th")?.hasAttribute("aria-sort")).toBe(false);
    expect(getByRole(view.element, "button", { name: "Text" })).toBe(text);
    expect(rows(view).map(row => row.cells[0]?.textContent)).toEqual(["10", "2"]);
  });

  it("keeps a view's choice through data updates and empty states and resets independently to mapping order", () => {
    const view = dataTableView();
    const other = dataTableView();
    const mapping: TableConfig = { ...config, limit: 2, sort: { field: "value", direction: "desc" } };
    const projection = ready([record("b", 9), record("a", 4)], mapping);
    view.render(projection);
    other.render(projection);
    getByRole(view.element, "button", { name: "link" }).click();
    expect(rows(view).map(row => row.cells[0]?.textContent)).toEqual(["4", "9"]);
    expect(rows(other).map(row => row.cells[0]?.textContent)).toEqual(["9", "4"]);
    expect(other.element.querySelector('th[aria-sort="descending"] button')?.textContent).toContain("value");
    const update = ready([record("c", 10), record("b", 9)], { ...mapping, columns: mapping.columns.map(column => ({ ...column })) });
    view.render(update);
    expect(rows(view).map(row => row.cells[0]?.textContent)).toEqual(["9", "10"]);
    expect(getByRole(view.element, "button", { name: "link" }).closest("th")?.getAttribute("aria-sort")).toBe("ascending");
    view.render({ status: "no-records", message: "No records" });
    view.render(update);
    expect(rows(view).map(row => row.cells[0]?.textContent)).toEqual(["9", "10"]);
    view.clear();
    view.render(update);
    expect(rows(view).map(row => row.cells[0]?.textContent)).toEqual(["9", "10"]);
    view.resetSort();
    view.render(update);
    expect(rows(view).map(row => row.cells[0]?.textContent)).toEqual(["10", "9"]);
    expect(getByRole(view.element, "button", { name: "value" }).closest("th")?.getAttribute("aria-sort")).toBe("descending");
    const remounted = dataTableView();
    remounted.render(update);
    expect(rows(remounted).map(row => row.cells[0]?.textContent)).toEqual(["10", "9"]);
    expect(projection.rows.map(({ id }) => id)).toEqual(["b", "a"]);
    expect(update.rows.map(({ id }) => id)).toEqual(["c", "b"]);
  });

  it("retains unchanged native rows, cell content and focused links across detached snapshots", () => {
    const view = dataTableView();
    document.body.append(view.element);
    view.render(ready([record("a", 1), record("b", 2)]));
    const original = rows(view);
    const untouchedContent = original[0]?.cells[0]?.firstChild;
    const untouchedText = untouchedContent?.firstChild;
    const link = original[1]?.querySelector("a");
    link?.focus();
    view.render(ready([record("a", 1), record("b", 9)], { ...config, columns: config.columns.map(column => ({ ...column })) }));
    expect(rows(view)).toEqual(original);
    expect(original[0]?.cells[0]?.firstChild).toBe(untouchedContent);
    expect(original[0]?.cells[0]?.firstChild?.firstChild).toBe(untouchedText);
    expect(original[1]?.cells[0]?.textContent).toBe("9");
    expect(original[1]?.querySelector("a")).toBe(link);
    expect(document.activeElement).toBe(link);
    view.element.remove();
  });

  it("reuses sorted rows while records arrive, disappear and change position in either direction", () => {
    const view = dataTableView();
    view.render(ready([record("a", 1), record("b", 2), record("c", 3)]));
    const original = rows(view);
    view.render(ready([record("d", 0), record("b", 2), record("c", 3), record("a", 4)]));
    expect(rows(view).map(row => row.cells[0]?.textContent)).toEqual(["0", "2", "3", "4"]);
    expect(rows(view).slice(1)).toEqual([original[1], original[2], original[0]]);
    view.render(ready([record("a", -1), record("c", 3)]));
    expect(rows(view)).toEqual([original[0], original[2]]);
    expect(rows(view).map(row => row.cells[0]?.textContent)).toEqual(["-1", "3"]);
    expect(original[1]?.parentNode).toBeNull();
  });

  it("rebuilds changed column mappings and recovers from a problem without stale cells or active unsafe links", () => {
    const view = dataTableView();
    view.render(ready([record("a", 1)]));
    const link = rows(view)[0]?.querySelector("a");
    expect(link?.getAttribute("target")).toBe("_blank");
    expect(link?.getAttribute("rel")).toBe("noopener noreferrer");
    view.render(ready([{ id: "a", value: { value: 1, link: "javascript:alert(1)" } }]));
    expect(rows(view)[0]?.querySelector("a")).toBeNull();
    expect(rows(view)[0]?.cells[1]?.dataset.state).toBe("invalid");
    view.render(ready([{ id: "a", value: { value: null, note: "<img src=x>" } }], {
      ...config, columns: [{ field: "note", label: "Note", format: "text" }, { field: "value", format: "number" }],
    }));
    expect(view.element.querySelector("th")?.textContent).toBe("Note");
    expect(rows(view)[0]?.cells[0]?.textContent).toBe("<img src=x>");
    expect(view.element.querySelector("img")).toBeNull();
    expect(rows(view)[0]?.cells[1]?.dataset.state).toBe("null");
    view.render({ status: "no-records", message: "No records" });
    expect(view.element.hidden).toBe(true);
    expect(rows(view)).toHaveLength(0);
    view.render(ready([record("b", 2)]));
    expect(view.element.hidden).toBe(false);
    expect(rows(view)[0]?.cells[0]?.textContent).toBe("2");
    expect(rows(view)[0]?.querySelector("a")?.getAttribute("href")).toBe("https://example.com/b");
  });
});

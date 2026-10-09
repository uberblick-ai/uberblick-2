import { describe, expect, it } from "vitest";
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
    expect(view.element.querySelector("button, .ub-table-range, .ub-table-pager")).toBeNull();
    view.render(ready([record("a", 1)], config));
    expect(view.element.querySelector("caption")?.textContent).toBe("Data table of observations");
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

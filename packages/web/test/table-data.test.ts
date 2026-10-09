import { describe, expect, it } from "vitest";
import * as Y from "yjs";
import { applyDocData, DATA_KEY, DATA_LIMITS, getDocDataEntries, initDoc, readDocData } from "@uberblick/schema";
import type { CollectionSchema, DataRecord, DocData, JSONValue } from "@uberblick/schema";
import { formatChartNumber, formatChartX, parseChartConfig } from "../src/editor/chart-data.js";
import { formatTableCell, parseTableConfig, prepareTable, tableAccessibleName, tableDiagnosticsText } from "../src/editor/table-data.js";
import type { TableColumnMapping, TableConfig, TableReady } from "../src/editor/table-data.js";

const mapping: TableConfig = {
  version: 1, type: "table", collection: "observations",
  columns: [{ field: "value", format: "text" }], pageSize: 25,
};
const openSchema: CollectionSchema = { version: 1, schema: { type: "object" } };

function fixture(records: DataRecord[], schema = openSchema): { doc: Y.Doc; data: DocData } {
  const doc = new Y.Doc();
  initDoc(doc, { uuid: "table-data-doc", title: "Observations" });
  applyDocData(doc, new Y.Doc(), [{ collection: "observations", schema, upsert: records }]);
  const data = readDocData(doc);
  if (data === null) throw new Error("Fixture data is absent");
  return { doc, data };
}
function ready(data: DocData, config = mapping): TableReady {
  const table = prepareTable(JSON.stringify(config), data);
  expect(table.status).toBe("ready");
  if (table.status !== "ready") throw new Error(table.message);
  return table;
}
function frozen<T>(value: T): T {
  if (value !== null && typeof value === "object") {
    for (const child of Object.values(value)) frozen(child);
    Object.freeze(value);
  }
  return value;
}

describe("table mapping", () => {
  it("defaults format and page size on detached configuration only", () => {
    const source = JSON.stringify({ version: 1, type: "table", collection: "observations", columns: [{ field: "value", label: "Stored value" }] });
    expect(parseTableConfig(source)).toEqual({ ok: true, config: {
      ...mapping, columns: [{ field: "value", label: "Stored value", format: "text" }],
    } });
    expect(source).not.toContain("pageSize");
    expect(source).not.toContain("format");
    expect(parseChartConfig(source)).toMatchObject({ ok: false });
  });

  it.each([
    "not JSON", "null", "[]", "1", JSON.stringify({ ...mapping, version: 2 }),
    JSON.stringify({ ...mapping, type: "line" }), JSON.stringify({ ...mapping, values: [1] }),
    JSON.stringify({ ...mapping, collection: "" }), JSON.stringify({ ...mapping, columns: [] }),
    JSON.stringify({ ...mapping, columns: Array.from({ length: 31 }, () => ({ field: "value" })) }),
    JSON.stringify({ ...mapping, columns: [{ field: "value", format: "percent" }] }),
    JSON.stringify({ ...mapping, columns: [{ field: "value", format: "currency" }] }),
    JSON.stringify({ ...mapping, columns: [{ field: "value", format: "duration" }] }),
    JSON.stringify({ ...mapping, columns: [{ field: "value", format: "link", textField: "title" }] }),
    JSON.stringify({ ...mapping, columns: [{ field: "value", format: null }] }),
    JSON.stringify({ ...mapping, columns: [{ field: "value", format: "text", unit: "h" }] }),
    JSON.stringify({ ...mapping, columns: [{ field: "value", format: "date", decimals: 1 }] }),
    JSON.stringify({ ...mapping, columns: [{ field: "value", format: "number", decimals: -1 }] }),
    JSON.stringify({ ...mapping, columns: [{ field: "value", format: "number", decimals: 11 }] }),
    JSON.stringify({ ...mapping, columns: [{ field: "value", format: "number", decimals: 1.5 }] }),
    JSON.stringify({ ...mapping, columns: [{ field: "value", format: "number", decimals: null }] }),
    JSON.stringify({ ...mapping, columns: [{ field: "value", format: "number", unit: null }] }),
    JSON.stringify({ ...mapping, columns: [{ field: "", label: "Value" }] }),
    JSON.stringify({ ...mapping, columns: [{ field: "\ud800" }] }),
    JSON.stringify({ ...mapping, title: null }),
    JSON.stringify({ ...mapping, pageSize: 0 }), JSON.stringify({ ...mapping, pageSize: 101 }),
    JSON.stringify({ ...mapping, pageSize: 1.5 }), JSON.stringify({ ...mapping, pageSize: "25" }),
    JSON.stringify({ ...mapping, sort: { field: "other", direction: "asc" } }),
    JSON.stringify({ ...mapping, sort: { field: "value", direction: "ascending" } }),
    JSON.stringify({ ...mapping, sort: { field: "value", direction: "asc", locale: "en" } }),
    JSON.stringify({ ...mapping, sort: null }),
  ])("refuses unsupported configuration without consulting or changing data: %s", (source) => {
    expect(prepareTable(source, null)).toMatchObject({ status: "invalid-configuration", message: expect.stringContaining("Invalid table configuration") });
  });

  it("accepts the approved bounds and numeric options without adding a uniqueness restriction", () => {
    for (const pageSize of [1, 100]) {
      expect(parseTableConfig(JSON.stringify({ ...mapping, pageSize, columns: Array.from({ length: 30 }, () => ({ field: "value", format: "number", unit: "%", decimals: 10 })) }))).toMatchObject({ ok: true });
    }
    expect(parseTableConfig(JSON.stringify({ ...mapping, columns: [{ field: "value", format: "number", decimals: 0 }] }))).toMatchObject({ ok: true });
  });
});

describe("table cell values", () => {
  it("shows strings verbatim and every other non-null text value as compact JSON", () => {
    const column: TableColumnMapping = { field: "value", format: "text" };
    for (const value of ["<script>alert(1)</script>", "a\nb", 12, true, ["a", 1], { nested: "text" }] satisfies JSONValue[]) {
      expect(formatTableCell(column, { id: "value", value: { value } })).toEqual({
        state: "valid", text: typeof value === "string" ? value : JSON.stringify(value),
      });
    }
    expect(formatTableCell({ field: "a.b", format: "text" }, { id: "literal", value: { "a.b": "top-level", a: { b: "nested" } } }).text).toBe("top-level");
  });

  it("formats numbers and dates through the chart's locale semantics, adding only explicit numeric options", () => {
    const value: DataRecord = { id: "number", value: { value: 1234.56789, day: "2026-10-08", instant: "2026-10-08T12:30:00+02:00" } };
    expect(formatTableCell({ field: "value", format: "number" }, value, "de-DE").text).toBe(formatChartNumber(1234.56789, "de-DE"));
    expect(formatTableCell({ field: "value", format: "number", decimals: 2, unit: "%" }, value, "de-DE").text).toBe("1.234,57 %");
    expect(formatTableCell({ field: "value", format: "number", decimals: 0, unit: "h" }, value, "en-US").text).toBe("1,235 h");
    expect(formatTableCell({ field: "day", format: "date" }, value, "en-US").text).toBe(formatChartX(Date.parse("2026-10-08T00:00:00Z"), "date", "en-US"));
    expect(formatTableCell({ field: "instant", format: "date" }, value, "de-DE").text).toBe(formatChartX(Date.parse("2026-10-08T10:30:00Z"), "date", "de-DE"));
    expect(formatTableCell({ field: "value", format: "number", decimals: 10 }, { id: "zero", value: { value: 0 } }, "en-US").text).toBe("0.0000000000");
  });

  it.each(["text", "number", "date", "link"] as const)("distinguishes absent and null for %s", (format) => {
    expect(formatTableCell({ field: "value", format }, { id: "absent", value: {} })).toEqual({ state: "absent", text: "Absent" });
    expect(formatTableCell({ field: "value", format }, { id: "null", value: { value: null } })).toEqual({ state: "null", text: "Null" });
  });

  it.each([
    ["number", "12"], ["number", false], ["number", { nested: 1 }],
    ["date", "2026-02-30"], ["date", "2026-10-08T12:30:00"], ["date", 123],
    ["link", "javascript:alert(1)"], ["link", "data:text/html,<script>alert(1)</script>"],
    ["link", "/relative"], ["link", "//example.com"], ["link", "https://example.com has spaces"],
    ["link", "<a href='https://example.com'>Markup</a>"], ["link", false],
  ] satisfies [TableColumnMapping["format"], JSONValue][]) ("names invalid %s values and preserves their text: %s", (format, value) => {
    expect(formatTableCell({ field: "value", format }, { id: "invalid", value: { value } })).toEqual({
      state: "invalid", text: `Invalid: ${typeof value === "string" ? value : JSON.stringify(value)}`,
    });
  });

  it("activates only URL-only links under the existing external-href rule", () => {
    for (const value of ["https://example.com/evidence?a=1&b=2", "HTTP://example.com"]) {
      const record: DataRecord = { id: "link", value: { value } };
      expect(formatTableCell({ field: "value", format: "link" }, record)).toEqual({ state: "valid", text: value, href: value });
      expect(formatTableCell({ field: "value", format: "text" }, record)).toEqual({ state: "valid", text: value });
    }
  });
});

describe("table projection and ordering", () => {
  it("orders unsorted records and ties by Unicode code point without modifying the snapshot or Y.Doc", () => {
    const { doc, data } = fixture([
      { id: "😀", value: { value: 3 } }, { id: "\ufffd", value: { value: 3 } }, { id: "a", value: { value: 2 } },
    ]);
    const before = getDocDataEntries(doc);
    const updates: Uint8Array[] = [];
    doc.on("update", (update: Uint8Array) => updates.push(update));
    frozen(data);
    const table = ready(data);
    expect(table.rows.map(({ id }) => id)).toEqual(["a", "\ufffd", "😀"]);
    const sorted = ready(data, { ...mapping, columns: [{ field: "value", format: "number" }], sort: { field: "value", direction: "desc" } });
    expect(sorted.rows.map(({ id }) => id)).toEqual(["\ufffd", "😀", "a"]);
    expect(sorted.rows[0]).toBe(data.collections[0]?.records[1]);
    expect(getDocDataEntries(doc)).toEqual(before);
    expect(updates).toEqual([]);
  });

  it.each(["asc", "desc"] as const)("sorts valid number values first, then all absent/null/invalid values by id in %s order", (direction) => {
    const { data } = fixture([
      { id: "z-invalid", value: { value: "2" } }, { id: "a-absent", value: {} },
      { id: "b-null", value: { value: null } }, { id: "x-high", value: { value: 12 } },
      { id: "y-low", value: { value: -3 } }, { id: "t-tie", value: { value: 12 } },
    ]);
    const table = ready(data, { ...mapping, columns: [{ field: "value", format: "number" }], sort: { field: "value", direction } });
    expect(table.rows.map(({ id }) => id)).toEqual(direction === "asc"
      ? ["y-low", "t-tie", "x-high", "a-absent", "b-null", "z-invalid"]
      : ["t-tie", "x-high", "y-low", "a-absent", "b-null", "z-invalid"]);
    expect(table.invalidSchema).toBe(0);
  });

  it("orders dates by instant, including equal offsets, with invalid dates last", () => {
    const { data } = fixture([
      { id: "d-invalid", value: { value: "2026-02-30" } },
      { id: "c-later", value: { value: "2026-10-08T12:00:00Z" } },
      { id: "b-offset", value: { value: "2026-10-08T12:00:00+02:00" } },
      { id: "a-utc", value: { value: "2026-10-08T10:00:00Z" } },
    ]);
    const config = { ...mapping, columns: [{ field: "value", format: "date" as const }], sort: { field: "value", direction: "asc" as const } };
    expect(ready(data, config).rows.map(({ id }) => id)).toEqual(["a-utc", "b-offset", "c-later", "d-invalid"]);
    expect(ready(data, { ...config, sort: { field: "value", direction: "desc" } }).rows.map(({ id }) => id)).toEqual(["c-later", "a-utc", "b-offset", "d-invalid"]);
  });

  it("sorts text by its literal displayed value's code points without locale collation", () => {
    const { data } = fixture([
      { id: "emoji", value: { value: "😀" } }, { id: "bmp", value: { value: "\ufffd" } },
      { id: "lower", value: { value: "a" } }, { id: "upper", value: { value: "Z" } },
      { id: "number", value: { value: 20 } }, { id: "object", value: { value: { a: 1 } } },
    ]);
    const table = ready(data, { ...mapping, sort: { field: "value", direction: "asc" } });
    expect(table.rows.map(({ id }) => id)).toEqual(["number", "upper", "lower", "object", "bmp", "emoji"]);
  });

  it("sorts external links by raw URL and puts refused links last in either direction", () => {
    const { data } = fixture([
      { id: "z-bad", value: { value: "javascript:alert(1)" } }, { id: "b", value: { value: "https://b.test" } },
      { id: "a", value: { value: "http://a.test" } }, { id: "a-missing", value: {} },
    ]);
    const config = { ...mapping, columns: [{ field: "value", format: "link" as const }] };
    expect(ready(data, { ...config, sort: { field: "value", direction: "asc" } }).rows.map(({ id }) => id)).toEqual(["a", "b", "a-missing", "z-bad"]);
    expect(ready(data, { ...config, sort: { field: "value", direction: "desc" } }).rows.map(({ id }) => id)).toEqual(["b", "a", "a-missing", "z-bad"]);
  });

  it("omits and counts records invalid under a concurrently changed schema", () => {
    const schema: CollectionSchema = { version: 1, schema: { type: "object", properties: { value: { type: "number" } } } };
    const { doc } = fixture([{ id: "base", value: { value: 10 } }], schema);
    const other = new Y.Doc();
    Y.applyUpdate(other, Y.encodeStateAsUpdate(doc));
    applyDocData(doc, new Y.Doc(), [{ collection: "observations", schema: {
      version: 1, schema: { ...schema.schema, properties: { value: { type: "number", minimum: 10 } } },
    } }]);
    applyDocData(other, new Y.Doc(), [{ collection: "observations", upsert: [{ id: "concurrent", value: { value: 2 } }] }]);
    Y.applyUpdate(doc, Y.encodeStateAsUpdate(other));
    const data = readDocData(doc);
    if (data === null) throw new Error("Missing merge data");
    const table = ready(data);
    expect(table.rows.map(({ id }) => id)).toEqual(["base"]);
    expect(table.recordCount).toBe(2);
    expect(table.invalidSchema).toBe(1);
    expect(tableDiagnosticsText(table)).toBe("1 records not shown (invalid under the collection schema).");
  });
});

describe("table problem states", () => {
  it("distinguishes collection absence, unusable schema, incompatible mapping and no records", () => {
    const source = JSON.stringify(mapping);
    expect(prepareTable(source, null)).toMatchObject({ status: "collection-absent", message: expect.stringContaining("absent") });
    const { doc, data } = fixture([]);
    expect(prepareTable(source, data)).toMatchObject({ status: "no-records", message: expect.stringContaining("No records to show") });
    expect(prepareTable(source, { ...data, bytes: DATA_LIMITS.area + 1 })).toMatchObject({ status: "collection-unusable", message: expect.stringContaining("data area exceeds") });
    doc.getMap(DATA_KEY).delete(JSON.stringify(["schema", "observations"]));
    doc.getMap(DATA_KEY).set(JSON.stringify(["record", "observations", "orphan"]), { value: 1 });
    expect(prepareTable(source, readDocData(doc))).toMatchObject({ status: "collection-unusable", message: expect.stringContaining("schema is missing") });
    doc.getMap(DATA_KEY).set(JSON.stringify(["schema", "observations"]), { version: 2, schema: { type: "object" } });
    expect(prepareTable(source, readDocData(doc)).status).toBe("collection-unusable");
    const missing = fixture([], { version: 1, schema: { type: "object", additionalProperties: false } });
    expect(prepareTable(source, missing.data)).toMatchObject({ status: "mapping-incompatible", message: expect.stringContaining("“value”") });
  });

  it.each(["number", "date", "link"] as const)("requires a compatible schema type for %s without excluding nullable values", (format) => {
    const config = { ...mapping, columns: [{ field: "value", format }] };
    const incompatible = fixture([], { version: 1, schema: { type: "object", properties: { value: { type: "boolean" } } } });
    expect(prepareTable(JSON.stringify(config), incompatible.data).status).toBe("mapping-incompatible");
    const compatible = fixture([{ id: "null", value: { value: null } }], { version: 1, schema: {
      type: "object", properties: { value: { type: [format === "number" ? "integer" : "string", "null"] } }, additionalProperties: false,
    } });
    expect(ready(compatible.data, config).rows).toHaveLength(1);
  });

  it("shows every declared JSON type as text and undeclared fields from open schemas", () => {
    const { data } = fixture([{ id: "boolean", value: { value: false } }], { version: 1, schema: {
      type: "object", properties: { value: { type: "boolean" } }, additionalProperties: false,
    } });
    expect(ready(data).rows).toHaveLength(1);
    expect(ready(fixture([{ id: "open", value: { value: 3 } }]).data).rows).toHaveLength(1);
  });

  it("clears states when mapping or data becomes valid without changing authored content", () => {
    const source = JSON.stringify(mapping);
    const { doc, data } = fixture([]);
    expect(prepareTable(source, data).status).toBe("no-records");
    applyDocData(doc, new Y.Doc(), [{ collection: "observations", upsert: [{ id: "arrived", value: { value: "current" } }] }]);
    expect(prepareTable(source, readDocData(doc)).status).toBe("ready");
    expect(prepareTable(JSON.stringify({ ...mapping, columns: [{ field: "value", format: "duration" }] }), readDocData(doc)).status).toBe("invalid-configuration");
    expect(prepareTable(source, readDocData(doc)).status).toBe("ready");
    expect(source).toBe(JSON.stringify(mapping));
  });

  it("names the table by title or collection and reports omission counts as plain text", () => {
    expect(tableAccessibleName(mapping)).toBe("Data table of observations");
    expect(tableAccessibleName({ ...mapping, title: "Delivery evidence" })).toBe("Delivery evidence");
    expect(tableDiagnosticsText(ready(fixture([{ id: "ok", value: { value: 1 } }]).data))).toBe("");
  });
});

import { describe, expect, it } from "vitest";
import * as Y from "yjs";
import {
  applyDocData, DATA_KEY, DATA_LIMITS, getDocDataEntries, initDoc, readDocData,
} from "@uberblick/schema";
import type { CollectionSchema, DataRecord, DocData } from "@uberblick/schema";
import {
  chartAccessibleDescription, chartAccessibleName, chartDate, chartDiagnosticsText,
  formatChartNumber, formatChartX, parseChartConfig, prepareChart,
} from "../src/editor/chart-data.js";
import type { ChartConfig, ChartReady } from "../src/editor/chart-data.js";

const mapping: ChartConfig = {
  version: 1, type: "line", collection: "observations", x: { field: "x", type: "number" },
  y: [{ field: "y", label: "Count", unit: "issues" }], missing: "gap",
};
const openSchema: CollectionSchema = { version: 1, schema: { type: "object" } };

function fixture(records: DataRecord[], schema = openSchema): { doc: Y.Doc; data: DocData } {
  const doc = new Y.Doc();
  const directory = new Y.Doc();
  initDoc(doc, { uuid: "chart-data-doc", title: "Observations" });
  applyDocData(doc, directory, [{ collection: "observations", schema, upsert: records }]);
  const data = readDocData(doc);
  if (data === null) throw new Error("Fixture data is absent");
  return { doc, data };
}
function ready(data: DocData, config = mapping): ChartReady {
  const chart = prepareChart(JSON.stringify(config), data);
  expect(chart.status).toBe("ready");
  if (chart.status !== "ready") throw new Error(chart.message);
  return chart;
}

describe("chart mapping", () => {
  it("hides the not-plotted line for complete plots and empty collections, but keeps omitted values", () => {
    const { data } = fixture([{ id: "a", value: { x: 1, y: 2 } }]);
    expect(chartDiagnosticsText(ready(data))).toBe("");
    const empty = fixture([]).data;
    expect(chartDiagnosticsText(prepareChart(JSON.stringify(mapping), empty))).toBe("");
    const partial = ready(data, { ...mapping, y: [...mapping.y, { field: "absent", label: "Sparse" }] });
    expect(chartDiagnosticsText(partial)).toBe("0 records not plotted. Omitted series values: Sparse: 1 absent or null.");
  });
  it("holds only the versioned mapping, with a detached gap default", () => {
    const source = JSON.stringify({
      version: 1, type: "line", collection: "observations", x: { field: "x", type: "date", label: "Day" },
      y: [{ field: "y", label: "Delivered", unit: "issues" }], title: "Delivery",
    });
    const parsed = parseChartConfig(source);
    expect(parsed).toEqual({ ok: true, config: {
      version: 1, type: "line", collection: "observations", x: { field: "x", type: "date", label: "Day" },
      y: [{ field: "y", label: "Delivered", unit: "issues" }], title: "Delivery", missing: "gap",
    } });
    expect(source).not.toContain("missing");
  });

  it.each([
    "not JSON", "null", "[]", "1", JSON.stringify({ ...mapping, version: 2 }),
    JSON.stringify({ ...mapping, type: "bar" }), JSON.stringify({ ...mapping, values: [1] }),
    JSON.stringify({ ...mapping, collection: "" }), JSON.stringify({ ...mapping, collection: null }),
    JSON.stringify({ ...mapping, x: { field: "x", type: "string" } }),
    JSON.stringify({ ...mapping, x: { field: "x", type: "number", unit: "days" } }),
    JSON.stringify({ ...mapping, x: { field: "", type: "number" } }),
    JSON.stringify({ ...mapping, y: [] }),
    JSON.stringify({ ...mapping, y: Array.from({ length: 9 }, () => ({ field: "y" })) }),
    JSON.stringify({ ...mapping, y: [{ field: "y", values: [1] }] }),
    JSON.stringify({ ...mapping, y: [{ field: "y", label: null }] }),
    JSON.stringify({ ...mapping, title: 2 }), JSON.stringify({ ...mapping, missing: "zero" }),
    JSON.stringify({ ...mapping, x: { field: "\ud800", type: "number" } }),
  ])("refuses malformed or unsupported mappings without data changes: %s", (source) => {
    expect(prepareChart(source, null)).toMatchObject({ status: "invalid-configuration", message: expect.stringContaining("Invalid chart configuration") });
  });

  it("accepts eight series and treats field names as literal top-level properties", () => {
    const config = { ...mapping, x: { field: "a.b", type: "number" as const }, y: Array.from({ length: 8 }, (_, i) => ({ field: `y${i}` })) };
    const { data } = fixture([{ id: "literal", value: { "a.b": 3, ...Object.fromEntries(config.y.map((series, i) => [series.field, i])) } }]);
    const chart = ready(data, config);
    expect(chart.series).toHaveLength(8);
    expect(chart.series[0]?.points).toEqual([{ x: 3, y: 0, id: "literal" }]);
  });
});

describe("chart dates", () => {
  it("accepts real UTC days and RFC 3339 offsets without timezone coercion", () => {
    expect(chartDate("2024-02-29")).toBe(Date.parse("2024-02-29T00:00:00Z"));
    expect(chartDate("0000-01-01")).toBe(Date.parse("0000-01-01T00:00:00Z"));
    expect(chartDate("0099-12-31")).toBe(Date.parse("0099-12-31T00:00:00Z"));
    expect(chartDate("2026-10-08T12:34:56.123456+02:30")).toBeCloseTo(Date.parse("2026-10-08T10:04:56Z") + 123.456, 2);
    expect(chartDate("2026-10-08t12:34:56z")).toBe(Date.parse("2026-10-08T12:34:56Z"));
    expect(chartDate("2026-10-08T12:34:56-00:00")).toBe(Date.parse("2026-10-08T12:34:56Z"));
    expect(chartDate("1990-12-31T23:59:60Z")).toBe(Date.parse("1991-01-01T00:00:00Z"));
    expect(chartDate("1990-12-31T15:59:60-08:00")).toBe(Date.parse("1991-01-01T00:00:00Z"));
  });
  it.each([
    null, 1791417600000, "", "10/08/2026", "2026-2-01", "2023-02-29", "2026-02-30",
    "2026-04-31", "2026-00-01", "2026-13-01", "2026-01-00", "2026-01-32",
    "2026-10-08 12:00:00Z", "2026-10-08T12:00:00", "2026-10-08T12:00Z",
    "2026-10-08T24:00:00Z", "2026-10-08T12:60:00Z", "2026-10-08T12:00:61Z",
    "2026-10-08T12:00:00+24:00", "2026-10-08T12:00:00+01:60", "2026-10-08T12:00:00+0100",
    "2026-10-08T12:00:00.Z", "2026-10-08T12:00:00Z\n", "2026-06-30T23:59:60Z",
    "2016-12-31T12:59:60Z",
  ])("does not normalize an invalid or ambiguous date: %s", (value) => {
    expect(chartDate(value)).toBeNull();
  });
});

describe("chart data projection", () => {
  it("orders x then Unicode record id, preserving duplicates and zero", () => {
    const { doc, data } = fixture([
      { id: "last", value: { x: 9, y: 4 } },
      { id: "😀", value: { x: 2, y: 3 } },
      { id: "first", value: { x: -1, y: 0 } },
      { id: "\ufffd", value: { x: 2, y: 2 } },
    ]);
    const before = getDocDataEntries(doc);
    const updates: Uint8Array[] = [];
    doc.on("update", (update: Uint8Array) => updates.push(update));
    const chart = ready(data);
    expect(chart.series[0]?.points).toEqual([
      { id: "first", x: -1, y: 0 }, { id: "\ufffd", x: 2, y: 2 },
      { id: "😀", x: 2, y: 3 }, { id: "last", x: 9, y: 4 },
    ]);
    expect(chart.plottedCount).toBe(4);
    expect(chart.firstX).toBe(-1);
    expect(chart.lastX).toBe(9);
    expect(getDocDataEntries(doc)).toEqual(before);
    expect(updates).toEqual([]);
  });

  it("rejects absent, null and wrong-type x and counts why", () => {
    const { data } = fixture([
      { id: "absent", value: { y: 1 } }, { id: "null", value: { x: null, y: 2 } },
      { id: "string", value: { x: "3", y: 3 } }, { id: "boolean", value: { x: false, y: 4 } },
      { id: "ok", value: { x: 0, y: 5 } },
    ]);
    const chart = ready(data);
    expect(chart.plottedCount).toBe(1);
    expect(chart.notPlotted).toBe(4);
    expect(chart.diagnostics).toMatchObject({ missingX: 2, invalidX: 2 });
    expect(chartDiagnosticsText(chart)).toContain("4 records not plotted (2 absent or null x; 2 wrong-type or invalid x)");
  });

  it("does not coerce y, and only bridges absence when connect is selected", () => {
    const { data } = fixture([
      { id: "a", value: { x: 1, y: 1, z: 10 } }, { id: "b", value: { x: 2, z: 20 } },
      { id: "c", value: { x: 3, y: null, z: 30 } }, { id: "d", value: { x: 4, y: "4", z: 40 } },
      { id: "e", value: { x: 5, y: 5 } }, { id: "f", value: { x: 6 } },
    ]);
    const gap = ready(data, { ...mapping, y: [...mapping.y, { field: "z" }] });
    expect(gap.series[0]?.points.map(({ y }) => y)).toEqual([1, null, null, null, 5, null]);
    expect(gap.plottedCount).toBe(5);
    expect(gap.notPlotted).toBe(1);
    expect(gap.diagnostics.noNumericY).toBe(1);
    expect(gap.diagnostics.series[0]).toMatchObject({ missing: 3, invalid: 1 });
    const connect = ready(data, { ...mapping, missing: "connect" });
    expect(connect.series[0]?.points).toEqual([
      { id: "a", x: 1, y: 1 }, { id: "d", x: 4, y: null }, { id: "e", x: 5, y: 5 },
    ]);
  });

  it("skips schema-invalid records from independent schema and record merges", () => {
    const schema: CollectionSchema = { version: 1, schema: {
      type: "object", properties: { x: { type: "number" }, y: { type: "number" } },
    } };
    const { doc } = fixture([{ id: "base", value: { x: 1, y: 10 } }], schema);
    const other = new Y.Doc();
    Y.applyUpdate(other, Y.encodeStateAsUpdate(doc));
    applyDocData(doc, new Y.Doc(), [{ collection: "observations", schema: {
      version: 1, schema: { ...schema.schema, properties: { ...schema.schema.properties, y: { type: "number", minimum: 10 } } },
    } }]);
    applyDocData(other, new Y.Doc(), [{ collection: "observations", upsert: [{ id: "concurrent", value: { x: 2, y: 2 } }] }]);
    Y.applyUpdate(doc, Y.encodeStateAsUpdate(other));
    const merged = readDocData(doc);
    if (merged === null) throw new Error("Missing merge data");
    const before = getDocDataEntries(doc);
    const chart = ready(merged);
    expect(chart.series[0]?.points).toEqual([{ id: "base", x: 1, y: 10 }]);
    expect(chart.diagnostics.invalidSchema).toBe(1);
    expect(chartDiagnosticsText(chart)).toContain("1 invalid under the collection schema");
    expect(getDocDataEntries(doc)).toEqual(before);
  });

  it("bounds by greatest x with deterministic ties while preserving gaps", () => {
    const records: DataRecord[] = Array.from({ length: 5_003 }, (_, index) => ({
      id: index.toString().padStart(5, "0"), value: { x: index, ...(index === 4 ? {} : { y: index }) },
    }));
    const { data } = fixture(records.reverse());
    const chart = ready(data);
    expect(chart.series[0]?.points).toHaveLength(5_000);
    expect(chart.series[0]?.points[0]).toEqual({ id: "00003", x: 3, y: 3 });
    expect(chart.series[0]?.points[1]).toEqual({ id: "00004", x: 4, y: null });
    expect(chart.series[0]?.points.at(-1)).toEqual({ id: "05002", x: 5002, y: 5002 });
    expect(chart.notice).toBe("Showing the latest 5,000 of 5003 records");
    expect(chart.plottedCount).toBe(4_999);
    expect(chart.notPlotted).toBe(4);
    expect(chart.diagnostics).toMatchObject({ limited: 3, noNumericY: 1 });
  });
});

describe("chart problem states", () => {
  it("distinguishes an absent collection, unusable schema, incompatible mapping and no values", () => {
    const source = JSON.stringify(mapping);
    expect(prepareChart(source, null).status).toBe("collection-absent");
    const { doc, data } = fixture([]);
    expect(prepareChart(source, data)).toMatchObject({ status: "no-records", message: expect.stringContaining("No plottable records") });
    doc.getMap(DATA_KEY).delete(JSON.stringify(["schema", "observations"]));
    doc.getMap(DATA_KEY).set(JSON.stringify(["record", "observations", "orphan"]), { x: 1, y: 1 });
    expect(prepareChart(source, readDocData(doc))).toMatchObject({ status: "collection-unusable", message: expect.stringContaining("schema is missing") });
    doc.getMap(DATA_KEY).set(JSON.stringify(["schema", "observations"]), { version: 2, schema: { type: "object" } });
    expect(prepareChart(source, readDocData(doc)).status).toBe("collection-unusable");
    const incompatible = fixture([], { version: 1, schema: { type: "object", properties: { x: { type: "string" }, y: { type: "number" } } } });
    expect(prepareChart(source, incompatible.data).status).toBe("mapping-incompatible");
    const missing = fixture([], { version: 1, schema: { type: "object", properties: { x: { type: "number" } }, additionalProperties: false } });
    expect(prepareChart(source, missing.data)).toMatchObject({ status: "mapping-incompatible", message: expect.stringContaining("“y”") });
    expect(prepareChart(source, { ...data, bytes: DATA_LIMITS.area + 1 })).toMatchObject({ status: "collection-unusable", message: expect.stringContaining("data area exceeds") });
  });

  it("allows nullable numeric and integer declarations, and undeclared fields in open schemas", () => {
    const { data } = fixture([{ id: "ok", value: { x: 1, y: 2 } }], { version: 1, schema: {
      type: "object", properties: { x: { type: ["integer", "null"] }, y: { type: ["number", "null"] } }, additionalProperties: false,
    } });
    expect(ready(data).plottedCount).toBe(1);
    expect(ready(fixture([{ id: "open", value: { x: 3, y: 4 } }]).data).plottedCount).toBe(1);
  });

  it("clears a problem after valid data arrives without changing the mapping", () => {
    const source = JSON.stringify(mapping);
    const { doc, data } = fixture([{ id: "missing", value: { x: 1 } }]);
    const empty = prepareChart(source, data);
    expect(empty).toMatchObject({ status: "no-records", notPlotted: 1 });
    expect(chartDiagnosticsText(empty)).toContain("1 without numeric y values");
    applyDocData(doc, new Y.Doc(), [{ collection: "observations", upsert: [{ id: "missing", value: { x: 1, y: 2 } }] }]);
    expect(prepareChart(source, readDocData(doc)).status).toBe("ready");
    expect(source).toBe(JSON.stringify(mapping));
  });
});

describe("chart text alternative", () => {
  it("uses locale formatting, series labels/units and latest plotted values", () => {
    const { data } = fixture([
      { id: "a", value: { x: 1, y: 1_234.5, z: 100 } },
      { id: "b", value: { x: 2, y: null, z: 200 } },
    ]);
    const chart = ready(data, { ...mapping, x: { ...mapping.x, label: "Day" }, y: [...mapping.y, { field: "z", label: "Elapsed", unit: "ms" }] });
    expect(chartAccessibleName(chart.config)).toBe("Line chart of Count, Elapsed by Day");
    expect(chartAccessibleName({ ...chart.config, title: "Health" })).toBe("Health");
    expect(chartAccessibleDescription(chart, "de-DE")).toBe("2 plotted records. First Day: 1. Last: 2. Latest values: Count: 1.234,5 issues; Elapsed: 200 ms.");
    expect(formatChartNumber(0.00000123, "en-US")).toBe("0.00000123");
    expect(formatChartX(Date.parse("0000-01-01T00:00:00Z"), "date", "en-US")).toBe("Jan 1, 1 BC");
    expect(formatChartX(Date.parse("2026-10-08T00:00:00Z"), "date", "en-US")).toBe("Oct 8, 2026");
    expect(formatChartX(Date.parse("2026-10-08T12:30:00Z"), "date", "en-US")).toContain("UTC");
  });
});

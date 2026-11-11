import { describe, expect, it } from "vitest";
import { parseBarConfig, prepareBar, prepareChartView } from "../src/index.js";
import type { DataRecord, DataSchema, DocData, JSONObject, JSONValue } from "../src/index.js";

const mapping = {
  version: 1, type: "bar", collection: "observations", category: { field: "name" }, y: [{ field: "count" }],
};
function source(overrides: Record<string, unknown> = {}): string { return JSON.stringify({ ...mapping, ...overrides }); }
function snapshot(records: DataRecord[], schema: DataSchema = { type: "object" }): DocData {
  return {
    valid: true, bytes: 0, errors: [], collections: [{
      name: "observations", schema: { version: 1, schema } as unknown as JSONValue, records,
      valid: true, invalidRecordIds: [], errors: [],
    }],
  };
}
function record(id: string, value: JSONObject): DataRecord { return { id, value }; }

describe("category bar mapping", () => {
  it("defaults to vertical and accepts named stacks, one axis' metadata and table sorting", () => {
    expect(parseBarConfig(source())).toEqual({ ok: true, config: { ...mapping, orientation: "vertical" } });
    const input = {
      category: { field: "name", label: "Team" }, orientation: "horizontal", title: "Tickets", height: 420,
      y: [
        { field: "count", label: "Open", unit: "tickets", stack: "eu", range: [-10, 40], reference: 20 },
        { field: "closed", label: "Closed", unit: "tickets", stack: "eu" },
      ],
      sort: { field: "count", direction: "desc" }, limit: 20,
    };
    expect(parseBarConfig(source(input))).toEqual({ ok: true, config: { ...mapping, ...input } });
    expect(parseBarConfig(source({ y: Array.from({ length: 8 }, () => ({ field: "count" })) })).ok).toBe(true);
  });

  it.each([
    { layout: "overlay" }, { missing: "gap" }, { x: { field: "x", type: "number" } }, { extra: true },
    { version: 2 }, { collection: "" }, { category: { field: "" } }, { category: { field: "name", format: "text" } },
    { category: { field: "name", label: null } }, { y: [] },
    { y: Array.from({ length: 9 }, () => ({ field: "count" })) },
    { y: [{ field: "count", type: "bar" }] }, { y: [{ field: "count", lower: "lower" }] },
    { y: [{ field: "count", stack: null }] }, { y: [{ field: "count", unit: 4 }] },
    { y: [{ field: "count", range: [0, 0] }] }, { y: [{ field: "count", range: [4, 2] }] },
    { y: [{ field: "count", range: [0, "4"] }] }, { y: [{ field: "count", reference: "5" }] },
    { orientation: null }, { orientation: "diagonal" }, { limit: 0 }, { limit: 1.5 },
    { height: 99 }, { height: 601 }, { height: 101.5 }, { height: null },
    { sort: { field: "other", direction: "asc" } }, { sort: { field: "name", direction: "up" } },
    { sort: { field: "name", direction: "asc", format: "number" } },
  ])("rejects unsupported or invalid bar options %j", (options) => {
    expect(parseBarConfig(source(options))).toMatchObject({ ok: false, message: expect.stringContaining("Invalid bar configuration") });
  });
});

describe("shared category bar projection", () => {
  it("keeps record identity, equal category labels, empty groups and table text formatting without mutation", () => {
    const data = snapshot([
      record("z", { name: "Same", count: 0 }), record("a", { name: "Same", count: 3 }),
      record("c", { name: { nested: true }, count: 5 }), record("b", { name: false }),
    ]);
    const before = structuredClone(data);
    expect(prepareChartView(source(), data)).toMatchObject({ type: "bar", projection: {
      status: "ready", recordCount: 4, eligibleCount: 4, plottedCount: 3, notPlotted: 1,
      rows: [
        { id: "a", label: "Same", values: [3] }, { id: "b", label: "false", values: [null] },
        { id: "c", label: '{"nested":true}', values: [5] }, { id: "z", label: "Same", values: [0] },
      ],
      domain: [0, 5], warnings: [], diagnostics: { noNumericY: 1 },
    } });
    expect(data).toEqual(before);
  });

  it("counts schema and category omissions and absent, null and invalid series values without coercion", () => {
    const data = snapshot([
      record("invalid", { name: "Invalid", count: 100 }), record("absent-category", { count: 100 }),
      record("null-category", { name: null, count: 100 }), record("absent", { name: "Absent" }),
      record("null", { name: "Null", count: null, second: null }),
      record("wrong", { name: "Wrong", count: "2", second: false }), record("zero", { name: "Zero", count: 0 }),
    ]);
    data.collections[0]!.invalidRecordIds = ["invalid"];
    expect(prepareBar(source({ y: [{ field: "count" }, { field: "second" }] }), data)).toMatchObject({
      status: "ready", recordCount: 7, eligibleCount: 4, plottedCount: 1, notPlotted: 6,
      rows: [
        { id: "absent", values: [null, null] }, { id: "null", values: [null, null] },
        { id: "wrong", values: [null, null] }, { id: "zero", values: [0, null] },
      ],
      diagnostics: { invalidSchema: 1, missingCategory: 2, noNumericY: 3, series: [
        { field: "count", absent: 1, null: 1, missing: 2, invalid: 1 },
        { field: "second", absent: 2, null: 1, missing: 3, invalid: 1 },
      ] }, warnings: ["No numeric values for series field “second”."], domain: [0, 0],
    });
  });

  it("sorts the category as text and series numerically with invalid-last values and record-id ties", () => {
    const data = snapshot([
      record("z", { name: "10", count: 2 }), record("a", { name: "2", count: 2 }),
      record("b", { name: 3, count: 10 }), record("c", { name: "A", count: null }),
      record("d", { name: "B", count: "90" }), record("e", { name: "C" }),
    ]);
    const ids = (options: Record<string, unknown>) => {
      const result = prepareBar(source(options), data);
      if (result.status !== "ready") throw new Error("Expected ready bars");
      return result.rows.map((row) => row.id);
    };
    expect(ids({ sort: { field: "name", direction: "asc" } })).toEqual(["z", "a", "b", "c", "d", "e"]);
    expect(ids({ sort: { field: "count", direction: "asc" } })).toEqual(["a", "z", "b", "c", "d", "e"]);
    expect(ids({ sort: { field: "count", direction: "desc" } })).toEqual(["b", "a", "z", "c", "d", "e"]);
    expect(prepareBar(source({ sort: { field: "count", direction: "desc" }, limit: 2 }), data)).toMatchObject({
      status: "ready", rows: [{ id: "b" }, { id: "a" }], plottedCount: 2,
      notice: "Showing 2 of 6 records", diagnostics: { limited: 0 }, notPlotted: 0,
    });
  });

  it("widens the zero-based value domain for independent signed stacks, ranges and references", () => {
    const data = snapshot([
      record("a", { name: "A", a: 6, b: 7, c: 9, d: 10 }),
      record("b", { name: "B", a: -10, b: -9, c: -12, d: 13 }),
      record("c", { name: "C", a: -5, b: 4, c: -1, d: 1 }),
    ]);
    const y = [{ field: "a", stack: "shared" }, { field: "b", stack: "shared" }, { field: "c" }, { field: "d" }];
    expect(prepareBar(source({ y }), data)).toMatchObject({ status: "ready", domain: [-19, 13] });
    expect(prepareBar(source({ orientation: "horizontal", y }), data)).toMatchObject({ status: "ready", domain: [-19, 13] });
    expect(prepareBar(source({ y: [
      { field: "a", stack: "shared", range: [1, 2], reference: -25 },
      { field: "b", stack: "shared", reference: 20 }, { field: "c" }, { field: "d" },
    ] }), data)).toMatchObject({ status: "ready", domain: [-25, 20] });
    expect(prepareBar(source({ y: [{ field: "a", range: [-50, 50] }] }), data)).toMatchObject({ status: "ready", domain: [-50, 50] });
  });

  it("takes the first 5,000 categories after sorting, including empty groups, and reports the cap", () => {
    const records = Array.from({ length: 5_002 }, (_, index) => record(String(index).padStart(4, "0"), {
      name: `Category ${index}`, count: index === 0 ? null : index,
    }));
    const data = snapshot(records.reverse());
    const result = prepareBar(source({ limit: 10_000 }), data);
    expect(result).toMatchObject({
      status: "ready", recordCount: 5_002, eligibleCount: 5_002, plottedCount: 4_999, notPlotted: 3,
      notice: "Showing 5,000 of 5002 records", diagnostics: { limited: 2, noNumericY: 1 }, domain: [0, 4_999],
    });
    if (result.status !== "ready") throw new Error("Expected ready bars");
    expect(result.rows).toHaveLength(5_000);
    expect(result.rows[0]).toEqual({ id: "0000", label: "Category 0", values: [null] });
    expect(result.rows[4_999]?.id).toBe("4999");
    expect(prepareBar(source({ sort: { field: "count", direction: "desc" }, limit: 1 }), data)).toMatchObject({
      status: "ready", rows: [{ id: "5001", values: [5_001] }], notice: "Showing 1 of 5002 records",
    });
  });

  it("normalizes only extreme drawing coordinates while preserving finite values and stack geometry", () => {
    const data = snapshot([
      record("positive", { name: "Positive", a: Number.MAX_VALUE, b: Number.MAX_VALUE }),
      record("negative", { name: "Negative", a: -Number.MAX_VALUE, b: -Number.MAX_VALUE }),
    ]);
    const result = prepareBar(source({ y: [
      { field: "a", stack: "same", range: [-Number.MAX_VALUE, Number.MAX_VALUE] },
      { field: "b", stack: "same", reference: Number.MAX_VALUE },
    ] }), data);
    expect(result.status).toBe("ready");
    if (result.status !== "ready") throw new Error("Expected ready bars");
    expect(result.coordinateDivisor).toBe(1e308);
    expect(result.domain[0]).toBeCloseTo(-3.59538626972463);
    expect(result.domain[1]).toBeCloseTo(3.59538626972463);
    expect(Number.isFinite(result.domain[1] - result.domain[0])).toBe(true);
    expect(result.rows.map(row => row.values)).toEqual([
      [-Number.MAX_VALUE, -Number.MAX_VALUE], [Number.MAX_VALUE, Number.MAX_VALUE],
    ]);
    expect(result).toMatchObject({ plottedCount: 2, notPlotted: 0, warnings: [] });
    const independent = prepareBar(source({ y: [{ field: "a" }] }), data);
    expect(independent).toMatchObject({ status: "ready", coordinateDivisor: 1e308 });
    if (independent.status !== "ready") throw new Error("Expected ready bars");
    expect(independent.domain[0]).toBeCloseTo(-1.7976931348623157);
    expect(independent.domain[1]).toBeCloseTo(1.7976931348623157);
    expect(prepareBar(source(), snapshot([record("a", { name: "Ordinary", count: 40 })]))).not.toHaveProperty("coordinateDivisor");
  });

  it("retains no-record diagnostics and empty-series warnings for a window without numeric values", () => {
    const data = snapshot([record("a", { name: "Empty", count: "3" }), record("b", { name: "Outside", count: 3 })]);
    expect(prepareBar(source({ limit: 1, y: [{ field: "count" }, { field: "count", label: "Duplicate" }] }), data)).toMatchObject({
      status: "no-records", message: "No plottable records in this chart collection.", recordCount: 2,
      plottedCount: 0, rows: [{ id: "a", label: "Empty", values: [null, null] }],
      warnings: ["No numeric values for series field “count”."], notice: "Showing 1 of 2 records",
      diagnostics: { noNumericY: 1, series: [{ invalid: 1 }, { invalid: 1 }] },
    });
  });

  it("keeps the existing distinct binding problems and accepts any non-null text-cell category type", () => {
    expect(prepareBar("{ incomplete", null)).toMatchObject({ status: "invalid-configuration" });
    expect(prepareBar(source(), null)).toMatchObject({ status: "collection-absent" });
    const unusable = snapshot([]);
    unusable.collections[0]!.schema = null;
    expect(prepareBar(source(), unusable)).toMatchObject({ status: "collection-unusable" });
    const schema: DataSchema = {
      type: "object", additionalProperties: false, properties: { name: { type: "integer" }, count: { type: "string" } },
    };
    expect(prepareBar(source(), snapshot([], schema))).toMatchObject({ status: "mapping-incompatible" });
    expect(prepareBar(source({ category: { field: "missing" } }), snapshot([], schema))).toMatchObject({ status: "mapping-incompatible" });
    expect(prepareBar(source({ y: [{ field: "name" }] }), snapshot([record("a", { name: 2 })], schema))).toMatchObject({
      status: "ready", rows: [{ label: "2", values: [2] }],
    });
  });
});

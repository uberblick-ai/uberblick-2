import { describe, expect, it } from "vitest";
import { parseDotConfig, prepareBar, prepareChartView, prepareDot } from "../src/index.js";
import type { DataRecord, DataSchema, DocData, JSONObject, JSONValue } from "../src/index.js";

const mapping = {
  version: 1, type: "dot", collection: "systems", category: { field: "name" }, y: [{ field: "old" }],
};
function source(overrides: Record<string, unknown> = {}): string { return JSON.stringify({ ...mapping, ...overrides }); }
function snapshot(records: DataRecord[], schema: DataSchema = { type: "object" }): DocData {
  return {
    valid: true, bytes: 0, errors: [], collections: [{
      name: "systems", schema: { version: 1, schema } as unknown as JSONValue, records,
      valid: true, invalidRecordIds: [], errors: [],
    }],
  };
}
function record(id: string, value: JSONObject): DataRecord { return { id, value }; }

describe("dot mapping", () => {
  it("accepts one series and the full two-series mapping without changing source defaults", () => {
    expect(parseDotConfig(source())).toEqual({ ok: true, config: mapping });
    expect(parseDotConfig(source({ connect: false }))).toMatchObject({ ok: true });
    const options = {
      category: { field: "name", label: "System" }, title: "Word error rate", height: 420,
      y: [{ field: "old", label: "Old", unit: "%", range: [8, 20], reference: 10 }, { field: "new", label: "Today", unit: "%" }],
      connect: true, note: "change", sort: { field: "new", direction: "asc" }, limit: 20,
    };
    expect(parseDotConfig(source(options))).toEqual({ ok: true, config: { ...mapping, ...options } });
    for (const note of ["event.note", "__proto__", "↻"]) expect(parseDotConfig(source({ note })).ok).toBe(true);
  });

  it.each([
    { connect: true }, { connect: "true" }, { connect: null }, { orientation: "horizontal" }, { stack: "a" },
    { layout: "overlay" }, { missing: "gap" }, { x: { field: "x" } }, { extra: true },
    { version: 2 }, { collection: "" }, { category: { field: "" } }, { category: { field: "name", format: "text" } },
    { category: { field: "name", label: null } }, { y: [] },
    { y: [{ field: "a" }, { field: "b" }, { field: "c" }] },
    { y: [{ field: "old", stack: "a" }] }, { y: [{ field: "old", note: "note" }] },
    { y: [{ field: "old", type: "line" }] }, { y: [{ field: "old", lower: "low" }] },
    { y: [{ field: "old", range: [2, 2] }] }, { y: [{ field: "old", range: [2, 1] }] },
    { y: [{ field: "old", range: [0, "4"] }] }, { y: [{ field: "old", reference: "5" }] },
    { y: [{ field: "old", unit: 4 }] }, { y: [{ field: "old", label: null }] },
    { note: "" }, { note: null }, { note: false }, { note: 1 }, { note: "\ud800" },
    { limit: 0 }, { limit: 1.5 }, { height: 99 }, { height: 601 }, { height: 101.5 },
    { sort: { field: "change", direction: "asc" } }, { sort: { field: "name", direction: "up" } },
    { sort: { field: "name", direction: "asc", format: "number" } },
  ])("refuses unsupported or invalid options %j", (options) => {
    expect(parseDotConfig(source(options))).toMatchObject({ ok: false, message: expect.stringContaining("Invalid dot configuration") });
  });
});

describe("shared dot projection", () => {
  it("preserves separate equal categories, stored values and text-cell notes without mutation", () => {
    const data = snapshot([
      record("f", { name: "Same", old: 9.9, new: 12.5, change: "<b>+2.6</b>\nfull note" }),
      record("a", { name: "Same", old: 11.1, change: 0 }),
      record("b", { name: { nested: true }, old: 12, change: { value: "+1" } }),
      record("c", { name: false, old: 13, change: false }),
      record("d", { name: "No note", old: 14, change: null }),
      record("e", { name: "Absent note", old: 15 }),
    ]);
    const before = structuredClone(data);
    const result = prepareChartView(source({ y: [{ field: "old", unit: "%" }, { field: "new" }], connect: true, note: "change" }), data);
    expect(result).toMatchObject({ type: "dot", projection: {
      status: "ready", recordCount: 6, eligibleCount: 6, plottedCount: 6, domain: [9.9, 15],
      rows: [
        { id: "a", label: "Same", values: [11.1, null], note: "0" },
        { id: "b", label: '{"nested":true}', values: [12, null], note: '{"value":"+1"}' },
        { id: "c", label: "false", values: [13, null], note: "false" },
        { id: "d", values: [14, null] }, { id: "e", values: [15, null] },
        { id: "f", label: "Same", values: [9.9, 12.5], note: "<b>+2.6</b>\nfull note" },
      ],
    } });
    if (result.projection.status !== "ready" || result.type !== "dot") throw new Error("Expected ready dots");
    expect(result.projection.rows[3]).not.toHaveProperty("note");
    expect(result.projection.rows[4]).not.toHaveProperty("note");
    expect(data).toEqual(before);
  });

  it("shares category eligibility, sorting, windows, missing diagnostics and warnings with bars", () => {
    const data = snapshot([
      record("invalid", { name: "Invalid", old: 100 }), record("absent-category", { old: 100 }),
      record("null-category", { name: null, old: 100 }), record("absent", { name: "Absent" }),
      record("null", { name: "Null", old: null, new: null }),
      record("wrong", { name: "Wrong", old: "2", new: false }), record("zero", { name: "Zero", old: 0 }),
    ]);
    data.collections[0]!.invalidRecordIds = ["invalid"];
    const options = { y: [{ field: "old" }, { field: "new" }], sort: { field: "old", direction: "desc" } };
    const dot = prepareDot(source(options), data);
    const bar = prepareBar(source({ ...options, type: "bar" }), data);
    expect(dot).toMatchObject({
      status: "ready", recordCount: 7, eligibleCount: 4, plottedCount: 1, notPlotted: 6, domain: [0, 0],
      rows: [{ id: "zero", values: [0, null] }, { id: "absent" }, { id: "null" }, { id: "wrong" }],
      diagnostics: { invalidSchema: 1, missingCategory: 2, noNumericY: 3, series: [
        { field: "old", absent: 1, null: 1, missing: 2, invalid: 1 },
        { field: "new", absent: 2, null: 1, missing: 3, invalid: 1 },
      ] }, warnings: ["No numeric values for series field “new”."],
    });
    if (dot.status !== "ready" || bar.status !== "ready") throw new Error("Expected ready category projections");
    expect({ ...dot, config: bar.config }).toEqual(bar);
    expect(prepareDot(source({ ...options, limit: 1 }), data)).toMatchObject({
      status: "ready", rows: [{ id: "zero" }], plottedCount: 1, notice: "Showing 1 of 4 records", notPlotted: 3,
    });
    expect(prepareDot(source({ y: [{ field: "new" }], limit: 1 }), data)).toMatchObject({
      status: "no-records", plottedCount: 0, rows: [{ id: "absent" }], notice: "Showing 1 of 4 records",
      warnings: ["No numeric values for series field “new”."],
    });
  });

  it("uses the nonzero value extent and only widens declared ranges for values or references", () => {
    const data = snapshot([record("a", { name: "A", old: 83.5, new: 95.1 })]);
    const options = { y: [{ field: "old" }, { field: "new" }] };
    expect(prepareDot(source(options), data)).toMatchObject({ status: "ready", domain: [83.5, 95.1] });
    expect(prepareDot(source({ y: [{ field: "old", range: [80, 90] }, { field: "new", reference: 100 }] }), data))
      .toMatchObject({ status: "ready", domain: [80, 100] });
    expect(prepareDot(source({ y: [{ field: "old", range: [85, 90] }] }), data))
      .toMatchObject({ status: "ready", domain: [83.5, 90] });
    expect(prepareDot(source({ y: [{ field: "old", reference: 0 }] }), data))
      .toMatchObject({ status: "ready", domain: [0, 83.5] });
    expect(prepareDot(source(), snapshot([record("a", { name: "A", old: -30 }), record("b", { name: "B", old: -20 })])))
      .toMatchObject({ status: "ready", domain: [-30, -20] });
  });

  it("retains full extreme values while keeping drawing coordinates and their span finite", () => {
    const data = snapshot([
      record("a", { name: "Negative", old: -Number.MAX_VALUE }),
      record("b", { name: "Positive", old: Number.MAX_VALUE }),
    ]);
    const result = prepareDot(source({ y: [{ field: "old", range: [-Number.MAX_VALUE, Number.MAX_VALUE], reference: Number.MAX_VALUE }] }), data);
    if (result.status !== "ready") throw new Error("Expected ready dots");
    expect(result.coordinateDivisor).toBe(1e308);
    expect(result.domain[0]).toBeCloseTo(-1.7976931348623157);
    expect(result.domain[1]).toBeCloseTo(1.7976931348623157);
    expect(Number.isFinite(result.domain[1] - result.domain[0])).toBe(true);
    expect(result.rows.map(row => row.values)).toEqual([[-Number.MAX_VALUE], [Number.MAX_VALUE]]);
  });

  it.each([1e-20, 1e-300, Number.MIN_VALUE, -Number.MIN_VALUE])(
    "keeps singleton %s drawable without underflowing its scale expansion", (value) => {
      const result = prepareDot(source(), snapshot([record("a", { name: "Tiny", old: value })]));
      if (result.status !== "ready") throw new Error("Expected ready dots");
      expect(result.rows[0]?.values).toEqual([value]);
      expect(result.coordinateDivisor).toBeGreaterThan(0);
      const [lower, upper] = result.domain;
      expect(Number.isFinite(lower)).toBe(true);
      expect(lower).not.toBe(0);
      expect(upper + Math.abs(upper * 0.05)).toBeGreaterThan(lower - Math.abs(lower * 0.05));
    },
  );

  it("keeps tiny signed ranges and references finite without collapsing distinct stored values", () => {
    for (const values of [[Number.MIN_VALUE, Number.MIN_VALUE * 2], [-Number.MIN_VALUE * 2, -Number.MIN_VALUE],
      [-Number.MIN_VALUE, Number.MIN_VALUE], [1e-300, 2e-300]]) {
      const [lower, upper] = values as [number, number];
      const result = prepareDot(source({ y: [{ field: "old", range: [lower, upper], reference: upper }] }), snapshot([
        record("a", { name: "Lower", old: lower }), record("b", { name: "Upper", old: upper }),
      ]));
      if (result.status !== "ready") throw new Error("Expected ready dots");
      expect(result.rows.map(row => row.values)).toEqual([[lower], [upper]]);
      expect(result.coordinateDivisor).toBeGreaterThan(0);
      expect(Number.isFinite(result.domain[1] - result.domain[0])).toBe(true);
      expect(result.domain[1]).toBeGreaterThan(result.domain[0]);
    }
  });

  it("enforces the sorted 5,000-row cap and keeps rows without numeric values in the window", () => {
    const data = snapshot(Array.from({ length: 5_002 }, (_, index) => record(String(index).padStart(4, "0"), {
      name: `System ${index}`, old: index === 0 ? null : index, change: `Note ${index}`,
    })).reverse());
    const result = prepareDot(source({ limit: 10_000, note: "change" }), data);
    expect(result).toMatchObject({
      status: "ready", recordCount: 5_002, eligibleCount: 5_002, plottedCount: 4_999, notPlotted: 3,
      notice: "Showing 5,000 of 5002 records", diagnostics: { limited: 2, noNumericY: 1 }, domain: [1, 4_999],
    });
    if (result.status !== "ready") throw new Error("Expected ready dots");
    expect(result.rows).toHaveLength(5_000);
    expect(result.rows[0]).toEqual({ id: "0000", label: "System 0", values: [null], note: "Note 0" });
    expect(prepareDot(source({ sort: { field: "old", direction: "desc" }, limit: 1 }), data)).toMatchObject({
      status: "ready", rows: [{ id: "5001", values: [5_001] }], notice: "Showing 1 of 5002 records",
    });
  });

  it("keeps distinct binding states and validates the note field with text-cell compatibility", () => {
    expect(prepareDot("{ incomplete", null)).toMatchObject({ status: "invalid-configuration" });
    expect(prepareDot(source(), null)).toMatchObject({ status: "collection-absent" });
    const unusable = snapshot([]);
    unusable.collections[0]!.schema = null;
    expect(prepareDot(source(), unusable)).toMatchObject({ status: "collection-unusable" });
    const schema: DataSchema = {
      type: "object", additionalProperties: false, properties: { name: { type: "string" }, old: { type: "number" }, change: { type: "number" } },
    };
    expect(prepareDot(source({ note: "missing" }), snapshot([], schema))).toMatchObject({
      status: "mapping-incompatible", message: expect.stringContaining("field “missing”"),
    });
    expect(prepareDot(source({ y: [{ field: "name" }] }), snapshot([], schema))).toMatchObject({ status: "mapping-incompatible" });
    expect(prepareDot(source({ category: { field: "missing" } }), snapshot([], schema))).toMatchObject({ status: "mapping-incompatible" });
    expect(prepareDot(source({ note: "change" }), snapshot([record("a", { name: "A", old: 2, change: 0 })], schema)))
      .toMatchObject({ status: "ready", rows: [{ note: "0" }] });
    expect(prepareDot(source(), snapshot([]))).toMatchObject({ status: "no-records", recordCount: 0, plottedCount: 0 });
  });
});

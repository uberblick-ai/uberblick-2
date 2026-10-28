import { describe, expect, it } from "vitest";
import { parseScatterConfig, prepareChartView, prepareScatter } from "../src/index.js";
import type { DataRecord, DataSchema, DocData, JSONObject, JSONValue } from "../src/index.js";

const mapping = {
  version: 1, type: "scatter", collection: "observations",
  x: { field: "x" }, y: { field: "y" }, label: "label",
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

describe("scatter mapping", () => {
  it("accepts numeric axes, independent stored bounds, and the table details grammar", () => {
    const input = {
      x: { field: "x", label: "Cost", unit: "€", range: [-10, 90], lower: "xlo", upper: "xhi" },
      y: { field: "y", lower: "ylo" }, label: "label", group: "tier", title: "Comparison", height: 320,
      details: [
        { field: "name" }, { field: "count", format: "number", unit: "items", decimals: 0 },
        { field: "day", format: "date" }, { field: "url", format: "link" },
      ],
    };
    expect(parseScatterConfig(source(input))).toEqual({
      ok: true, config: { ...mapping, ...input, details: [
        { field: "name", format: "text" }, { field: "count", format: "number", unit: "items", decimals: 0 },
        { field: "day", format: "date" }, { field: "url", format: "link" },
      ] },
    });
    expect(parseScatterConfig(source())).toMatchObject({ ok: true, config: { details: [] } });
    expect(parseScatterConfig(source({ details: Array.from({ length: 8 }, () => ({ field: "name" })) })).ok).toBe(true);
  });

  it.each([
    { layout: "overlay" }, { limit: 10 }, { missing: "gap" }, { reference: 1 }, { extra: true },
    { group: null }, { label: "" }, { label: null }, { x: { field: "x", type: "number" } },
    { x: { field: "x", lower: "" } }, { y: { field: "y", upper: null } },
    { x: { field: "x", range: [10, 10] } }, { x: { field: "x", range: [20, 10] } },
    { x: { field: "x", range: [0, "10"] } }, { y: { field: "y", reference: 0 } },
    { height: 99 }, { height: 601 }, { height: 320.5 }, { height: null },
    { details: null }, { details: Array.from({ length: 9 }, () => ({ field: "name" })) },
    { details: [{ field: "name", format: null }] }, { details: [{ field: "name", format: "text", unit: "kg" }] },
    { details: [{ field: "name", format: "number", decimals: 11 }] },
    { details: [{ field: "name", format: "html" }] }, { details: [{ field: "name", extra: true }] },
  ])("rejects unsupported or invalid scatter options %j", (options) => {
    expect(parseScatterConfig(source(options))).toMatchObject({ ok: false, message: expect.stringContaining("Invalid scatter configuration") });
  });
});

describe("shared scatter projection", () => {
  it("retains equal-valued observations and raw details in record-id order without writing the snapshot", () => {
    const data = snapshot([
      record("z", { x: 4, y: 9, label: "Last", detail: { nested: true } }),
      record("a", { x: 4, y: 9, label: "First" }),
    ]);
    const before = structuredClone(data);
    const view = prepareChartView(source(), data);
    expect(view).toMatchObject({ type: "scatter", projection: {
      status: "ready", recordCount: 2, plottedCount: 2, eligibleCount: 2, notPlotted: 0,
      points: [{ id: "a", x: 4, y: 9 }, { id: "z", x: 4, y: 9, record: { value: { detail: { nested: true } } } }],
      domain: { x: [4, 4], y: [9, 9] },
    } });
    expect(data).toEqual(before);
  });

  it("counts schema omissions and both axes' absent, null and wrong-type coordinates without coercion", () => {
    const data = snapshot([
      record("invalid", { x: 1, y: 2 }), record("absent", {}), record("null", { x: null, y: null }),
      record("wrong", { x: "1", y: false }), record("valid", { x: 0, y: 0 }),
    ]);
    data.collections[0]!.invalidRecordIds = ["invalid"];
    expect(prepareScatter(source(), data)).toMatchObject({
      status: "ready", recordCount: 5, plottedCount: 1, notPlotted: 4, points: [{ id: "valid", x: 0, y: 0 }],
      diagnostics: { invalidSchema: 1, axes: {
        x: { absent: 1, null: 1, invalid: 1 }, y: { absent: 1, null: 1, invalid: 1 },
      } },
    });
  });

  it("draws only bounds on the correct side and widens each minimum span with drawn values", () => {
    const input = source({
      x: { field: "x", lower: "lo", upper: "hi", range: [0, 10] },
      y: { field: "y", lower: "bottom", upper: "top", range: [0, 100] },
    });
    const data = snapshot([
      record("a", { x: 5, y: 50, lo: -20, hi: 25, bottom: 20, top: 110 }),
      record("b", { x: 5, y: 50, lo: 6, hi: 4, bottom: "bad", top: false }),
      record("c", { x: 5, y: 50, lo: null, top: null }),
      record("d", { x: 5, y: 50, lo: 5, hi: 5, bottom: 50, top: 50 }),
    ]);
    expect(prepareScatter(input, data)).toMatchObject({
      status: "ready", domain: { x: [-20, 25], y: [0, 110] },
      points: [
        { id: "a", xLower: -20, xUpper: 25, yLower: 20, yUpper: 110 },
        { id: "b", x: 5, y: 50 }, { id: "c", x: 5, y: 50 },
        { id: "d", xLower: 5, xUpper: 5, yLower: 50, yUpper: 50 },
      ],
      diagnostics: { axes: {
        x: { bounds: { lower: { invalid: 0, wrongSide: 1 }, upper: { invalid: 0, wrongSide: 1 } } },
        y: { bounds: { lower: { invalid: 1, wrongSide: 0 }, upper: { invalid: 1, wrongSide: 0 } } },
      } },
    });
    const projection = prepareScatter(input, data);
    if (projection.status !== "ready") throw new Error("Expected ready scatter");
    expect(projection.points[1]).not.toHaveProperty("xLower");
    expect(projection.points[1]).not.toHaveProperty("xUpper");
    expect(projection.points[1]).not.toHaveProperty("yLower");
    expect(projection.points[1]).not.toHaveProperty("yUpper");
    expect(projection.points[2]).not.toHaveProperty("xLower");
    expect(projection.points[2]).not.toHaveProperty("yUpper");
  });

  it("groups stored values consistently, keeps absent and null neutral, and warns above eight groups", () => {
    const records = [
      record("z", { x: 1, y: 2, group: "B" }), record("a", { x: 1, y: 2, group: "A" }),
      record("none", { x: 1, y: 2 }), record("null", { x: 1, y: 2, group: null }),
      record("object-1", { x: 1, y: 2, group: { a: 1, b: 2 } }),
      record("object-2", { x: 1, y: 2, group: { b: 2, a: 1 } }),
    ];
    const input = source({ group: "group" });
    const first = prepareScatter(input, snapshot(records));
    const reordered = prepareScatter(input, snapshot([...records].reverse()));
    expect(first).toMatchObject({ status: "ready", groups: [
      { key: '"A"', value: "A" }, { key: '"B"', value: "B" }, { key: '{"a":1,"b":2}' },
    ], diagnostics: { groupOverflow: false }, warnings: [] });
    expect(reordered).toEqual(first);
    if (first.status !== "ready") throw new Error("Expected ready scatter");
    expect(first.points.find((point) => point.id === "none")).not.toHaveProperty("groupKey");
    expect(first.points.find((point) => point.id === "null")).not.toHaveProperty("groupKey");
    const many = Array.from({ length: 8 }, (_, index) => record(String(index), { x: 1, y: 2, group: index }));
    expect(prepareScatter(input, snapshot(many))).toMatchObject({ status: "ready", diagnostics: { groupOverflow: false } });
    many.push(record("ninth", { x: 1, y: 2, group: false }));
    expect(prepareScatter(input, snapshot(many))).toMatchObject({
      status: "ready", groups: [], plottedCount: 9, diagnostics: { groupOverflow: true },
      warnings: [expect.stringContaining("group field “group” has more than 8 values")],
    });
  });

  it("takes at most 5,000 qualifying records by id, with a shown/total notice and domain, groups and bounds from drawn points", () => {
    const records = Array.from({ length: 5_000 }, (_, index) =>
      record(String(index).padStart(4, "0"), { x: index, y: -index, label: index, group: "kept" }));
    records.push(...Array.from({ length: 9 }, (_, index) => record(String(index + 5_000), {
      x: index + 5_000, y: -index - 5_000, group: index,
      xlo: "bad", xhi: -1, ylo: 1, yhi: false,
    })));
    const projection = prepareScatter(source({
      group: "group", x: { field: "x", lower: "xlo", upper: "xhi" },
      y: { field: "y", lower: "ylo", upper: "yhi" },
    }), snapshot(records.reverse()));
    expect(projection).toMatchObject({
      status: "ready", recordCount: 5_009, eligibleCount: 5_009, plottedCount: 5_000, notPlotted: 9,
      groups: [{ key: '"kept"', value: "kept" }], warnings: [],
      diagnostics: { limited: 9, groupOverflow: false, axes: {
        x: { bounds: { lower: { invalid: 0, wrongSide: 0 }, upper: { invalid: 0, wrongSide: 0 } } },
        y: { bounds: { lower: { invalid: 0, wrongSide: 0 }, upper: { invalid: 0, wrongSide: 0 } } },
      } },
      notice: "Showing 5,000 of 5009 records", domain: { x: [0, 4_999], y: [-4_999, -0] },
    });
    if (projection.status !== "ready") throw new Error("Expected ready scatter");
    expect(projection.points[0]?.id).toBe("0000");
    expect(projection.points[4_999]?.id).toBe("4999");
  });

  it("returns the existing distinct collection and no-record problem states", () => {
    expect(prepareScatter("{ incomplete", null)).toMatchObject({ status: "invalid-configuration" });
    expect(prepareScatter(source(), null)).toMatchObject({ status: "collection-absent" });
    const unusable = snapshot([]);
    unusable.collections[0]!.schema = null;
    expect(prepareScatter(source(), unusable)).toMatchObject({ status: "collection-unusable" });
    expect(prepareScatter(source(), snapshot([record("bad", { x: "1", y: 2 })]))).toMatchObject({
      status: "no-records", recordCount: 1, plottedCount: 0, points: [], diagnostics: { axes: { x: { invalid: 1 } } },
    });
  });

  it.each([
    { x: { field: "missing" } }, { y: { field: "text" } }, { label: "missing" }, { group: "missing" },
    { x: { field: "x", lower: "text" } }, { y: { field: "y", upper: "missing" } },
    { details: [{ field: "text", format: "number" }] }, { details: [{ field: "x", format: "link" }] },
  ])("rejects missing or schema-incompatible mapped fields %j", (options) => {
    const schema: DataSchema = {
      type: "object", additionalProperties: false,
      properties: { x: { type: "number" }, y: { type: "integer" }, label: { type: "string" }, text: { type: "string" } },
    };
    expect(prepareScatter(source(options), snapshot([], schema))).toMatchObject({ status: "mapping-incompatible" });
  });
});

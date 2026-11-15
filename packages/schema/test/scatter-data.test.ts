import { describe, expect, it } from "vitest";
import { parseBarConfig, parseChartConfig, parseDotConfig, parseScatterConfig, prepareChartView, prepareScatter } from "../src/index.js";
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

  it.each([0, -1.5, Number.MAX_VALUE, Number.MIN_VALUE, [], [0, 0, -2.5], Array.from({ length: 8 }, (_, index) => index)])(
    "accepts finite scalar or bounded list references %j on either axis", (reference) => {
      const input = { x: { field: "x", reference }, y: { field: "y", reference } };
      expect(parseScatterConfig(source(input))).toMatchObject({ ok: true, config: input });
    },
  );

  it.each([true, false])("accepts diagonal %j", (diagonal) => {
    expect(parseScatterConfig(source({ diagonal }))).toMatchObject({ ok: true, config: { diagonal } });
  });

  it.each([null, "1", true, {}, [null], ["1"], [false], [[1]], [1, "2"], Array.from({ length: 9 }, () => 1)])(
    "rejects invalid reference %j on either axis", (reference) => {
      expect(prepareScatter(source({ x: { field: "x", reference } }), null)).toMatchObject({ status: "invalid-configuration" });
      expect(prepareScatter(source({ y: { field: "y", reference } }), null)).toMatchObject({ status: "invalid-configuration" });
    },
  );

  it.each(["1e999", "-1e999", "[0,1e999]", "[0,-1e999]", "NaN", "Infinity"])(
    "rejects non-finite reference source %s", (reference) => {
      expect(parseScatterConfig(source().replace('"field":"x"', `"field":"x","reference":${reference}`))).toMatchObject({ ok: false });
      expect(parseScatterConfig(source().replace('"field":"y"', `"field":"y","reference":${reference}`))).toMatchObject({ ok: false });
    },
  );

  it("keeps line, category bar and dot references restricted to a single number", () => {
    const common = { version: 1, collection: "observations", y: [{ field: "y", reference: 1 }] };
    const line = { ...common, type: "line", x: { field: "x", type: "number" } };
    const bar = { ...common, type: "bar", category: { field: "label" } };
    const dot = { ...bar, type: "dot" };
    expect(parseChartConfig(JSON.stringify(line)).ok).toBe(true);
    expect(parseBarConfig(JSON.stringify(bar)).ok).toBe(true);
    expect(parseDotConfig(JSON.stringify(dot)).ok).toBe(true);
    const list = { y: [{ field: "y", reference: [1] }] };
    expect(parseChartConfig(JSON.stringify({ ...line, ...list })).ok).toBe(false);
    expect(parseBarConfig(JSON.stringify({ ...bar, ...list })).ok).toBe(false);
    expect(parseDotConfig(JSON.stringify({ ...dot, ...list })).ok).toBe(false);
  });

  it.each([
    { layout: "overlay" }, { limit: 10 }, { missing: "gap" }, { reference: 1 }, { extra: true },
    { group: null }, { label: "" }, { label: null }, { x: { field: "x", type: "number" } },
    { x: { field: "x", lower: "" } }, { y: { field: "y", upper: null } },
    { x: { field: "x", range: [10, 10] } }, { x: { field: "x", range: [20, 10] } },
    { x: { field: "x", range: [0, "10"] } },
    { diagonal: null }, { diagonal: 0 }, { diagonal: "true" }, { diagonal: [] }, { diagonal: {} },
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

  it.each([
    { range: {}, domain: { x: [-30, 40], y: [20, 130] } },
    { range: { x: [-100, 100], y: [0, 100] }, domain: { x: [-100, 100], y: [0, 130] } },
  ])("widens each axis for references while preserving minimum spans %j", ({ range, domain }) => {
    const data = snapshot([record("a", { x: 5, y: 50, lo: -20, hi: 25, bottom: 20, top: 110 })]);
    const axes = {
      x: { field: "x", lower: "lo", upper: "hi", ...(range.x === undefined ? {} : { range: range.x }) },
      y: { field: "y", lower: "bottom", upper: "top", ...(range.y === undefined ? {} : { range: range.y }) },
    };
    const plain = prepareScatter(source(axes), data);
    const decorated = prepareScatter(source({
      x: { ...axes.x, reference: [-30, 40, -30] }, y: { ...axes.y, reference: 130 },
    }), data);
    expect(decorated).toMatchObject({ status: "ready", domain });
    if (plain.status !== "ready" || decorated.status !== "ready") throw new Error("Expected ready scatters");
    expect({ ...decorated, config: plain.config, domain: plain.domain }).toEqual(plain);
  });

  it("leaves axis ranges and the projection unchanged for a diagonal and empty references", () => {
    const data = snapshot([record("a", { x: 2, y: 100 }), record("b", { x: 4, y: 200 })]);
    const plain = prepareScatter(source(), data);
    const diagonal = prepareScatter(source({ diagonal: true }), data);
    const absent = prepareScatter(source({ diagonal: false, x: { field: "x", reference: [] }, y: { field: "y", reference: [] } }), data);
    expect(diagonal).toMatchObject({ status: "ready", domain: { x: [2, 4], y: [100, 200] } });
    if (plain.status !== "ready" || diagonal.status !== "ready" || absent.status !== "ready") throw new Error("Expected ready scatters");
    expect({ ...diagonal, config: plain.config }).toEqual(plain);
    expect({ ...absent, config: plain.config }).toEqual(plain);
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

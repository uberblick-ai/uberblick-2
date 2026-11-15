import { describe, expect, it } from "vitest";
import { prepareChartView } from "../src/index.js";
import type { ChartView, DataCollection, DataRecord, DataSchema, DocData, JSONObject } from "../src/index.js";

const mappings = [
  { version: 1, type: "line", collection: "observations", x: { field: "x", type: "number" }, y: [{ field: "y" }] },
  { version: 1, type: "scatter", collection: "observations", x: { field: "x" }, y: { field: "y" }, label: "name", group: "group" },
  { version: 1, type: "bar", collection: "observations", category: { field: "name" }, y: [{ field: "y" }], group: "group" },
  { version: 1, type: "dot", collection: "observations", category: { field: "name" }, y: [{ field: "y" }], group: "group" },
  { version: 1, type: "table", collection: "observations", columns: [{ field: "x", format: "number", bar: true }, { field: "y", format: "number" }], shade: { fields: ["y"], better: "lower" } },
] as const;

function snapshot(records: DataCollection["records"], invalidRecordIds: string[] = [], schema: DataSchema = { type: "object" }): DocData {
  return {
    valid: true, bytes: 0, errors: [], collections: [{
      name: "observations", schema: { version: 1, schema } as unknown as DataCollection["schema"], records,
      valid: invalidRecordIds.length === 0, invalidRecordIds, errors: [],
    }],
  };
}
function record(id: string, value: JSONObject = {}): DataRecord {
  return { id, value: { x: 1, y: 2, name: id, group: "shown", ...value } };
}
function ids(view: ChartView): string[] {
  if (view.projection.status !== "ready" && view.projection.status !== "no-records") throw new Error("Expected bound view");
  switch (view.type) {
    case "line": return view.projection.series[0]!.points.map(point => point.id);
    case "scatter": return view.projection.points.map(point => point.id);
    case "table": case "bar": case "dot": return view.projection.rows.map(row => row.id);
  }
}
function withoutSelection(projection: ChartView["projection"]) {
  if (projection.status !== "ready" && projection.status !== "no-records") throw new Error("Expected bound view");
  const { config: _config, recordCount: _count, notice: _notice, ...rest } = projection;
  return rest;
}

describe.each(mappings)("$type view filters", (mapping) => {
  const prepare = (data: DocData | null, options: Record<string, unknown> = {}) =>
    prepareChartView(JSON.stringify({ ...mapping, ...options }), data);

  it("accepts non-empty primitive predicates and rejects unsupported filters", () => {
    for (const filter of [{ reference: "baseline-a" }, { string: "", number: 1.5, boolean: false, null: null }, JSON.parse('{"__proto__":null,"event.kind":"exact","↻":true}')]) {
      expect(prepare(snapshot([]), { filter }).projection.status).toBe("no-records");
    }
    for (const filter of [{}, null, false, 1, "baseline-a", [], [1], { reference: [] }, { reference: {} }, { "": 1 }, { "\ud800": 1 }]) {
      expect(prepare(null, { filter }).projection.status).toBe("invalid-configuration");
    }
    const source = JSON.stringify(mapping).replace(/}$/, ',"filter":{"reference":1e400}}');
    expect(prepareChartView(source, null).projection.status).toBe("invalid-configuration");
  });

  it("matches every stored primitive by exact type and value without treating absence as null", () => {
    const values = ["1", 1, true, false, null, "", "A", "a", "é", "e\u0301"];
    const data = snapshot([
      ...values.map((value, index) => record(String(index), { value })),
      record("absent"), record("array", { value: [1] }), record("object", { value: { nested: true } }),
    ]);
    for (const [index, value] of values.entries()) {
      const view = prepare(data, { filter: { value } });
      expect(ids(view)).toEqual([String(index)]);
      expect(view.projection).toMatchObject({ recordCount: 13, notice: "1 of 13 records" });
    }
  });

  it("joins predicates with AND and uses literal own field names", () => {
    const inherited = Object.assign(Object.create({ inherited: true }), record("inherited").value) as JSONObject;
    const data = snapshot([
      record("match", JSON.parse('{"reference":"baseline-a","active":true,"empty":null,"event.kind":"a","__proto__":false}')),
      record("different-reference", { reference: "baseline-b", active: true, empty: null }),
      record("different-type", { reference: "baseline-a", active: "true", empty: null }),
      record("absent-null", { reference: "baseline-a", active: true }),
      { id: "inherited", value: inherited },
    ]);
    expect(ids(prepare(data, { filter: JSON.parse('{"reference":"baseline-a","active":true,"empty":null,"event.kind":"a","__proto__":false}') })))
      .toEqual(["match"]);
    expect(prepare(data, { filter: { inherited: true } }).projection).toMatchObject({
      status: "no-records", message: "No records match the filter.", notice: "0 of 5 records",
    });
  });

  it("applies every projection rule to only selected records without mutating stored data", () => {
    const selected = [
      record("a", { x: 1, y: 2, group: "shown-a", reference: "baseline-a" }),
      record("b", { x: 3, y: 4, group: "shown-b", reference: "baseline-a" }),
      record("invalid-selected", { reference: "baseline-a" }),
      record("missing-selected", { x: null, y: null, name: null, reference: "baseline-a" }),
    ];
    const hidden = Array.from({ length: 9 }, (_, index) => record(`hidden-${index}`, {
      x: -1000, y: 10_000, group: index, reference: "baseline-b",
    }));
    hidden.push(record("invalid-hidden", { reference: "baseline-b" }));
    hidden.push({ id: "malformed-hidden", value: null as unknown as JSONObject });
    hidden.push(record("missing-hidden", { x: null, y: "wrong", name: null, reference: "baseline-b" }));
    const data = snapshot([...selected, ...hidden], ["invalid-selected", "invalid-hidden", "malformed-hidden"]);
    const before = structuredClone(data);
    const filtered = prepare(data, { filter: { reference: "baseline-a" } }).projection;
    const subset = prepare(snapshot(selected, ["invalid-selected"])).projection;
    expect(filtered).toMatchObject({ status: "ready", recordCount: 16, notice: "4 of 16 records" });
    expect(withoutSelection(filtered)).toEqual(withoutSelection(subset));
    expect(data).toEqual(before);
  });

  it("distinguishes no match, empty collections, and selected records without plottable values", () => {
    const data = snapshot([record("a", { reference: "baseline-a" })]);
    expect(prepare(data, { filter: { reference: "baseline-b" } }).projection).toMatchObject({
      status: "no-records", message: "No records match the filter.", recordCount: 1, notice: "0 of 1 records",
    });
    expect(prepare(snapshot([])).projection).toMatchObject({ status: "no-records", message: expect.not.stringContaining("filter") });
    const allSelected = prepare(data, { filter: { reference: "baseline-a" } }).projection;
    expect(allSelected).not.toHaveProperty("notice");
    if (mapping.type !== "table") {
      expect(prepare(snapshot([record("a", { reference: "baseline-a", y: null })]), { filter: { reference: "baseline-a" } }).projection)
        .toMatchObject({ status: "no-records", message: expect.not.stringContaining("filter") });
    }
  });

  it("rejects filter fields forbidden by the schema while allowing declared fields of any type", () => {
    const properties = { x: { type: "number" }, y: { type: "number" }, name: { type: "string" }, group: { type: "string" } } as const;
    const schema: DataSchema = { type: "object", additionalProperties: false, properties };
    expect(prepare(snapshot([], [], schema), { filter: { reference: "baseline-a" } }).projection).toMatchObject({
      status: "mapping-incompatible", message: expect.stringContaining("field “reference”"),
    });
    expect(prepare(snapshot([], [], schema), { filter: { x: "1" } }).projection.status).toBe("no-records");
  });
});

describe("filter windows", () => {
  it.each(mappings.filter(mapping => mapping.type !== "scatter"))("applies $type sort and author limit within the selected records", (mapping) => {
    const data = snapshot([
      record("a", { x: 9, y: 90, reference: "hidden" }),
      record("b", { x: 1, y: 10, reference: "shown" }),
      record("c", { x: 2, y: 20, reference: "shown" }),
    ]);
    const options = mapping.type === "line" ? {} : { sort: { field: "y", direction: "desc" } };
    const view = prepareChartView(JSON.stringify({ ...mapping, ...options, filter: { reference: "shown" }, limit: 1 }), data);
    expect(ids(view)).toEqual(["c"]);
    expect(view.projection).toMatchObject({
      notice: `2 of 3 records · Showing ${mapping.type === "line" ? "the latest " : ""}1 of 2 records`, recordCount: 3,
      ...(mapping.type === "table" ? { invalidSchema: 0, barScales: [{ max: 2, signed: false }, null], shadeScale: { min: 20, max: 20 } }
        : { notPlotted: 0, diagnostics: { limited: 0 } }),
    });
  });

  it.each(mappings.filter(mapping => mapping.type !== "table"))("applies the $type record cap after filtering", (mapping) => {
    const selected = Array.from({ length: 5_001 }, (_, index) => record(`b-${String(index).padStart(4, "0")}`, {
      x: index, y: index, reference: "shown",
    }));
    const hidden = Array.from({ length: 5_001 }, (_, index) => record(`a-${String(index).padStart(4, "0")}`, {
      x: index + 10_000, y: 10_000, group: index, reference: "hidden",
    }));
    const view = prepareChartView(JSON.stringify({ ...mapping, filter: { reference: "shown" } }), snapshot([...selected, ...hidden]));
    expect(view.projection).toMatchObject({
      status: "ready", plottedCount: 5_000, eligibleCount: 5_001, recordCount: 10_002, notPlotted: 1,
      notice: `5001 of 10002 records · Showing ${mapping.type === "line" ? "the latest " : ""}5,000 of 5001 records`,
      diagnostics: { limited: 1, invalidSchema: 0 },
    });
    const selectedIds = ids(view);
    expect(selectedIds).toHaveLength(5_000);
    expect(selectedIds.every(id => id.startsWith("b-"))).toBe(true);
    expect(selectedIds[0]).toBe(mapping.type === "line" ? "b-0001" : "b-0000");
    if (view.type === "scatter" && view.projection.status === "ready") {
      expect(view.projection.domain).toEqual({ x: [0, 4_999], y: [0, 4_999] });
      expect(view.projection.groups).toEqual([{ key: '"shown"', value: "shown" }]);
    }
  });
});

import { describe, expect, it } from "vitest";
import { chartViewType, parseChartConfig, prepareChart, prepareChartView } from "../src/index.js";
import type { DocData } from "../src/index.js";

function snapshot(): DocData {
  return {
    valid: true, bytes: 0, errors: [], collections: [{
      name: "observations", schema: { version: 1, schema: { type: "object" } },
      records: [
        { id: "a", value: { x: 1, y: null } },
        { id: "b", value: { x: 2 } },
        { id: "invalid", value: { x: 3, y: 3 } },
      ],
      valid: false, invalidRecordIds: ["invalid"], errors: [],
    }],
  };
}

describe("shared chart-block projection", () => {
  const line = {
    version: 1, type: "line", collection: "observations", x: { field: "x", type: "number" },
    y: [{ field: "y" }],
  };

  it("accepts note field names under the y field rules and only in line-mapping series", () => {
    for (const note of ["event", "event.note", "__proto__", "↻"]) {
      expect(parseChartConfig(JSON.stringify({ ...line, y: [{ field: "y", note }] })))
        .toMatchObject({ ok: true, config: { y: [{ field: "y", note }] } });
    }
    for (const note of [null, "", 1, false, [], {}, "\ud800"]) {
      expect(parseChartConfig(JSON.stringify({ ...line, y: [{ field: "y", note }] }))).toMatchObject({ ok: false });
    }
    for (const mapping of [
      { ...line, note: "event" },
      { ...line, x: { ...line.x, note: "event" } },
      { version: 1, type: "scatter", collection: "observations", x: { field: "x", note: "event" }, y: { field: "y" }, label: "name" },
      { version: 1, type: "scatter", collection: "observations", x: { field: "x" }, y: { field: "y", note: "event" }, label: "name" },
      { version: 1, type: "bar", collection: "observations", category: { field: "x" }, y: [{ field: "y", note: "event" }] },
      { version: 1, type: "table", collection: "observations", columns: [{ field: "y", note: "event" }] },
    ]) {
      expect(prepareChartView(JSON.stringify(mapping), null).projection.status).toBe("invalid-configuration");
    }
  });

  it("carries only non-empty string notes on numeric points without changing the data projection", () => {
    const notes = ["↻1", "<b>Full note\nwith another line</b>", undefined, null, "", 12, false, [], {}];
    const data = snapshot();
    const collection = data.collections[0]!;
    collection.invalidRecordIds = [];
    collection.records = notes.map((note, index) => ({
      id: `row-${index}`, value: { x: index, y: index, "event.note": note ?? null },
    }));
    collection.records.push(
      { id: "absent", value: { x: 9, y: 9 } },
      { id: "no-value", value: { x: 10, "event.note": "NOT_PLOTTED" } },
      { id: "null-value", value: { x: 11, y: null, "event.note": "NOT_PLOTTED" } },
      { id: "invalid-value", value: { x: 12, y: "bad", "event.note": "NOT_PLOTTED" } },
    );
    const before = structuredClone(data);
    for (const type of ["line", "bar"]) {
      const plain = prepareChart(JSON.stringify({ ...line, y: [{ field: "y", type }] }), data);
      const annotated = prepareChart(JSON.stringify({ ...line, y: [{ field: "y", type, note: "event.note" }] }), data);
      if ((plain.status !== "ready") || annotated.status !== "ready") throw new Error("Fixture chart is not ready");
      expect(annotated.series[0]?.points.filter(point => point.note !== undefined)).toEqual([
        { id: "row-0", x: 0, y: 0, note: notes[0] },
        { id: "row-1", x: 1, y: 1, note: notes[1] },
      ]);
      expect({ ...annotated, config: plain.config, series: annotated.series.map(series => ({
        ...series, points: series.points.map(({ note: _note, ...point }) => point),
      })) }).toEqual(plain);
    }
    expect(data).toEqual(before);
  });

  it("requires note fields in closed schemas without imposing a stored value type", () => {
    const data = snapshot();
    const collection = data.collections[0]!;
    const properties: Record<string, { type: "number" }> = { x: { type: "number" }, y: { type: "number" } };
    collection.schema = { version: 1, schema: {
      type: "object", properties, additionalProperties: false,
    } };
    const source = JSON.stringify({ ...line, y: [{ field: "y", note: "event" }] });
    expect(prepareChartView(source, data).projection).toEqual({
      status: "mapping-incompatible",
      message: "Chart mapping is incompatible with the schema: field “event” is missing or has an incompatible type.",
    });
    properties.event = { type: "number" };
    expect(prepareChartView(source, data).projection.status).toBe("no-records");
  });

  it.each([
    ["{ incomplete", "line", "Invalid chart configuration: source must be JSON."],
    ["null", "line", "Invalid chart configuration:"],
    ['{"type":"line"}', "line", "Invalid chart configuration:"],
    ['{"type":"table"}', "table", "Invalid table configuration:"],
    ['{"type":"scatter"}', "scatter", "Invalid scatter configuration:"],
    ['{"type":"bar"}', "bar", "Invalid bar configuration:"],
  ] as const)("dispatches %s to the same parser and problem message", (source, type, message) => {
    expect(chartViewType(source)).toBe(type);
    expect(prepareChartView(source, null)).toMatchObject({
      type, projection: { status: "invalid-configuration", message: expect.stringContaining(message) },
    });
  });

  it("retains bound record and per-series projections when no chart record is plottable", () => {
    const source = JSON.stringify({
      version: 1, type: "line", collection: "observations", x: { field: "x", type: "number" },
      y: [{ field: "misspelled" }, { field: "y" }],
    });
    const view = prepareChartView(source, snapshot());
    expect(view).toMatchObject({
      type: "line", projection: {
        status: "no-records", recordCount: 3, eligibleCount: 2, plottedCount: 0,
        diagnostics: { invalidSchema: 1 },
        series: [
          { field: "misspelled", points: [{ x: 1, y: null }, { x: 2, y: null }] },
          { field: "y", points: [{ x: 1, y: null }, { x: 2, y: null }] },
        ],
      },
    });
    expect(view.projection).not.toHaveProperty("firstX");
    expect(view.projection).not.toHaveProperty("lastX");
  });

  it("keeps table counts and schema omissions for limited and empty row windows", () => {
    const source = JSON.stringify({
      version: 1, type: "table", collection: "observations", columns: [{ field: "x" }], limit: 1,
    });
    const data = snapshot();
    expect(prepareChartView(source, data)).toMatchObject({
      type: "table", projection: {
        status: "ready", recordCount: 3, invalidSchema: 1, rows: [{ id: "a" }],
      },
    });
    const collection = data.collections[0];
    if (collection === undefined) throw new Error("Fixture collection is absent");
    collection.invalidRecordIds = ["a", "b", "invalid"];
    expect(prepareChartView(source, data)).toMatchObject({
      type: "table", projection: { status: "no-records", recordCount: 3, invalidSchema: 3, rows: [] },
    });
  });
});

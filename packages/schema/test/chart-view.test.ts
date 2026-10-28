import { describe, expect, it } from "vitest";
import { chartViewType, prepareChartView } from "../src/index.js";
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
  it.each([
    ["{ incomplete", "line", "Invalid chart configuration: source must be JSON."],
    ["null", "line", "Invalid chart configuration:"],
    ['{"type":"line"}', "line", "Invalid chart configuration:"],
    ['{"type":"table"}', "table", "Invalid table configuration:"],
    ['{"type":"scatter"}', "scatter", "Invalid scatter configuration:"],
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

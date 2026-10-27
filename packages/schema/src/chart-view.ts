/** Shared chart-block dispatch keeps clients on the same mapping projection. */
import type { DocData } from "./data.js";
import { prepareChart } from "./chart-data.js";
import type { ChartProjection } from "./chart-data.js";
import { prepareTable } from "./table-data.js";
import type { TableProjection } from "./table-data.js";

export type ChartView =
  { type: "line"; projection: ChartProjection } |
  { type: "table"; projection: TableProjection };

export function chartViewType(source: string): "line" | "table" {
  try { return JSON.parse(source)?.type === "table" ? "table" : "line"; }
  catch { return "line"; }
}

export function prepareChartView(source: string, data: DocData | null): ChartView {
  return chartViewType(source) === "table"
    ? { type: "table", projection: prepareTable(source, data) }
    : { type: "line", projection: prepareChart(source, data) };
}

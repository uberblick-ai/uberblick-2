/** Shared chart-block dispatch keeps clients on the same mapping projection. */
import type { DocData } from "./data.js";
import { prepareChart } from "./chart-data.js";
import type { ChartProjection } from "./chart-data.js";
import { prepareTable } from "./table-data.js";
import type { TableProjection } from "./table-data.js";
import { prepareScatter } from "./scatter-data.js";
import type { ScatterProjection } from "./scatter-data.js";
import { prepareBar } from "./bar-data.js";
import type { BarProjection } from "./bar-data.js";
import { prepareDot } from "./dot-data.js";
import type { DotProjection } from "./dot-data.js";

export type ChartView =
  { type: "line"; projection: ChartProjection } |
  { type: "table"; projection: TableProjection } |
  { type: "bar"; projection: BarProjection } |
  { type: "dot"; projection: DotProjection } |
  { type: "scatter"; projection: ScatterProjection };

export function chartViewType(source: string): "line" | "table" | "scatter" | "bar" | "dot" {
  try {
    const type = JSON.parse(source)?.type;
    return type === "table" || type === "scatter" || type === "bar" || type === "dot" ? type : "line";
  }
  catch { return "line"; }
}

export function prepareChartView(source: string, data: DocData | null): ChartView {
  switch (chartViewType(source)) {
    case "table": return { type: "table", projection: prepareTable(source, data) };
    case "scatter": return { type: "scatter", projection: prepareScatter(source, data) };
    case "bar": return { type: "bar", projection: prepareBar(source, data) };
    case "dot": return { type: "dot", projection: prepareDot(source, data) };
    case "line": return { type: "line", projection: prepareChart(source, data) };
  }
}

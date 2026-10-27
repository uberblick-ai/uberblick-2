import { prepareChartView, readDocData } from "@uberblick/schema";
import type { Block, DocData } from "@uberblick/schema";
import type * as Y from "yjs";
import type { ChartWriteSummary } from "../outputs.js";

function xEndpoint(value: number, type: "number" | "date"): number | string {
  if (type === "number") return value;
  const iso = new Date(value).toISOString();
  return iso.endsWith("T00:00:00.000Z") ? iso.slice(0, -14) : iso;
}

function summarize(source: string, data: DocData | null): ChartWriteSummary {
  const view = prepareChartView(source, data);
  const result = view.projection;
  const warnings = result.status === "ready" ? [] : [result.message];
  if (view.type === "line") {
    const chart = view.projection;
    if (chart.status === "ready" || chart.status === "no-records") {
      const series = chart.series.map(series => ({
        field: series.field, pointCount: series.points.filter(point => typeof point.y === "number").length,
      }));
      for (const seriesCount of series) {
        if (seriesCount.pointCount === 0) warnings.push(`Chart series “${seriesCount.field}” has no plotted points.`);
      }
      const counts = { recordCount: chart.recordCount, plottedCount: chart.plottedCount, series };
      return chart.status === "ready"
        ? { status: chart.status, warnings, ...counts,
            firstX: xEndpoint(chart.firstX, chart.config.x.type), lastX: xEndpoint(chart.lastX, chart.config.x.type) }
        : { status: chart.status, message: chart.message, warnings, ...counts };
    }
  } else {
    const table = view.projection;
    if (table.status === "ready" || table.status === "no-records") {
      const counts = { recordCount: table.recordCount, rowCount: table.rows.length, invalidRecordCount: table.invalidSchema };
      return table.status === "ready" ? { status: table.status, warnings, ...counts }
        : { status: table.status, message: table.message, warnings, ...counts };
    }
  }
  if (result.status === "ready" || result.status === "no-records") throw new Error("Unreachable bound view");
  return result.status === "collection-absent"
    ? { status: result.status, message: result.message, warnings, collections: data?.collections.map(collection => collection.name) ?? [] }
    : { status: result.status, message: result.message, warnings };
}

function unavailable(): ChartWriteSummary {
  // Projection runs after application. Keep failures advisory and raw data or
  // exception details out of the write result.
  const message = "Chart unavailable: could not compute the chart summary.";
  return { status: "collection-unusable", message, warnings: [message] };
}

/** Read one snapshot for the written charts, without changing their source. */
export function summarizeWrittenBlocks(doc: Y.Doc, blocks: readonly Block[]) {
  let data: DocData | null = null;
  let readFailed = false;
  if (blocks.some(block => block.type === "chart")) {
    try { data = readDocData(doc); }
    catch { readFailed = true; }
  }
  return blocks.map(block => {
    const written = { id: block.id, rev: block.rev };
    if (block.type !== "chart") return written;
    try { return { ...written, chart: readFailed ? unavailable() : summarize(block.text, data) }; }
    catch { return { ...written, chart: unavailable() }; }
  });
}

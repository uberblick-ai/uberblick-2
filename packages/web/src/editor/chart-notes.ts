import type { FontSpec, Plugin } from "chart.js";
import { toFont } from "chart.js/helpers";
import { barAxisLabel } from "./bar-view.js";

export interface NotedPoint { x: number; y: number | null; note?: string }

/** Read current datasets so live data, mapping and appearance updates share the hook. */
export const chartNotes: Plugin<"line" | "bar"> = {
  id: "chart-point-notes",
  afterLayout(chart) {
    const datasets = chart.data.datasets.filter((_, index) => chart.isDatasetVisible(index));
    if (!datasets.some(dataset => (dataset.data as NotedPoint[]).some(point => point.note))) return;
    const room = toFont(chart.options.font as FontSpec).lineHeight + 8;
    const area = chart.chartArea;
    // Select native ticks at the original size, then remap only y pixels.
    // Layout padding would change automatic tick steps and even axis bounds.
    const top = Math.min(Math.max(0, room - area.top), Math.max(0, area.height - 1));
    const negative = datasets.some(dataset => dataset.type === "bar" &&
      (dataset.data as NotedPoint[]).some(point => point.note && point.y !== null && point.y < 0));
    const bottom = negative ? Math.min(room, Math.max(0, area.height - top - 1)) : 0;
    area.top += top;
    area.bottom -= bottom;
    area.height -= top + bottom;
    for (const scale of Object.values(chart.scales)) if (scale.axis === "y") {
      scale.top += top;
      scale.bottom -= bottom;
      scale.height -= top + bottom;
      scale.configure();
    }
  },
  afterDatasetsDraw(chart) {
    const { ctx, chartArea } = chart;
    const font = toFont(chart.options.font as FontSpec);
    const rows = new Map<number, { left: number; right: number; top: number; bottom: number }[]>();
    ctx.save();
    ctx.font = font.string;
    ctx.fillStyle = chart.options.color as string;
    ctx.textAlign = "left";
    ctx.textBaseline = "top";
    chart.data.datasets.forEach((dataset, datasetIndex) => {
      if (!chart.isDatasetVisible(datasetIndex)) return;
      const metadata = chart.getDatasetMeta(datasetIndex);
      (dataset.data as NotedPoint[]).forEach((point, index) => {
        const position = metadata.data[index];
        if (!point.note || point.y === null || position === undefined) return;
        if (dataset.type !== "bar") {
          // Drawing the marker here leaves native overflow and tick selection unchanged.
          ctx.fillStyle = dataset.borderColor as string;
          ctx.beginPath(); ctx.arc(position.x, position.y, 2, 0, Math.PI * 2); ctx.fill();
          ctx.fillStyle = chart.options.color as string;
        }
        const label = barAxisLabel(point.note, Math.min(160, chartArea.width - 4), text => ctx.measureText(text).width);
        const metrics = ctx.measureText(label);
        const width = metrics.width;
        const left = Math.max(chartArea.left + 2 + Math.max(0, metrics.actualBoundingBoxLeft),
          Math.min(position.x - width / 2, chartArea.right - 2 - Math.max(width, metrics.actualBoundingBoxRight)));
        const top = dataset.type === "bar" && point.y < 0 ? position.y + 6 : position.y - 6 - font.lineHeight;
        const rect = { left: left - metrics.actualBoundingBoxLeft, right: left + metrics.actualBoundingBoxRight,
          top: Math.min(top, top - metrics.actualBoundingBoxAscent), bottom: Math.max(top + font.lineHeight, top + metrics.actualBoundingBoxDescent) };
        if (rect.left < chartArea.left || rect.right > chartArea.right || rect.top < 0 || rect.bottom > (chart.scales.x?.top ?? chartArea.bottom)) return;
        const first = Math.floor(rect.top / font.lineHeight);
        const last = Math.floor(rect.bottom / font.lineHeight);
        for (let row = first; row <= last; row += 1) if (rows.get(row)?.some(other =>
          rect.left < other.right + 4 && rect.right + 4 > other.left && rect.top < other.bottom + 2 && rect.bottom + 2 > other.top)) return;
        for (let row = first; row <= last; row += 1) rows.set(row, [...rows.get(row) ?? [], rect]);
        ctx.fillText(label, left, top);
      });
    });
    ctx.restore();
  },
};

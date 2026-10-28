/** Chart.js owns plotting and hit testing; the native select owns keyboard input. */
import { Chart, ScatterController } from "chart.js";
import type { ChartConfiguration, Plugin, PointStyle } from "chart.js";
import type { ScatterAxisMapping, ScatterPoint, ScatterProjection, ScatterReady } from "@uberblick/schema";
import { createRoot } from "react-dom/client";
import type { ReactElement } from "react";
import { NativeSelect } from "../ui/shadcn/native-select.js";
import { tableCellFormatter } from "./table-data.js";
import type { TableCell } from "./table-data.js";
import { formatChartNumber } from "./chart-data.js";

Chart.register(ScatterController);
const SHAPES: PointStyle[] = ["circle", "triangle", "rect", "rectRot", "cross", "crossRot", "star", "rectRounded"];

export function scatterDiagnosticsText(result: ScatterProjection): string {
  if (!("diagnostics" in result)) return "";
  const { diagnostics: counts } = result;
  const reasons = counts.invalidSchema ? [`${counts.invalidSchema} invalid under the collection schema`] : [];
  for (const axis of ["x", "y"] as const) {
    const values = counts.axes[axis];
    if (values.absent) reasons.push(`${values.absent} absent ${axis}`);
    if (values.null) reasons.push(`${values.null} null ${axis}`);
    if (values.invalid) reasons.push(`${values.invalid} wrong-type ${axis}`);
  }
  if (counts.limited) reasons.push(`${counts.limited} outside the first 5,000`);
  const bounds: string[] = [];
  for (const axis of ["x", "y"] as const) for (const side of ["lower", "upper"] as const) {
    const values = counts.axes[axis].bounds[side];
    if (values.invalid) bounds.push(`${axis} ${side}: ${values.invalid} wrong-type`);
    if (values.wrongSide) bounds.push(`${axis} ${side}: ${values.wrongSide} on the wrong side`);
  }
  return [
    ...(result.notPlotted ? [`${result.notPlotted} records not plotted (${reasons.join("; ")}).`] : []),
    ...(bounds.length ? [`Omitted bounds: ${bounds.join("; ")}.`] : []), ...result.warnings,
  ].join(" ");
}

function textCell(point: ScatterPoint, field: string): TableCell {
  return tableCellFormatter({ field, format: "text" })(point.record);
}

/** Include stored markers even when an unusable bound cannot draw a whisker. */
export function scatterAxisText(point: ScatterPoint, mapping: ScatterAxisMapping): string {
  const unit = mapping.unit === undefined ? {} : { unit: mapping.unit };
  const cell = (field: string): string => tableCellFormatter({ field, format: "number", ...unit })(point.record).text;
  const value = cell(mapping.field);
  if (mapping.lower === undefined && mapping.upper === undefined) return value;
  if (mapping.lower !== undefined && mapping.upper !== undefined) {
    const lower = tableCellFormatter({ field: mapping.lower, format: "number" })(point.record);
    const upper = tableCellFormatter({ field: mapping.upper, format: "number", ...unit })(point.record);
    return `${value} (${lower.text}–${upper.text})`;
  }
  return `${value} (${mapping.lower !== undefined ? `lower: ${cell(mapping.lower)}` : `upper: ${cell(mapping.upper as string)}`})`;
}

function Cell({ cell }: { cell: TableCell }): ReactElement {
  return <span data-state={cell.state}>{cell.href === undefined ? cell.text
    : <a className="ub-data-link" href={cell.href} target="_blank" rel="noopener noreferrer">{cell.text}</a>}</span>;
}

function Details({ result, selected, select }: {
  result: ScatterReady; selected: string | null; select: (id: string) => void;
}): ReactElement {
  const { config } = result;
  const point = result.points.find(point => point.id === selected);
  const occurrences = new Map<string, number>();
  const details = config.details.map(column => {
    const signature = JSON.stringify(column);
    const occurrence = occurrences.get(signature) ?? 0;
    occurrences.set(signature, occurrence + 1);
    return { column, key: `${signature}:${occurrence}` };
  });
  return <>
    <NativeSelect aria-label="Select point" value={selected ?? ""} onChange={event => select(event.target.value)}>
      <option value="">Select a point</option>
      {result.points.map(point => <option key={point.id} value={point.id}>{textCell(point, config.label).text} · {point.id}</option>)}
    </NativeSelect>
    {point !== undefined && <dl>
      <dt>Label</dt><dd><Cell cell={textCell(point, config.label)} /></dd>
      <dt>Record</dt><dd>{point.id}</dd>
      {config.group !== undefined && <><dt>Group</dt><dd><Cell cell={textCell(point, config.group)} /></dd></>}
      <dt>{config.x.label || config.x.field}</dt><dd>{scatterAxisText(point, config.x)}</dd>
      <dt>{config.y.label || config.y.field}</dt><dd>{scatterAxisText(point, config.y)}</dd>
      {details.map(({ column, key }) => <div className="ub-scatter-detail" key={key}>
        <dt>{column.label || column.field}</dt><dd><Cell cell={tableCellFormatter(column)(point.record)} /></dd>
      </div>)}
    </dl>}
  </>;
}

export function scatterView(canvas: HTMLCanvasElement): {
  element: HTMLElement; render: (result: ScatterReady, colors: CSSStyleDeclaration, palette: string[]) => void;
  selectAt: (event: MouseEvent) => boolean; reset: () => void; clear: () => void; destroy: () => void;
} {
  const element = document.createElement("div");
  element.className = "ub-scatter-details";
  element.hidden = true;
  element.contentEditable = "false";
  const root = createRoot(element);
  let chart: Chart<"scatter", ScatterPoint[]> | null = null;
  let result: ScatterReady | null = null;
  let selected: string | null = null;
  let colors: CSSStyleDeclaration;
  let palette: string[] = [];
  const groupIndex = (point: ScatterPoint | undefined): number => result?.groups.findIndex(group => group.key === point?.groupKey) ?? -1;
  const color = (point: ScatterPoint | undefined): string => palette[groupIndex(point)] ?? colors.color;
  const showDetails = (): void => {
    if (result !== null) root.render(<Details result={result} selected={selected} select={select} />);
  };
  function select(id: string): void {
    selected = result?.points.some(point => point.id === id) ? id : null;
    showDetails();
    chart?.draw();
  }
  const decorations: Plugin<"scatter"> = {
    id: "stored-scatter-decorations",
    beforeDatasetsDraw(instance) {
      if (result === null) return;
      const { ctx, scales } = instance;
      const xScale = scales.x;
      const yScale = scales.y;
      if (xScale === undefined || yScale === undefined) return;
      ctx.save();
      ctx.lineWidth = 1;
      for (const point of result.points) {
        const x = xScale.getPixelForValue(point.x);
        const y = yScale.getPixelForValue(point.y);
        ctx.strokeStyle = color(point);
        ctx.beginPath();
        for (const bound of [point.xLower, point.xUpper]) if (bound !== undefined) {
          const end = xScale.getPixelForValue(bound);
          ctx.moveTo(x, y); ctx.lineTo(end, y);
          ctx.moveTo(end, y - 3); ctx.lineTo(end, y + 3);
        }
        for (const bound of [point.yLower, point.yUpper]) if (bound !== undefined) {
          const end = yScale.getPixelForValue(bound);
          ctx.moveTo(x, y); ctx.lineTo(x, end);
          ctx.moveTo(x - 3, end); ctx.lineTo(x + 3, end);
        }
        ctx.stroke();
      }
      ctx.restore();
    },
    afterDatasetsDraw(instance) {
      if (result === null) return;
      const { config } = result;
      const { ctx, chartArea } = instance;
      const metadata = instance.getDatasetMeta(0);
      const fontSize = Number.parseFloat(colors.fontSize);
      const lineHeight = Number.parseFloat(colors.lineHeight) || fontSize * 1.4;
      ctx.save();
      ctx.font = `${fontSize}px ${colors.fontFamily}`;
      ctx.fillStyle = colors.color;
      ctx.textBaseline = "top";
      const rows = new Map<number, { left: number; right: number; top: number; bottom: number }[]>();
      result.points.forEach((point, index) => {
        const position = metadata.data[index];
        if (position === undefined) return;
        const { x, y } = position;
        if (point.id === selected) {
          ctx.strokeStyle = colors.color;
          ctx.lineWidth = 2;
          ctx.beginPath(); ctx.arc(x, y, 9, 0, Math.PI * 2); ctx.stroke();
        }
        const lines = textCell(point, config.label).text.split(/\r?\n/);
        const width = Math.max(...lines.map(line => ctx.measureText(line).width));
        const left = x + 8 + width <= chartArea.right ? x + 8 : x - 8 - width;
        const top = y - lineHeight / 2;
        const rect = { left, right: left + width, top, bottom: top + lines.length * lineHeight };
        if (left < chartArea.left || rect.right > chartArea.right || top < chartArea.top || rect.bottom > chartArea.bottom) return;
        const first = Math.floor(top / lineHeight);
        const last = Math.floor(rect.bottom / lineHeight);
        for (let row = first; row <= last; row += 1) if (rows.get(row)?.some(other =>
          rect.left < other.right + 4 && rect.right + 4 > other.left && rect.top < other.bottom + 2 && rect.bottom + 2 > other.top)) return;
        for (let row = first; row <= last; row += 1) rows.set(row, [...rows.get(row) ?? [], rect]);
        lines.forEach((line, index) => { ctx.fillText(line, left, top + index * lineHeight); });
      });
      ctx.restore();
    },
  };
  const clear = (): void => {
    chart?.destroy();
    chart = null;
    result = null;
    selected = null;
    element.hidden = true;
    root.render(null);
  };
  return {
    element,
    render(next, nextColors, nextPalette) {
      result = next; colors = nextColors; palette = nextPalette;
      if (!next.points.some(point => point.id === selected)) selected = null;
      element.hidden = false;
      canvas.setAttribute("aria-label", next.config.title || `Scatter plot of ${next.config.y.label || next.config.y.field} by ${next.config.x.label || next.config.x.field}`);
      const font = { family: colors.fontFamily, size: Number.parseFloat(colors.fontSize), lineHeight: colors.lineHeight };
      const scale = (axis: "x" | "y") => ({
        type: "linear" as const,
        ...(next.config[axis].range === undefined
          ? { suggestedMin: next.domain[axis][0], suggestedMax: next.domain[axis][1] }
          : { min: next.domain[axis][0], max: next.domain[axis][1] }),
        title: { display: true, text: next.config[axis].label || next.config[axis].field, color: colors.color, font },
        ticks: { color: colors.color, font, maxTicksLimit: 6,
          callback: (value: string | number) => `${formatChartNumber(Number(value))}${next.config[axis].unit ? ` ${next.config[axis].unit}` : ""}` },
        grid: { color: colors.borderTopColor }, border: { display: false },
      });
      const configuration: ChartConfiguration<"scatter", ScatterPoint[]> = {
        type: "scatter", plugins: [decorations],
        data: { datasets: [{ data: next.points, showLine: false, pointRadius: 4, pointHitRadius: 8,
          pointStyle: context => SHAPES[groupIndex(next.points[context.dataIndex])] ?? "circle",
          backgroundColor: context => color(next.points[context.dataIndex]),
          borderColor: context => color(next.points[context.dataIndex]), borderWidth: 1.5, clip: false,
        }] },
        options: {
          animation: false, responsive: true, maintainAspectRatio: false,
          layout: { padding: 12 }, scales: { x: scale("x"), y: scale("y") },
          plugins: {
            tooltip: { enabled: false },
            legend: { display: next.groups.length > 0, position: "bottom", align: "start", onClick: () => {},
              labels: { color: colors.color, font, usePointStyle: true, boxHeight: 8,
                generateLabels: () => next.groups.map((group, index) => ({
                  text: typeof group.value === "string" ? group.value : JSON.stringify(group.value),
                  fontColor: colors.color, fillStyle: palette[index] ?? colors.color,
                  strokeStyle: palette[index] ?? colors.color, pointStyle: SHAPES[index] ?? "circle",
                })),
              },
            },
          },
        },
      };
      if (chart === null) chart = new Chart(canvas, configuration);
      else { chart.data = configuration.data; chart.options = configuration.options ?? {}; chart.update("none"); }
      showDetails();
    },
    selectAt(event) {
      if (chart === null || result === null || event.target !== canvas) return false;
      const hits = chart.getElementsAtEventForMode(event, "point", { intersect: true }, false);
      if (hits.length === 0) return false;
      const ids = hits.flatMap(hit => result?.points[hit.index]?.id ?? []);
      select(ids[(ids.indexOf(selected ?? "") + 1) % ids.length] ?? "");
      return true;
    },
    reset: () => { selected = null; }, clear,
    destroy: () => { chart?.destroy(); root.unmount(); },
  };
}

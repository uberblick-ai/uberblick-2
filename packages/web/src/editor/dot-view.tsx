/** Chart.js owns plotting and hit testing; the native select owns keyboard input. */
import { Chart, CategoryScale } from "chart.js";
import type { ChartConfiguration, FontSpec, Plugin } from "chart.js";
import { toFont } from "chart.js/helpers";
import type { DotReady, DotRow } from "@uberblick/schema";
import { createRoot } from "react-dom/client";
import { Fragment } from "react";
import type { ReactElement } from "react";
import { NativeSelect } from "../ui/shadcn/native-select.js";
import { barAxisLabel, barCoordinateText, chartTooltipLines } from "./bar-view.js";
import { chartAccessibleName, formatChartNumber, CHART_MIN_HEIGHT, CHART_MAX_HEIGHT } from "./chart-data.js";

export { barDiagnosticsText as dotDiagnosticsText } from "./bar-view.js";

Chart.register(CategoryScale);
type DotValues = (number | null)[];

function textWidth(ctx: CanvasRenderingContext2D, text: string): number {
  const metrics = ctx.measureText(text);
  return Math.max(0, metrics.actualBoundingBoxLeft) + Math.max(metrics.width, metrics.actualBoundingBoxRight);
}

export function dotDefaultHeight(result: DotReady): number {
  return Math.min(CHART_MAX_HEIGHT, Math.max(CHART_MIN_HEIGHT, 80 + (result.rows.length + result.series.length) * 24));
}

export function dotCategoryValues(result: DotReady, row: DotRow): { key: string; label: string; value: string }[] {
  return result.series.flatMap((series, index) => {
    const value = row.values[index];
    return value === undefined || value === null ? [] : [{ key: String(index), label: series.label,
      value: `${formatChartNumber(value)}${series.unit ? ` ${series.unit}` : ""}` }];
  });
}

/** Joined values follow the axis while their arrow retains the series direction. */
export function dotRowValues(result: DotReady, row: DotRow): string {
  const values = dotCategoryValues(result, row).map(({ value }) => value);
  if (!result.config.connect || values.length !== 2) return values.join(" · ");
  return (row.values[0] as number) > (row.values[1] as number)
    ? `${values[1]} ← ${values[0]}` : `${values[0]} → ${values[1]}`;
}

function Details({ result, selected, select }: {
  result: DotReady; selected: string | null; select: (id: string) => void;
}): ReactElement {
  const row = result.rows.find(row => row.id === selected);
  return <>
    <NativeSelect aria-label="Select category" value={selected ?? ""} onChange={event => select(event.target.value)}>
      <option value="">Select a category</option>
      {result.rows.map(row => <option key={row.id} value={row.id}>{row.label} · {row.id}</option>)}
    </NativeSelect>
    {row !== undefined && <dl>
      <dt>{result.config.category.label || result.config.category.field}</dt><dd>{row.label}</dd>
      {dotCategoryValues(result, row).map(({ key, label, value }) => <Fragment key={key}>
        <dt>{label}</dt><dd>{value}</dd>
      </Fragment>)}
      {row.values.every(value => value === null) && <><dt>Values</dt><dd>No numeric values</dd></>}
      {row.note !== undefined && <><dt>Note</dt><dd>{row.note}</dd></>}
    </dl>}
  </>;
}

function decorations(read: () => DotReady | null, readColors: () => CSSStyleDeclaration): Plugin<"line"> {
  let room = 0;
  const gap = 12;
  return {
    id: "category-dot-decorations",
    afterLayout(instance) {
      room = 0;
      const result = read();
      const scale = instance.scales.x;
      if (result === null || scale === undefined) return;
      const { ctx, chartArea } = instance;
      const available = Math.max(0, chartArea.width - 120);
      const font = toFont(instance.options.font as FontSpec);
      ctx.save(); ctx.font = font.string; ctx.textAlign = "left"; ctx.textBaseline = "middle";
      for (const row of result.rows) {
        const values = dotRowValues(result, row);
        const width = textWidth(ctx, values);
        // known limit: full row values that cannot fit beside a usable plot are omitted; revisit when narrow plots can provide more room.
        if (width + gap > available || (values === "" && !row.note)) continue;
        const note = row.note ? Math.min(160, textWidth(ctx, row.note.replace(/\s+/gu, " "))) + (values ? gap : 0) : 0;
        room = Math.max(room, Math.min(available, width + note + gap * 2));
      }
      ctx.restore();
      // Native tick generation and skipping must use the final plot width.
      chartArea.right -= room;
      chartArea.width -= room;
      scale.right -= room;
      scale.width -= room;
      if (room > 0) {
        const bounds = { left: scale.left, right: scale.right, top: scale.top, bottom: scale.bottom, width: scale.width, height: scale.height };
        scale.update(bounds.width, bounds.height, { left: bounds.left, right: instance.width - bounds.right,
          top: 0, bottom: 0, width: bounds.width, height: bounds.height });
        Object.assign(scale, bounds);
      }
      scale.configure();
    },
    beforeDatasetsDraw(instance) {
      const result = read();
      const scale = instance.scales.x;
      if (result === null || scale === undefined) return;
      const { ctx, chartArea } = instance;
      ctx.save(); ctx.strokeStyle = readColors().color; ctx.lineWidth = 2;
      for (const value of new Set(result.config.y.flatMap(series => series.reference === undefined ? [] : [series.reference]))) {
        const at = scale.getPixelForValue(value / (result.coordinateDivisor ?? 1));
        ctx.beginPath(); ctx.moveTo(at, chartArea.top); ctx.lineTo(at, chartArea.bottom); ctx.stroke();
      }
      if (result.config.connect) {
        const first = instance.getDatasetMeta(0);
        const second = instance.getDatasetMeta(1);
        ctx.lineWidth = 1.5;
        result.rows.forEach((row, index) => {
          const start = first.data[index];
          const end = second.data[index];
          // known limit: a missing member of a pair draws its single dot without a line; revisit when partial pairs need another representation.
          if (row.values[0] == null || row.values[1] == null || start === undefined || end === undefined || Math.abs(end.x - start.x) <= 10) return;
          const direction = Math.sign(end.x - start.x);
          ctx.beginPath(); ctx.moveTo(start.x + direction * 5, start.y); ctx.lineTo(end.x - direction * 5, end.y); ctx.stroke();
        });
      }
      ctx.restore();
    },
    afterDatasetsDraw(instance) {
      const result = read();
      const scale = instance.scales.y;
      if (result === null || scale === undefined || room === 0) return;
      const { ctx, chartArea } = instance;
      const font = toFont(instance.options.font as FontSpec);
      const available = room - gap;
      let previousBottom = -Infinity;
      ctx.save(); ctx.font = font.string; ctx.fillStyle = readColors().color;
      ctx.textAlign = "left"; ctx.textBaseline = "middle";
      result.rows.forEach((row, index) => {
        const values = dotRowValues(result, row);
        const valueWidth = textWidth(ctx, values);
        // Subpixel layout arithmetic must not discard a value that fits its gutter.
        if (valueWidth > available + 0.5) return;
        const noteRoom = available - valueWidth - (values ? gap : 0);
        let note = row.note && noteRoom >= textWidth(ctx, "…")
          ? barAxisLabel(row.note, noteRoom, text => textWidth(ctx, text)) : "";
        const metrics = ctx.measureText(values);
        const left = chartArea.right + gap + Math.max(0, metrics.actualBoundingBoxLeft);
        const right = left + Math.max(metrics.width, metrics.actualBoundingBoxRight);
        if (right > chartArea.right + room) return;
        const noteLeft = chartArea.right + gap + valueWidth + (values ? gap : 0);
        let noteMetrics = ctx.measureText(note);
        let noteInkLeft = noteLeft + Math.max(0, noteMetrics.actualBoundingBoxLeft);
        if (noteInkLeft + Math.max(noteMetrics.width, noteMetrics.actualBoundingBoxRight) > chartArea.right + room) {
          note = ""; noteMetrics = ctx.measureText(""); noteInkLeft = noteLeft;
        }
        if (!values && !note) return;
        const y = scale.getPixelForValue(index);
        const top = y - Math.max(font.lineHeight / 2, metrics.actualBoundingBoxAscent, noteMetrics.actualBoundingBoxAscent);
        const bottom = y + Math.max(font.lineHeight / 2, metrics.actualBoundingBoxDescent, noteMetrics.actualBoundingBoxDescent);
        // known limit: row text that collides at the capped or authored height is omitted; revisit when dense rows can retain readable text.
        if (top < chartArea.top || bottom > chartArea.bottom || top < previousBottom + 2) return;
        if (values) ctx.fillText(values, left, y);
        if (note) ctx.fillText(note, noteInkLeft, y);
        previousBottom = bottom;
      });
      ctx.restore();
    },
  };
}

export function dotConfiguration(result: DotReady, colors: CSSStyleDeclaration, palette: string[], decorationPlugin?: Plugin<"line">,
  selectCategory?: (id: string) => void): ChartConfiguration<"line", DotValues> {
  const font = { family: colors.fontFamily, size: Number.parseFloat(colors.fontSize), lineHeight: colors.lineHeight };
  const units = new Set(result.series.map(series => series.unit || ""));
  const unit = units.size === 1 ? result.series[0]?.unit || "" : "";
  const divisor = result.coordinateDivisor ?? 1;
  const declared = result.config.y.flatMap(series => series.range === undefined ? [] : [[series.range[0] / divisor, series.range[1] / divisor] as [number, number]]);
  return {
    type: "line", plugins: [decorationPlugin ?? decorations(() => result, () => colors)],
    data: {
      labels: result.rows.map(row => row.label),
      datasets: result.series.map((series, index) => ({
        label: series.label, data: result.rows.map(row => row.values[index] == null ? null : (row.values[index] as number) / divisor),
        showLine: false, pointRadius: 4, pointHitRadius: 8, pointHoverRadius: 5,
        pointStyle: "circle", borderColor: palette[index],
        backgroundColor: result.series.length === 2 && index === 0 ? "transparent" : palette[index],
        borderWidth: 1.5, pointBorderWidth: 1.5,
      })),
    },
    options: {
      animation: false, responsive: true, maintainAspectRatio: false, indexAxis: "y", color: colors.color, font,
      interaction: { mode: "index", axis: "y", intersect: false },
      onHover: (_event, elements) => {
        const row = result.rows[elements[0]?.index ?? -1];
        if (row !== undefined) selectCategory?.(row.id);
      },
      scales: {
        x: {
          type: "linear", beginAtZero: false,
          ...(declared.length ? {
            ...(result.domain[0] === Math.min(...declared.map(range => range[0])) ? { min: result.domain[0] } : { suggestedMin: result.domain[0] }),
            ...(result.domain[1] === Math.max(...declared.map(range => range[1])) ? { max: result.domain[1] } : { suggestedMax: result.domain[1] }),
          } : { suggestedMin: result.domain[0], suggestedMax: result.domain[1] }),
          afterBuildTicks(scale) {
            // Native rounding may reach zero even when every plotted value stays on one side.
            if (result.domain[0] > 0 && scale.min <= 0) scale.min = result.domain[0];
            if (result.domain[1] < 0 && scale.max >= 0) scale.max = result.domain[1];
            scale.ticks = scale.ticks.filter(tick => tick.value >= scale.min && tick.value <= scale.max);
          },
          ticks: { color: colors.color, font, maxTicksLimit: 6, maxRotation: 0,
            callback: value => `${barCoordinateText(Number(value), divisor)}${unit ? ` ${unit}` : ""}` },
          grid: { color: colors.borderTopColor }, border: { display: false },
        },
        y: {
          type: "category", offset: true,
          title: { display: true, text: result.config.category.label || result.config.category.field, color: colors.color, font },
          // known limit: crowded category labels are skipped at the height cap or authored size; revisit when a denser readable axis is available.
          ticks: { autoSkip: true, maxRotation: 0, color: colors.color, font,
            callback(value) {
              const label = result.rows[Number(value)]?.label ?? "";
              const ctx = this.chart.ctx;
              ctx.save(); ctx.font = `${font.size}px ${font.family}`;
              const shortened = barAxisLabel(label, Math.max(24, Math.min(180, this.chart.width * 0.35)), text => ctx.measureText(text).width);
              ctx.restore(); return shortened;
            },
          },
          grid: { display: false }, border: { display: false },
        },
      },
      plugins: {
        legend: { display: true, position: "bottom", align: "start", onClick: () => {},
          ...(result.config.height === undefined ? { maxHeight: CHART_MAX_HEIGHT } : {}),
          labels: { color: colors.color, font, usePointStyle: true, pointStyle: "circle", boxWidth: 12, boxHeight: 12 } },
        tooltip: { titleFont: font, bodyFont: font, displayColors: false,
          filter: (_item, index) => index === 0,
          callbacks: {
            title(items) {
              const row = result.rows[items[0]?.dataIndex ?? -1];
              if (row === undefined) return [];
              const ctx = this.chart.ctx;
              ctx.save(); ctx.font = `bold ${font.size}px ${font.family}`;
              const title = chartTooltipLines(row.label, Math.max(40, this.chart.width - 32), text => ctx.measureText(text).width);
              ctx.restore(); return title;
            },
            label(item) {
              const row = result.rows[item.dataIndex];
              if (row === undefined) return [];
              const ctx = this.chart.ctx;
              ctx.save(); ctx.font = `${font.size}px ${font.family}`;
              const lines = [
                ...dotCategoryValues(result, row).map(({ label, value }) => `${label}: ${value}`),
                ...(row.note === undefined ? [] : [row.note]),
              ].flatMap(text => chartTooltipLines(text, Math.max(40, this.chart.width - 32), text => ctx.measureText(text).width));
              ctx.restore(); return lines;
            },
          },
        },
      },
    },
  };
}

export function dotView(canvas: HTMLCanvasElement): {
  element: HTMLElement; render: (result: DotReady, colors: CSSStyleDeclaration, palette: string[]) => void;
  selectAt: (event: MouseEvent) => boolean; reset: () => void; clear: () => void; destroy: () => void;
} {
  const element = document.createElement("div");
  element.className = "ub-dot-details";
  element.hidden = true; element.contentEditable = "false";
  const root = createRoot(element);
  let chart: Chart<"line", DotValues> | null = null;
  let result: DotReady | null = null;
  let selected: string | null = null;
  let colors: CSSStyleDeclaration;
  const drawing = decorations(() => result, () => colors);
  const showDetails = (): void => {
    if (result !== null) root.render(<Details result={result} selected={selected} select={select} />);
  };
  function select(id: string): void {
    const next = result?.rows.some(row => row.id === id) ? id : null;
    if (selected === next) return;
    selected = next; showDetails();
  }
  return {
    element,
    render(next, nextColors, palette) {
      result = next; colors = nextColors;
      if (!next.rows.some(row => row.id === selected)) selected = null;
      element.hidden = false;
      canvas.setAttribute("aria-label", chartAccessibleName(next.config));
      const configuration = dotConfiguration(next, colors, palette, drawing, select);
      if (chart === null) chart = new Chart(canvas, configuration);
      else { chart.data = configuration.data; chart.options = configuration.options ?? {}; chart.update("none"); }
      showDetails();
    },
    selectAt(event) {
      if (chart === null || result === null || event.target !== canvas) return false;
      const hit = chart.getElementsAtEventForMode(event, "point", { intersect: true }, false)[0];
      if (hit === undefined) return false;
      select(result.rows[hit.index]?.id ?? ""); return true;
    },
    reset: () => { selected = null; },
    clear: () => { chart?.destroy(); chart = null; result = null; selected = null; element.hidden = true; root.render(null); },
    destroy: () => { chart?.destroy(); root.unmount(); },
  };
}

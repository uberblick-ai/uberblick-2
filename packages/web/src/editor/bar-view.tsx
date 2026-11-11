/** Chart.js owns plotting and hit testing; the native select owns keyboard input. */
import { Chart, CategoryScale } from "chart.js";
import type { ChartConfiguration, Plugin } from "chart.js";
import type { BarProjection, BarReady, BarRow } from "@uberblick/schema";
import { createRoot } from "react-dom/client";
import { Fragment } from "react";
import type { ReactElement } from "react";
import { NativeSelect } from "../ui/shadcn/native-select.js";
import { chartAccessibleName, formatChartNumber, CHART_MIN_HEIGHT, CHART_MAX_HEIGHT } from "./chart-data.js";

Chart.register(CategoryScale);
type BarValues = (number | null)[];

export function barDefaultHeight(result: BarReady): number | undefined {
  return result.config.orientation === "horizontal"
    // Reserve one legend row per series, including a narrow document column.
    ? Math.min(CHART_MAX_HEIGHT, Math.max(CHART_MIN_HEIGHT, 80 + (result.rows.length + result.series.length) * 24))
    : undefined;
}

/** Restore authored units after coordinate scaling, even above the finite number span. */
export function barCoordinateText(value: number, divisor: number): string {
  if (divisor === 1 || value === 0) return formatChartNumber(value);
  const power = Math.floor(Math.log10(divisor));
  const coefficient = value * (divisor / 10 ** power);
  const adjustment = Math.floor(Math.log10(Math.abs(coefficient)));
  return `${formatChartNumber(coefficient / 10 ** adjustment)}e${power + adjustment}`;
}

export function barDiagnosticsText(result: BarProjection): string {
  if (!("diagnostics" in result)) return "";
  const { diagnostics: counts } = result;
  const reasons = [
    [counts.invalidSchema, "invalid under the collection schema"],
    [counts.missingCategory, "absent or null category"],
    [counts.noNumericY, "without numeric series values"],
    [counts.limited, "outside the first 5,000"],
  ] as const;
  const omitted = reasons.filter(([count]) => count > 0).map(([count, reason]) => `${count} ${reason}`).join("; ");
  const values = counts.series.flatMap(series => [
    ...(series.absent ? [`${series.label}: ${series.absent} absent`] : []),
    ...(series.null ? [`${series.label}: ${series.null} null`] : []),
    ...(series.invalid ? [`${series.label}: ${series.invalid} wrong-type`] : []),
  ]);
  return [
    ...(result.notPlotted ? [`${result.notPlotted} records not plotted (${omitted}).`] : []),
    ...(values.length ? [`Omitted series values: ${values.join("; ")}.`] : []),
    ...result.warnings,
  ].join(" ");
}

export function barCategoryValues(result: BarReady, row: BarRow): { key: string; label: string; value: string }[] {
  const occurrences = new Map<string, number>();
  return result.series.flatMap((series, index) => {
    const signature = JSON.stringify(series);
    const occurrence = occurrences.get(signature) ?? 0;
    occurrences.set(signature, occurrence + 1);
    const value = row.values[index];
    return value === undefined || value === null ? []
      : [{ key: `${signature}:${occurrence}`, label: series.label, value: `${formatChartNumber(value)}${series.unit ? ` ${series.unit}` : ""}` }];
  });
}

function Details({ result, selected, select }: {
  result: BarReady; selected: string | null; select: (id: string) => void;
}): ReactElement {
  const row = result.rows.find(row => row.id === selected);
  return <>
    <NativeSelect aria-label="Select category" value={selected ?? ""} onChange={event => select(event.target.value)}>
      <option value="">Select a category</option>
      {result.rows.map(row => <option key={row.id} value={row.id}>{row.label} · {row.id}</option>)}
    </NativeSelect>
    {row !== undefined && <dl>
      <dt>{result.config.category.label || result.config.category.field}</dt><dd>{row.label}</dd>
      {barCategoryValues(result, row).map(({ key, label, value }) => <Fragment key={key}>
        <dt>{label}</dt><dd>{value}</dd>
      </Fragment>)}
      {row.values.every(value => value === null) && <><dt>Values</dt><dd>No numeric values</dd></>}
    </dl>}
  </>;
}

/** Axis labels fit their slot; the tooltip and selector retain the full label. */
export function barAxisLabel(label: string, width: number, measure: (text: string) => number): string {
  const text = label.replace(/\s+/gu, " ");
  if (measure(text) <= width) return text;
  const letters = Array.from(text);
  let low = 0;
  let high = letters.length;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (measure(`${letters.slice(0, middle).join("")}…`) <= width) low = middle;
    else high = middle - 1;
  }
  return `${letters.slice(0, low).join("")}…`;
}

function tooltipTitle(label: string, width: number, measure: (text: string) => number): string[] {
  const lines: string[] = [];
  for (const line of label.split(/\r?\n/u)) {
    let current = "";
    for (const letter of line) {
      if (current !== "" && measure(current + letter) > width) { lines.push(current); current = ""; }
      current += letter;
    }
    lines.push(current);
  }
  return lines;
}

function references(read: () => BarReady | null, readColors: () => CSSStyleDeclaration): Plugin<"bar"> {
  return {
    id: "category-bar-references",
    beforeDatasetsDraw(instance) {
      const result = read();
      if (result === null) return;
      const horizontal = result.config.orientation === "horizontal";
      const scale = instance.scales[horizontal ? "x" : "y"];
      if (scale === undefined) return;
      const { ctx, chartArea } = instance;
      ctx.save();
      ctx.strokeStyle = readColors().color;
      ctx.lineWidth = 2;
      for (const value of new Set(result.config.y.flatMap(series => series.reference === undefined ? [] : [series.reference]))) {
        const at = scale.getPixelForValue(value / (result.coordinateDivisor ?? 1));
        ctx.beginPath();
        ctx.moveTo(horizontal ? at : chartArea.left, horizontal ? chartArea.top : at);
        ctx.lineTo(horizontal ? at : chartArea.right, horizontal ? chartArea.bottom : at);
        ctx.stroke();
      }
      ctx.restore();
    },
  };
}

export function barConfiguration(result: BarReady, colors: CSSStyleDeclaration, palette: string[], referencePlugin?: Plugin<"bar">,
  selectCategory?: (id: string) => void): ChartConfiguration<"bar", BarValues> {
  const horizontal = result.config.orientation === "horizontal";
  const font = { family: colors.fontFamily, size: Number.parseFloat(colors.fontSize), lineHeight: colors.lineHeight };
  const units = new Set(result.series.map(series => series.unit || ""));
  const unit = units.size === 1 ? result.series[0]?.unit || "" : "";
  const divisor = result.coordinateDivisor ?? 1;
  const declared = result.config.y.flatMap(series => series.range === undefined ? [] : [[series.range[0] / divisor, series.range[1] / divisor] as [number, number]]);
  const valueScale = {
    type: "linear" as const, stacked: true, beginAtZero: true,
    ...(declared.length ? {
      ...(result.domain[0] === Math.min(0, ...declared.map(range => range[0])) ? { min: result.domain[0] } : { suggestedMin: result.domain[0] }),
      ...(result.domain[1] === Math.max(0, ...declared.map(range => range[1])) ? { max: result.domain[1] } : { suggestedMax: result.domain[1] }),
    } : { suggestedMin: result.domain[0], suggestedMax: result.domain[1] }),
    ticks: { color: colors.color, font, maxTicksLimit: 6,
      callback: (value: string | number) => `${barCoordinateText(Number(value), divisor)}${unit ? ` ${unit}` : ""}` },
    grid: { color: colors.borderTopColor }, border: { display: false },
  };
  return {
    type: "bar", plugins: [referencePlugin ?? references(() => result, () => colors)],
    data: {
      // The index identifies a record even when several records share a label.
      labels: result.rows.map(row => row.label),
      datasets: result.series.map((series, index) => ({
        label: series.label, data: result.rows.map(row => row.values[index] == null ? null : (row.values[index] as number) / divisor),
        // Disjoint namespaces keep every unstacked series separate from author names.
        stack: series.stack === undefined ? `series:${index}` : `stack:${series.stack}`,
        borderColor: palette[index], backgroundColor: palette[index], borderWidth: 0,
      })),
    },
    options: {
      animation: false, responsive: true, maintainAspectRatio: false, indexAxis: horizontal ? "y" : "x",
      color: colors.color, font,
      interaction: { mode: "index", axis: horizontal ? "y" : "x", intersect: false },
      onHover: (_event, elements) => {
        const row = result.rows[elements[0]?.index ?? -1];
        if (row !== undefined) selectCategory?.(row.id);
      },
      scales: {
        [horizontal ? "x" : "y"]: valueScale,
        [horizontal ? "y" : "x"]: {
          type: "category", stacked: true, offset: true,
          title: { display: true, text: result.config.category.label || result.config.category.field, color: colors.color, font },
          // known limit: crowded category labels are skipped at the height cap or authored size; revisit when a denser readable axis is available.
          ticks: { autoSkip: true, maxRotation: 0, color: colors.color, font,
            callback(value) {
              const label = result.rows[Number(value)]?.label ?? "";
              const width = horizontal ? Math.max(24, Math.min(180, this.chart.width * 0.35))
                : Math.max(40, Math.min(130, this.chart.width / Math.min(result.rows.length, 6)));
              const ctx = this.chart.ctx;
              ctx.save(); ctx.font = `${font.size}px ${font.family}`;
              const shortened = barAxisLabel(label, width, text => ctx.measureText(text).width);
              ctx.restore();
              return shortened;
            },
          },
          grid: { display: false }, border: { display: false },
        },
      },
      plugins: {
        legend: { display: true, position: "bottom", align: "start", onClick: () => {},
          ...(horizontal && result.config.height === undefined ? { maxHeight: CHART_MAX_HEIGHT } : {}),
          labels: { color: colors.color, font, boxWidth: 12, boxHeight: 12 } },
        tooltip: { titleFont: font, bodyFont: font, displayColors: false,
          filter: (_item, index) => index === 0,
          callbacks: {
            title(items) {
              const row = result.rows[items[0]?.dataIndex ?? -1];
              if (row === undefined) return [];
              const ctx = this.chart.ctx;
              ctx.save(); ctx.font = `bold ${font.size}px ${font.family}`;
              const title = tooltipTitle(row.label, Math.max(40, this.chart.width - 32), text => ctx.measureText(text).width);
              ctx.restore();
              return title;
            },
            label: item => {
              const row = result.rows[item.dataIndex];
              return row === undefined ? [] : barCategoryValues(result, row).map(({ label, value }) => `${label}: ${value}`);
            },
          },
        },
      },
    },
  };
}

export function barView(canvas: HTMLCanvasElement): {
  element: HTMLElement; render: (result: BarReady, colors: CSSStyleDeclaration, palette: string[]) => void;
  selectAt: (event: MouseEvent) => boolean; reset: () => void; clear: () => void; destroy: () => void;
} {
  const element = document.createElement("div");
  element.className = "ub-bar-details";
  element.hidden = true;
  element.contentEditable = "false";
  const root = createRoot(element);
  let chart: Chart<"bar", BarValues> | null = null;
  let result: BarReady | null = null;
  let selected: string | null = null;
  let colors: CSSStyleDeclaration;
  const decorations = references(() => result, () => colors);
  const showDetails = (): void => {
    if (result !== null) root.render(<Details result={result} selected={selected} select={select} />);
  };
  function select(id: string): void {
    const next = result?.rows.some(row => row.id === id) ? id : null;
    if (selected === next) return;
    selected = next;
    showDetails();
  }
  return {
    element,
    render(next, nextColors, palette) {
      result = next; colors = nextColors;
      if (!next.rows.some(row => row.id === selected)) selected = null;
      element.hidden = false;
      canvas.setAttribute("aria-label", chartAccessibleName(next.config));
      const configuration = barConfiguration(next, colors, palette, decorations, select);
      if (chart === null) chart = new Chart(canvas, configuration);
      else { chart.data = configuration.data; chart.options = configuration.options ?? {}; chart.update("none"); }
      showDetails();
    },
    selectAt(event) {
      if (chart === null || result === null || event.target !== canvas) return false;
      const hit = chart.getElementsAtEventForMode(event, "point", { intersect: true }, false)[0];
      if (hit === undefined) return false;
      select(result.rows[hit.index]?.id ?? "");
      return true;
    },
    reset: () => { selected = null; },
    clear: () => {
      chart?.destroy(); chart = null; result = null; selected = null;
      element.hidden = true; root.render(null);
    },
    destroy: () => { chart?.destroy(); root.unmount(); },
  };
}

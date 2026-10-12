/**
 * A document-owned data view. Only the JSON mapping is block content. Drawing,
 * diagnostics and subscriptions never dispatch a content transaction or repair
 * data; asynchronous DOM writes stay inside ignored chrome (see terminal.ts).
 */
import { Extension } from "@tiptap/core";
import type { NodeViewRenderer, NodeViewRendererProps } from "@tiptap/core";
import type { Node as PMNode } from "@tiptap/pm/model";
import { TextSelection } from "@tiptap/pm/state";
import type { NodeView } from "@tiptap/pm/view";
import {
  Chart, LineController, LineElement, PointElement, LinearScale, Legend, Tooltip,
} from "chart.js";
import type { ChartConfiguration, Scale } from "chart.js";
import { COMMENT_MARK } from "@uberblick/schema";
import type { DocData } from "@uberblick/schema";
import type * as Y from "yjs";
import {
  prepareChart, formatChartX, formatChartNumber, chartAccessibleName,
  CHART_RECORD_LIMIT, chartAccessibleDescription, chartDiagnosticsText,
} from "./chart-data.js";
import type { ChartReady } from "./chart-data.js";
import { chartChrome, copyButton, sourceEditingPlugin } from "./source-chrome.js";
import { prepareTable, tableDiagnosticsText } from "./table-data.js";
import { dataTableView } from "./table-view.js";
import { bindDocView } from "./view-bindings.js";
import { observationEndpoints, observationTicks } from "./chart-ticks.js";
import { chartAxes, chartPanelRanges, chartPointRadius, formatChartTick } from "./chart-presentation.js";

// Both axes are linear. Epoch milliseconds plus Intl date labels require no
// date adapter. No auto registry, decimator, transform or chart plugin package.
Chart.register(LineController, LineElement, PointElement, LinearScale, Legend, Tooltip);
type Point = { x: number; y: number | null };

const LIGHT = ["#1d4ed8", "#b91c1c", "#047857", "#7e22ce", "#a16207", "#0e7490", "#be185d", "#334155"];
const DARK = ["#93c5fd", "#fca5a5", "#6ee7b7", "#d8b4fe", "#fde047", "#67e8f9", "#f9a8d4", "#cbd5e1"];

function lineConfigurations(result: ChartReady, colors: CSSStyleDeclaration, palette: string[], canvas: HTMLCanvasElement) {
  const { config } = result;
  const layout = config.layout === "panels" ? "panels" : "overlay";
  const axes = chartAxes(config.y);
  // Chart.js also extends all-negative axes to zero when enabled.
  const beginAtZero = (axis: "y" | "yRight"): boolean => !result.series.some((series, index) =>
    axes.seriesAxes[index] === axis && series.points.some(point => point.y !== null && point.y < 0));
  const font = { family: colors.fontFamily, size: 11 };
  const ranges = layout === "panels" ? chartPanelRanges(result.series) : [];
  const panelUnit = (index: number): string => result.series[index]?.unit || "";
  const formatValue = (index: number, value: number): string =>
    `${formatChartNumber(value)}${panelUnit(index) ? ` ${panelUnit(index)}` : ""}`;
  // Equal gutters give equal-width panels identical observation selections,
  // even when their unit labels have different widths.
  const measure = layout === "panels" ? canvas.getContext("2d") : null;
  let panelAxisWidth = 0;
  if (layout === "panels" && measure !== null) {
    measure.save();
    measure.font = `${font.size}px ${font.family}`;
    ranges.forEach((range, index) => {
      let { min, max } = range;
      // Reserve native constant-range expansion and one extra digit when nice
      // rounding crosses a decimal boundary (for example, 99 becomes 100).
      if (min === max) {
        const padding = max === 0 ? 1 : Math.abs(max * 0.05);
        max += padding;
        if (min < 0) min -= padding;
      }
      const ticks = [min, min / 2 + max / 2, max].map(value => ({ value }));
      for (const tick of ticks) panelAxisWidth = Math.max(panelAxisWidth,
        measure.measureText(formatChartTick(tick.value, panelUnit(index), ticks)).width + 12 + font.size);
    });
    measure.restore();
  }
  const xValues = [...new Set(result.series.flatMap(series =>
    series.points.filter(point => point.y !== null).map(point => point.x)))].sort((a, b) => a - b);
  const endpoints = layout === "panels" ? observationEndpoints(xValues, config.x.type) : null;
  const fittedTicks = new Map<number, ReturnType<typeof observationTicks>>();
  const configurationFor = (indices: number[]): ChartConfiguration<"line", Point[]> => {
    const xLabels = new Map<number, string[]>();
    const setTicks = (scale: Scale, ticks: ReturnType<typeof observationTicks>): void => {
      xLabels.clear();
      for (const tick of ticks) xLabels.set(tick.value, tick.label);
      // Chart.js attaches a scale-specific context to each tick object.
      scale.ticks = layout === "panels" ? ticks.map(tick => ({ ...tick })) : ticks;
    };
    const selectTicks = (scale: Scale): void => {
      const ctx = scale.chart.ctx;
      ctx.save();
      ctx.font = `${font.size}px ${font.family}`;
      let ticks = layout === "panels" ? fittedTicks.get(scale.width) : undefined;
      if (ticks === undefined) {
        ticks = observationTicks(xValues, config.x.type, scale.min, scale.max, scale.width,
          label => ctx.measureText(label).width + (layout === "panels" ? 6 : 0));
        if (layout === "panels") fittedTicks.set(scale.width, ticks);
      }
      ctx.restore();
      setTicks(scale, ticks);
    };
    // Equal explicit limits leave a zero range in Chart.js. Only this
    // degenerate case gets a small range, placing its point in the middle.
    const padding = config.x.type === "date" ? 30_000 : Math.max(1, Math.abs(result.firstX) * Number.EPSILON * 4);
    const min = result.firstX === result.lastX ? Math.max(-Number.MAX_VALUE, result.firstX - padding) : result.firstX;
    const max = result.firstX === result.lastX ? Math.min(Number.MAX_VALUE, result.lastX + padding) : result.lastX;
    const configuration: ChartConfiguration<"line", Point[]> = {
      type: "line",
      data: { datasets: indices.map(index => {
        const series = result.series[index];
        if (series === undefined) throw new Error("Chart series is absent");
        const plottedValues = series.points.filter(point => point.y !== null).length;
        return {
          label: axes.legendLabels[index] ?? series.label,
          yAxisID: layout === "panels" ? "y" : axes.seriesAxes[index],
          data: series.points.map(({ x, y }) => ({ x, y })),
          borderColor: palette[index],
          backgroundColor: palette[index],
          borderWidth: 2,
          // A dense gap-free panel has no visible points. A constant lets
          // Chart.js share its point options instead of resolving every point.
          pointRadius: layout === "panels" && plottedValues > 40 && plottedValues === series.points.length
            ? 0 : context => chartPointRadius(series.points, context.dataIndex, plottedValues),
          pointHoverRadius: 4,
          pointHitRadius: 6,
          spanGaps: false,
        };
      }) },
      options: {
        animation: false,
        responsive: true,
        maintainAspectRatio: false,
        parsing: false,
        color: colors.color,
        font,
        interaction: { mode: "nearest", axis: "x", intersect: false },
        scales: {
          x: {
            type: "linear",
            min, max,
            title: { display: config.x.type === "number", text: config.x.label || config.x.field, color: colors.color, font },
            // Reserve both endpoints even if crowding will omit one, so
            // the fitted selection cannot introduce an unpadded end label.
            afterBuildTicks: scale => setTicks(scale, endpoints ?? observationEndpoints(xValues, config.x.type)),
            afterFit: selectTicks,
            ticks: {
              color: colors.color, font,
              autoSkip: false, minRotation: 0, maxRotation: 0,
              callback: value => xLabels.get(Number(value)),
            },
            grid: { display: false },
            border: { display: false },
          },
          y: {
            type: "linear",
            beginAtZero: layout === "panels" ? (ranges[indices[0] ?? 0]?.min ?? 0) >= 0 : beginAtZero("y"),
            ...(layout === "panels" ? {
              suggestedMin: ranges[indices[0] ?? 0]?.min,
              suggestedMax: ranges[indices[0] ?? 0]?.max,
              afterFit: (scale: Scale) => { scale.width = Math.min(panelAxisWidth, scale.maxWidth); },
            } : {}),
            ticks: { color: colors.color, font, maxTicksLimit: layout === "panels" ? 3 : 6,
              callback: (value, _index, ticks) => formatChartTick(Number(value), layout === "panels" ? panelUnit(indices[0] ?? 0) : axes.leftUnit, ticks) },
            grid: { color: colors.borderTopColor },
            border: { display: false },
          },
          ...(layout === "overlay" && axes.rightUnit !== undefined ? { yRight: {
            type: "linear" as const, position: "right" as const,
            beginAtZero: beginAtZero("yRight"),
            ticks: { color: colors.color, font, maxTicksLimit: 6, callback: (value: string | number, _index: number, ticks: { value: number }[]) => formatChartTick(Number(value), axes.rightUnit ?? "", ticks) },
            grid: { drawOnChartArea: false },
            border: { display: false },
          } } : {}),
        },
        plugins: {
          legend: { display: layout === "overlay", position: "bottom", align: "start", labels: {
            color: colors.color, font, usePointStyle: true, pointStyle: "line", boxWidth: 20, boxHeight: 8,
          } },
          tooltip: { callbacks: {
            title: items => items[0]?.parsed.x == null ? "" : formatChartX(items[0].parsed.x, config.x.type),
            label: item => {
              const index = indices[item.datasetIndex] ?? 0;
              const series = config.y[index];
              return item.parsed.y === null ? "" : `${series?.label ?? series?.field ?? ""}: ${formatValue(index, item.parsed.y)}`;
            },
          } },
        },
      },
    };
    return configuration;
  };
  return { configurationFor, formatValue };
}

// biome-ignore lint/complexity/noExcessiveLinesPerFunction: This function predates the length limit.
export function chartBlockView(ydoc: Y.Doc | null): NodeViewRenderer {
  // biome-ignore lint/complexity/noExcessiveLinesPerFunction: This function predates the length limit.
  return ({ node, editor, getPos }: NodeViewRendererProps): NodeView => {
    let current: PMNode = node;
    let instances: Chart<"line", Point[]>[] = [];
    let drawnLayout: "overlay" | "panels" | null = null;
    let seriesPanels: { header: HTMLElement; canvas: HTMLCanvasElement }[] = [];
    let destroyed = false;
    let dirty = true;
    let snapshot: DocData | null = null;
    let tableSource = false;
    let prepared: ReturnType<typeof prepareChart> | ReturnType<typeof prepareTable> | null = null;
    const dom = chartChrome.root();
    const contentDOM = chartChrome.content();
    const panel = document.createElement("div");
    panel.className = "ub-chart-panel";
    panel.contentEditable = "false";
    const title = document.createElement("p");
    title.className = "ub-chart-title";
    const openButton = document.createElement("button");
    openButton.className = "ub-chart-open";
    openButton.type = "button";
    openButton.textContent = "source";
    openButton.setAttribute("aria-label", "Open chart source");
    const screen = document.createElement("div");
    screen.className = "ub-chart-screen";
    const canvas = document.createElement("canvas");
    canvas.setAttribute("role", "img");
    const description = document.createElement("p");
    description.className = "ub-chart-description ub-sr-only";
    description.id = `chart-description-${crypto.randomUUID()}`;
    canvas.setAttribute("aria-describedby", description.id);
    screen.append(canvas);
    const table = dataTableView();
    table.element.hidden = true;
    const message = document.createElement("p");
    message.className = "ub-chart-message";
    const diagnostics = document.createElement("p");
    diagnostics.className = "ub-chart-diagnostics";
    const notice = document.createElement("p");
    notice.className = "ub-chart-notice";
    const footer = document.createElement("div");
    footer.className = "ub-chart-footer";
    footer.contentEditable = "false";
    footer.hidden = true;
    // Resolve CSS light-dark tokens as actual canvas colors, not raw variables.
    const probe = document.createElement("span");
    probe.className = "ub-chart-probe";
    probe.setAttribute("aria-hidden", "true");
    panel.append(title, openButton, screen, table.element, description, message, diagnostics, notice, probe);
    const copy = copyButton(() => current.textContent);
    dom.append(panel, footer, copy.element, contentDOM);

    const releaseChart = (): void => {
      for (const instance of instances) instance.destroy();
      instances = [];
      drawnLayout = null;
      seriesPanels = [];
      screen.replaceChildren(canvas);
      screen.classList.remove("ub-chart-panels");
      screen.removeAttribute("role");
      screen.removeAttribute("aria-label");
      screen.removeAttribute("aria-describedby");
    };
    const text = (element: HTMLElement, value: string): void => {
      element.textContent = value;
      element.hidden = value === "";
    };

    // biome-ignore lint/complexity/noExcessiveCognitiveComplexity: This function predates the complexity limit.
    const draw = (data: DocData | null, readError?: unknown): void => {
      if (destroyed) return;
      try {
        if (readError !== undefined) throw readError;
        if (dirty || prepared === null || snapshot !== data) {
          try { tableSource = JSON.parse(current.textContent)?.type === "table"; }
          catch { tableSource = false; }
          prepared = tableSource ? prepareTable(current.textContent, data) : prepareChart(current.textContent, data);
          snapshot = data;
          dirty = false;
        }
        const result = prepared;
        notice.classList.toggle("ub-chart-limit-notice", result.status === "ready" &&
          result.config.limit !== undefined && result.config.limit <= CHART_RECORD_LIMIT);
        const view = tableSource ? "table" : "line";
        if (dom.dataset.view !== view) dom.dataset.view = view;
        // Reserve the actions beside the footnote, outside the table and its
        // scrolling area. Source mode keeps copy available in this chrome.
        if (tableSource && notice.parentNode !== footer) {
          footer.append(notice, openButton, copy.element, diagnostics);
        } else if (!tableSource && notice.parentNode !== panel) {
          screen.before(openButton);
          panel.append(diagnostics, notice, probe);
          contentDOM.before(copy.element);
        }
        footer.hidden = !tableSource;
        openButton.setAttribute("aria-label", tableSource ? "Open table source" : "Open chart source");
        panel.dataset.state = result.status;
        if (result.status !== "ready") {
          table.render(result);
          text(diagnostics, tableSource ? tableDiagnosticsText(result) : chartDiagnosticsText(result));
          releaseChart();
          screen.hidden = true;
          description.textContent = "";
          text(title, "");
          text(message, result.message);
          text(notice, "");
          return;
        }
        if ("rows" in result) {
          releaseChart();
          screen.hidden = true;
          description.textContent = "";
          text(title, "");
          text(message, "");
          text(notice, `Generated from document data · read-only${result.notice ? ` · ${result.notice}` : ""}`);
          text(diagnostics, tableDiagnosticsText(result));
          table.render(result);
          return;
        }
        table.clear();
        text(diagnostics, chartDiagnosticsText(result));
        const { config } = result;
        text(title, config.title ?? "");
        text(message, "");
        text(notice, result.notice ?? "");
        screen.hidden = false;
        const layout = config.layout === "panels" ? "panels" : "overlay";
        if (drawnLayout !== layout || (layout === "panels" && seriesPanels.length !== result.series.length)) {
          releaseChart();
          drawnLayout = layout;
          if (layout === "panels") {
            screen.replaceChildren();
            screen.classList.add("ub-chart-panels");
            screen.setAttribute("role", "img");
            screen.setAttribute("aria-describedby", description.id);
            seriesPanels = result.series.map(() => {
              const element = document.createElement("div");
              element.className = "ub-chart-series-panel";
              const header = document.createElement("p");
              header.className = "ub-chart-series-header";
              const plot = document.createElement("div");
              plot.className = "ub-chart-series-plot";
              const seriesCanvas = document.createElement("canvas");
              seriesCanvas.setAttribute("aria-hidden", "true");
              plot.append(seriesCanvas);
              element.append(header, plot);
              screen.append(element);
              return { header, canvas: seriesCanvas };
            });
          }
        }
        (layout === "panels" ? screen : canvas).setAttribute("aria-label", chartAccessibleName(config));
        const colors = getComputedStyle(probe);
        const dark = document.documentElement.dataset.theme === "dark" ||
          (document.documentElement.dataset.theme !== "light" && appearance?.matches === true);
        const palette = dark ? DARK : LIGHT;
        const { configurationFor, formatValue } = lineConfigurations(result, colors, palette, canvas);
        seriesPanels.forEach((target, index) => {
          const series = result.series[index];
          const latest = series?.points.findLast(point => point.y !== null)?.y;
          const label = document.createElement("span");
          label.textContent = series?.label ?? "";
          const value = document.createElement("strong");
          value.textContent = latest === undefined || latest === null ? "no plotted value" : formatValue(index, latest);
          target.header.replaceChildren(label, value);
          target.header.style.color = palette[index] ?? "";
        });
        const groups = layout === "panels" ? result.series.map((_, index) => [index]) : [result.series.map((_, index) => index)];
        groups.forEach((indices, index) => {
          const target = seriesPanels[index];
          const configuration = configurationFor(indices);
          const instance = instances[index];
          if (instance === undefined) instances[index] = new Chart(target?.canvas ?? canvas, configuration);
          else {
            instance.data = configuration.data;
            instance.options = configuration.options ?? {};
            instance.update("none");
          }
        });
        // Updated after the synchronous canvas draw, without a live region.
        description.textContent = chartAccessibleDescription(result);
      } catch (error) {
        releaseChart();
        screen.hidden = true;
        table.clear();
        description.textContent = "";
        if (tableSource) text(notice, "");
        panel.dataset.state = "collection-unusable";
        text(message, `Chart unavailable: ${error instanceof Error ? error.message : "Rendering failed"}`);
      }
    };
    const binding = bindDocView(ydoc, draw);
    const schedule = (): void => { if (!destroyed) binding.schedule(); };
    const appearance = typeof matchMedia === "function" ? matchMedia("(prefers-color-scheme: dark)") : null;
    appearance?.addEventListener("change", schedule);
    const theme = new MutationObserver(schedule);
    theme.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
    // Canvas does not repaint when the editor's self-hosted font finishes.
    // Reuse the shared frame and snapshot; a removed view schedules nothing.
    void document.fonts?.ready.then(schedule);

    const open = (event: Event): void => {
      event.preventDefault();
      const pos = typeof getPos === "function" ? getPos() : undefined;
      if (pos === undefined) return;
      editor.view.dispatch(editor.state.tr.setSelection(TextSelection.near(editor.state.doc.resolve(pos + 1))));
      editor.view.focus();
    };
    openButton.addEventListener("mousedown", event => event.preventDefault());
    openButton.addEventListener("click", open);
    screen.addEventListener("mousedown", open);
    const syncChrome = (): void => {
      chartChrome.sync(current, dom);
      let annotated = false;
      current.forEach(child => { if (child.marks.some(mark => mark.type.name === COMMENT_MARK)) annotated = true; });
      dom.setAttribute("data-annotated", String(annotated));
    };
    syncChrome();
    schedule();
    return {
      dom, contentDOM,
      update(updated: PMNode): boolean {
        if (updated.type !== current.type || contentDOM.parentNode !== dom) return false;
        if (updated.textContent !== current.textContent) {
          dirty = true;
          table.resetSort();
        }
        current = updated;
        syncChrome();
        // Source visibility follows ProseMirror decorations. Caret moves and
        // annotation changes do not alter the chart's data or appearance.
        if (dirty) schedule();
        return true;
      },
      stopEvent: event => event.target instanceof Node &&
        (panel.contains(event.target) || footer.contains(event.target) || copy.element.contains(event.target)),
      // The derived root presentation is chrome too, never content to reparse.
      ignoreMutation: mutation =>
        (mutation.type === "attributes" && mutation.target === dom && mutation.attributeName === "data-view") ||
        (mutation.type === "childList" && mutation.target === dom &&
          [...mutation.addedNodes, ...mutation.removedNodes].every(child => child === copy.element)) ||
        panel.contains(mutation.target) || footer.contains(mutation.target) || copy.element.contains(mutation.target),
      destroy: () => {
        destroyed = true;
        binding.destroy();
        releaseChart();
        theme.disconnect();
        appearance?.removeEventListener("change", schedule);
        openButton.removeEventListener("click", open);
        screen.removeEventListener("mousedown", open);
      },
    };
  };
}

export const ChartBlocks = Extension.create({
  name: "uberblickChartBlocks",
  addProseMirrorPlugins() { return [sourceEditingPlugin("chart", "ub-chart-editing")]; },
});

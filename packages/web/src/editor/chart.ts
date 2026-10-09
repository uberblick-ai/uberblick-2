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
import type { ChartConfiguration } from "chart.js";
import { COMMENT_MARK } from "@uberblick/schema";
import type { DocData } from "@uberblick/schema";
import type * as Y from "yjs";
import {
  prepareChart, formatChartX, formatChartNumber, chartAccessibleName,
  chartAccessibleDescription, chartDiagnosticsText,
} from "./chart-data.js";
import { chartChrome, copyButton, sourceEditingPlugin } from "./source-chrome.js";
import { prepareTable, tableDiagnosticsText } from "./table-data.js";
import { dataTableView } from "./table-view.js";
import { bindDocView } from "./view-bindings.js";
import { calendarTicks } from "./chart-ticks.js";
import { chartAxes, chartPointRadius, formatChartTick } from "./chart-presentation.js";

// Both axes are linear. Epoch milliseconds plus Intl date labels require no
// date adapter. No auto registry, decimator, transform or chart plugin package.
Chart.register(LineController, LineElement, PointElement, LinearScale, Legend, Tooltip);
type Point = { x: number; y: number | null };

const LIGHT = ["#1d4ed8", "#b91c1c", "#047857", "#7e22ce", "#a16207", "#0e7490", "#be185d", "#334155"];
const DARK = ["#93c5fd", "#fca5a5", "#6ee7b7", "#d8b4fe", "#fde047", "#67e8f9", "#f9a8d4", "#cbd5e1"];

export function chartBlockView(ydoc: Y.Doc | null): NodeViewRenderer {
  return ({ node, editor, getPos }: NodeViewRendererProps): NodeView => {
    let current: PMNode = node;
    let instance: Chart<"line", Point[]> | null = null;
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
    // Resolve CSS light-dark tokens as actual canvas colors, not raw variables.
    const probe = document.createElement("span");
    probe.className = "ub-chart-probe";
    probe.setAttribute("aria-hidden", "true");
    panel.append(title, openButton, screen, table.element, description, message, diagnostics, notice, probe);
    const copy = copyButton(() => current.textContent);
    dom.append(panel, copy.element, contentDOM);

    const releaseChart = (): void => {
      instance?.destroy();
      instance = null;
    };
    const text = (element: HTMLElement, value: string): void => {
      element.textContent = value;
      element.hidden = value === "";
    };

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
        const view = tableSource ? "table" : "line";
        if (dom.dataset.view !== view) dom.dataset.view = view;
        const noticePredecessor = tableSource ? table.element : diagnostics;
        if (noticePredecessor.nextElementSibling !== notice) noticePredecessor.after(notice);
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
          text(notice, "Generated from document data · read-only");
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
        canvas.setAttribute("aria-label", chartAccessibleName(config));
        const colors = getComputedStyle(probe);
        const dark = document.documentElement.dataset.theme === "dark" ||
          (document.documentElement.dataset.theme !== "light" && appearance?.matches === true);
        const palette = dark ? DARK : LIGHT;
        const axes = chartAxes(config.y);
        const font = { family: colors.fontFamily, size: 11 };
        const dateLabels = new Map<number, string[]>();
        // Equal explicit limits leave a zero range in Chart.js. Only this
        // degenerate case gets a small range, placing its point in the middle.
        const padding = config.x.type === "date" ? 30_000 : Math.max(1, Math.abs(result.firstX) * Number.EPSILON * 4);
        const min = result.firstX === result.lastX ? Math.max(-Number.MAX_VALUE, result.firstX - padding) : result.firstX;
        const max = result.firstX === result.lastX ? Math.min(Number.MAX_VALUE, result.lastX + padding) : result.lastX;
        const configuration: ChartConfiguration<"line", Point[]> = {
          type: "line",
          data: { datasets: result.series.map((series, index) => {
            const plottedValues = series.points.filter(point => point.y !== null).length;
            return {
              label: axes.legendLabels[index] ?? series.label,
              yAxisID: axes.seriesAxes[index],
              data: series.points.map(({ x, y }) => ({ x, y })),
              borderColor: palette[index],
              backgroundColor: palette[index],
              borderWidth: 2,
              pointRadius: context => chartPointRadius(series.points, context.dataIndex, plottedValues),
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
                ...(config.x.type === "date" ? { afterBuildTicks: (scale) => {
                  const ctx = scale.chart.ctx;
                  ctx.save();
                  ctx.font = `${font.size}px ${font.family}`;
                  const ticks = calendarTicks(scale.min, scale.max, scale.width, label => ctx.measureText(label).width);
                  ctx.restore();
                  dateLabels.clear();
                  for (const tick of ticks) dateLabels.set(tick.value, tick.label);
                  scale.ticks = ticks.map(({ value }) => ({ value }));
                } } : {}),
                ticks: {
                  color: colors.color, font, maxTicksLimit: 8,
                  autoSkip: config.x.type !== "date", minRotation: 0, maxRotation: 0,
                  callback: value => dateLabels.get(Number(value)) ?? formatChartX(Number(value), config.x.type),
                },
                grid: { display: false },
                border: { display: false },
              },
              y: {
                type: "linear",
                ticks: { color: colors.color, font, maxTicksLimit: 6, callback: (value, _index, ticks) => formatChartTick(Number(value), axes.leftUnit, ticks) },
                grid: { color: colors.borderTopColor },
                border: { display: false },
              },
              ...(axes.rightUnit !== undefined ? { yRight: {
                type: "linear" as const, position: "right" as const,
                ticks: { color: colors.color, font, maxTicksLimit: 6, callback: (value: string | number, _index: number, ticks: { value: number }[]) => formatChartTick(Number(value), axes.rightUnit ?? "", ticks) },
                grid: { drawOnChartArea: false },
                border: { display: false },
              } } : {}),
            },
            plugins: {
              legend: { display: true, position: "bottom", align: "start", labels: {
                color: colors.color, font, usePointStyle: true, pointStyle: "line", boxWidth: 20, boxHeight: 8,
              } },
              tooltip: { callbacks: {
                title: items => items[0]?.parsed.x == null ? "" : formatChartX(items[0].parsed.x, config.x.type),
                label: item => {
                  const series = config.y[item.datasetIndex];
                  return item.parsed.y === null ? "" : `${series?.label ?? series?.field ?? ""}: ${formatChartNumber(item.parsed.y)}${series?.unit ? ` ${series.unit}` : ""}`;
                },
              } },
            },
          },
        };
        if (instance === null) instance = new Chart(canvas, configuration);
        else {
          instance.data = configuration.data;
          instance.options = configuration.options ?? {};
          instance.update("none");
        }
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
        if (updated.textContent !== current.textContent) dirty = true;
        current = updated;
        syncChrome();
        // Source visibility follows ProseMirror decorations. Caret moves and
        // annotation changes do not alter the chart's data or appearance.
        if (dirty) schedule();
        return true;
      },
      stopEvent: event => event.target instanceof Node &&
        (panel.contains(event.target) || copy.element.contains(event.target)),
      // The derived root presentation is chrome too, never content to reparse.
      ignoreMutation: mutation =>
        (mutation.type === "attributes" && mutation.target === dom && mutation.attributeName === "data-view") ||
        panel.contains(mutation.target) || copy.element.contains(mutation.target),
      destroy: () => {
        destroyed = true;
        binding.destroy();
        releaseChart();
        theme.disconnect();
        appearance?.removeEventListener("change", schedule);
        openButton.removeEventListener("click", open);
        screen.removeEventListener("mousedown", open);
        copy.destroy();
      },
    };
  };
}

export const ChartBlocks = Extension.create({
  name: "uberblickChartBlocks",
  addProseMirrorPlugins() { return [sourceEditingPlugin("chart", "ub-chart-editing")]; },
});

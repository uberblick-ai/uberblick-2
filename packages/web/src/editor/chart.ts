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
    openButton.textContent = "Open chart source";
    const screen = document.createElement("div");
    screen.className = "ub-chart-screen";
    const canvas = document.createElement("canvas");
    canvas.setAttribute("role", "img");
    const description = document.createElement("p");
    description.className = "ub-chart-description ub-sr-only";
    description.id = `chart-description-${crypto.randomUUID()}`;
    canvas.setAttribute("aria-describedby", description.id);
    screen.append(canvas);
    const table = dataTableView(() => schedule());
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
        openButton.textContent = tableSource ? "Open table source" : "Open chart source";
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
          text(title, result.config.title ?? "");
          text(message, "");
          text(notice, "");
          text(diagnostics, tableDiagnosticsText(result));
          table.render(result);
          return;
        }
        table.element.hidden = true;
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
        const labels = config.y.map(series => `${series.label || series.field}${series.unit ? ` (${series.unit})` : ""}`);
        const commonUnit = config.y.every(series => series.unit === config.y[0]?.unit) ? config.y[0]?.unit : undefined;
        const numeric = (value: number): string => `${formatChartNumber(value)}${commonUnit ? ` ${commonUnit}` : ""}`;
        const day = 86_400_000;
        // Use the library's tick-step option to keep longer date ranges on UTC
        // days. Intraday plots retain time labels; record x values stay exact.
        const dailyTicks = config.x.type === "date" && result.lastX - result.firstX >= day;
        const configuration: ChartConfiguration<"line", Point[]> = {
          type: "line",
          data: { datasets: result.series.map((series, index) => ({
            label: labels[index] ?? series.label,
            data: series.points.map(({ x, y }) => ({ x, y })),
            borderColor: palette[index],
            backgroundColor: palette[index],
            borderWidth: 2,
            pointRadius: result.plottedCount > 500 ? 0 : 2,
            pointHitRadius: 6,
            spanGaps: false,
          })) },
          options: {
            animation: false,
            responsive: true,
            maintainAspectRatio: false,
            parsing: false,
            color: colors.color,
            interaction: { mode: "nearest", intersect: false },
            scales: {
              x: {
                type: "linear",
                title: { display: true, text: config.x.label || config.x.field, color: colors.color },
                ticks: {
                  color: colors.color, maxTicksLimit: 8,
                  ...(dailyTicks ? { stepSize: Math.max(1, Math.ceil((result.lastX - result.firstX) / day / 7)) * day } : {}),
                  callback: value => formatChartX(Number(value), config.x.type),
                },
                grid: { color: colors.borderTopColor },
              },
              y: {
                type: "linear",
                title: { display: true, text: labels.join(", "), color: colors.color },
                ticks: { color: colors.color, callback: value => numeric(Number(value)) },
                grid: { color: colors.borderTopColor },
              },
            },
            plugins: {
              legend: { display: result.series.length > 1, labels: { color: colors.color } },
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
        table.element.hidden = true;
        description.textContent = "";
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
      ignoreMutation: mutation => panel.contains(mutation.target) || copy.element.contains(mutation.target),
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

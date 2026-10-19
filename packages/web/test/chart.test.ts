import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as Y from "yjs";
import {
  appendBlock, applyDocData, createAnnotation, editBlock, getBlocks, getBlocksFragment,
  initDoc, readDocData,
  blockRev,
} from "@uberblick/schema";
import { mountEditor, typeText } from "./helpers.js";
import { createUberblickEditor } from "../src/editor/create-editor.js";
import { prepareTable } from "../src/editor/table-data.js";
import { dataRevision } from "../src/editor/render-state.js";
import type { ChartConfiguration } from "chart.js";

type RecordedChart = typeof charts.instances[number];
type PanelData = { datasets: { label: string; yAxisID: string; data: { x: number; y: number | null }[]; borderColor: string;
  pointRadius: number | ((context: { dataIndex: number }) => number) }[] };
type PanelOptions = { interaction: unknown; scales: {
  x: { min: number; max: number; title: { display: boolean; text: string };
    afterBuildTicks: (scale: unknown) => void; afterFit: (scale: unknown) => void;
    ticks: { callback: (value: number) => unknown } };
  y: { suggestedMin: number; suggestedMax: number; beginAtZero: boolean; ticks: {
    callback: (value: number, index: number, ticks: { value: number }[]) => string } };
}; plugins: { tooltip: { callbacks: { label: (item: { datasetIndex: number; parsed: { y: number | null } }) => string } } } };

const charts = vi.hoisted(() => ({ instances: [] as Array<{ canvas: unknown; data: unknown; options: unknown; updates: number; destroyed: boolean }> }));
vi.mock("@uberblick/schema", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@uberblick/schema")>();
  return { ...actual, readDocData: vi.fn(actual.readDocData) };
});
vi.mock("../src/editor/table-data.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/editor/table-data.js")>();
  return { ...actual, prepareTable: vi.fn(actual.prepareTable) };
});
vi.mock("chart.js", () => {
  class Chart {
    static register() {}
    static defaults = { plugins: { legend: { labels: {
      generateLabels: (chart: { data: { datasets: { label: string }[] } }) =>
        chart.data.datasets.map((dataset, datasetIndex) => ({ text: dataset.label, datasetIndex })),
    } } } };
    canvas: unknown;
    data: unknown;
    options: unknown;
    updates = 0;
    destroyed = false;
    constructor(canvas: unknown, config: { data: unknown; options: unknown }) {
      this.canvas = canvas;
      this.data = config.data;
      this.options = config.options;
      charts.instances.push(this);
    }
    update() { this.updates += 1; }
    destroy() { this.destroyed = true; }
  }
  return { Chart, LineController: {}, LineElement: {}, PointElement: {}, BarController: {}, BarElement: {}, LinearScale: {}, Legend: {}, Tooltip: {} };
});

const mapping = JSON.stringify({ version: 1, type: "line", collection: "trend", x: { field: "day", type: "number" }, y: [{ field: "value", label: "Delivery", unit: "issues" }] });
const schema = { version: 1 as const, schema: { type: "object" as const, properties: { day: { type: "number" as const }, value: { type: "number" as const } } } };
const tableMapping = JSON.stringify({ version: 1, type: "table", collection: "trend", pageSize: 1,
  columns: [{ field: "day", format: "number" }, { field: "value", label: "Delivery", format: "number" }],
  sort: { field: "day", direction: "asc" } });
function fixture() {
  const doc = new Y.Doc();
  const directory = new Y.Doc();
  initDoc(doc, { uuid: "chart-document", title: "Trend" });
  appendBlock(doc, { type: "paragraph", text: "before" });
  const id = appendBlock(doc, { type: "chart", text: mapping });
  applyDocData(doc, directory, [{ collection: "trend", schema, upsert: [{ id: "a", value: { day: 1, value: 3 } }] }]);
  return { doc, directory, id };
}
function panelFixture() {
  const result = fixture();
  const source = JSON.stringify({ version: 1, type: "line", collection: "trend", layout: "panels",
    x: { field: "day", type: "number", label: "Observation" }, y: [
      { field: "value", label: "Autonomous", unit: "%" },
      { field: "secondary", label: "Wasted", unit: "%" },
      { field: "third", label: "Denials", unit: "requests" },
      { field: "empty", label: "No observations" },
    ] });
  editBlock(result.doc, result.id, mapping, source);
  applyDocData(result.doc, result.directory, [{ collection: "trend", schema: { version: 1, schema: { type: "object" } }, replaceRecords: [
    { id: "first", value: { day: 1, value: 10, secondary: 30, third: 5_000 } },
    { id: "gap", value: { day: 3, value: null, secondary: null, third: null } },
    { id: "last", value: { day: 6, value: null, secondary: -20, third: 9_000 } },
  ] }]);
  return { ...result, source };
}
function panelOptions(chart: RecordedChart): PanelOptions { return chart.options as PanelOptions; }
function panelData(chart: RecordedChart): PanelData { return chart.data as PanelData; }
function panelPointRadius(chart: RecordedChart, dataIndex: number): number {
  const radius = panelData(chart).datasets[0]?.pointRadius;
  if (radius === undefined) throw new Error("Panel dataset is absent");
  return typeof radius === "number" ? radius : radius({ dataIndex });
}
let frames: Map<number, FrameRequestCallback>;
function flush() {
  const pending = [...frames.values()];
  frames.clear();
  pending.forEach(callback => { callback(0); });
}
beforeEach(() => {
  frames = new Map();
  let next = 0;
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => { frames.set(++next, callback); return next; });
  vi.stubGlobal("cancelAnimationFrame", (id: number) => frames.delete(id));
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue({
    save() {}, restore() {}, font: "", measureText: (text: string) => ({ width: text.length * 6 }),
  } as CanvasRenderingContext2D);
    charts.instances = [];
    vi.mocked(readDocData).mockClear();
    vi.mocked(prepareTable).mockClear();
});
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe("the chart's derived lifecycle", () => {
  it("draws native bars behind lines without changing mapping order in the legend or shared tooltip", () => {
    const { doc, directory, id } = fixture();
    const source = JSON.stringify({ ...JSON.parse(mapping), missing: "connect", y: [
      { field: "secondary", label: "Responses", unit: "responses", type: "bar" },
      { field: "value", label: "Score", unit: "%" },
      { field: "third", label: "Other responses", unit: "responses", type: "bar" },
    ] });
    editBlock(doc, id, mapping, source);
    applyDocData(doc, directory, [{ collection: "trend", schema: { version: 1, schema: { type: "object" } }, replaceRecords: [
      { id: "a", value: { day: 1, value: -30, secondary: -10, third: -20 } },
      { id: "b", value: { day: 2, secondary: null, third: -30 } },
      { id: "c", value: { day: 3, value: -50, secondary: -40, third: -60 } },
    ] }]);
    const before = Y.encodeStateAsUpdate(doc);
    const { editor } = mountEditor(doc);
    flush();
    const instance = charts.instances[0]!;
    const datasets = (instance.data as ChartConfiguration<"line" | "bar">["data"]).datasets;
    expect(datasets.map(series => [series.type, series.yAxisID, series.order])).toEqual([
      ["bar", "yRight", 1], ["line", "y", 0], ["bar", "yRight", 1],
    ]);
    expect(datasets[0]).not.toHaveProperty("pointRadius");
    expect(datasets[1]).toHaveProperty("pointRadius");
    expect(instance.options).toMatchObject({
      scales: { x: { min: 1, max: 3, offset: true }, y: { beginAtZero: false }, yRight: { beginAtZero: true, grid: { drawOnChartArea: false } } },
    });
    const plugins = (instance.options as { plugins: {
      legend: { labels: { generateLabels: (chart: unknown) => { datasetIndex: number; pointStyle: string }[];
        sort: (a: { datasetIndex: number }, b: { datasetIndex: number }) => number } };
      tooltip: { displayColors: boolean; filter: (item: unknown, index: number) => boolean;
        callbacks: { label: (item: { parsed: { x: number; y: number } }) => string[] } };
    } }).plugins;
    const labels = plugins.legend.labels.generateLabels(instance);
    expect(labels.map(item => item.pointStyle)).toEqual(["rect", "line", "rect"]);
    expect([labels[2]!, labels[0]!, labels[1]!].sort(plugins.legend.labels.sort).map(item => item.datasetIndex)).toEqual([0, 1, 2]);
    expect(plugins.tooltip.filter({ datasetIndex: 0 }, 0)).toBe(true);
    expect(plugins.tooltip.filter({ datasetIndex: 1 }, 1)).toBe(false);
    expect(plugins.tooltip.filter({ datasetIndex: 3 }, 0)).toBe(false);
    expect(plugins.tooltip.displayColors).toBe(false);
    expect(plugins.tooltip.callbacks.label({ parsed: { x: 3, y: -40 } })).toEqual([
      "Responses: -40 responses", "Score: -50 %", "Other responses: -60 responses",
    ]);
    expect(plugins.tooltip.callbacks.label({ parsed: { x: 2, y: -30 } })).toEqual(["Other responses: -30 responses"]);
    expect(Y.encodeStateAsUpdate(doc)).toEqual(before);
    editor.destroy(); doc.destroy(); directory.destroy();
  });

  it("groups all-bar series on native axes and includes zero in bar panels with negative values", () => {
    const { doc, directory, id } = fixture();
    const source = JSON.stringify({ ...JSON.parse(mapping), y: [
      { field: "value", unit: "%", type: "bar" }, { field: "secondary", unit: "requests", type: "bar" },
    ] });
    editBlock(doc, id, mapping, source);
    applyDocData(doc, directory, [{ collection: "trend", schema: { version: 1, schema: { type: "object" } }, replaceRecords: [
      { id: "a", value: { day: 1, value: -5, secondary: -100 } },
    ] }]);
    const { editor } = mountEditor(doc);
    flush();
    expect(charts.instances[0]?.options).toMatchObject({ scales: {
      x: { min: 0, max: 2, offset: true }, y: { beginAtZero: true }, yRight: { beginAtZero: true },
    } });
    expect((charts.instances[0]!.data as ChartConfiguration<"bar">["data"]).datasets.map(series => series.yAxisID)).toEqual(["y", "yRight"]);
    editBlock(doc, id, source, JSON.stringify({ ...JSON.parse(source), layout: "panels" }));
    flush();
    const panels = charts.instances.slice(1);
    expect(panels).toHaveLength(2);
    expect(panels.map(panel => panelData(panel).datasets[0])).toEqual([
      expect.objectContaining({ type: "bar", yAxisID: "y" }), expect.objectContaining({ type: "bar", yAxisID: "y" }),
    ]);
    expect(panels.map(panel => panelOptions(panel).scales.y.suggestedMax)).toEqual([0, 0]);
    editor.destroy(); doc.destroy(); directory.destroy();
  });

  it.each(["overlay", "panels"])("keeps declared bar ranges at zero and references ahead of bars in %s", layout => {
    const { doc, directory, id } = fixture();
    const source = JSON.stringify({ ...JSON.parse(mapping), layout, y: [
      { field: "value", unit: "responses", type: "bar", range: [-10, -1], reference: -3 },
      { field: "secondary", unit: "score", range: [20, 30], reference: 25 },
    ] });
    editBlock(doc, id, mapping, source);
    applyDocData(doc, directory, [{ collection: "trend", schema: { version: 1, schema: { type: "object" } },
      replaceRecords: [{ id: "a", value: { day: 1, value: -5, secondary: 25 } }],
    }]);
    const { editor } = mountEditor(doc);
    flush();
    const bars = charts.instances[0]!;
    const lines = charts.instances[layout === "panels" ? 1 : 0]!;
    expect(bars.options).toMatchObject({ scales: { [layout === "panels" ? "y" : "yRight"]: {
      min: -10, suggestedMax: 0, beginAtZero: true,
    } } });
    expect(lines.options).toMatchObject({ scales: { y: { min: 20, max: 30, beginAtZero: false } } });
    const datasets = (bars.data as ChartConfiguration<"line" | "bar">["data"]).datasets;
    expect(datasets[0]).toMatchObject({ type: "bar", order: 1 });
    expect(datasets.at(-1)).toMatchObject({ type: "line", order: 0, xAxisID: "referenceX", pointRadius: 0 });
    expect(datasets[0]).not.toHaveProperty("clip");
    editor.destroy(); doc.destroy(); directory.destroy();
  });

  it("fits observation labels within the span left by native bar offsets", () => {
    const { doc, directory, id } = fixture();
    editBlock(doc, id, mapping, JSON.stringify({ ...JSON.parse(mapping), y: [{ field: "value", type: "bar" }] }));
    applyDocData(doc, directory, [{ collection: "trend", replaceRecords: [
      { id: "a", value: { day: 100, value: 1 } }, { id: "b", value: { day: 101, value: 2 } },
      { id: "c", value: { day: 102, value: 3 } },
    ] }]);
    const { editor } = mountEditor(doc);
    flush();
    const instance = charts.instances[0]!;
    const scale = { min: 100, max: 102, width: 45, ticks: [] as { value: number; label: string[] }[],
      chart: { ctx: { save() {}, restore() {}, font: "", measureText: (text: string) => ({ width: text.length * 6 }) } } };
    panelOptions(instance).scales.x.afterFit(scale);
    expect(scale.ticks.map(tick => tick.value)).toEqual([100, 102]);
    const span = scale.width * (scale.ticks.length - 1) / scale.ticks.length;
    expect(span).toBeGreaterThanOrEqual(18);
    editor.destroy(); doc.destroy(); directory.destroy();
  });

  it.each([mapping, tableMapping])("exposes only the source and data revision whose drawing completed: %s", (source) => {
    const { doc, directory, id } = fixture();
    if (source !== mapping) editBlock(doc, id, mapping, source);
    const { editor } = mountEditor(doc);
    const root = editor.view.dom.querySelector<HTMLElement>(".ub-chart")!;
    expect(root.dataset.sourceRev).toBeUndefined();
    flush();
    const firstDataRev = dataRevision(readDocData(doc));
    expect(root.dataset).toMatchObject({ sourceRev: blockRev({ type: "chart", text: source }), dataRev: firstDataRev, drawState: "success" });
    applyDocData(doc, directory, [{ collection: "trend", upsert: [{ id: "b", value: { day: 2, value: 7 } }] }]);
    expect(root.dataset.dataRev).toBe(firstDataRev);
    flush();
    expect(root.dataset.dataRev).toBe(dataRevision(readDocData(doc)));
    expect(root.dataset.dataRev).not.toBe(firstDataRev);
    const invalid = "invalid mapping";
    editBlock(doc, id, source, invalid);
    expect(root.dataset.sourceRev).toBe(blockRev({ type: "chart", text: source }));
    flush();
    expect(root.dataset).toMatchObject({ sourceRev: blockRev({ type: "chart", text: invalid }), drawState: "error" });
    expect(root.querySelector(".ub-chart-panel")?.getAttribute("data-state")).toBe("invalid-configuration");
    editBlock(doc, id, invalid, source);
    flush();
    expect(root.dataset.drawState).toBe("success");
    editor.destroy(); doc.destroy(); directory.destroy();
  });

  it("sorts only a mounted table's cached window without reads, projection, selection or writes", () => {
    const { doc, directory, id } = fixture();
    const source = JSON.stringify({ ...JSON.parse(tableMapping), limit: 2, sort: { field: "day", direction: "desc" } });
    editBlock(doc, id, mapping, source);
    appendBlock(doc, { type: "chart", text: source });
    applyDocData(doc, directory, [{ collection: "trend", upsert: [
      { id: "b", value: { day: 2, value: 4 } }, { id: "c", value: { day: 3, value: 5 } },
    ] }]);
    const { editor } = mountEditor(doc);
    flush();
    const tables = [...editor.view.dom.querySelectorAll<HTMLTableElement>(".ub-data-table")];
    const first = tables[0]!;
    const button = first.querySelectorAll<HTMLButtonElement>("th button")[1]!;
    const order = (table: HTMLTableElement) => [...table.querySelectorAll("tbody tr")].map(row => row.textContent);
    const selection = editor.state.selection;
    const before = Y.encodeStateAsUpdate(doc);
    let updates = 0;
    doc.on("update", () => { updates += 1; });
    button.click();
    flush();
    expect(order(first)).toEqual(["24", "35"]);
    expect(order(tables[1]!)).toEqual(["35", "24"]);
    expect(first.querySelector('th[aria-sort="ascending"]')?.textContent).toBe("Delivery↑");
    expect(document.activeElement).toBe(button);
    expect(editor.state.selection.eq(selection)).toBe(true);
    expect(first.closest(".ub-chart")?.classList.contains("ub-chart-editing")).toBe(false);
    expect(readDocData).toHaveBeenCalledTimes(1);
    expect(prepareTable).toHaveBeenCalledTimes(2);
    expect(Y.encodeStateAsUpdate(doc)).toEqual(before);
    expect(updates).toBe(0);

    applyDocData(doc, directory, [{ collection: "trend", upsert: [{ id: "d", value: { day: 4, value: 1 } }] }]);
    flush();
    expect(order(first)).toEqual(["41", "35"]);
    expect(order(tables[1]!)).toEqual(["41", "35"]);
    expect(first.querySelector('th[aria-sort="ascending"]')?.textContent).toBe("Delivery↑");
    expect(document.activeElement).toBe(button);
    expect(readDocData).toHaveBeenCalledTimes(2);
    expect(prepareTable).toHaveBeenCalledTimes(4);
    editBlock(doc, id, source, `${source} `);
    flush();
    expect(first.querySelector('th[aria-sort="descending"]')?.textContent).toBe("day↓");
    expect(readDocData).toHaveBeenCalledTimes(2);
    editor.destroy();
    const remounted = mountEditor(doc);
    flush();
    expect(remounted.editor.view.dom.querySelector('th[aria-sort="descending"]')?.textContent).toBe("day↓");
    remounted.editor.destroy(); doc.destroy(); directory.destroy();
  });

  it("switches table and line presentation with the source while preserving annotation and source access", async () => {
    const { doc, directory, id } = fixture();
    editBlock(doc, id, mapping, tableMapping);
    const { editor } = mountEditor(doc);
    flush();
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(getBlocks(doc).find(block => block.id === id)?.text).toBe(tableMapping);
    const root = editor.view.dom.querySelector(".ub-chart") as HTMLElement;
    const source = root.querySelector(".ub-chart-open") as HTMLButtonElement;
    expect(root.dataset.view).toBe("table");
    expect(root.querySelector<HTMLElement>(".ub-block-caption")?.hidden).toBe(true);
    expect(source.getAttribute("aria-label")).toBe("Open table source");
    expect(root.querySelector(".ub-chart-footer .ub-copy")).not.toBeNull();
    expect(root.querySelector("caption")?.textContent).toBe("Data table of trend");
    source.click();
    expect(root.classList.contains("ub-chart-editing")).toBe(true);
    editor.commands.setTextSelection(1);
    createAnnotation(doc, id, 0, 5, "reader", "Table mapping note");
    flush();
    expect(root.getAttribute("data-annotated")).toBe("true");
    expect(readDocData).toHaveBeenCalledTimes(1);
    editBlock(doc, id, tableMapping, mapping);
    flush();
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(getBlocks(doc).find(block => block.id === id)?.text).toBe(mapping);
    expect(root.dataset.view).toBe("line");
    expect(root.querySelectorAll(".ub-data-table tbody tr")).toHaveLength(0);
    expect(source.getAttribute("aria-label")).toBe("Open chart source");
    expect(root.querySelector(".ub-block-caption .ub-copy")).not.toBeNull();
    expect(root.querySelector<HTMLElement>(".ub-block-caption")?.hidden).toBe(false);
    expect(root.querySelector(".ub-chart-footer")?.hasAttribute("hidden")).toBe(true);
    expect(root.querySelector(".ub-chart-notice")?.hasAttribute("hidden")).toBe(true);
    expect(charts.instances).toHaveLength(1);
    expect(readDocData).toHaveBeenCalledTimes(1);
    editor.destroy(); doc.destroy(); directory.destroy();
  });

  it("wires compact axes, shared x hover and a bottom legend, including one series and a single x", () => {
    const { doc, directory, id } = fixture();
    const { editor } = mountEditor(doc);
    flush();
    const instance = charts.instances[0];
    if (instance === undefined) throw new Error("Chart did not draw");
    const options = instance.options as NonNullable<ChartConfiguration<"line">["options"]>;
    expect(options.interaction).toMatchObject({ mode: "nearest", axis: "x", intersect: false });
    expect(options.plugins?.legend).toMatchObject({ display: true, position: "bottom", align: "start", labels: { pointStyle: "line", usePointStyle: true } });
    expect(options.scales?.x).toMatchObject({ min: 0, max: 2, title: { display: true, text: "day" }, grid: { display: false }, border: { display: false } });
    expect(options.scales?.y).not.toHaveProperty("title");
    expect(options.scales?.y?.ticks).toMatchObject({ maxTicksLimit: 6 });
    expect(editor.view.dom.querySelector(".ub-chart-diagnostics")?.hasAttribute("hidden")).toBe(true);
    const source = editor.view.dom.querySelector(".ub-chart-open");
    const caption = editor.view.dom.querySelector(".ub-block-caption");
    expect(editor.view.dom.querySelectorAll(".ub-block-caption")).toHaveLength(1);
    expect(caption?.querySelector(".ub-block-label")?.firstChild?.textContent).toBe("Chart");
    expect(caption?.querySelector(".ub-chart-title")).not.toBeNull();
    expect([...caption!.querySelectorAll(".ub-block-actions > button")].map(button => button.textContent)).toEqual(["Copy", "Source"]);
    expect(source?.textContent).toBe("Source");
    expect(source?.getAttribute("aria-label")).toBe("Open chart source");
    const data = instance.data as ChartConfiguration<"line">["data"];
    expect(data.datasets[0]).toMatchObject({ label: "Delivery", yAxisID: "y", pointHoverRadius: 4 });
    editBlock(doc, id, mapping, JSON.stringify({ ...JSON.parse(mapping), y: [{ field: "value", unit: "%" }, { field: "value", unit: "ms" }] }));
    applyDocData(doc, directory, [{ collection: "trend", upsert: [{ id: "b", value: { day: 3, value: 7 } }] }]);
    flush();
    const next = instance.options as typeof options;
    expect(next.scales?.x).toMatchObject({ min: 1, max: 3 });
    expect(next.scales?.yRight).toMatchObject({ type: "linear", position: "right", grid: { drawOnChartArea: false }, border: { display: false } });
    expect((instance.data as typeof data).datasets.map(series => series.yAxisID)).toEqual(["y", "yRight"]);
    editor.destroy(); doc.destroy(); directory.destroy();
  });

  it("recomputes the zero baseline from every series assigned to each value axis", () => {
    const { doc, directory, id } = fixture();
    const sharedMapping = JSON.stringify({ ...JSON.parse(mapping), y: [
      { field: "value", unit: "requests" }, { field: "secondary", unit: "requests" }, { field: "right", unit: "%" },
    ] });
    editBlock(doc, id, mapping, sharedMapping);
    applyDocData(doc, directory, [{ collection: "trend", schema: { version: 1, schema: { type: "object" } },
      replaceRecords: [{ id: "a", value: { day: 1, value: 30, secondary: 36, right: -40 } }],
    }]);
    const { editor } = mountEditor(doc);
    flush();
    const instance = charts.instances[0];
    if (instance === undefined) throw new Error("Chart did not draw");
    expect(instance.options).toMatchObject({ scales: { y: { beginAtZero: true }, yRight: { beginAtZero: false } } });

    applyDocData(doc, directory, [{ collection: "trend", upsert: [{ id: "a", value: { day: 1, value: 30, secondary: -5, right: 36 } }] }]);
    flush();
    expect(instance.options).toMatchObject({ scales: { y: { beginAtZero: false }, yRight: { beginAtZero: true } } });

    const threeUnitMapping = JSON.stringify({ ...JSON.parse(mapping), y: [
      { field: "value", unit: "requests" }, { field: "secondary", unit: "ms" }, { field: "right", unit: "%" },
    ] });
    editBlock(doc, id, sharedMapping, threeUnitMapping);
    flush();
    expect(instance.options).toMatchObject({ scales: { y: { beginAtZero: false } } });
    expect((instance.options as NonNullable<ChartConfiguration<"line">["options"]>).scales).not.toHaveProperty("yRight");

    editBlock(doc, id, threeUnitMapping, JSON.stringify({ ...JSON.parse(mapping), y: [
      { field: "value", unit: "requests" }, { field: "right", unit: "%" },
    ] }));
    flush();
    expect(instance.options).toMatchObject({ scales: { y: { beginAtZero: true }, yRight: { beginAtZero: true } } });
    editor.destroy(); doc.destroy(); directory.destroy();
  });

  it.each(["overlay", "panels"])("uses exact combined spans and native noninteractive references in %s", layout => {
    const { doc, directory, id } = fixture();
    const source = JSON.stringify({ ...JSON.parse(mapping), layout, y: [
      { field: "value", label: "Delivery", unit: "ms", range: [50, 100], reference: 73 },
      { field: "secondary", label: "Second", unit: "ms", range: [40, 90], reference: 120 },
      { field: "right", label: "Rate", unit: "%", range: [1, 7], reference: 3 },
      { field: "value", label: "Again", unit: "ms", reference: 73 },
    ] });
    editBlock(doc, id, mapping, source);
    applyDocData(doc, directory, [{ collection: "trend", schema: { version: 1, schema: { type: "object" } },
      replaceRecords: [
        { id: "first", value: { day: 1, value: 60, secondary: 90, right: 4 } },
        { id: "last", value: { day: 3, value: 110, secondary: -5, right: 5 } },
      ],
    }]);
    const { editor } = mountEditor(doc);
    flush();
    expect(charts.instances).toHaveLength(layout === "panels" ? 4 : 1);
    const instance = charts.instances[0]!;
    expect(instance.options).toMatchObject({ scales: {
      y: { suggestedMin: -5, suggestedMax: 120, beginAtZero: false },
      referenceX: { type: "linear", axis: "x", display: false, min: 0, max: 1 },
    } });
    const sharedScale = (instance.options as { scales: { y: Record<string, unknown> } }).scales.y;
    expect(sharedScale).not.toHaveProperty("min");
    expect(sharedScale).not.toHaveProperty("max");
    if (layout === "panels") {
      for (const index of [1, 3]) expect(panelOptions(charts.instances[index]!).scales.y)
        .toMatchObject({ suggestedMin: -5, suggestedMax: 120, beginAtZero: false });
    }
    const percentChart = layout === "panels" ? charts.instances[2]! : instance;
    expect((percentChart.options as { scales: Record<string, unknown> }).scales[layout === "panels" ? "y" : "yRight"])
      .toMatchObject({ min: 1, max: 7, beginAtZero: false });
    const data = instance.data as ChartConfiguration<"line", { x: number; y: number | null }[]>["data"];
    const realCount = layout === "panels" ? 1 : 4;
    const references = data.datasets.slice(realCount);
    expect(references).toHaveLength(layout === "panels" ? 1 : 3);
    expect(references[0]).toMatchObject({
      yAxisID: "y", xAxisID: "referenceX", data: [{ x: -1, y: 73 }, { x: 2, y: 73 }],
      pointRadius: 0, pointHoverRadius: 0, pointHitRadius: 0, clip: { left: 0, right: 0, top: 1, bottom: 1 },
    });
    expect(data.datasets[0]?.clip).toEqual({ left: 0, right: 0, top: 5, bottom: 5 });
    const options = instance.options as { plugins: {
      legend: { labels: { filter: (item: { datasetIndex: number }) => boolean } };
      tooltip: { filter: (item: { datasetIndex: number }) => boolean;
        callbacks: { label: (item: { datasetIndex: number; parsed: { y: number } }) => string } };
    } };
    expect(options.plugins.legend.labels.filter({ datasetIndex: realCount - 1 })).toBe(true);
    expect(options.plugins.legend.labels.filter({ datasetIndex: realCount })).toBe(false);
    expect(options.plugins.tooltip.filter({ datasetIndex: realCount - 1 })).toBe(true);
    expect(options.plugins.tooltip.filter({ datasetIndex: realCount })).toBe(false);
    expect(options.plugins.tooltip.callbacks.label({ datasetIndex: 0, parsed: { y: 60 } })).toBe("Delivery: 60 ms");
    if (layout === "panels") {
      expect(panelOptions(percentChart).plugins.tooltip.callbacks.label({ datasetIndex: 0, parsed: { y: 4 } })).toBe("Rate: 4 %");
      expect(editor.view.dom.querySelectorAll(".ub-chart-series-header")).toHaveLength(4);
    } else expect(references[2]?.yAxisID).toBe("yRight");
    expect(editor.view.dom.querySelector(".ub-chart-description")?.textContent).not.toContain("73");
    expect(getBlocks(doc).find(block => block.id === id)?.text).toBe(source);

    applyDocData(doc, directory, [{ collection: "trend", upsert: [{ id: "outside", value: { day: 5, value: 200, secondary: 0, right: -2 } }] }]);
    flush();
    expect(instance.options).toMatchObject({ scales: { y: { suggestedMin: -5, suggestedMax: 200 } } });
    expect((percentChart.options as { scales: Record<string, unknown> }).scales[layout === "panels" ? "y" : "yRight"])
      .toMatchObject({ suggestedMin: -2, max: 7 });
    editor.destroy(); doc.destroy(); directory.destroy();
  });

  it.each(["overlay", "panels"])("rounds only widened sides of declared %s ranges on either value axis", layout => {
    const { doc, directory, id } = fixture();
    editBlock(doc, id, mapping, JSON.stringify({ ...JSON.parse(mapping), layout, y: [
      { field: "value", unit: "%", range: [0, 100], reference: 117.3 },
      { field: "secondary", unit: "ms", range: [-100, 100] },
    ] }));
    applyDocData(doc, directory, [{ collection: "trend", schema: { version: 1, schema: { type: "object" } },
      replaceRecords: [{ id: "first", value: { day: 1, value: 60, secondary: -139.7 } }],
    }]);
    const { editor } = mountEditor(doc);
    flush();
    const left = (charts.instances[0]!.options as { scales: Record<string, Record<string, unknown>> }).scales.y;
    const right = (charts.instances[layout === "panels" ? 1 : 0]!.options as {
      scales: Record<string, Record<string, unknown>>;
    }).scales[layout === "panels" ? "y" : "yRight"];
    expect(left).toMatchObject({ min: 0, suggestedMax: 117.3, beginAtZero: false });
    expect(left).not.toHaveProperty("max");
    expect(right).toMatchObject({ suggestedMin: -139.7, max: 100, beginAtZero: false });
    expect(right).not.toHaveProperty("min");
    editor.destroy(); doc.destroy(); directory.destroy();
  });

  it.each(["overlay", "panels"])("widens automatic %s scales for reference-only values", layout => {
    const { doc, directory, id } = fixture();
    const source = JSON.stringify({ ...JSON.parse(mapping), layout, y: [{ field: "value", reference: -100 }] });
    editBlock(doc, id, mapping, source);
    const { editor } = mountEditor(doc);
    flush();
    const options = charts.instances[0]?.options as { scales: { y: Record<string, unknown> } };
    expect(options.scales.y).toMatchObject({ suggestedMin: -100, suggestedMax: 3, beginAtZero: false });
    expect(options.scales.y).not.toHaveProperty("min");
    expect(options.scales.y).not.toHaveProperty("max");
    editor.destroy(); doc.destroy(); directory.destroy();
  });

  it("keeps invalid range source intact without constructing a chart", () => {
    const { doc, directory, id } = fixture();
    const source = JSON.stringify({ ...JSON.parse(mapping), y: [{ field: "value", range: [7, 1] }] });
    editBlock(doc, id, mapping, source);
    const before = Y.encodeStateAsUpdate(doc);
    const { editor } = mountEditor(doc);
    flush();
    expect(editor.view.dom.querySelector(".ub-chart-panel")?.getAttribute("data-state")).toBe("invalid-configuration");
    expect(charts.instances).toHaveLength(0);
    expect(Y.encodeStateAsUpdate(doc)).toEqual(before);
    expect(getBlocks(doc).find(block => block.id === id)?.text).toBe(source);
    editor.destroy(); doc.destroy(); directory.destroy();
  });

  it("uses only plotted values for the baseline, ignoring null gaps and negative records rejected by x or schema", () => {
    const doc = new Y.Doc(), directory = new Y.Doc();
    initDoc(doc, { uuid: "filtered-baseline", title: "Filtered baseline" });
    appendBlock(doc, { type: "chart", text: JSON.stringify({ version: 1, type: "line", collection: "trend",
      x: { field: "day", type: "date" }, y: [{ field: "value", unit: "requests" }, { field: "secondary", unit: "requests" }],
    }) });
    applyDocData(doc, directory, [{ collection: "trend", schema: { version: 1, schema: { type: "object", properties: {
      day: { type: "string" }, value: { type: ["number", "null"] }, secondary: { type: ["number", "null"] }, marker: { type: "string" },
    } } }, upsert: [
      { id: "first", value: { day: "2026-01-01", value: 30, secondary: null } },
      { id: "gap", value: { day: "2026-01-02", value: null, secondary: 36 } },
      { id: "invalid-x", value: { day: "2026-02-31", value: -40, secondary: -40 } },
    ] }]);
    // A merged peer record can violate the schema despite valid local writes.
    doc.getMap("data").set(JSON.stringify(["record", "trend", "invalid-schema"]), {
      day: "2026-01-03", value: -50, secondary: -50, marker: 42,
    });
    const { editor } = mountEditor(doc);
    flush();
    const instance = charts.instances[0];
    if (instance === undefined) throw new Error("Chart did not draw");
    expect(instance.options).toMatchObject({ scales: { y: { beginAtZero: true } } });
    expect((instance.data as { datasets: { data: { y: number | null }[] }[] }).datasets.map(series => series.data.map(point => point.y)))
      .toEqual([[30, null], [null, 36]]);
    expect(editor.view.dom.querySelector(".ub-chart-diagnostics")?.textContent).toContain("1 invalid under the collection schema");
    expect(editor.view.dom.querySelector(".ub-chart-diagnostics")?.textContent).toContain("1 wrong-type or invalid x");
    editor.destroy(); doc.destroy(); directory.destroy();
  });

  it("uses observation labels on date scales while retaining the full accessible date", () => {
    const doc = new Y.Doc(), directory = new Y.Doc();
    initDoc(doc, { uuid: "calendar-chart", title: "Calendar" });
    appendBlock(doc, { type: "chart", text: JSON.stringify({ version: 1, type: "line", collection: "trend", x: { field: "day", type: "date", label: "Day" }, y: [{ field: "value" }] }) });
    applyDocData(doc, directory, [{ collection: "trend", schema: { version: 1, schema: { type: "object" } }, upsert: [
      { id: "a", value: { day: "2026-10-07", value: 3 } },
      { id: "b", value: { day: "2026-10-09", value: 7 } },
    ] }]);
    const { editor } = mountEditor(doc);
    flush();
    const options = charts.instances[0]?.options as { scales: { x: {
      title: { display: boolean }; afterBuildTicks: (scale: unknown) => void;
      ticks: { callback: (value: number) => unknown; maxRotation: number };
    } } };
    const scale = { min: Date.parse("2026-10-07"), max: Date.parse("2026-10-09"), width: 600, ticks: [] as { value: number }[], chart: { ctx: { save() {}, restore() {}, font: "", measureText: (text: string) => ({ width: text.length * 6 }) } } };
    options.scales.x.afterBuildTicks(scale);
    expect(options.scales.x.title.display).toBe(false);
    expect(options.scales.x.ticks.maxRotation).toBe(0);
    expect(scale.ticks.map(tick => tick.value)).toEqual([Date.parse("2026-10-07"), Date.parse("2026-10-09")]);
    expect(options.scales.x.ticks.callback(scale.ticks[0]?.value ?? NaN)).toEqual(["Oct 7"]);
    expect(editor.view.dom.querySelector(".ub-chart-description")?.textContent).toContain("Oct 7, 2026");
    editor.destroy(); doc.destroy(); directory.destroy();
  });
  it.each(["gap", "connect"])("labels only distinct plotted x values under %s without changing series points", (missing) => {
    for (const type of ["number", "date"] as const) {
      const x = (value: number): number | string => type === "number" ? value : `2026-10-0${value}`;
      const doc = new Y.Doc(), directory = new Y.Doc();
      initDoc(doc, { uuid: "observation-chart", title: "Observations" });
      appendBlock(doc, { type: "chart", text: JSON.stringify({ version: 1, type: "line", collection: "trend", missing,
        x: { field: "x", type, label: "Observation" }, y: [{ field: "a" }, { field: "b" }] }) });
      applyDocData(doc, directory, [{ collection: "trend", schema: { version: 1, schema: { type: "object" } }, upsert: [
        { id: "first", value: { x: x(1), a: 3 } },
        { id: "tied", value: { x: x(1), b: 4 } },
        { id: "absent", value: { x: x(2) } },
        { id: "null", value: { x: x(3), a: null, b: null } },
        { id: "invalid", value: { x: x(4), a: "wrong" } },
        { id: "last", value: { x: x(7), a: 7, b: 8 } },
      ] }]);
      const { editor } = mountEditor(doc);
      flush();
      const instance = charts.instances.at(-1);
      if (!instance) throw new Error("Chart did not draw");
      const data = JSON.stringify(instance.data);
      const options = instance.options as { scales: { x: {
        min: number; max: number; title: { display: boolean; text: string };
        afterBuildTicks: (scale: unknown) => void; afterFit: (scale: unknown) => void;
        ticks: { callback: (value: number) => unknown; autoSkip: boolean; maxRotation: number };
      } } };
      const { min, max } = options.scales.x;
      const scale = { min, max, width: 800, ticks: [] as { value: number }[],
        chart: { ctx: { save() {}, restore() {}, font: "", measureText: (text: string) => ({ width: text.length * 6 }) } } };
      options.scales.x.afterBuildTicks(scale);
      expect(scale.ticks.map(tick => tick.value)).toEqual([min, max]);
      expect(options.scales.x.ticks.callback(min)).toEqual([type === "number" ? "1" : "Oct 1"]);
      expect(options.scales.x.title).toMatchObject({ display: type === "number", text: "Observation" });
      expect(options.scales.x.ticks).toMatchObject({ autoSkip: false, maxRotation: 0 });
      scale.width = 5;
      options.scales.x.afterFit(scale);
      expect(scale.ticks.map(tick => tick.value)).toEqual([min]);
      expect(JSON.stringify(instance.data)).toBe(data);
      expect(options.scales.x).toMatchObject({ min, max });
      editor.destroy(); doc.destroy(); directory.destroy();
    }
  });
  it("shows a shared reader failure in every view and recovers on a valid update without writes", () => {
    const { doc, directory } = fixture();
    appendBlock(doc, { type: "chart", text: tableMapping });
    doc.getMap("data").set(JSON.stringify(["record", "trend", "a"]), { day: 1, value: NaN });
    const peer = new Y.Doc();
    Y.applyUpdate(peer, Y.encodeStateAsUpdate(doc));
    let local = 0;
    doc.on("update", (_update, _origin, _doc, transaction: Y.Transaction) => { if (transaction.local) local += 1; });
    const { editor } = mountEditor(doc);
    flush();
    expect(readDocData).toHaveBeenCalledTimes(1);
    expect(editor.view.dom.querySelectorAll(".ub-chart-panel[data-state=collection-unusable]")).toHaveLength(2);
    expect(editor.view.dom.querySelectorAll('.ub-chart[data-draw-state="error"]')).toHaveLength(2);
    const table = editor.view.dom.querySelector('.ub-chart[data-view="table"]');
    expect(table).not.toBeNull();
    expect(table?.querySelector(".ub-block-caption")?.hasAttribute("hidden")).toBe(true);
    expect(table?.querySelector(".ub-chart-footer .ub-copy")).not.toBeNull();
    expect(table?.querySelector(".ub-chart-open")?.getAttribute("aria-label")).toBe("Open table source");
    peer.getMap("data").set(JSON.stringify(["record", "trend", "a"]), { day: 1, value: 9 });
    Y.applyUpdate(doc, Y.encodeStateAsUpdate(peer, Y.encodeStateVector(doc)));
    flush();
    expect(readDocData).toHaveBeenCalledTimes(2);
    expect(editor.view.dom.querySelectorAll(".ub-chart-panel[data-state=ready]")).toHaveLength(2);
    expect(editor.view.dom.querySelectorAll('.ub-chart[data-draw-state="success"]')).toHaveLength(2);
    expect(editor.view.dom.querySelector(".ub-data-table tbody")?.textContent).toBe("19");
    peer.getMap("data").set(JSON.stringify(["record", "trend", "a"]), { day: 1, value: NaN });
    Y.applyUpdate(doc, Y.encodeStateAsUpdate(peer, Y.encodeStateVector(doc)));
    flush();
    expect(editor.view.dom.querySelector(".ub-chart[data-view=table] .ub-chart-notice")?.hasAttribute("hidden")).toBe(true);
    editor.destroy();
    expect(local).toBe(0);
    doc.destroy(); peer.destroy(); directory.destroy();
  });

  it("shares one full read and observer across mixed views, with no reads for source, caret, prose or annotation", () => {
    const { doc, directory, id } = fixture();
    applyDocData(doc, directory, [{ collection: "trend", upsert: [{ id: "b", value: { day: 2, value: 4 } }] }]);
    for (let index = 0; index < 9; index += 1) appendBlock(doc, { type: "chart", text: mapping });
    for (let index = 0; index < 10; index += 1) appendBlock(doc, { type: "chart", text: tableMapping });
    const data = doc.getMap("data");
    const observe = vi.spyOn(data, "observe");
    const unobserve = vi.spyOn(data, "unobserve");
    let local = 0;
    doc.on("update", (_update, _origin, _doc, transaction: Y.Transaction) => { if (transaction.local) local += 1; });
    const before = Y.encodeStateAsUpdate(doc);
    const { editor } = mountEditor(doc);
    flush();
    expect(observe).toHaveBeenCalledTimes(1);
    expect(readDocData).toHaveBeenCalledTimes(1);
    expect(editor.view.dom.querySelectorAll(".ub-data-table tbody tr")).toHaveLength(20);
    expect(Y.encodeStateAsUpdate(doc)).toEqual(before);
    expect(local).toBe(0);
    expect(editor.view.dom.querySelector(".ub-table-pager")).toBeNull();
    expect(editor.view.dom.querySelector(".ub-table-view:not([hidden]) tbody")?.textContent).toBe("1324");
    const firstChart = editor.view.dom.querySelector(".ub-chart-open") as HTMLButtonElement;
    firstChart.click();
    editor.commands.setTextSelection(1);
    typeText(editor, "prose");
    createAnnotation(doc, id, 0, 5, "reader", "mapping note");
    editBlock(doc, id, mapping, mapping.replace("Delivery", "Shipped"));
    flush();
    expect(readDocData).toHaveBeenCalledTimes(1);
    const peer = new Y.Doc();
    Y.applyUpdate(peer, Y.encodeStateAsUpdate(doc));
    local = 0;
    const chartUpdates = charts.instances.map(chart => chart.updates);
    const retainedRows = [...editor.view.dom.querySelectorAll(".ub-data-table tbody tr:first-child")];
    for (let value = 5; value < 10; value += 1) {
      applyDocData(peer, directory, [{ collection: "trend", upsert: [{ id: "b", value: { day: 2, value } }] }]);
      Y.applyUpdate(doc, Y.encodeStateAsUpdate(peer, Y.encodeStateVector(doc)));
    }
    flush();
    expect(readDocData).toHaveBeenCalledTimes(2);
    expect(charts.instances.map((chart, index) => chart.updates - (chartUpdates[index] ?? 0))).toEqual(Array(10).fill(1));
    expect([...editor.view.dom.querySelectorAll(".ub-data-table tbody tr:first-child")]).toEqual(retainedRows);
    for (const body of editor.view.dom.querySelectorAll(".ub-data-table tbody")) expect(body.textContent).toBe("1329");
    expect(editor.view.dom.querySelectorAll(".ub-chart-panel[data-state=ready]")).toHaveLength(20);
    editor.destroy();
    expect(unobserve).toHaveBeenCalledTimes(1);
    expect(local).toBe(0);
    peer.destroy(); doc.destroy(); directory.destroy();
  });

  it("moves limited mixed views with remote data, retains unchanged rows and never writes the source", () => {
    const { doc, directory, id } = fixture();
    const limitedChart = JSON.stringify({ ...JSON.parse(mapping), limit: 2 });
    const limitedTable = JSON.stringify({ ...JSON.parse(tableMapping), limit: 2, sort: { field: "day", direction: "desc" } });
    editBlock(doc, id, mapping, limitedChart);
    appendBlock(doc, { type: "chart", text: limitedTable });
    applyDocData(doc, directory, [{ collection: "trend", upsert: [
      { id: "b", value: { day: 2, value: 4 } }, { id: "c", value: { day: 3, value: 5 } },
    ] }]);
    const peer = new Y.Doc();
    Y.applyUpdate(peer, Y.encodeStateAsUpdate(doc));
    let local = 0;
    doc.on("update", (_update, _origin, _doc, transaction: Y.Transaction) => { if (transaction.local) local += 1; });
    const beforeMount = Y.encodeStateAsUpdate(doc);
    const { editor } = mountEditor(doc);
    flush();
    const chart = charts.instances[0];
    if (!chart) throw new Error("Chart did not draw");
    const chartRoot = editor.view.dom.querySelector(".ub-chart[data-view=line]") as HTMLElement;
    const tableRoot = editor.view.dom.querySelector(".ub-chart[data-view=table]") as HTMLElement;
    const chartNotice = chartRoot.querySelector(".ub-chart-notice") as HTMLElement;
    const tableNotice = tableRoot.querySelector(".ub-chart-notice") as HTMLElement;
    const points = () => (chart.data as { datasets: { data: { x: number; y: number }[] }[] }).datasets[0]?.data;
    const sources = () => getBlocks(doc).filter(block => block.type === "chart").map(block => block.text);
    expect(points()).toEqual([{ x: 2, y: 4 }, { x: 3, y: 5 }]);
    expect(chart.options).toMatchObject({ scales: { x: { min: 2, max: 3 } } });
    expect(chartNotice.textContent).toBe("Showing the latest 2 of 3 records");
    expect(tableNotice.textContent).toBe("Generated from document data · read-only · Showing 2 of 3 records");
    const initialRows = [...tableRoot.querySelectorAll("tbody tr")];
    expect(initialRows.map(row => row.textContent)).toEqual(["35", "24"]);
    for (const notice of [chartNotice, tableNotice]) {
      expect(notice.closest('[aria-live], [role="alert"], [role="status"]')).toBeNull();
    }
    expect(editor.view.dom.querySelector(".ub-table-pager, .ub-table-range")).toBeNull();
    expect([...editor.view.dom.querySelectorAll(".ub-chart-diagnostics")].every(element => element.hasAttribute("hidden"))).toBe(true);
    expect(Y.encodeStateAsUpdate(doc)).toEqual(beforeMount);

    applyDocData(peer, directory, [{ collection: "trend", upsert: [{ id: "d", value: { day: 4, value: 6 } }] }]);
    Y.applyUpdate(doc, Y.encodeStateAsUpdate(peer, Y.encodeStateVector(doc)));
    const beforeRedraw = Y.encodeStateAsUpdate(doc);
    flush();
    expect(points()).toEqual([{ x: 3, y: 5 }, { x: 4, y: 6 }]);
    expect(chart.options).toMatchObject({ scales: { x: { min: 3, max: 4 } } });
    const nextRows = [...tableRoot.querySelectorAll("tbody tr")];
    expect(nextRows.map(row => row.textContent)).toEqual(["46", "35"]);
    expect(nextRows[1]).toBe(initialRows[0]);
    expect(initialRows[1]?.isConnected).toBe(false);
    expect(chartNotice.textContent).toBe("Showing the latest 2 of 4 records");
    expect(tableNotice.textContent).toBe("Generated from document data · read-only · Showing 2 of 4 records");
    expect(sources()).toEqual([limitedChart, limitedTable]);
    expect(Y.encodeStateAsUpdate(doc)).toEqual(beforeRedraw);
    expect(local).toBe(0);

    applyDocData(peer, directory, [{ collection: "trend", deleteRecords: ["a", "b"] }]);
    Y.applyUpdate(doc, Y.encodeStateAsUpdate(peer, Y.encodeStateVector(doc)));
    flush();
    expect(chartNotice.hasAttribute("hidden")).toBe(true);
    expect(chartNotice.textContent).toBe("");
    expect(tableNotice.textContent).toBe("Generated from document data · read-only");
    expect([...tableRoot.querySelectorAll("tbody tr")]).toEqual(nextRows);
    expect(sources()).toEqual([limitedChart, limitedTable]);
    editor.destroy();
    expect(local).toBe(0);
    peer.destroy(); doc.destroy(); directory.destroy();
  });

  it("drops snapshots after the last mixed view leaves and isolates documents over twenty remount cycles", () => {
    const { doc, directory } = fixture();
    appendBlock(doc, { type: "chart", text: tableMapping });
    const data = doc.getMap("data");
    const observe = vi.spyOn(data, "observe");
    const unobserve = vi.spyOn(data, "unobserve");
    for (let cycle = 0; cycle < 20; cycle += 1) {
      applyDocData(doc, directory, [{ collection: "trend", upsert: [{ id: "a", value: { day: 1, value: cycle } }] }]);
      const before = Y.encodeStateAsUpdate(doc);
      const first = mountEditor(doc);
      const second = mountEditor(doc);
      flush();
      expect(observe).toHaveBeenCalledTimes(cycle + 1);
      expect(readDocData).toHaveBeenCalledTimes(cycle + 1);
      expect(first.editor.view.dom.querySelector(".ub-table-view:not([hidden]) tbody")?.textContent).toBe(`1${cycle}`);
      first.editor.destroy();
      expect(unobserve).toHaveBeenCalledTimes(cycle);
      second.editor.destroy();
      expect(unobserve).toHaveBeenCalledTimes(cycle + 1);
      expect(Y.encodeStateAsUpdate(doc)).toEqual(before);
      expect(frames.size).toBe(0);
    }
    const next = fixture();
    appendBlock(next.doc, { type: "chart", text: tableMapping });
    const mounted = mountEditor(next.doc);
    flush();
    expect(mounted.editor.view.dom.querySelector(".ub-table-view:not([hidden]) tbody")?.textContent).toBe("13");
    mounted.editor.destroy();
    doc.destroy(); directory.destroy(); next.doc.destroy(); next.directory.destroy();
  });

  it("renders every current and arriving record in an unwritable table with safe native cells and no writes", () => {
    const { doc, directory } = fixture();
    getBlocksFragment(doc).delete(1, 1);
    appendBlock(doc, { type: "chart", text: JSON.stringify({ version: 1, type: "table", collection: "trend", title: "Evidence", pageSize: 1,
      columns: [{ field: "day", format: "number" }, { field: "value", format: "number" }, { field: "link", format: "link" }, { field: "note" }] }) });
    applyDocData(doc, directory, [{ collection: "trend", upsert: [
      { id: "a", value: { day: 1, value: 3, link: "https://example.com", note: "<img src=x onerror=alert(1)>" } },
      { id: "b", value: { day: 2, value: 4, link: "javascript:alert(1)" } },
    ] }]);
    const peer = new Y.Doc();
    Y.applyUpdate(peer, Y.encodeStateAsUpdate(doc));
    let local = 0;
    doc.on("update", (_update, _origin, _doc, transaction: Y.Transaction) => { if (transaction.local) local += 1; });
    const element = document.createElement("div");
    document.body.append(element);
    const editor = createUberblickEditor({ element, fragment: getBlocksFragment(doc), editable: false, canWrite: () => false });
    flush();
    const link = element.querySelector(".ub-data-table a");
    expect(link?.getAttribute("rel")).toBe("noopener noreferrer");
    expect(link?.getAttribute("target")).toBe("_blank");
    expect(element.querySelector(".ub-data-table caption")?.textContent).toBe("Evidence");
    expect(element.querySelectorAll("th[scope=col]")).toHaveLength(4);
    expect(element.querySelector(".ub-data-table img")).toBeNull();
    expect(element.querySelectorAll(".ub-data-table tbody tr")).toHaveLength(2);
    expect(element.querySelector(".ub-table-range, .ub-table-pager")).toBeNull();
    expect(element.querySelector(".ub-data-table tbody")?.textContent).toMatch(/Invalid.*javascript:alert\(1\).*Absent/i);
    expect(element.querySelectorAll(".ub-data-table a")).toHaveLength(1);
    expect(element.querySelector(".ub-chart-title")?.hasAttribute("hidden")).toBe(true);
    expect(element.querySelector(".ub-chart-notice")?.textContent).toBe("Generated from document data · read-only");
    expect(element.querySelector(".ub-chart-notice")?.hasAttribute("aria-live")).toBe(false);
    expect(element.querySelector(".ub-chart")?.getAttribute("data-view")).toBe("table");
    const dayHeader = element.querySelector<HTMLButtonElement>("th button")!;
    dayHeader.click();
    dayHeader.click();
    expect([...element.querySelectorAll("tbody tr")].map(row => row.firstElementChild?.textContent)).toEqual(["2", "1"]);
    expect(element.querySelector('th[aria-sort="descending"]')?.textContent).toBe("day↓");
    expect(local).toBe(0);
    applyDocData(peer, directory, [{ collection: "trend", upsert: [{ id: "b", value: { day: 2, value: 9 } }] }]);
    Y.applyUpdate(doc, Y.encodeStateAsUpdate(peer, Y.encodeStateVector(doc)));
    flush();
    expect(element.querySelector(".ub-data-table tbody")?.textContent).toContain("29");
    // A peer's merged value can violate the schema even though local writes validate.
    peer.getMap("data").set(JSON.stringify(["record", "trend", "a"]), { day: "wrong type", value: 3 });
    Y.applyUpdate(doc, Y.encodeStateAsUpdate(peer, Y.encodeStateVector(doc)));
    flush();
    expect(element.querySelectorAll(".ub-data-table tbody tr")).toHaveLength(1);
    expect(element.querySelector(".ub-chart-diagnostics")?.textContent).toBe("1 records not shown (invalid under the collection schema).");
    expect(element.querySelector(".ub-chart-diagnostics")?.hasAttribute("aria-live")).toBe(false);
    expect(element.querySelector(".ub-chart-panel")?.nextElementSibling?.querySelector(".ub-chart-notice")?.textContent).toBe("Generated from document data · read-only");
    applyDocData(peer, directory, [{ collection: "trend", replaceRecords: [] }]);
    Y.applyUpdate(doc, Y.encodeStateAsUpdate(peer, Y.encodeStateVector(doc)));
    flush();
    expect(element.querySelector(".ub-chart-panel")?.getAttribute("data-state")).toBe("no-records");
    applyDocData(peer, directory, [{ collection: "trend", upsert: [
      { id: "a", value: { day: 1, value: 3 } }, { id: "b", value: { day: 2, value: 9 } },
    ] }]);
    Y.applyUpdate(doc, Y.encodeStateAsUpdate(peer, Y.encodeStateVector(doc)));
    flush();
    expect(element.querySelector(".ub-data-table tbody")?.textContent).toContain("13");
    applyDocData(peer, directory, [{ collection: "trend", deleteRecords: ["b"] }]);
    Y.applyUpdate(doc, Y.encodeStateAsUpdate(peer, Y.encodeStateVector(doc)));
    flush();
    expect(element.querySelector(".ub-data-table tbody")?.textContent).toContain("13");
    expect(element.querySelectorAll(".ub-data-table tbody tr")).toHaveLength(1);
    editor.destroy(); element.remove();
    expect(local).toBe(0);
    doc.destroy(); peer.destroy(); directory.destroy();
  });

  it("keeps source and annotation chrome current without redrawing charts for caret moves or unrelated typing", () => {
    const { doc, directory, id } = fixture();
    appendBlock(doc, { type: "chart", text: mapping });
    const { editor } = mountEditor(doc);
    flush();
    expect(charts.instances).toHaveLength(2);
    const chart = editor.view.dom.querySelector(".ub-chart") as HTMLElement;
    for (const character of "abcdefghijklmnopqrst") {
      editor.commands.setTextSelection(1);
      typeText(editor, character);
      flush();
    }
    const source = chart.querySelector(".ub-chart-open") as HTMLButtonElement;
    source.click();
    flush();
    expect(chart.classList.contains("ub-chart-editing")).toBe(true);
    editor.commands.setTextSelection(1);
    flush();
    expect(chart.classList.contains("ub-chart-editing")).toBe(false);
    createAnnotation(doc, id, 0, 5, "reader", "Mapping note");
    flush();
    expect(chart.getAttribute("data-annotated")).toBe("true");
    expect(charts.instances.every(instance => instance.updates === 0)).toBe(true);
    expect(frames.size).toBe(0);
    editBlock(doc, id, mapping, mapping.replace("Delivery", "Shipped"));
    flush();
    expect(charts.instances.map(instance => instance.updates)).toEqual([1, 0]);
    expect(chart.querySelector(".ub-chart-description")?.textContent).toContain("Shipped: 3 issues");
    editor.destroy(); doc.destroy(); directory.destroy();
  });

  it("renders current and arriving data in an unwritable editor without a local write", () => {
    const { doc, directory } = fixture();
    const peer = new Y.Doc();
    Y.applyUpdate(peer, Y.encodeStateAsUpdate(doc));
    let local = 0;
    doc.on("update", (_update, _origin, _doc, transaction: Y.Transaction) => { if (transaction.local) local += 1; });
    const element = document.createElement("div");
    document.body.append(element);
    const editor = createUberblickEditor({ element, fragment: getBlocksFragment(doc), editable: false, canWrite: () => false });
    flush();
    expect(element.querySelector(".ub-chart-panel")?.getAttribute("data-state")).toBe("ready");
    applyDocData(peer, directory, [{ collection: "trend", upsert: [{ id: "a", value: { day: 1, value: 9 } }] }]);
    Y.applyUpdate(doc, Y.encodeStateAsUpdate(peer, Y.encodeStateVector(doc)));
    flush();
    expect(element.querySelector(".ub-chart-description")?.textContent).toContain("Delivery: 9 issues");
    editor.destroy(); element.remove();
    expect(local).toBe(0);
    doc.destroy(); peer.destroy(); directory.destroy();
  });
  it("mounts, redraws a burst once per frame, follows remote mapping/data and adds no local update", () => {
    const { doc, directory, id } = fixture();
    const peer = new Y.Doc();
    Y.applyUpdate(peer, Y.encodeStateAsUpdate(doc));
    const before = Y.encodeStateAsUpdate(doc);
    let local = 0;
    doc.on("update", (_update, _origin, _doc, transaction: Y.Transaction) => { if (transaction.local) local += 1; });
    const { editor } = mountEditor(doc);
    flush();
    expect(local).toBe(0);
    expect(Y.encodeStateAsUpdate(doc)).toEqual(before);
    expect(charts.instances).toHaveLength(1);
    const chart = charts.instances[0];
    const description = () => editor.view.dom.querySelector(".ub-chart-description")?.textContent;
    expect(description()).toContain("Delivery: 3 issues");
    for (let value = 4; value <= 8; value += 1) {
      const cursor = Y.encodeStateVector(doc);
      applyDocData(peer, directory, [{ collection: "trend", upsert: [{ id: "a", value: { day: 1, value } }] }]);
      Y.applyUpdate(doc, Y.encodeStateAsUpdate(peer, cursor));
    }
    expect(chart?.updates).toBe(0);
    flush();
    expect(chart?.updates).toBe(1);
    expect(description()).toContain("Delivery: 8 issues");
    editBlock(peer, id, mapping, mapping.replace("Delivery", "Shipped"));
    Y.applyUpdate(doc, Y.encodeStateAsUpdate(peer, Y.encodeStateVector(doc)));
    flush();
    expect(description()).toContain("Shipped: 8 issues");
    const source = editor.view.dom.querySelector(".ub-chart-open") as HTMLButtonElement;
    source.click();
    flush();
    expect(editor.state.selection.$head.parent.type.name).toBe("chart");
    expect(local).toBe(0);
    editor.destroy();
    expect(chart?.destroyed).toBe(true);
    expect(local).toBe(0);
    peer.destroy();
    doc.destroy();
    directory.destroy();
  });

  it("holds one data observer per mounted chart and releases it on removal, remount and document switch", () => {
    const { doc, directory } = fixture();
    const data = doc.getMap("data");
    const observe = vi.spyOn(data, "observe");
    const unobserve = vi.spyOn(data, "unobserve");
    const { editor } = mountEditor(doc);
    flush();
    expect(observe).toHaveBeenCalledTimes(1);
    for (let cycle = 0; cycle < 20; cycle += 1) {
      getBlocksFragment(doc).delete(1, 1);
      flush();
      expect(unobserve).toHaveBeenCalledTimes(cycle + 1);
      appendBlock(doc, { type: "chart", text: mapping });
      flush();
      expect(observe).toHaveBeenCalledTimes(cycle + 2);
      expect(charts.instances.filter(chart => !chart.destroyed)).toHaveLength(1);
    }
    editor.destroy();
    expect(unobserve).toHaveBeenCalledTimes(21);
    expect(charts.instances.every(chart => chart.destroyed)).toBe(true);
    const nextDoc = fixture();
    const next = mountEditor(nextDoc.doc);
    flush();
    expect(charts.instances.filter(chart => !chart.destroyed)).toHaveLength(1);
    next.editor.destroy();
    expect(frames.size).toBe(0);
    doc.destroy(); directory.destroy(); nextDoc.doc.destroy(); nextDoc.directory.destroy();
  });

  it("recovers problem states without changing mapping, schema or records and keeps annotated source visible", () => {
    const { doc, directory, id } = fixture();
    const { editor } = mountEditor(doc);
    flush();
    editBlock(doc, id, mapping, "not JSON");
    const before = Y.encodeStateAsUpdate(doc);
    flush();
    expect(editor.view.dom.querySelector(".ub-chart-message")?.textContent).toContain("Invalid chart configuration");
    expect(Y.encodeStateAsUpdate(doc)).toEqual(before);
    editBlock(doc, id, "not JSON", mapping);
    flush();
    expect(editor.view.dom.querySelector(".ub-chart-panel")?.getAttribute("data-state")).toBe("ready");
    const storedData = readDocData(doc);
    createAnnotation(doc, id, 0, 5, "reader", "Mapping note");
    flush();
    expect(editor.view.dom.querySelector(".ub-chart")?.getAttribute("data-annotated")).toBe("true");
    expect(getBlocks(doc).find(block => block.id === id)?.text).toBe(mapping);
    expect(readDocData(doc)).toEqual(storedData);
    editor.destroy(); doc.destroy(); directory.destroy();
  });
});

describe("the panel chart's shared presentation and lifecycle", () => {
  it("draws ordered panels with shared ranges and observation labels as one accessible image", () => {
    const { doc, directory, id, source } = panelFixture();
    const overlay = JSON.stringify({ ...JSON.parse(source), layout: "overlay" });
    editBlock(doc, id, source, overlay);
    const { editor } = mountEditor(doc);
    flush();
    const root = editor.view.dom.querySelector(".ub-chart") as HTMLElement;
    const overlayImage = root.querySelector("canvas") as HTMLCanvasElement;
    const accessibleName = overlayImage.getAttribute("aria-label");
    const accessibleDescription = root.querySelector(".ub-chart-description")?.textContent;
    const overlayChart = charts.instances[0];
    editBlock(doc, id, overlay, source);
    flush();

    expect(overlayChart?.destroyed).toBe(true);
    const live = charts.instances.filter(chart => !chart.destroyed);
    expect(live).toHaveLength(4);
    const panels = [...root.querySelectorAll(".ub-chart-series-panel")];
    expect(panels).toHaveLength(4);
    expect(panels.map(panel => panel.querySelector(".ub-chart-series-header")?.textContent)).toEqual([
      expect.stringContaining("Autonomous"), expect.stringContaining("Wasted"),
      expect.stringContaining("Denials"), expect.stringContaining("No observations"),
    ]);
    expect(panels[0]?.querySelector(".ub-chart-series-header")?.textContent).toContain("10 %");
    expect(panels[1]?.querySelector(".ub-chart-series-header")?.textContent).toContain("-20 %");
    expect(panels[2]?.querySelector(".ub-chart-series-header")?.textContent).toContain("9,000 requests");
    expect(panels[3]?.querySelector(".ub-chart-series-header")?.textContent).toContain("no plotted value");
    const image = root.querySelector(".ub-chart-panels") as HTMLElement;
    expect(image.getAttribute("role")).toBe("img");
    expect(image.getAttribute("aria-label")).toBe(accessibleName);
    expect(image.getAttribute("aria-describedby")).toBe(root.querySelector(".ub-chart-description")?.id);
    expect(root.querySelector(".ub-chart-description")?.textContent).toBe(accessibleDescription);
    expect([...root.querySelectorAll('[role="img"]')].filter(element => !element.closest("[hidden]"))).toEqual([image]);

    const tickSelections: number[][] = [];
    live.forEach((chart, index) => {
      const options = panelOptions(chart), data = panelData(chart);
      expect(data.datasets).toHaveLength(1);
      expect(data.datasets[0]).toMatchObject({ yAxisID: "y" });
      expect(options).toMatchObject({ interaction: { mode: "nearest", axis: "x", intersect: false },
        plugins: { legend: { display: false } }, scales: {
          x: { min: 1, max: 6, title: { display: true, text: "Observation" }, grid: { display: false }, border: { display: false } },
          y: { ticks: { maxTicksLimit: 3 }, border: { display: false } },
        } });
      expect(options.scales).not.toHaveProperty("yRight");
      expect(options.scales.y).not.toHaveProperty("title");
      const scale = { min: 1, max: 6, width: 180, ticks: [] as { value: number }[],
        chart: { ctx: { save() {}, restore() {}, font: "", measureText: (text: string) => ({ width: text.length * 6 }) } } };
      options.scales.x.afterBuildTicks(scale);
      options.scales.x.afterFit(scale);
      tickSelections.push(scale.ticks.map(tick => tick.value));
      expect(options.scales.x.ticks.callback(1)).toEqual(["1"]);
      const canvas = panels[index]?.querySelector("canvas");
      expect(chart.canvas).toBe(canvas);
      expect(canvas?.getAttribute("role")).toBeNull();
      expect(canvas?.getAttribute("aria-hidden")).toBe("true");
      const header = panels[index]?.querySelector(".ub-chart-series-header") as HTMLElement;
      const color = document.createElement("span");
      color.style.color = data.datasets[0]?.borderColor ?? "";
      expect(header.style.color).toBe(color.style.color);
    });
    expect(tickSelections).toEqual(Array(4).fill([1, 6]));
    const [first, second, third] = live.map(panelOptions);
    expect(first?.scales.y.suggestedMin).toBe(second?.scales.y.suggestedMin);
    expect(first?.scales.y.suggestedMax).toBe(second?.scales.y.suggestedMax);
    expect(first?.scales.y.suggestedMin).toBeLessThanOrEqual(-20);
    expect(first?.scales.y.suggestedMax).toBeGreaterThanOrEqual(30);
    expect(first?.scales.y.beginAtZero).toBe(false);
    expect(third?.scales.y.suggestedMin).toBe(0);
    expect(third?.scales.y.suggestedMax).toBeGreaterThanOrEqual(9_000);
    expect(third?.scales.y.beginAtZero).toBe(true);
    for (const chart of live) {
      expect(panelOptions(chart).scales.y).not.toHaveProperty("min");
      expect(panelOptions(chart).scales.y).not.toHaveProperty("max");
      expect(panelOptions(chart).scales.y.ticks).not.toHaveProperty("count");
    }
    const sharedTicks = [{ value: -20 }, { value: 0 }, { value: 30 }];
    expect(first?.scales.y.ticks.callback(0, 1, sharedTicks)).toBe("0%");
    expect(third?.scales.y.ticks.callback(9_000, 2, [{ value: 0 }, { value: 5_000 }, { value: 10_000 }])).toBe("9K requests");
    expect(first?.plugins.tooltip.callbacks.label({ datasetIndex: 0, parsed: { y: 10 } })).toBe("Autonomous: 10 %");
    expect(second?.plugins.tooltip.callbacks.label({ datasetIndex: 0, parsed: { y: -20 } })).toBe("Wasted: -20 %");
    expect(third?.plugins.tooltip.callbacks.label({ datasetIndex: 0, parsed: { y: 9_000 } })).toBe("Denials: 9,000 requests");
    expect(third?.plugins.tooltip.callbacks.label({ datasetIndex: 0, parsed: { y: null } })).toBe("");
    expect(root.querySelector(".ub-chart-open")?.getAttribute("aria-label")).toBe("Open chart source");
    expect(root.querySelector(".ub-block-caption .ub-copy")).not.toBeNull();
    expect(root.querySelectorAll(".ub-chart-diagnostics")).toHaveLength(1);
    editor.destroy(); doc.destroy(); directory.destroy();
  });

  it("retains single-x points in every panel and applies the point rule per series", () => {
    const { doc, directory, id } = fixture();
    const source = JSON.stringify({ ...JSON.parse(mapping), layout: "panels", y: [
      { field: "value", label: "Delivery" }, { field: "secondary", label: "Other" },
    ] });
    editBlock(doc, id, mapping, source);
    applyDocData(doc, directory, [{ collection: "trend", schema: { version: 1, schema: { type: "object" } },
      replaceRecords: [{ id: "only", value: { day: 1, value: 3, secondary: 7 } }],
    }]);
    const { editor } = mountEditor(doc);
    flush();
    expect(charts.instances).toHaveLength(2);
    for (const chart of charts.instances) {
      expect(panelOptions(chart).scales.x).toMatchObject({ min: 0, max: 2 });
      expect(panelData(chart).datasets[0]?.data).toHaveLength(1);
      expect(panelPointRadius(chart, 0)).toBe(2);
    }
    applyDocData(doc, directory, [{ collection: "trend", replaceRecords: Array.from({ length: 41 }, (_, index) => ({
      id: `point-${index}`, value: { day: index + 1, value: index, ...(index === 20 ? { secondary: 7 } : {}) },
    })) }]);
    flush();
    expect(panelPointRadius(charts.instances[0] as RecordedChart, 20)).toBe(0);
    expect(panelPointRadius(charts.instances[1] as RecordedChart, 20)).toBe(2);
    expect(panelPointRadius(charts.instances[1] as RecordedChart, 0)).toBe(0);
    applyDocData(doc, directory, [{ collection: "trend", replaceRecords: Array.from({ length: 45 }, (_, index) => ({
      id: `point-${index}`, value: { day: index + 1, value: index, ...(index === 19 || index === 21 ? {} : { secondary: index }) },
    })) }]);
    flush();
    expect(panelPointRadius(charts.instances[0] as RecordedChart, 20)).toBe(0);
    expect(panelPointRadius(charts.instances[1] as RecordedChart, 20)).toBe(2);
    expect(panelPointRadius(charts.instances[1] as RecordedChart, 18)).toBe(0);
    expect(panelPointRadius(charts.instances[1] as RecordedChart, 19)).toBe(0);
    editor.destroy(); doc.destroy(); directory.destroy();
  });

  it("coalesces data, mapping, theme, appearance and font redraws through one binding without writes", async () => {
    const { doc, directory, id, source } = panelFixture();
    const peer = new Y.Doc();
    Y.applyUpdate(peer, Y.encodeStateAsUpdate(doc));
    const data = doc.getMap("data");
    const observe = vi.spyOn(data, "observe"), unobserve = vi.spyOn(data, "unobserve");
    let local = 0, appearanceChanged: (() => void) | undefined, fontReady: (() => void) | undefined;
    doc.on("update", (_update, _origin, _doc, transaction: Y.Transaction) => { if (transaction.local) local += 1; });
    vi.stubGlobal("matchMedia", () => ({ addEventListener: (_name: string, callback: () => void) => { appearanceChanged = callback; }, removeEventListener() {} }));
    const originalFonts = Object.getOwnPropertyDescriptor(document, "fonts");
    Object.defineProperty(document, "fonts", { configurable: true, value: { ready: new Promise<void>(resolve => { fontReady = resolve; }) } });
    const originalTheme = document.documentElement.getAttribute("data-theme");
    const { editor } = mountEditor(doc);
    try {
      const before = Y.encodeStateAsUpdate(doc);
      flush();
      expect(observe).toHaveBeenCalledTimes(1);
      expect(readDocData).toHaveBeenCalledTimes(1);
      expect(charts.instances).toHaveLength(4);
      expect(Y.encodeStateAsUpdate(doc)).toEqual(before);
      for (let value = 31; value < 35; value += 1) {
        applyDocData(peer, directory, [{ collection: "trend", upsert: [{ id: "last", value: { day: 6, value, secondary: -20, third: 9_000 } }] }]);
        Y.applyUpdate(doc, Y.encodeStateAsUpdate(peer, Y.encodeStateVector(doc)));
      }
      editBlock(peer, id, source, source.replace("Autonomous", "Shipped"));
      Y.applyUpdate(doc, Y.encodeStateAsUpdate(peer, Y.encodeStateVector(doc)));
      appearanceChanged?.();
      document.documentElement.setAttribute("data-theme", "dark");
      fontReady?.();
      await Promise.resolve();
      expect(charts.instances.map(chart => chart.updates)).toEqual([0, 0, 0, 0]);
      expect(frames.size).toBe(1);
      const beforeDraw = Y.encodeStateAsUpdate(doc);
      flush();
      expect(charts.instances.map(chart => chart.updates)).toEqual([1, 1, 1, 1]);
      expect(charts.instances.filter(chart => !chart.destroyed)).toHaveLength(4);
      expect(readDocData).toHaveBeenCalledTimes(2);
      expect(observe).toHaveBeenCalledTimes(1);
      expect(editor.view.dom.querySelector(".ub-chart-series-header")?.textContent).toContain("Shipped");
      expect(editor.view.dom.querySelector(".ub-chart-series-header")?.textContent).toContain("34 %");
      expect(Y.encodeStateAsUpdate(doc)).toEqual(beforeDraw);
      expect(local).toBe(0);
      appearanceChanged?.();
      document.documentElement.setAttribute("data-theme", "light");
      await Promise.resolve();
      flush();
      expect(charts.instances.map(chart => chart.updates)).toEqual([2, 2, 2, 2]);
      expect(readDocData).toHaveBeenCalledTimes(2);
      expect(Y.encodeStateAsUpdate(doc)).toEqual(beforeDraw);
      expect(local).toBe(0);
    } finally {
      editor.destroy();
      if (originalFonts) Object.defineProperty(document, "fonts", originalFonts);
      else Reflect.deleteProperty(document, "fonts");
      if (originalTheme === null) document.documentElement.removeAttribute("data-theme");
      else document.documentElement.setAttribute("data-theme", originalTheme);
      doc.destroy(); peer.destroy(); directory.destroy();
    }
    expect(unobserve).toHaveBeenCalledTimes(1);
    expect(charts.instances.every(chart => chart.destroyed)).toBe(true);
    expect(frames.size).toBe(0);
    expect(local).toBe(0);
  });

  it("replaces instances on layout and series-count changes and releases all panels for problem states", () => {
    const { doc, directory, id, source } = panelFixture();
    const { editor } = mountEditor(doc);
    flush();
    const first = [...charts.instances];
    const shorter = JSON.stringify({ ...JSON.parse(source), y: JSON.parse(source).y.slice(0, 2) });
    editBlock(doc, id, source, shorter);
    flush();
    expect(first.every(chart => chart.destroyed)).toBe(true);
    expect(charts.instances.filter(chart => !chart.destroyed)).toHaveLength(2);
    expect(editor.view.dom.querySelectorAll(".ub-chart-series-panel")).toHaveLength(2);
    const overlay = JSON.stringify({ ...JSON.parse(shorter), layout: "overlay" });
    editBlock(doc, id, shorter, overlay);
    flush();
    expect(charts.instances.filter(chart => !chart.destroyed)).toHaveLength(1);
    expect(editor.view.dom.querySelector(".ub-chart-panels")).toBeNull();
    expect(editor.view.dom.querySelector(".ub-chart-screen > canvas")?.getAttribute("role")).toBe("img");
    editBlock(doc, id, overlay, source);
    flush();
    expect(charts.instances.filter(chart => !chart.destroyed)).toHaveLength(4);
    editBlock(doc, id, source, "not JSON");
    const before = Y.encodeStateAsUpdate(doc);
    flush();
    expect(charts.instances.every(chart => chart.destroyed)).toBe(true);
    expect(editor.view.dom.querySelector(".ub-chart-panel")?.getAttribute("data-state")).toBe("invalid-configuration");
    expect(editor.view.dom.querySelector(".ub-chart-message")?.textContent).toContain("Invalid chart configuration");
    expect(Y.encodeStateAsUpdate(doc)).toEqual(before);
    editBlock(doc, id, "not JSON", source);
    flush();
    expect(charts.instances.filter(chart => !chart.destroyed)).toHaveLength(4);
    applyDocData(doc, directory, [{ collection: "trend", replaceRecords: [] }]);
    flush();
    expect(charts.instances.every(chart => chart.destroyed)).toBe(true);
    expect(editor.view.dom.querySelector(".ub-chart-panel")?.getAttribute("data-state")).toBe("no-records");
    expect(editor.view.dom.querySelector(".ub-chart-open")?.getAttribute("aria-label")).toBe("Open chart source");
    editor.destroy(); doc.destroy(); directory.destroy();
  });

  it("releases every instance and its one observer on removal, remount and document switch", () => {
    const { doc, directory, source } = panelFixture();
    const observe = vi.spyOn(doc.getMap("data"), "observe"), unobserve = vi.spyOn(doc.getMap("data"), "unobserve");
    const { editor } = mountEditor(doc);
    flush();
    expect(observe).toHaveBeenCalledTimes(1);
    expect(charts.instances.filter(chart => !chart.destroyed)).toHaveLength(4);
    getBlocksFragment(doc).delete(1, 1);
    flush();
    expect(charts.instances.every(chart => chart.destroyed)).toBe(true);
    expect(unobserve).toHaveBeenCalledTimes(1);
    appendBlock(doc, { type: "chart", text: source });
    flush();
    expect(charts.instances.filter(chart => !chart.destroyed)).toHaveLength(4);
    expect(observe).toHaveBeenCalledTimes(2);
    expect(readDocData).toHaveBeenCalledTimes(2);
    editor.destroy();
    expect(charts.instances.every(chart => chart.destroyed)).toBe(true);
    expect(unobserve).toHaveBeenCalledTimes(2);
    const next = panelFixture();
    const mounted = mountEditor(next.doc);
    flush();
    expect(charts.instances.filter(chart => !chart.destroyed)).toHaveLength(4);
    mounted.editor.destroy();
    expect(charts.instances.every(chart => chart.destroyed)).toBe(true);
    expect(frames.size).toBe(0);
    doc.destroy(); directory.destroy(); next.doc.destroy(); next.directory.destroy();
  });
});

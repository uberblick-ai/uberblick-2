import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as Y from "yjs";
import {
  appendBlock, applyDocData, createAnnotation, editBlock, getBlocks, getBlocksFragment,
  initDoc, readDocData,
} from "@uberblick/schema";
import { mountEditor, typeText } from "./helpers.js";
import { createUberblickEditor } from "../src/editor/create-editor.js";
import type { ChartConfiguration } from "chart.js";

const charts = vi.hoisted(() => ({ instances: [] as Array<{ data: unknown; options: unknown; updates: number; destroyed: boolean }> }));
vi.mock("@uberblick/schema", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@uberblick/schema")>();
  return { ...actual, readDocData: vi.fn(actual.readDocData) };
});
vi.mock("chart.js", () => {
  class Chart {
    static register() {}
    data: unknown;
    options: unknown;
    updates = 0;
    destroyed = false;
    constructor(_canvas: unknown, config: { data: unknown; options: unknown }) {
      this.data = config.data;
      this.options = config.options;
      charts.instances.push(this);
    }
    update() { this.updates += 1; }
    destroy() { this.destroyed = true; }
  }
  return { Chart, LineController: {}, LineElement: {}, PointElement: {}, LinearScale: {}, Legend: {}, Tooltip: {} };
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
    charts.instances = [];
    vi.mocked(readDocData).mockClear();
});
afterEach(() => { vi.unstubAllGlobals(); });

describe("the chart's derived lifecycle", () => {
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
    expect(root.querySelector(":scope > .ub-copy")).not.toBeNull();
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
    expect(source?.textContent).toBe("source");
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
    peer.getMap("data").set(JSON.stringify(["record", "trend", "a"]), { day: 1, value: 9 });
    Y.applyUpdate(doc, Y.encodeStateAsUpdate(peer, Y.encodeStateVector(doc)));
    flush();
    expect(readDocData).toHaveBeenCalledTimes(2);
    expect(editor.view.dom.querySelectorAll(".ub-chart-panel[data-state=ready]")).toHaveLength(2);
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

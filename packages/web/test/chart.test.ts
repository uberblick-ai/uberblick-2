import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as Y from "yjs";
import {
  appendBlock, applyDocData, createAnnotation, editBlock, getBlocks, getBlocksFragment,
  initDoc, readDocData,
} from "@uberblick/schema";
import { mountEditor, typeText } from "./helpers.js";
import { createUberblickEditor } from "../src/editor/create-editor.js";

const charts = vi.hoisted(() => ({ instances: [] as Array<{ data: unknown; options: unknown; updates: number; destroyed: boolean }> }));
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
});
afterEach(() => { vi.unstubAllGlobals(); });

describe("the chart's derived lifecycle", () => {
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

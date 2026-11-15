import { describe, expect, it } from "vitest";
import * as Y from "yjs";
import { applyDocData, prepareBar, prepareDot, readDocData } from "@uberblick/schema";
import type { BarReady, DotReady } from "@uberblick/schema";
import { barConfiguration, barDefaultHeight } from "../src/editor/bar-view.js";
import { dotConfiguration, dotDefaultHeight } from "../src/editor/dot-view.js";
import { categoryGroupValue, chartAccessibleDescription, chartAccessibleName } from "../src/editor/chart-data.js";

const colors = { color: "#334155", borderTopColor: "#ddd", fontFamily: "sans-serif", fontSize: "12px", lineHeight: "16px" } as CSSStyleDeclaration;
const palette = ["red", "blue", "green", "purple", "orange", "yellow", "pink", "cyan"];

function ready(type: "bar" | "dot", group: boolean, multiple = false, overflow = false): BarReady | DotReady {
  const doc = new Y.Doc();
  const directory = new Y.Doc();
  applyDocData(doc, directory, [{ collection: "options", schema: { version: 1, schema: { type: "object" } }, upsert: [
    { id: "a", value: { name: "First", score: 2, other: 4, kind: "Paid" } },
    { id: "b", value: { name: "Second", score: 3, other: 5, kind: "Open" } },
    { id: "c", value: { name: "Third", score: 4, other: 6, kind: "Paid" } },
    { id: "d", value: { name: "Absent", score: 5 } },
    { id: "e", value: { name: "Null", score: 6, kind: null } },
    ...(overflow ? Array.from({ length: 7 }, (_, i) => ({ id: `extra-${i}`, value: { name: "Extra", score: i, kind: i } })) : []),
  ] }]);
  const result = (type === "bar" ? prepareBar : prepareDot)(JSON.stringify({
    version: 1, type, collection: "options", category: { field: "name" }, y: [{ field: "score" }, ...(multiple ? [{ field: "other" }] : [])],
    ...(type === "bar" ? { orientation: "horizontal" } : {}), ...(group ? { group: "kind" } : {}),
  }), readDocData(doc));
  doc.destroy(); directory.destroy();
  if (result.status !== "ready") throw new Error(result.message);
  return result;
}

function configuration(result: BarReady | DotReady) {
  return result.config.type === "bar" ? barConfiguration(result as BarReady, colors, palette)
    : dotConfiguration(result as DotReady, colors, palette);
}

describe.each(["bar", "dot"] as const)("%s group presentation", type => {
  it("colours equal groups alike, uses neutral for absent/null, and names groups in palette order", () => {
    const result = ready(type, true);
    const chart = configuration(result);
    const dataset = chart.data.datasets[0]!;
    const background = dataset.backgroundColor as (context: { dataIndex: number }) => string;
    const border = dataset.borderColor as typeof background;
    expect([0, 1, 2, 3, 4].map(dataIndex => background({ dataIndex }))).toEqual(["blue", "red", "blue", colors.color, colors.color]);
    expect([0, 1, 2, 3, 4].map(dataIndex => border({ dataIndex }))).toEqual(["blue", "red", "blue", colors.color, colors.color]);
    const labels = chart.options?.plugins?.legend?.labels?.generateLabels as unknown as () => { text: string; fillStyle: string }[];
    expect(labels().map(({ text, fillStyle }) => [text, fillStyle])).toEqual([["Open", "red"], ["Paid", "blue"]]);
    expect(chartAccessibleDescription(result)).toContain("Groups by kind: Open; Paid.");
    expect(chartAccessibleName(result.config)).toBe(`${type === "bar" ? "Bar chart" : "Dot plot"} of score by name`);
    expect(type === "bar" ? barDefaultHeight(result as BarReady) : dotDefaultHeight(result as DotReady)).toBe(248);
  });

  it.each([false, true])("keeps series presentation with multiple=%s when grouping cannot colour the chart", multiple => {
    const result = ready(type, true, multiple, !multiple);
    const chart = configuration(result);
    const plainResult = { ...result, config: { ...result.config } } as BarReady | DotReady;
    delete plainResult.config.group;
    const plain = configuration(plainResult);
    expect(chart.data).toEqual(plain.data);
    expect(chart.options?.plugins?.legend?.labels).toEqual(plain.options?.plugins?.legend?.labels);
    expect(chartAccessibleDescription(result)).toBe(chartAccessibleDescription(plainResult));
    expect(categoryGroupValue(result, result.rows[0]!)).toEqual([{ label: "kind", value: "Paid" }]);
  });

  it("uses text-cell formatting in group details and omits absent/null values", () => {
    const result = ready(type, true);
    expect(categoryGroupValue(result, { ...result.rows[0]!, groupValue: { api: true } })).toEqual([{ label: "kind", value: '{"api":true}' }]);
    expect(categoryGroupValue(result, { ...result.rows[0]!, groupValue: "<b>Paid</b>" })).toEqual([{ label: "kind", value: "<b>Paid</b>" }]);
    expect(categoryGroupValue(result, result.rows[3]!)).toEqual([]);
    expect(categoryGroupValue(result, result.rows[4]!)).toEqual([]);
    expect(categoryGroupValue(ready(type, false), result.rows[0]!)).toEqual([]);
    const chart = configuration(result);
    const label = chart.options?.plugins?.tooltip?.callbacks?.label as unknown as (this: unknown, item: { dataIndex: number }) => string[];
    const context = { chart: { width: 600, ctx: { save() {}, restore() {}, measureText: (text: string) => ({ width: text.length * 6 }) } } };
    expect(label.call(context, { dataIndex: 0 })).toEqual(["kind: Paid", "score: 2"]);
    expect(label.call(context, { dataIndex: 3 })).toEqual(["score: 5"]);
    const longGroup = "Paid API with a descriptive group name";
    const long = configuration({ ...result, rows: [{ ...result.rows[0]!, groupValue: longGroup }] });
    const wrappedLabel = long.options?.plugins?.tooltip?.callbacks?.label as typeof label;
    const lines = wrappedLabel.call({ chart: { ...context.chart, width: 180 } }, { dataIndex: 0 });
    expect(lines.slice(0, -1).join("")).toBe(`kind: ${longGroup}`);
    expect(lines.every(line => line.length * 6 <= 148)).toBe(true);
    expect(lines.at(-1)).toBe("score: 2");
  });
});

import { chartViewType, parseJsonSource, parseScatterConfig } from "@uberblick/schema";
import { CHART_MAX_HEIGHT, CHART_MIN_HEIGHT, parseChartConfig } from "./chart-data.js";

export interface ChartHeightEdit {
  from: number;
  to: number;
  text: string;
}

/** Source offsets, descending so one transaction can apply them without remapping. */
export function chartHeightEdits(source: string, height: number | undefined): ChartHeightEdit[] | null {
  if (height !== undefined && (!Number.isInteger(height) || height < CHART_MIN_HEIGHT || height > CHART_MAX_HEIGHT)) return null;
  const config = chartViewType(source) === "scatter" ? parseScatterConfig(source) : parseChartConfig(source);
  if (!config.ok) return null;
  if (config.config.height === height) return [];
  const parsed = parseJsonSource(source);
  if (!parsed.ok || parsed.value.kind !== "object") return null;
  const { entries } = parsed.value;
  const starts = entries.map((entry, index) => source.indexOf(entry.rawKey, entries[index - 1]?.value.end ?? parsed.value.start + 1));
  const heights = entries.flatMap((entry, index) => entry.key === "height" ? [index] : []);
  const lastHeight = heights.at(-1);

  if (height !== undefined) {
    if (lastHeight !== undefined) {
      // Native JSON uses the last duplicate; earlier spellings remain untouched.
      const value = entries[lastHeight]?.value;
      if (value?.kind !== "number") return null;
      return [{ from: value.start, to: value.end, text: String(height) }];
    }
    const last = entries.at(-1);
    const previous = entries.at(-2);
    const lastStart = starts.at(-1);
    if (last === undefined || previous === undefined || lastStart === undefined) return null;
    const separator = source.slice(previous.value.end, lastStart);
    const colon = source.slice(lastStart + last.rawKey.length, last.value.start);
    return [{ from: last.value.end, to: last.value.end, text: `${separator}"height"${colon}${height}` }];
  }

  // Clear every duplicate so removing the effective value cannot resurrect one.
  const kept = entries.flatMap((entry, index) => entry.key === "height" ? [] : [index]);
  const keptCommas = new Set(kept.slice(0, -1));
  const edits: ChartHeightEdit[] = heights.map((index) => ({ from: starts[index] as number, to: entries[index]?.value.end as number, text: "" }));
  for (let index = 0; index < entries.length - 1; index += 1) {
    if (keptCommas.has(index)) continue;
    const comma = source.indexOf(",", entries[index]?.value.end);
    edits.push({ from: comma, to: comma + 1, text: "" });
  }
  return edits.sort((a, b) => b.from - a.from);
}

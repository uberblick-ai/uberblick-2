/** Category bars preserve one group per eligible record in a detached view. */
import { CHART_MAX_HEIGHT, CHART_MIN_HEIGHT } from "./chart-data.js";
import type { DocData } from "./data.js";
import { projectCategory } from "./category-data.js";
import type { CategoryDiagnostics, CategoryRow, CategorySeries } from "./category-data.js";
import type { ChartGroup } from "./chart-groups.js";
import { keys, name, numeric, object, optionalText } from "./view-data.js";

export interface BarSeriesMapping {
  field: string;
  label?: string;
  unit?: string;
  stack?: string;
  range?: [number, number];
  reference?: number;
}
export interface BarConfig {
  version: 1;
  type: "bar";
  collection: string;
  category: { field: string; label?: string };
  y: BarSeriesMapping[];
  group?: string;
  orientation: "vertical" | "horizontal";
  sort?: { field: string; direction: "asc" | "desc" };
  limit?: number;
  title?: string;
  height?: number;
}
export type BarRow = CategoryRow;
export type BarSeries = CategorySeries;
export type BarDiagnostics = CategoryDiagnostics;
export interface BarReady {
  status: "ready";
  config: BarConfig;
  rows: BarRow[];
  series: BarSeries[];
  groups: ChartGroup[];
  domain: [number, number];
  /** Divide stored values by this optional magnitude for finite drawing coordinates. */
  coordinateDivisor?: number;
  recordCount: number;
  eligibleCount: number;
  plottedCount: number;
  notPlotted: number;
  diagnostics: BarDiagnostics;
  warnings: string[];
  notice?: string;
}
export interface BarNoRecords extends Omit<BarReady, "status" | "domain"> {
  status: "no-records";
  message: string;
}
interface BarProblem {
  status: "invalid-configuration" | "collection-absent" | "collection-unusable" | "mapping-incompatible";
  message: string;
}
export type BarProjection = BarReady | BarNoRecords | BarProblem;

export function parseBarConfig(source: string):
  { ok: true; config: BarConfig } | { ok: false; message: string } {
  let value: unknown;
  try { value = JSON.parse(source); }
  catch { return { ok: false, message: "Invalid bar configuration: source must be JSON." }; }
  if (!object(value) || !keys(value, ["version", "type", "collection", "category", "y", "group", "orientation", "sort", "limit", "title", "height"]) ||
      value.version !== 1 || value.type !== "bar" || !name(value.collection) ||
      !object(value.category) || !keys(value.category, ["field", "label"]) ||
      !name(value.category.field) || !optionalText(value.category, "label") ||
      !Array.isArray(value.y) || value.y.length < 1 || value.y.length > 8 ||
      !value.y.every((series: unknown) => object(series) && keys(series, ["field", "label", "unit", "stack", "range", "reference"]) &&
        name(series.field) && optionalText(series, "label") && optionalText(series, "unit") && optionalText(series, "stack") &&
        (!Object.hasOwn(series, "range") || (Array.isArray(series.range) && series.range.length === 2 &&
          numeric(series.range[0]) && numeric(series.range[1]) && series.range[0] < series.range[1])) &&
        (!Object.hasOwn(series, "reference") || numeric(series.reference))) ||
      (Object.hasOwn(value, "group") && !name(value.group)) || !optionalText(value, "title") ||
      (Object.hasOwn(value, "orientation") && value.orientation !== "vertical" && value.orientation !== "horizontal") ||
      (Object.hasOwn(value, "limit") && (typeof value.limit !== "number" || !Number.isInteger(value.limit) || value.limit < 1)) ||
      (Object.hasOwn(value, "height") && (typeof value.height !== "number" || !Number.isInteger(value.height) ||
        value.height < CHART_MIN_HEIGHT || value.height > CHART_MAX_HEIGHT)) ||
      (Object.hasOwn(value, "sort") && (!object(value.sort) || !keys(value.sort, ["field", "direction"]) ||
        !name(value.sort.field) || (value.sort.direction !== "asc" && value.sort.direction !== "desc") ||
        (value.sort.field !== value.category.field &&
          !value.y.some((series: { field: string }) => series.field === (value.sort as { field: string }).field))))) {
    return { ok: false, message: "Invalid bar configuration: expected a version 1 bar mapping with one category field, one to eight numeric y series, optional vertical or horizontal orientation, sort by a mapped field, positive integer limit and whole-pixel height from 100 to 600; unknown keys are not supported." };
  }
  return { ok: true, config: { ...value, orientation: value.orientation ?? "vertical" } as BarConfig };
}

function valueDomain(rows: BarRow[], mappings: BarSeriesMapping[], divisor = 1): [number, number] {
  let lower = 0;
  let upper = 0;
  for (const mapping of mappings) {
    if (mapping.range !== undefined) {
      lower = Math.min(lower, mapping.range[0] / divisor);
      upper = Math.max(upper, mapping.range[1] / divisor);
    }
    if (mapping.reference !== undefined) {
      lower = Math.min(lower, mapping.reference / divisor);
      upper = Math.max(upper, mapping.reference / divisor);
    }
  }
  for (const row of rows) {
    const stacks = new Map<string, [number, number]>();
    mappings.forEach((mapping, index) => {
      const stored = row.values[index];
      if (stored === null || stored === undefined) return;
      const value = stored / divisor;
      const key = JSON.stringify(mapping.stack === undefined ? ["series", index] : ["stack", mapping.stack]);
      const extent = stacks.get(key) ?? [0, 0];
      if (value < 0) extent[0] += value;
      else extent[1] += value;
      stacks.set(key, extent);
    });
    for (const extent of stacks.values()) {
      lower = Math.min(lower, extent[0]);
      upper = Math.max(upper, extent[1]);
    }
  }
  return [lower, upper];
}

function drawingDomain(rows: BarRow[], mappings: BarSeriesMapping[]): { domain: [number, number]; coordinateDivisor?: number } {
  const domain = valueDomain(rows, mappings);
  // Leave a decimal order of headroom for the scale's tick rounding and span.
  if (Math.max(Math.abs(domain[0]), Math.abs(domain[1])) <= Number.MAX_VALUE / 10) return { domain };
  let magnitude = 0;
  for (const mapping of mappings) {
    for (const value of [...(mapping.range ?? []), ...(mapping.reference === undefined ? [] : [mapping.reference])]) {
      magnitude = Math.max(magnitude, Math.abs(value));
    }
  }
  for (const row of rows) {
    for (const value of row.values) magnitude = Math.max(magnitude, Math.abs(value ?? 0));
  }
  const coordinateDivisor = 10 ** Math.floor(Math.log10(magnitude));
  return { domain: valueDomain(rows, mappings, coordinateDivisor), coordinateDivisor };
}

function projectBar(config: BarConfig, data: DocData | null): BarProjection {
  const projection = projectCategory(config, data, "Bar");
  return projection.status === "ready"
    ? { ...projection, ...drawingDomain(projection.rows, config.y) } : projection;
}

export function prepareBar(source: string, data: DocData | null): BarProjection {
  const parsed = parseBarConfig(source);
  return parsed.ok ? projectBar(parsed.config, data) : { status: "invalid-configuration", message: parsed.message };
}

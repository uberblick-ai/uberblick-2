/** Dots share category rows while keeping their value axis free of a zero baseline. */
import { CHART_MAX_HEIGHT, CHART_MIN_HEIGHT } from "./chart-data.js";
import { projectCategory } from "./category-data.js";
import type { CategoryDiagnostics, CategoryRow, CategorySeries } from "./category-data.js";
import type { DocData } from "./data.js";
import { keys, name, numeric, object, optionalText } from "./view-data.js";

export interface DotSeriesMapping {
  field: string;
  label?: string;
  unit?: string;
  range?: [number, number];
  reference?: number;
}
export interface DotConfig {
  version: 1;
  type: "dot";
  collection: string;
  category: { field: string; label?: string };
  y: DotSeriesMapping[];
  connect?: boolean;
  note?: string;
  sort?: { field: string; direction: "asc" | "desc" };
  limit?: number;
  title?: string;
  height?: number;
}
export interface DotRow extends CategoryRow { note?: string }
export type DotSeries = Omit<CategorySeries, "stack">;
export type DotDiagnostics = CategoryDiagnostics;
export interface DotReady {
  status: "ready";
  config: DotConfig;
  rows: DotRow[];
  series: DotSeries[];
  domain: [number, number];
  /** Divide stored values by this optional magnitude for finite drawing coordinates. */
  coordinateDivisor?: number;
  recordCount: number;
  eligibleCount: number;
  plottedCount: number;
  notPlotted: number;
  diagnostics: DotDiagnostics;
  warnings: string[];
  notice?: string;
}
export interface DotNoRecords extends Omit<DotReady, "status" | "domain"> {
  status: "no-records";
  message: string;
}
interface DotProblem {
  status: "invalid-configuration" | "collection-absent" | "collection-unusable" | "mapping-incompatible";
  message: string;
}
export type DotProjection = DotReady | DotNoRecords | DotProblem;

export function parseDotConfig(source: string):
  { ok: true; config: DotConfig } | { ok: false; message: string } {
  let value: unknown;
  try { value = JSON.parse(source); }
  catch { return { ok: false, message: "Invalid dot configuration: source must be JSON." }; }
  if (!object(value) || !keys(value, ["version", "type", "collection", "category", "y", "connect", "note", "sort", "limit", "title", "height"]) ||
      value.version !== 1 || value.type !== "dot" || !name(value.collection) ||
      !object(value.category) || !keys(value.category, ["field", "label"]) ||
      !name(value.category.field) || !optionalText(value.category, "label") ||
      !Array.isArray(value.y) || value.y.length < 1 || value.y.length > 2 ||
      !value.y.every((series: unknown) => object(series) && keys(series, ["field", "label", "unit", "range", "reference"]) &&
        name(series.field) && optionalText(series, "label") && optionalText(series, "unit") &&
        (!Object.hasOwn(series, "range") || (Array.isArray(series.range) && series.range.length === 2 &&
          numeric(series.range[0]) && numeric(series.range[1]) && series.range[0] < series.range[1])) &&
        (!Object.hasOwn(series, "reference") || numeric(series.reference))) ||
      (Object.hasOwn(value, "connect") && (typeof value.connect !== "boolean" || (value.connect && value.y.length !== 2))) ||
      (Object.hasOwn(value, "note") && !name(value.note)) || !optionalText(value, "title") ||
      (Object.hasOwn(value, "limit") && (typeof value.limit !== "number" || !Number.isInteger(value.limit) || value.limit < 1)) ||
      (Object.hasOwn(value, "height") && (typeof value.height !== "number" || !Number.isInteger(value.height) ||
        value.height < CHART_MIN_HEIGHT || value.height > CHART_MAX_HEIGHT)) ||
      (Object.hasOwn(value, "sort") && (!object(value.sort) || !keys(value.sort, ["field", "direction"]) ||
        !name(value.sort.field) || (value.sort.direction !== "asc" && value.sort.direction !== "desc") ||
        (value.sort.field !== value.category.field &&
          !value.y.some((series: { field: string }) => series.field === (value.sort as { field: string }).field))))) {
    return { ok: false, message: "Invalid dot configuration: expected a version 1 dot mapping with one category field, one or two numeric y series, optional connect with exactly two series, note field, sort by a mapped field, positive integer limit and whole-pixel height from 100 to 600; unknown keys are not supported." };
  }
  return { ok: true, config: value as unknown as DotConfig };
}

function drawingDomain(rows: DotRow[], mappings: DotSeriesMapping[]): { domain: [number, number]; coordinateDivisor?: number } {
  let lower = Infinity;
  let upper = -Infinity;
  const include = (value: number) => { lower = Math.min(lower, value); upper = Math.max(upper, value); };
  for (const mapping of mappings) {
    if (mapping.range !== undefined) { include(mapping.range[0]); include(mapping.range[1]); }
    if (mapping.reference !== undefined) include(mapping.reference);
  }
  for (const row of rows) for (const value of row.values) if (value !== null) include(value);
  // Keep tick rounding and singleton expansion away from overflow and underflow.
  const magnitude = Math.max(Math.abs(lower), Math.abs(upper));
  if (magnitude === 0 || (magnitude >= 1e-14 && magnitude <= Number.MAX_VALUE / 10)) return { domain: [lower, upper] };
  const coordinateDivisor = 10 ** Math.max(-300, Math.floor(Math.log10(magnitude)));
  return { domain: [lower / coordinateDivisor, upper / coordinateDivisor], coordinateDivisor };
}

export function prepareDot(source: string, data: DocData | null): DotProjection {
  const parsed = parseDotConfig(source);
  if (!parsed.ok) return { status: "invalid-configuration", message: parsed.message };
  const projection = projectCategory(parsed.config, data, "Dot", parsed.config.note);
  return projection.status === "ready"
    ? { ...projection, ...drawingDomain(projection.rows, parsed.config.y) } : projection;
}

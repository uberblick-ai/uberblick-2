/** Category bars preserve one group per eligible record in a detached view. */
import { CHART_MAX_HEIGHT, CHART_MIN_HEIGHT, CHART_RECORD_LIMIT } from "./chart-data.js";
import { compareCodePoints } from "./data-schema.js";
import type { DataRecord, DocData } from "./data.js";
import { sortTableRows } from "./table-data.js";
import { bindCollection, incompatible, keys, name, numeric, object, optionalText, own } from "./view-data.js";

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
  orientation: "vertical" | "horizontal";
  sort?: { field: string; direction: "asc" | "desc" };
  limit?: number;
  title?: string;
  height?: number;
}
export interface BarRow { id: string; label: string; values: (number | null)[] }
export interface BarSeries { field: string; label: string; unit?: string; stack?: string }
export interface BarDiagnostics {
  invalidSchema: number;
  missingCategory: number;
  noNumericY: number;
  limited: number;
  series: { field: string; label: string; absent: number; null: number; missing: number; invalid: number }[];
}
export interface BarReady {
  status: "ready";
  config: BarConfig;
  rows: BarRow[];
  series: BarSeries[];
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
  if (!object(value) || !keys(value, ["version", "type", "collection", "category", "y", "orientation", "sort", "limit", "title", "height"]) ||
      value.version !== 1 || value.type !== "bar" || !name(value.collection) ||
      !object(value.category) || !keys(value.category, ["field", "label"]) ||
      !name(value.category.field) || !optionalText(value.category, "label") ||
      !Array.isArray(value.y) || value.y.length < 1 || value.y.length > 8 ||
      !value.y.every((series: unknown) => object(series) && keys(series, ["field", "label", "unit", "stack", "range", "reference"]) &&
        name(series.field) && optionalText(series, "label") && optionalText(series, "unit") && optionalText(series, "stack") &&
        (!Object.hasOwn(series, "range") || (Array.isArray(series.range) && series.range.length === 2 &&
          numeric(series.range[0]) && numeric(series.range[1]) && series.range[0] < series.range[1])) &&
        (!Object.hasOwn(series, "reference") || numeric(series.reference))) ||
      !optionalText(value, "title") ||
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
  const binding = bindCollection(data, config.collection, "Chart");
  if (binding.status !== "ready") return binding;
  const { collection, schema } = binding;
  const badField = incompatible(schema, config.category.field, "text") ? config.category.field
    : config.y.find((series) => incompatible(schema, series.field, "number"))?.field;
  if (badField !== undefined) return {
    status: "mapping-incompatible",
    message: `Bar mapping is incompatible with the schema: field “${badField}” is missing or has an incompatible type.`,
  };
  const series: BarSeries[] = config.y.map((mapping) => ({
    field: mapping.field, label: mapping.label || mapping.field,
    ...(mapping.unit !== undefined ? { unit: mapping.unit } : {}),
    ...(mapping.stack !== undefined ? { stack: mapping.stack } : {}),
  }));
  const diagnostics: BarDiagnostics = {
    invalidSchema: 0, missingCategory: 0, noNumericY: 0, limited: 0,
    series: series.map((mapping) => ({ field: mapping.field, label: mapping.label, absent: 0, null: 0, missing: 0, invalid: 0 })),
  };
  const invalid = new Set(collection.invalidRecordIds);
  let eligible: DataRecord[] = [];
  for (const record of collection.records) {
    if (invalid.has(record.id) || !object(record.value)) { diagnostics.invalidSchema += 1; continue; }
    const category = own(record.value, config.category.field);
    if (category === undefined || category === null) { diagnostics.missingCategory += 1; continue; }
    eligible.push(record as DataRecord);
  }
  if (config.sort === undefined) eligible.sort((a, b) => compareCodePoints(a.id, b.id));
  else eligible = sortTableRows(eligible, {
    field: config.sort.field, format: config.sort.field === config.category.field ? "text" : "number",
  }, config.sort.direction);
  const limit = Math.min(config.limit ?? CHART_RECORD_LIMIT, CHART_RECORD_LIMIT);
  const excluded = Math.max(0, eligible.length - limit);
  const authorWindow = config.limit !== undefined && config.limit <= CHART_RECORD_LIMIT;
  diagnostics.limited = authorWindow ? 0 : excluded;
  const rows: BarRow[] = eligible.slice(0, limit).map((record) => {
    const category = own(record.value, config.category.field);
    const values = config.y.map((mapping, index) => {
      const value = own(record.value, mapping.field);
      if (numeric(value)) return value;
      const count = diagnostics.series[index];
      if (count !== undefined) {
        if (value === undefined) { count.absent += 1; count.missing += 1; }
        else if (value === null) { count.null += 1; count.missing += 1; }
        else count.invalid += 1;
      }
      return null;
    });
    if (!values.some(numeric)) diagnostics.noNumericY += 1;
    return { id: record.id, label: typeof category === "string" ? category : JSON.stringify(category), values };
  });
  const plottedCount = rows.length - diagnostics.noNumericY;
  const emptyFields = new Set(config.y.filter((_, index) => !rows.some((row) => numeric(row.values[index]))).map((mapping) => mapping.field));
  const common = {
    config, rows, series, recordCount: collection.records.length, eligibleCount: eligible.length, plottedCount,
    notPlotted: collection.records.length - plottedCount - (authorWindow ? excluded : 0), diagnostics,
    warnings: [...emptyFields].map((field) => `No numeric values for series field “${field}”.`),
    ...(excluded > 0 ? { notice: `Showing ${limit === CHART_RECORD_LIMIT ? "5,000" : limit} of ${eligible.length} records` } : {}),
  };
  if (plottedCount === 0) return { status: "no-records", message: "No plottable records in this chart collection.", ...common };
  return { status: "ready", ...common, ...drawingDomain(rows, config.y) };
}

export function prepareBar(source: string, data: DocData | null): BarProjection {
  const parsed = parseBarConfig(source);
  return parsed.ok ? projectBar(parsed.config, data) : { status: "invalid-configuration", message: parsed.message };
}

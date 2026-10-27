/** A chart derives a bounded view from the shared reader; it never repairs data. */
import { compareCodePoints } from "./data-schema.js";
import type { DocData } from "./data.js";
import type { JSONObject } from "./data-schema.js";
import { bindCollection, incompatible, keys, name, numeric, object, optionalText, own } from "./view-data.js";

export const CHART_RECORD_LIMIT = 5_000;
export const CHART_MIN_HEIGHT = 100;
export const CHART_MAX_HEIGHT = 600;

export interface ChartSeriesMapping {
  field: string;
  label?: string;
  unit?: string;
  type?: "line" | "bar";
  range?: [number, number];
  reference?: number;
}
export interface ChartConfig {
  version: 1;
  type: "line";
  collection: string;
  x: { field: string; type: "number" | "date"; label?: string };
  y: ChartSeriesMapping[];
  title?: string;
  limit?: number;
  layout?: "overlay" | "panels";
  height?: number;
  missing: "gap" | "connect";
}
interface ChartPoint { x: number; y: number | null; id: string }
export interface ChartSeries { field: string; label: string; unit?: string; type: "line" | "bar"; points: ChartPoint[] }
interface ChartDiagnostics {
  invalidSchema: number;
  missingX: number;
  invalidX: number;
  noNumericY: number;
  /** Older records having a numeric y; missing-only rows are counted above. */
  limited: number;
  series: { label: string; missing: number; invalid: number }[];
}
export interface ChartReady {
  status: "ready";
  config: ChartConfig;
  series: ChartSeries[];
  recordCount: number;
  eligibleCount: number;
  plottedCount: number;
  firstX: number;
  lastX: number;
  notPlotted: number;
  diagnostics: ChartDiagnostics;
  notice?: string;
}
export interface ChartNoRecords extends Omit<ChartReady, "status" | "firstX" | "lastX"> {
  status: "no-records";
  message: string;
}
interface ChartProblem {
  status: "invalid-configuration" | "collection-absent" | "collection-unusable" | "mapping-incompatible";
  message: string;
  diagnostics?: ChartDiagnostics;
  notPlotted?: number;
  notice?: string;
}
export type ChartProjection = ChartReady | ChartNoRecords | ChartProblem;

export function parseChartConfig(source: string):
  { ok: true; config: ChartConfig } | { ok: false; message: string } {
  let value: unknown;
  try { value = JSON.parse(source); }
  catch { return { ok: false, message: "Invalid chart configuration: source must be JSON." }; }
  if (!object(value) || !keys(value, ["version", "type", "collection", "x", "y", "title", "missing", "limit", "layout", "height"]) ||
      value.version !== 1 || value.type !== "line" || !name(value.collection) ||
      !object(value.x) || !keys(value.x, ["field", "type", "label"]) ||
      !name(value.x.field) || (value.x.type !== "number" && value.x.type !== "date") ||
      !optionalText(value.x, "label") || !Array.isArray(value.y) || value.y.length < 1 || value.y.length > 8 ||
      !value.y.every((series: unknown) => object(series) && keys(series, ["field", "label", "unit", "type", "range", "reference"]) &&
        name(series.field) && optionalText(series, "label") && optionalText(series, "unit") &&
        (!Object.hasOwn(series, "type") || series.type === "line" || series.type === "bar") &&
        (!Object.hasOwn(series, "range") || (Array.isArray(series.range) && series.range.length === 2 &&
          numeric(series.range[0]) && numeric(series.range[1]) && series.range[0] < series.range[1])) &&
        (!Object.hasOwn(series, "reference") || numeric(series.reference))) ||
      !optionalText(value, "title") ||
      (Object.hasOwn(value, "limit") && (typeof value.limit !== "number" || !Number.isInteger(value.limit) || value.limit < 1)) ||
      (Object.hasOwn(value, "layout") && value.layout !== "overlay" && value.layout !== "panels") ||
      (Object.hasOwn(value, "height") && (typeof value.height !== "number" || !Number.isInteger(value.height) ||
        value.height < CHART_MIN_HEIGHT || value.height > CHART_MAX_HEIGHT)) ||
      (Object.hasOwn(value, "missing") && value.missing !== "gap" && value.missing !== "connect")) {
    return { ok: false, message: "Invalid chart configuration: expected a version 1 line mapping with one x field, one to eight y series, optional positive integer limit and optional whole-pixel height from 100 to 600; unknown keys are not supported." };
  }
  // Defaulting is a detached view value, never a write to the source block.
  return { ok: true, config: {
    ...value,
    y: value.y.map((series) => ({ ...series, type: series.type ?? "line" })),
    missing: value.missing ?? "gap", layout: value.layout ?? "overlay",
  } as ChartConfig };
}

// RFC 3339's complete-date/date-time grammar, with an explicit timezone. Native
// Date parsing alone accepts nonstandard strings and normalizes impossible days.
const DATE = /^(\d{4})-(\d{2})-(\d{2})(?:[Tt](\d{2}):(\d{2}):(\d{2})(?:\.(\d+))?([Zz]|[+-]\d{2}:\d{2}))?$/;
// UTC leap-second boundaries; keep the authoritative IERS list:
// https://hpiers.obspm.fr/iers/bul/bulc/Leap_Second.dat
const LEAP_SECOND_BOUNDARIES = new Set([
  "1972-07-01", "1973-01-01", "1974-01-01", "1975-01-01", "1976-01-01", "1977-01-01", "1978-01-01",
  "1979-01-01", "1980-01-01", "1981-07-01", "1982-07-01", "1983-07-01", "1985-07-01", "1988-01-01",
  "1990-01-01", "1991-01-01", "1992-07-01", "1993-07-01", "1994-07-01", "1996-01-01", "1997-07-01",
  "1999-01-01", "2006-01-01", "2009-01-01", "2012-07-01", "2015-07-01", "2017-01-01",
]);

/** ISO date-only values are UTC days; RFC 3339 offsets identify the same instant. */
export function chartDate(value: unknown): number | null {
  if (typeof value !== "string") return null;
  const match = DATE.exec(value);
  if (match === null) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const instant = new Date(0);
  // setUTCFullYear handles 0000..0099 without Date.UTC's 1900 offset.
  instant.setUTCFullYear(year, month - 1, day);
  if (instant.getUTCFullYear() !== year || instant.getUTCMonth() !== month - 1 || instant.getUTCDate() !== day) return null;
  if (match[4] === undefined) return instant.getTime();
  const hour = Number(match[4]);
  const minute = Number(match[5]);
  const second = Number(match[6]);
  const fraction = match[7] === undefined ? 0 : Number(`0.${match[7]}`) * 1_000;
  const zone = match[8] ?? "";
  const offsetHours = /^[Zz]$/.test(zone) ? 0 : Number(zone.slice(1, 3));
  const offsetMinutes = /^[Zz]$/.test(zone) ? 0 : Number(zone.slice(4, 6));
  if (hour > 23 || minute > 59 || second > 60 || offsetHours > 23 || offsetMinutes > 59) return null;
  const offset = (offsetHours * 60 + offsetMinutes) * 60_000 * (zone.startsWith("-") ? -1 : 1);
  const result = instant.getTime() + hour * 3_600_000 + minute * 60_000 + second * 1_000 + fraction - offset;
  if (second === 60) {
    // Unix milliseconds cannot represent a leap second separately. It occupies
    // the following instant; keep both records if another observation ties it.
    // RFC 3339 permits :60 only when a leap second occurred, with shifted offsets.
    const next = new Date(result - fraction);
    if (!LEAP_SECOND_BOUNDARIES.has(next.toISOString().slice(0, 10)) ||
        next.getUTCHours() !== 0 || next.getUTCMinutes() !== 0 || next.getUTCSeconds() !== 0) return null;
  }
  return result;
}

function projectChart(config: ChartConfig, data: DocData | null): ChartProjection {
  const binding = bindCollection(data, config.collection, "Chart");
  if (binding.status !== "ready") return binding;
  const { collection, schema } = binding;
  const badField = incompatible(schema, config.x.field, config.x.type) ? config.x.field
    : config.y.find((series) => incompatible(schema, series.field, "number"))?.field;
  if (badField !== undefined) return { status: "mapping-incompatible", message: `Chart mapping is incompatible with the schema: field “${badField}” is missing or has an incompatible type.` };

  const diagnostics: ChartDiagnostics = {
    invalidSchema: 0, missingX: 0, invalidX: 0, noNumericY: 0, limited: 0,
    series: config.y.map((series) => ({ label: series.label || series.field, missing: 0, invalid: 0 })),
  };
  const invalid = new Set(collection.invalidRecordIds);
  const rows: { id: string; x: number; values: unknown[]; hasY: boolean }[] = [];
  for (const record of collection.records) {
    if (invalid.has(record.id) || !object(record.value)) { diagnostics.invalidSchema += 1; continue; }
    const rawX = own(record.value as JSONObject, config.x.field);
    if (rawX === undefined || rawX === null) { diagnostics.missingX += 1; continue; }
    const x = config.x.type === "number" ? (numeric(rawX) ? rawX : null) : chartDate(rawX);
    if (x === null) { diagnostics.invalidX += 1; continue; }
    const values = config.y.map((series) => own(record.value as JSONObject, series.field));
    const hasY = values.some(numeric);
    rows.push({ id: record.id, x, values, hasY });
  }
  rows.sort((a, b) => a.x - b.x || compareCodePoints(a.id, b.id));
  const limit = Math.min(config.limit ?? CHART_RECORD_LIMIT, CHART_RECORD_LIMIT);
  // Larger author limits retain the system cap's notice and omission diagnostics.
  const authorWindow = config.limit !== undefined && config.limit <= CHART_RECORD_LIMIT;
  const excluded = Math.max(0, rows.length - limit);
  const selected = rows.slice(excluded);
  diagnostics.noNumericY = (authorWindow ? selected : rows).filter((row) => !row.hasY).length;
  diagnostics.limited = authorWindow ? 0 : rows.slice(0, excluded).filter((row) => row.hasY).length;
  const series: ChartSeries[] = config.y.map((mapping, index) => ({
    field: mapping.field,
    label: mapping.label || mapping.field,
    type: mapping.type ?? "line",
    ...(mapping.unit !== undefined ? { unit: mapping.unit } : {}),
    points: selected.flatMap((row): ChartPoint[] => {
      const value = row.values[index];
      if (numeric(value)) return [{ x: row.x, y: value, id: row.id }];
      const count = diagnostics.series[index];
      if (value === undefined || value === null) {
        if (count !== undefined) count.missing += 1;
        return mapping.type !== "bar" && config.missing === "connect" ? [] : [{ x: row.x, y: null, id: row.id }];
      }
      if (count !== undefined) count.invalid += 1;
      // Wrong types never become zero or a bridge authorized only for absence.
      return [{ x: row.x, y: null, id: row.id }];
    }),
  }));
  const plotted = selected.filter((row) => row.hasY);
  const notice = excluded > 0 ? { notice: `Showing the latest ${limit === CHART_RECORD_LIMIT ? "5,000" : limit} of ${rows.length} records` } : {};
  const notPlotted = collection.records.length - plotted.length - (authorWindow ? excluded : 0);
  const first = plotted[0];
  const last = plotted[plotted.length - 1];
  if (first === undefined || last === undefined) return {
    status: "no-records", message: "No plottable records in this chart collection.",
    config, series, recordCount: collection.records.length, eligibleCount: rows.length,
    plottedCount: 0, diagnostics, notPlotted, ...notice,
  };
  return {
    status: "ready", config, series, recordCount: collection.records.length, eligibleCount: rows.length,
    plottedCount: plotted.length, firstX: first.x, lastX: last.x, notPlotted, diagnostics, ...notice,
  };
}

export function prepareChart(source: string, data: DocData | null): ChartProjection {
  const parsed = parseChartConfig(source);
  return parsed.ok ? projectChart(parsed.config, data) : { status: "invalid-configuration", message: parsed.message };
}

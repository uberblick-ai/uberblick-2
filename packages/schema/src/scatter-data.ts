/** Scatter points retain record identity and only show stored numeric values. */
import { CHART_MAX_HEIGHT, CHART_MIN_HEIGHT, CHART_RECORD_LIMIT } from "./chart-data.js";
import { canonicalJson, compareCodePoints } from "./data-schema.js";
import type { JSONValue } from "./data-schema.js";
import type { DataRecord, DocData } from "./data.js";
import { tableColumn } from "./table-data.js";
import type { TableColumnMapping } from "./table-data.js";
import { bindCollection, incompatible, keys, name, numeric, object, optionalText, own } from "./view-data.js";

export interface ScatterAxisMapping {
  field: string;
  label?: string;
  unit?: string;
  range?: [number, number];
  lower?: string;
  upper?: string;
}
export interface ScatterConfig {
  version: 1;
  type: "scatter";
  collection: string;
  x: ScatterAxisMapping;
  y: ScatterAxisMapping;
  label: string;
  group?: string;
  details: TableColumnMapping[];
  title?: string;
  height?: number;
}
export interface ScatterPoint {
  id: string;
  record: DataRecord;
  x: number;
  y: number;
  xLower?: number;
  xUpper?: number;
  yLower?: number;
  yUpper?: number;
  groupKey?: string;
}
export interface ScatterAxisDiagnostics {
  absent: number;
  null: number;
  invalid: number;
  bounds: {
    lower: { invalid: number; wrongSide: number };
    upper: { invalid: number; wrongSide: number };
  };
}
export interface ScatterDiagnostics {
  invalidSchema: number;
  axes: { x: ScatterAxisDiagnostics; y: ScatterAxisDiagnostics };
  limited: number;
  groupOverflow: boolean;
}
export interface ScatterReady {
  status: "ready";
  config: ScatterConfig;
  points: ScatterPoint[];
  groups: { key: string; value: JSONValue }[];
  domain: { x: [number, number]; y: [number, number] };
  recordCount: number;
  eligibleCount: number;
  plottedCount: number;
  notPlotted: number;
  diagnostics: ScatterDiagnostics;
  warnings: string[];
  notice?: string;
}
export interface ScatterNoRecords extends Omit<ScatterReady, "status" | "domain"> {
  status: "no-records";
  message: string;
}
interface ScatterProblem {
  status: "invalid-configuration" | "collection-absent" | "collection-unusable" | "mapping-incompatible";
  message: string;
}
export type ScatterProjection = ScatterReady | ScatterNoRecords | ScatterProblem;

function axis(value: unknown): boolean {
  return object(value) && keys(value, ["field", "label", "unit", "range", "lower", "upper"]) &&
    name(value.field) && optionalText(value, "label") && optionalText(value, "unit") &&
    (!Object.hasOwn(value, "lower") || name(value.lower)) &&
    (!Object.hasOwn(value, "upper") || name(value.upper)) &&
    (!Object.hasOwn(value, "range") || (Array.isArray(value.range) && value.range.length === 2 &&
      numeric(value.range[0]) && numeric(value.range[1]) && value.range[0] < value.range[1]));
}

export function parseScatterConfig(source: string):
  { ok: true; config: ScatterConfig } | { ok: false; message: string } {
  let value: unknown;
  try { value = JSON.parse(source); }
  catch { return { ok: false, message: "Invalid scatter configuration: source must be JSON." }; }
  if (!object(value) || !keys(value, ["version", "type", "collection", "x", "y", "label", "group", "details", "title", "height"]) ||
      value.version !== 1 || value.type !== "scatter" || !name(value.collection) ||
      !axis(value.x) || !axis(value.y) || !name(value.label) ||
      (Object.hasOwn(value, "group") && !name(value.group)) ||
      (Object.hasOwn(value, "details") && (!Array.isArray(value.details) || value.details.length > 8 || !value.details.every(tableColumn))) ||
      !optionalText(value, "title") ||
      (Object.hasOwn(value, "height") && (typeof value.height !== "number" || !Number.isInteger(value.height) ||
        value.height < CHART_MIN_HEIGHT || value.height > CHART_MAX_HEIGHT))) {
    return { ok: false, message: "Invalid scatter configuration: expected a version 1 scatter mapping with numeric x and y fields, a label field, at most eight details and optional whole-pixel height from 100 to 600; unknown keys are not supported." };
  }
  return { ok: true, config: {
    ...value,
    details: (value.details as Record<string, unknown>[] | undefined)?.map((entry) => ({ ...entry, format: entry.format ?? "text" })) ?? [],
  } as ScatterConfig };
}

function axisDiagnostics(): ScatterAxisDiagnostics {
  return { absent: 0, null: 0, invalid: 0, bounds: { lower: { invalid: 0, wrongSide: 0 }, upper: { invalid: 0, wrongSide: 0 } } };
}

function coordinate(value: unknown, diagnostics: ScatterAxisDiagnostics): number | undefined {
  if (value === undefined) diagnostics.absent += 1;
  else if (value === null) diagnostics.null += 1;
  else if (!numeric(value)) diagnostics.invalid += 1;
  else return value;
  return undefined;
}

function bound(record: DataRecord, mapping: ScatterAxisMapping, side: "lower" | "upper", value: number,
  diagnostics: ScatterAxisDiagnostics): number | undefined {
  const field = mapping[side];
  if (field === undefined) return undefined;
  const stored = own(record.value, field);
  if (stored === undefined || stored === null) return undefined;
  if (!numeric(stored)) diagnostics.bounds[side].invalid += 1;
  else if (side === "lower" ? stored > value : stored < value) diagnostics.bounds[side].wrongSide += 1;
  else return stored;
  return undefined;
}

function domain(points: ScatterPoint[], dimension: "x" | "y", mapping: ScatterAxisMapping): [number, number] {
  let lower = mapping.range?.[0] ?? Infinity;
  let upper = mapping.range?.[1] ?? -Infinity;
  for (const point of points) {
    lower = Math.min(lower, point[dimension], point[dimension === "x" ? "xLower" : "yLower"] ?? Infinity);
    upper = Math.max(upper, point[dimension], point[dimension === "x" ? "xUpper" : "yUpper"] ?? -Infinity);
  }
  return [lower, upper];
}

function projectScatter(config: ScatterConfig, data: DocData | null): ScatterProjection {
  const binding = bindCollection(data, config.collection, "Chart");
  if (binding.status !== "ready") return binding;
  const { collection, schema } = binding;
  const mappings: { field: string; format: "number" | "text" | "date" | "link" }[] = [
    { field: config.x.field, format: "number" }, { field: config.y.field, format: "number" },
    { field: config.label, format: "text" }, ...config.details,
  ];
  if (config.group !== undefined) mappings.push({ field: config.group, format: "text" });
  for (const mapping of [config.x, config.y]) {
    if (mapping.lower !== undefined) mappings.push({ field: mapping.lower, format: "number" });
    if (mapping.upper !== undefined) mappings.push({ field: mapping.upper, format: "number" });
  }
  const badField = mappings.find((mapping) => incompatible(schema, mapping.field, mapping.format))?.field;
  if (badField !== undefined) return {
    status: "mapping-incompatible",
    message: `Scatter mapping is incompatible with the schema: field “${badField}” is missing or has an incompatible type.`,
  };

  const diagnostics: ScatterDiagnostics = {
    invalidSchema: 0, axes: { x: axisDiagnostics(), y: axisDiagnostics() }, limited: 0, groupOverflow: false,
  };
  const invalid = new Set(collection.invalidRecordIds);
  const eligible: ScatterPoint[] = [];
  for (const record of collection.records) {
    if (invalid.has(record.id) || !object(record.value)) { diagnostics.invalidSchema += 1; continue; }
    const x = coordinate(own(record.value, config.x.field), diagnostics.axes.x);
    const y = coordinate(own(record.value, config.y.field), diagnostics.axes.y);
    if (x === undefined || y === undefined) continue;
    eligible.push({ id: record.id, record: record as DataRecord, x, y });
  }
  eligible.sort((a, b) => compareCodePoints(a.id, b.id));
  const points = eligible.slice(0, CHART_RECORD_LIMIT);
  const groupValues = new Map<string, JSONValue>();
  for (const point of points) {
    const { record, x, y } = point;
    const xLower = bound(record, config.x, "lower", x, diagnostics.axes.x);
    const xUpper = bound(record, config.x, "upper", x, diagnostics.axes.x);
    const yLower = bound(record, config.y, "lower", y, diagnostics.axes.y);
    const yUpper = bound(record, config.y, "upper", y, diagnostics.axes.y);
    if (xLower !== undefined) point.xLower = xLower;
    if (xUpper !== undefined) point.xUpper = xUpper;
    if (yLower !== undefined) point.yLower = yLower;
    if (yUpper !== undefined) point.yUpper = yUpper;
    const groupValue = config.group === undefined ? undefined : own(record.value, config.group);
    if (groupValue !== undefined && groupValue !== null) {
      point.groupKey = canonicalJson(groupValue);
      groupValues.set(point.groupKey, groupValue as JSONValue);
    }
  }
  diagnostics.limited = eligible.length - points.length;
  diagnostics.groupOverflow = groupValues.size > 8;
  const warnings = diagnostics.groupOverflow
    ? [`Scatter group field “${config.group}” has more than 8 values; all points use a neutral style.`] : [];
  const groups = diagnostics.groupOverflow ? [] : [...groupValues.entries()]
    .sort(([a], [b]) => compareCodePoints(a, b)).map(([key, value]) => ({ key, value }));
  const common = {
    config, points, groups, recordCount: collection.records.length, eligibleCount: eligible.length,
    plottedCount: points.length, notPlotted: collection.records.length - points.length, diagnostics, warnings,
    ...(diagnostics.limited > 0 ? { notice: `Showing 5,000 of ${eligible.length} records` } : {}),
  };
  if (points.length === 0) return { status: "no-records", message: "No plottable records in this scatter collection.", ...common };
  return { status: "ready", ...common, domain: { x: domain(points, "x", config.x), y: domain(points, "y", config.y) } };
}

export function prepareScatter(source: string, data: DocData | null): ScatterProjection {
  const parsed = parseScatterConfig(source);
  return parsed.ok ? projectScatter(parsed.config, data) : { status: "invalid-configuration", message: parsed.message };
}

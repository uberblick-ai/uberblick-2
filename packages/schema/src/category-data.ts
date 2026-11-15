/** Category charts share record eligibility, row windows and value diagnostics. */
import { CHART_RECORD_LIMIT } from "./chart-data.js";
import { compareCodePoints } from "./data-schema.js";
import type { DataRecord, DocData } from "./data.js";
import { sortTableRows } from "./table-data.js";
import { bindCollection, incompatible, numeric, object, own } from "./view-data.js";

interface CategoryConfig {
  collection: string;
  category: { field: string; label?: string };
  y: { field: string; label?: string; unit?: string; stack?: string }[];
  sort?: { field: string; direction: "asc" | "desc" };
  limit?: number;
}
export interface CategoryRow { id: string; label: string; values: (number | null)[] }
export interface CategorySeries { field: string; label: string; unit?: string; stack?: string }
export interface CategoryDiagnostics {
  invalidSchema: number;
  missingCategory: number;
  noNumericY: number;
  limited: number;
  series: { field: string; label: string; absent: number; null: number; missing: number; invalid: number }[];
}

export function projectCategory<C extends CategoryConfig>(config: C, data: DocData | null, label: "Bar" | "Dot", note?: string) {
  const binding = bindCollection(data, config.collection, "Chart");
  if (binding.status !== "ready") return binding;
  const { collection, schema } = binding;
  const badField = incompatible(schema, config.category.field, "text") ? config.category.field
    : config.y.find((series) => incompatible(schema, series.field, "number"))?.field
      ?? (note !== undefined && incompatible(schema, note, "text") ? note : undefined);
  if (badField !== undefined) return {
    status: "mapping-incompatible" as const,
    message: `${label} mapping is incompatible with the schema: field “${badField}” is missing or has an incompatible type.`,
  };
  const series: CategorySeries[] = config.y.map((mapping) => ({
    field: mapping.field, label: mapping.label || mapping.field,
    ...(mapping.unit !== undefined ? { unit: mapping.unit } : {}),
    ...(mapping.stack !== undefined ? { stack: mapping.stack } : {}),
  }));
  const diagnostics: CategoryDiagnostics = {
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
  const rows = eligible.slice(0, limit).map((record): CategoryRow & { note?: string } => {
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
    const storedNote = note === undefined ? undefined : own(record.value, note);
    return {
      id: record.id, label: typeof category === "string" ? category : JSON.stringify(category), values,
      ...(storedNote === undefined || storedNote === null ? {} : {
        note: typeof storedNote === "string" ? storedNote : JSON.stringify(storedNote),
      }),
    };
  });
  const plottedCount = rows.length - diagnostics.noNumericY;
  const emptyFields = new Set(config.y.filter((_, index) => !rows.some((row) => numeric(row.values[index]))).map((mapping) => mapping.field));
  const common = {
    config, rows, series, recordCount: collection.records.length, eligibleCount: eligible.length, plottedCount,
    notPlotted: collection.records.length - plottedCount - (authorWindow ? excluded : 0), diagnostics,
    warnings: [...emptyFields].map((field) => `No numeric values for series field “${field}”.`),
    ...(excluded > 0 ? { notice: `Showing ${limit === CHART_RECORD_LIMIT ? "5,000" : limit} of ${eligible.length} records` } : {}),
  };
  if (plottedCount === 0) return { status: "no-records" as const, message: "No plottable records in this chart collection.", ...common };
  return { status: "ready" as const, ...common };
}

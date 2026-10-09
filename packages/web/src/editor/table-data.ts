/** Tables retain record references and format only cells on the visible page. */
import { compareCodePoints, isExternalHref } from "@uberblick/schema";
import type { DataRecord, DocData } from "@uberblick/schema";
import { chartDate, formatChartNumber, formatChartX } from "./chart-data.js";
import { bindCollection, incompatible, keys, name, numeric, object, optionalText, own } from "./view-data.js";

export type TableFormat = "text" | "number" | "date" | "link";
export interface TableColumnMapping {
  field: string;
  label?: string;
  format: TableFormat;
  unit?: string;
  decimals?: number;
}
export interface TableConfig {
  version: 1;
  type: "table";
  collection: string;
  columns: TableColumnMapping[];
  title?: string;
  sort?: { field: string; direction: "asc" | "desc" };
  pageSize: number;
}
export interface TableReady {
  status: "ready";
  config: TableConfig;
  rows: DataRecord[];
  recordCount: number;
  invalidSchema: number;
}
export interface TableProblem {
  status: "invalid-configuration" | "collection-absent" | "collection-unusable" | "mapping-incompatible" | "no-records";
  message: string;
  invalidSchema?: number;
}
export type TableProjection = TableReady | TableProblem;
export interface TableCell {
  state: "valid" | "absent" | "null" | "invalid";
  text: string;
  href?: string;
}

function column(value: unknown): boolean {
  if (!object(value) || !name(value.field) || !optionalText(value, "label")) return false;
  const format = value.format ?? "text";
  if (format !== "text" && format !== "number" && format !== "date" && format !== "link") return false;
  // An explicit null is invalid, even though omitted format defaults to text.
  if (Object.hasOwn(value, "format") && value.format === null) return false;
  if (!keys(value, format === "number" ? ["field", "label", "format", "unit", "decimals"] : ["field", "label", "format"])) return false;
  return format !== "number" || (optionalText(value, "unit") &&
    (!Object.hasOwn(value, "decimals") || (Number.isInteger(value.decimals) &&
      typeof value.decimals === "number" && value.decimals >= 0 && value.decimals <= 10)));
}

export function parseTableConfig(source: string):
  { ok: true; config: TableConfig } | { ok: false; message: string } {
  let value: unknown;
  try { value = JSON.parse(source); }
  catch { return { ok: false, message: "Invalid table configuration: source must be JSON." }; }
  if (!object(value) || !keys(value, ["version", "type", "collection", "columns", "title", "sort", "pageSize"]) ||
      value.version !== 1 || value.type !== "table" || !name(value.collection) ||
      !Array.isArray(value.columns) || value.columns.length < 1 || value.columns.length > 30 ||
      !value.columns.every(column) || !optionalText(value, "title") ||
      (Object.hasOwn(value, "pageSize") && (typeof value.pageSize !== "number" ||
        !Number.isInteger(value.pageSize) || value.pageSize < 1 || value.pageSize > 100)) ||
      (Object.hasOwn(value, "sort") && (!object(value.sort) || !keys(value.sort, ["field", "direction"]) ||
        !name(value.sort.field) || (value.sort.direction !== "asc" && value.sort.direction !== "desc") ||
        !value.columns.some((entry: { field: string }) => entry.field === (value.sort as { field: string }).field)))) {
    return { ok: false, message: "Invalid table configuration: expected a version 1 table mapping with one to thirty columns, supported formats and pageSize 1 to 100; unknown keys are not supported." };
  }
  // Defaults belong to this detached view, never to the authored JSON source.
  return { ok: true, config: {
    ...value,
    columns: value.columns.map((entry: Record<string, unknown>) => ({ ...entry, format: entry.format ?? "text" })),
    pageSize: value.pageSize ?? 25,
  } as TableConfig };
}

function storedText(value: unknown): string { return typeof value === "string" ? value : JSON.stringify(value); }

/** Sort keys reflect the stored format, not its locale-dependent display text. */
function sortValue(column: TableColumnMapping, record: DataRecord): string | number | null {
  const value = own(record.value, column.field);
  if (value === undefined || value === null) return null;
  switch (column.format) {
    case "text": return storedText(value);
    case "number": return numeric(value) ? value : null;
    case "date": return chartDate(value);
    case "link": return isExternalHref(value) ? value : null;
  }
}

export function projectTable(config: TableConfig, data: DocData | null): TableProjection {
  const binding = bindCollection(data, config.collection, "Table");
  if (binding.status !== "ready") return binding;
  const { collection, schema } = binding;
  const badField = config.columns.find((entry) => incompatible(schema, entry.field, entry.format))?.field;
  if (badField !== undefined) return { status: "mapping-incompatible", message: `Table mapping is incompatible with the schema: field “${badField}” is missing or has an incompatible type.` };
  const invalid = new Set(collection.invalidRecordIds);
  const rows: DataRecord[] = [];
  let invalidSchema = 0;
  for (const record of collection.records) {
    if (invalid.has(record.id) || !object(record.value)) { invalidSchema += 1; continue; }
    rows.push(record as DataRecord);
  }
  const sort = config.sort;
  // If a field appears twice, its first displayed column defines its sort format.
  const sortColumn = sort === undefined ? undefined : config.columns.find((entry) => entry.field === sort.field);
  if (sortColumn === undefined) rows.sort((a, b) => compareCodePoints(a.id, b.id));
  else {
    const values = new Map(rows.map((record) => [record, sortValue(sortColumn, record)]));
    const direction = sort?.direction === "desc" ? -1 : 1;
    rows.sort((a, b) => {
      const av = values.get(a) ?? null;
      const bv = values.get(b) ?? null;
      if (av === null || bv === null) return (av === null ? 1 : 0) - (bv === null ? 1 : 0) || compareCodePoints(a.id, b.id);
      const order = typeof av === "number" && typeof bv === "number" ? av - bv : compareCodePoints(String(av), String(bv));
      return direction * order || compareCodePoints(a.id, b.id);
    });
  }
  if (rows.length === 0) return { status: "no-records", message: "No records to show in this table collection.", invalidSchema };
  return { status: "ready", config, rows, recordCount: collection.records.length, invalidSchema };
}

export function prepareTable(source: string, data: DocData | null): TableProjection {
  const parsed = parseTableConfig(source);
  return parsed.ok ? projectTable(parsed.config, data) : { status: "invalid-configuration", message: parsed.message };
}

/** Text is always assigned as text by the renderer; only href activates a link. */
export function formatTableCell(column: TableColumnMapping, record: DataRecord, locale?: string): TableCell {
  const value = own(record.value, column.field);
  if (value === undefined) return { state: "absent", text: "Absent" };
  if (value === null) return { state: "null", text: "Null" };
  switch (column.format) {
    case "text": return { state: "valid", text: storedText(value) };
    case "number": {
      if (!numeric(value)) break;
      const formatted = column.decimals === undefined ? formatChartNumber(value, locale)
        : new Intl.NumberFormat(locale, { minimumFractionDigits: column.decimals, maximumFractionDigits: column.decimals }).format(value);
      return { state: "valid", text: `${formatted}${column.unit ? ` ${column.unit}` : ""}` };
    }
    case "date": {
      const instant = chartDate(value);
      if (instant !== null) return { state: "valid", text: formatChartX(instant, "date", locale) };
      break;
    }
    case "link":
      if (isExternalHref(value)) return { state: "valid", text: value, href: value };
      break;
  }
  return { state: "invalid", text: `Invalid: ${storedText(value)}` };
}

export function tableAccessibleName(config: TableConfig): string { return config.title || `Data table of ${config.collection}`; }
export function tableDiagnosticsText(table: TableProjection): string {
  return (table.invalidSchema ?? 0) > 0 ? `${table.invalidSchema} records not shown (invalid under the collection schema).` : "";
}

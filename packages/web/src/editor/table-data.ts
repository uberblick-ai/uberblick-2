/** Locale-specific cells and accessible presentation stay in the web client. */
import { chartDate, isExternalHref } from "@uberblick/schema";
import type { ChartProjection, DataRecord, TableColumnMapping, TableConfig, TableProjection } from "@uberblick/schema";
import { chartDateFormatter, chartNumberFormatter } from "./chart-data.js";
export { parseTableConfig, prepareTable, sortTableRows } from "@uberblick/schema";
export type { TableColumnMapping, TableConfig, TableProjection, TableReady } from "@uberblick/schema";

function storedText(value: unknown): string { return typeof value === "string" ? value : JSON.stringify(value); }
function numeric(value: unknown): value is number { return typeof value === "number" && Number.isFinite(value); }

export interface TableCell {
  state: "valid" | "absent" | "null" | "invalid";
  text: string;
  href?: string;
}

/**
 * Reuse Intl formatters within a column, keeping the chart's locale semantics.
 * The renderer assigns cell text as text; only href activates a link.
 */
export function tableCellFormatter(column: TableColumnMapping, locale?: string): (record: DataRecord) => TableCell {
  let number: ((value: number) => string) | undefined;
  let date: ((value: number) => string) | undefined;
  return (record) => {
    const value = Object.hasOwn(record.value, column.field) ? record.value[column.field] : undefined;
    if (value === undefined) return { state: "absent", text: "Absent" };
    if (value === null) return { state: "null", text: "Null" };
    switch (column.format) {
      case "text": return { state: "valid", text: storedText(value) };
      case "number": {
        if (!numeric(value)) break;
        number ??= column.decimals === undefined ? chartNumberFormatter(locale)
          : new Intl.NumberFormat(locale, { minimumFractionDigits: column.decimals, maximumFractionDigits: column.decimals }).format;
        return { state: "valid", text: `${number(value)}${column.unit ? ` ${column.unit}` : ""}` };
      }
      case "date": {
        const instant = chartDate(value);
        if (instant === null) break;
        date ??= chartDateFormatter(locale);
        return { state: "valid", text: date(instant) };
      }
      case "link":
        if (isExternalHref(value)) return { state: "valid", text: value, href: value };
        break;
    }
    return { state: "invalid", text: `Invalid: ${storedText(value)}` };
  };
}

export function tableAccessibleName(config: TableConfig): string { return config.title || `Data table of ${config.collection}`; }
export function tableDiagnosticsText(table: TableProjection | ChartProjection): string {
  const invalidSchema = "invalidSchema" in table ? table.invalidSchema ?? 0 : 0;
  return invalidSchema > 0 ? `${invalidSchema} records not shown (invalid under the collection schema).` : "";
}

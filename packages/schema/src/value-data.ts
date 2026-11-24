import type { DataRecord, DocData } from "./data.js";
import { tableColumn } from "./table-data.js";
import { bindCollection, filterRecords, keys, name, object, optionalFilter } from "./view-data.js";
import type { ViewFilter } from "./view-data.js";

export interface ValueConfig {
  collection: string;
  filter: ViewFilter;
  field: string;
  format: "text" | "number" | "date";
  unit?: string;
  decimals?: number;
}

export interface ValueSourceRange { from: number; to: number; source: string }

/** Find complete object boundaries; JSON.parse owns the JSON grammar. */
export function scanValueSources(text: string, options: { includeIncomplete?: boolean } = {}): ValueSourceRange[] {
  const ranges: ValueSourceRange[] = [];
  let from = text.indexOf(":value{");
  while (from !== -1) {
    let depth = 0;
    let quoted = false;
    let escaped = false;
    let complete = false;
    let to = from + 6;
    for (; to < text.length; to += 1) {
      const char = text[to];
      if (quoted) {
        if (escaped) escaped = false;
        else if (char === "\\") escaped = true;
        else if (char === '"') quoted = false;
      } else if (char === '"') quoted = true;
      else if (char === "{") depth += 1;
      else if (char === "}" && --depth === 0) {
        to += 1;
        ranges.push({ from, to, source: text.slice(from, to) });
        complete = true;
        break;
      }
    }
    if (options.includeIncomplete && !complete) {
      ranges.push({ from, to, source: text.slice(from, to) });
      break;
    }
    from = text.indexOf(":value{", complete ? to : from + 6);
  }
  return ranges;
}

export function parseValueSource(source: string): { ok: true; config: ValueConfig } | { ok: false; message: string } {
  const failure = { ok: false, message: "Unreadable value source." } as const;
  if (!source.startsWith(":value{")) return failure;
  let value: unknown;
  try { value = JSON.parse(source.slice(6)); }
  catch { return failure; }
  if (!object(value) || !keys(value, ["collection", "filter", "field", "format", "unit", "decimals"]) ||
      !name(value.collection) || !Object.hasOwn(value, "filter") || !optionalFilter(value) ||
      (value.format !== undefined && value.format !== "text" && value.format !== "number" && value.format !== "date")) return failure;
  const { collection, filter, ...column } = value;
  if (!tableColumn(column)) return failure;
  return { ok: true, config: { ...column, collection, filter, format: value.format ?? "text" } as ValueConfig };
}

export type ValueProjection =
  | { status: "ready"; config: ValueConfig; record: DataRecord }
  | { status: "invalid-source" | "collection-absent" | "collection-unusable" | "no-records" | "multiple-records"; message: string };

/** Read one schema-valid match from the detached snapshot, never by position. */
export function prepareValue(source: string, data: DocData | null): ValueProjection {
  const parsed = parseValueSource(source);
  if (!parsed.ok) return { status: "invalid-source", message: parsed.message };
  const { config } = parsed;
  const binding = bindCollection(data, config.collection, "Value");
  if (binding.status !== "ready") return binding;
  const invalid = new Set(binding.collection.invalidRecordIds);
  const records = filterRecords(binding.collection.records, config.filter)
    .filter((record) => !invalid.has(record.id) && object(record.value));
  if (records.length === 0) return { status: "no-records", message: "No schema-valid record matches the value filter." };
  if (records.length > 1) return { status: "multiple-records", message: "Several schema-valid records match the value filter." };
  return { status: "ready", config, record: records[0] as DataRecord };
}

/** Shared read-only binding rules for document-owned data views. */
import { DATA_LIMITS, validateCollectionSchema } from "@uberblick/schema";
import type { DataCollection, DataSchema, DocData, JSONObject } from "@uberblick/schema";

export function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
export function text(value: unknown): value is string {
  return typeof value === "string" && !/[\uD800-\uDFFF]/u.test(value);
}
export function name(value: unknown): value is string { return text(value) && value.length > 0; }
export function keys(value: Record<string, unknown>, allowed: readonly string[]): boolean {
  return Object.keys(value).every((key) => allowed.includes(key));
}
export function optionalText(value: Record<string, unknown>, key: string): boolean {
  return !Object.hasOwn(value, key) || text(value[key]);
}
export function numeric(value: unknown): value is number { return typeof value === "number" && Number.isFinite(value); }
export function own(value: JSONObject, key: string): unknown { return Object.hasOwn(value, key) ? value[key] : undefined; }

export interface CollectionProblem {
  status: "collection-absent" | "collection-unusable";
  message: string;
}

/** Collection validation never repairs or modifies the detached shared snapshot. */
export function bindCollection(data: DocData | null, collectionName: string, label: "Chart" | "Table"):
  { status: "ready"; collection: DataCollection; schema: DataSchema } | CollectionProblem {
  const collection = data?.collections.find((candidate) => candidate.name === collectionName);
  if (collection === undefined) return { status: "collection-absent", message: `${label} collection “${collectionName}” is absent.` };
  if (data !== null && (data.bytes > DATA_LIMITS.area || data.errors.some((error) => error.details.limit === "area"))) {
    return { status: "collection-unusable", message: `${label} collection is unusable: the document data area exceeds its limit.` };
  }
  const schema = collection.schema;
  try { validateCollectionSchema(schema); }
  catch { return { status: "collection-unusable", message: `${label} collection is unusable: its schema is missing or unsupported.` }; }
  if (collection.errors.some((error) => error.code === "data_schema_invalid" || error.details.limit === "schema")) {
    return { status: "collection-unusable", message: `${label} collection is unusable: its schema is missing, unsupported or over its limit.` };
  }
  return { status: "ready", collection, schema: schema.schema };
}

/** Text can show every JSON value; typed formats require a compatible declaration. */
export function incompatible(schema: DataSchema, field: string, expected: "text" | "number" | "date" | "link"): boolean {
  const property = schema.properties !== undefined && Object.hasOwn(schema.properties, field)
    ? schema.properties[field] : undefined;
  if (property === undefined) return schema.additionalProperties === false;
  if (property.type === undefined || expected === "text") return false;
  const types = typeof property.type === "string" ? [property.type] : property.type;
  return expected === "date" || expected === "link"
    ? !types.includes("string") : !types.includes("number") && !types.includes("integer");
}

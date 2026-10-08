/**
 * The deliberately closed version-1 data vocabulary. This is not a general
 * JSON Schema dialect: unsupported keywords are errors, and enum/const values
 * are scalar. A version changes only when the accepted vocabulary changes.
 */
export type JSONScalar = string | number | boolean | null;
export type JSONValue = JSONScalar | JSONObject | JSONValue[];
export interface JSONObject { [key: string]: JSONValue }

export type DataType = "object" | "array" | "string" | "number" | "integer" | "boolean" | "null";
export interface DataSchema {
  type?: DataType | readonly DataType[];
  properties?: Record<string, DataSchema>;
  required?: readonly string[];
  additionalProperties?: false;
  items?: DataSchema;
  enum?: readonly JSONScalar[];
  const?: JSONScalar;
  minimum?: number;
  maximum?: number;
  minLength?: number;
  maxLength?: number;
  minItems?: number;
  maxItems?: number;
}
export interface CollectionSchema {
  version: 1;
  schema: DataSchema;
}

/** Codes and details survive a caller adding collection and record context. */
export class DataError extends Error {
  readonly code: string;
  readonly details: Record<string, unknown>;

  constructor(code: string, reason: string, details: Record<string, unknown> = {}) {
    super(reason);
    this.name = "DataError";
    this.code = code;
    this.details = details;
  }
}

export const MAX_DATA_DEPTH = 32;

/** Unicode code-point order, independent of locale and UTF-16 surrogate order. */
export function compareCodePoints(left: string, right: string): number {
  let a = 0;
  let b = 0;
  while (a < left.length && b < right.length) {
    const first = left.codePointAt(a) ?? 0;
    const second = right.codePointAt(b) ?? 0;
    if (first !== second) return first < second ? -1 : 1;
    a += first > 0xffff ? 2 : 1;
    b += second > 0xffff ? 2 : 1;
  }
  return a === left.length ? (b === right.length ? 0 : -1) : 1;
}

function pointer(path: string, key: string | number): string {
  return `${path}/${String(key).replaceAll("~", "~0").replaceAll("/", "~1")}`;
}

function isObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype: unknown = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function invalidJSON(path: string, reason: string): never {
  throw new DataError("data_invalid_input", `JSON ${path || "/"}: ${reason}`, { path });
}

/**
 * Reject values JSON would silently drop or transform. Depth counts containers:
 * a root object/array has depth one, its nested containers have depth two.
 * Shared-root envelopes may use Infinity after each schema/record is checked.
 */
export function assertJSON(value: unknown, maxDepth = MAX_DATA_DEPTH): asserts value is JSONValue {
  const ancestors = new Set<object>();
  function visit(current: unknown, path: string, depth: number): void {
    if (current === null || typeof current === "string" || typeof current === "boolean") return;
    if (typeof current === "number") {
      if (!Number.isFinite(current)) invalidJSON(path, "numbers must be finite");
      return;
    }
    if (typeof current !== "object") invalidJSON(path, "expected a JSON value");
    if (!Array.isArray(current) && !isObject(current)) invalidJSON(path, "expected a plain JSON object");
    if (depth > maxDepth) {
      throw new DataError("data_limit_exceeded", `JSON nesting_depth limit ${maxDepth} exceeded by ${depth}`, {
        path, limit: "nesting_depth", value: maxDepth, attempted: depth,
      });
    }
    if (ancestors.has(current)) invalidJSON(path, "cyclic values are not JSON");
    ancestors.add(current);
    if (Array.isArray(current)) {
      for (const key of Reflect.ownKeys(current)) {
        if (key === "length") continue;
        if (typeof key !== "string" || !/^(0|[1-9][0-9]*)$/.test(key) || Number(key) >= current.length) {
          invalidJSON(path, "array properties must be element indices");
        }
      }
      for (let index = 0; index < current.length; index += 1) {
        const descriptor = Object.getOwnPropertyDescriptor(current, String(index));
        if (descriptor === undefined || !("value" in descriptor) || !descriptor.enumerable) {
          invalidJSON(pointer(path, index), "expected an ordinary JSON array element");
        }
        visit(descriptor.value, pointer(path, index), depth + 1);
      }
    } else {
      for (const key of Reflect.ownKeys(current).sort((a, b) =>
        typeof a === "string" && typeof b === "string" ? compareCodePoints(a, b) : 0)) {
        if (typeof key !== "string") invalidJSON(path, "object keys must be strings");
        const descriptor = Object.getOwnPropertyDescriptor(current, key);
        if (descriptor === undefined || !("value" in descriptor) || !descriptor.enumerable) {
          invalidJSON(pointer(path, key), "expected an ordinary JSON property");
        }
        visit(descriptor.value, pointer(path, key), depth + 1);
      }
    }
    ancestors.delete(current);
  }
  visit(value, "", 1);
}

/** Stable JSON bytes and equality: object key insertion order is immaterial. */
export function canonicalJson(value: unknown, maxDepth = MAX_DATA_DEPTH): string {
  assertJSON(value, maxDepth);
  function encode(current: JSONValue): string {
    if (current === null || typeof current !== "object") return JSON.stringify(current);
    if (Array.isArray(current)) return `[${current.map(encode).join(",")}]`;
    return `{${Object.keys(current).sort(compareCodePoints)
      .map((key) => `${JSON.stringify(key)}:${encode(current[key] as JSONValue)}`).join(",")}}`;
  }
  return encode(value);
}

/** Parsing the canonical value also detaches every nested object and array. */
export function cloneJson(value: unknown, maxDepth = MAX_DATA_DEPTH): JSONValue {
  return JSON.parse(canonicalJson(value, maxDepth)) as JSONValue;
}

const TYPES = new Set<string>(["object", "array", "string", "number", "integer", "boolean", "null"]);
const KEYWORDS = new Set([
  "type", "properties", "required", "additionalProperties", "items", "enum", "const",
  "minimum", "maximum", "minLength", "maxLength", "minItems", "maxItems",
]);

function schemaError(path: string, reason: string): never {
  throw new DataError("data_schema_invalid", `Schema ${path || "/"}: ${reason}`, { path });
}

function scalar(value: unknown): value is JSONScalar {
  return value === null || typeof value === "string" || typeof value === "boolean" ||
    (typeof value === "number" && Number.isFinite(value));
}

/** Validate every keyword even when its schema cannot match the current data. */
export function validateCollectionSchema(value: unknown): asserts value is CollectionSchema {
  try {
    assertJSON(value);
  } catch (error) {
    if (error instanceof DataError && error.code === "data_invalid_input") {
      schemaError(String(error.details.path), error.message);
    }
    throw error;
  }
  if (!isObject(value)) schemaError("", "expected a collection schema object");
  for (const key of Object.keys(value).sort(compareCodePoints)) {
    if (key !== "version" && key !== "schema") schemaError(pointer("", key), "unsupported envelope keyword");
  }
  if (value.version !== 1) schemaError("/version", "unsupported vocabulary version; expected 1");

  function visit(node: unknown, path: string): void {
    if (!isObject(node)) schemaError(path, "expected a schema object");
    for (const key of Object.keys(node).sort(compareCodePoints)) {
      const at = pointer(path, key);
      const entry = node[key];
      if (!KEYWORDS.has(key)) schemaError(at, "unsupported keyword");
      switch (key) {
        case "type":
          if (typeof entry === "string" && TYPES.has(entry)) break;
          if (Array.isArray(entry) && entry.length === 2 && entry.includes("null") &&
              entry[0] !== entry[1] && entry.every((type) => typeof type === "string" && TYPES.has(type))) break;
          schemaError(at, "expected one supported type, or that type paired with null");
          break;
        case "properties":
          if (!isObject(entry)) schemaError(at, "expected an object of property schemas");
          for (const name of Object.keys(entry).sort(compareCodePoints)) visit(entry[name], pointer(at, name));
          break;
        case "required":
          if (!Array.isArray(entry) || !entry.every((name) => typeof name === "string") ||
              new Set(entry).size !== entry.length) schemaError(at, "expected an array of unique property names");
          break;
        case "additionalProperties":
          if (entry !== false) schemaError(at, "only false or omission is supported");
          break;
        case "items":
          visit(entry, at);
          break;
        case "enum":
          // Version 1 requires a nonempty, unique array of scalar choices.
          if (!Array.isArray(entry) || entry.length === 0 || !entry.every(scalar) ||
              new Set(entry.map((item) => JSON.stringify(item))).size !== entry.length) {
            schemaError(at, "expected a nonempty array of unique scalar values");
          }
          break;
        case "const":
          if (!scalar(entry)) schemaError(at, "expected a scalar value");
          break;
        case "minimum":
        case "maximum":
          if (typeof entry !== "number" || !Number.isFinite(entry)) schemaError(at, "expected a finite number");
          break;
        case "minLength":
        case "maxLength":
        case "minItems":
        case "maxItems":
          if (typeof entry !== "number" || !Number.isInteger(entry) || entry < 0) {
            schemaError(at, "expected a nonnegative integer");
          }
          break;
      }
    }
  }
  visit(value.schema, "/schema");
  if ((value.schema as DataSchema).type !== "object") schemaError("/schema/type", "a record schema must have type object");
}

function recordError(path: string, reason: string): never {
  throw new DataError("data_record_invalid", `Record ${path || "/"}: ${reason}`, { path });
}

function matchesType(value: JSONValue, type: DataType): boolean {
  switch (type) {
    case "null": return value === null;
    case "object": return value !== null && typeof value === "object" && !Array.isArray(value);
    case "array": return Array.isArray(value);
    case "integer": return typeof value === "number" && Number.isInteger(value);
    default: return typeof value === type;
  }
}

/** The schema must have passed validateCollectionSchema once per collection. */
export function validateDataRecord(value: unknown, schema: CollectionSchema): asserts value is JSONObject {
  try {
    assertJSON(value);
  } catch (error) {
    if (error instanceof DataError && error.code === "data_invalid_input") {
      recordError(String(error.details.path), error.message);
    }
    throw error;
  }
  if (!isObject(value)) recordError("", "expected a JSON object");
  function visit(current: JSONValue, node: DataSchema, path: string): void {
    if (node.type !== undefined) {
      const types: readonly DataType[] = typeof node.type === "string" ? [node.type] : node.type;
      if (!types.some((type) => matchesType(current, type))) recordError(path, `expected type ${types.join(" or ")}`);
    }
    if (node.enum !== undefined && !node.enum.some((choice) => choice === current)) recordError(path, "value is not in enum");
    if (Object.hasOwn(node, "const") && node.const !== current) recordError(path, "value does not equal const");
    if (typeof current === "number") {
      if (node.minimum !== undefined && current < node.minimum) recordError(path, `minimum is ${node.minimum}`);
      if (node.maximum !== undefined && current > node.maximum) recordError(path, `maximum is ${node.maximum}`);
    } else if (typeof current === "string") {
      const length = [...current].length;
      if (node.minLength !== undefined && length < node.minLength) recordError(path, `minLength is ${node.minLength}`);
      if (node.maxLength !== undefined && length > node.maxLength) recordError(path, `maxLength is ${node.maxLength}`);
    } else if (Array.isArray(current)) {
      if (node.minItems !== undefined && current.length < node.minItems) recordError(path, `minItems is ${node.minItems}`);
      if (node.maxItems !== undefined && current.length > node.maxItems) recordError(path, `maxItems is ${node.maxItems}`);
      const items = node.items;
      if (items !== undefined) current.forEach((item, index) => { visit(item, items, pointer(path, index)); });
    } else if (current !== null && typeof current === "object") {
      for (const name of node.required ?? []) {
        if (!Object.hasOwn(current, name)) recordError(pointer(path, name), "required property is missing");
      }
      for (const name of Object.keys(current).sort(compareCodePoints)) {
        if (node.properties !== undefined && Object.hasOwn(node.properties, name)) {
          visit(current[name] as JSONValue, node.properties[name] as DataSchema, pointer(path, name));
        } else if (node.additionalProperties === false) {
          recordError(pointer(path, name), "additional property is not allowed");
        }
      }
    }
  }
  visit(value as JSONObject, schema.schema, "");
}

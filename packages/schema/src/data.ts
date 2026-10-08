/**
 * Optional document content in one flat Y.Map. Schemas and whole JSON records
 * are independent conflict units; transactions are local, not distributed CAS.
 * Key tuples avoid separators/escaping ambiguities, including arbitrary JSON
 * property names. Names and ids are nonempty Unicode strings, without lone
 * surrogates. There is no record-count limit or CRDT-history reclamation.
 */
import type * as Y from "yjs";
import { getMeta } from "./doc.js";
import { decisionTopicArchived } from "./directory.js";
import {
  canonicalJson, compareCodePoints, DataError, validateCollectionSchema,
  validateDataRecord,
} from "./data-schema.js";
import type { CollectionSchema, JSONObject, JSONValue } from "./data-schema.js";

export const DATA_KEY = "data";
export const DATA_LIMITS = {
  area: 4 * 1024 * 1024,
  record: 64 * 1024,
  schema: 64 * 1024,
  depth: 32,
  operation: 1024 * 1024,
} as const;

export interface DataRecord { id: string; value: JSONObject }
export interface DataOperation {
  collection: string;
  schema?: CollectionSchema;
  upsert?: DataRecord[];
  deleteRecords?: string[];
  replaceRecords?: DataRecord[];
  deleteCollection?: boolean;
}
export interface DataIssue {
  code: string;
  reason: string;
  details: Record<string, unknown>;
}
export interface DataCollection {
  name: string;
  /** Unsupported versions and malformed merged schemas remain visible. */
  schema: JSONValue | null;
  records: { id: string; value: JSONValue }[];
  valid: boolean;
  invalidRecordIds: string[];
  errors: DataIssue[];
}
export interface DocData {
  collections: DataCollection[];
  valid: boolean;
  bytes: number;
  errors: DataIssue[];
}

function key(kind: "schema" | "record", collection: string, id?: string): string {
  return JSON.stringify(id === undefined ? [kind, collection] : [kind, collection, id]);
}
function identifier(value: unknown, field: string): asserts value is string {
  if (typeof value !== "string" || value.length === 0 || /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u.test(value)) {
    throw new DataError("data_invalid_input", `${field} must be a nonempty Unicode string`, { field });
  }
}
type DataKey = ["schema", string] | ["record", string, string];
function parseKey(value: string): DataKey {
  try {
    const tuple = JSON.parse(value);
    if (Array.isArray(tuple) &&
      ((tuple[0] === "schema" && tuple.length === 2) || (tuple[0] === "record" && tuple.length === 3))) {
      identifier(tuple[1], "collection");
      if (tuple[0] === "record") identifier(tuple[2], "recordId");
      if (JSON.stringify(tuple) === value) return tuple as DataKey;
    }
  } catch { /* Report unsupported storage keys; never silently remove them. */ }
  throw new DataError("data_invalid_input", "Unsupported data key", { key: value });
}
const encoder = new TextEncoder();
function bytes(value: unknown): number {
  // Each schema/record has its own depth budget. The storage wrapper adds none.
  return encoder.encode(canonicalJson(value, Infinity)).byteLength;
}
function areaBytes(entries: Map<string, JSONValue>): number {
  return bytes(Object.fromEntries(entries));
}
function limitError(name: keyof typeof DATA_LIMITS, attempted: number): DataError {
  return new DataError("data_limit_exceeded", `${name} limit ${DATA_LIMITS[name]} exceeded by attempted size ${attempted}`, {
    limit: name, value: DATA_LIMITS[name], attempted,
  });
}
function limit(name: keyof typeof DATA_LIMITS, attempted: number): void {
  if (attempted > DATA_LIMITS[name]) {
    throw limitError(name, attempted);
  }
}
function contextual(error: unknown, collection: string, recordId?: string): DataError {
  if (!(error instanceof DataError)) throw error;
  return new DataError(error.code, error.message, {
    ...error.details, collection, ...(recordId === undefined ? {} : { recordId }),
  });
}
function issue(error: DataError): DataIssue {
  return { code: error.code, reason: error.message, details: error.details };
}

/** Detached, canonically ordered raw content, including unsupported versions. */
export function getDocDataEntries(doc: Y.Doc): [string, JSONValue][] {
  return [...doc.getMap<unknown>(DATA_KEY).entries()]
    .sort(([a], [b]) => compareCodePoints(a, b))
    .map(([k, value]) => [k, JSON.parse(canonicalJson(value, Infinity)) as JSONValue]);
}
export function hasDocData(doc: Y.Doc): boolean {
  return doc.getMap(DATA_KEY).size > 0;
}

interface CollectionEntries {
  schema?: JSONValue;
  records: Map<string, JSONValue>;
}

/** Parse each storage key once; unknown entries stay in the raw area. */
function groupEntries(entries: Map<string, JSONValue>): {
  collections: Map<string, CollectionEntries>;
  errors: DataIssue[];
} {
  const collections = new Map<string, CollectionEntries>();
  const errors: DataIssue[] = [];
  for (const [k, value] of entries) {
    let tuple: ReturnType<typeof parseKey>;
    try { tuple = parseKey(k); }
    catch (error) {
      if (!(error instanceof DataError)) throw error;
      errors.push(issue(error));
      continue;
    }
    const name = tuple[1];
    const collection: CollectionEntries = collections.get(name) ?? { records: new Map<string, JSONValue>() };
    if (tuple[0] === "schema") collection.schema = value;
    else collection.records.set(tuple[2], value);
    collections.set(name, collection);
  }
  return { collections, errors };
}

function collectionState(entries: CollectionEntries, name: string): DataCollection {
  const schema = entries.schema ?? null;
  const records = [...entries.records].map(([id, value]) => ({ id, value }));
  records.sort((a, b) => compareCodePoints(a.id, b.id));
  const errors: DataIssue[] = [];
  let supported: CollectionSchema | undefined;
  try {
    if (schema === null) throw new DataError("data_schema_invalid", "Collection has no schema", { path: "/schema" });
    validateCollectionSchema(schema);
    limit("schema", bytes(schema));
    supported = schema;
  } catch (error) { errors.push(issue(contextual(error, name))); }
  const invalidRecordIds: string[] = [];
  for (const record of records) {
    try {
      if (supported === undefined) {
        throw new DataError("data_record_invalid", "Record has no supported collection schema");
      }
      validateDataRecord(record.value, supported);
      limit("record", bytes(record.value));
    } catch (error) {
      invalidRecordIds.push(record.id);
      errors.push(issue(contextual(error, name, record.id)));
    }
  }
  return { name, schema, records, valid: errors.length === 0, invalidRecordIds, errors };
}

/** Observe merged invalidity without dropping values, repairing or writing. */
export function readDocData(doc: Y.Doc): DocData | null {
  const entries = new Map(getDocDataEntries(doc));
  if (entries.size === 0) return null;
  const grouped = groupEntries(entries);
  const errors = grouped.errors;
  const collections = [...grouped.collections].sort(([a], [b]) => compareCodePoints(a, b))
    .map(([name, collection]) => collectionState(collection, name));
  const size = areaBytes(entries);
  if (size > DATA_LIMITS.area) {
    const error = issue(limitError("area", size));
    errors.push(error);
    for (const collection of collections) {
      collection.valid = false;
      collection.invalidRecordIds = collection.records.map((record) => record.id);
      collection.errors.push(error);
    }
  }
  return { collections, bytes: size, valid: errors.length === 0 && collections.every((c) => c.valid), errors };
}

/**
 * Validate the complete candidate for every touched collection before writing.
 * For each collection: set schema, replace records, delete ids, then upsert.
 * Different operations may not name the same collection. DeleteCollection is
 * exclusive. Only changed keys are written; an identical refresh emits nothing.
 * An over-limit merged area may shrink while remaining over its area budget.
 */
export function applyDocData(doc: Y.Doc, directory: Y.Doc, operations: readonly DataOperation[]): { changed: boolean } {
  const meta = getMeta(doc);
  if (decisionTopicArchived(directory, meta.uuid)) throw new DataError("doc_archived", "Archived documents are read-only", { uuid: meta.uuid, archived: true });
  if (meta.kind === "decision" && meta.status === "decided") {
    throw new DataError("decision_read_only", "Decided document content is read-only", { uuid: meta.uuid, kind: meta.kind, status: meta.status });
  }
  if (!Array.isArray(operations)) throw new DataError("data_invalid_input", "Operations must be an array");
  const before = new Map(getDocDataEntries(doc));
  const next = new Map(before);
  const { collections } = groupEntries(before);
  const touched = new Set<string>();
  for (const op of operations) {
    if (op === null || typeof op !== "object") throw new DataError("data_invalid_input", "Each collection operation must be an object");
    identifier(op.collection, "collection");
    const name = op.collection;
    if (touched.has(name)) throw new DataError("data_invalid_input", "Collection occurs twice in one operation", { collection: name });
    touched.add(name);
    const collection: CollectionEntries = collections.get(name) ?? { records: new Map<string, JSONValue>() };
    if (op.deleteCollection === true) {
      if (op.schema !== undefined || op.upsert !== undefined || op.deleteRecords !== undefined || op.replaceRecords !== undefined) {
        throw new DataError("data_invalid_input", "Collection deletion cannot carry other changes", { collection: name });
      }
      next.delete(key("schema", name));
      for (const id of collection.records.keys()) next.delete(key("record", name, id));
      collections.delete(name);
      continue;
    }
    if (op.schema !== undefined) {
      try {
        validateCollectionSchema(op.schema);
        limit("schema", bytes(op.schema));
        collection.schema = JSON.parse(canonicalJson(op.schema)) as JSONValue;
        next.set(key("schema", name), collection.schema);
      } catch (error) { throw contextual(error, name); }
    }
    const put = (records: DataRecord[]) => {
      if (!Array.isArray(records)) throw new DataError("data_invalid_input", "Records must be an array", { collection: name });
      const ids = new Set<string>();
      for (const record of records) {
        if (record === null || typeof record !== "object") throw new DataError("data_invalid_input", "Each record must have an id and JSON object value", { collection: name });
        identifier(record.id, "recordId");
        if (ids.has(record.id)) throw new DataError("data_invalid_input", "Duplicate record id", { collection: name, recordId: record.id });
        ids.add(record.id);
        try {
          const encoded = canonicalJson(record.value);
          limit("record", encoder.encode(encoded).byteLength);
          const value = JSON.parse(encoded) as JSONValue;
          collection.records.set(record.id, value);
          next.set(key("record", name, record.id), value);
        } catch (error) { throw contextual(error, name, record.id); }
      }
    };
    if (op.replaceRecords !== undefined) {
      for (const id of collection.records.keys()) next.delete(key("record", name, id));
      collection.records.clear();
      put(op.replaceRecords);
    }
    if (op.deleteRecords !== undefined) {
      if (!Array.isArray(op.deleteRecords)) throw new DataError("data_invalid_input", "Deleted ids must be an array", { collection: name });
      for (const id of op.deleteRecords) {
        identifier(id, "recordId");
        collection.records.delete(id);
        next.delete(key("record", name, id));
      }
    }
    if (op.upsert !== undefined) put(op.upsert);
    if (collection.schema === undefined && collection.records.size === 0) {
      collections.delete(name);
      continue;
    }
    collections.set(name, collection);
    const state = collectionState(collection, name);
    const first = state.errors[0];
    if (first !== undefined) {
      throw new DataError(first.code, first.reason, first.details);
    }
  }
  const previousSize = areaBytes(before);
  const nextSize = areaBytes(next);
  if (nextSize > DATA_LIMITS.area && nextSize >= previousSize) limit("area", nextSize);
  const writes: [string, JSONValue][] = [];
  for (const [k, value] of next) {
    if (!before.has(k) || canonicalJson(before.get(k), Infinity) !== canonicalJson(value, Infinity)) writes.push([k, value]);
  }
  limit("operation", writes.reduce((total, [, value]) => total + bytes(value), 0));
  const deletes = [...before.keys()].filter((k) => !next.has(k));
  if (writes.length === 0 && deletes.length === 0) return { changed: false };
  const root = doc.getMap<JSONValue>(DATA_KEY);
  doc.transact(() => {
    for (const k of deletes) root.delete(k);
    for (const [k, value] of writes) root.set(k, value);
  });
  return { changed: true };
}

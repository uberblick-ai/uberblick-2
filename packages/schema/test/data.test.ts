import * as Y from "yjs";
import { describe, expect, it } from "vitest";
import {
  applyDocData, canonicalJson, DATA_KEY, DATA_LIMITS, DataError,
  getAnnotationsMap, getBlocksFragment, getMetaMap, initDoc, readDocData,
  setKind, setStatus, tombstoneDirectoryEntry, upsertDirectoryEntry,
} from "../src/index.js";
import type { CollectionSchema, DataOperation, JSONObject } from "../src/index.js";
import { syncDocs } from "./helpers.js";

const UUID = "22222222-2222-4222-8222-222222222222";
const SCHEMA: CollectionSchema = { version: 1, schema: { type: "object" } };
function rig() {
  const doc = new Y.Doc();
  const directory = new Y.Doc();
  initDoc(doc, { uuid: UUID, title: "Data owner" });
  upsertDirectoryEntry(directory, { uuid: UUID, title: "Data owner", tags: [] });
  const apply = (ops: DataOperation[]) => applyDocData(doc, directory, ops);
  return { doc, directory, apply };
}
function failUnchanged(doc: Y.Doc, action: () => unknown): DataError {
  const before = Y.encodeStateAsUpdate(doc);
  let failure: unknown;
  try { action(); } catch (error) { failure = error; }
  expect(failure).toBeInstanceOf(DataError);
  expect(Buffer.from(Y.encodeStateAsUpdate(doc)).equals(Buffer.from(before))).toBe(true);
  return failure as DataError;
}
function dataKey(kind: string, name: string, id?: string) {
  return JSON.stringify(id === undefined ? [kind, name] : [kind, name, id]);
}
function recordAtLimit() { return { text: "x".repeat(DATA_LIMITS.record - 11) }; }

describe("document-owned data", () => {
  it("is optional, detached, preserves the other roots, and sorts ids by code point", () => {
    const { doc, apply } = rig();
    expect(readDocData(doc)).toBeNull();
    const meta = getMetaMap(doc).toJSON();
    const blocks = getBlocksFragment(doc).toJSON();
    const annotations = getAnnotationsMap(doc).toJSON();
    const value = { nested: { values: [1, { type: "minimum" }] } };
    apply([{ collection: "colon:/[]", schema: SCHEMA, upsert: ["😀", "\uE000", "2", "10"].map(id => ({ id, value })) }]);
    value.nested.values.push(99);
    const area = readDocData(doc)!;
    expect(area.collections[0]!.records.map(r => r.id)).toEqual(["10", "2", "\uE000", "😀"]);
    const readValue = area.collections[0]!.records[0]!.value as JSONObject;
    (readValue.nested as JSONObject).extra = true;
    expect(readDocData(doc)!.collections[0]!.records[0]!.value).toEqual({ nested: { values: [1, { type: "minimum" }] } });
    expect(getMetaMap(doc).toJSON()).toEqual(meta);
    expect(getBlocksFragment(doc).toJSON()).toEqual(blocks);
    expect(getAnnotationsMap(doc).toJSON()).toEqual(annotations);
    for (const value of doc.getMap(DATA_KEY).values()) expect(value).not.toBeInstanceOf(Y.AbstractType);
  });

  it("batches changed keys and skips identical records, schemas and full refreshes", () => {
    const { doc, apply } = rig();
    let updates = 0;
    const sizes: number[] = [];
    doc.on("update", (update: Uint8Array) => { updates++; sizes.push(update.byteLength); });
    const initial = Array.from({ length: 1000 }, (_, i) => ({ id: String(i), value: { a: i, b: [true] } }));
    apply([{ collection: "producer", schema: SCHEMA, upsert: initial }]);
    expect(updates).toBe(1);
    expect(apply([{ collection: "producer", schema: SCHEMA, replaceRecords: initial.map(r => ({ id: r.id, value: { b: [true], a: r.value.a } })) }])).toEqual({ changed: false });
    expect(updates).toBe(1);
    apply([{ collection: "producer", upsert: [{ id: "50", value: { a: 123, b: [true] } }] }]);
    expect(updates).toBe(2);
    expect(sizes[1]).toBeLessThan(250);
    expect(sizes[1]!).toBeLessThan(sizes[0]! / 100);
  });

  it("producer replacements and deletion preserve separate human dispositions", () => {
    const { doc, apply } = rig();
    apply([
      { collection: "producer", schema: SCHEMA, upsert: [{ id: "a", value: { score: 1 } }, { id: "b", value: {} }] },
      { collection: "human", schema: SCHEMA, upsert: [{ id: "a", value: { disposition: "keep" } }] },
    ]);
    const human = readDocData(doc)!.collections.find(c => c.name === "human");
    apply([{ collection: "producer", replaceRecords: [{ id: "c", value: { score: 3 } }] }]);
    expect(readDocData(doc)!.collections.find(c => c.name === "human")).toEqual(human);
    apply([{ collection: "producer", deleteCollection: true }]);
    expect(readDocData(doc)!.collections).toEqual([human]);
    apply([{ collection: "human", deleteCollection: true }]);
    expect(readDocData(doc)).toBeNull();
  });

  it("refuses incompatible schema changes, invalid records and missing schemas atomically", () => {
    const { doc, apply } = rig();
    const schema: CollectionSchema = { version: 1, schema: { type: "object", properties: { x: { type: "number" } }, required: ["x"], additionalProperties: false } };
    apply([{ collection: "a", schema, upsert: [{ id: "kept", value: { x: 1 } }] }]);
    const badRecord = failUnchanged(doc, () => apply([
      { collection: "new", schema: SCHEMA, upsert: [{ id: "okay", value: {} }] },
      { collection: "a", upsert: [{ id: "bad", value: { x: "wrong" } }] },
    ]));
    expect(badRecord).toMatchObject({ code: "data_record_invalid", details: { collection: "a", recordId: "bad", path: "/x" } });
    expect(failUnchanged(doc, () => apply([{ collection: "a", schema: { version: 1, schema: { ...schema.schema, properties: { x: { type: "string" } } } } }])).details).toMatchObject({ collection: "a", recordId: "kept" });
    expect(failUnchanged(doc, () => apply([{ collection: "orphan", upsert: [{ id: "a", value: {} }] }])).code).toBe("data_schema_invalid");
    expect(failUnchanged(doc, () => apply([{ collection: "a", schema: { version: 2, schema: { type: "object" } } as unknown as CollectionSchema }])).details).toMatchObject({ collection: "a", path: "/version" });
    apply([{ collection: "a", schema: { version: 1, schema: { type: "object", properties: { x: { type: "string" } } } }, replaceRecords: [{ id: "kept", value: { x: "migrated" } }] }]);
    expect(readDocData(doc)!.valid).toBe(true);
  });

  it("enforces archive and decided-content locks on every shared mutation", () => {
    const { doc, directory, apply } = rig();
    tombstoneDirectoryEntry(directory, UUID);
    expect(failUnchanged(doc, () => apply([{ collection: "a", schema: SCHEMA }])).code).toBe("doc_archived");
    const open = rig();
    setKind(open.doc, "decision");
    setStatus(open.doc, "decided");
    expect(failUnchanged(open.doc, () => open.apply([{ collection: "a", schema: SCHEMA }])).code).toBe("decision_read_only");
    const successor = rig();
    const topic = "33333333-3333-4333-8333-333333333333";
    upsertDirectoryEntry(successor.directory, { uuid: topic, title: "Topic", tags: [], kind: "decision", status: "open" });
    upsertDirectoryEntry(successor.directory, { uuid: UUID, title: "Successor", tags: [], kind: "decision", status: "open", topic });
    tombstoneDirectoryEntry(successor.directory, topic);
    expect(failUnchanged(successor.doc, () => successor.apply([{ collection: "a", schema: SCHEMA }])).code).toBe("doc_archived");
  });

  it("converges independent keys and reports incompatible schema/record winners without writes", () => {
    const { doc: a, directory } = rig();
    const b = new Y.Doc();
    syncDocs(a, b);
    a.clientID = 101;
    b.clientID = 202;
    applyDocData(a, directory, [{ collection: "c", schema: { version: 1, schema: { type: "object", properties: { x: { type: "string" } } } }, upsert: [{ id: "a", value: { x: "first" } }] }]);
    applyDocData(b, directory, [{ collection: "c", schema: { version: 1, schema: { type: "object", properties: { x: { type: "number" } } } }, upsert: [{ id: "b", value: { x: 2 } }] }, { collection: "other", schema: SCHEMA }]);
    syncDocs(a, b);
    expect(readDocData(a)).toEqual(readDocData(b));
    const before = Y.encodeStateAsUpdate(a);
    expect(readDocData(a)!.collections[0]).toMatchObject({ name: "c", valid: false, invalidRecordIds: ["a"] });
    expect(Buffer.from(Y.encodeStateAsUpdate(a)).equals(Buffer.from(before))).toBe(true);
    failUnchanged(a, () => applyDocData(a, directory, [{ collection: "c", upsert: [{ id: "b", value: { x: 3 } }] }]));
    applyDocData(a, directory, [{ collection: "c", deleteRecords: ["a"] }]);
    expect(readDocData(a)!.valid).toBe(true);
  });

  it("same-record competitors have a deterministic winner while other records merge", () => {
    const { doc: a, directory, apply } = rig();
    apply([{ collection: "c", schema: SCHEMA, upsert: [{ id: "same", value: {} }] }]);
    const b = new Y.Doc();
    syncDocs(a, b);
    a.clientID = 101;
    b.clientID = 202;
    applyDocData(a, directory, [{ collection: "c", upsert: [{ id: "same", value: { writer: "a" } }, { id: "a", value: {} }] }]);
    applyDocData(b, directory, [{ collection: "c", upsert: [{ id: "same", value: { writer: "b" } }, { id: "b", value: {} }] }]);
    syncDocs(a, b);
    expect(readDocData(a)).toEqual(readDocData(b));
    expect(readDocData(a)!.collections[0]!.records).toEqual([{ id: "a", value: {} }, { id: "b", value: {} }, { id: "same", value: { writer: "b" } }]);
  });

  it("reports concurrent schema deletion and unsupported versions and permits explicit repairs", () => {
    const { doc: a, directory, apply } = rig();
    apply([{ collection: "c", schema: SCHEMA }]);
    const b = new Y.Doc();
    syncDocs(a, b);
    apply([{ collection: "c", deleteCollection: true }]);
    applyDocData(b, directory, [{ collection: "c", upsert: [{ id: "unseen", value: { x: 1 } }] }]);
    syncDocs(a, b);
    expect(readDocData(a)!.collections[0]).toMatchObject({ schema: null, valid: false, invalidRecordIds: ["unseen"] });
    applyDocData(a, directory, [{ collection: "c", schema: SCHEMA }]);
    a.getMap(DATA_KEY).set(dataKey("schema", "c"), { version: 99, schema: { type: "object" } });
    const before = Y.encodeStateAsUpdate(a);
    expect(readDocData(a)!.collections[0]).toMatchObject({ valid: false, invalidRecordIds: ["unseen"], schema: { version: 99 } });
    expect(Buffer.from(Y.encodeStateAsUpdate(a)).equals(Buffer.from(before))).toBe(true);
    applyDocData(a, directory, [{ collection: "c", deleteCollection: true }]);
    expect(readDocData(a)).toBeNull();
    a.getMap(DATA_KEY).set(dataKey("record", "c", "orphan"), {});
    applyDocData(a, directory, [{ collection: "c", deleteRecords: ["orphan"] }]);
    expect(readDocData(a)).toBeNull();
  });

  it("enforces exact UTF-8 record and schema budgets before writing", () => {
    const { doc, apply } = rig();
    apply([{ collection: "c", schema: SCHEMA, upsert: [{ id: "at-limit", value: recordAtLimit() }] }]);
    expect(failUnchanged(doc, () => apply([{ collection: "c", upsert: [{ id: "large", value: { text: "x".repeat(DATA_LIMITS.record - 10) } }] }]))).toMatchObject({ code: "data_limit_exceeded", details: { collection: "c", recordId: "large", limit: "record", value: 65536, attempted: 65537 } });
    const envelope = { version: 1, schema: { type: "object", properties: { x: { enum: [""] } } } } as const;
    const overhead = new TextEncoder().encode(canonicalJson(envelope)).byteLength;
    const schema: CollectionSchema = { version: 1, schema: { type: "object", properties: { x: { enum: ["é".repeat(Math.floor((DATA_LIMITS.schema - overhead) / 2))] } } } };
    apply([{ collection: "s", schema }]);
    schema.schema.properties!.x!.enum = ["é".repeat(DATA_LIMITS.schema)];
    expect(failUnchanged(doc, () => apply([{ collection: "s", schema }])).details).toMatchObject({ collection: "s", limit: "schema", value: 65536 });
  });

  it("counts only changed schema/record values toward the operation budget", () => {
    const { doc, apply } = rig();
    apply([{ collection: "c", schema: SCHEMA }]);
    const sixteen = Array.from({ length: 16 }, (_, i) => ({ id: String(i), value: recordAtLimit() }));
    apply([{ collection: "c", upsert: sixteen }]);
    expect(apply([{ collection: "c", schema: SCHEMA, replaceRecords: sixteen }])).toEqual({ changed: false });
    const seventeen = Array.from({ length: 17 }, (_, i) => ({ id: `changed-${i}`, value: recordAtLimit() }));
    expect(failUnchanged(doc, () => apply([{ collection: "c", upsert: seventeen }]))).toMatchObject({ code: "data_limit_exceeded", details: { limit: "operation", value: 1048576, attempted: 1114112 } });
  });

  it("reads over-depth and oversized merged values without repair and permits their deletion", () => {
    const { doc, apply } = rig();
    apply([{ collection: "c", schema: SCHEMA }]);
    let nested: JSONObject = {};
    for (let depth = 1; depth < 33; depth++) nested = { child: nested };
    expect(failUnchanged(doc, () => apply([{ collection: "c", upsert: [{ id: "deep", value: nested }] }])).details).toMatchObject({ collection: "c", recordId: "deep", limit: "nesting_depth", value: 32, attempted: 33 });
    doc.transact(() => {
      doc.getMap(DATA_KEY).set(dataKey("record", "c", "deep"), nested);
      doc.getMap(DATA_KEY).set(dataKey("record", "c", "large"), { text: "x".repeat(DATA_LIMITS.record) });
    });
    const before = Y.encodeStateAsUpdate(doc);
    const state = readDocData(doc)!;
    expect(state.collections[0]!.invalidRecordIds).toEqual(["deep", "large"]);
    expect(state.collections[0]!.records[0]!.value).toEqual(nested);
    expect(Buffer.from(Y.encodeStateAsUpdate(doc)).equals(Buffer.from(before))).toBe(true);
    apply([{ collection: "c", deleteRecords: ["deep", "large"] }]);
    expect(readDocData(doc)!.valid).toBe(true);
  });

  it("reports unknown storage keys while preserving them through known-collection writes", () => {
    const { doc, apply } = rig();
    doc.getMap(DATA_KEY).set("future-layout", { nested: ["retained"] });
    apply([{ collection: "c", schema: SCHEMA }]);
    const state = readDocData(doc)!;
    expect(state.valid).toBe(false);
    expect(state.errors[0]).toMatchObject({ code: "data_invalid_input", details: { key: "future-layout" } });
    expect(state.collections[0]!.valid).toBe(true);
    apply([{ collection: "c", deleteCollection: true }]);
    expect(doc.getMap(DATA_KEY).get("future-layout")).toEqual({ nested: ["retained"] });
  });

  it("bounds live area bytes, reports merged excess and allows incremental shrinking", () => {
    const { doc, apply } = rig();
    apply([{ collection: "c", schema: SCHEMA }]);
    for (let batch = 0; batch < 3; batch++) apply([{ collection: "c", upsert: Array.from({ length: 16 }, (_, i) => ({ id: String(batch * 16 + i), value: recordAtLimit() })) }]);
    apply([{ collection: "c", upsert: Array.from({ length: 15 }, (_, i) => ({ id: String(48 + i), value: recordAtLimit() })) }]);
    expect(failUnchanged(doc, () => apply([{ collection: "c", upsert: [{ id: "63", value: recordAtLimit() }] }])).details).toMatchObject({ limit: "area", value: 4194304 });
    doc.transact(() => {
      for (let i = 63; i < 66; i++) doc.getMap(DATA_KEY).set(dataKey("record", "c", String(i)), recordAtLimit());
    });
    const before = Y.encodeStateAsUpdate(doc);
    const area = readDocData(doc)!;
    expect(area.bytes).toBeGreaterThan(DATA_LIMITS.area);
    expect(area.collections[0]!.valid).toBe(false);
    expect(area.collections[0]!.invalidRecordIds).toHaveLength(66);
    expect(Buffer.from(Y.encodeStateAsUpdate(doc)).equals(Buffer.from(before))).toBe(true);
    apply([{ collection: "c", deleteRecords: ["65"] }]);
    expect(readDocData(doc)!.bytes).toBeGreaterThan(DATA_LIMITS.area);
    apply([{ collection: "c", deleteRecords: ["64", "63"] }]);
    expect(readDocData(doc)!.valid).toBe(true);
  });

  it("keeps retained Yjs history distinct from live JSON size and imposes no record-count ceiling", () => {
    const { doc, apply } = rig();
    apply([{ collection: "c", schema: SCHEMA, upsert: Array.from({ length: 10000 }, (_, i) => ({ id: String(i), value: {} })) }]);
    const live = readDocData(doc)!.bytes;
    const encoded = Y.encodeStateAsUpdate(doc).byteLength;
    for (let pass = 0; pass < 3; pass++) apply([{ collection: "c", upsert: Array.from({ length: 1000 }, (_, i) => ({ id: String(pass * 1000 + i), value: { pass } })) }]);
    apply([{ collection: "c", replaceRecords: Array.from({ length: 10000 }, (_, i) => ({ id: String(i), value: {} })) }]);
    expect(readDocData(doc)!.bytes).toBe(live);
    expect(Y.encodeStateAsUpdate(doc).byteLength).toBeGreaterThan(encoded);
  });
});

/** Dedicated data tools keep ordinary reads light and reuse shared validation. */
import {
  canonicalJson,
  compareCodePoints,
  createTagCatalogEntry,
  DATA_KEY,
  DATA_LIMITS,
  readDocData,
  setTags,
} from "@uberblick/schema";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import * as Y from "yjs";
import { removeTempDirs, startServer, testConfig, WORKSPACE } from "./helpers.js";
import type { Rig } from "./helpers.js";

const rigs: Rig[] = [];
const textSchema = {
  version: 1,
  schema: {
    type: "object",
    properties: { text: { type: "string" } },
    required: ["text"],
    additionalProperties: false,
  },
};
const objectSchema = { version: 1, schema: { type: "object" } };

async function local(): Promise<Rig> {
  const rig = await startServer(testConfig());
  rigs.push(rig);
  return rig;
}

async function create(rig: Rig, fields: Record<string, unknown> = {}) {
  return rig.ok("create_doc", {
    title: "Data tool fixture",
    description: "Synthetic data beside ordinary prose.",
    blocks: [{ type: "paragraph", text: "A searchable prose marker." }],
    ...fields,
  });
}

function document(rig: Rig, uuid: string): Y.Doc {
  return rig.instance.replicas.replica(uuid).doc;
}

function state(rig: Rig, uuid: string) {
  return {
    document: Y.encodeStateAsUpdate(document(rig, uuid)),
    directory: Y.encodeStateAsUpdate(rig.instance.replicas.directory().doc),
    log: rig.instance.store.logSize(),
  };
}

function pageBytes(records: { id: string; value: unknown }[]): number {
  return new TextEncoder().encode(canonicalJson(records, Infinity)).byteLength;
}

async function refuse(
  rig: Rig,
  uuid: string,
  operations: unknown,
  error: string,
  details: Record<string, unknown> = {},
) {
  const before = state(rig, uuid);
  const result = await rig.call("update_data", { uuid, operations });
  expect(result).toMatchObject({ isError: true, payload: {
    error, applied: false, partial: false, synced: false, ...details,
  } });
  expect(state(rig, uuid)).toEqual(before);
  return result.payload;
}

afterEach(async () => {
  for (const rig of rigs.splice(0)) await rig.close();
});
afterAll(removeTempDirs);

describe("dedicated document data MCP tools", () => {
  it("keeps ordinary reads unchanged without data and carries only names and counts with data", async () => {
    const rig = await local();
    const { uuid } = await create(rig);
    const original = await rig.ok("get_doc", { uuid });
    expect(original).not.toHaveProperty("data");
    expect(await rig.ok("get_data", { uuid })).toEqual({ uuid, data: null });
    expect(await rig.ok("get_doc", { uuid })).toEqual(original);
    const listing = await rig.ok("list_docs");
    const search = await rig.ok("search", { query: "searchable prose marker" });
    const markdown = await rig.ok("export_markdown", { uuid });
    const written = await rig.ok("update_data", { uuid, operations: [{
      collection: "observations",
      schema: textSchema,
      upsert: [{ id: "row-a", value: { text: "quartzneedledataonly" } }],
    }] });
    expect(written).toMatchObject({
      uuid, changed: true, applied: true, synced: false,
      collections: [{ name: "observations", recordCount: 1, deleted: false }],
      hub: expect.any(Object),
    });
    expect(JSON.stringify(written)).not.toContain("quartzneedledataonly");
    expect(written).not.toHaveProperty("schema");
    expect(written).not.toHaveProperty("records");
    expect(await rig.ok("get_doc", { uuid })).toEqual({
      ...original,
      data: { collections: [{ name: "observations", recordCount: 1 }], readWith: "get_data" },
    });
    const summary = await rig.ok("get_data", { uuid });
    expect(summary).toEqual({ uuid, data: {
      collections: [{ name: "observations", recordCount: 1, valid: true, invalidRecordCount: 0 }],
      bytes: readDocData(document(rig, uuid))?.bytes,
      valid: true, errorCount: 0,
    } });
    expect(JSON.stringify(summary)).not.toContain("quartzneedledataonly");
    expect(JSON.stringify(summary)).not.toContain("schema");
    expect(await rig.ok("list_docs")).toEqual(listing);
    expect(await rig.ok("search", { query: "searchable prose marker" })).toEqual(search);
    expect((await rig.ok("search", { query: "quartzneedledataonly" })).hits).toEqual([]);
    expect(await rig.ok("export_markdown", { uuid })).toEqual({
      ...markdown,
      markdown: `${markdown.markdown}\n> Structured document data is omitted from this Markdown export.\n`,
    });
    const missing = await rig.call("get_data", { uuid, collection: "absent" });
    expect(missing).toMatchObject({ isError: true, payload: {
      error: "data_collection_not_found", recovery: expect.stringMatching(/get_data.*collection/i),
    } });
    await rig.ok("update_data", { uuid, operations: [{ collection: "observations", deleteCollection: true }] });
    expect(await rig.ok("get_doc", { uuid })).toEqual(original);
    expect(await rig.ok("get_data", { uuid })).toEqual({ uuid, data: null });
  });

  it("reads 4,432 observations exactly once across bounded cursors without enlarging ordinary reads", async () => {
    const rig = await local();
    const { uuid } = await create(rig);
    const records = Array.from({ length: 4_432 }, (_, index) => ({
      id: `api-${String(index).padStart(5, "0")}`,
      value: { text: `observation-${index} ${"x".repeat(570)}` },
    }));
    for (let start = 0; start < records.length; start += 1_000) {
      await rig.ok("update_data", { uuid, operations: [{
        collection: "observations", ...(start === 0 ? { schema: textSchema } : {}),
        upsert: records.slice(start, start + 1_000).reverse(),
      }] });
    }
    await rig.ok("update_data", { uuid, operations: [{
      collection: "dispositions", schema: textSchema,
      upsert: [{ id: "api-00001", value: { text: "reviewed" } }],
    }] });
    const ordinary = await rig.ok("get_doc", { uuid });
    expect(ordinary.data).toEqual({ collections: [
      { name: "dispositions", recordCount: 1 }, { name: "observations", recordCount: 4_432 },
    ], readWith: "get_data" });
    expect(JSON.stringify(ordinary.data).length).toBeLessThan(200);
    const initial = await rig.ok("get_data", { uuid, collection: "observations" });
    expect(initial.records).toHaveLength(100);
    expect(initial.bytes).toBe(pageBytes(initial.records.map(({ id, value }: { id: string; value: unknown }) => ({ id, value }))));
    expect(initial.bytes).toBeLessThanOrEqual(64 * 1_024);
    const summary = await rig.ok("get_data", { uuid });
    const beforeReads = state(rig, uuid);
    for (const collection of summary.data.collections) {
      let after: string | undefined;
      const read: { id: string; value: unknown }[] = [];
      do {
        const page = await rig.ok("get_data", {
          uuid, collection: collection.name, limit: 1_000, max_bytes: 1_024 * 1_024,
          ...(after === undefined ? {} : { after }),
        });
        expect(page.records.length).toBeGreaterThan(0);
        expect(page.records.length).toBeLessThanOrEqual(1_000);
        expect(page.bytes).toBeLessThanOrEqual(1_024 * 1_024);
        expect(page.records.every((record: { valid: boolean }) => record.valid)).toBe(true);
        read.push(...page.records.map(({ id, value }: { id: string; value: unknown }) => ({ id, value })));
        expect(page.complete).toBe(page.next_after === null);
        if (page.complete) break;
        expect(page.next_after).toBe(page.records.at(-1).id);
        after = page.next_after;
      } while (read.length <= collection.recordCount);
      expect(read).toHaveLength(collection.recordCount);
      expect(new Set(read.map(({ id }) => id)).size).toBe(collection.recordCount);
      expect(read).toEqual(collection.name === "observations" ? records : [
        { id: "api-00001", value: { text: "reviewed" } },
      ]);
    }
    expect(state(rig, uuid)).toEqual(beforeReads);
  });

  it("orders by Unicode code point, applies exclusive cursors and filters, and permits schema-only reads", async () => {
    const rig = await local();
    const { uuid } = await create(rig);
    const ids = ["😀", "\ue000", "a", "🦊", "a/child"];
    await rig.ok("update_data", { uuid, operations: [{
      collection: "unicode", schema: objectSchema,
      upsert: ids.map(id => ({ id, value: { nested: [id] } })),
    }] });
    const ordered = [...ids].sort(compareCodePoints);
    const first = await rig.ok("get_data", { uuid, collection: "unicode", limit: 2 });
    expect(first.records.map((record: { id: string }) => record.id)).toEqual(ordered.slice(0, 2));
    expect(first.next_after).toBe(ordered[1]);
    const second = await rig.ok("get_data", { uuid, collection: "unicode", after: first.next_after, limit: 2 });
    expect(second.records.map((record: { id: string }) => record.id)).toEqual(ordered.slice(2, 4));
    const gap = await rig.ok("get_data", { uuid, collection: "unicode", after: "b" });
    expect(gap.records.map((record: { id: string }) => record.id)).toEqual(ordered.slice(2));
    const filtered = await rig.ok("get_data", {
      uuid, collection: "unicode", ids: ["missing", "🦊", "\ue000", "other-missing"], limit: 1,
    });
    expect(filtered.records.map((record: { id: string }) => record.id)).toEqual(["\ue000"]);
    expect([...filtered.missing_ids].sort()).toEqual(["missing", "other-missing"].sort());
    const tail = await rig.ok("get_data", {
      uuid, collection: "unicode", ids: ["missing", "🦊", "\ue000", "other-missing"],
      after: filtered.next_after,
    });
    expect(tail.records.map((record: { id: string }) => record.id)).toEqual(["🦊"]);
    expect(tail).toMatchObject({ complete: true, next_after: null });
    const before = state(rig, uuid);
    const schemaOnly = await rig.ok("get_data", { uuid, collection: "unicode", limit: 0 });
    expect(schemaOnly).toMatchObject({ schema: objectSchema, records: [], recordCount: ids.length, valid: true });
    expect(state(rig, uuid)).toEqual(before);
    first.records[0].value.nested.push("client-only");
    expect((await rig.ok("get_data", { uuid, collection: "unicode", ids: ["a"] })).records[0].value)
      .toEqual({ nested: ["a"] });
    for (const args of [
      { limit: -1 }, { limit: 1_001 }, { max_bytes: 1_048_577 },
      { ids: Array.from({ length: 1_001 }, (_, index) => `id-${index}`) },
    ]) {
      expect((await rig.call("get_data", { uuid, collection: "unicode", ...args })).isError).toBe(true);
    }
  });

  it("bounds canonical record JSON at the byte boundary and always returns the first remaining record", async () => {
    const rig = await local();
    const { uuid } = await create(rig);
    const nearLimit = { id: "a", value: { text: "x".repeat(65_490) } };
    const small = { id: "b", value: { text: "tail" } };
    await rig.ok("update_data", { uuid, operations: [{
      collection: "boundary", schema: textSchema, upsert: [nearLimit, small],
    }] });
    const exact = pageBytes([nearLimit]);
    expect(exact).toBeLessThan(65_536);
    expect(pageBytes([nearLimit, small])).toBeGreaterThan(65_536);
    const defaultPage = await rig.ok("get_data", { uuid, collection: "boundary" });
    expect(defaultPage.records.map((record: { id: string }) => record.id)).toEqual(["a"]);
    expect(defaultPage.bytes).toBeLessThanOrEqual(65_536);
    const page = await rig.ok("get_data", { uuid, collection: "boundary", max_bytes: exact });
    expect(page.records.map((record: { id: string }) => record.id)).toEqual(["a"]);
    expect(page.bytes).toBe(exact);
    expect(page).toMatchObject({ next_after: "a", complete: false });
    const tail = await rig.ok("get_data", { uuid, collection: "boundary", after: "a", max_bytes: 1 });
    expect(tail.records.map((record: { id: string }) => record.id)).toEqual(["b"]);
    expect(tail.bytes).toBeGreaterThan(1);
    expect(tail).toMatchObject({ next_after: null, complete: true });
    const longId = "a".repeat(100_000);
    await rig.ok("update_data", { uuid, operations: [{
      collection: "long-id", schema: objectSchema,
      upsert: [{ id: longId, value: {} }, { id: "z", value: {} }],
    }] });
    const oversized = await rig.ok("get_data", { uuid, collection: "long-id" });
    expect(oversized.records.map((record: { id: string }) => record.id)).toEqual([longId]);
    expect(oversized.bytes).toBeGreaterThan(65_536);
    expect(oversized).toMatchObject({ next_after: longId, complete: false });
    expect((await rig.ok("get_data", { uuid, collection: "long-id", after: longId })).records)
      .toMatchObject([{ id: "z", value: {} }]);
  });

  it("uses collection operation order, preserves human dispositions, and emits no update for an identical refresh", async () => {
    const rig = await local();
    const { uuid } = await create(rig);
    await rig.ok("update_data", { uuid, operations: [
      { collection: "producer", schema: textSchema, upsert: [
        { id: "row-a", value: { text: "old producer value" } },
        { id: "row-b", value: { text: "retired producer value" } },
      ] },
      { collection: "dispositions", schema: textSchema, upsert: [
        { id: "row-a", value: { text: "human reviewed" } },
      ] },
    ] });
    const dispositions = await rig.ok("get_data", { uuid, collection: "dispositions" });
    const operations = [{
      collection: "producer", schema: textSchema,
      replaceRecords: [{ id: "row-a", value: { text: "replacement" } }],
      deleteRecords: ["row-a"],
      upsert: [{ id: "row-a", value: { text: "refreshed producer value" } }],
    }];
    const refreshed = await rig.ok("update_data", { uuid, operations });
    expect(refreshed).toMatchObject({ changed: true, collections: [
      { name: "producer", recordCount: 1, deleted: false },
    ] });
    expect(JSON.stringify(refreshed)).not.toContain("refreshed producer value");
    expect((await rig.ok("get_data", { uuid, collection: "producer" })).records)
      .toMatchObject([{ id: "row-a", value: { text: "refreshed producer value" } }]);
    expect(await rig.ok("get_data", { uuid, collection: "dispositions" })).toEqual(dispositions);
    const room = `${WORKSPACE}/${uuid}`;
    const before = state(rig, uuid);
    const count = rig.instance.store.updateCount(room);
    expect(await rig.ok("update_data", { uuid, operations })).toMatchObject({ changed: false, applied: true });
    expect(rig.instance.store.updateCount(room)).toBe(count);
    expect(state(rig, uuid)).toEqual(before);
    const deleted = await rig.ok("update_data", { uuid, operations: [{ collection: "producer", deleteCollection: true }] });
    expect(deleted.collections).toEqual([{ name: "producer", recordCount: 0, deleted: true }]);
    expect(await rig.ok("get_data", { uuid, collection: "dispositions" })).toEqual(dispositions);
  });

  it("refuses invalid batches atomically with shared codes and unaltered JSON Pointer diagnostics", async () => {
    const rig = await local();
    const { uuid } = await create(rig);
    await rig.ok("update_data", { uuid, operations: [{
      collection: "observations", schema: textSchema,
      upsert: [{ id: "row-a", value: { text: "unchanged" } }],
    }] });
    await refuse(rig, uuid, [{ collection: "observations", schema: { ...textSchema, version: 2 } }], "data_schema_invalid", {
      collection: "observations", path: "/version",
    });
    await refuse(rig, uuid, [{ collection: "observations", upsert: [{ id: "bad", value: { text: 3 } }] }], "data_record_invalid", {
      collection: "observations", recordId: "bad", path: "/text",
    });
    await refuse(rig, uuid, [{ collection: "observations", schema: {
      version: 1, schema: { type: "object", properties: { text: { type: "integer" } }, required: ["text"] },
    } }], "data_record_invalid", { collection: "observations", recordId: "row-a", path: "/text" });
    await refuse(rig, uuid, [
      { collection: "new", schema: objectSchema, upsert: [{ id: "would-write", value: {} }] },
      { collection: "observations", upsert: [{ id: "bad", value: null }] },
    ], "data_record_invalid");
    await refuse(rig, uuid, [{ collection: "observations" }, { collection: "observations" }], "data_invalid_input");
    await refuse(rig, uuid, [{ collection: "observations", upsert: [
      { id: "same", value: { text: "first" } }, { id: "same", value: { text: "second" } },
    ] }], "data_invalid_input");
    await refuse(rig, uuid, [{ collection: "observations", deleteCollection: true, upsert: [] }], "data_invalid_input");
    await refuse(rig, uuid, [{ collection: "observations", upsert: [{
      id: "unsafe", value: JSON.parse('{"text":"safe","__proto__":{"polluted":true}}'),
    }] }], "data_invalid_input", { path: "/__proto__", collection: "observations", recordId: "unsafe" });
    await refuse(rig, uuid, [{ collection: "observations", schema: JSON.parse(
      '{"version":1,"schema":{"type":"object","properties":{"__proto__":{"type":"string"}}}}',
    ) }], "data_schema_invalid", { path: "/schema/properties/__proto__", collection: "observations" });
    await refuse(rig, uuid, [{ collection: "observations", upsert: [{
      id: "oversized", value: { text: "x".repeat(DATA_LIMITS.record) },
    }] }], "data_limit_exceeded", { limit: "record" });
    await refuse(rig, uuid, [{ collection: "observations", upsert: Array.from({ length: 18 }, (_, index) => ({
      id: `bulk-${index}`, value: { text: "x".repeat(60_000) },
    })) }], "data_limit_exceeded", { limit: "operation" });
  });

  it("gates writes on guidance and keeps archived and decided data readable but immutable", async () => {
    const rig = await local();
    const guide = await create(rig, { title: "Guidance" });
    const target = await create(rig);
    const marker = "5a7808ea-1c79-4330-af35-3f67f9f38a3b";
    createTagCatalogEntry(rig.instance.replicas.settings().doc, "guidance", marker);
    setTags(document(rig, guide.uuid), [marker]);
    const operations = [{ collection: "observations", schema: objectSchema, upsert: [{ id: "row-a", value: {} }] }];
    await refuse(rig, target.uuid, operations, "guidance_required");
    expect(await rig.ok("get_data", { uuid: target.uuid })).toEqual({ uuid: target.uuid, data: null });
    await rig.ok("get_doc", { uuid: guide.uuid });
    await rig.ok("update_data", { uuid: target.uuid, operations });
    const archivedData = await rig.ok("get_data", { uuid: target.uuid, collection: "observations" });
    await rig.ok("archive_doc", { uuid: target.uuid });
    expect(await rig.ok("get_data", { uuid: target.uuid, collection: "observations" })).toEqual(archivedData);
    expect((await rig.ok("get_doc", { uuid: target.uuid })).data.collections).toEqual([{ name: "observations", recordCount: 1 }]);
    await refuse(rig, target.uuid, operations, "doc_archived");
    const decision = await create(rig, { kind: "decision", title: "Data decision" });
    await rig.ok("update_data", { uuid: decision.uuid, operations });
    await rig.ok("set_status", { uuid: decision.uuid, status: "decided" });
    const decidedData = await rig.ok("get_data", { uuid: decision.uuid, collection: "observations" });
    await refuse(rig, decision.uuid, operations, "decision_read_only");
    expect(await rig.ok("get_data", { uuid: decision.uuid, collection: "observations" })).toEqual(decidedData);
  });

  it("observes merged schemas and invalid records without repairing them or leaking off-page diagnostics", async () => {
    const rig = await local();
    const { uuid } = await create(rig);
    const target = document(rig, uuid);
    const base = Y.encodeStateAsUpdate(target);
    const left = new Y.Doc();
    const right = new Y.Doc();
    try {
      Y.applyUpdate(left, base);
      Y.applyUpdate(right, base);
      left.clientID = 1;
      right.clientID = 2;
      left.getMap(DATA_KEY).set(JSON.stringify(["schema", "merged"]), textSchema);
      left.getMap(DATA_KEY).set(JSON.stringify(["record", "merged", "row-a"]), { text: "writer one" });
      const secondSchema = { version: 1, schema: {
        type: "object", properties: { count: { type: "integer" } }, required: ["count"], additionalProperties: false,
      } };
      right.getMap(DATA_KEY).set(JSON.stringify(["schema", "merged"]), secondSchema);
      right.getMap(DATA_KEY).set(JSON.stringify(["record", "merged", "row-b"]), { count: 2 });
      Y.applyUpdate(target, Y.encodeStateAsUpdate(left));
      Y.applyUpdate(target, Y.encodeStateAsUpdate(right));
      target.getMap(DATA_KEY).set(JSON.stringify(["record", "missing", "row-c"]), { text: "no schema" });
      target.getMap(DATA_KEY).set(JSON.stringify(["schema", "unsupported"]), { version: 2, schema: { type: "object" } });
      target.getMap(DATA_KEY).set(JSON.stringify(["record", "unsupported", "row-d"]), { text: "future schema" });
      const observed = readDocData(target);
      const before = state(rig, uuid);
      const summary = await rig.ok("get_data", { uuid });
      expect(summary.data).toMatchObject({ bytes: observed?.bytes, valid: false });
      expect(summary.data.collections).toEqual([
        { name: "merged", recordCount: 2, valid: false, invalidRecordCount: 1 },
        { name: "missing", recordCount: 1, valid: false, invalidRecordCount: 1 },
        { name: "unsupported", recordCount: 1, valid: false, invalidRecordCount: 1 },
      ]);
      expect(JSON.stringify(summary)).not.toContain("row-a");
      expect(JSON.stringify(summary)).not.toContain("writer one");
      const first = await rig.ok("get_data", { uuid, collection: "merged", limit: 1 });
      expect(first.schema).toEqual(secondSchema);
      expect(first.errors).toEqual([]);
      expect(first.records).toMatchObject([{ id: "row-a", value: { text: "writer one" }, valid: false, errors: [
        { code: "data_record_invalid", details: { collection: "merged", recordId: "row-a", path: "/count" } },
      ] }]);
      const second = await rig.ok("get_data", { uuid, collection: "merged", after: first.next_after });
      expect(second.records).toMatchObject([{ id: "row-b", value: { count: 2 }, valid: true, errors: [] }]);
      expect(second.errors).toEqual([]);
      expect(JSON.stringify(second)).not.toContain("row-a");
      const missing = await rig.ok("get_data", { uuid, collection: "missing" });
      expect(missing).toMatchObject({ schema: null, valid: false, errors: [
        { code: "data_schema_invalid", details: { collection: "missing", path: "/schema" } },
      ], records: [{ id: "row-c", valid: false, errors: [{ code: "data_record_invalid" }] }] });
      const unsupported = await rig.ok("get_data", { uuid, collection: "unsupported" });
      expect(unsupported).toMatchObject({ schema: { version: 2 }, valid: false, errors: [
        { code: "data_schema_invalid", details: { collection: "unsupported", path: "/version" } },
      ], records: [{ id: "row-d", valid: false, errors: [{ code: "data_record_invalid" }] }] });
      expect(state(rig, uuid)).toEqual(before);
    } finally {
      left.destroy();
      right.destroy();
    }
  });

  it("reports an over-limit merged area with counts and page-local explanations without writing", async () => {
    const rig = await local();
    const { uuid } = await create(rig);
    const target = document(rig, uuid);
    target.transact(() => {
      const data = target.getMap(DATA_KEY);
      data.set(JSON.stringify(["schema", "oversized"]), textSchema);
      for (let index = 0; index < 70; index += 1) {
        data.set(JSON.stringify(["record", "oversized", `row-${String(index).padStart(2, "0")}`]), {
          text: "x".repeat(64_000),
        });
      }
    });
    const before = state(rig, uuid);
    const summary = await rig.ok("get_data", { uuid });
    expect(summary.data).toMatchObject({
      valid: false, bytes: expect.any(Number),
      collections: [{ name: "oversized", recordCount: 70, valid: false, invalidRecordCount: 70 }],
    });
    expect(summary.data.bytes).toBeGreaterThan(DATA_LIMITS.area);
    expect(JSON.stringify(summary)).not.toContain("row-00");
    const page = await rig.ok("get_data", { uuid, collection: "oversized", limit: 1 });
    expect(page.errors).toMatchObject([{ code: "data_limit_exceeded", details: { limit: "area" } }]);
    expect(page.records).toMatchObject([{ id: "row-00", valid: false, errors: [
      { code: "data_limit_exceeded", details: { limit: "area" } },
    ] }]);
    expect(state(rig, uuid)).toEqual(before);
  });
});

import { DATA_KEY, getBlocks } from "@uberblick/schema";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import * as Y from "yjs";
import { removeTempDirs, startServer } from "./core-helpers.js";
import type { Rig } from "./core-helpers.js";

const rigs: Rig[] = [];
const line = {
  version: 1, type: "line", collection: "observations",
  x: { field: "day", type: "date" }, y: [{ field: "count" }],
};
const table = {
  version: 1, type: "table", collection: "observations",
  columns: [{ field: "count", format: "number" }],
};
const scatter = {
  version: 1, type: "scatter", collection: "observations",
  x: { field: "cost" }, y: { field: "quality", unit: "%", lower: "low", upper: "high" },
  label: "name", group: "tier", details: [{ field: "source", format: "link" }],
};

async function local(): Promise<Rig> {
  const rig = await startServer();
  rigs.push(rig);
  return rig;
}

async function create(rig: Rig) {
  return rig.ok("create_doc", {
    title: "Chart feedback", description: "Feedback describes the chart's current local data.",
  });
}

async function insert(rig: Rig, uuid: string, mapping: unknown) {
  const result = await rig.ok("insert_block", {
    uuid, blocks: [{ type: "chart", text: JSON.stringify(mapping) }],
  });
  return result.blocks[0].chart;
}

afterEach(async () => {
  vi.restoreAllMocks();
  for (const rig of rigs.splice(0)) await rig.close();
});
afterAll(removeTempDirs);

describe("chart source write summaries", () => {
  it("summarizes every chart seed without refusing invalid JSON or summarizing ordinary blocks", async () => {
    const rig = await local();
    const created = await rig.ok("create_doc", {
      title: "Seeded charts", description: "Charts may precede their collection.",
      blocks: [
        { type: "paragraph", text: "Context" },
        { type: "chart", text: JSON.stringify(line) },
        { type: "chart", text: "{ incomplete" },
        { type: "chart", text: JSON.stringify(table) },
      ],
    });
    expect(created).toMatchObject({ applied: true, synced: expect.any(Boolean), hub: { status: expect.any(String) } });
    expect(created.blocks[0]).toEqual({ id: expect.any(String), rev: expect.any(String) });
    expect(created.blocks[1].chart).toEqual({
      status: "collection-absent", message: "Chart collection “observations” is absent.",
      collections: [], warnings: [expect.any(String)],
    });
    expect(created.blocks[2].chart).toEqual({
      status: "invalid-configuration", message: "Invalid chart configuration: source must be JSON.",
      warnings: [expect.any(String)],
    });
    expect(created.blocks[3].chart).toEqual({
      status: "collection-absent", message: "Table collection “observations” is absent.",
      collections: [], warnings: [expect.any(String)],
    });
    const read = await rig.ok("get_doc", { uuid: created.uuid });
    expect(read.blocks.map((block: { text: string }) => block.text)).toEqual([
      "Context", JSON.stringify(line), "{ incomplete", JSON.stringify(table),
    ]);
    for (const block of read.blocks) expect(block).not.toHaveProperty("chart");
  });

  it("counts numeric points and distinct plotted records inside the selected window, without returning data", async () => {
    const rig = await local();
    const { uuid } = await create(rig);
    await rig.ok("update_data", { uuid, operations: [{
      collection: "observations", schema: { version: 1, schema: { type: "object" } },
      upsert: [
        { id: "record-old", value: { day: "2026-09-08", count: 42424242 } },
        { id: "record-gap", value: { day: "2026-09-09", count: null } },
        { id: "record-both", value: { day: "2026-09-10", count: 42424242, spare: 31313131 } },
        { id: "record-spare", value: { day: "2026-09-11", spare: 31313131 } },
        { id: "record-bad-x", value: { day: "not a day", count: 42424242 } },
        { id: "record-no-x", value: { count: 42424242, secret: "PRIVATE_RECORD_VALUE" } },
      ],
    }] });
    const doc = rig.instance.replicas.replica(uuid).doc;
    const before = JSON.stringify(doc.getMap(DATA_KEY).toJSON());
    const mapping = { ...line, limit: 3, y: [
      { field: "count", label: "PRIVATE_SERIES_LABEL" }, { field: "spare" }, { field: "coutn" },
    ] };
    const result = await rig.ok("insert_block", { uuid, blocks: [
      { type: "paragraph", text: "A mixed batch" },
      { type: "chart", text: JSON.stringify(mapping) },
      { type: "chart", text: JSON.stringify({ ...line, collection: "observation" }) },
    ] });
    expect(result).toMatchObject({ applied: true, synced: expect.any(Boolean), hub: { status: expect.any(String) } });
    expect(result.blocks[0]).not.toHaveProperty("chart");
    expect(result.blocks[1].chart).toEqual({
      status: "ready", recordCount: 6, plottedCount: 2,
      series: [{ field: "count", pointCount: 1 }, { field: "spare", pointCount: 2 }, { field: "coutn", pointCount: 0 }],
      firstX: "2026-09-10", lastX: "2026-09-11", warnings: [expect.stringContaining("coutn")],
    });
    expect(result.blocks[2].chart).toEqual({
      status: "collection-absent", message: "Chart collection “observation” is absent.",
      collections: ["observations"], warnings: [expect.any(String)],
    });
    expect(JSON.stringify(result)).not.toMatch(/42424242|31313131|PRIVATE_RECORD_VALUE|PRIVATE_SERIES_LABEL|record-both/);
    expect(JSON.stringify(doc.getMap(DATA_KEY).toJSON())).toBe(before);
    expect(getBlocks(doc).find(block => block.id === result.blocks[1].id)?.text).toBe(JSON.stringify(mapping));

    const edited = await rig.ok("edit_block", {
      uuid, block_id: result.blocks[1].id, rev: result.blocks[1].rev,
      old_text: JSON.stringify(mapping), new_text: JSON.stringify({ ...line, y: [{ field: "coutn" }] }),
    });
    expect(edited.block.chart).toEqual({
      status: "no-records", message: "No plottable records in this chart collection.",
      recordCount: 6, plottedCount: 0, series: [{ field: "coutn", pointCount: 0 }],
      warnings: [expect.any(String), expect.stringContaining("coutn")],
    });
    expect(JSON.stringify(doc.getMap(DATA_KEY).toJSON())).toBe(before);
    const moved = await rig.ok("move_block", { uuid, block_ids: [edited.block.id] });
    expect(moved.blocks).toEqual([{ id: edited.block.id, rev: edited.block.rev }]);
    const paragraph = await rig.ok("edit_block", {
      uuid, block_id: result.blocks[0].id, rev: result.blocks[0].rev,
      old_text: "A mixed batch", new_text: "Changed context",
    });
    expect(paragraph.block).not.toHaveProperty("chart");
  });

  it.each([
    { type: "number", first: -2.5, last: 8, firstX: -2.5, lastX: 8 },
    { type: "date", first: "2026-09-10T10:15:00+02:00", last: "2026-09-11T09:45:00Z",
      firstX: "2026-09-10T08:15:00.000Z", lastX: "2026-09-11T09:45:00.000Z" },
  ])("returns $type x endpoints in mapping terms", async ({ type, first, last, firstX, lastX }) => {
    const rig = await local();
    const { uuid } = await create(rig);
    await rig.ok("update_data", { uuid, operations: [{
      collection: "observations", schema: { version: 1, schema: { type: "object" } },
      upsert: [
        { id: "later", value: { day: last, count: 222222 } },
        { id: "earlier", value: { day: first, count: 111111 } },
      ],
    }] });
    expect(await insert(rig, uuid, { ...line, x: { field: "day", type } })).toEqual({
      status: "ready", recordCount: 2, plottedCount: 2,
      series: [{ field: "count", pointCount: 2 }], firstX, lastX, warnings: [],
    });
  });

  it("reports unusable collection and incompatible mapping states while applying the source", async () => {
    const rig = await local();
    const { uuid } = await create(rig);
    await rig.ok("update_data", { uuid, operations: [{
      collection: "observations", schema: { version: 1, schema: {
        type: "object", properties: { day: { type: "string" }, count: { type: "string" } }, additionalProperties: false,
      } },
    }] });
    expect(await insert(rig, uuid, line)).toEqual({
      status: "mapping-incompatible",
      message: "Chart mapping is incompatible with the schema: field “count” is missing or has an incompatible type.",
      warnings: [expect.any(String)],
    });
    const doc = rig.instance.replicas.replica(uuid).doc;
    doc.getMap(DATA_KEY).set(JSON.stringify(["schema", "observations"]), { version: 2, schema: { type: "object" } });
    expect(await insert(rig, uuid, line)).toEqual({
      status: "collection-unusable", message: "Chart collection is unusable: its schema is missing or unsupported.",
      warnings: [expect.any(String)],
    });
    expect(getBlocks(doc)).toHaveLength(2);
    expect(getBlocks(doc).every(block => block.text === JSON.stringify(line))).toBe(true);
    expect(doc.getMap(DATA_KEY).get(JSON.stringify(["schema", "observations"]))).toEqual({
      version: 2, schema: { type: "object" },
    });
  });

  it("counts table rows after limit and excludes schema-invalid records without exposing cells", async () => {
    const rig = await local();
    const { uuid } = await create(rig);
    await rig.ok("update_data", { uuid, operations: [{
      collection: "observations", schema: { version: 1, schema: {
        type: "object", properties: { count: { type: "number" } }, required: ["count"],
      } },
      upsert: [{ id: "valid-a", value: { count: 42424242 } }, { id: "valid-b", value: { count: 31313131 } }],
    }] });
    const doc = rig.instance.replicas.replica(uuid).doc;
    doc.getMap(DATA_KEY).set(JSON.stringify(["record", "observations", "invalid"]), { count: "PRIVATE_CELL_VALUE" });
    const before = JSON.stringify(doc.getMap(DATA_KEY).toJSON());
    const summary = await insert(rig, uuid, { ...table, limit: 1 });
    expect(summary).toEqual({ status: "ready", recordCount: 3, rowCount: 1, invalidRecordCount: 1, warnings: [] });
    expect(JSON.stringify(summary)).not.toMatch(/42424242|31313131|PRIVATE_CELL_VALUE|valid-a/);
    expect(JSON.stringify(doc.getMap(DATA_KEY).toJSON())).toBe(before);
    doc.getMap(DATA_KEY).delete(JSON.stringify(["record", "observations", "valid-a"]));
    doc.getMap(DATA_KEY).delete(JSON.stringify(["record", "observations", "valid-b"]));
    expect(await insert(rig, uuid, table)).toEqual({
      status: "no-records", message: "No records to show in this table collection.",
      recordCount: 1, rowCount: 0, invalidRecordCount: 1, warnings: [expect.any(String)],
    });
  });

  it("summarizes scatter seeds, inserted points and edited groups from the shared projection without record values", async () => {
    const rig = await local();
    const source = JSON.stringify(scatter);
    const created = await rig.ok("create_doc", {
      title: "Scatter feedback", description: "Stored bounds remain private to the document.",
      blocks: [{ type: "chart", text: source }],
    });
    expect(created.blocks[0].chart).toEqual({
      status: "collection-absent", message: "Chart collection “observations” is absent.",
      collections: [], warnings: [expect.any(String)],
    });
    await rig.ok("update_data", { uuid: created.uuid, operations: [{
      collection: "observations", schema: { version: 1, schema: { type: "object" } },
      upsert: [
        { id: "private-a", value: { cost: 42424242, quality: 82, low: 76, high: 87,
          name: "PRIVATE_POINT_LABEL", tier: "PRIVATE_GROUP", source: "https://private.example/source" } },
        { id: "private-b", value: { cost: 42424242, quality: 82, low: "PRIVATE_BAD_BOUND", high: 70,
          name: "PRIVATE_DUPLICATE_POINT", tier: "PRIVATE_GROUP" } },
        { id: "private-invalid-x", value: { cost: "PRIVATE_WRONG_TYPE", quality: 82 } },
        { id: "private-missing-y", value: { cost: 42424242 } },
      ],
    }] });
    const doc = rig.instance.replicas.replica(created.uuid).doc;
    const before = JSON.stringify(doc.getMap(DATA_KEY).toJSON());
    const result = await rig.ok("insert_block", { uuid: created.uuid, blocks: [{ type: "chart", text: source }] });
    expect(result.blocks[0].chart).toEqual({ status: "ready", recordCount: 4, plottedCount: 2, warnings: [] });
    expect(JSON.stringify(result)).not.toMatch(/42424242|PRIVATE_|private-/);
    expect(JSON.stringify(doc.getMap(DATA_KEY).toJSON())).toBe(before);

    await rig.ok("update_data", { uuid: created.uuid, operations: [{
      collection: "observations",
      upsert: Array.from({ length: 9 }, (_, index) => ({ id: `group-${index}`,
        value: { cost: index, quality: index, tier: `PRIVATE_GROUP_${index}` } })),
    }] });
    const edited = await rig.ok("edit_block", {
      uuid: created.uuid, block_id: result.blocks[0].id, rev: result.blocks[0].rev,
      old_text: source, new_text: JSON.stringify({ ...scatter, title: "Changed scatter title" }),
    });
    expect(edited.block.chart).toEqual({
      status: "ready", recordCount: 13, plottedCount: 11, warnings: [expect.stringContaining("tier")],
    });
    expect(JSON.stringify(edited)).not.toMatch(/PRIVATE_|private-/);
  });

  it("reports bound empty line, scatter and table collections with counts", async () => {
    const rig = await local();
    const { uuid } = await create(rig);
    await rig.ok("update_data", { uuid, operations: [{
      collection: "observations", schema: { version: 1, schema: { type: "object" } },
    }] });
    expect(await insert(rig, uuid, line)).toEqual({
      status: "no-records", message: "No plottable records in this chart collection.",
      recordCount: 0, plottedCount: 0, series: [{ field: "count", pointCount: 0 }],
      warnings: [expect.any(String), expect.stringContaining("count")],
    });
    expect(await insert(rig, uuid, table)).toEqual({
      status: "no-records", message: "No records to show in this table collection.",
      recordCount: 0, rowCount: 0, invalidRecordCount: 0, warnings: [expect.any(String)],
    });
    expect(await insert(rig, uuid, scatter)).toEqual({
      status: "no-records", message: "No plottable records in this scatter collection.",
      recordCount: 0, plottedCount: 0, warnings: [expect.any(String)],
    });
  });

  it.each(["create_doc", "insert_block", "edit_block"])("keeps %s applied when reading chart data throws", async (tool) => {
    const rig = await local();
    const page = await create(rig);
    const initial = await rig.ok("insert_block", {
      uuid: page.uuid, blocks: [{ type: "chart", text: JSON.stringify(line) }],
    });
    const source = JSON.stringify({ ...line, title: "Applied despite unavailable feedback" });
    const original = Y.Doc.prototype.getMap;
    vi.spyOn(Y.Doc.prototype, "getMap").mockImplementation(function<T>(this: Y.Doc, name?: string) {
      if (name === DATA_KEY) throw new Error("PRIVATE_DATA_READ_FAILURE");
      return original.call(this, name) as Y.Map<T>;
    });
    const args = tool === "create_doc"
      ? { title: "Applied chart", description: "The write survives a failed feedback read.", blocks: [{ type: "chart", text: source }] }
      : tool === "insert_block"
        ? { uuid: page.uuid, blocks: [{ type: "chart", text: source }] }
        : { uuid: page.uuid, block_id: initial.blocks[0].id, rev: initial.blocks[0].rev,
            old_text: JSON.stringify(line), new_text: source };
    const result = await rig.ok(tool, args);
    expect(result).toMatchObject({ applied: true, synced: expect.any(Boolean), hub: { status: expect.any(String) } });
    const written = tool === "edit_block" ? result.block : result.blocks[0];
    expect(written.chart).toMatchObject({ status: "collection-unusable", message: expect.any(String), warnings: [expect.any(String)] });
    expect(JSON.stringify(result)).not.toContain("PRIVATE_DATA_READ_FAILURE");
    vi.restoreAllMocks();
    expect(getBlocks(rig.instance.replicas.replica(result.uuid).doc).find(block => block.id === written.id)?.text).toBe(source);
    const replay = new Y.Doc();
    try {
      const replica = rig.instance.replicas.replica(result.uuid);
      const logged = rig.instance.store.readSince(replica.room, 0);
      if (logged.snapshot !== null) Y.applyUpdate(replay, logged.snapshot.state);
      for (const update of logged.updates) Y.applyUpdate(replay, update.payload);
      expect(getBlocks(replay).find(block => block.id === written.id)?.text).toBe(source);
    } finally {
      replay.destroy();
    }
  });
});

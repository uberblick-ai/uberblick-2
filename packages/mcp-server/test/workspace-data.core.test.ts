import { randomUUID } from "node:crypto";
import { createTagCatalogEntry, DATA_KEY, DATA_LIMITS, readDocData, setTags, upsertDirectoryEntry } from "@uberblick/schema";
import { afterEach, describe, expect, it } from "vitest";
import * as Y from "yjs";
import { PersistenceError } from "../src/replica.js";
import { readWorkspaceData, updateWorkspaceData, WorkspaceDataWriteError } from "../src/workspace-data.js";
import { cleanupTestResources, FailingStore, startServer, testConfig } from "./core-helpers.js";
import type { Rig } from "./core-helpers.js";

const rigs: Rig[] = [];
const schema = {
  version: 1,
  schema: {
    type: "object", properties: { text: { type: "string" } },
    required: ["text"], additionalProperties: false,
  },
};
const operations = [{
  collection: "observations", schema, upsert: [{ id: "row-a", value: { text: "first" } }],
}];

async function local() {
  const rig = await startServer(testConfig());
  rigs.push(rig);
  return rig;
}

async function create(rig: Rig, fields: Record<string, unknown> = {}) {
  return rig.ok("create_doc", {
    title: "Workspace data", description: "A file data operation fixture.",
    blocks: [{ type: "paragraph", text: "A supported answer." }], ...fields,
  });
}

function state(rig: Rig, uuid: string) {
  return {
    document: Y.encodeStateAsUpdate(rig.instance.replicas.replica(uuid).doc),
    directory: Y.encodeStateAsUpdate(rig.instance.replicas.directory().doc),
    log: rig.instance.store.logSize(),
  };
}

async function refuses(rig: Rig, uuid: string, batch: unknown, code: string) {
  await rig.instance.replicas.settle();
  const before = state(rig, uuid);
  for (const dryRun of [true, false]) {
    await expect(updateWorkspaceData(rig.instance.replicas, { uuid, operations: batch }, dryRun))
      .rejects.toMatchObject({ code });
    expect(state(rig, uuid)).toEqual(before);
  }
  expect(await rig.call("update_data", { uuid, operations: batch })).toMatchObject({
    isError: true, payload: { error: code, applied: false, partial: false },
  });
  expect(state(rig, uuid)).toEqual(before);
}

afterEach(async () => {
  await cleanupTestResources({
    clients: rigs.splice(0).map((client) => () => client.close()),
  });
});

describe("workspace file data operations", () => {
  it("exempts only the CLI writer and previews without changing document, directory or log", async () => {
    const rig = await local();
    const guide = await create(rig, { title: "Guidance" });
    const target = await create(rig);
    const marker = randomUUID();
    createTagCatalogEntry(rig.instance.replicas.settings().doc, "guidance", marker);
    setTags(rig.instance.replicas.replica(guide.uuid).doc, [marker]);
    await readWorkspaceData(rig.instance.replicas, target.uuid);
    const before = state(rig, target.uuid);
    const args = { uuid: target.uuid, operations };

    expect(await rig.call("update_data", args)).toMatchObject({
      isError: true, payload: { error: "guidance_required" },
    });
    for (const extra of [{ dryRun: true }, { skipBriefing: true }]) {
      expect(await rig.call("update_data", { ...args, ...extra })).toMatchObject({
        isError: true, payload: { error: "schema_validation" },
      });
      await expect(updateWorkspaceData(rig.instance.replicas, { ...args, ...extra })).rejects.toThrow();
    }
    expect(await updateWorkspaceData(rig.instance.replicas, args, true)).toEqual({
      uuid: target.uuid, changed: true, dryRun: true, synced: false,
      collections: [{
        name: "observations", recordCount: 1, deleted: false, upserted: 1,
        removed: 0, schemaChanged: true,
      }],
    });
    expect(state(rig, target.uuid)).toEqual(before);
    const written = await updateWorkspaceData(rig.instance.replicas, args);
    expect(written).toMatchObject({ changed: true, dryRun: false, synced: false });
    expect(await rig.ok("get_data", { uuid: target.uuid, collection: "observations" }))
      .toMatchObject({ records: [{ id: "row-a", value: { text: "first" } }] });
    expect(await rig.call("set_metadata", { uuid: target.uuid, title: "Still gated" }))
      .toMatchObject({ isError: true, payload: { error: "guidance_required" } });
    expect(await rig.call("update_data", args)).toMatchObject({
      isError: true, payload: { error: "guidance_required" },
    });
    const saved = state(rig, target.uuid);
    expect(await updateWorkspaceData(rig.instance.replicas, args)).toMatchObject({ changed: false });
    expect(state(rig, target.uuid)).toEqual(saved);
  });

  it("reads all records from one detached observation and preserves invalid stored values", async () => {
    const rig = await local();
    const { uuid } = await create(rig);
    const records = Array.from({ length: 1_003 }, (_, index) => ({
      id: `row-${String(index).padStart(4, "0")}`, value: { text: String(index) },
    }));
    await updateWorkspaceData(rig.instance.replicas, {
      uuid, operations: [{ collection: "observations", schema, upsert: records.reverse() }],
    });
    const doc = rig.instance.replicas.replica(uuid).doc;
    doc.getMap(DATA_KEY).set(JSON.stringify(["record", "observations", "invalid"]), { text: 42 });
    await rig.instance.replicas.settle();
    const before = state(rig, uuid);
    const data = await readWorkspaceData(rig.instance.replicas, uuid);
    expect(data).toEqual(readDocData(doc));
    expect(data?.collections[0]?.records).toHaveLength(1_004);
    expect(data?.collections[0]).toMatchObject({ valid: false, invalidRecordIds: ["invalid"] });
    expect(data?.collections[0]?.records[0]).toMatchObject({ id: "invalid", value: { text: 42 } });
    expect(data?.collections[0]?.records.at(-1)).toMatchObject({ id: "row-1002" });
    expect(state(rig, uuid)).toEqual(before);
    doc.getMap(DATA_KEY).set(JSON.stringify(["record", "observations", "invalid"]), { text: "changed later" });
    expect(data?.collections[0]?.records[0]?.value).toEqual({ text: 42 });
  });

  it("shares schema, record and operation-budget refusals in preview and real writes", async () => {
    const rig = await local();
    const { uuid } = await create(rig);
    await updateWorkspaceData(rig.instance.replicas, { uuid, operations });
    await refuses(rig, uuid, [
      { collection: "observations", upsert: [{ id: "ok", value: { text: "would change" } }] },
      { collection: "bad", schema: { version: 2, schema: { type: "object" } } },
    ], "data_schema_invalid");
    await refuses(rig, uuid, [{ collection: "observations", upsert: [{ id: "bad", value: { text: 1 } }] }], "data_record_invalid");
    await refuses(rig, uuid, [{ collection: "observations" }, { collection: "observations" }], "data_invalid_input");
    await refuses(rig, uuid, [{ collection: "observations", upsert: [{
      id: "large", value: { text: "x".repeat(DATA_LIMITS.record) },
    }] }], "data_limit_exceeded");
    await refuses(rig, uuid, [{ collection: "observations", upsert: Array.from({ length: 18 }, (_, index) => ({
      id: `large-${index}`, value: { text: "x".repeat(60_000) },
    })) }], "data_limit_exceeded");
  });

  it("shares archive, decision, unknown and unhydrated guards without writing", async () => {
    const rig = await local();
    const archived = await create(rig);
    await rig.ok("archive_doc", { uuid: archived.uuid });
    await refuses(rig, archived.uuid, operations, "doc_archived");
    const decision = await create(rig, { kind: "decision" });
    await refuses(rig, decision.uuid, operations, "decision_data_unsupported");
    await rig.ok("set_status", { uuid: decision.uuid, status: "decided" });
    await refuses(rig, decision.uuid, operations, "decision_read_only");
    const unknown = randomUUID();
    for (const dryRun of [true, false]) {
      await expect(updateWorkspaceData(rig.instance.replicas, { uuid: unknown, operations }, dryRun))
        .rejects.toMatchObject({ code: "doc_not_found" });
    }
    await expect(readWorkspaceData(rig.instance.replicas, unknown)).rejects.toMatchObject({ code: "doc_not_found" });
    const unhydrated = randomUUID();
    upsertDirectoryEntry(rig.instance.replicas.directory().doc, { uuid: unhydrated, title: "Not hydrated" });
    await refuses(rig, unhydrated, operations, "doc_not_hydrated");
  });

  it("does not claim a saved write when the local append fails", async () => {
    const config = testConfig();
    const store = new FailingStore(config.databasePath, config.workspaceId);
    const rig = await startServer(config, store);
    rigs.push(rig);
    const { uuid } = await create(rig);
    await readWorkspaceData(rig.instance.replicas, uuid);
    const before = store.logSize();
    store.failing = true;
    await expect(updateWorkspaceData(rig.instance.replicas, { uuid, operations }, true)).resolves.toMatchObject({ changed: true });
    expect(store.logSize()).toBe(before);
    await expect(updateWorkspaceData(rig.instance.replicas, { uuid, operations })).rejects.toMatchObject({
      writeOutcome: "unconfirmed", cause: expect.any(PersistenceError),
    });
    expect(store.logSize()).toBe(before);
  });

  it("reports an unconfirmed outcome when document data persists before a directory append fails", async () => {
    const config = testConfig({ updatedAtCoarsenessMs: 0 });
    const store = new FailingStore(config.databasePath, config.workspaceId);
    const rig = await startServer(config, store);
    rigs.push(rig);
    const { uuid } = await create(rig);
    await readWorkspaceData(rig.instance.replicas, uuid);
    const before = store.logSize();
    store.failRoom = room => room === rig.instance.replicas.directory().room;
    store.failing = true;
    const error = await updateWorkspaceData(rig.instance.replicas, { uuid, operations }).catch(error => error);
    expect(error).toBeInstanceOf(WorkspaceDataWriteError);
    expect(error).toMatchObject({ writeOutcome: "unconfirmed", cause: expect.any(PersistenceError) });
    expect(store.logSize()).toBeGreaterThan(before);

    const persisted = new Y.Doc();
    try {
      const log = store.readSince(rig.instance.replicas.replica(uuid).room, 0);
      if (log.snapshot !== null) Y.applyUpdate(persisted, log.snapshot.state);
      for (const update of log.updates) Y.applyUpdate(persisted, update.payload);
      expect(readDocData(persisted)?.collections[0]?.records).toEqual([{ id: "row-a", value: { text: "first" } }]);
    } finally { persisted.destroy(); }
  });

  it("retains confirmed local save when another append fails during acknowledgement waiting", async () => {
    const config = testConfig();
    const store = new FailingStore(config.databasePath, config.workspaceId);
    const rig = await startServer(config, store);
    rigs.push(rig);
    const target = await create(rig);
    const other = await create(rig);
    await readWorkspaceData(rig.instance.replicas, target.uuid);
    const doc = rig.instance.replicas.replica(target.uuid).doc;
    const otherDoc = rig.instance.replicas.replica(other.uuid).doc;
    doc.once("update", () => queueMicrotask(() => {
      store.failing = true;
      otherDoc.getMap(DATA_KEY).set(JSON.stringify(["record", "other", "failure"]), {});
    }));
    await expect(updateWorkspaceData(rig.instance.replicas, { uuid: target.uuid, operations }))
      .rejects.toMatchObject({ writeOutcome: "saved-locally", cause: expect.any(PersistenceError) });
    const persisted = new Y.Doc();
    try {
      const log = store.readSince(rig.instance.replicas.replica(target.uuid).room, 0);
      if (log.snapshot !== null) Y.applyUpdate(persisted, log.snapshot.state);
      for (const update of log.updates) Y.applyUpdate(persisted, update.payload);
      expect(readDocData(persisted)?.collections[0]?.records).toEqual([{ id: "row-a", value: { text: "first" } }]);
    } finally { persisted.destroy(); }
  });
});

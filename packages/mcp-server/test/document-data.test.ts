/** Document data uses the existing room log, snapshots and hub sync path. */

import type { Hub } from "@uberblick/hub";
import { applyDocData, readDocData } from "@uberblick/schema";
import type { DataOperation } from "@uberblick/schema";
import { afterEach, describe, expect, it } from "vitest";
import * as Y from "yjs";
import { MirrorStore } from "../src/store.js";
import {
  FailingStore,
  hubUrl,
  LIVE_HUB_SETTLE,
  removeTempDirs,
  startHub,
  startServer,
  tempDatabasePath,
  testConfig,
  TEST_SECRET,
  waitForCorpus,
  waitUntil,
  WORKSPACE,
} from "./helpers.js";
import type { Rig, TestConfigOptions } from "./helpers.js";

const rigs = new Set<Rig>();
const hubs = new Set<Hub>();

afterEach(async () => {
  for (const rig of rigs) await rig.close();
  rigs.clear();
  for (const hub of hubs) await hub.stop();
  hubs.clear();
  removeTempDirs();
});

async function server(options: TestConfigOptions = {}, store?: MirrorStore) {
  const rig = await startServer(testConfig(options), store);
  rigs.add(rig);
  return rig;
}

async function close(rig: Rig) {
  await rig.close();
  rigs.delete(rig);
}

async function hub(databasePath: string) {
  const started = await startHub({ databasePath });
  hubs.add(started);
  return started;
}

const observationSchema = {
  version: 1 as const,
  schema: {
    type: "object" as const,
    properties: { text: { type: "string" as const } },
    required: ["text"],
    additionalProperties: false as const,
  },
};

function doc(rig: Rig, uuid: string) {
  return rig.instance.replicas.replica(uuid).doc;
}

function apply(rig: Rig, uuid: string, operations: DataOperation[]) {
  return applyDocData(doc(rig, uuid), rig.instance.replicas.directory().doc, operations);
}

/** Rebuild from committed bytes through another SQLite connection. */
function persistedData(databasePath: string, room: string) {
  const reader = new MirrorStore(databasePath, WORKSPACE);
  const rebuilt = new Y.Doc();
  try {
    const slice = reader.readSince(room, 0);
    if (slice.snapshot !== null) Y.applyUpdate(rebuilt, slice.snapshot.state);
    for (const update of slice.updates) Y.applyUpdate(rebuilt, update.payload);
    return readDocData(rebuilt);
  } finally {
    rebuilt.destroy();
    reader.close();
  }
}

async function synced(rig: Rig) {
  await waitUntil("document data to be acknowledged by the hub", async () => {
    const status = await rig.ok("sync_status");
    return (
      status.hub.status === "connected" &&
      status.pendingRooms.length === 0 &&
      status.unsyncedChanges === 0
    );
  });
}

async function hydrated(rig: Rig, uuid: string) {
  await waitUntil("the document room to hydrate after its directory stub", async () =>
    !(await rig.call("get_doc", { uuid })).isError,
  );
}

describe("document-owned data persistence", () => {
  it("logs data synchronously without changing get_doc or indexing record text", async () => {
    const databasePath = tempDatabasePath();
    const rig = await server({ databasePath });
    const created = await rig.ok("create_doc", {
      title: "Observations beside prose",
      description: "A synthetic data persistence fixture.",
      blocks: [{ type: "paragraph", text: "Searchable prose fixture" }],
    });
    const before = await rig.ok("get_doc", { uuid: created.uuid });
    const replicaDoc = doc(rig, created.uuid);
    expect(readDocData(replicaDoc)).toBeNull();

    const applied = apply(rig, created.uuid, [{
      collection: "observations",
      schema: observationSchema,
      upsert: [{ id: "row-1", value: { text: "quartzneedledataonly" } }],
    }]);
    expect(applied.changed).toBe(true);
    const expected = readDocData(replicaDoc);
    expect(expected?.valid).toBe(true);

    // No settle or graceful shutdown precedes this separate committed read.
    expect(persistedData(databasePath, `${WORKSPACE}/${created.uuid}`))
      .toEqual(expected);
    expect(await rig.ok("get_doc", { uuid: created.uuid })).toEqual(before);
    expect((await rig.ok("search", { query: "quartzneedledataonly" })).hits)
      .toEqual([]);
    expect((await rig.ok("search", { query: "Searchable prose" })).hits)
      .toEqual([expect.objectContaining({ uuid: created.uuid })]);

    await close(rig);
    const reopened = await server({ databasePath });
    expect(await reopened.ok("get_doc", { uuid: created.uuid })).toEqual(before);
    expect(readDocData(doc(reopened, created.uuid))).toEqual(expected);
    expect((await reopened.ok("search", { query: "quartzneedledataonly" })).hits)
      .toEqual([]);
  });

  it("compacts data updates and reopens from the snapshot plus its tail", async () => {
    const databasePath = tempDatabasePath();
    const rig = await server({ databasePath, compactAfter: 4 });
    const created = await rig.ok("create_doc", {
      title: "Compacted document data",
      description: "A synthetic snapshot fixture.",
    });
    const replicaDoc = doc(rig, created.uuid);
    apply(rig, created.uuid, [{
      collection: "observations",
      schema: observationSchema,
      upsert: [{ id: "row-1", value: { text: "initial" } }],
    }]);
    for (let step = 1; step <= 5; step += 1) {
      apply(rig, created.uuid, [{
        collection: "observations",
        upsert: [{ id: "row-1", value: { text: `revision ${step}` } }],
      }]);
    }
    await rig.ok("sync_status");
    const room = `${WORKSPACE}/${created.uuid}`;
    expect(rig.instance.store.snapshot(room)).not.toBeNull();
    expect(rig.instance.store.updateCount(room)).toBeLessThan(4);

    // Keep a data-only deletion after the snapshot as a log-tail update.
    apply(rig, created.uuid, [{
      collection: "observations",
      deleteRecords: ["row-1"],
      upsert: [{ id: "row-2", value: { text: "tail survives" } }],
    }]);
    const expected = readDocData(replicaDoc);
    expect(rig.instance.store.updateCount(room)).toBe(1);
    expect(persistedData(databasePath, room)).toEqual(expected);
    await close(rig);

    const reopened = await server({ databasePath });
    await reopened.ok("get_doc", { uuid: created.uuid });
    expect(readDocData(doc(reopened, created.uuid))).toEqual(expected);
  });

  it("merges separate collections through the hub and recovers its snapshot without any old replica", async () => {
    const hubDatabase = tempDatabasePath();
    const running = await hub(hubDatabase);
    const connected = {
      ...LIVE_HUB_SETTLE,
      authSecret: TEST_SECRET,
      hubUrl: hubUrl(running.port),
    };
    const producer = await server(connected);
    const human = await server(connected);
    const created = await producer.ok("create_doc", {
      title: "Independent collection writers",
      description: "A synthetic hub convergence fixture.",
      blocks: [{ type: "paragraph", text: "Plain prose stays readable" }],
    });
    await waitForCorpus(human, [created.uuid]);
    await hydrated(human, created.uuid);
    await synced(producer);
    await synced(human);

    // Neither transaction sees the other's new collection before it commits.
    apply(producer, created.uuid, [{
      collection: "observations",
      schema: observationSchema,
      upsert: [{ id: "row-1", value: { text: "producer observation" } }],
    }]);
    apply(human, created.uuid, [{
      collection: "dispositions",
      schema: observationSchema,
      upsert: [{ id: "row-1", value: { text: "human disposition" } }],
    }]);
    await waitUntil("both independent data collections to converge", () => {
      const producerData = readDocData(doc(producer, created.uuid));
      const humanData = readDocData(doc(human, created.uuid));
      return (
        producerData?.collections.length === 2 &&
        JSON.stringify(producerData) === JSON.stringify(humanData)
      );
    });
    const expected = readDocData(doc(producer, created.uuid));
    expect(expected?.valid).toBe(true);
    expect(expected?.collections.map(({ name }) => name))
      .toEqual(["dispositions", "observations"]);
    await synced(producer);
    await synced(human);

    // Close every old client before stopping the hub: none can re-send data
    // after restart, so a fresh mirror proves recovery from the hub's disk.
    await close(producer);
    await close(human);
    await running.stop();
    hubs.delete(running);
    const restarted = await hub(hubDatabase);
    const fresh = await server({ ...connected, hubUrl: hubUrl(restarted.port) });
    await waitForCorpus(fresh, [created.uuid]);
    await hydrated(fresh, created.uuid);
    const read = await fresh.ok("get_doc", { uuid: created.uuid });
    expect(read.blocks[0].text).toBe("Plain prose stays readable");
    await waitUntil("hub snapshot data to hydrate a fresh local mirror", () =>
      JSON.stringify(readDocData(doc(fresh, created.uuid))) === JSON.stringify(expected),
    );
    expect(persistedData(fresh.config.databasePath, `${WORKSPACE}/${created.uuid}`))
      .toEqual(expected);
  });

  it("quarantines a refused data append and never compacts the unlogged change", async () => {
    const databasePath = tempDatabasePath();
    const faulty = new FailingStore(databasePath, WORKSPACE);
    const rig = await server({ databasePath, compactAfter: 1 }, faulty);
    const created = await rig.ok("create_doc", {
      title: "Data disk failure",
      description: "A synthetic persistence failure fixture.",
    });
    const replicaDoc = doc(rig, created.uuid);
    apply(rig, created.uuid, [{
      collection: "observations",
      schema: observationSchema,
      upsert: [{ id: "row-1", value: { text: "durable" } }],
    }]);
    await rig.ok("sync_status");
    const expected = readDocData(replicaDoc);
    const room = `${WORKSPACE}/${created.uuid}`;
    const snapshot = rig.instance.store.snapshot(room);
    expect(snapshot).not.toBeNull();

    faulty.failing = true;
    apply(rig, created.uuid, [{
      collection: "observations",
      upsert: [{ id: "row-1", value: { text: "unlogged" } }],
    }]);
    expect(() => rig.instance.replicas.assertHealthy()).toThrow();
    expect((await rig.call("get_doc", { uuid: created.uuid })).payload.error)
      .toBe("persistence_failed");
    faulty.failing = false;
    const status = await rig.ok("sync_status");
    expect(status.persistence?.room).toBe(room);
    expect(rig.instance.store.snapshot(room)).toEqual(snapshot);
    expect(persistedData(databasePath, room)).toEqual(expected);
    await close(rig);

    const reopened = await server({ databasePath });
    await reopened.ok("get_doc", { uuid: created.uuid });
    expect(readDocData(doc(reopened, created.uuid))).toEqual(expected);
  });
});

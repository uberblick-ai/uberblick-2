/** Document data uses the existing room log, snapshots and hub sync path. */

import type { Hub } from "@uberblick/hub";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import {
  StdioClientTransport,
  getDefaultEnvironment,
} from "@modelcontextprotocol/sdk/client/stdio.js";
import { readDocData } from "@uberblick/schema";
import { dirname } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import * as Y from "yjs";
import { MirrorStore } from "../src/store.js";
import {
  hubUrl,
  FailingStore,
  LIVE_HUB_SETTLE,
  mainTsProcess,
  PACKAGE_ROOT,
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
const processes = new Set<ProcessClient>();

afterEach(async () => {
  for (const processClient of processes) await processClient.close();
  processes.clear();
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

interface ProcessClient {
  readonly pid: number;
  ok(name: string, args?: Record<string, unknown>): Promise<any>;
  close(): Promise<void>;
}

function alive(pid: number) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** Separate processes must exchange data through the shared log, not memory. */
async function processClient(databasePath: string): Promise<ProcessClient> {
  const transport = new StdioClientTransport({
    ...mainTsProcess(),
    cwd: PACKAGE_ROOT,
    env: {
      ...getDefaultEnvironment(),
      WORKSPACE_ID: WORKSPACE,
      UBERBLICK_DB: databasePath,
      XDG_DATA_HOME: dirname(databasePath),
      HUB_URL: "ws://127.0.0.1:1",
    },
    stderr: "ignore",
  });
  const client = new Client({ name: "uberblick-tests", version: "0.0.0" });
  let pid: number | null = null;
  const started: ProcessClient = {
    get pid() {
      if (pid === null) throw new Error("MCP process has not started");
      return pid;
    },
    async ok(name, args = {}) {
      const result = await client.callTool({ name, arguments: args });
      const content = result.content as { text?: string }[];
      const payload = JSON.parse(content[0]?.text ?? "null");
      if (result.isError === true) {
        throw new Error(`tool ${name} failed: ${JSON.stringify(payload)}`);
      }
      return payload;
    },
    async close() {
      await client.close();
      if (pid !== null) {
        await waitUntil("the MCP process to exit", () => !alive(pid as number));
      }
      processes.delete(started);
    },
  };
  processes.add(started);
  await client.connect(transport);
  pid = transport.pid;
  return started;
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
  it("logs MCP data writes synchronously, keeps ordinary reads light and reopens identically", async () => {
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

    const operations = [{
      collection: "observations",
      schema: observationSchema,
      upsert: [{ id: "row-1", value: { text: "quartzneedledataonly" } }],
    }];
    const applied = await rig.ok("update_data", { uuid: created.uuid, operations });
    expect(applied).toMatchObject({ changed: true, applied: true, synced: false });
    const expected = readDocData(replicaDoc);
    expect(expected?.valid).toBe(true);

    // No settle or graceful shutdown precedes this separate committed read.
    expect(persistedData(databasePath, `${WORKSPACE}/${created.uuid}`))
      .toEqual(expected);
    const { data, ...ordinary } = await rig.ok("get_doc", { uuid: created.uuid });
    expect(ordinary).toEqual(before);
    expect(data.collections).toEqual([{ name: "observations", recordCount: 1 }]);
    expect(JSON.stringify(data)).toContain("get_data");
    expect(JSON.stringify(data)).not.toContain("quartzneedledataonly");
    const expectedPage = await rig.ok("get_data", {
      uuid: created.uuid, collection: "observations",
    });
    expect(expectedPage).toMatchObject({
      schema: observationSchema,
      valid: true,
      records: [{ id: "row-1", value: { text: "quartzneedledataonly" }, valid: true }],
      complete: true,
    });

    const room = `${WORKSPACE}/${created.uuid}`;
    const loggedBefore = rig.instance.store.updateCount(room);
    const refreshed = await rig.ok("update_data", { uuid: created.uuid, operations });
    expect(refreshed).toMatchObject({ changed: false, applied: true, synced: false });
    expect(rig.instance.store.updateCount(room)).toBe(loggedBefore);
    expect((await rig.ok("search", { query: "quartzneedledataonly" })).hits)
      .toEqual([]);
    expect((await rig.ok("search", { query: "Searchable prose" })).hits)
      .toEqual([expect.objectContaining({ uuid: created.uuid })]);

    await close(rig);
    const reopened = await server({ databasePath });
    expect(await reopened.ok("get_doc", { uuid: created.uuid })).toEqual({ ...before, data });
    expect(await reopened.ok("get_data", {
      uuid: created.uuid, collection: "observations",
    })).toEqual(expectedPage);
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
    await rig.ok("update_data", { uuid: created.uuid, operations: [{
      collection: "observations",
      schema: observationSchema,
      upsert: [{ id: "row-1", value: { text: "initial" } }],
    }] });
    for (let step = 1; step <= 6; step += 1) {
      await rig.ok("update_data", { uuid: created.uuid, operations: [{
        collection: "observations",
        upsert: [{ id: "row-1", value: { text: `revision ${step}` } }],
      }] });
    }
    await rig.ok("sync_status");
    const room = `${WORKSPACE}/${created.uuid}`;
    expect(rig.instance.store.snapshot(room)).not.toBeNull();
    expect(rig.instance.store.updateCount(room)).toBeLessThan(4);

    // Keep a data-only deletion after the snapshot as a log-tail update.
    await rig.ok("update_data", { uuid: created.uuid, operations: [{
      collection: "observations",
      deleteRecords: ["row-1"],
      upsert: [{ id: "row-2", value: { text: "tail survives" } }],
    }] });
    const expected = readDocData(replicaDoc);
    const expectedPage = await rig.ok("get_data", {
      uuid: created.uuid, collection: "observations",
    });
    expect(rig.instance.store.updateCount(room)).toBe(1);
    expect(persistedData(databasePath, room)).toEqual(expected);
    await close(rig);

    const reopened = await server({ databasePath });
    expect(await reopened.ok("get_data", {
      uuid: created.uuid, collection: "observations",
    })).toEqual(expectedPage);
    expect(readDocData(doc(reopened, created.uuid))).toEqual(expected);
  });

  it("exchanges MCP data between two processes on one database and survives an abrupt restart", async () => {
    const databasePath = tempDatabasePath();
    const writer = await processClient(databasePath);
    const reader = await processClient(databasePath);
    expect(writer.pid).not.toBe(reader.pid);
    // Both processes start before either creates the document, so the reader
    // must discover the directory and document log tails on its next call.
    const created = await writer.ok("create_doc", {
      title: "Shared local document data",
      description: "A synthetic multi-process persistence fixture.",
    });
    const operations = [{
      collection: "observations",
      schema: observationSchema,
      upsert: [{ id: "row-1", value: { text: "from first process" } }],
    }];
    expect(await writer.ok("update_data", { uuid: created.uuid, operations }))
      .toMatchObject({ changed: true, applied: true, synced: false });
    const args = { uuid: created.uuid, collection: "observations" };
    expect(await reader.ok("get_data", args)).toEqual(await writer.ok("get_data", args));

    expect(await reader.ok("update_data", {
      uuid: created.uuid,
      operations: [{
        collection: "observations",
        upsert: [{ id: "row-2", value: { text: "from second process" } }],
      }],
    })).toMatchObject({ changed: true, applied: true, synced: false });
    const expected = await reader.ok("get_data", args);
    expect(await writer.ok("get_data", args)).toEqual(expected);
    expect(expected.records.map((record: { id: string }) => record.id))
      .toEqual(["row-1", "row-2"]);

    // A completed response must be durable even if shutdown never runs.
    process.kill(writer.pid, "SIGKILL");
    await waitUntil("the killed MCP writer to exit", () => !alive(writer.pid));
    await writer.close();
    await reader.close();
    const restarted = await processClient(databasePath);
    expect(await restarted.ok("get_data", args)).toEqual(expected);
    await restarted.close();
  });

  it("fails closed when an MCP data append fails and reopens the unchanged log", async () => {
    const databasePath = tempDatabasePath();
    const faulty = new FailingStore(databasePath, WORKSPACE);
    const rig = await server({ databasePath }, faulty);
    const created = await rig.ok("create_doc", {
      title: "Data append refusal",
      description: "A synthetic persistence failure fixture.",
    });
    faulty.failing = true;
    const refused = await rig.call("update_data", {
      uuid: created.uuid,
      operations: [{
        collection: "observations",
        schema: observationSchema,
        upsert: [{ id: "row-1", value: { text: "must not become durable" } }],
      }],
    });
    expect(refused.isError).toBe(true);
    expect(refused.payload).toMatchObject({
      error: "persistence_failed", applied: false, partial: false,
    });
    expect(persistedData(databasePath, `${WORKSPACE}/${created.uuid}`)).toBeNull();
    const blockedRead = await rig.call("get_data", { uuid: created.uuid });
    expect(blockedRead.isError).toBe(true);
    expect(blockedRead.payload.error).toBe("persistence_failed");

    faulty.failing = false;
    await close(rig);
    const reopened = await server({ databasePath });
    expect(await reopened.ok("get_data", { uuid: created.uuid }))
      .toEqual({ uuid: created.uuid, data: null });
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

    const writes = await Promise.all([
      producer.ok("update_data", { uuid: created.uuid, operations: [{
        collection: "observations",
        schema: observationSchema,
        upsert: [{ id: "row-1", value: { text: "producer observation" } }],
      }] }),
      human.ok("update_data", { uuid: created.uuid, operations: [{
        collection: "dispositions",
        schema: observationSchema,
        upsert: [{ id: "row-1", value: { text: "human disposition" } }],
      }] }),
    ]);
    for (const write of writes) {
      expect(write).toMatchObject({ changed: true, applied: true, synced: false });
    }
    await waitUntil("both independent data collections to converge", async () => {
      const producerData = (await producer.ok("get_data", { uuid: created.uuid })).data;
      const humanData = (await human.ok("get_data", { uuid: created.uuid })).data;
      return (
        producerData?.collections.length === 2 &&
        JSON.stringify(producerData) === JSON.stringify(humanData)
      );
    });
    const disposition = await human.ok("get_data", {
      uuid: created.uuid, collection: "dispositions",
    });
    expect(disposition.records).toEqual([
      expect.objectContaining({ id: "row-1", value: { text: "human disposition" } }),
    ]);
    const refresh = [{
      collection: "observations",
      replaceRecords: [{ id: "row-2", value: { text: "producer refresh" } }],
    }];
    expect(await producer.ok("update_data", { uuid: created.uuid, operations: refresh }))
      .toMatchObject({ changed: true, applied: true, synced: false });
    await waitUntil("the producer full replacement to reach the second replica", async () => {
      const page = await human.ok("get_data", {
        uuid: created.uuid, collection: "observations",
      });
      return page.records.length === 1 && page.records[0].id === "row-2";
    });
    expect(await human.ok("get_data", {
      uuid: created.uuid, collection: "dispositions",
    })).toEqual(disposition);
    await synced(producer);
    await synced(human);
    expect(await producer.ok("update_data", { uuid: created.uuid, operations: refresh }))
      .toMatchObject({ changed: false, applied: true, synced: true });
    const expected = readDocData(doc(producer, created.uuid));
    const expectedPage = await producer.ok("get_data", {
      uuid: created.uuid, collection: "observations",
    });

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
    await waitUntil("hub snapshot data to hydrate a fresh local mirror", async () =>
      JSON.stringify(await fresh.ok("get_data", {
        uuid: created.uuid, collection: "observations",
      })) === JSON.stringify(expectedPage),
    );
    expect(await fresh.ok("get_data", {
      uuid: created.uuid, collection: "dispositions",
    })).toEqual(disposition);
    expect(persistedData(fresh.config.databasePath, `${WORKSPACE}/${created.uuid}`))
      .toEqual(expected);
  });
});

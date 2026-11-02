/** Hosted replies follow real hub acknowledgement while stdio remains immediate. */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { readOriginUpdate } from "@uberblick/schema";
import { afterEach, expect, it, vi } from "vitest";
import { createMcpRuntime, type UberblickMcpRuntime } from "../src/server.js";
import {
  cleanupTestResources, FailingStore, hubUrl, LIVE_HUB_SETTLE, startHub,
  startServer, testConfig, TEST_SECRET, waitUntil, WORKSPACE,
} from "./helpers.js";

const clients: (() => Promise<void>)[] = [];
const runtimes: UberblickMcpRuntime[] = [];
const hubs: (() => Promise<void>)[] = [];
const releases: (() => void)[] = [];

afterEach(async () => {
  for (const release of releases.splice(0)) release();
  await cleanupTestResources({
    clients: clients.splice(0),
    peers: runtimes.splice(0).map(runtime => () => runtime.close(performance.now() + 100)),
    hubs: hubs.splice(0),
    after: [() => vi.restoreAllMocks()],
  });
});

async function fixture(syncTimeoutMs: number = LIVE_HUB_SETTLE.syncTimeoutMs) {
  const hub = await startHub();
  hubs.push(() => hub.stop());
  const config = testConfig({
    authSecret: TEST_SECRET, hubUrl: hubUrl(hub.port), ...LIVE_HUB_SETTLE, syncTimeoutMs,
  });
  const runtime = createMcpRuntime(config, { waitForWriteAcknowledgement: true });
  runtimes.push(runtime);
  const session = runtime.openSession();
  const client = new Client({ name: "hosted writes", version: "1" });
  clients.push(() => client.close());
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([session.connect(serverTransport), client.connect(clientTransport)]);
  await client.listTools();
  const call = async (name: string, args: Record<string, unknown> = {}): Promise<any> => {
    const result = await client.callTool({ name, arguments: args });
    expect(result.isError).not.toBe(true);
    return result.structuredContent;
  };
  const created = await call("create_doc", {
    title: "Acknowledged hosted write", description: "Hosted writes wait for the hub.",
    blocks: [{ type: "paragraph", text: "Original" }],
  });
  return { hub, config, runtime, session, client, call, created };
}

function holdUpdates(hub: Awaited<ReturnType<typeof startHub>>, room: string) {
  let enter!: () => void;
  let release!: () => void;
  const entered = new Promise<void>(resolve => { enter = resolve; });
  const held = new Promise<void>(resolve => { release = resolve; });
  releases.push(release);
  const connection = hub.hocuspocus.documents.get(room)?.getConnections()[0];
  if (connection === undefined) throw new Error("The writer must have joined the room before holding its updates.");
  const stateless = connection.callbacks.statelessCallback;
  connection.onStatelessCallback(async payload => {
    if (readOriginUpdate(payload.payload) !== null) {
      enter();
      await held;
    }
    await stateless(payload);
  });
  return { entered, release };
}

it("acknowledges multi-room, document, sidebar and settings writes before replying", async () => {
  const { runtime, call, created } = await fixture();
  expect(created).toMatchObject({ applied: true, synced: true });
  expect(created.rooms.length).toBeGreaterThan(1);
  expect(created.rooms.every((room: { synced: boolean }) => room.synced)).toBe(true);
  for (const [name, args] of [
    ["edit_block", { uuid: created.uuid, block_id: created.blocks[0].id, old_text: "Original", new_text: "Acknowledged" }],
    ["set_metadata", { uuid: created.uuid, title: "Acknowledged metadata" }],
    ["pin_doc", { uuid: created.uuid, group: "Hosted" }],
    ["create_tag", { name: "hosted-write" }],
  ] as const) {
    expect(await call(name, args)).toMatchObject({ applied: true, synced: true });
  }
  const tags = await call("list_tags");
  const tag = tags.tags.find((entry: { name: string }) => entry.name === "hosted-write");
  expect(await call("set_metadata", { uuid: created.uuid, tags: [tag.id] }))
    .toMatchObject({ applied: true, synced: true });
  expect(await call("create_tag", { name: "hosted-write" }))
    .toMatchObject({ applied: true, synced: true });
  expect(runtime.store.pendingRooms()).toEqual([]);
});

it("keeps the admitted call busy until the hub acknowledges its write", async () => {
  const { hub, runtime, session, call, created } = await fixture();
  const room = `${WORKSPACE}/${created.uuid}`;
  const held = holdUpdates(hub, room);
  let answered = false;
  const write = call("edit_block", {
    uuid: created.uuid, block_id: created.blocks[0].id, old_text: "Original", new_text: "Held update",
  }).then(result => { answered = true; return result; });
  await held.entered;
  expect(runtime.store.pendingRooms().some(entry => entry.room === room)).toBe(true);
  expect(answered).toBe(false);
  expect(session.activeCalls).toBe(1);
  held.release();
  expect(await write).toMatchObject({ applied: true, synced: true });
  expect(session.activeCalls).toBe(0);
});

it("returns an applied unsynced write when a connected hub withholds acknowledgement past the bound", async () => {
  const { hub, runtime, call, created } = await fixture(1_000);
  const room = `${WORKSPACE}/${created.uuid}`;
  const held = holdUpdates(hub, room);
  const write = call("set_metadata", { uuid: created.uuid, title: "Still only local" });
  await held.entered;
  expect(await write).toMatchObject({ applied: true, synced: false });
  expect(runtime.store.pendingRooms().some(entry => entry.room === room)).toBe(true);
  held.release();
  await waitUntil("the bounded hosted write to be acknowledged later", () => {
    runtime.replicas.refresh();
    return runtime.store.pendingRooms().length === 0;
  });
});

it("includes an implicit directory update in the acknowledgement of a document metadata write", async () => {
  const { hub, runtime, call, created } = await fixture(1_000);
  const directory = runtime.replicas.directory().room;
  const held = holdUpdates(hub, directory);
  const write = call("set_metadata", { uuid: created.uuid, title: "Directory also needs acknowledgement" });
  await held.entered;
  expect(await write).toMatchObject({ applied: true, synced: false });
  expect(runtime.replicas.isRoomQuiet(`${WORKSPACE}/${created.uuid}`)).toBe(true);
  expect(runtime.store.pendingRooms().some(entry => entry.room === directory)).toBe(true);
  held.release();
});

it("keeps concurrently admitted writes' acknowledgement rooms independent", async () => {
  const { hub, runtime, session, call, created } = await fixture(1_000);
  const second = await call("create_doc", {
    title: "Independent write", description: "Another room has its own acknowledgement.",
    blocks: [{ type: "paragraph", text: "Original second" }],
  });
  const firstGate = holdUpdates(hub, `${WORKSPACE}/${created.uuid}`);
  const secondGate = holdUpdates(hub, `${WORKSPACE}/${second.uuid}`);
  let releaseSettles!: () => void;
  const settled = new Promise<void>(resolve => { releaseSettles = resolve; });
  releases.push(releaseSettles);
  let ready = 0;
  const settle = runtime.replicas.settle.bind(runtime.replicas);
  const spy = vi.spyOn(runtime.replicas, "settle").mockImplementation(async options => {
    await settle(options);
    ready += 1;
    await settled;
  });
  const firstWrite = call("edit_block", {
    uuid: created.uuid, block_id: created.blocks[0].id, old_text: "Original", new_text: "First independent write",
  });
  const secondWrite = call("edit_block", {
    uuid: second.uuid, block_id: second.blocks[0].id, old_text: "Original second", new_text: "Second independent write",
  });
  await waitUntil("both admitted writes to finish their opening settle", () => ready === 2);
  spy.mockRestore();
  releaseSettles();
  await Promise.all([firstGate.entered, secondGate.entered]);
  expect(session.activeCalls).toBe(2);
  firstGate.release();
  expect(await firstWrite).toMatchObject({ applied: true, synced: true });
  expect(await secondWrite).toMatchObject({ applied: true, synced: false });
  secondGate.release();
});

it("keeps hosted writes applied and unsynced when the hub is down", async () => {
  const { hub, runtime, call, created } = await fixture();
  await hub.stop();
  const before = performance.now();
  expect(await call("set_metadata", { uuid: created.uuid, title: "Offline hosted write" }))
    .toMatchObject({ applied: true, synced: false });
  expect(performance.now() - before).toBeLessThan(5_000);
  expect(runtime.store.pendingRooms().length).toBeGreaterThan(0);
});

it("keeps stdio replies immediate while a real hub holds the write", async () => {
  const hub = await startHub();
  hubs.push(() => hub.stop());
  const rig = await startServer(testConfig({ authSecret: TEST_SECRET, hubUrl: hubUrl(hub.port), ...LIVE_HUB_SETTLE }));
  clients.push(() => rig.close());
  const created = await rig.ok("create_doc", { title: "Local reply", description: "Stdio remains immediate." });
  expect((await rig.instance.replicas.waitForSettled()).caughtUp).toBe(true);
  const held = holdUpdates(hub, `${WORKSPACE}/${created.uuid}`);
  expect(await rig.ok("set_metadata", { uuid: created.uuid, title: "No acknowledgement wait" }))
    .toMatchObject({ applied: true, synced: false });
  await held.entered;
  held.release();
});

it("preserves partial persistence failures when the acknowledgement wait itself fails", async () => {
  const config = testConfig();
  const store = new FailingStore(config.databasePath, WORKSPACE);
  const runtime = createMcpRuntime(config, { store, waitForWriteAcknowledgement: true });
  runtimes.push(runtime);
  const session = runtime.openSession();
  const client = new Client({ name: "failed hosted write", version: "1" });
  clients.push(() => client.close());
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([session.connect(serverTransport), client.connect(clientTransport)]);
  store.failing = true;
  store.failRoom = room => room.endsWith("/_directory");
  vi.spyOn(runtime.replicas, "waitForSettled").mockRejectedValueOnce(new Error("wait failed"));
  vi.spyOn(console, "error").mockImplementation(() => {});
  const result = await client.callTool({
    name: "create_doc", arguments: { title: "Partial", description: "Keep the accepted room." },
  }) as CallToolResult;
  expect(result.isError).toBe(true);
  const content = result.content[0];
  if (content?.type !== "text") throw new Error("Expected a JSON failure.");
  expect(JSON.parse(content.text)).toMatchObject({
    error: "persistence_failed", applied: false, partial: true, synced: false, rolledBack: false,
    completed: [{ purpose: "document", applied: true, synced: false }], failed: { purpose: "directory" },
  });
});

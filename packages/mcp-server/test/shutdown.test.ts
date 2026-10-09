/** Shutdown keeps admitted calls and startup work on live replicas. */
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { getMeta } from "@uberblick/schema";
import { afterAll, expect, it, vi } from "vitest";
import type { Replicas, Replica } from "../src/replica.js";
import { createMcpServer } from "../src/server.js";
import {
  removeTempDirs,
  sleep,
  startServer,
  testConfig,
  TEST_SECRET,
} from "./helpers.js";

afterAll(removeTempDirs);

function gate(): { entered: Promise<void>; release(): void; wait(): Promise<void> } {
  let enter!: () => void;
  let release!: () => void;
  const entered = new Promise<void>((resolve) => { enter = resolve; });
  const released = new Promise<void>((resolve) => { release = resolve; });
  return {
    entered,
    release,
    async wait() {
      enter();
      await released;
    },
  };
}

/** Hold the real runSettle hub wait, keeping the handler's write synchronous. */
function holdHubWait(replicas: Replicas) {
  const held = gate();
  const waitForQuiet = replicas.sync.waitForQuiet.bind(replicas.sync);
  vi.spyOn(replicas.sync, "waitForQuiet").mockImplementation(async () => {
    await held.wait();
    await waitForQuiet();
  });
  (replicas as unknown as { settleNeeded: boolean }).settleNeeded = true;
  return held;
}

function watchDestruction(replicas: Replicas, order: string[]) {
  let destroyed = false;
  let accessesAfterDestroy = 0;
  const destroy = replicas.destroy.bind(replicas);
  vi.spyOn(replicas, "destroy").mockImplementation(() => {
    destroyed = true;
    order.push("replicas destroyed");
    destroy();
  });
  const rooms = replicas as unknown as { ensureRoom(room: string, id: string): Replica };
  const ensureRoom = rooms.ensureRoom.bind(rooms);
  vi.spyOn(rooms, "ensureRoom").mockImplementation((room, id) => {
    if (destroyed) accessesAfterDestroy += 1;
    return ensureRoom(room, id);
  });
  return { destroyed: () => destroyed, accessesAfterDestroy: () => accessesAfterDestroy };
}

it("closes the transport, drains a write waiting on the hub, then destroys replicas and closes the store", async () => {
  const config = testConfig({ authSecret: TEST_SECRET });
  const rig = await startServer(config);
  const { uuid } = await rig.ok("create_doc", {
    title: "Before shutdown",
    description: "A write must survive the client's departure.",
  });
  const room = rig.instance.replicas.replica(uuid).room;
  const held = holdHubWait(rig.instance.replicas);
  const order: string[] = [];
  const watched = watchDestruction(rig.instance.replicas, order);
  const serverClose = rig.instance.server.close.bind(rig.instance.server);
  vi.spyOn(rig.instance.server, "close").mockImplementation(async () => {
    await serverClose();
    order.push("transport closed");
  });
  const appendUpdate = rig.instance.store.appendUpdate.bind(rig.instance.store);
  vi.spyOn(rig.instance.store, "appendUpdate").mockImplementation((target, payload, origin) => {
    if (target === room) order.push("write logged");
    return appendUpdate(target, payload, origin);
  });
  const storeClose = rig.instance.store.close.bind(rig.instance.store);
  vi.spyOn(rig.instance.store, "close").mockImplementation(() => {
    order.push("store closed");
    storeClose();
  });

  const write = rig.call("set_metadata", { uuid, title: "Written during shutdown" }).catch((error: unknown) => error);
  let closing: Promise<void> | undefined;
  try {
    await held.entered;
    closing = rig.instance.close();
    await sleep(25);
    const destroyedWhileWaiting = watched.destroyed();
    held.release();
    await closing;
    // Closing the SDK transport drops the response, but does not cancel the write.
    expect(await write).toBeInstanceOf(Error);

    const reopened = await startServer(testConfig({ databasePath: config.databasePath }));
    try {
      expect(getMeta(reopened.instance.replicas.replica(uuid).doc).title).toBe("Written during shutdown");
    } finally {
      await reopened.close();
    }
    expect(destroyedWhileWaiting).toBe(false);
    expect(watched.accessesAfterDestroy()).toBe(0);
    expect(order).toEqual([
      "transport closed",
      "write logged",
      "replicas destroyed",
      "store closed",
    ]);
  } finally {
    held.release();
    await (closing ?? rig.instance.close());
    await write;
    await rig.client.close();
  }
});

it("drains startup seeding without attaching the transport after shutdown begins", async () => {
  const instance = createMcpServer(testConfig({ authSecret: TEST_SECRET }));
  const held = holdHubWait(instance.replicas);
  const order: string[] = [];
  const watched = watchDestruction(instance.replicas, order);
  const [, transport] = InMemoryTransport.createLinkedPair();
  const attached = vi.spyOn(transport, "start");
  const [, lateTransport] = InMemoryTransport.createLinkedPair();
  const lateAttached = vi.spyOn(lateTransport, "start");
  const connecting = instance.connect(transport).catch((error: unknown) => error);
  let closing: Promise<void> | undefined;
  try {
    await held.entered;
    closing = instance.close();
    await sleep(25);
    const destroyedWhileWaiting = watched.destroyed();
    held.release();
    expect(await connecting).not.toBeInstanceOf(Error);
    await closing;
    expect(destroyedWhileWaiting).toBe(false);
    expect(watched.accessesAfterDestroy()).toBe(0);
    expect(attached).not.toHaveBeenCalled();
    await instance.connect(lateTransport);
    expect(lateAttached).not.toHaveBeenCalled();
  } finally {
    held.release();
    await connecting;
    await (closing ?? instance.close());
    await transport.close();
    await lateTransport.close();
  }
});

it("rejects later calls without a write and lets repeated closes await the same drain", async () => {
  const rig = await startServer(testConfig({ authSecret: TEST_SECRET }));
  const { uuid } = await rig.ok("create_doc", {
    title: "Only the admitted call may write",
    description: "Later requests never reach the replica set.",
  });
  const held = holdHubWait(rig.instance.replicas);
  const storeClose = vi.spyOn(rig.instance.store, "close");
  const admitted = rig.call("set_metadata", { uuid, title: "Admitted" }).catch((error: unknown) => error);
  let first: Promise<void> | undefined;
  let second: Promise<void> | undefined;
  try {
    await held.entered;
    first = rig.instance.close();
    let secondFinished = false;
    second = rig.instance.close().then(() => { secondFinished = true; });
    await sleep(25);
    const secondFinishedWhileWaiting = secondFinished;
    const late = await rig.call("set_metadata", { uuid, title: "Too late" }).catch((error: unknown) => error);
    expect(late).toBeInstanceOf(Error);
    held.release();
    await Promise.all([first, second]);
    await admitted;
    const reopened = await startServer(testConfig({ databasePath: rig.config.databasePath }));
    try {
      expect(getMeta(reopened.instance.replicas.replica(uuid).doc).title).toBe("Admitted");
    } finally {
      await reopened.close();
    }
    expect(secondFinishedWhileWaiting).toBe(false);
    expect(storeClose).toHaveBeenCalledTimes(1);
  } finally {
    held.release();
    await Promise.all([first ?? rig.instance.close(), second]);
    await admitted;
    await rig.client.close();
  }
});

it("refuses tool and resource callbacks dispatched while the transport is closing", async () => {
  const rig = await startServer(testConfig());
  const { uuid } = await rig.ok("create_doc", {
    title: "Keep this title",
    description: "A callback retained by the transport must still be refused.",
  });
  // Retain the SDK's registered callbacks, as a transport can before closing.
  const registered = rig.instance.server as unknown as {
    _registeredTools: Record<string, {
      handler(args: { uuid: string; title: string }): Promise<CallToolResult>;
    }>;
    _registeredResourceTemplates: Record<string, {
      resourceTemplate: { listCallback(): unknown };
      readCallback(uri: URL, variables: { uuid: string }): unknown;
    }>;
  };
  const rename = registered._registeredTools.set_metadata!.handler;
  const guidance = registered._registeredResourceTemplates.guidance!;
  const held = gate();
  const serverClose = rig.instance.server.close.bind(rig.instance.server);
  vi.spyOn(rig.instance.server, "close").mockImplementation(async () => {
    await held.wait();
    await serverClose();
  });
  const closing = rig.instance.close();
  try {
    await held.entered;
    const settle = vi.spyOn(rig.instance.replicas, "settle");
    const refresh = vi.spyOn(rig.instance.replicas, "refresh");
    const append = vi.spyOn(rig.instance.store, "appendUpdate");
    const refused = await rename({ uuid, title: "Too late" });
    expect(refused.isError).toBe(true);
    const content = refused.content[0];
    expect(content?.type).toBe("text");
    if (content?.type !== "text") throw new Error("A refusal must contain its JSON failure payload.");
    expect(JSON.parse(content.text)).toMatchObject({ error: "server_shutting_down", applied: false });
    expect(() => guidance.resourceTemplate.listCallback()).toThrow(/shutting down/i);
    expect(() => guidance.readCallback(new URL(`uberblick://doc/${uuid}`), { uuid })).toThrow(/shutting down/i);
    expect(settle).not.toHaveBeenCalled();
    expect(refresh).not.toHaveBeenCalled();
    expect(append).not.toHaveBeenCalled();
  } finally {
    held.release();
    await closing;
    await rig.client.close();
  }
  const readSince = vi.spyOn(rig.instance.store, "readSince");
  expect(() => rig.instance.replicas.settings()).toThrow("Cannot open a room on destroyed replicas.");
  expect(readSince).not.toHaveBeenCalled();
  const reopened = await startServer(testConfig({ databasePath: rig.config.databasePath }));
  try {
    expect(getMeta(reopened.instance.replicas.replica(uuid).doc).title).toBe("Keep this title");
  } finally {
    await reopened.close();
  }
});

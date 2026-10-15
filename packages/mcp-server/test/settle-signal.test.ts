import { HocuspocusProvider } from "@hocuspocus/provider";
import { afterEach, expect, it, vi } from "vitest";
import { messageYjsSyncStep2 } from "y-protocols/sync";
import { HubSync } from "../src/sync.js";
import {
  hubUrl,
  LIVE_HUB_SETTLE,
  peerClient,
  removeTempDirs,
  startHub,
  startServer,
  testConfig,
  TEST_SECRET,
  waitUntil,
  WORKSPACE,
} from "./helpers.js";

const cleanup: Array<() => void | Promise<void>> = [];

afterEach(async () => {
  vi.restoreAllMocks();
  for (const close of cleanup.splice(0).reverse()) await close();
  removeTempDirs();
});

it("wakes from caller state without polling, and removes subscriptions after every ending", async () => {
  const hub = await startHub();
  cleanup.push(() => hub.stop());
  const sync = new HubSync(testConfig({
    authSecret: TEST_SECRET, hubUrl: hubUrl(hub.port), ...LIVE_HUB_SETTLE,
  }), () => {});
  cleanup.push(() => sync.destroy());
  expect(await sync.waitForQuiet()).toEqual({ caughtUp: true, reason: "caught-up" });

  const predicate = vi.fn(() => false);
  const unsubscribe = vi.fn();
  let wake = () => {};
  const waiting = sync.waitForQuiet({
    isQuiet: predicate,
    subscribe: (listener) => { wake = listener; return unsubscribe; },
  });
  await new Promise<void>((resolve) => setImmediate(resolve));
  expect(predicate).toHaveBeenCalledTimes(1);
  predicate.mockReturnValue(true);
  wake();
  expect(await waiting).toEqual({ caughtUp: true, reason: "caught-up" });
  expect(predicate).toHaveBeenCalledTimes(2);
  expect(unsubscribe).toHaveBeenCalledOnce();
  wake();
  await new Promise<void>((resolve) => setImmediate(resolve));
  expect(predicate).toHaveBeenCalledTimes(2);

  expect(await sync.waitForQuiet({ isQuiet: () => false, deadline: performance.now() }))
    .toEqual({ caughtUp: false, reason: "deadline" });
  const destroyed = sync.waitForQuiet({ isQuiet: () => false });
  sync.destroy();
  expect(await destroyed).toEqual({ caughtUp: false, reason: "unavailable" });
});

it("rejects caller predicate failures and releases the caller subscription", async () => {
  const hub = await startHub();
  cleanup.push(() => hub.stop());
  const sync = new HubSync(testConfig({
    authSecret: TEST_SECRET, hubUrl: hubUrl(hub.port), ...LIVE_HUB_SETTLE,
  }), () => {});
  cleanup.push(() => sync.destroy());
  await sync.waitForQuiet();
  const unsubscribe = vi.fn();
  await expect(sync.waitForQuiet({
    isQuiet: () => { throw new Error("replica refresh failed"); },
    subscribe: () => unsubscribe,
  })).rejects.toThrow("replica refresh failed");
  expect(unsubscribe).toHaveBeenCalledOnce();
});

it("keeps reconnect writes unacknowledged through the auth-to-handshake gap and the held diff", async () => {
  const hub = await startHub();
  cleanup.push(() => hub.stop());
  const rig = await startServer(testConfig({
    authSecret: TEST_SECRET, hubUrl: hubUrl(hub.port), ...LIVE_HUB_SETTLE,
    syncTimeoutMs: 500,
  }));
  cleanup.push(() => rig.close());
  const created = await rig.ok("create_doc", {
    title: "Reconnect acknowledgement",
    description: "A held reconnect diff must keep every acknowledgement reading false.",
  });
  expect((await rig.instance.replicas.waitForSettled()).caughtUp).toBe(true);
  const replica = rig.instance.replicas.replica(created.uuid);
  const room = `${WORKSPACE}/${created.uuid}`;
  const peer = await peerClient(hub.port, room);
  cleanup.push(() => peer.destroy());
  await peer.synced;
  let originalConnection = hub.hocuspocus.documents.get(room)?.getConnections()
    .find((connection) => "sub" in connection.context && connection.context.sub === rig.config.sessionId);
  await waitUntil("the writer's hub connection", () => {
    originalConnection = hub.hocuspocus.documents.get(room)?.getConnections()
      .find((connection) => "sub" in connection.context && connection.context.sub === rig.config.sessionId);
    return originalConnection !== undefined;
  });
  if (originalConnection === undefined) throw new Error("writer connection disappeared");

  let release = () => {};
  const held = new Promise<void>((resolve) => { release = resolve; });
  cleanup.push(release);
  let entered = false;
  hub.hocuspocus.configuration.extensions.push({
    async beforeSync({ documentName, context, connection, type }) {
      if (documentName !== room || !("sub" in context) || context.sub !== rig.config.sessionId ||
        connection === originalConnection || type !== messageYjsSyncStep2) return;
      entered = true;
      await held;
    },
  });

  let injected = false;
  const sendToken = HocuspocusProvider.prototype.sendToken;
  vi.spyOn(HocuspocusProvider.prototype, "sendToken").mockImplementation(async function (this: HocuspocusProvider) {
    if (this.document !== replica.doc || injected) return sendToken.call(this);
    injected = true;
    this.document.getText("offline").insert(0, "reconnect diff");
    await sendToken.call(this);
    // sendToken has sent auth, but onOpen has not resumed to reset the count.
    this.document.getText("gap").insert(0, "written after auth");
  });
  originalConnection.close();
  await waitUntil("the writer's reconnect diff to enter beforeSync", () => entered);
  expect(injected).toBe(true);
  expect(hub.hocuspocus.documents.get(room)?.getText("offline").toString()).toBe("");
  expect(rig.instance.replicas.isRoomQuiet(room)).toBe(false);
  expect(await rig.instance.replicas.waitForSettled({
    rooms: [room], deadline: performance.now() + 10,
  })).toEqual({ caughtUp: false, reason: "deadline" });
  const status = await rig.ok("sync_status");
  expect(status.rooms.find((entry: { room: string }) => entry.room === room)?.synced).toBe(false);
  const written = await rig.ok("set_metadata", { uuid: created.uuid, title: "Held reconnect" });
  expect(written).toMatchObject({ applied: true, synced: false });

  release();
  expect((await rig.instance.replicas.waitForSettled()).caughtUp).toBe(true);
  await waitUntil("the hub to hold both reconnect changes", () =>
    hub.hocuspocus.documents.get(room)?.getText("offline").toString() === "reconnect diff" &&
    hub.hocuspocus.documents.get(room)?.getText("gap").toString() === "written after auth");
});

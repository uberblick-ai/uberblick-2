/** Pending-marker release must follow acknowledgement of the applied log cut. */
import { randomUUID } from "node:crypto";
import { appendBlock, roomForDoc } from "@uberblick/schema";
import type { Hub } from "@uberblick/hub";
import * as Y from "yjs";
import { afterEach, expect, it, vi } from "vitest";
import { MirrorStore } from "../src/store.js";
import {
  hubUrl,
  LIVE_HUB_SETTLE,
  removeTempDirs,
  startHub,
  startServer,
  tempDatabasePath,
  testConfig,
  TEST_SECRET,
  waitUntil,
  WORKSPACE,
} from "./helpers.js";
import type { Rig } from "./helpers.js";

const rigs: Rig[] = [];
const hubs: Hub[] = [];
const stores: MirrorStore[] = [];
const releases: (() => void)[] = [];

afterEach(async () => {
  for (const release of releases.splice(0)) release();
  for (const rig of rigs.splice(0)) await rig.close();
  for (const store of stores.splice(0)) store.close();
  for (const hub of hubs.splice(0)) await hub.stop();
  vi.restoreAllMocks();
  removeTempDirs();
});

function gate() {
  let release!: () => void;
  let enter!: () => void;
  const entered = new Promise<void>((resolve) => { enter = resolve; });
  const held = new Promise<void>((resolve) => { release = resolve; });
  releases.push(release);
  return { entered, release, async wait() { enter(); await held; } };
}

async function fixture(store?: MirrorStore) {
  const hub = await startHub();
  hubs.push(hub);
  const rig = await startServer(testConfig({
    ...(store === undefined ? {} : { databasePath: store.databasePath }),
    authSecret: TEST_SECRET,
    hubUrl: hubUrl(hub.port),
    ...LIVE_HUB_SETTLE,
  }), store);
  rigs.push(rig);
  const { uuid } = await rig.ok("create_doc", {
    title: "Shutdown acknowledgement",
    description: "Pending local changes must reach the hub before release.",
  });
  await waitUntil("the initial changes to be acknowledged", () => {
    rig.instance.replicas.refresh();
    return rig.instance.store.pendingRooms().length === 0;
  });
  return { hub, rig, replica: rig.instance.replicas.replica(uuid) };
}

it("finishes when its pending write is acknowledged while unrelated hydration remains blocked", async () => {
  const { hub, rig, replica } = await fixture();
  const unrelated = roomForDoc(WORKSPACE, randomUUID());
  const hydration = gate();
  hub.hocuspocus.configuration.extensions.push({
    onLoadDocument: async ({ documentName }) => {
      if (documentName === unrelated) await hydration.wait();
    },
  });
  const blocked = rig.instance.replicas.replica(unrelated.slice(WORKSPACE.length + 1));
  await hydration.entered;
  appendBlock(replica.doc, { type: "paragraph", text: "The last local write." });
  expect(rig.instance.store.pendingRooms().some(({ room }) => room === replica.room)).toBe(true);

  const started = performance.now();
  const pending = await rig.instance.replicas.waitForPendingChanges(started + 5_000);
  expect(pending).toBe(0);
  expect(performance.now() - started).toBeLessThan(2_000);
  expect(rig.instance.replicas.sync.isRoomQuiet(unrelated)).toBe(false);

  // Once that room also holds a local write, a timeout keeps only its marker.
  appendBlock(blocked.doc, { type: "paragraph", text: "This room has not answered." });
  appendBlock(replica.doc, { type: "paragraph", text: "This room can acknowledge again." });
  expect(await rig.instance.replicas.waitForPendingChanges(performance.now() + 500)).toBe(1);
  expect(rig.instance.store.pendingRooms().map(({ room }) => room)).toEqual([unrelated]);
});

/** Inject another process's append after a poll, before a pending marker read. */
class LatePendingStore extends MirrorStore {
  private hook: (() => void) | null = null;

  beforeNextPendingRead(hook: () => void): void {
    this.hook = hook;
  }

  override pendingRooms() {
    const hook = this.hook;
    this.hook = null;
    hook?.();
    return super.pendingRooms();
  }
}

it("retains a newer cross-process append between the final poll and marker release", async () => {
  const store = new LatePendingStore(tempDatabasePath(), WORKSPACE);
  const { rig, replica } = await fixture(store);
  const outside = new MirrorStore(store.databasePath, WORKSPACE);
  stores.push(outside);
  const foreign = new Y.Doc();
  Y.applyUpdate(foreign, Y.encodeStateAsUpdate(replica.doc));
  let update!: Uint8Array;
  foreign.on("update", (payload: Uint8Array) => { update = payload; });
  appendBlock(foreign, { type: "paragraph", text: "A later process's write." });
  foreign.destroy();

  let appendedSeq = 0;
  const waitForQuiet = rig.instance.replicas.sync.waitForQuiet.bind(rig.instance.replicas.sync);
  vi.spyOn(rig.instance.replicas.sync, "waitForQuiet").mockImplementation(async (options) => {
    await waitForQuiet(options);
    store.beforeNextPendingRead(() => {
      appendedSeq = outside.appendUpdate(replica.room, update, "local");
    });
  });
  appendBlock(replica.doc, { type: "paragraph", text: "The acknowledged write." });
  const pending = await rig.instance.replicas.waitForPendingChanges(performance.now() + 5_000);
  expect(appendedSeq).toBeGreaterThan(0);
  expect(pending).toBe(1);
  expect(store.pendingRooms()).toEqual([{ room: replica.room, seq: appendedSeq }]);
  expect(replica.lastSeq).toBeLessThan(appendedSeq);
});

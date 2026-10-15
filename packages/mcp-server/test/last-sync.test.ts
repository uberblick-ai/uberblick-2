/**
 * Last sync is a best-effort acknowledgement observation stored by the full
 * replica. SQLite cuts remain real here; controlled provider facts isolate the
 * conjunction from transport timing, and one live hub exercises tool settles.
 */

import { performance } from "node:perf_hooks";
import type { Hub } from "@uberblick/hub";

import { afterEach, describe, expect, it, vi } from "vitest";

import type { Replicas } from "../src/replica.js";
import type { MirrorStore } from "../src/store.js";
import { cleanupTestResources, hubUrl, LIVE_HUB_SETTLE, startHub, startServer, testConfig, TEST_SECRET, waitUntil } from "./helpers.js";
import type { Rig } from "./helpers.js";

const T0 = Date.UTC(2031, 0, 1, 0, 0, 0, 987);
const replicasToClose: Replicas[] = [];
const stores: MirrorStore[] = [];
const rigs: Rig[] = [];
const hubs: Hub[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
  await cleanupTestResources({
    clients: [
      ...rigs.splice(0).map((rig) => () => rig.close()),
      ...replicasToClose.splice(0).map((replicas) => () => replicas.destroy()),
    ],
    hubs: hubs.splice(0).map((hub) => () => hub.stop()),
    after: stores.splice(0).map((store) => () => store.close()),
  });
});

function clock(): { wall: number; elapsed: number } {
  const time = { wall: T0, elapsed: 0 };
  vi.spyOn(Date, "now").mockImplementation(() => time.wall);
  vi.spyOn(performance, "now").mockImplementation(() => time.elapsed);
  return time;
}

describe("last acknowledged sync", () => {

  it("returns its current caught-up time from a live hub sync_status settle", async () => {
    const hub = await startHub();
    hubs.push(hub);
    const rig = await startServer(testConfig({
      authSecret: TEST_SECRET,
      hubUrl: hubUrl(hub.port),
      ...LIVE_HUB_SETTLE,
    }));
    rigs.push(rig);
    await waitUntil("the real hub to acknowledge all attached rooms", () =>
      rig.instance.replicas.attachedReplicas().every(({ room }) =>
        rig.instance.replicas.isRoomQuiet(room),
      ),
    );

    const time = clock();
    time.elapsed = 1_000_000;
    const status = await rig.ok("sync_status");
    expect(status.hub.status).toBe("connected");
    expect(status.unsyncedChanges).toBe(0);
    expect(status.lastSync).toBe("2031-01-01T00:00:00Z");
    expect(status.lastSync).toBe(rig.instance.replicas.readLastSync());
  });
});

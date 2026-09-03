/**
 * Fresh-room writes cannot get ahead of the token admission gate.
 *
 * These are real MCP calls over the in-memory MCP transport and a real shared
 * Hocuspocus socket to an in-process hub. The defect lived between those two
 * layers: the provider listened to a room as soon as it was constructed, so an
 * attach-then-write burst named hundreds of unauthenticated rooms before the
 * token gate had admitted them.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { MAX_PENDING_DOCUMENTS } from "@uberblick/hub";
import type { Hub } from "@uberblick/hub";
import {
  hubUrl,
  LIVE_HUB_SETTLE,
  removeTempDirs,
  startHub,
  startServer,
  tempDatabasePath,
  testConfig,
  TEST_SECRET,
  WAIT_TIMEOUT_MS,
  waitUntil,
  WORKSPACE,
} from "./helpers.js";
import type { Rig } from "./helpers.js";

const hubs: Hub[] = [];
const rigs: Rig[] = [];

afterEach(async () => {
  for (const hub of hubs.splice(0)) {
    await hub.stop().catch(() => {});
  }
  for (const rig of rigs.splice(0)) {
    await rig.close();
  }
  vi.restoreAllMocks();
  removeTempDirs();
});

async function hub(options: Parameters<typeof startHub>[0] = {}): Promise<Hub> {
  const started = await startHub(options);
  hubs.push(started);
  return started;
}

async function server(port: number, syncTimeoutMs = 10_000): Promise<Rig> {
  const rig = await startServer(
    testConfig({
      authSecret: TEST_SECRET,
      hubUrl: hubUrl(port),
      ...LIVE_HUB_SETTLE,
      syncTimeoutMs,
    }),
  );
  rigs.push(rig);
  return rig;
}

function watchForPendingRoomTermination(): () => readonly string[] {
  const seen: string[] = [];
  const warn = console.warn;
  vi.spyOn(console, "warn").mockImplementation((...args: unknown[]) => {
    const line = args.map(String).join(" ");
    if (line.includes("too many pending unauthenticated documents")) {
      seen.push(line);
      return;
    }
    warn(...args);
  });
  return () => seen;
}

function endsWithin<T>(label: string, promise: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new Error(`timed out waiting for ${label}`)),
      WAIT_TIMEOUT_MS,
    );
  });
  return Promise.race([promise, deadline]).finally(() => clearTimeout(timer));
}

describe("fresh-room admission", () => {
  it("syncs a 300-document create burst without breaching the default hub ceiling", async () => {
    const terminations = watchForPendingRoomTermination();
    const running = await hub();
    expect(running.server.configuration.maxPendingDocuments).toBe(
      MAX_PENDING_DOCUMENTS,
    );
    const rig = await server(running.port);

    // Concurrent calls share the boot settle and then take the real
    // create_doc attach-then-write path in one burst.
    const created = await Promise.all(
      Array.from({ length: 300 }, (_, index) =>
        rig.ok("create_doc", {
          title: `Burst ${index}`,
          description: "A fresh-room admission test document.",
        }),
      ),
    );
    const rooms = created.map(
      ({ uuid }: { uuid: string }) => `${WORKSPACE}/${uuid}`,
    );
    const sync = rig.instance.replicas.sync;

    await waitUntil(
      "the create burst to sync or the hub to terminate its socket",
      () =>
        terminations().length > 0 ||
        rooms.every((room) => sync.isRoomQuiet(room)),
      60_000,
    );

    expect(terminations()).toEqual([]);
    expect(rooms.every((room) => sync.isRoomQuiet(room))).toBe(true);
    expect(sync.isDraining()).toBe(false);
  });

  it("releases every admission after a hub-initiated socket termination", async () => {
    const terminations = watchForPendingRoomTermination();
    const databasePath = tempDatabasePath();
    const first = await hub({ databasePath, maxPendingDocuments: 1 });
    const port = first.port;
    const rig = await server(port, 60_000);

    // Directory and sidebar are admitted together. A ceiling of one therefore
    // terminates this deliberately invalid test connection before either auth
    // can finish; production keeps 32 strictly below 100.
    await waitUntil(
      "the tiny-ceiling hub to terminate the socket",
      () => terminations().length > 0,
    );
    await hubs.pop()?.stop();

    const recovered = await hub({
      port,
      databasePath,
      maxPendingDocuments: MAX_PENDING_DOCUMENTS,
    });
    expect(recovered.port).toBe(port);

    const sync = rig.instance.replicas.sync;
    const rooms = [`${WORKSPACE}/_directory`, `${WORKSPACE}/_sidebar`];
    await waitUntil(
      "the reconnected rooms to become quiet",
      () =>
        sync.state().status === "connected" &&
        rooms.every((room) => sync.isRoomQuiet(room)) &&
        !sync.isDraining(),
    );

    // A stranded admission makes settle wait the full 60-second sync budget.
    // Once the rooms are quiet, the recovered connection has no such debt.
    await endsWithin(
      "settle after the hub-initiated termination",
      rig.instance.replicas.settle(),
    );
    expect(sync.isDraining()).toBe(false);
  });
});

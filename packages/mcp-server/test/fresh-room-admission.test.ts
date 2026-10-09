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

/** Past the hub's pending-room ceiling, so an unbounded attach would breach it. */
const BURST = MAX_PENDING_DOCUMENTS + 20;

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

/**
 * Hocuspocus reports this guard through process-wide `console.warn`. Match a
 * room owned by this test so a previous rig finishing teardown cannot make the
 * next test claim that its own socket was terminated.
 */
function watchForPendingRoomTermination(
  rooms: readonly string[],
): () => readonly string[] {
  const seen: string[] = [];
  const warn = console.warn;
  vi.spyOn(console, "warn").mockImplementation((...args: unknown[]) => {
    const line = args.map(String).join(" ");
    if (
      line.includes("too many pending unauthenticated documents") &&
      rooms.some((room) => line.includes(room))
    ) {
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
  it("syncs a create burst past the default hub ceiling without breaching it", async () => {
    const rooms: string[] = [];
    const terminations = watchForPendingRoomTermination(rooms);
    const running = await hub();
    expect(running.server.configuration.maxPendingDocuments).toBe(
      MAX_PENDING_DOCUMENTS,
    );
    const rig = await server(running.port);

    // Concurrent calls share the boot settle and then take the real
    // create_doc attach-then-write path in one burst.
    const created = await Promise.all(
      Array.from({ length: BURST }, (_, index) =>
        rig.ok("create_doc", {
          title: `Burst ${index}`,
          description: "A fresh-room admission test document.",
        }),
      ),
    );
    rooms.push(
      ...created.map(
        ({ uuid }: { uuid: string }) => `${WORKSPACE}/${uuid}`,
      ),
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

  it("drops closing-window updates before they can replay ahead of admission", async () => {
    const rooms: string[] = [];
    const terminations = watchForPendingRoomTermination(rooms);
    const running = await hub();
    const rig = await server(running.port, 3_000);
    const created = await Promise.all(
      Array.from({ length: BURST }, (_, index) =>
        rig.ok("create_doc", {
          title: `Reconnect ${index}`,
          description: "A closing-window admission test document.",
        }),
      ),
    );
    rooms.push(
      ...created.map(
        ({ uuid }: { uuid: string }) => `${WORKSPACE}/${uuid}`,
      ),
    );
    const sync = rig.instance.replicas.sync;
    await waitUntil("the reconnect corpus to sync", () =>
      rooms.every((room) => sync.isRoomQuiet(room)),
    );

    // Drive rebuild's production ordering: disconnect first, then mutate while
    // the close event is still pending. The provider must drop those frames;
    // the new connection's handshakes recover every update from Yjs state.
    const internals = sync as unknown as {
      rebuilding: boolean;
      socket: { disconnect(): void };
    };
    internals.rebuilding = true;
    internals.socket.disconnect();
    const writes = created.map(({ uuid }: { uuid: string }, index: number) =>
      rig.ok("set_metadata", { uuid, title: `Reconnected ${index}` }),
    );

    await Promise.all(writes);
    await waitUntil(
      "every closing-window update to converge after reconnect",
      () =>
        sync.state().status === "connected" &&
        rooms.every((room) => sync.isRoomQuiet(room)) &&
        !sync.isDraining(),
      60_000,
    );

    expect(terminations()).toEqual([]);
    expect(sync.isDraining()).toBe(false);
  });

  it("releases every admission after a hub-initiated socket termination", async () => {
    const rooms = [`${WORKSPACE}/_directory`, `${WORKSPACE}/_sidebar`];
    const terminations = watchForPendingRoomTermination(rooms);
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

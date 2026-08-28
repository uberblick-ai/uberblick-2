// @vitest-environment node
/**
 * What a page does when the hub refuses the sync protocol it speaks.
 *
 * The refusal is terminal at **socket** granularity, and that is the whole
 * subject here. Every room in a tab rides one shared socket, `disconnect()` on
 * a provider that does not own its socket is a no-op, and a permission denial
 * never closes the socket by itself — so "the room stops retrying" would not be
 * a mechanism, and a second room's ordinary close would drop and redial the
 * socket straight back into the same refusal.
 *
 * Three properties, against a real hub from another release:
 *
 * 1. the refusal reaches every open room as both integers;
 * 2. the socket stops and nothing dials it again;
 * 3. a room opened *afterwards* reads the same state without dialling.
 *
 * A reload starts over, which is what a person does once they have updated.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { createHub } from "@uberblick/hub";
import type { Hub, HubLogRecord } from "@uberblick/hub";
import { SYNC_PROTOCOL_VERSION } from "@uberblick/hub/protocol";
import type { RoomConnection, RoomStatus } from "../src/collab/rooms.js";

const SECRET = "protocol-mismatch-test-secret";
const WORKSPACE = "6f4c8a51-2b7d-4e39-9a06-c81d3f572be4";

/** Same shape as `reconnect.test.ts`: the config module is the hub's address. */
const injected = vi.hoisted(() => ({ url: "", secret: "" }));
vi.mock("../src/config.js", () => ({
  HUB_CONFIG_PATH: "/uberblick-config.json",
  hubUrl: () => injected.url,
  hubAuthToken: () => injected.secret,
  resolveClientConfig: async () => ({}),
}));

const hubs: Hub[] = [];
const dirs: string[] = [];
const teardown: Array<() => void> = [];

afterEach(async () => {
  refusals.length = 0;
  for (const undo of teardown.splice(0).reverse()) undo();
  for (const hub of hubs.splice(0)) await hub.stop().catch(() => {});
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  // The shared socket and the refusal are both module state.
  vi.resetModules();
});

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitFor(label: string, predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 20_000;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}`);
    await sleep(25);
  }
}

/** Every auth attempt the hub refused — the count this test is really about. */
const refusals: HubLogRecord[] = [];

/** A hub from another release: one integer away, which is the whole test. */
async function hubFromAnotherRelease(): Promise<Hub> {
  const dir = mkdtempSync(join(tmpdir(), "uberblick-web-protocol-"));
  dirs.push(dir);
  const hub = await createHub({
    authSecret: SECRET,
    port: 0,
    databasePath: join(dir, "hub.sqlite"),
    log: (record) => {
      if (record.cause === "protocol-mismatch") refusals.push(record);
    },
    protocolVersion: SYNC_PROTOCOL_VERSION + 1,
    debounce: 200,
    maxDebounce: 1_000,
    shutdownTimeoutMs: 2_000,
  });
  hubs.push(hub);
  return hub;
}

interface Tab {
  connection: RoomConnection;
  latest(): RoomStatus;
}

async function openTab(room: string, port: number): Promise<Tab> {
  injected.url = `ws://127.0.0.1:${port}`;
  injected.secret = SECRET;
  const { acquireRoom } = await import("../src/collab/rooms.js");
  const handle = acquireRoom(room, { name: "tab", color: "#abcdef" });
  let latest: RoomStatus = handle.connection.status;
  const unsubscribe = handle.connection.onStatusChange((next) => {
    latest = next;
  });
  teardown.push(() => {
    unsubscribe();
    handle.release();
  });
  return { connection: handle.connection, latest: () => latest };
}

function sharedSocket(connection: RoomConnection) {
  return connection.provider.configuration.websocketProvider;
}

/** One real hub over one real socket; generous because the review container runs every suite at once. */
const TEST_TIMEOUT_MS = 60_000;

it("stops the page's socket for good when the hub refuses its protocol version", async () => {
  const hub = await hubFromAnotherRelease();
  const first = await openTab(`${WORKSPACE}/${randomUUID()}`, hub.port);

  await waitFor(
    "the refusal to reach the open room",
    () => first.latest().protocolMismatch !== null,
  );

  // Both integers: which side is old is the whole of what a reader can act on.
  expect(first.latest().protocolMismatch).toEqual({
    hub: SYNC_PROTOCOL_VERSION + 1,
    client: SYNC_PROTOCOL_VERSION,
  });
  expect(first.latest().connected).toBe(false);

  // Stopped, and not merely down: `shouldConnect` is the library's own record
  // of whether it intends to come back, and the socket's retry reads it. A
  // client the hub cannot talk to is not made compatible by dialling again.
  //
  // Intent rather than the socket's momentary `status`: `disconnect()` only
  // asks, and the close lands a tick or more later, so reading `status` here
  // races the transport — which is why the page's own reading is settled at the
  // halt (`haltForProtocolMismatch`) instead of derived from it.
  const socket = sharedSocket(first.connection);
  expect(socket.shouldConnect).toBe(false);

  // Counted at the hub rather than waited out: exactly one attempt for the one
  // room the page opened, so nothing retried behind it.
  const afterFirst = refusals.length;
  expect(afterFirst).toBe(1);

  // A room opened after the refusal reads the same terminal state, and sends
  // nothing: attaching is what would put its token on the wire, and its absence
  // is what keeps the count still.
  const later = await openTab(`${WORKSPACE}/${randomUUID()}`, hub.port);
  expect(later.latest().protocolMismatch).toEqual({
    hub: SYNC_PROTOCOL_VERSION + 1,
    client: SYNC_PROTOCOL_VERSION,
  });
  expect(later.connection.provider.isAttached).toBe(false);
  expect(socket.shouldConnect).toBe(false);
  expect(refusals.length).toBe(afterFirst);
}, TEST_TIMEOUT_MS);

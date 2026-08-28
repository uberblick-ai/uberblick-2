// @vitest-environment node
/**
 * A page that came up before its configuration did (#426).
 *
 * The secret is served rather than compiled in, so "the document did not
 * arrive" is now a state a perfectly healthy tab can start in — a host still
 * booting, a proxy holding one request. The decision that makes that survivable
 * has two halves, and this file defends the second: the read is not memoised
 * (`hub-config.test.ts` pins that), and the room actually tries again.
 *
 * Against a real hub, because the thing that goes wrong is a protocol edge and
 * nothing else would show it. Hocuspocus sends a token only on a socket `open`,
 * and a token that could not be minted leaves the provider unauthenticated on a
 * socket that stays open — measured at ~60s before its own message-reconnect
 * produced another `open`. A tab dead for a minute after its deployment came up
 * is the permanent failure this issue exists to remove, in slow motion, and a
 * mocked socket would have reported success.
 *
 * Node rather than jsdom for the same reason as `reconnect.test.ts`: this needs
 * a working WebSocket.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { createHub, silentLogger } from "@uberblick/hub";
import type { Hub } from "@uberblick/hub";
import type { RoomStatus } from "../src/collab/rooms.js";

const SECRET = "token-recovery-test-secret";
/** The workspace this room lives in. A workspace id is a uuid. */
const WORKSPACE = "6f4c8a51-2b7d-4e39-9a06-c81d3f572be4";

/**
 * The configuration module, standing in for a settled `resolveClientConfig()` —
 * the same shape `reconnect.test.ts` uses. `secret` is mutable because that is
 * the whole subject: it is what a document supplies, and a document can start
 * out absent and arrive later.
 */
const injected = vi.hoisted(() => ({ url: "", secret: "" }));
vi.mock("../src/config.js", () => ({
  HUB_CONFIG_PATH: "/uberblick-config.json",
  hubUrl: () => injected.url,
  hubAuthToken: () => injected.secret,
  resolveClientConfig: async () => ({}),
}));

const hubs: Hub[] = [];
const dirs: string[] = [];

afterEach(async () => {
  for (const hub of hubs.splice(0)) await hub.stop().catch(() => {});
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  // The shared socket and the forced-drop window are module state.
  vi.resetModules();
});

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Generous, like the reconnect suite's: a retry here waits out the forced-drop
 * window (2.5–5s), and a deadline sized for a quiet machine turns load into a
 * red gate.
 */
async function waitFor(
  label: string,
  predicate: () => boolean,
  timeoutMs = 20_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}`);
    await sleep(50);
  }
}

it(
  "says it has no token, and syncs once one arrives — without a reload",
  async () => {
    const dir = mkdtempSync(join(tmpdir(), "uberblick-token-recovery-"));
    dirs.push(dir);
    const hub = await createHub({
      authSecret: SECRET,
      port: 0,
      databasePath: join(dir, "hub.sqlite"),
      log: silentLogger,
      debounce: 200,
      maxDebounce: 1_000,
      shutdownTimeoutMs: 2_000,
    });
    hubs.push(hub);

    // A tab that loaded while its configuration document was answering with
    // nothing usable: an endpoint, and no secret.
    injected.url = `ws://127.0.0.1:${hub.port}`;
    injected.secret = "";
    const { acquireRoom } = await import("../src/collab/rooms.js");
    const handle = acquireRoom(`${WORKSPACE}/_directory`, {
      name: "tab",
      color: "#abcdef",
    });
    let latest: RoomStatus = handle.connection.status;
    handle.connection.onStatusChange((next) => {
      latest = next;
    });

    // The reading a person gets, and it is not "synced": nothing was ever sent
    // to the hub, so the deployment is what is incomplete.
    await waitFor("the missing-token reading", () => latest.tokenMissing);
    expect(latest.synced).toBe(false);

    // The deployment finishes coming up. Nothing reloads, nothing re-mounts.
    injected.secret = SECRET;
    await waitFor("the room to sync on a later attempt", () => latest.synced);
    expect(latest.tokenMissing).toBe(false);

    handle.release();
  },
  60_000,
);

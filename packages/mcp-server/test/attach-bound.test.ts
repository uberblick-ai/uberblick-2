/**
 * The client stays below the hub's pending-document ceiling.
 *
 * The hub counts, per websocket, the documents whose authentication has not
 * finished, and past its ceiling it does not refuse the document — it
 * terminates the socket, taking every healthy room on it down with the greedy
 * one. This process puts the whole corpus on one socket, so the corpus size is
 * that count unless something bounds it.
 *
 * The bound has to hold twice over: once when the rooms are first attached, and
 * again on every reconnect, because every attached provider re-sends its token
 * from its own `onOpen` — a hub restart re-authenticates the whole corpus in a
 * single tick. Both halves are here, against a real hub whose ceiling is small
 * enough that an unbounded client is *guaranteed* to breach it: 12 rooms, a
 * ceiling of 5, a client bound of 3.
 */

import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createHub, silentLogger } from "@uberblick/hub";
import type { Hub } from "@uberblick/hub";
import { Awareness } from "y-protocols/awareness";
import * as Y from "yjs";
import { HubSync } from "../src/sync.js";
import {
  hubUrl,
  LIVE_HUB_SETTLE,
  removeTempDirs,
  tempDatabasePath,
  testConfig,
  TEST_SECRET,
  waitUntil,
  WORKSPACE,
} from "./helpers.js";

/** Small enough that an unbounded client breaches it in one tick. */
const HUB_CEILING = 5;
/** Strictly below the ceiling, like the production constant. */
const CLIENT_BOUND = 3;
/** More rooms than the ceiling, so the bound is what keeps the socket alive. */
const ROOM_COUNT = 12;

const hubs: Hub[] = [];
const syncs: HubSync[] = [];

afterEach(async () => {
  for (const sync of syncs.splice(0)) {
    sync.destroy();
  }
  for (const hub of hubs.splice(0)) {
    await hub.stop().catch(() => {});
  }
  removeTempDirs();
  vi.restoreAllMocks();
});

async function startHub(options: { port?: number; databasePath: string }) {
  const hub = await createHub({
    authSecret: TEST_SECRET,
    port: options.port ?? 0,
    databasePath: options.databasePath,
    log: silentLogger,
    debounce: 20,
    maxDebounce: 200,
    shutdownTimeoutMs: 5_000,
    maxPendingDocuments: HUB_CEILING,
  });
  hubs.push(hub);
  return hub;
}

/**
 * Hocuspocus announces a terminated connection on `console.warn` and nowhere
 * else — no hook, no log record — so this is the one place the failure this
 * whole bound exists to prevent can be observed.
 */
function watchForTermination(): () => string[] {
  const seen: string[] = [];
  vi.spyOn(console, "warn").mockImplementation((...args: unknown[]) => {
    const line = args.map(String).join(" ");
    if (line.includes("too many pending unauthenticated documents")) {
      seen.push(line);
    }
  });
  return () => seen;
}

/** A fresh room with something in it, attached to the hub. Returns its name. */
function attach(sync: HubSync, text: string): string {
  const room = `${WORKSPACE}/${randomUUID()}`;
  const doc = new Y.Doc();
  doc.getText("body").insert(0, text);
  sync.attach({ room, doc, awareness: new Awareness(doc) });
  return room;
}

describe("bounded room attach", () => {
  it("joins a corpus larger than the hub's ceiling, and survives a restart", async () => {
    const terminations = watchForTermination();
    const database = tempDatabasePath();
    const hub = await startHub({ databasePath: database });
    const port = hub.port;

    const sync = new HubSync(
      testConfig({
        authSecret: TEST_SECRET,
        hubUrl: hubUrl(port),
        ...LIVE_HUB_SETTLE,
      }),
      () => {},
      { maxConcurrentAttaches: CLIENT_BOUND },
    );
    syncs.push(sync);

    // One room first, so the rest are attached onto a socket that is already
    // open — which is what makes the next assertion exact rather than a race:
    // a provider handed a live socket asks for its token there and then.
    const first = attach(sync, "first");
    await waitUntil("the first room to sync", () => sync.isRoomQuiet(first));

    const rooms: string[] = [];
    for (let index = 0; index < ROOM_COUNT; index += 1) {
      rooms.push(attach(sync, `room ${index}`));
    }

    // Still in the tick that attached them: exactly the bound have been let
    // through, and the rest are holding a ticket, having told the hub nothing
    // at all. A room waiting here has not synced, and `isRoomQuiet` — what
    // every mutating tool reports as `synced` — says so.
    expect(sync.attachesInFlight()).toBe(CLIENT_BOUND);
    expect(sync.attachesWaiting()).toBe(ROOM_COUNT - CLIENT_BOUND);
    for (const room of rooms) {
      expect(sync.isRoomQuiet(room)).toBe(false);
    }

    let peak = 0;
    const sampler = setInterval(() => {
      peak = Math.max(peak, sync.attachesInFlight());
    }, 1);

    try {
      await waitUntil("every room to sync on the first connection", () =>
        [first, ...rooms].every((room) => sync.isRoomQuiet(room)),
      );

      expect(peak).toBeGreaterThan(0);
      expect(peak).toBeLessThanOrEqual(CLIENT_BOUND);
      expect(sync.attachesWaiting()).toBe(0);
      // The whole point: an unbounded client would have named all 12 documents
      // before any of them authenticated, and the hub would have closed the
      // socket under every one of them.
      expect(terminations()).toEqual([]);

      // The stampede this exists for: the hub goes away and comes back, and
      // every provider re-sends its token at once on the new connection.
      await hubs.shift()?.stop();
      await waitUntil("the rooms to lose sync with the hub that went away", () =>
        [first, ...rooms].some((room) => !sync.isRoomQuiet(room)),
      );

      peak = 0;
      await startHub({ port, databasePath: database });
      await waitUntil("every room to sync again after the restart", () =>
        [first, ...rooms].every((room) => sync.isRoomQuiet(room)),
      );

      expect(peak).toBeGreaterThan(0);
      expect(peak).toBeLessThanOrEqual(CLIENT_BOUND);
      expect(sync.attachesWaiting()).toBe(0);
      expect(terminations()).toEqual([]);
    } finally {
      clearInterval(sampler);
    }
  });
});

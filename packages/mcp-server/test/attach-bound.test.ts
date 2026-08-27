/**
 * The client stays below the hub's pending-document ceiling.
 *
 * The hub counts, per websocket, the documents whose authentication has not
 * finished, and past its ceiling it does not refuse the document — it
 * terminates the socket, taking every healthy room on it down with the greedy
 * one. This process puts the whole corpus on one socket, so the corpus size is
 * that count unless something bounds it.
 *
 * The bound has to hold on every connection, not only the first: every attached
 * provider re-sends its token from its own `onOpen`, so a hub restart
 * re-authenticates the whole corpus in a single tick, and a socket that flaps
 * *while the queue is draining* does it again on every flap. All of that is
 * here, against a real hub whose ceiling is small enough that an unbounded
 * client is *guaranteed* to breach it: 12 rooms, a ceiling of 5, a client bound
 * of 3.
 *
 * Nothing here samples a counter. The admission accounting is reported on every
 * transition, so the maximum in flight is computed exactly rather than caught
 * in the act — and the flaps are driven from an observed admission rather than
 * from a timer, so the test does the same thing on a fast machine and a loaded
 * one.
 *
 * The last suite is the other half of pacing a corpus: what a caller may call
 * hydrated. A queue drained in waves takes one round trip per wave, so a settle
 * that waits a single round trip's budget reports a corpus complete while it is
 * still joining.
 */

import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createHub, MAX_PENDING_DOCUMENTS, silentLogger } from "@uberblick/hub";
import type { Hub } from "@uberblick/hub";
import { Awareness } from "y-protocols/awareness";
import * as Y from "yjs";
import type { AdmissionCounts } from "../src/sync.js";
import { HubSync, MAX_CONCURRENT_ROOM_ATTACHES } from "../src/sync.js";
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

/**
 * Small enough that an unbounded client breaches it in one tick — and only one
 * above the client's bound, so a single room that reached the hub outside the
 * pacing is a terminated socket rather than something the headroom absorbs.
 */
const HUB_CEILING = 4;
/** Strictly below the ceiling, like the production constant. */
const CLIENT_BOUND = 3;
/** More rooms than the ceiling, so the bound is what keeps the socket alive. */
const ROOM_COUNT = 12;
/** How many times the socket is dropped and restored mid-drain. */
const FLAPS = 3;

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
 *
 * Scoped to `rooms`, which the caller fills as it attaches: the warning is
 * process-wide, and a hub being torn down answers a departing client's close
 * messages as first sightings of documents it no longer holds — which can
 * terminate that connection while the next test is already running. A
 * connection only ever carries the rooms of the client that opened it, so the
 * document the warning names is what says whose socket went down.
 */
function watchForTermination(rooms: readonly string[]): () => string[] {
  const seen: string[] = [];
  vi.spyOn(console, "warn").mockImplementation((...args: unknown[]) => {
    const line = args.map(String).join(" ");
    if (
      line.includes("too many pending unauthenticated documents") &&
      rooms.some((room) => line.includes(room))
    ) {
      seen.push(line);
    }
  });
  return () => seen;
}

/** Every admission transition, and what can be read off the whole series. */
function recordAdmissions() {
  const seen: AdmissionCounts[] = [];
  return {
    record: (counts: AdmissionCounts) => seen.push(counts),
    /** The largest number of rooms ever in flight, on any connection. */
    peak: (from = 0) =>
      seen.slice(from).reduce((most, counts) => Math.max(most, counts.inFlight), 0),
    /** How many distinct connections let a room through. */
    connections: () =>
      new Set(seen.filter((counts) => counts.inFlight > 0).map((c) => c.generation))
        .size,
    /** The accounting as it stood at the last transition. */
    latest: (): AdmissionCounts => {
      const last = seen[seen.length - 1];
      if (last === undefined) {
        throw new Error("nothing has been admitted or queued yet");
      }
      return last;
    },
    length: () => seen.length,
  };
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
  it("keeps the client's bound strictly below the hub's ceiling", () => {
    // The two constants are the contract: the client paces itself against a
    // count the hub keeps, so the client's bound moving above the hub's ceiling
    // would silently turn the pacing into a queue for a socket that is already
    // being terminated.
    expect(MAX_CONCURRENT_ROOM_ATTACHES).toBeLessThan(MAX_PENDING_DOCUMENTS);
  });

  it("joins a corpus larger than the hub's ceiling, and survives a restart", async () => {
    const rooms: string[] = [];
    const terminations = watchForTermination(rooms);
    const admissions = recordAdmissions();
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
      { maxConcurrentAttaches: CLIENT_BOUND, onAdmissions: admissions.record },
    );
    syncs.push(sync);

    // One room first, so the rest are attached onto a socket that is already
    // open — which is what makes the next assertion exact rather than a race:
    // a provider handed a live socket asks for its token there and then.
    const first = attach(sync, "first");
    rooms.push(first);
    await waitUntil("the first room to sync", () => sync.isRoomQuiet(first));

    const wave: string[] = [];
    for (let index = 0; index < ROOM_COUNT; index += 1) {
      wave.push(attach(sync, `room ${index}`));
    }
    rooms.push(...wave);

    // Still in the tick that attached them: exactly the bound have been let
    // through, and the rest are holding a ticket, having told the hub nothing
    // at all. A room waiting there has not synced, and `isRoomQuiet` — what
    // every mutating tool reports as `synced` — says so.
    expect(admissions.latest()).toMatchObject({
      inFlight: CLIENT_BOUND,
      waiting: ROOM_COUNT - CLIENT_BOUND,
    });
    for (const room of wave) {
      expect(sync.isRoomQuiet(room)).toBe(false);
    }

    await waitUntil("every room to sync on the first connection", () =>
      rooms.every((room) => sync.isRoomQuiet(room)),
    );

    expect(admissions.peak()).toBe(CLIENT_BOUND);
    expect(admissions.latest().waiting).toBe(0);
    // The whole point: an unbounded client would have named all 12 documents
    // before any of them authenticated, and the hub would have closed the
    // socket under every one of them.
    expect(terminations()).toEqual([]);

    // The stampede this exists for: the hub goes away and comes back, and
    // every provider re-sends its token at once on the new connection.
    await hubs.shift()?.stop();
    await waitUntil("the rooms to lose sync with the hub that went away", () =>
      rooms.some((room) => !sync.isRoomQuiet(room)),
    );

    const afterRestart = admissions.length();
    await startHub({ port, databasePath: database });
    await waitUntil("every room to sync again after the restart", () =>
      rooms.every((room) => sync.isRoomQuiet(room)),
    );

    expect(admissions.peak(afterRestart)).toBe(CLIENT_BOUND);
    expect(admissions.latest().waiting).toBe(0);
    expect(terminations()).toEqual([]);
  });

  it("holds the bound on every connection while the socket flaps mid-drain", async () => {
    const rooms: string[] = [];
    const terminations = watchForTermination(rooms);
    const admissions = recordAdmissions();
    const database = tempDatabasePath();
    const port = (await startHub({ databasePath: database })).port;

    // Each flap is a hub that goes away and comes back on the same address.
    // Serialized, because a stop that overlaps the next start would race for
    // the port rather than reconnect the client.
    let restarts = Promise.resolve();
    let flapsLeft = FLAPS;
    const flapped = new Set<number>();
    const flap = (generation: number) => {
      flapped.add(generation);
      flapsLeft -= 1;
      restarts = restarts.then(async () => {
        await hubs.shift()?.stop();
        await startHub({ port, databasePath: database });
      });
    };

    const sync = new HubSync(
      testConfig({
        authSecret: TEST_SECRET,
        hubUrl: hubUrl(port),
        ...LIVE_HUB_SETTLE,
      }),
      () => {},
      {
        maxConcurrentAttaches: CLIENT_BOUND,
        onAdmissions: (counts) => {
          admissions.record(counts);
          // Driven by the drain itself, never by a clock: a full wave is on the
          // wire and rooms are still queued behind it, which is the middle of
          // the drain on whatever machine this runs on. Once per connection, so
          // that every flap interrupts a drain of its own.
          if (
            flapsLeft > 0 &&
            !flapped.has(counts.generation) &&
            counts.inFlight === CLIENT_BOUND &&
            counts.waiting > 0
          ) {
            flap(counts.generation);
          }
        },
      },
    );
    syncs.push(sync);

    for (let index = 0; index < ROOM_COUNT; index += 1) {
      rooms.push(attach(sync, `room ${index}`));
    }

    await waitUntil("the socket to flap through the drain", () => flapsLeft === 0);
    await restarts;
    await waitUntil("every room to converge after the flaps", () =>
      rooms.every((room) => sync.isRoomQuiet(room)),
    );

    // The contract, and the one a disconnect used to break: a slot is a place
    // on one connection, so no connection ever carried more than the bound —
    // not the one a flap interrupted, and not the one that inherited its
    // half-minted tokens.
    expect(admissions.peak()).toBe(CLIENT_BOUND);
    expect(admissions.connections()).toBeGreaterThan(FLAPS);
    expect(admissions.latest().waiting).toBe(0);
    expect(terminations()).toEqual([]);
  });
});

/** Bound of one, so the corpus below needs one round trip per room. */
const DRAIN_BOUND = 1;
const DRAIN_ROOMS = 60;
/**
 * A settle budget for one wave. The drain below takes sixty of them, so a wait
 * that spent this once — rather than once per wave — would give up on the queue
 * long before it emptied.
 */
const ONE_WAVE_MS = 10;

describe("the settle budget", () => {
  it("covers the whole drain, not the first wave of it", async () => {
    const sync = new HubSync(
      testConfig({
        authSecret: TEST_SECRET,
        hubUrl: hubUrl((await startHub({ databasePath: tempDatabasePath() })).port),
        ...LIVE_HUB_SETTLE,
        syncTimeoutMs: ONE_WAVE_MS,
      }),
      () => {},
      { maxConcurrentAttaches: DRAIN_BOUND },
    );
    syncs.push(sync);

    // Connected before the corpus arrives, so what is measured below is the
    // drain and not the dial.
    const first = attach(sync, "first");
    await waitUntil("the first room to sync", () => sync.isRoomQuiet(first));

    const rooms: string[] = [];
    for (let index = 0; index < DRAIN_ROOMS; index += 1) {
      rooms.push(attach(sync, `room ${index}`));
    }

    const started = Date.now();
    await sync.waitForQuiet();
    const waited = Date.now() - started;

    // What a caller records as "hydrated": every room reached the hub, none
    // left queued. A budget sized for one wave would have expired part way
    // down the queue and reported this corpus complete while it was still
    // joining — which is the elapsed time below, measured to prove the drain
    // really did outlast a single wave's worth of budget.
    for (const room of rooms) {
      expect(sync.isRoomQuiet(room)).toBe(true);
    }
    expect(waited).toBeGreaterThan(ONE_WAVE_MS);
  });
});

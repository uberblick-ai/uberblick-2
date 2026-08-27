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
 * re-authenticates the whole corpus in a single tick. All of that is here,
 * against a real hub whose ceiling is small enough that an unbounded client is
 * *guaranteed* to breach it: 12 rooms, a ceiling of 4, a client bound of 3.
 *
 * Nothing here samples a counter or reads `HubSync`'s own accounting — the
 * accounting is what is under test. Two seams, both at a boundary the library
 * owns: `mintToken` is held, which suspends a token call exactly where a real
 * one is slow and the socket under it can die; and `getToken` is watched, which
 * is the library's own call into the token callable and the moment a provider
 * becomes free to send. Between them a token call's whole lifecycle — held
 * across a reconnect, held across a quarantine — is driven rather than raced,
 * and nothing here waits out a duration in the hope that what it is about to
 * assert would have happened by now: every step waits for an event.
 *
 * The last suite is the other half of pacing a corpus: what a caller may call
 * hydrated. A queue drained in waves takes one round trip per wave and a settle
 * is one budget, so the wait ends where it promised to and says the drain is
 * still going, rather than growing with the corpus or calling it complete. Its
 * clock is a seam as well — a deadline is a clock reading, so the budget is
 * spent by moving the clock rather than by measuring a loaded machine.
 */

import { randomUUID } from "node:crypto";
import { HocuspocusProvider } from "@hocuspocus/provider";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createHub, MAX_PENDING_DOCUMENTS, silentLogger } from "@uberblick/hub";
import type { Hub } from "@uberblick/hub";
import { Awareness } from "y-protocols/awareness";
import * as Y from "yjs";
import { HubSync, MAX_CONCURRENT_ROOM_ATTACHES } from "../src/sync.js";
import {
  hubUrl,
  LIVE_HUB_SETTLE,
  removeTempDirs,
  tempDatabasePath,
  testConfig,
  TEST_SECRET,
  WAIT_TIMEOUT_MS,
  waitUntil,
  WORKSPACE,
} from "./helpers.js";

/**
 * Every `mintToken` call, suspended until this suite releases it.
 *
 * Minting is where a real token call spends its time, and it is the window the
 * generation scoping exists for: a socket can end while a slot's token is half
 * made. Holding the mint puts a test inside that window deliberately instead of
 * hoping to land in it.
 *
 * Releasing one hands back the mint's *own* completion, because the mint is
 * asynchronous (WebCrypto, `packages/hub/src/token.ts`): a test that asserts on
 * what a released call did — or did not — do waits for the moment its token
 * exists, not for a duration it hopes is longer than the machine takes.
 */
const mints = vi.hoisted(() => {
  const suspended: Array<{ resume: () => void; finished: Promise<void> }> = [];
  let holding = false;
  return {
    /** Suspend every mint from here on. */
    hold: (): void => {
      holding = true;
    },
    /** How many mint calls are suspended right now. */
    held: (): number => suspended.length,
    /**
     * Let the oldest suspended mint run, and resolve once it has finished. The
     * rest stay suspended.
     */
    release: async (): Promise<void> => {
      const mint = suspended.shift();
      if (mint === undefined) {
        return;
      }
      mint.resume();
      await mint.finished;
    },
    /** Stop holding, and let everything suspended finish. */
    releaseAll: (): void => {
      holding = false;
      for (const mint of suspended.splice(0)) {
        mint.resume();
      }
    },
    /** Run one mint, suspended at its start while this suite is holding. */
    run: async <T>(mint: () => Promise<T>): Promise<T> => {
      if (!holding) {
        return mint();
      }
      let resume!: () => void;
      const gate = new Promise<void>((resolve) => {
        resume = resolve;
      });
      let finish!: () => void;
      const finished = new Promise<void>((resolve) => {
        finish = resolve;
      });
      suspended.push({ resume, finished });
      await gate;
      try {
        return await mint();
      } finally {
        finish();
      }
    },
  };
});

vi.mock("@uberblick/hub/token", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@uberblick/hub/token")>();
  return {
    ...actual,
    mintToken: (...args: Parameters<typeof actual.mintToken>) =>
      mints.run(() => actual.mintToken(...args)),
  };
});

/**
 * Let every already-scheduled turn of the event loop run.
 *
 * `setImmediate` fires after the microtask queue has drained, so a continuation
 * chained onto something that has already resolved has run by the time this
 * returns — whatever else the machine is doing.
 */
function flush(): Promise<void> {
  return new Promise((resolve) => {
    setImmediate(resolve);
  });
}

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
/**
 * A bound of one: the room that holds the slot and the rooms queued behind it
 * are then a matter of construction rather than of timing.
 */
const ONE_SLOT = 1;

const hubs: Hub[] = [];
const syncs: HubSync[] = [];

afterEach(async () => {
  mints.releaseAll();
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

/**
 * Which rooms' token calls have ended, in order.
 *
 * `getToken` is the library's own call into the token callable, and a provider
 * sends nothing — no auth message, no sync step — until it returns. Watching it
 * watches the gate itself, at the boundary, rather than the accounting inside
 * `HubSync` that the gate is there to enforce.
 */
function watchTokenGate(): () => string[] {
  const opened: string[] = [];
  const getToken = HocuspocusProvider.prototype.getToken;
  vi.spyOn(HocuspocusProvider.prototype, "getToken").mockImplementation(
    async function (this: HocuspocusProvider) {
      const token = await getToken.call(this);
      opened.push(this.configuration.name);
      return token;
    },
  );
  return () => [...opened];
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

  it("refuses a bound that is not a positive integer", () => {
    // The bound is the admission gate: a zero admits nothing, so every room
    // would queue forever on a socket that is up and answering.
    for (const bound of [0, -1, 2.5]) {
      expect(
        () =>
          new HubSync(testConfig(), () => {}, {
            maxConcurrentAttaches: bound,
          }),
      ).toThrow(/positive integer/);
    }
  });

  it("joins a corpus larger than the hub's ceiling, and survives a restart", async () => {
    const rooms: string[] = [];
    const terminations = watchForTermination(rooms);
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
    rooms.push(first);
    await waitUntil("the first room to sync", () => sync.isRoomQuiet(first));

    const wave: string[] = [];
    for (let index = 0; index < ROOM_COUNT; index += 1) {
      wave.push(attach(sync, `room ${index}`));
    }
    rooms.push(...wave);

    // Still in the tick that attached them: none of them has told the hub
    // anything, the queue says so, and `isRoomQuiet` — what every mutating tool
    // reports as `synced` — says so too.
    expect(sync.isDraining()).toBe(true);
    for (const room of wave) {
      expect(sync.isRoomQuiet(room)).toBe(false);
    }

    await waitUntil("every room to sync on the first connection", () =>
      rooms.every((room) => sync.isRoomQuiet(room)),
    );

    expect(sync.isDraining()).toBe(false);
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

    await startHub({ port, databasePath: database });
    await waitUntil("every room to sync again after the restart", () =>
      rooms.every((room) => sync.isRoomQuiet(room)),
    );

    expect(sync.isDraining()).toBe(false);
    expect(terminations()).toEqual([]);
  });

  it("keeps a token minted on a dead connection from sending on the next one", async () => {
    const rooms: string[] = [];
    const terminations = watchForTermination(rooms);
    const gateOpened = watchTokenGate();
    const database = tempDatabasePath();
    const port = (await startHub({ databasePath: database })).port;

    const sync = new HubSync(
      testConfig({
        authSecret: TEST_SECRET,
        hubUrl: hubUrl(port),
        ...LIVE_HUB_SETTLE,
      }),
      () => {},
      { maxConcurrentAttaches: ONE_SLOT },
    );
    syncs.push(sync);

    // One room joined first, so the socket holds a room: a hub stopping sends
    // no frame to a connection that holds none, and this test is about a
    // connection that ends.
    const first = attach(sync, "first");
    rooms.push(first);
    await waitUntil("the first room to sync", () => sync.isRoomQuiet(first));

    // The next room takes the only slot and stops there, mid-mint.
    mints.hold();
    const stale = attach(sync, "stale");
    rooms.push(stale);
    await waitUntil("the stale room's token call to reach the mint", () =>
      mints.held() === 1,
    );

    // A third room queues behind it — the one that will hold the only slot on
    // the *next* connection.
    const next = attach(sync, "next");
    rooms.push(next);

    // The connection ends and a new one takes its place while that suspended
    // call still holds a slot on it — a place on a connection nobody will
    // answer on.
    await hubs.shift()?.stop();
    await waitUntil(
      "the socket to go down under the suspended call",
      () => sync.state().status !== "connected",
    );
    await startHub({ port, databasePath: database });
    // The queued room takes the only slot on the new connection and starts a
    // mint of its own: two suspended mints, the stale one and this one.
    await waitUntil("the queued room to be admitted on the new connection", () =>
      mints.held() === 2,
    );

    // Let the stale call finish minting, and wait for that mint itself. Its
    // token is good and its provider is attached to a live socket — the only
    // thing between it and the hub is that the slot it holds belongs to a
    // connection that is gone.
    await mints.release();
    await flush();

    // The contract: it cannot send. The one slot on this connection belongs to
    // the room admitted on it, and the stale call has to be re-admitted here
    // before anything of its leaves — which is what keeps a flapping socket
    // from carrying one connection's wave into the next one's count.
    expect(gateOpened()).not.toContain(stale);

    // The positive half, so the assertion above is not passing on a call that
    // has simply not got there yet: the room admitted on *this* connection is
    // released after the stale one and goes through — an event to wait for
    // rather than a duration. The stale call's token was finished before this
    // one began, so without the generation scoping it would be through first.
    await mints.release();
    await waitUntil("the room admitted on the new connection to send", () =>
      gateOpened().includes(next),
    );
    expect(gateOpened()).not.toContain(stale);

    mints.releaseAll();
    await waitUntil("every room to converge", () =>
      rooms.every((room) => sync.isRoomQuiet(room)),
    );

    // Re-admitted, and behind the room that held the slot on this connection.
    expect(gateOpened()).toContain(stale);
    expect(gateOpened().indexOf(next)).toBeLessThan(gateOpened().indexOf(stale));
    expect(terminations()).toEqual([]);
  });

  it.each(["quarantine", "destroy"] as const)(
    "ends a token call suspended across %s instead of re-queueing it",
    async (terminal) => {
      const gateOpened = watchTokenGate();
      const port = (await startHub({ databasePath: tempDatabasePath() })).port;

      const sync = new HubSync(
        testConfig({
          authSecret: TEST_SECRET,
          hubUrl: hubUrl(port),
          ...LIVE_HUB_SETTLE,
        }),
        () => {},
        { maxConcurrentAttaches: ONE_SLOT },
      );
      syncs.push(sync);

      // A room joined first, so the socket holds one: a hub stopping sends no
      // frame to a connection that holds no room at all.
      const first = attach(sync, "first");
      await waitUntil("the first room to sync", () => sync.isRoomQuiet(first));

      mints.hold();
      const room = attach(sync, "held");
      await waitUntil("the held room's token call to reach the mint", () =>
        mints.held() === 1,
      );

      // The connection dies under the suspended call first, so the generation
      // has already moved when it wakes: this is the state a stale call queues
      // again from, and the reason a terminal one must not.
      await hubs.shift()?.stop();
      await waitUntil(
        "the socket to go down under the suspended call",
        () => sync.state().status !== "connected",
      );

      if (terminal === "quarantine") {
        sync.quarantine();
      } else {
        sync.destroy();
      }
      mints.releaseAll();

      // The call ends. Nothing leaves — a quarantined or destroyed provider is
      // detached and its `send` is inert — but ending is the point: a call that
      // queued again here would wait for a connection that is never opened
      // again, and its queue entry would outlive it.
      await waitUntil("the suspended token call to end", () =>
        gateOpened().includes(room),
      );
    },
  );
});

/**
 * The configured budget. Any number would do: it is spent by moving the clock
 * the wait reads, not by waiting.
 */
const SETTLE_BUDGET_MS = 100;
/** Rooms behind the one slot: a drain of several waves, at one wave per room. */
const DRAIN_ROOMS = 8;

/**
 * `Date.now` under the test's control, frozen where it stands.
 *
 * The deadline is the whole contract here — "a call never waits past its
 * configured budget while the settle stays owed" — and a deadline is a clock
 * reading, not an elapsed duration. So the test moves the clock the wait reads
 * instead of measuring milliseconds on a machine whose load it does not own:
 * while the clock stands still no deadline can expire however long the process
 * takes, and one advance of exactly one budget is what ends the wait.
 */
function frozenClock(): { advance: (ms: number) => void; restore: () => void } {
  let now = Date.now();
  const spy = vi.spyOn(Date, "now").mockImplementation(() => now);
  return {
    advance: (ms: number): void => {
      now += ms;
    },
    restore: (): void => {
      spy.mockRestore();
    },
  };
}

/**
 * Await `promise`, failing by name rather than as a bare runner timeout.
 *
 * What {@link waitUntil} does for a condition, for a promise — and needed
 * separately because `waitUntil` reads the very clock this suite is holding
 * still. The deadline is a diagnostic, never the assertion: what is asserted is
 * that the wait ends when the clock says its budget is spent, so this is the
 * suite's own generous deadline and only decides how a hang is reported.
 */
function endsWithin<T>(label: string, promise: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  const named = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new Error(`timed out waiting for ${label}`)),
      WAIT_TIMEOUT_MS,
    );
  });
  return Promise.race([promise, named]).finally(() => {
    clearTimeout(timer);
  });
}

describe("the settle budget", () => {
  it("ends at the configured budget and reports the drain unfinished", async () => {
    const sync = new HubSync(
      testConfig({
        authSecret: TEST_SECRET,
        hubUrl: hubUrl((await startHub({ databasePath: tempDatabasePath() })).port),
        ...LIVE_HUB_SETTLE,
        syncTimeoutMs: SETTLE_BUDGET_MS,
      }),
      () => {},
      { maxConcurrentAttaches: ONE_SLOT },
    );
    syncs.push(sync);

    // Connected before the corpus arrives, so what is measured below is the
    // drain and not the dial.
    const first = attach(sync, "first");
    await waitUntil("the first room to sync", () => sync.isRoomQuiet(first));

    // Every mint from here is suspended, so the queue cannot drain while the
    // wait spends its budget — a fresh client's multi-wave corpus, without
    // making the test's meaning depend on how fast the machine is.
    mints.hold();
    const rooms: string[] = [];
    for (let index = 0; index < DRAIN_ROOMS; index += 1) {
      rooms.push(attach(sync, `room ${index}`));
    }
    await waitUntil("the first queued room to reach the mint", () =>
      mints.held() === 1,
    );

    const clock = frozenClock();
    let returned = false;
    const quiet = sync.waitForQuiet().then(() => {
      returned = true;
    });

    // Nothing may end this wait but its own deadline: the drain is suspended,
    // and the clock the deadline is read from is standing still.
    await flush();
    expect(returned).toBe(false);

    // One budget, and the wait is over. `syncTimeoutMs` is the whole budget
    // whatever the corpus is: a deadline multiplied by the queue depth would
    // want eight of them here — this await would never come back — and a
    // hundred rooms would make an ordinary tool call wait a hundred.
    clock.advance(SETTLE_BUDGET_MS);
    await endsWithin("the settle to end when its budget was spent", quiet);
    clock.restore();

    // And nothing is called complete that is not: the drain is still going, and
    // every room still in it reports unsynced.
    expect(sync.isDraining()).toBe(true);
    for (const room of rooms) {
      expect(sync.isRoomQuiet(room)).toBe(false);
    }

    // The drain finishes in its own time — over as many settles as it takes —
    // and only then does it say so.
    mints.releaseAll();
    await waitUntil("every room to join the hub", () =>
      rooms.every((room) => sync.isRoomQuiet(room)),
    );
    expect(sync.isDraining()).toBe(false);
  });
});

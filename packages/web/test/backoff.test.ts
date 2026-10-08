// @vitest-environment node
/**
 * The two recovery timers the web client owns, and the band each declares.
 *
 * A hub that goes down goes down for every tab and every machine at once, so a
 * fixed delay on the way back is a fixed rendezvous: all of them redial in the
 * same millisecond, discover the same thing, and do it again. Both timers draw
 * from a band instead, and both bands are pinned here with the source stubbed
 * at its ends — a distribution assertion would need samples, and a sampled test
 * fails for reasons nobody can read.
 */

import { describe, expect, it } from "vitest";
import {
  FORCED_DROP_COOLDOWN,
  SOCKET_BACKOFF,
  forcedDropCooldownMs,
} from "../src/collab/rooms.js";

describe("socket reconnect band", () => {
  it("randomizes, and declares its ends", () => {
    // `jitter: true` is the whole randomization for this path: the websocket
    // forwards these fields to the retry library and nothing else, so there is
    // no source to inject — the band is what can be pinned.
    expect(SOCKET_BACKOFF).toEqual({
      delay: 250,
      minDelay: 125,
      factor: 2,
      maxDelay: 2_000,
      jitter: true,
    });

    // Full jitter draws from `[minDelay, delay]`, so a floor equal to the delay
    // would leave the first retry — the one every tab makes together — as the
    // one attempt that is not spread at all.
    expect(SOCKET_BACKOFF.minDelay).toBeLessThan(SOCKET_BACKOFF.delay);
    // And the retry library rejects every attempt outright when the floor is
    // above the delay.
    expect(SOCKET_BACKOFF.delay).toBeLessThanOrEqual(SOCKET_BACKOFF.maxDelay);
  });
});

describe("forced-drop cooldown band", () => {
  it("draws the window from its declared ends", () => {
    expect(forcedDropCooldownMs(() => 0)).toBe(FORCED_DROP_COOLDOWN.minMs);
    expect(forcedDropCooldownMs(() => 1)).toBe(FORCED_DROP_COOLDOWN.maxMs);
    // Mid-draw lands mid-band, so the source is genuinely the whole spread and
    // not a coin flip between the ends.
    expect(forcedDropCooldownMs(() => 0.5)).toBe(3_750);
  });

  it("never waits longer than the fixed window it replaced", () => {
    // `reconnect.test.ts` derives REJOIN_REPAIR_TIMEOUT_MS and TEST_TIMEOUT_MS
    // from a 5s cooldown: a suppressed close waits out at most one window
    // before the trailing drop. Raising this maximum invalidates that
    // derivation rather than that test, so it is pinned here.
    expect(FORCED_DROP_COOLDOWN.maxMs).toBe(5_000);
    expect(FORCED_DROP_COOLDOWN.minMs).toBeLessThan(FORCED_DROP_COOLDOWN.maxMs);
  });
});

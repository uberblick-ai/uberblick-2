/**
 * The two recovery timers this package owns, and the band each declares.
 *
 * Three clients share one remote hub in release 1, and a hub going down takes
 * all three with it — so every delay on the way back is randomized, or they
 * come back in lockstep and keep doing it. What is tested here is the *band*,
 * with the source stubbed at its ends: a distribution assertion would need
 * samples, and a sampled test is a test that fails for reasons nobody can read.
 */

import { describe, expect, it } from "vitest";
import { rebuildDelayMs, socketBackoff } from "../src/sync.js";

describe("socket reconnect band", () => {
  it("randomizes, and declares its ends", () => {
    const backoff = socketBackoff(2_000);

    // `jitter: true` is the whole randomization for this path: the websocket
    // forwards these fields to the retry library and nothing else, so there is
    // no source to inject — the band is what can be pinned.
    expect(backoff).toEqual({
      delay: 250,
      minDelay: 125,
      factor: 2,
      maxDelay: 2_000,
      jitter: true,
    });

    // Full jitter draws from `[minDelay, delay]`, so a floor equal to the delay
    // would make the first retry — the one every client makes together — the
    // one attempt that is not spread at all.
    expect(backoff.minDelay).toBeLessThan(backoff.delay);
    // And the retry library rejects every attempt outright when the floor is
    // above the delay.
    expect(backoff.delay).toBeLessThanOrEqual(backoff.maxDelay);
  });

  it("never opens above the cap it was given", () => {
    const backoff = socketBackoff(100);

    expect(backoff.delay).toBe(100);
    expect(backoff.minDelay).toBe(50);
    expect(backoff.maxDelay).toBe(100);
  });
});

describe("rebuild ladder band", () => {
  it("draws each rung from half its ceiling to the ceiling", () => {
    // The ladder the fixed version walked exactly — 250, 500, 1000 — is now the
    // top of each rung's band.
    expect(rebuildDelayMs(0, 250, 2_000, () => 0)).toBe(125);
    expect(rebuildDelayMs(0, 250, 2_000, () => 1)).toBe(250);

    expect(rebuildDelayMs(1, 250, 2_000, () => 0)).toBe(250);
    expect(rebuildDelayMs(1, 250, 2_000, () => 1)).toBe(500);

    expect(rebuildDelayMs(2, 250, 2_000, () => 0)).toBe(500);
    expect(rebuildDelayMs(2, 250, 2_000, () => 1)).toBe(1_000);

    // Mid-draw lands mid-band, so the source is genuinely the whole spread and
    // not a coin flip between the ends.
    expect(rebuildDelayMs(1, 250, 2_000, () => 0.5)).toBe(375);
  });

  it("keeps the cap as the ceiling once the ladder reaches it", () => {
    expect(rebuildDelayMs(5, 250, 2_000, () => 0)).toBe(1_000);
    expect(rebuildDelayMs(5, 250, 2_000, () => 1)).toBe(2_000);
  });
});

/** Bounded CLI probes use the same credential recovery as serving engines. */
import { expect, it } from "vitest";
import { deviceRetryDelayMs } from "../src/sync.js";

it("spreads device retries through a growing band and caps long manual waits", () => {
  for (const [attempt, floor, ceiling] of [[0, 1_000, 2_000], [1, 2_000, 4_000], [5, 15_000, 30_000], [20, 15_000, 30_000]] as const) {
    expect(deviceRetryDelayMs(attempt, 2_000, false, () => 0)).toBe(floor);
    expect(deviceRetryDelayMs(attempt, 2_000, false, () => 1)).toBe(ceiling);
  }
  expect(deviceRetryDelayMs(0, 2_000, true, () => 0)).toBe(125);
  expect(deviceRetryDelayMs(0, 2_000, true, () => 1)).toBe(250);
  expect(deviceRetryDelayMs(1, 2_000, true, () => 0)).toBe(2_000);
  expect(deviceRetryDelayMs(1, 2_000, true, () => 1)).toBe(4_000);
});

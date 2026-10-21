// @vitest-environment node

import { describe, expect, it } from "vitest";
import {
  FORCED_DROP_COOLDOWN,
  forcedDropCooldownMs,
} from "../src/collab/rooms.js";

describe("forced-drop cooldown band", () => {
  it("draws the window from its declared ends", () => {
    expect(forcedDropCooldownMs(() => 0)).toBe(FORCED_DROP_COOLDOWN.minMs);
    expect(forcedDropCooldownMs(() => 1)).toBe(FORCED_DROP_COOLDOWN.maxMs);
    // Mid-draw lands mid-band, so the source is genuinely the whole spread and
    // not a coin flip between the ends.
    expect(forcedDropCooldownMs(() => 0.5)).toBe(3_750);
  });
});

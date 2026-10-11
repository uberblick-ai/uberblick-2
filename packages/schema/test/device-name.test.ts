import { describe, expect, it } from "vitest";
import { sanitizeDeviceName } from "../src/device-name.js";

describe("optional device display names", () => {
  it.each(["agent-server", " two computers ", "é".repeat(253), "🖥".repeat(253), "a".repeat(253)])(
    "preserves acceptable single-line text unchanged", name => {
      expect(sanitizeDeviceName(name)).toBe(name);
    },
  );

  it.each([
    undefined, null, 12, {}, [], "", "   ", "a".repeat(254), "🖥".repeat(254),
    "host\nname", "host\n", "host\r", "host\rname", "host\tname", "host\u0000name", "host\u007fname",
    "host\u0085name", "host\u202ename", "host\u200bname", "host\u2028name", "host\u2029name", "host\ud800name",
  ])("leaves unacceptable metadata unnamed", name => {
    expect(sanitizeDeviceName(name)).toBeUndefined();
  });
});

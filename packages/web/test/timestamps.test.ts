import { describe, expect, it } from "vitest";
import { formatDecisionTimestamp, formatShortTimestamp, formatTimestamp } from "../src/ui/timestamps.js";

const NOW = Date.parse("2026-10-12T12:00:00Z");
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

describe("recorded-answer timestamps", () => {
  it("keeps invalid free text out and accepts recorded date-only values", () => {
    expect(formatShortTimestamp("not a date", NOW)).toBeNull();
    expect(formatShortTimestamp(Number.NaN, NOW)).toBeNull();
    for (const compact of [false, true]) {
      expect(formatDecisionTimestamp("2026-10-07", NOW, compact)).toEqual({
        label: "Oct 7, 2026", dateTime: "2026-10-07", title: "Oct 7, 2026",
      });
      expect(formatDecisionTimestamp("not a date", NOW, compact)).toBeNull();
    }
  });

  it("keeps full instants and other legacy values on their existing display path", () => {
    for (const value of ["2026-10-07T12:00:00Z", "2026-10-07T19:00:00+07:00", "2026-10-07T12:00", "October 7, 2026"]) {
      expect(formatDecisionTimestamp(value, NOW)).toEqual(formatTimestamp(value, NOW, true));
      expect(formatDecisionTimestamp(value, NOW, true)).toEqual(formatShortTimestamp(value, NOW));
    }
  });

  it("keeps exact hover dates and short relative labels for all recorded ages", () => {
    for (const [age, label] of [[0, "now"], [5 * MINUTE, "5m"], [2 * HOUR, "2h"], [5 * DAY, "5d"], [14 * DAY, "2w"], [90 * DAY, "3mo"], [730 * DAY, "2y"]] as const) {
      const reading = formatShortTimestamp(NOW - age, NOW);
      expect(reading?.label).toBe(label);
      expect(reading?.dateTime).toBe(new Date(NOW - age).toISOString());
      expect(reading?.title).toBeTruthy();
    }
    expect(formatShortTimestamp(NOW + DAY, NOW)?.label).toBe("now");
  });

  it("preserves existing long activity and timeline readings", () => {
    expect(formatTimestamp(NOW - 5 * DAY, NOW)?.label).toBe("5 days ago");
    expect(formatTimestamp(NOW - 90 * DAY, NOW, true)?.label).toBe("3 months ago");
    expect(formatTimestamp(NOW - 90 * DAY, NOW)?.title).toBeUndefined();
  });
});

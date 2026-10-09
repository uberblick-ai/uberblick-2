import { describe, expect, it } from "vitest";
import { calendarTicks } from "../src/editor/chart-ticks.js";

const epoch = (date: string): number => Date.parse(date);
const measure = (text: string): number => text.length * 6;
const ticks = (min: string, max: string, width = 500) => calendarTicks(epoch(min), epoch(max), width, measure, "en-US");

describe("calendar date ticks", () => {
  it("uses the smallest measured minute step and UTC context without seconds", () => {
    const result = ticks("2026-10-07T09:01:30Z", "2026-10-07T09:08:00Z", 800);
    expect(result.map(({ value }) => new Date(value).getUTCMinutes())).toEqual([2, 3, 4, 5, 6, 7, 8]);
    expect(result[0]?.label).toEqual(["09:02", "Oct 7", "2026", "UTC"]);
    expect(result[1]?.label).toEqual(["09:03"]);
    expect(result.every(({ value }) => value % 60_000 === 0)).toBe(true);
  });

  it("moves through hours, day and year context at UTC boundaries", () => {
    const hourly = ticks("2026-10-07T09:00:00Z", "2026-10-07T15:00:00Z", 450);
    expect(hourly.map(({ value }) => new Date(value).getUTCHours())).toEqual([9, 10, 11, 12, 13, 14, 15]);
    const midnight = ticks("2026-12-31T23:00:00Z", "2027-01-01T03:00:00Z", 800);
    expect(midnight.find(({ value }) => value === epoch("2027-01-01T00:00:00Z"))?.label).toEqual(["00:00", "Jan 1", "2027"]);
    expect(midnight.flatMap(({ label }) => label).filter((line) => line === "UTC")).toHaveLength(1);
  });

  it("uses UTC midnight day ticks, including the leap day", () => {
    const result = ticks("2024-02-28T00:00:00Z", "2024-03-02T00:00:00Z", 250);
    expect(result.map(({ value }) => new Date(value).toISOString())).toEqual([
      "2024-02-28T00:00:00.000Z", "2024-02-29T00:00:00.000Z",
      "2024-03-01T00:00:00.000Z", "2024-03-02T00:00:00.000Z",
    ]);
    expect(result.map(({ label }) => label)).toEqual([["Feb 28", "2024"], ["Feb 29"], ["Mar 1"], ["Mar 2"]]);
  });

  it("aligns weeks to Mondays rather than epoch weekdays", () => {
    const result = ticks("2026-01-01T00:00:00Z", "2026-03-01T00:00:00Z", 500);
    expect(result.length).toBeGreaterThan(4);
    expect(result.every(({ value }) => new Date(value).getUTCDay() === 1)).toBe(true);
    expect(result[0]?.value).toBe(epoch("2026-01-05T00:00:00Z"));
    expect((result[1]?.value ?? 0) - (result[0]?.value ?? 0)).toBe(7 * 86_400_000);
  });

  it("uses months then quarter boundaries when month labels no longer fit", () => {
    const monthly = ticks("2026-01-01T00:00:00Z", "2026-12-31T00:00:00Z", 600);
    expect(monthly.map(({ value }) => new Date(value).getUTCMonth())).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]);
    expect(monthly[0]?.label).toEqual(["Jan", "2026"]);
    const quarters = ticks("2026-01-01T00:00:00Z", "2026-12-31T00:00:00Z", 280);
    expect(quarters.map(({ value }) => new Date(value).getUTCMonth())).toEqual([0, 3, 6, 9]);
    expect(quarters.map(({ label }) => label)).toEqual([["Jan", "2026"], ["Apr"], ["Jul"], ["Oct"]]);
  });

  it("uses nonduplicated years and bounded nice multi-year steps", () => {
    const years = ticks("2020-01-01T00:00:00Z", "2034-01-01T00:00:00Z", 600);
    expect(years.map(({ label }) => label)).toEqual(Array.from({ length: 15 }, (_, index) => [(2020 + index).toString()]));
    const millennia = ticks("0000-01-01T00:00:00Z", "9999-12-31T00:00:00Z", 300);
    expect(millennia.map(({ value }) => new Date(value).getUTCFullYear())).toEqual([0, 2000, 4000, 6000, 8000]);
    expect(millennia[0]?.label).toEqual(["1 BC"]);
  });

  it("rejects impossibly dense long-range candidates before measuring their labels", () => {
    let measurements = 0;
    const result = calendarTicks(epoch("0000-01-01T00:00:00Z"), epoch("9999-12-31T00:00:00Z"), 300, (text) => {
      measurements++;
      return measure(text);
    }, "en-US");
    expect(result.map(({ value }) => new Date(value).getUTCFullYear())).toEqual([0, 2000, 4000, 6000, 8000]);
    expect(measurements).toBeLessThanOrEqual(80);
  });

  it("preserves early years and boundaries before the epoch", () => {
    const years = ticks("0099-01-01T00:00:00Z", "0101-01-01T00:00:00Z", 150);
    expect(years.map(({ value }) => new Date(value).getUTCFullYear())).toEqual([99, 100, 101]);
    const negative = ticks("1969-12-31T23:56:30Z", "1969-12-31T23:59:00Z", 500);
    expect(negative.map(({ value }) => new Date(value).getUTCMinutes())).toEqual([57, 58, 59]);
  });

  it("fits measured multiline widths without rotating and coarsens with available width", () => {
    const min = epoch("2026-01-01T00:00:00Z");
    const max = epoch("2026-01-15T00:00:00Z");
    const narrow = calendarTicks(min, max, 240, measure, "en-US");
    const wide = calendarTicks(min, max, 1_000, measure, "en-US");
    expect(narrow.length).toBeLessThan(wide.length);
    for (let index = 1; index < narrow.length; index++) {
      const previous = narrow[index - 1];
      const current = narrow[index];
      if (previous === undefined || current === undefined) throw new Error("Missing ticks");
      const separation = (current.value - previous.value) / (max - min) * 240;
      const previousWidth = Math.max(...previous.label.map(measure));
      const currentWidth = Math.max(...current.label.map(measure));
      expect(separation).toBeGreaterThanOrEqual((previousWidth + currentWidth) / 2 + 12);
    }
    const largeFont = calendarTicks(min, max, 1_000, (text) => measure(text) * 2, "en-US");
    expect(largeFont.length).toBeLessThan(wide.length);
  });

  it("never invents unaligned ticks for sub-minute or equal-x ranges and refuses invalid ranges", () => {
    const min = epoch("2026-10-07T09:01:12Z");
    expect(calendarTicks(min, min + 1_000, 300, measure, "en-US")).toEqual([]);
    expect(calendarTicks(min, min, 300, measure, "en-US")).toEqual([]);
    const boundary = epoch("2026-10-07T09:02:00Z");
    expect(calendarTicks(min, boundary, 300, measure, "en-US")).toEqual([
      { value: boundary, label: ["09:02", "Oct 7", "2026", "UTC"] },
    ]);
    expect(calendarTicks(boundary, boundary, 300, measure, "en-US")).toHaveLength(1);
    expect(calendarTicks(Number.NaN, min, 300, measure)).toEqual([]);
    expect(calendarTicks(min, min - 1, 300, measure)).toEqual([]);
    expect(calendarTicks(0, 9e15, 300, measure)).toEqual([]);
  });
});

import { describe, expect, it } from "vitest";
import { observationTicks } from "../src/editor/chart-ticks.js";

const epoch = (date: string): number => Date.parse(date);
const measure = (text: string): number => text.length * 6;
const dates = (values: string[], width = 800) => {
  const xs = values.map(epoch);
  return observationTicks(xs, "date", xs[0] ?? 0, xs.at(-1) ?? 0, width, measure, "en-US");
};

describe("observation ticks", () => {
  it("labels every daily observation compactly without inventing intermediate ticks", () => {
    const values = Array.from({ length: 7 }, (_, index) => `2026-10-0${index + 1}T09:30:00Z`);
    const result = dates(values);
    expect(result.map(tick => tick.value)).toEqual(values.map(epoch));
    expect(result.map(tick => tick.label)).toEqual(values.map((_, index) => [`Oct ${index + 1}`]));
    const german = observationTicks(values.map(epoch), "date", epoch(values[0] as string), epoch(values[6] as string), 800, measure, "de-DE");
    expect(german[0]?.label).toEqual([new Intl.DateTimeFormat("de-DE", { timeZone: "UTC", month: "short", day: "numeric" }).format(epoch(values[0] as string))]);
  });

  it("adds year context only for multiple UTC years, including years before 100", () => {
    expect(dates(["2026-12-30", "2026-12-31", "2027-01-01", "2027-01-02"]).map(tick => tick.label))
      .toEqual([["Dec 30", "2026"], ["Dec 31"], ["Jan 1", "2027"], ["Jan 2"]]);
    expect(dates(["0099-12-31", "0100-01-01"]).map(tick => tick.label))
      .toEqual([["Dec 31", "99"], ["Jan 1", "100"]]);
    expect(dates(["0000-12-31", "0001-01-01"])[0]?.label).toEqual(["Dec 31", "1 BC"]);
  });

  it("uses time only for distinct same-day x values, with day changes and UTC once", () => {
    const result = dates(["2026-10-07T09:00:00Z", "2026-10-07T10:00:00Z", "2026-10-08T10:00:00Z"]);
    expect(result.map(tick => tick.label)).toEqual([["09:00", "Oct 7", "UTC"], ["10:00"], ["10:00", "Oct 8"]]);
    expect(dates(["2026-12-31T22:00:00Z", "2026-12-31T23:00:00Z", "2027-01-01T00:00:00Z"]).map(tick => tick.label))
      .toEqual([["22:00", "Dec 31", "2026", "UTC"], ["23:00"], ["00:00", "Jan 1", "2027"]]);
    expect(dates(["2026-10-07T09:00:01Z", "2026-10-07T09:00:02Z"]).map(tick => tick.label[0]))
      .toEqual(["09:00:01", "09:00:02"]);
    expect(dates(["2026-10-07T09:00:00.100Z", "2026-10-07T09:00:00.200Z"]).map(tick => tick.label[0]))
      .toEqual(["09:00:00.100", "09:00:00.200"]);
  });

  it("distinguishes sub-millisecond observations without truncation, also before the epoch", () => {
    for (const xs of [[0.1, 0.2], [-0.2, -0.1], [1_000.1, 1_000.2]]) {
      const result = observationTicks(xs, "date", xs[0] as number, xs[1] as number, 800, measure, "en-US");
      expect(result).toHaveLength(2);
      expect(new Set(result.map(tick => tick.label[0])).size).toBe(2);
      expect(result[0]?.label[0]).toMatch(/ms$/);
      expect(result[0]?.label).toContain(xs[0] as number < 0 ? "Dec 31" : "Jan 1");
    }
    const closeNegative = observationTicks([-0.10000000000000002, -0.1], "date", -0.10000000000000002, -0.1, 800, measure, "en-US");
    expect(closeNegative).toHaveLength(2);
    expect(closeNegative.map(tick => tick.label[1])).toEqual(["-0.10000000000000002 epoch ms", "-0.1 epoch ms"]);
    expect(observationTicks([-Number.MIN_VALUE, Number.MIN_VALUE], "date", -Number.MIN_VALUE, Number.MIN_VALUE, 800, measure, "en-US").map(tick => tick.label))
      .toEqual([["Dec 31", "1969"], ["Jan 1", "1970"]]);
  });

  it("keeps irregular numeric observations and enough precision for adjacent doubles", () => {
    for (const xs of [[1, 2, 7, 7.5, 40], [1, 1 + Number.EPSILON], [1e-20, 1.0000000000000001e-20]]) {
      const result = observationTicks(xs, "number", xs[0] as number, xs.at(-1) as number, 10_000, measure, "en-US");
      expect(result.map(tick => tick.value)).toEqual(xs);
      expect(new Set(result.map(tick => tick.label[0])).size).toBe(xs.length);
    }
  });

  it("omits only overlapping labels, without imposing extra spacing", () => {
    const xs = [1, 2, 7, 7.5, 40];
    const result = observationTicks(xs, "number", 1, 40, 360, measure, "en-US");
    for (let index = 1; index < result.length; index++) {
      const previous = result[index - 1];
      const current = result[index];
      if (!previous || !current) throw new Error("Missing ticks");
      expect((current.value - previous.value) / 39 * 360)
        .toBeGreaterThanOrEqual((measure(previous.label[0] as string) + measure(current.label[0] as string)) / 2);
    }
    for (const omitted of xs.filter(x => !result.some(tick => tick.value === x))) {
      expect(result.some(tick => Math.abs(omitted - tick.value) / 39 * 360 <
        (measure(String(omitted)) + measure(tick.label[0] as string)) / 2)).toBe(true);
    }
    expect(observationTicks([1, 2], "number", 1, 2, 7, measure, "en-US")).toHaveLength(2);
  });

  it("preserves context relative to retained labels after skipping a day and year boundary", () => {
    const result = dates(["2026-12-31T22:00:00Z", "2026-12-31T23:59:00Z", "2027-01-01T00:00:00Z", "2027-01-01T02:00:00Z"], 65);
    expect(result.map(tick => tick.label)).toEqual([["22:00", "Dec 31", "2026", "UTC"], ["02:00", "Jan 1", "2027"]]);
  });

  it("keeps single x labels and handles the 5,000-record bound with one measured pass", () => {
    expect(dates(["2026-10-07T09:30:00Z"])).toEqual([{ value: epoch("2026-10-07T09:30:00Z"), label: ["Oct 7"] }]);
    expect(observationTicks([7.5], "number", 6.5, 8.5, 360, measure, "en-US")).toEqual([{ value: 7.5, label: ["7.5"] }]);
    for (const count of [365, 5_000]) {
      const xs = Array.from({ length: count }, (_, index) => epoch("2026-01-01") + index * 86_400_000);
      let measurements = 0;
      const result = observationTicks(xs, "date", xs[0] as number, xs.at(-1) as number, 360, text => {
        measurements++;
        return measure(text);
      }, "en-US");
      expect(result.length).toBeGreaterThan(1);
      expect(result.length).toBeLessThan(20);
      expect(measurements).toBeLessThanOrEqual(xs.length * 2);
      expect(result.every(tick => xs.includes(tick.value))).toBe(true);
      for (let index = 1; index < result.length; index++) {
        const previous = result[index - 1], current = result[index];
        if (!previous || !current) throw new Error("Missing ticks");
        expect((current.value - previous.value) / ((xs.at(-1) as number) - (xs[0] as number)) * 360)
          .toBeGreaterThanOrEqual((Math.max(...previous.label.map(measure)) + Math.max(...current.label.map(measure))) / 2);
      }
    }
    expect(observationTicks([], "number", 0, 1, 360, measure)).toEqual([]);
  });
});

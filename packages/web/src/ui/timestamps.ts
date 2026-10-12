/**
 * Show elapsed time for activity younger than 30 days, with exact local time
 * on hover, and a calendar date thereafter. Return null for invalid values.
 * Share one clock per surface rather than one timer per row.
 */

import { useEffect, useState } from "react";

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const WEEK = 7 * DAY;
const MONTH = 30 * DAY;
const YEAR = 365 * DAY;
const RECENT_WINDOW = MONTH;

const DATE_FORMAT = new Intl.DateTimeFormat(undefined, { dateStyle: "medium" });
const DATE_TIME_FORMAT = new Intl.DateTimeFormat(undefined, {
  dateStyle: "medium",
  timeStyle: "short",
});

export interface FormattedTimestamp {
  label: string;
  dateTime: string;
  /** Present only while the visible label is relative. */
  title?: string;
}

function timestampDate(value: string | number): Date | null {
  const date = new Date(typeof value === "number" ? value : Date.parse(value));
  return Number.isFinite(date.getTime()) ? date : null;
}

function relativeAge(age: number): { amount: number; unit: string; shortUnit: string } {
  const [amount, unit, shortUnit] =
    age < HOUR
      ? [Math.floor(age / MINUTE), "minute", "m"] as const
      : age < DAY
        ? [Math.floor(age / HOUR), "hour", "h"] as const
        : age < WEEK
          ? [Math.floor(age / DAY), "day", "d"] as const
          : age < MONTH
            ? [Math.floor(age / WEEK), "week", "w"] as const
            : age < YEAR
              ? [Math.floor(age / MONTH), "month", "mo"] as const
              : [Math.floor(age / YEAR), "year", "y"] as const;
  return { amount, unit, shortUnit };
}

/** The exact local date and time used by hover previews and sync details. */
export function formatExactTimestamp(
  value: string | number,
): FormattedTimestamp | null {
  const date = timestampDate(value);
  return date === null
    ? null
    : { label: DATE_TIME_FORMAT.format(date), dateTime: date.toISOString() };
}

/** Activity switches to calendar dates; record timelines keep elapsed time. */
export function formatTimestamp(
  value: string | number,
  now: number = Date.now(),
  relativeOnly = false,
): FormattedTimestamp | null {
  const date = timestampDate(value);
  if (date === null) return null;
  const at = date.getTime();

  const dateTime = date.toISOString();
  const age = Math.max(0, now - at);
  if (age >= RECENT_WINDOW && !relativeOnly) {
    return { label: DATE_FORMAT.format(at), dateTime };
  }

  const { amount, unit } = relativeAge(age);
  return {
    label: amount < 1 ? "just now" : `${amount} ${unit}${amount === 1 ? "" : "s"} ago`,
    dateTime,
    title: DATE_TIME_FORMAT.format(at),
  };
}

/** Compact recorded-answer ages keep an exact date on hover at every age. */
export function formatShortTimestamp(
  value: string | number,
  now: number = Date.now(),
): FormattedTimestamp | null {
  const date = timestampDate(value);
  if (date === null) return null;
  const { amount, shortUnit } = relativeAge(Math.max(0, now - date.getTime()));
  return {
    label: amount < 1 ? "now" : `${amount}${shortUnit}`,
    dateTime: date.toISOString(),
    title: DATE_TIME_FORMAT.format(date),
  };
}

/** One minute-resolution clock, called once by each timestamp surface. */
export function useTimestampClock(): number {
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), MINUTE);
    return () => window.clearInterval(timer);
  }, []);
  return now;
}

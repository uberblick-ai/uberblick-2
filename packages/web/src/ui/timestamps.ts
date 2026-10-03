/**
 * The one visible timestamp policy for the web UI.
 *
 * Recent activity is easiest to place as elapsed time, with its exact local
 * date and time available on hover. Once it is 30 days old, a calendar date is
 * easier to place and the time of day stops adding useful precision. Invalid
 * values return `null` so each consuming surface keeps its own honest fallback.
 * A surface calls {@link useTimestampClock} once, rather than giving every
 * timestamp its own timer, so relative labels stay current without per-row work.
 */

import { useEffect, useState } from "react";

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const WEEK = 7 * DAY;
const RECENT_WINDOW = 30 * DAY;

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

/** The exact local date and time used by hover previews and sync details. */
export function formatExactTimestamp(
  value: string | number,
): FormattedTimestamp | null {
  const date = timestampDate(value);
  return date === null
    ? null
    : { label: DATE_TIME_FORMAT.format(date), dateTime: date.toISOString() };
}

/** One visible timestamp rule for every web surface. */
export function formatTimestamp(
  value: string | number,
  now: number = Date.now(),
): FormattedTimestamp | null {
  const date = timestampDate(value);
  if (date === null) return null;
  const at = date.getTime();

  const dateTime = date.toISOString();
  const age = Math.max(0, now - at);
  if (age >= RECENT_WINDOW) {
    return { label: DATE_FORMAT.format(at), dateTime };
  }

  const [amount, unit] =
    age < HOUR
      ? [Math.floor(age / MINUTE), "minute"]
      : age < DAY
        ? [Math.floor(age / HOUR), "hour"]
        : age < WEEK
          ? [Math.floor(age / DAY), "day"]
          : [Math.floor(age / WEEK), "week"];
  return {
    label: amount < 1 ? "just now" : `${amount} ${unit}${amount === 1 ? "" : "s"} ago`,
    dateTime,
    title: DATE_TIME_FORMAT.format(at),
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

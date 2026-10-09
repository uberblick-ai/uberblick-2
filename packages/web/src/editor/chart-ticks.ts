export interface CalendarTick {
  value: number;
  label: string[];
}

type CalendarUnit = "minute" | "hour" | "day" | "week" | "month" | "year";
interface CalendarStep { unit: CalendarUnit; amount: number }

const MINUTE = 60_000;
const DAY = 24 * 60 * MINUTE;
const MAX_TICKS = 2_048;
const LABEL_GAP = 12;
const STEPS: CalendarStep[] = [
  ...[1, 2, 5, 10, 15, 30].map((amount) => ({ unit: "minute" as const, amount })),
  ...[1, 2, 3, 6, 12].map((amount) => ({ unit: "hour" as const, amount })),
  ...[1, 2].map((amount) => ({ unit: "day" as const, amount })),
  ...[1, 2].map((amount) => ({ unit: "week" as const, amount })),
  { unit: "month", amount: 1 }, { unit: "month", amount: 3 },
];

// Date.UTC interprets years 0–99 as 1900–1999. The mapping also accepts those years.
function utcDate(year: number, month = 0, day = 1): number {
  const date = new Date(0);
  date.setUTCFullYear(year, month, day);
  return date.getTime();
}

function interval(step: CalendarStep): number {
  switch (step.unit) {
    case "minute": return step.amount * MINUTE;
    case "hour": return step.amount * 60 * MINUTE;
    case "day": return step.amount * DAY;
    case "week": return step.amount * 7 * DAY;
    case "month": return step.amount * 28 * DAY;
    case "year": return step.amount * 365 * DAY;
  }
}

function firstBoundary(min: number, step: CalendarStep): number {
  if (step.unit === "month" || step.unit === "year") {
    const date = new Date(min);
    const year = date.getUTCFullYear();
    const month = Math.floor(date.getUTCMonth() / step.amount) * step.amount;
    const first = step.unit === "year"
      ? utcDate(Math.floor(year / step.amount) * step.amount)
      : utcDate(year, month);
    return first < min ? nextBoundary(first, step) : first;
  }
  // 1970-01-05 is a Monday; a two-week cadence uses that same calendar anchor.
  const anchor = step.unit === "week" ? 4 * DAY : 0;
  const size = interval(step);
  return Math.ceil((min - anchor) / size) * size + anchor;
}

function nextBoundary(value: number, step: CalendarStep): number {
  if (step.unit === "month" || step.unit === "year") {
    const date = new Date(value);
    return step.unit === "year"
      ? utcDate(date.getUTCFullYear() + step.amount)
      : utcDate(date.getUTCFullYear(), date.getUTCMonth() + step.amount);
  }
  return value + interval(step);
}

function boundaryValues(min: number, max: number, step: CalendarStep, limit: number): number[] | null {
  const first = firstBoundary(min, step);
  if (!Number.isFinite(first) || first > max) return [];
  const firstDate = new Date(first);
  const lastDate = new Date(max);
  const distance = step.unit === "month"
    ? (lastDate.getUTCFullYear() - firstDate.getUTCFullYear()) * 12 + lastDate.getUTCMonth() - firstDate.getUTCMonth()
    : step.unit === "year" ? lastDate.getUTCFullYear() - firstDate.getUTCFullYear()
    : max - first;
  const size = step.unit === "month" || step.unit === "year" ? step.amount : interval(step);
  // The required gap alone rules these candidates out; avoid generating or formatting them.
  if (Math.floor(distance / size) + 1 > limit) return null;
  const values: number[] = [];
  for (let value = first; value <= max && Number.isFinite(value); value = nextBoundary(value, step)) {
    if (values.length === limit) return null;
    values.push(value);
  }
  return values;
}

function tickLabels(values: number[], step: CalendarStep, locale?: string): CalendarTick[] {
  const time = new Intl.DateTimeFormat(locale, {
    timeZone: "UTC", hour: "2-digit", minute: "2-digit", hourCycle: "h23",
  });
  const day = new Intl.DateTimeFormat(locale, { timeZone: "UTC", month: "short", day: "numeric" });
  const month = new Intl.DateTimeFormat(locale, { timeZone: "UTC", month: "short" });
  const year = new Intl.DateTimeFormat(locale, { timeZone: "UTC", year: "numeric" });
  const ancientYear = new Intl.DateTimeFormat(locale, { timeZone: "UTC", year: "numeric", era: "short" });
  const intraday = step.unit === "minute" || step.unit === "hour";
  return values.map((value, index) => {
    const date = new Date(value);
    const previous = index === 0 ? null : new Date(values[index - 1] as number);
    const yearLabel = date.getUTCFullYear() <= 0 ? ancientYear.format(date) : year.format(date);
    const label = [intraday ? time.format(date)
      : step.unit === "year" ? yearLabel
      : step.unit === "month" ? month.format(date) : day.format(date)];
    if (intraday && (previous === null || Math.floor(value / DAY) !== Math.floor(previous.getTime() / DAY))) {
      label.push(day.format(date));
    }
    if (step.unit !== "year" && (previous === null || previous.getUTCFullYear() !== date.getUTCFullYear())) {
      label.push(yearLabel);
    }
    if (intraday && previous === null) label.push("UTC");
    return { value, label };
  });
}

function labelsFit(ticks: CalendarTick[], min: number, max: number, width: number, measure: (text: string) => number): boolean {
  const widths = ticks.map(({ label }) => Math.max(...label.map(measure)));
  if (widths.some((labelWidth) => labelWidth > width)) return false;
  return ticks.every((tick, index) => {
    if (index === 0) return true;
    const previous = ticks[index - 1] as CalendarTick;
    const available = (tick.value - previous.value) / (max - min) * width;
    return available >= ((widths[index - 1] as number) + (widths[index] as number)) / 2 + LABEL_GAP;
  });
}

/** Calendar-aligned UTC ticks for Chart.js's linear epoch-millisecond scale. */
export function calendarTicks(
  min: number, max: number, width: number, measure: (text: string) => number, locale?: string,
): CalendarTick[] {
  if (!Number.isFinite(min) || !Number.isFinite(max) || max < min
    || !Number.isFinite(new Date(min).getTime()) || !Number.isFinite(new Date(max).getTime())) return [];
  const availableWidth = Number.isFinite(width) ? Math.max(1, width) : 1;
  const limit = Math.min(MAX_TICKS, Math.floor(availableWidth / LABEL_GAP) + 1);
  const steps = [...STEPS];
  // Nice multi-year steps keep the walk bounded even across the entire Date range.
  for (let power = 1; power <= 1_000_000; power *= 10) {
    for (const amount of [power, 2 * power, 5 * power]) steps.push({ unit: "year", amount });
  }
  let fallback: CalendarTick[] | undefined;
  for (const step of steps) {
    const values = boundaryValues(min, max, step, limit);
    if (values === null || values.length === 0) continue;
    const ticks = tickLabels(values, step, locale);
    fallback = ticks;
    if (labelsFit(ticks, min, max, availableWidth, measure)) return ticks;
  }
  // A sub-minute range can contain no boundary; never invent an unaligned tick.
  return fallback?.slice(0, 1) ?? [];
}

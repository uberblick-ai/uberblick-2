export interface ObservationTick {
  value: number;
  label: string[];
}

const DAY = 86_400_000;

function dateLabels(values: readonly number[], locale?: string): (value: number, previous?: number) => string[] {
  const bucket = (value: number, size: number): number => Math.floor(Math.floor(value) / size);
  const intraday = values.some((value, index) => index > 0 &&
    bucket(value, DAY) === bucket(values[index - 1] as number, DAY));
  const yearOf = (value: number): number => new Date(Math.floor(value)).getUTCFullYear();
  const multiYear = yearOf(values[0] as number) !== yearOf(values[values.length - 1] as number);
  const time = [false, true].map(seconds => new Intl.DateTimeFormat(locale, {
    timeZone: "UTC", hour: "2-digit", minute: "2-digit", hourCycle: "h23",
    ...(seconds ? { second: "2-digit" } as const : {}),
  }));
  const fractions = new Map<number, Intl.NumberFormat>();
  const timeOf = (value: number, previous?: number): string => {
    const seconds = previous !== undefined && bucket(value, 60_000) === bucket(previous, 60_000);
    let label = (time[Number(seconds)] as Intl.DateTimeFormat).format(new Date(Math.floor(value)));
    if (!seconds || previous === undefined || bucket(value, 1_000) !== bucket(previous, 1_000)) return label;
    const remainder = (instant: number): number => (instant - bucket(instant, 1_000) * 1_000) / 1_000;
    const current = remainder(value), prior = remainder(previous);
    // Use only the decimal precision needed by this retained pair. Rounding
    // avoids exposing binary epoch-ms tails; don't round into the next second.
    let digits = 1;
    while (digits < 9 && (current.toFixed(digits) === prior.toFixed(digits) || Number(current.toFixed(digits)) === 1)) digits++;
    let format = fractions.get(digits);
    if (format === undefined) {
      format = new Intl.NumberFormat(locale, { minimumFractionDigits: digits, maximumFractionDigits: digits, useGrouping: false });
      fractions.set(digits, format);
    }
    label += format.format(current).slice(1);
    return label;
  };
  const day = new Intl.DateTimeFormat(locale, { timeZone: "UTC", month: "short", day: "numeric" });
  const year = new Intl.DateTimeFormat(locale, { timeZone: "UTC", year: "numeric" });
  const ancientYear = new Intl.DateTimeFormat(locale, { timeZone: "UTC", year: "numeric", era: "short" });
  return (value, previous) => {
    const date = new Date(Math.floor(value));
    const label = [intraday ? timeOf(value, previous) : day.format(date)];
    if (intraday && (previous === undefined || bucket(value, DAY) !== bucket(previous, DAY))) {
      label.push(day.format(date));
    }
    if (multiYear && (previous === undefined || yearOf(value) !== yearOf(previous))) {
      label.push((yearOf(value) <= 0 ? ancientYear : year).format(date));
    }
    if (intraday && previous === undefined) label.push("UTC");
    return label;
  };
}

function observationLabels(values: readonly number[], type: "date" | "number", locale?: string) {
  const number = new Intl.NumberFormat(locale, { maximumSignificantDigits: 21 }).format;
  return type === "date" ? dateLabels(values, locale) : (value: number) => [number(value)];
}

/** Reserve both endpoints before Chart.js fits, including the finest last-label precision. */
export function observationEndpoints(values: readonly number[], type: "date" | "number", locale?: string): ObservationTick[] {
  if (values.length === 0) return [];
  const labelFor = observationLabels(values, type, locale);
  const first = values[0] as number, last = values[values.length - 1] as number;
  const ticks = [{ value: first, label: labelFor(first) }];
  if (last !== first) {
    const label = labelFor(last);
    label[0] = labelFor(last, values[values.length - 2])[0] as string;
    ticks.push({ value: last, label });
  }
  return ticks;
}

/** Select a non-overlapping subset of sorted, distinct plotted x positions. */
export function observationTicks(
  values: readonly number[], type: "date" | "number", min: number, max: number,
  width: number, measure: (text: string) => number, locale?: string,
): ObservationTick[] {
  if (values.length === 0) return [];
  const labelFor = observationLabels(values, type, locale);
  const selected: ObservationTick[] = [];
  let previousWidth = 0;
  for (const value of values) {
    const previous = selected[selected.length - 1];
    const label = labelFor(value, previous?.value);
    const labelWidth = Math.max(...label.map(measure));
    const distance = previous === undefined ? Infinity :
      (value - previous.value) / (max - min) * width;
    // Every skipped label overlaps a retained predecessor. Do not impose a
    // cadence or extra minimum spacing that would hide labels which fit.
    if (distance < (previousWidth + labelWidth) / 2) continue;
    selected.push({ value, label });
    previousWidth = labelWidth;
  }
  return selected;
}

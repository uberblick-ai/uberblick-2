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
  // Distinct instants within one minute need seconds; within one second they
  // need fractions. Keep the numeric remainder rather than Date's truncated ms.
  const sameBucket = (size: number): boolean => values.some((value, index) => index > 0 &&
    bucket(value, size) === bucket(values[index - 1] as number, size));
  const seconds = intraday && sameBucket(60_000);
  const fractions = seconds && sameBucket(1_000);
  const subMillisecond = fractions && values.some(value => value !== Math.floor(value));
  const time = new Intl.DateTimeFormat(locale, {
    timeZone: "UTC", hour: "2-digit", minute: "2-digit", hourCycle: "h23",
    ...(seconds ? { second: "2-digit" } as const : {}),
    ...(fractions && !subMillisecond ? { fractionalSecondDigits: 3 } as const : {}),
  });
  const remainder = new Intl.NumberFormat(locale, { maximumSignificantDigits: 21 }).format;
  const timeOf = (value: number): string => time.format(new Date(Math.floor(value))) + (subMillisecond
    ? ` + ${remainder(value - bucket(value, 1_000) * 1_000)} ms` : "");
  // Subtracting a second boundary can lose precision near the epoch (e.g.
  // adjacent negative fractions both round to 999.9 ms). Exact epoch context
  // distinguishes those supported instants without changing tooltip formats.
  const epochContext = subMillisecond && values.some((value, index) => index > 0 &&
    bucket(value, DAY) === bucket(values[index - 1] as number, DAY) &&
    timeOf(value) === timeOf(values[index - 1] as number));
  const day = new Intl.DateTimeFormat(locale, { timeZone: "UTC", month: "short", day: "numeric" });
  const year = new Intl.DateTimeFormat(locale, { timeZone: "UTC", year: "numeric" });
  const ancientYear = new Intl.DateTimeFormat(locale, { timeZone: "UTC", year: "numeric", era: "short" });
  return (value, previous) => {
    const date = new Date(Math.floor(value));
    const label = [intraday ? timeOf(value) : day.format(date)];
    if (epochContext) label.push(`${remainder(value)} epoch ms`);
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

/** Select a non-overlapping subset of sorted, distinct plotted x positions. */
export function observationTicks(
  values: readonly number[], type: "date" | "number", min: number, max: number,
  width: number, measure: (text: string) => number, locale?: string,
): ObservationTick[] {
  if (values.length === 0) return [];
  const number = new Intl.NumberFormat(locale, { maximumSignificantDigits: 21 }).format;
  const labelFor = type === "date" ? dateLabels(values, locale) : (value: number) => [number(value)];
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

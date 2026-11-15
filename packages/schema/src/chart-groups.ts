/** Group identities and palette order depend on stored values, not row order. */
import { canonicalJson, compareCodePoints } from "./data-schema.js";
import type { JSONValue } from "./data-schema.js";

export interface ChartGroup { key: string; value: JSONValue }

export function chartGroups<T extends { groupKey?: string }>(items: T[], valueFor: (item: T) => unknown):
  { groups: ChartGroup[]; groupOverflow: boolean } {
  const values = new Map<string, JSONValue>();
  for (const item of items) {
    const value = valueFor(item);
    if (value === undefined || value === null) continue;
    item.groupKey = canonicalJson(value);
    values.set(item.groupKey, value as JSONValue);
  }
  const groupOverflow = values.size > 8;
  const groups = groupOverflow ? [] : [...values.entries()]
    .sort(([a], [b]) => compareCodePoints(a, b)).map(([key, value]) => ({ key, value }));
  return { groups, groupOverflow };
}

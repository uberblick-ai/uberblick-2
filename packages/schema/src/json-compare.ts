/**
 * A structural comparison of two JSON texts. Both sides of a side-by-side view
 * render the same merged tree, so their rows line up by construction.
 * Formatting and key order are never changes; literals stay as written.
 */
import { jsonPathStep, parseJsonSource } from "./json-source.js";
import type { JsonSourceNode } from "./json-source.js";
import { diffWords, matchSequence } from "./revision-sequence.js";

/** Larger pairs fall back to a text comparison. */
export const JSON_COMPARE_MAX_NODES = 20_000;
/** Longer strings mark changed words instead of characters. */
export const JSON_COMPARE_WORD_LENGTH = 80;
/** Cap exact word matching's quadratic work; larger values use one prefix/suffix range. */
const MAX_WORD_DIFF_LENGTH = 4096;
/** Fields that identify array elements, checked in this order. */
const IDENTITY_FIELDS = ["id", "key", "name"] as const;

export type JsonChangeKind = "unchanged" | "changed" | "added" | "removed" | "moved" | "type-changed";
/** A half-open range of a value's text as written. */
export type JsonTextRange = readonly [start: number, end: number];

export interface JsonCompareNode {
  /** Stable per comparison: object keys and array indexes on the newer side, `[was n]` for removed elements. */
  path: string;
  kind: JsonChangeKind;
  /** The key as written, or the array index, on each side; null for the root and for a missing side. */
  beforeKey: string | number | null;
  afterKey: string | number | null;
  before: JsonSourceNode | null;
  after: JsonSourceNode | null;
  /** Children of an object or array present on either side, in display order. */
  children: JsonCompareNode[];
  /** This node or anything inside it changed. */
  changedWithin: boolean;
  /** Changed ranges of a changed string or number, on each side. */
  marks?: { before: JsonTextRange[]; after: JsonTextRange[] };
  /** A moved array element's index in the older text. */
  movedFrom?: number;
}

export type JsonComparison =
  | { ok: true; root: JsonCompareNode; changes: number }
  | { ok: false; reason: "before-invalid" | "after-invalid" | "too-large" };

function nodeCount(node: JsonSourceNode): number {
  if (node.kind === "object") return node.entries.reduce((sum, entry) => sum + nodeCount(entry.value), 1);
  if (node.kind === "array") return node.items.reduce((sum, item) => sum + nodeCount(item), 1);
  return 1;
}

/** Key order and formatting removed: equal values give equal text. */
function canonical(node: JsonSourceNode): string {
  switch (node.kind) {
    case "object": {
      const entries = node.entries.map((entry) => `${JSON.stringify(entry.key)}:${canonical(entry.value)}`);
      return `{${entries.sort().join(",")}}`;
    }
    case "array": return `[${node.items.map(canonical).join(",")}]`;
    case "string": return JSON.stringify(node.value);
    case "number": return node.raw;
    case "boolean": return String(node.value);
    case "null": return "null";
  }
}

function scalarText(node: JsonSourceNode): string {
  if (node.kind === "string" || node.kind === "number") return node.raw;
  return node.kind === "boolean" ? String(node.value) : "null";
}

/** Changed characters, or changed words within the matching budget; shared ends stay unmarked. */
export function changedRanges(before: string, after: string): { before: JsonTextRange[]; after: JsonTextRange[] } {
  if ((before.length > JSON_COMPARE_WORD_LENGTH || after.length > JSON_COMPARE_WORD_LENGTH)
    && before.length + after.length <= MAX_WORD_DIFF_LENGTH) {
    const marks = { before: [] as JsonTextRange[], after: [] as JsonTextRange[] };
    let oldAt = 0;
    let newAt = 0;
    for (const span of diffWords(before, after)) {
      const length = span.text.length;
      if (span.kind !== "added") {
        if (span.kind === "removed") marks.before.push([oldAt, oldAt + length]);
        oldAt += length;
      }
      if (span.kind !== "removed") {
        if (span.kind === "added") marks.after.push([newAt, newAt + length]);
        newAt += length;
      }
    }
    return marks;
  }
  const shortest = Math.min(before.length, after.length);
  let prefix = 0;
  while (prefix < shortest && before[prefix] === after[prefix]) prefix += 1;
  let suffix = 0;
  while (suffix < shortest - prefix && before[before.length - 1 - suffix] === after[after.length - 1 - suffix]) suffix += 1;
  const range = (text: string): JsonTextRange[] => prefix < text.length - suffix ? [[prefix, text.length - suffix]] : [];
  return { before: range(before), after: range(after) };
}

function oneSided(node: JsonSourceNode, side: "before" | "after", path: string, key: string | number | null): JsonCompareNode {
  const children = node.kind === "object"
    ? withOccurrences(node).map(({ entry, suffix }) => oneSided(entry.value, side, objectPath(path, entry.key, suffix), entry.rawKey))
    : node.kind === "array" ? node.items.map((item, index) => oneSided(item, side, `${path}${jsonPathStep(index)}`, index)) : [];
  return {
    path, kind: side === "before" ? "removed" : "added", children, changedWithin: true,
    beforeKey: side === "before" ? key : null, afterKey: side === "after" ? key : null,
    before: side === "before" ? node : null, after: side === "after" ? node : null,
  };
}

type ObjectNode = Extract<JsonSourceNode, { kind: "object" }>;
type ArrayNode = Extract<JsonSourceNode, { kind: "array" }>;

/** Match the decoded key and occurrence independently of the display suffix. */
function withOccurrences(node: ObjectNode) {
  const seen = new Map<string, number>();
  return node.entries.map((entry) => {
    const count = (seen.get(entry.key) ?? 0) + 1;
    seen.set(entry.key, count);
    const suffix = count > 1 ? `#${count}` : "";
    return { entry, id: JSON.stringify([entry.key, count]), suffix };
  });
}

function objectPath(path: string, key: string, suffix: string): string {
  return `${path}${jsonPathStep(key)}${suffix}`;
}

function compareObjects(before: ObjectNode, after: ObjectNode, path: string): JsonCompareNode[] {
  const older = withOccurrences(before);
  const newer = withOccurrences(after);
  const olderIndex = new Map(older.map((item, index) => [item.id, index]));
  const matched = new Set<number>();
  const rows: JsonCompareNode[][] = newer.map((item) => {
    const index = olderIndex.get(item.id);
    const childPath = objectPath(path, item.entry.key, item.suffix);
    if (index === undefined) return [oneSided(item.entry.value, "after", childPath, item.entry.rawKey)];
    matched.add(index);
    const old = older[index] as (typeof older)[number];
    return [compareNodes(old.entry.value, item.entry.value, childPath, old.entry.rawKey, item.entry.rawKey)];
  });
  // A removed key follows its nearest older neighbour that still exists.
  const leading: JsonCompareNode[] = [];
  let anchor: JsonCompareNode[] = leading;
  older.forEach((item, index) => {
    if (matched.has(index)) {
      const at = newer.findIndex((candidate) => candidate.id === item.id);
      anchor = rows[at] as JsonCompareNode[];
      return;
    }
    anchor.push(oneSided(item.entry.value, "before", objectPath(path, item.entry.key, item.suffix), item.entry.rawKey));
  });
  return [...leading, ...rows.flat()];
}

function identityField(before: ArrayNode, after: ArrayNode): string | null {
  for (const field of IDENTITY_FIELDS) {
    const ids = (items: JsonSourceNode[]): string[] | null => {
      const values: string[] = [];
      for (const item of items) {
        if (item.kind !== "object") return null;
        const entry = item.entries.find((candidate) => candidate.key === field);
        if (entry?.value.kind !== "string") return null;
        values.push(entry.value.value);
      }
      return new Set(values).size === values.length ? values : null;
    };
    if (before.items.length + after.items.length > 0 && ids(before.items) !== null && ids(after.items) !== null) return field;
  }
  return null;
}

function identityOf(item: JsonSourceNode, field: string): string {
  if (item.kind !== "object") return "";
  const entry = item.entries.find((candidate) => candidate.key === field);
  return entry?.value.kind === "string" ? entry.value.value : "";
}

function compareArrays(before: ArrayNode, after: ArrayNode, path: string): JsonCompareNode[] {
  const field = identityField(before, after);
  const keys = (items: JsonSourceNode[]) => items.map((item) => ({
    key: canonical(item), ...(field === null ? {} : { id: JSON.stringify(identityOf(item, field)) }),
  }));
  const kept = matchSequence(keys(before.items), keys(after.items));
  const keptBefore = new Set(kept.map((pair) => pair.before));
  const keptAfter = new Map(kept.map((pair) => [pair.after, pair.before]));
  // Identity pairs that left the stationary sequence are moves.
  const moves = new Map<number, number>();
  if (field !== null) {
    const olderById = new Map(before.items.map((item, index) => [identityOf(item, field), index]));
    after.items.forEach((item, index) => {
      const old = olderById.get(identityOf(item, field));
      if (old !== undefined && !keptAfter.has(index)) moves.set(index, old);
    });
  }
  const movedFrom = new Set(moves.values());
  const element = (index: number) => `${path}${jsonPathStep(index)}`;
  const rows: JsonCompareNode[] = [];
  const gap = (oldStart: number, oldEnd: number, newStart: number, newEnd: number): void => {
    const removed: number[] = [];
    for (let index = oldStart; index < oldEnd; index += 1) if (!keptBefore.has(index) && !movedFrom.has(index)) removed.push(index);
    const added: number[] = [];
    for (let index = newStart; index < newEnd; index += 1) added.push(index);
    // Without identity, unmatched neighbours of one type compare inside rather than as remove plus add.
    for (let step = 0; step < Math.max(removed.length, added.length); step += 1) {
      const old = removed[step];
      const next = added[step];
      const moved = next === undefined ? undefined : moves.get(next);
      const oldNode = old === undefined ? undefined : before.items[old];
      const newNode = next === undefined ? undefined : after.items[next];
      if (field === null && oldNode !== undefined && newNode !== undefined && old !== undefined && next !== undefined
        && oldNode.kind === newNode.kind) {
        rows.push(compareNodes(oldNode, newNode, element(next), old, next));
        continue;
      }
      if (oldNode !== undefined && old !== undefined) rows.push(oneSided(oldNode, "before", `${path}[was ${old}]`, old));
      if (newNode === undefined || next === undefined) continue;
      if (moved === undefined) { rows.push(oneSided(newNode, "after", element(next), next)); continue; }
      const node = compareNodes(before.items[moved] as JsonSourceNode, newNode, element(next), moved, next);
      rows.push({ ...node, kind: node.kind === "unchanged" ? "moved" : node.kind, movedFrom: moved, changedWithin: true });
    }
  };
  let oldAt = 0;
  let newAt = 0;
  for (const pair of kept) {
    gap(oldAt, pair.before, newAt, pair.after);
    rows.push(compareNodes(before.items[pair.before] as JsonSourceNode, after.items[pair.after] as JsonSourceNode,
      element(pair.after), pair.before, pair.after));
    oldAt = pair.before + 1;
    newAt = pair.after + 1;
  }
  gap(oldAt, before.items.length, newAt, after.items.length);
  return rows;
}

function compareNodes(
  before: JsonSourceNode, after: JsonSourceNode, path: string,
  beforeKey: string | number | null, afterKey: string | number | null,
): JsonCompareNode {
  const base = { path, beforeKey, afterKey, before, after };
  if (before.kind !== after.kind) return { ...base, kind: "type-changed", children: [], changedWithin: true };
  if (before.kind === "object" || before.kind === "array") {
    const children = before.kind === "object"
      ? compareObjects(before, after as ObjectNode, path)
      : compareArrays(before, after as ArrayNode, path);
    return { ...base, kind: "unchanged", children, changedWithin: children.some((child) => child.changedWithin) };
  }
  const same = before.kind === "string" && after.kind === "string" ? before.value === after.value : scalarText(before) === scalarText(after);
  if (same) return { ...base, kind: "unchanged", children: [], changedWithin: false };
  const marks = before.kind === "boolean" ? undefined : changedRanges(scalarText(before), scalarText(after));
  return { ...base, kind: "changed", children: [], changedWithin: true, ...(marks === undefined ? {} : { marks }) };
}

/** How many changes a reader steps through: a whole added, removed or retyped subtree counts once. */
function countChanges(node: JsonCompareNode): number {
  if (node.kind === "added" || node.kind === "removed" || node.kind === "type-changed" || node.kind === "changed") return 1;
  return (node.kind === "moved" ? 1 : 0) + node.children.reduce((sum, child) => sum + countChanges(child), 0);
}

export function compareJsonSources(beforeText: string, afterText: string): JsonComparison {
  const before = parseJsonSource(beforeText);
  if (!before.ok) return { ok: false, reason: "before-invalid" };
  const after = parseJsonSource(afterText);
  if (!after.ok) return { ok: false, reason: "after-invalid" };
  if (nodeCount(before.value) + nodeCount(after.value) > JSON_COMPARE_MAX_NODES) return { ok: false, reason: "too-large" };
  const root = compareNodes(before.value, after.value, "", null, null);
  return { ok: true, root, changes: countChanges(root) };
}

/** The first view opens containers breadth-first while this many rows fit. */
export const JSON_COMPARE_FIRST_VIEW_ROWS = 20;

export interface JsonComparePiece {
  text: string;
  role: "key" | "punct" | "string" | "number" | "literal" | "count" | "note";
  /** Part of a changed value's changed range. */
  mark?: boolean;
}

export type JsonCompareRow =
  | {
    type: "node";
    node: JsonCompareNode;
    form: "leaf" | "open" | "closed" | "close";
    depth: number;
    /** Null where the node is missing on that side. */
    before: JsonComparePiece[] | null;
    after: JsonComparePiece[] | null;
  }
  | { type: "run"; id: string; depth: number; nodes: JsonCompareNode[]; label: string };

export interface JsonCompareRowOptions {
  /** Whether a container path or a run id is open. */
  isOpen: (key: string) => boolean;
  /** Fold runs of two or more unchanged siblings into one row. */
  collapseUnchanged: boolean;
}

function foldable(node: JsonCompareNode): boolean {
  return node.children.length > 0;
}

/**
 * Container paths open in the first view. Collapsing unchanged opens every
 * container that holds a change; otherwise containers open breadth-first while
 * the rows stay within the budget.
 */
export function jsonComparisonOpenPaths(root: JsonCompareNode, collapseUnchanged: boolean, budget = JSON_COMPARE_FIRST_VIEW_ROWS): Set<string> {
  const open = new Set<string>();
  if (collapseUnchanged) {
    // A container opens when something inside it changed; a moved but unchanged item stays folded.
    const visit = (node: JsonCompareNode): void => {
      if (!foldable(node) || !node.children.some((child) => child.changedWithin)) return;
      open.add(node.path);
      node.children.forEach(visit);
    };
    visit(root);
    if (foldable(root)) open.add(root.path);
    return open;
  }
  let visible = 1;
  let level = [root];
  while (level.length > 0) {
    const next: JsonCompareNode[] = [];
    for (const node of level) {
      if (!foldable(node)) continue;
      const added = node.children.length + 1;
      if (node !== root && visible + added > budget) continue;
      visible += added;
      open.add(node.path);
      next.push(...node.children);
    }
    level = next;
  }
  return open;
}

function compact(node: JsonSourceNode): string {
  if (node.kind === "object") return `{${node.entries.map((entry) => `${entry.rawKey}: ${compact(entry.value)}`).join(", ")}}`;
  if (node.kind === "array") return `[${node.items.map(compact).join(", ")}]`;
  return scalarText(node);
}

function valueRole(node: JsonSourceNode): JsonComparePiece["role"] {
  if (node.kind === "string" || node.kind === "number") return node.kind;
  return node.kind === "object" || node.kind === "array" ? "punct" : "literal";
}

function markedPieces(text: string, role: JsonComparePiece["role"], ranges: readonly JsonTextRange[]): JsonComparePiece[] {
  const pieces: JsonComparePiece[] = [];
  let at = 0;
  for (const [start, end] of ranges) {
    if (start > at) pieces.push({ text: text.slice(at, start), role });
    pieces.push({ text: text.slice(start, end), role, mark: true });
    at = end;
  }
  if (at < text.length) pieces.push({ text: text.slice(at), role });
  return pieces;
}

function countLabel(node: JsonSourceNode): string {
  if (node.kind === "object") return `${node.entries.length} ${node.entries.length === 1 ? "key" : "keys"}`;
  if (node.kind === "array") return `${node.items.length} ${node.items.length === 1 ? "item" : "items"}`;
  return "";
}

function brackets(node: JsonSourceNode): [string, string] {
  return node.kind === "object" ? ["{", "}"] : ["[", "]"];
}

/** One side of a row: key, value or bracket, comma, and any note. */
function sidePieces(row: { node: JsonCompareNode; form: "leaf" | "open" | "closed" | "close" }, side: "before" | "after", comma: boolean): JsonComparePiece[] | null {
  const { node, form } = row;
  const value = node[side];
  if (value === null) return null;
  const key = side === "before" ? node.beforeKey : node.afterKey;
  const pieces: JsonComparePiece[] = [];
  if (form !== "close" && typeof key === "string") pieces.push({ text: key, role: "key" }, { text: ": ", role: "punct" });
  const [open, close] = brackets(value);
  if (form === "open") pieces.push({ text: open, role: "punct" });
  else if (form === "close") pieces.push({ text: close, role: "punct" });
  else if (form === "closed") pieces.push({ text: `${open} … ${close}`, role: "punct" });
  else if (node.kind === "type-changed") pieces.push({ text: compact(value), role: valueRole(value) });
  else pieces.push(...markedPieces(compact(value), valueRole(value), node.marks?.[side] ?? []));
  if (comma && form !== "open") pieces.push({ text: ",", role: "punct" });
  if (form === "closed") pieces.push({ text: countLabel(value), role: "count" });
  if (side === "after" && form !== "close") {
    if (node.kind === "type-changed" && node.before !== null) pieces.push({ text: `${node.before.kind} → ${value.kind}`, role: "note" });
    if (node.movedFrom !== undefined) pieces.push({ text: `moved from [${node.movedFrom}]`, role: "note" });
  }
  return pieces;
}

/** The unchanged runs among siblings that fold into one row, sparing the sibling next to a change. */
function unchangedRuns(children: readonly JsonCompareNode[]): Map<number, number> {
  const runs = new Map<number, number>();
  let start = 0;
  while (start < children.length) {
    if ((children[start] as JsonCompareNode).changedWithin) { start += 1; continue; }
    let end = start;
    while (end < children.length && !(children[end] as JsonCompareNode).changedWithin) end += 1;
    const from = start > 0 ? start + 1 : start;
    const to = end < children.length ? end - 1 : end;
    if (to - from >= 2) runs.set(from, to);
    start = end;
  }
  return runs;
}

/** Rows in display order for both sides of a comparison. */
export function jsonComparisonRows(root: JsonCompareNode, options: JsonCompareRowOptions): JsonCompareRow[] {
  const rows: JsonCompareRow[] = [];
  const push = (node: JsonCompareNode, form: "leaf" | "open" | "closed" | "close", depth: number, commas: [boolean, boolean]): void => {
    rows.push({ type: "node", node, form, depth, before: sidePieces({ node, form }, "before", commas[0]), after: sidePieces({ node, form }, "after", commas[1]) });
  };
  const visit = (node: JsonCompareNode, depth: number, commas: [boolean, boolean]): void => {
    if (!foldable(node) || node.kind === "type-changed") { push(node, "leaf", depth, commas); return; }
    if (!options.isOpen(node.path)) { push(node, "closed", depth, commas); return; }
    push(node, "open", depth, commas);
    const { children } = node;
    const lastBefore = children.findLastIndex((child) => child.before !== null);
    const lastAfter = children.findLastIndex((child) => child.after !== null);
    const runs = options.collapseUnchanged ? unchangedRuns(children) : new Map<number, number>();
    const objectish = (node.after ?? node.before)?.kind === "object";
    for (let index = 0; index < children.length; index += 1) {
      const child = children[index] as JsonCompareNode;
      const end = runs.get(index);
      const id = `run:${child.path}`;
      if (end !== undefined && !options.isOpen(id)) {
        const nodes = children.slice(index, end);
        rows.push({ type: "run", id, depth: depth + 1, nodes, label: `${nodes.length} unchanged ${objectish ? "keys" : "items"}` });
        index = end - 1;
        continue;
      }
      visit(child, depth + 1, [index < lastBefore, index < lastAfter]);
    }
    push(node, "close", depth, commas);
  };
  visit(root, 0, [false, false]);
  return rows;
}

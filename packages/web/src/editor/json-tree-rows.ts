/** The rows a JSON tree shows, derived from parsed source and the reader's fold choices. */
import { jsonPathStep } from "@uberblick/schema";
import type { JsonSourceNode } from "@uberblick/schema";

/** The first view opens containers breadth-first while this many rows fit. */
export const FIRST_VIEW_ROWS = 20;
/** Longer arrays fold into groups of this many items. */
export const GROUP_SIZE = 100;
/** Rows built per "Show more" step. */
export const ROW_PAGE = 2000;

export type JsonTreeItem =
  /** `rawKey` is an object key as written, quotes and escapes included. */
  | { type: "value"; path: string; key: string | number | null; rawKey?: string; node: JsonSourceNode }
  | { type: "group"; path: string; node: Extract<JsonSourceNode, { kind: "array" }>; start: number; end: number };

export type JsonTreeRow =
  | { form: "leaf" | "closed"; item: JsonTreeItem; depth: number; comma: boolean }
  | { form: "open"; item: JsonTreeItem; depth: number }
  | { form: "close"; item: JsonTreeItem; depth: number; comma: boolean }
  | { form: "more"; depth: number };

export function rootItem(node: JsonSourceNode): JsonTreeItem {
  return { type: "value", path: "", key: null, node };
}

/** Whether an item can fold: a non-empty object or array, or a group. */
export function foldable(item: JsonTreeItem): boolean {
  if (item.type === "group") return true;
  return item.node.kind === "object" ? item.node.entries.length > 0 : item.node.kind === "array" && item.node.items.length > 0;
}

function itemChildren(path: string, node: Extract<JsonSourceNode, { kind: "array" }>, start: number, end: number): JsonTreeItem[] {
  return node.items.slice(start, end).map((child, offset) => ({
    type: "value", path: `${path}${jsonPathStep(start + offset)}`, key: start + offset, node: child,
  }));
}

/** An item's children; a repeated key gets a `#n` suffix so its fold state stays its own. */
export function children(item: JsonTreeItem): JsonTreeItem[] {
  if (item.type === "group") return itemChildren(item.path.slice(0, item.path.lastIndexOf("[")), item.node, item.start, item.end);
  const { node, path } = item;
  if (node.kind === "object") {
    const seen = new Map<string, number>();
    return node.entries.map((entry) => {
      const count = (seen.get(entry.key) ?? 0) + 1;
      seen.set(entry.key, count);
      return { type: "value", path: `${path}${jsonPathStep(entry.key)}${count > 1 ? `#${count}` : ""}`, key: entry.key, rawKey: entry.rawKey, node: entry.value };
    });
  }
  if (node.kind !== "array") return [];
  if (node.items.length <= GROUP_SIZE) return itemChildren(path, node, 0, node.items.length);
  const groups: JsonTreeItem[] = [];
  for (let start = 0; start < node.items.length; start += GROUP_SIZE) {
    const end = Math.min(node.items.length, start + GROUP_SIZE);
    groups.push({ type: "group", path: `${path}[${start}…${end - 1}]`, node, start, end });
  }
  return groups;
}

/**
 * Open the root, then containers breadth-first while the visible rows stay
 * within the budget. The root opens even when its children alone exceed it.
 */
export function firstView(root: JsonTreeItem, budget = FIRST_VIEW_ROWS): Set<string> {
  const open = new Set<string>();
  if (!foldable(root)) return open;
  let visible = 1;
  let level = [root];
  while (level.length > 0) {
    const next: JsonTreeItem[] = [];
    for (const item of level) {
      // Opening any container adds at least two rows.
      if (visible + 2 > budget && item !== root) break;
      if (!foldable(item)) continue;
      const kids = children(item);
      const added = kids.length + 1;
      if (item !== root && visible + added > budget) continue;
      visible += added;
      open.add(item.path);
      next.push(...kids);
    }
    level = next;
  }
  return open;
}

/** Every foldable path in an item's subtree, the item included. */
export function subtreePaths(item: JsonTreeItem): string[] {
  if (!foldable(item)) return [];
  return [item.path, ...children(item).flatMap(subtreePaths)];
}

/** Rows in display order, stopping with a "more" row once `limit` rows are built. */
export function jsonTreeRows(root: JsonTreeItem, isOpen: (path: string) => boolean, limit = ROW_PAGE): JsonTreeRow[] {
  const rows: JsonTreeRow[] = [];
  let full = false;
  const visit = (item: JsonTreeItem, depth: number, comma: boolean): void => {
    if (full) return;
    if (rows.length >= limit) { rows.push({ form: "more", depth }); full = true; return; }
    if (!foldable(item)) { rows.push({ form: "leaf", item, depth, comma }); return; }
    if (!isOpen(item.path)) { rows.push({ form: "closed", item, depth, comma }); return; }
    rows.push({ form: "open", item, depth });
    const kids = children(item);
    kids.forEach((child, index) => { visit(child, depth + 1, index < kids.length - 1); });
    if (!full) rows.push({ form: "close", item, depth, comma });
  };
  visit(root, 0, false);
  return rows;
}

/** "3 keys", "1 item": what a folded container holds. */
export function itemCount(item: JsonTreeItem): string {
  if (item.type === "group") return `${item.end - item.start} items`;
  const { node } = item;
  if (node.kind === "object") return `${node.entries.length} ${node.entries.length === 1 ? "key" : "keys"}`;
  if (node.kind === "array") return `${node.items.length} ${node.items.length === 1 ? "item" : "items"}`;
  return "";
}

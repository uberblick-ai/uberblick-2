/** UUID-only curation in a synced room; sidebar writes never alter documents. */

import type * as Y from "yjs";
import type { SidebarGroup } from "./types.js";

export const SIDEBAR_GROUPS_KEY = "groups";

export const SIDEBAR_ORDER_KEY = "order";

export const SIDEBAR_UNPINNED_KEY = "unpinned";

export const SIDEBAR_FLAGS_KEY = "flags";

/** A persistent seed guard independent of whether the sidebar is empty. */
const SEEDED_FLAG = "seeded";

const PINS_PREFIX = "pins:";

const NAME_ID_PREFIX = "name:";

const CLIENT_SEPARATOR = "#";

/** One stored pin: a document uuid, and the unpin level it was pinned under. */
interface Pin {
  uuid: string;
  since: number;
}

/** Concurrent names resolve by Yjs key order without replacing any pins. */
export function getSidebarGroups(sidebarDoc: Y.Doc): Y.Map<string> {
  return sidebarDoc.getMap<string>(SIDEBAR_GROUPS_KEY);
}

/** Order stores plain ids so delete/insert moves never clone pin containers. */
export function getSidebarOrder(sidebarDoc: Y.Doc): Y.Array<string> {
  return sidebarDoc.getArray<string>(SIDEBAR_ORDER_KEY);
}

/**
 * `<uuid>#<clientID>` counters have one writer each and only increase; reads
 * take their maximum. Never delete or compact keys that their owners may write.
 * Storage grows by one entry per document/client that unpins it.
 */
export function getSidebarUnpinned(sidebarDoc: Y.Doc): Y.Map<number> {
  return sidebarDoc.getMap<number>(SIDEBAR_UNPINNED_KEY);
}

/** Flags only become true; clearing one would race concurrent seeding. */
export function getSidebarFlags(sidebarDoc: Y.Doc): Y.Map<boolean> {
  return sidebarDoc.getMap<boolean>(SIDEBAR_FLAGS_KEY);
}

export function isSidebarSeeded(sidebarDoc: Y.Doc): boolean {
  return getSidebarFlags(sidebarDoc).get(SEEDED_FLAG) === true;
}

/**
 * Set once so deliberately emptying the sidebar cannot trigger another seed.
 * Offline seeders must still use shared ids: neither may see the other's flag.
 */
export function markSidebarSeeded(sidebarDoc: Y.Doc): void {
  getSidebarFlags(sidebarDoc).set(SEEDED_FLAG, true);
}

/** Missing groups make writes no-ops: concurrent group deletion is ordinary. */
function groupName(sidebarDoc: Y.Doc, groupId: string): string | null {
  const name = getSidebarGroups(sidebarDoc).get(groupId);
  return typeof name === "string" ? name : null;
}

/**
 * Named top-level arrays merge independent group creates; competing nested
 * maps would replace a whole pin container. Yjs creates this array on access.
 * Top-level arrays cannot be removed, even after their group is deleted.
 */
function pinsOfGroup(sidebarDoc: Y.Doc, groupId: string): Y.Array<Pin> {
  return sidebarDoc.getArray<Pin>(`${PINS_PREFIX}${groupId}`);
}

/** Pins are plain values so moves can reinsert them without cloning Y types. */
function readPin(value: unknown): Pin | null {
  if (typeof value !== "object" || value === null) return null;
  const candidate = value as Partial<Pin>;
  if (typeof candidate.uuid !== "string" || candidate.uuid === "") return null;
  const since = typeof candidate.since === "number" ? candidate.since : 0;
  return { uuid: candidate.uuid, since };
}

function unpinLevels(sidebarDoc: Y.Doc): Map<string, number> {
  const levels = new Map<string, number>();
  for (const [key, value] of getSidebarUnpinned(sidebarDoc).entries()) {
    const separator = key.lastIndexOf(CLIENT_SEPARATOR);
    if (separator <= 0 || typeof value !== "number") continue;
    const uuid = key.slice(0, separator);
    if (value > (levels.get(uuid) ?? 0)) levels.set(uuid, value);
  }
  return levels;
}

/** An unseen counter contributes zero; a deliberate pin may equal the level. */
function unpinLevel(sidebarDoc: Y.Doc, uuid: string): number {
  return unpinLevels(sidebarDoc).get(uuid) ?? 0;
}

/** Group ids in stored order: known groups only, first occurrence wins. */
function orderedGroupIds(sidebarDoc: Y.Doc): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const id of getSidebarOrder(sidebarDoc).toArray()) {
    if (typeof id !== "string" || seen.has(id)) continue;
    if (groupName(sidebarDoc, id) === null) continue;
    seen.add(id);
    out.push(id);
  }
  return out;
}

function clampIndex(index: number | undefined, length: number): number {
  if (index === undefined || !Number.isFinite(index)) return length;
  return Math.min(Math.max(Math.trunc(index), 0), length);
}

/** Delete every occurrence of `value`, back to front so indexes stay valid. */
function removeAll(array: Y.Array<string>, value: string): void {
  const items = array.toArray();
  for (let i = items.length - 1; i >= 0; i -= 1) {
    if (items[i] === value) array.delete(i, 1);
  }
}

function allPinLists(sidebarDoc: Y.Doc): Y.Array<Pin>[] {
  return orderedGroupIds(sidebarDoc).map((id) => pinsOfGroup(sidebarDoc, id));
}

/** Remove every pin of `uuid`, hidden ones included. The caller transacts. */
function removePinEverywhere(sidebarDoc: Y.Doc, uuid: string): void {
  for (const pins of allPinLists(sidebarDoc)) {
    const items = pins.toArray();
    for (let i = items.length - 1; i >= 0; i -= 1) {
      if (readPin(items[i])?.uuid === uuid) pins.delete(i, 1);
    }
  }
}

/**
 * The pin that makes `uuid` read as pinned — the first in traversal order whose
 * `since` still clears the document's unpin level — or null.
 */
function visiblePin(sidebarDoc: Y.Doc, uuid: string): Pin | null {
  const level = unpinLevel(sidebarDoc, uuid);
  for (const pins of allPinLists(sidebarDoc)) {
    for (const item of pins.toArray()) {
      const pin = readPin(item);
      if (pin !== null && pin.uuid === uuid && pin.since >= level) return pin;
    }
  }
  return null;
}

/**
 * A pin can arrive before the counter that justified its stamp. Clear both
 * the visible stamps and the observed level so every visible pin is hidden.
 */
function unpinCeiling(sidebarDoc: Y.Doc, uuid: string): number {
  const level = unpinLevel(sidebarDoc, uuid);
  let ceiling = level;
  for (const pins of allPinLists(sidebarDoc)) {
    for (const item of pins.toArray()) {
      const pin = readPin(item);
      if (pin === null || pin.uuid !== uuid) continue;
      if (pin.since >= level && pin.since > ceiling) ceiling = pin.since;
    }
  }
  return ceiling;
}

/**
 * Shared caller-supplied ids merge offline creates into one group with both
 * sets of pins. Repeating an id asserts its name without moving or clearing it.
 */
export function createGroup(
  sidebarDoc: Y.Doc,
  name: string,
  index?: number,
  id: string = crypto.randomUUID(),
): string {
  sidebarDoc.transact(() => {
    getSidebarGroups(sidebarDoc).set(id, name);
    const order = getSidebarOrder(sidebarDoc);
    // Concurrent creates can insert duplicate ids; reads dedupe and moves clear them.
    if (!order.toArray().includes(id)) {
      order.insert(clampIndex(index, order.length), [id]);
    }
  });
  return id;
}

/**
 * Name-derived ids merge offline creates. If a renamed group occupies the id,
 * generated fallback ids can leave duplicate names, while retaining both pins.
 */
export function getOrCreateGroup(
  sidebarDoc: Y.Doc,
  name: string,
  index?: number,
): string {
  for (const id of orderedGroupIds(sidebarDoc)) {
    if (groupName(sidebarDoc, id) === name) return id;
  }
  const derived = `${NAME_ID_PREFIX}${name}`;
  const free = groupName(sidebarDoc, derived) === null;
  return createGroup(
    sidebarDoc,
    name,
    index,
    free ? derived : crypto.randomUUID(),
  );
}

export function renameGroup(
  sidebarDoc: Y.Doc,
  groupId: string,
  name: string,
): void {
  if (groupName(sidebarDoc, groupId) === null) return;
  getSidebarGroups(sidebarDoc).set(groupId, name);
}

/**
 * Empty the permanent array without touching documents. Unseen concurrent
 * pins survive invisibly and resurface if the exact group id is created again.
 */
export function deleteGroup(sidebarDoc: Y.Doc, groupId: string): void {
  if (groupName(sidebarDoc, groupId) === null) return;
  sidebarDoc.transact(() => {
    getSidebarGroups(sidebarDoc).delete(groupId);
    removeAll(getSidebarOrder(sidebarDoc), groupId);
    const pins = pinsOfGroup(sidebarDoc, groupId);
    pins.delete(0, pins.length);
  });
}

/**
 * An already visible pin makes this a no-op. A deliberate re-pin removes stale
 * copies and stamps the observed level; equality wins over observed unpins.
 */
export function pinDoc(
  sidebarDoc: Y.Doc,
  groupId: string,
  uuid: string,
  index?: number,
): void {
  if (groupName(sidebarDoc, groupId) === null) return;
  if (visiblePin(sidebarDoc, uuid) !== null) return;
  const pins = pinsOfGroup(sidebarDoc, groupId);
  const since = unpinLevel(sidebarDoc, uuid);
  sidebarDoc.transact(() => {
    removePinEverywhere(sidebarDoc, uuid);
    pins.insert(clampIndex(index, pins.length), [{ uuid, since }]);
  });
}

/**
 * An unpin beats a concurrent move: raise the counter beyond visible stamps,
 * since deleting visible pins alone cannot suppress the move's unseen insert.
 */
export function unpinDoc(sidebarDoc: Y.Doc, uuid: string): void {
  if (visiblePin(sidebarDoc, uuid) === null) return;
  raiseUnpin(sidebarDoc, uuid);
}

/**
 * Archiving asserts an unpin even with no visible pin, hiding unseen pins at
 * or below the observed level. A pin stamped at or above the raised counter can
 * still surface; a deliberate re-pin after observing the unpin also wins.
 */
export function unpinDocIncludingUnseen(sidebarDoc: Y.Doc, uuid: string): void {
  raiseUnpin(sidebarDoc, uuid);
}

/** Only this client writes its counter; it is never cleared on re-pin. */
function raiseUnpin(sidebarDoc: Y.Doc, uuid: string): void {
  const next = unpinCeiling(sidebarDoc, uuid) + 1;
  const key = `${uuid}${CLIENT_SEPARATOR}${sidebarDoc.clientID}`;
  sidebarDoc.transact(() => {
    removePinEverywhere(sidebarDoc, uuid);
    getSidebarUnpinned(sidebarDoc).set(key, next);
  });
}

/**
 * Only move visible pins, carrying their stamp so a move cannot undo an unpin.
 * The target index is measured after removing the pin, including hidden copies.
 */
export function moveDoc(
  sidebarDoc: Y.Doc,
  uuid: string,
  toGroupId: string,
  index?: number,
): void {
  if (groupName(sidebarDoc, toGroupId) === null) return;
  const moving = visiblePin(sidebarDoc, uuid);
  if (moving === null) return;
  const pins = pinsOfGroup(sidebarDoc, toGroupId);
  sidebarDoc.transact(() => {
    removePinEverywhere(sidebarDoc, uuid);
    pins.insert(clampIndex(index, pins.length), [moving]);
  });
}

export function moveGroup(
  sidebarDoc: Y.Doc,
  groupId: string,
  index?: number,
): void {
  if (groupName(sidebarDoc, groupId) === null) return;
  sidebarDoc.transact(() => {
    const order = getSidebarOrder(sidebarDoc);
    removeAll(order, groupId);
    order.insert(clampIndex(index, order.length), [groupId]);
  });
}

/**
 * Stored traversal order determines the first visible pin per uuid, including
 * concurrent moves. This is a positional winner, never recency or title order.
 * Successful pin/move/unpin writes clear shadowed copies in current groups.
 */
export function readSidebar(sidebarDoc: Y.Doc): SidebarGroup[] {
  const levels = unpinLevels(sidebarDoc);
  const seen = new Set<string>();
  const out: SidebarGroup[] = [];
  for (const id of orderedGroupIds(sidebarDoc)) {
    const name = groupName(sidebarDoc, id);
    if (name === null) continue;
    const docs: string[] = [];
    for (const item of pinsOfGroup(sidebarDoc, id).toArray()) {
      const pin = readPin(item);
      if (pin === null || seen.has(pin.uuid)) continue;
      if (pin.since < (levels.get(pin.uuid) ?? 0)) continue;
      seen.add(pin.uuid);
      docs.push(pin.uuid);
    }
    out.push({ id, name, docs });
  }
  return out;
}

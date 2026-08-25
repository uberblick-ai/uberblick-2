/**
 * The sidebar document.
 *
 * The sidebar is explicit curation, not a view of the directory: one Y.Doc per
 * workspace, in the well-known room `<workspaceId>/_sidebar` (see `rooms.ts`),
 * holding an ordered list of named groups, each holding an ordered list of
 * pinned document UUIDs. It is an ordinary synced document — logged, hydrated
 * offline and merged like every other room.
 *
 * It stores UUIDs and nothing else. No title, no path, no content: a group is a
 * list of references, so nothing here can change, hide or delete a document.
 * Unpinning and deleting a group are sidebar-only acts.
 *
 * Layout — two top-level keys, deliberately:
 *   - `groups` Y.Map: groupId → Y.Map { name: string, docs: Y.Array<uuid> }
 *   - `order`  Y.Array<groupId>: the group order
 *
 * The order is an array of *ids*, not of the groups themselves, because Yjs has
 * no move: reordering is delete-then-insert. Moving a string id rewrites
 * nothing, whereas moving a group whose array element held its own pins would
 * mean cloning that element — and a pin another replica made into it
 * concurrently would be dropped along with the original. Pins are plain uuid
 * strings for the same reason.
 *
 * Convergence, all of it a consequence of Yjs array semantics rather than of
 * any rule of ours:
 *
 *   - **One pin per document, enforced on read.** Two replicas pinning the same
 *     uuid into two groups both integrate, so storage holds two pins. Yjs
 *     orders those inserts identically everywhere, so `readSidebar` keeping the
 *     first occurrence in stored order — the block-id dedupe of `blocks.ts` —
 *     yields the same single pin on every replica. Every write here removes
 *     *all* occurrences of a uuid before inserting, so the duplicate clears on
 *     the next move or unpin; there is nothing to repair in the meantime.
 *
 *   - **A document moved by two replicas lands in one place: the
 *     last-integrated position wins, never both.** A move is a delete plus an
 *     insert; the deletes commute, both inserts survive, and read-side dedupe
 *     picks one — so the loser's pin is shadowed, not duplicated.
 *
 *   - **A move concurrent with an unpin keeps the document pinned.** The unpin
 *     deletes the pin its replica could see; the move inserted one it never
 *     saw, and a delete does not reach forward. That is the contract, pinned by
 *     `sidebar.test.ts` — it is Yjs, not a preference, and it is the same shape
 *     as the directory's rename-races-archive outcome.
 *
 * Ordering is stored, never computed: `readSidebar` returns groups and pins in
 * exactly the order the arrays hold. Nothing in this module sorts by title.
 *
 * Every operation naming a group id the sidebar does not hold does nothing. A
 * group can always be deleted concurrently, so a throw here would fire on
 * ordinary merges rather than on caller mistakes.
 */

import * as Y from "yjs";
import type { SidebarGroup } from "./types.js";

/** The key of the sidebar's groupId → group Y.Map. */
export const SIDEBAR_GROUPS_KEY = "groups";

/** The key of the sidebar's group-order Y.Array. */
export const SIDEBAR_ORDER_KEY = "order";

const NAME_KEY = "name";
const DOCS_KEY = "docs";

/** The groupId → group map inside a sidebar doc. */
export function getSidebarGroups(sidebarDoc: Y.Doc): Y.Map<unknown> {
  return sidebarDoc.getMap<unknown>(SIDEBAR_GROUPS_KEY);
}

/** The group-order array inside a sidebar doc. */
export function getSidebarOrder(sidebarDoc: Y.Doc): Y.Array<string> {
  return sidebarDoc.getArray<string>(SIDEBAR_ORDER_KEY);
}

function groupById(sidebarDoc: Y.Doc, groupId: string): Y.Map<unknown> | null {
  const group = getSidebarGroups(sidebarDoc).get(groupId);
  return group instanceof Y.Map ? (group as Y.Map<unknown>) : null;
}

function pinsOf(group: Y.Map<unknown>): Y.Array<string> | null {
  const docs = group.get(DOCS_KEY);
  return docs instanceof Y.Array ? (docs as Y.Array<string>) : null;
}

function nameOf(group: Y.Map<unknown>): string {
  const name = group.get(NAME_KEY);
  return typeof name === "string" ? name : "";
}

/** Group ids in stored order: known groups only, first occurrence wins. */
function orderedGroupIds(sidebarDoc: Y.Doc): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const id of getSidebarOrder(sidebarDoc).toArray()) {
    if (typeof id !== "string" || seen.has(id)) continue;
    if (groupById(sidebarDoc, id) === null) continue;
    seen.add(id);
    out.push(id);
  }
  return out;
}

/** `index` clamped into an array of `length`; undefined means append. */
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

/** Every group's pin array, in stored order. */
function allPinLists(sidebarDoc: Y.Doc): Y.Array<string>[] {
  const out: Y.Array<string>[] = [];
  for (const id of orderedGroupIds(sidebarDoc)) {
    const group = groupById(sidebarDoc, id);
    const pins = group === null ? null : pinsOf(group);
    if (pins !== null) out.push(pins);
  }
  return out;
}

/** Remove `uuid` from every group. The caller supplies the transaction. */
function removePinEverywhere(sidebarDoc: Y.Doc, uuid: string): void {
  for (const pins of allPinLists(sidebarDoc)) removeAll(pins, uuid);
}

/** True when `uuid` is pinned in any group. */
function isPinned(sidebarDoc: Y.Doc, uuid: string): boolean {
  return allPinLists(sidebarDoc).some((pins) =>
    pins.toArray().includes(uuid),
  );
}

/** Add an empty group at `index` (default: last) and return its generated id. */
export function createGroup(
  sidebarDoc: Y.Doc,
  name: string,
  index?: number,
): string {
  const id = crypto.randomUUID();
  sidebarDoc.transact(() => {
    const group = new Y.Map<unknown>();
    getSidebarGroups(sidebarDoc).set(id, group);
    group.set(NAME_KEY, name);
    group.set(DOCS_KEY, new Y.Array<string>());
    const order = getSidebarOrder(sidebarDoc);
    order.insert(clampIndex(index, order.length), [id]);
  });
  return id;
}

/** Rename a group, keeping its id and its pins. */
export function renameGroup(
  sidebarDoc: Y.Doc,
  groupId: string,
  name: string,
): void {
  groupById(sidebarDoc, groupId)?.set(NAME_KEY, name);
}

/**
 * Delete a group. Its pins go with it — the documents themselves are untouched,
 * because the sidebar only ever held their uuids.
 */
export function deleteGroup(sidebarDoc: Y.Doc, groupId: string): void {
  if (groupById(sidebarDoc, groupId) === null) return;
  sidebarDoc.transact(() => {
    getSidebarGroups(sidebarDoc).delete(groupId);
    removeAll(getSidebarOrder(sidebarDoc), groupId);
  });
}

/**
 * Pin a document into a group at `index` (default: last).
 *
 * One pin per document across the whole sidebar: pinning a uuid that is already
 * pinned anywhere does nothing, even into another group. Moving it is
 * {@link moveDoc}.
 */
export function pinDoc(
  sidebarDoc: Y.Doc,
  groupId: string,
  uuid: string,
  index?: number,
): void {
  const group = groupById(sidebarDoc, groupId);
  const pins = group === null ? null : pinsOf(group);
  if (pins === null || isPinned(sidebarDoc, uuid)) return;
  pins.insert(clampIndex(index, pins.length), [uuid]);
}

/** Unpin a document, wherever it sits. The document itself is untouched. */
export function unpinDoc(sidebarDoc: Y.Doc, uuid: string): void {
  if (!isPinned(sidebarDoc, uuid)) return;
  sidebarDoc.transact(() => {
    removePinEverywhere(sidebarDoc, uuid);
  });
}

/**
 * Move a document to `index` in `toGroupId` — within its group or across
 * groups. `index` counts positions in the target group *after* the document has
 * been taken out of it. A uuid that was not pinned is simply pinned.
 */
export function moveDoc(
  sidebarDoc: Y.Doc,
  uuid: string,
  toGroupId: string,
  index?: number,
): void {
  const group = groupById(sidebarDoc, toGroupId);
  const pins = group === null ? null : pinsOf(group);
  if (pins === null) return;
  sidebarDoc.transact(() => {
    removePinEverywhere(sidebarDoc, uuid);
    pins.insert(clampIndex(index, pins.length), [uuid]);
  });
}

/** Move a group to `index` in the sidebar, keeping its id, name and pins. */
export function moveGroup(
  sidebarDoc: Y.Doc,
  groupId: string,
  index?: number,
): void {
  if (groupById(sidebarDoc, groupId) === null) return;
  sidebarDoc.transact(() => {
    const order = getSidebarOrder(sidebarDoc);
    removeAll(order, groupId);
    order.insert(clampIndex(index, order.length), [groupId]);
  });
}

/**
 * The sidebar in stored order, with the one-pin-per-document rule applied: a
 * uuid appearing more than once keeps its first occurrence, which is the same
 * occurrence on every replica. Nothing is sorted.
 */
export function readSidebar(sidebarDoc: Y.Doc): SidebarGroup[] {
  const pinned = new Set<string>();
  const out: SidebarGroup[] = [];
  for (const id of orderedGroupIds(sidebarDoc)) {
    const group = groupById(sidebarDoc, id);
    if (group === null) continue;
    const docs: string[] = [];
    for (const uuid of pinsOf(group)?.toArray() ?? []) {
      if (typeof uuid !== "string" || pinned.has(uuid)) continue;
      pinned.add(uuid);
      docs.push(uuid);
    }
    out.push({ id, name: nameOf(group), docs });
  }
  return out;
}

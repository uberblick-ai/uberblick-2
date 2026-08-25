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
 * Layout — three top-level keys, deliberately:
 *   - `groups`   Y.Map: groupId → Y.Map { name: string, docs: Y.Array<uuid> }
 *   - `order`    Y.Array<groupId>: the group order
 *   - `unpinned` Y.Map: uuid → true, an unpin tombstone (see below)
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
 *   - **A document moved by two replicas lands in one place: the first
 *     occurrence in stored traversal order wins, never both.** A move is a
 *     delete plus an insert; the deletes commute and both inserts survive, so
 *     storage does hold the uuid twice. Read-side dedupe then keeps the earlier
 *     of the two — groups in sidebar order, pins in group order — and that is
 *     the same one on every replica. Nothing here is a recency rule: the winner
 *     is a position, not a timestamp, so the destination a replica sees does
 *     not depend on which move it made or integrated last. The shadowed copy
 *     clears on the next write touching that uuid.
 *
 *   - **An unpin beats a move it raced: the document ends up unpinned.** This
 *     one is a decision, not a gift from Yjs, and Yjs on its own gives the
 *     opposite: the unpin deletes the pin its own replica could see, the move
 *     inserts a pin the unpin never saw, and a delete does not reach forward —
 *     so the losing insert would survive as a live pin. The `unpinned` map is
 *     what buys the decided behaviour. `unpinDoc` records the uuid there, and
 *     `readSidebar` hides every pin of a recorded uuid, so the orphaned insert
 *     is shadowed rather than honoured. Enforced on read, like the single-pin
 *     rule and for the same reason: a read-side rule needs no agreement between
 *     replicas to reach the same answer on each of them.
 *
 *   - **A deliberate re-pin beats an older unpin.** `pinDoc` clears the
 *     tombstone and sweeps away any shadowed pins of that uuid before
 *     inserting, so re-pinning is a clean start rather than a fight with the
 *     document's own history. "Older" is causal, not chronological: a re-pin
 *     that has seen the tombstone removes it, while a re-pin *concurrent* with
 *     an unpin loses, because Yjs keeps a concurrent `set` over a `delete`
 *     whichever order they are made in. That happens to point the same way as
 *     the decision, so the rule holds without a counter or a clock.
 *
 *     The tombstone stays honest through one invariant: it is written only for
 *     a document that is visibly pinned, and cleared only by a replica that can
 *     already see it. Nothing outside this module may write that map.
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

/** The key of the sidebar's unpin-tombstone Y.Map. */
export const SIDEBAR_UNPINNED_KEY = "unpinned";

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

/**
 * The unpin tombstones inside a sidebar doc: uuid → true.
 *
 * An entry means "hide every pin of this uuid". Only {@link unpinDoc} writes
 * one and only {@link pinDoc} clears one; see the module header for why that
 * invariant is what makes the map safe.
 */
export function getSidebarUnpinned(sidebarDoc: Y.Doc): Y.Map<boolean> {
  return sidebarDoc.getMap<boolean>(SIDEBAR_UNPINNED_KEY);
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

/**
 * True when `uuid` reads as pinned — the same view {@link readSidebar} gives.
 * A tombstoned uuid is not pinned however many shadowed pins storage still
 * holds for it.
 */
function isVisiblyPinned(sidebarDoc: Y.Doc, uuid: string): boolean {
  if (getSidebarUnpinned(sidebarDoc).has(uuid)) return false;
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
 *
 * This is the only way back from an unpin, and it is deliberate about it: the
 * tombstone is cleared and any pins it was shadowing are swept away first, so
 * the document lands exactly where this call puts it rather than wherever a
 * race left it.
 */
export function pinDoc(
  sidebarDoc: Y.Doc,
  groupId: string,
  uuid: string,
  index?: number,
): void {
  const group = groupById(sidebarDoc, groupId);
  const pins = group === null ? null : pinsOf(group);
  if (pins === null || isVisiblyPinned(sidebarDoc, uuid)) return;
  sidebarDoc.transact(() => {
    getSidebarUnpinned(sidebarDoc).delete(uuid);
    removePinEverywhere(sidebarDoc, uuid);
    pins.insert(clampIndex(index, pins.length), [uuid]);
  });
}

/**
 * Unpin a document, wherever it sits. The document itself is untouched.
 *
 * Removing the pins is not enough on its own — a move made concurrently on
 * another replica would reinstate one — so this also records a tombstone that
 * hides the uuid until someone pins it again. See the module header.
 */
export function unpinDoc(sidebarDoc: Y.Doc, uuid: string): void {
  if (!isVisiblyPinned(sidebarDoc, uuid)) return;
  sidebarDoc.transact(() => {
    removePinEverywhere(sidebarDoc, uuid);
    getSidebarUnpinned(sidebarDoc).set(uuid, true);
  });
}

/**
 * Move a document to `index` in `toGroupId` — within its group or across
 * groups. `index` counts positions in the target group *after* the document has
 * been taken out of it.
 *
 * Moving only ever moves a pin that is there: a uuid that does not read as
 * pinned is left alone rather than pinned. Pinning is {@link pinDoc}, which is
 * where the deliberate re-pin of an unpinned document belongs — keeping the two
 * apart is what stops a move from quietly overriding an unpin.
 */
export function moveDoc(
  sidebarDoc: Y.Doc,
  uuid: string,
  toGroupId: string,
  index?: number,
): void {
  const group = groupById(sidebarDoc, toGroupId);
  const pins = group === null ? null : pinsOf(group);
  if (pins === null || !isVisiblyPinned(sidebarDoc, uuid)) return;
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
 * The sidebar in stored order, with both read-side rules applied: a uuid
 * carrying an unpin tombstone is hidden entirely, and a uuid appearing more
 * than once keeps its first occurrence — the same occurrence on every replica.
 * Nothing is sorted.
 */
export function readSidebar(sidebarDoc: Y.Doc): SidebarGroup[] {
  const unpinned = getSidebarUnpinned(sidebarDoc);
  const pinned = new Set<string>();
  const out: SidebarGroup[] = [];
  for (const id of orderedGroupIds(sidebarDoc)) {
    const group = groupById(sidebarDoc, id);
    if (group === null) continue;
    const docs: string[] = [];
    for (const uuid of pinsOf(group)?.toArray() ?? []) {
      if (typeof uuid !== "string" || pinned.has(uuid)) continue;
      if (unpinned.has(uuid)) continue;
      pinned.add(uuid);
      docs.push(uuid);
    }
    out.push({ id, name: nameOf(group), docs });
  }
  return out;
}

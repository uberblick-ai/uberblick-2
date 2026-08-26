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
 * Layout — four top-level keys, deliberately:
 *   - `groups`   Y.Map: groupId → Y.Map { name: string, docs: Y.Array<Pin> }
 *   - `order`    Y.Array<groupId>: the group order
 *   - `unpinned` Y.Map: `<uuid>#<clientID>` → number, unpin counters (below)
 *   - `flags`    Y.Map: set-once booleans about the sidebar itself (below)
 *
 * A `Pin` is a plain `{ uuid, since }` object, never a nested Y type.
 *
 * The order is an array of *ids*, not of the groups themselves, because Yjs has
 * no move: reordering is delete-then-insert. Moving a plain value rewrites
 * nothing, whereas moving a group whose array element held its own pins would
 * mean cloning that element — and a pin another replica made into it
 * concurrently would be dropped along with the original. Pins are plain objects
 * for the same reason.
 *
 * ## Convergence
 *
 * Two rules are enforced on read, which is what lets replicas agree without
 * agreeing on anything first — each computes the same answer from the same
 * state.
 *
 *   - **One pin per document.** Two replicas pinning the same uuid into two
 *     groups both integrate, so storage holds two pins. `readSidebar` keeps the
 *     first occurrence in stored traversal order — groups in sidebar order,
 *     pins in group order, the block-id dedupe of `blocks.ts` — and that is the
 *     same occurrence on every replica. Every write removes *all* occurrences
 *     of a uuid before inserting, so the shadowed copy clears on the next move
 *     or unpin; there is nothing to repair in the meantime.
 *
 *   - **A document moved by two replicas lands in one place: the first
 *     occurrence in stored traversal order wins, never both.** A move is a
 *     delete plus an insert; the deletes commute and both inserts survive, so
 *     storage does hold the uuid twice, and the same dedupe picks one. Nothing
 *     here is a recency rule: the winner is a position, not a timestamp, so the
 *     destination does not depend on which move was made or integrated last.
 *
 * ## Unpinning: counters, never a tombstone that gets deleted
 *
 * An unpin has to beat a move that raced it (owner decision), and removing the
 * pins cannot do that on its own: the unpin deletes the pin its own replica
 * could see, the move inserts one the unpin never saw, and a delete does not
 * reach forward, so the move's insert would survive as a live pin.
 *
 * So every pin records the unpin level it was made under, and `unpinned` counts
 * unpins:
 *
 *   - `unpinLevel(uuid)` is the **maximum** over every `<uuid>#<clientID>`
 *     entry, 0 when there are none.
 *   - A pin is visible iff `pin.since >= unpinLevel(pin.uuid)`.
 *   - `unpinDoc` writes **to its own client's key** one more than the highest
 *     stamp it can actually see — the unpin level, or a visible pin's `since`
 *     if that is higher — so every pin this replica can see is hidden. Counting
 *     from the level alone is not enough: updates from different clients arrive
 *     in no guaranteed order, so a replica can hold a pin stamped above its own
 *     level and would otherwise write a number that pin already clears.
 *   - `pinDoc` stamps the new pin with the level it can see, so the pin is
 *     visible again — a deliberate re-pin beats the unpins it has seen.
 *   - `moveDoc` carries the existing pin's `since` across unchanged. Moving is
 *     not re-pinning, and must not silently clear an unpin.
 *
 * Two properties make this sound, and both are deliberate:
 *
 *   - **Nothing is ever deleted from `unpinned`, and no key is ever written by
 *     more than one replica.** A concurrent set and delete of one Y.Map key
 *     resolves by clientID order — a coin flip, not a rule — so a design that
 *     needed one to win would converge to different answers on different
 *     machines. Keying by client removes the race instead of betting on it: the
 *     only writer of `<uuid>#<clientID>` is that client, and it only ever
 *     raises its own number. Taking the max on read is what merges them.
 *
 *   - **Equal counters mean pinned.** When an unpin and a re-pin are made
 *     concurrently from the same level, both produce the same number, the pin's
 *     `since` equals the level, and the document reads as pinned. That is a
 *     genuine tie between two deliberate acts that never saw each other, and it
 *     is resolved by a rule rather than by whoever's clientID sorts lower. The
 *     decided case — an unpin racing a *move*, which carries an older `since` —
 *     is not a tie, and the unpin wins it.
 *
 * The counters only grow, one entry per (document, client that unpinned it).
 * Compacting them would mean deleting keys their owners may concurrently write,
 * which is the race this design exists to avoid, so they are left alone.
 *
 * Ordering is stored, never computed: `readSidebar` returns groups and pins in
 * exactly the order the arrays hold. Nothing in this module sorts by title.
 *
 * Every operation naming a group id the sidebar does not hold does nothing. A
 * group can always be deleted concurrently, so a throw here would fire on
 * ordinary merges rather than on caller mistakes.
 *
 * ## Flags: set once, never cleared
 *
 * `flags` answers questions about the sidebar that its contents cannot — the
 * one there is being {@link isSidebarSeeded}, whether the one-time migration
 * that built a sidebar out of the old tag grouping has already run. Emptiness
 * cannot answer it: a sidebar deliberately emptied would be migrated again, and
 * the delete would not stick.
 *
 * A flag is only ever set, and only ever to `true`. That is what makes it
 * convergent without a rule: two replicas setting one key to the same value
 * agree however Yjs orders them, whereas a flag that could be cleared would be
 * the concurrent set-and-delete this module refuses everywhere else.
 *
 * A migration guarded by a flag still has to survive being run twice — two
 * offline replicas can each seed before either sees the other's flag — so it
 * writes with ids of its own choosing rather than generated ones (see
 * {@link createGroup}), and the two runs merge into one sidebar instead of two.
 *
 * The boundary of that trick, stated because sharing an id is not the same as
 * merging: a group is a nested Y.Map stored under its id, and two concurrent
 * creates of one id are two writes of one key, so one map wins whole and the
 * loser's `docs` — every pin in it — goes with it. Two runs that wrote the same
 * pins lose nothing, which is the migration's case: both sides read the same
 * directory and produce the same groups. Two replicas creating one group from
 * *different* state do lose one side's pins, silently. Repairing that is a
 * layout change — {@link https://github.com/uberblick-ai/uberblick-2/issues/210}
 * — not something a caller can work around, so a caller choosing an id should
 * be choosing it for content both sides agree on.
 */

import * as Y from "yjs";
import type { SidebarGroup } from "./types.js";

/** The key of the sidebar's groupId → group Y.Map. */
export const SIDEBAR_GROUPS_KEY = "groups";

/** The key of the sidebar's group-order Y.Array. */
export const SIDEBAR_ORDER_KEY = "order";

/** The key of the sidebar's unpin-counter Y.Map. */
export const SIDEBAR_UNPINNED_KEY = "unpinned";

/** The key of the sidebar's set-once flag Y.Map. */
export const SIDEBAR_FLAGS_KEY = "flags";

/** The flag recording that the one-time tag-group migration has run. */
const SEEDED_FLAG = "seeded";

const NAME_KEY = "name";
const DOCS_KEY = "docs";

/** Separates the uuid from the client id in an `unpinned` key. */
const CLIENT_SEPARATOR = "#";

/** One stored pin: a document uuid, and the unpin level it was pinned under. */
interface Pin {
  uuid: string;
  since: number;
}

/** The groupId → group map inside a sidebar doc. */
export function getSidebarGroups(sidebarDoc: Y.Doc): Y.Map<unknown> {
  return sidebarDoc.getMap<unknown>(SIDEBAR_GROUPS_KEY);
}

/** The group-order array inside a sidebar doc. */
export function getSidebarOrder(sidebarDoc: Y.Doc): Y.Array<string> {
  return sidebarDoc.getArray<string>(SIDEBAR_ORDER_KEY);
}

/**
 * The unpin counters inside a sidebar doc: `<uuid>#<clientID>` → count.
 *
 * A document's unpin level is the maximum over its entries. Only
 * {@link unpinDoc} writes here, only ever to its own client's key, and nothing
 * ever deletes one — see the module header for why that matters.
 */
export function getSidebarUnpinned(sidebarDoc: Y.Doc): Y.Map<number> {
  return sidebarDoc.getMap<number>(SIDEBAR_UNPINNED_KEY);
}

/** The set-once flags inside a sidebar doc. See the header. */
export function getSidebarFlags(sidebarDoc: Y.Doc): Y.Map<boolean> {
  return sidebarDoc.getMap<boolean>(SIDEBAR_FLAGS_KEY);
}

/** Whether the one-time migration out of tag grouping has already run. */
export function isSidebarSeeded(sidebarDoc: Y.Doc): boolean {
  return getSidebarFlags(sidebarDoc).get(SEEDED_FLAG) === true;
}

/**
 * Record that the one-time migration has run. Set once, never cleared: a
 * sidebar emptied down to nothing stays migrated, which is the whole point.
 */
export function markSidebarSeeded(sidebarDoc: Y.Doc): void {
  getSidebarFlags(sidebarDoc).set(SEEDED_FLAG, true);
}

function groupById(sidebarDoc: Y.Doc, groupId: string): Y.Map<unknown> | null {
  const group = getSidebarGroups(sidebarDoc).get(groupId);
  return group instanceof Y.Map ? (group as Y.Map<unknown>) : null;
}

function pinsOf(group: Y.Map<unknown>): Y.Array<Pin> | null {
  const docs = group.get(DOCS_KEY);
  return docs instanceof Y.Array ? (docs as Y.Array<Pin>) : null;
}

function nameOf(group: Y.Map<unknown>): string {
  const name = group.get(NAME_KEY);
  return typeof name === "string" ? name : "";
}

/** A stored pin, or null when the value is not one. */
function readPin(value: unknown): Pin | null {
  if (typeof value !== "object" || value === null) return null;
  const candidate = value as Partial<Pin>;
  if (typeof candidate.uuid !== "string" || candidate.uuid === "") return null;
  const since = typeof candidate.since === "number" ? candidate.since : 0;
  return { uuid: candidate.uuid, since };
}

/** Every document's unpin level, in one pass over the counters. */
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

/** How often `uuid` has been unpinned, as the highest replica's count. */
function unpinLevel(sidebarDoc: Y.Doc, uuid: string): number {
  return unpinLevels(sidebarDoc).get(uuid) ?? 0;
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
function allPinLists(sidebarDoc: Y.Doc): Y.Array<Pin>[] {
  const out: Y.Array<Pin>[] = [];
  for (const id of orderedGroupIds(sidebarDoc)) {
    const group = groupById(sidebarDoc, id);
    const pins = group === null ? null : pinsOf(group);
    if (pins !== null) out.push(pins);
  }
  return out;
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
 * The level an unpin of `uuid` has to clear: the document's unpin level, and
 * the stamp of every pin that currently reads as visible.
 *
 * The two can disagree. Updates from different clients arrive in no guaranteed
 * order, so a replica can hold a pin stamped `since: 2` while the counter that
 * justified it — written by some third client — has not arrived, leaving the
 * level at 0. Counting from the level alone would write 1, which that pin
 * already clears, and the unpin would be silently lost the moment the pin was
 * moved or the missing counter turned up. Counting from what is actually
 * visible cannot be fooled that way: whatever a replica can see, it can hide.
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
 * Add an empty group at `index` (default: last) and return its id.
 *
 * `id` defaults to a generated one, which is what an ordinary create wants. A
 * caller passes one when two replicas may make the *same* group independently —
 * the one-time migration does, because a generated id would give each replica
 * its own copy of every group, and a merge would show both. With one id they
 * write the same group instead, and it merges into one.
 */
export function createGroup(
  sidebarDoc: Y.Doc,
  name: string,
  index?: number,
  id: string = crypto.randomUUID(),
): string {
  sidebarDoc.transact(() => {
    const group = new Y.Map<unknown>();
    getSidebarGroups(sidebarDoc).set(id, group);
    group.set(NAME_KEY, name);
    group.set(DOCS_KEY, new Y.Array<Pin>());
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
 * This is also the way back from an unpin, and it is deliberate about it: the
 * new pin is stamped with the unpin level this replica can see, so it clears
 * every unpin it knows about, and any older pins are swept away first — the
 * document lands where this call puts it rather than wherever a race left it.
 */
export function pinDoc(
  sidebarDoc: Y.Doc,
  groupId: string,
  uuid: string,
  index?: number,
): void {
  const group = groupById(sidebarDoc, groupId);
  const pins = group === null ? null : pinsOf(group);
  if (pins === null || visiblePin(sidebarDoc, uuid) !== null) return;
  const since = unpinLevel(sidebarDoc, uuid);
  sidebarDoc.transact(() => {
    removePinEverywhere(sidebarDoc, uuid);
    pins.insert(clampIndex(index, pins.length), [{ uuid, since }]);
  });
}

/**
 * Unpin a document, wherever it sits. The document itself is untouched.
 *
 * Removing the pins is not enough on its own — a move made concurrently on
 * another replica would reinstate one — so this also raises this client's unpin
 * counter past every pin this replica can currently see, which is a stronger
 * bar than the unpin level alone. See {@link unpinCeiling} and the header.
 */
export function unpinDoc(sidebarDoc: Y.Doc, uuid: string): void {
  if (visiblePin(sidebarDoc, uuid) === null) return;
  const next = unpinCeiling(sidebarDoc, uuid) + 1;
  const key = `${uuid}${CLIENT_SEPARATOR}${sidebarDoc.clientID}`;
  sidebarDoc.transact(() => {
    removePinEverywhere(sidebarDoc, uuid);
    getSidebarUnpinned(sidebarDoc).set(key, next);
  });
}

/**
 * Move a document to `index` in `toGroupId` — within its group or across
 * groups. `index` counts positions in the target group *after* the document has
 * been taken out of it.
 *
 * Moving only ever moves a pin that is there: a uuid that does not read as
 * pinned is left alone rather than pinned, and the pin keeps the unpin level it
 * was made under. Pinning is {@link pinDoc}, which is where the deliberate
 * re-pin of an unpinned document belongs — keeping the two apart is what stops
 * a move from quietly overriding an unpin.
 */
export function moveDoc(
  sidebarDoc: Y.Doc,
  uuid: string,
  toGroupId: string,
  index?: number,
): void {
  const group = groupById(sidebarDoc, toGroupId);
  const pins = group === null ? null : pinsOf(group);
  const moving = pins === null ? null : visiblePin(sidebarDoc, uuid);
  if (pins === null || moving === null) return;
  sidebarDoc.transact(() => {
    removePinEverywhere(sidebarDoc, uuid);
    pins.insert(clampIndex(index, pins.length), [moving]);
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
 * The sidebar in stored order, with both read-side rules applied: a pin whose
 * `since` no longer clears its document's unpin level is hidden, and a uuid
 * appearing more than once keeps its first visible occurrence — the same
 * occurrence on every replica. Nothing is sorted.
 */
export function readSidebar(sidebarDoc: Y.Doc): SidebarGroup[] {
  const levels = unpinLevels(sidebarDoc);
  const seen = new Set<string>();
  const out: SidebarGroup[] = [];
  for (const id of orderedGroupIds(sidebarDoc)) {
    const group = groupById(sidebarDoc, id);
    if (group === null) continue;
    const docs: string[] = [];
    for (const item of pinsOf(group)?.toArray() ?? []) {
      const pin = readPin(item);
      if (pin === null || seen.has(pin.uuid)) continue;
      if (pin.since < (levels.get(pin.uuid) ?? 0)) continue;
      seen.add(pin.uuid);
      docs.push(pin.uuid);
    }
    out.push({ id, name: nameOf(group), docs });
  }
  return out;
}

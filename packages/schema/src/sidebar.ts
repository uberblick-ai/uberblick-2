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
 * Layout — four fixed top-level keys, plus one array per group:
 *   - `groups`    Y.Map: groupId → name, the group's only field
 *   - `order`     Y.Array<groupId>: the group order
 *   - `unpinned`  Y.Map: `<uuid>#<clientID>` → number, unpin counters (below)
 *   - `flags`     Y.Map: set-once booleans about the sidebar itself (below)
 *   - `pins:<id>` Y.Array<Pin>: one group's pins, a top-level type of its own
 *
 * A `Pin` is a plain `{ uuid, since }` object, never a nested Y type.
 *
 * A group's pins live in a *top-level* array named after the group rather than
 * in a nested one stored under its id, and that is what makes creating a group
 * convergent. A nested type has to be created by somebody: `groups.set(id, new
 * Y.Map())` on two replicas is two writes of one key, so one map wins whole and
 * every pin the loser held goes with it, silently. A top-level type is created
 * by *name* — Yjs hands the same array to whoever asks for `pins:<groupId>`, on
 * every replica, whether or not anyone has written to it — so two offline
 * replicas can each create one group and pin into it, and the merge keeps both
 * pins. A group is then a name in `groups`, an id in `order` and an array
 * reached by name: three writes that merge, none that replaces.
 *
 * Two replicas creating one group under *different* names still resolve that
 * one key by clientID, and deliberately so: a name is a string both sides can
 * see and correct, not a container holding somebody's pins.
 *
 * That layout replaced an earlier one — a group was a `Y.Map` under its id,
 * holding `name` and `docs` — and a document written that way reads as *empty*
 * here, because a group's name has to be a string. {@link
 * migrateLegacySidebar} converts such a document in place, keeping ids, names
 * and pins; it runs at MCP server start and is the one place in this module
 * that knows the old shape.
 *
 * The cost is that a top-level type cannot be removed. {@link deleteGroup}
 * empties the array instead, so a long-lived sidebar carries one spent array
 * per group ever deleted — a handful of empty arrays, in exchange for never
 * losing a pin. Emptying is not removal in the concurrent case, either: a pin
 * another replica made into the group while it was being deleted integrates
 * after the delete and stays in the array, invisible while no group carries
 * the id, and back in the sidebar if that exact id is created again — routine
 * once ids are derived from names ({@link getOrCreateGroup}). A pin
 * *resurfaces*; none is lost. Whether that wants a generation stamp on pins or
 * a record of spent ids is decided with the wiring, in
 * {@link https://github.com/uberblick-ai/uberblick-2/issues/306}.
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
 * Sharing an id is enough because a group's fields merge rather than replace
 * each other — the name is a string, the pins are an array Yjs hands out by
 * name — so two runs built from *different* state converge on one group holding
 * both sides' pins. A caller that addresses groups by name rather than by id
 * gets the same guarantee from {@link getOrCreateGroup}, which derives the id
 * from the name so that two replicas naming one group write one group.
 *
 * A group with a well-known id — the seeded ones — is the same rule with the
 * constant supplied instead of derived: whoever recreates "Start here" by name
 * writes the id the seed wrote, so a group that came back under a name comes
 * back under its identity too, and id-based references still find it. Passing
 * that constant is the caller's job, because the ids belong to what seeded them
 * rather than to the layout.
 */

// A value import, for one reason: {@link migrateLegacySidebar} recognises a
// group written under the earlier layout by its type. Nothing here constructs a
// Y type — creating one under a key is the loss this layout exists to avoid.
import * as Y from "yjs";
import type { SidebarGroup } from "./types.js";

/** The key of the sidebar's groupId → name Y.Map. */
export const SIDEBAR_GROUPS_KEY = "groups";

/** The key of the sidebar's group-order Y.Array. */
export const SIDEBAR_ORDER_KEY = "order";

/** The key of the sidebar's unpin-counter Y.Map. */
export const SIDEBAR_UNPINNED_KEY = "unpinned";

/** The key of the sidebar's set-once flag Y.Map. */
export const SIDEBAR_FLAGS_KEY = "flags";

/** The flag recording that the one-time tag-group migration has run. */
const SEEDED_FLAG = "seeded";

/** Prefixes the top-level array holding one group's pins. */
const PINS_PREFIX = "pins:";

/** Prefixes the id {@link getOrCreateGroup} derives from a group's name. */
const NAME_ID_PREFIX = "name:";

/** Separates the uuid from the client id in an `unpinned` key. */
const CLIENT_SEPARATOR = "#";

/** One stored pin: a document uuid, and the unpin level it was pinned under. */
interface Pin {
  uuid: string;
  since: number;
}

/** The groupId → name map inside a sidebar doc. A group's only field. */
export function getSidebarGroups(sidebarDoc: Y.Doc): Y.Map<string> {
  return sidebarDoc.getMap<string>(SIDEBAR_GROUPS_KEY);
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

/** A group's name, or null when the sidebar holds no such group. */
function groupName(sidebarDoc: Y.Doc, groupId: string): string | null {
  const name = getSidebarGroups(sidebarDoc).get(groupId);
  return typeof name === "string" ? name : null;
}

/**
 * One group's pins, as a top-level array named after the group.
 *
 * Reached by name and never stored under a key, which is what lets two replicas
 * create one group without either side's pins being replaced — see the header.
 * The array exists as soon as it is asked for, on every replica, so this needs
 * no create step and cannot return null.
 */
function pinsOfGroup(sidebarDoc: Y.Doc, groupId: string): Y.Array<Pin> {
  return sidebarDoc.getArray<Pin>(`${PINS_PREFIX}${groupId}`);
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
    if (groupName(sidebarDoc, id) === null) continue;
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
 * write the same group, and the two creates merge into one holding both sides'
 * pins: the name is a plain string and the pins are a top-level array reached
 * by name, so nothing here replaces anything (see the header).
 *
 * Creating a group that is already there is therefore not an error and not a
 * duplicate: it asserts the name and leaves the position and the pins alone.
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
    // The local repeat only: a replica creating this group concurrently cannot
    // see this entry and inserts its own, which `orderedGroupIds` dedupes on
    // read and the next `moveGroup` clears out of storage.
    if (!order.toArray().includes(id)) {
      order.insert(clampIndex(index, order.length), [id]);
    }
  });
  return id;
}

/**
 * The id of the group called `name`, creating it at `index` (default: last) if
 * no group carries that name — for callers that address groups by name.
 *
 * The created id is derived from the name, so two replicas that each create
 * "Reading" while out of contact write one group rather than two, and the merge
 * holds both sides' pins. Where the derived id is already taken by a group that
 * has since been renamed, this falls back to a generated id: two replicas can
 * then still end up with two same-named groups, which is visible and repairable
 * — the loss this trades away was neither.
 *
 * `wellKnownId` is the id to create the group under when the caller has a
 * constant for this name — the seeded groups do. Recreating one of those by
 * name then converges on the id the seed wrote and other things reference,
 * rather than on a fresh one that reads the same and matches nothing.
 */
export function getOrCreateGroup(
  sidebarDoc: Y.Doc,
  name: string,
  index?: number,
  wellKnownId?: string,
): string {
  for (const id of orderedGroupIds(sidebarDoc)) {
    if (groupName(sidebarDoc, id) === name) return id;
  }
  // Free means the *key* is unused, not that a name can be read from it: a
  // group written under the earlier layout has no readable name, and creating
  // over its key would replace the map holding its pins — deleting them, which
  // is the loss this module exists to prevent. See migrateLegacySidebar.
  const taken = (id: string): boolean =>
    getSidebarGroups(sidebarDoc).get(id) !== undefined;
  const preferred =
    wellKnownId !== undefined && !taken(wellKnownId)
      ? wellKnownId
      : `${NAME_ID_PREFIX}${name}`;
  return createGroup(
    sidebarDoc,
    name,
    index,
    taken(preferred) ? crypto.randomUUID() : preferred,
  );
}

/** Rename a group, keeping its id and its pins. */
export function renameGroup(
  sidebarDoc: Y.Doc,
  groupId: string,
  name: string,
): void {
  if (groupName(sidebarDoc, groupId) === null) return;
  getSidebarGroups(sidebarDoc).set(groupId, name);
}

/**
 * Delete a group. Its pins go with it — the documents themselves are untouched,
 * because the sidebar only ever held their uuids.
 *
 * The group's array is emptied rather than removed, because a top-level type
 * cannot be removed — and emptying reaches only the pins this replica can see.
 * A pin another replica made into the group concurrently integrates after the
 * delete, survives in the array, and is back in the sidebar if that id is
 * created again. See the header and
 * {@link https://github.com/uberblick-ai/uberblick-2/issues/306}.
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
  if (groupName(sidebarDoc, toGroupId) === null) return;
  const moving = visiblePin(sidebarDoc, uuid);
  if (moving === null) return;
  const pins = pinsOfGroup(sidebarDoc, toGroupId);
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
  if (groupName(sidebarDoc, groupId) === null) return;
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

/**
 * Rewrite groups written under the earlier layout into this one, keeping their
 * ids, their names and their pins. Returns how many were converted.
 *
 * Before the layout above, a group was a `Y.Map` stored under its id, holding
 * `name` and a `docs` array of the same plain pins. This module reads a group's
 * name as a string, so such a group is skipped on read and a sidebar full of
 * them reads as empty — every group and every pin present in the document and
 * invisible in every client. That is what happened to the live workspaces on
 * 2026-08-27
 * ({@link https://github.com/uberblick-ai/uberblick-2/issues/350}); this is the
 * repair, and it reads the old shape in exactly one place so nothing else has
 * to know two layouts.
 *
 * Safe to run on any sidebar, at any time, on every replica:
 *
 *   - **Idempotent.** A converted sidebar holds no `Y.Map` under a group id, so
 *     a second run writes nothing at all.
 *   - **Convergent.** Two replicas converting the same sidebar write the same
 *     name (one string, both sides equal) and the same pins into the same
 *     top-level array. Both sets of pins integrate, so a uuid can be stored
 *     twice — which `readSidebar` already dedupes to its first occurrence in
 *     stored order, the same occurrence on both, and the next write of that
 *     document sweeps the shadowed copy. Nothing is lost and nothing needs
 *     coordinating.
 *   - **Additive.** Pins already in `pins:<id>` are kept, keep their place, and
 *     are never duplicated: the legacy pins follow them, in their own order. A
 *     group half-rebuilt by hand after the break keeps what was rebuilt.
 *
 * Three boundaries, stated rather than handled:
 *
 *   - A legacy group whose `name` is not a string is left alone. It has nothing
 *     this layout could call a group, and inventing one would put a made-up
 *     name in somebody's sidebar.
 *   - A legacy group missing from `order` is converted and counted, and stays
 *     invisible until something places it — exactly what happens to a
 *     current-layout group missing from `order`. Converting it costs nothing
 *     and keeps its pins reachable the moment it is placed.
 *   - A pin written into the old nested map by a **pre-#305 replica** after the
 *     conversion integrates into a map that no longer exists, so it is
 *     unreachable. Such a replica is a browser session that has been open since
 *     before that release: reload every one of them before deploying this, and
 *     the window closes. Nothing already written is at risk — only a write made
 *     from a stale tab afterwards.
 */
export function migrateLegacySidebar(sidebarDoc: Y.Doc): number {
  const groups = getSidebarGroups(sidebarDoc);
  const legacy: [string, Y.Map<unknown>][] = [];
  // Read as unknown: this map's declared value type is the *current* layout's
  // name, and what is being looked for is precisely a value that is not one.
  for (const [id, value] of groups.entries() as IterableIterator<
    [string, unknown]
  >) {
    if (value instanceof Y.Map) legacy.push([id, value]);
  }
  if (legacy.length === 0) return 0;

  // One transaction, so a converted sidebar reaches every other replica whole:
  // never a name without the pins that belong to it.
  let converted = 0;
  sidebarDoc.transact(() => {
    for (const [id, group] of legacy) {
      const name = group.get("name");
      if (typeof name !== "string") continue;
      const pins = pinsOfGroup(sidebarDoc, id);
      const held = new Set(
        pins.toArray().map((item) => readPin(item)?.uuid ?? ""),
      );
      const docs = group.get("docs");
      const carried: Pin[] = [];
      for (const item of docs instanceof Y.Array ? docs.toArray() : []) {
        const pin = readPin(item);
        if (pin === null || held.has(pin.uuid)) continue;
        held.add(pin.uuid);
        carried.push(pin);
      }
      if (carried.length > 0) pins.insert(pins.length, carried);
      // Last: the pins are read out of the old map before this replaces it.
      groups.set(id, name);
      converted += 1;
    }
  });
  return converted;
}

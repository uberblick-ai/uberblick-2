/**
 * Changed-block marks: which blocks somebody else edited while you were not
 * looking.
 *
 * ## Session-local and ephemeral, deliberately
 *
 * Nothing here is written to the Y.Doc, to the IndexedDB replica or to
 * localStorage. The marks live in a plain Map held against the open document's
 * Y.Doc, so closing the tab, reloading the page or reopening the document
 * starts you with a clean slate — there is no read-state to migrate and none to
 * get wrong. That is the whole scope of #120: this says "you have not read this
 * yet", not "here is what changed since version 4". Versioning, diffs and a
 * read-state that survives a reload are a later, separate stage.
 *
 * ## What counts as somebody else
 *
 * `Y.Transaction.local` is false exactly when the change arrived as an encoded
 * update from elsewhere — the hub, a relayed peer, the local replica — and true
 * when this replica produced it. So your own typing never marks: y-prosemirror
 * writes it into the Y.Doc inside a local transaction. Neither does anything
 * else this client does to the document (a comment anchor, a re-type, a title
 * edit) — that is the same rule rather than a list of exceptions, which is why
 * the rule is worth having.
 *
 * ## Why the document arriving is not a change, and why that is a state
 *
 * Hydration is also "an update from elsewhere": the IndexedDB replay and the
 * hub's first sync both land as remote transactions carrying the whole
 * document. Recording those would paint every block the moment you opened a
 * document, which is noise, not news.
 *
 * The suppression is therefore a **state**, not an order of events. A tracker
 * records nothing until the document has *arrived*, and it has arrived when
 * both of these are true:
 *
 * - the local replica has finished replaying (`whenLocalReplicaLoaded`), and
 * - the provider has completed a sync, **if it is connected at all**.
 *
 * Both hydration payloads are applied to the Y.Doc before the signal that
 * announces them, so whichever order the two arrive in, they land while the
 * tracker is still deaf — which is why nothing has to be un-marked afterwards.
 * An earlier version wiped the set on the first sync instead, and that was
 * wrong in both directions: a hub-then-replica open left the replay marked, and
 * an offline open had its genuine catch-up erased by the sync that finally
 * arrived.
 *
 * The `connected` clause is what makes the offline case work. A disconnected
 * provider owes this reader nothing, so the replica alone completes the
 * arrival; when the hub does turn up later, everything it brings is a change
 * made while the reader was away, and marking it is the entire point.
 *
 * ## Why subscribers are notified late
 *
 * Listeners run on a microtask, never inside the Yjs transaction that marked
 * the block. A subscriber that dispatched a ProseMirror transaction from inside
 * a Yjs observer would run y-prosemirror's ProseMirror→Yjs diff against a
 * document ProseMirror has not re-rendered yet, and that diff writes the stale
 * content back over the remote change — data loss, not a redraw glitch. The set
 * itself is updated synchronously; only the telling waits.
 */

import * as Y from "yjs";
import { getBlocksFragment } from "@uberblick/schema";
import type { RoomConnection, RoomStatus } from "../collab/rooms.js";

/** The marked blocks of one document, and the ways they are marked and cleared. */
export interface ChangedBlocks {
  /**
   * The marked blocks, each with the generation it was last changed at. A block
   * changed *again* while it was already marked gets a new generation, which is
   * how a reader's part-finished look at it is invalidated.
   */
  touched(): ReadonlyMap<string, number>;
  has(id: string): boolean;
  /**
   * Bumped on every change to the set — the cache key for anything derived from
   * it, so a derived value can be kept rather than recomputed per keystroke.
   */
  generation(): number;
  /** Begin recording. Idempotent; nothing is recorded before it is called. */
  start(): void;
  /** This block has been read. */
  clear(id: string): void;
  /** Returns the unsubscribe. Listeners are called on a microtask — see above. */
  subscribe(listener: () => void): () => void;
}

/**
 * A tracker over one document's `blocks` fragment. Starts stopped.
 *
 * There is no teardown: the deep observer belongs to the fragment, which
 * belongs to the Y.Doc, so both are collected with the document the room owns.
 */
export function trackChangedBlocks(ydoc: Y.Doc): ChangedBlocks {
  const fragment = getBlocksFragment(ydoc);
  const marked = new Map<string, number>();
  const listeners = new Set<() => void>();
  let generation = 0;
  let recording = false;
  let queued = false;

  const notify = (): void => {
    if (queued) return;
    queued = true;
    // A resolved promise rather than `queueMicrotask`, so a test running on
    // faked timers still gets its listeners.
    void Promise.resolve().then(() => {
      queued = false;
      for (const listener of [...listeners]) listener();
    });
  };

  /** The id of the top-level block an event happened in, or `undefined`. */
  const blockOfEvent = (path: Array<string | number>): unknown => {
    const index = path[0];
    if (typeof index !== "number") return undefined;
    const block = fragment.get(index);
    return block instanceof Y.XmlElement ? block.getAttribute("id") : undefined;
  };

  /**
   * Drop marks for blocks the document no longer has. Returns whether any went.
   *
   * Called only when a remote transaction removed something, which is rare
   * enough to afford reading the block ids — and identifying the deleted
   * element from the event itself would mean reading attributes off a type Yjs
   * has already tombstoned.
   */
  const pruneDeleted = (): boolean => {
    if (marked.size === 0) return false;
    const live = new Set<string>();
    for (const child of fragment.toArray()) {
      if (!(child instanceof Y.XmlElement)) continue;
      const id = child.getAttribute("id");
      if (typeof id === "string") live.add(id);
    }
    let dropped = false;
    for (const id of [...marked.keys()]) {
      if (live.has(id)) continue;
      marked.delete(id);
      dropped = true;
    }
    return dropped;
  };

  const record = (
    events: Array<Y.YEvent<Y.AbstractType<unknown>>>,
    transaction: Y.Transaction,
  ): void => {
    if (!recording || transaction.local) return;
    const touched = new Set<string>();
    let removed = false;
    const add = (id: unknown): void => {
      if (typeof id === "string" && id !== "") touched.add(id);
    };
    for (const event of events) {
      if (event.path.length === 0) {
        // The fragment itself: blocks arriving or leaving.
        for (const change of event.changes.delta) {
          if (typeof change.delete === "number" && change.delete > 0) {
            removed = true;
          }
          if (!Array.isArray(change.insert)) continue;
          for (const child of change.insert) {
            if (child instanceof Y.XmlElement) add(child.getAttribute("id"));
          }
        }
        continue;
      }
      // Anything deeper — the block's text, its marks, its attributes — is a
      // change to the block the path starts at.
      add(blockOfEvent(event.path));
    }
    if (touched.size === 0 && !removed) return;

    // One generation per remote transaction, stamped on every block it touched:
    // a block marked again is a block the reader has *not* read, whatever they
    // were part-way through.
    const next = generation + 1;
    for (const id of touched) marked.set(id, next);
    // After the marking, not before: a block this transaction both edited and
    // deleted is deleted, whatever the earlier event said.
    //
    // A block somebody else deleted is the last news that block will ever
    // carry. Nothing remains to read, so no amount of looking could clear the
    // mark, and a mark that cannot clear is a mark that outlives its meaning.
    // A *local* deletion is a different case and is deliberately left alone:
    // the reader can undo it, and the block — and its mark — come back.
    const pruned = removed ? pruneDeleted() : false;
    if (touched.size === 0 && !pruned) return;
    generation = next;
    notify();
  };
  fragment.observeDeep(record);

  return {
    touched: () => marked,
    has: (id) => marked.has(id),
    generation: () => generation,
    start: () => {
      recording = true;
    },
    clear: (id) => {
      if (!marked.delete(id)) return;
      generation += 1;
      notify();
    },
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}

const trackers = new WeakMap<Y.Doc, ChangedBlocks>();

/**
 * The tracker for a document, created on first ask. Keyed by the Y.Doc so the
 * editor's decorations and the outline's dots are reading one set — and so a
 * fresh Y.Doc (a reload, a reopened room) is a fresh, empty one.
 */
export function changedBlocksFor(ydoc: Y.Doc): ChangedBlocks {
  const existing = trackers.get(ydoc);
  if (existing !== undefined) return existing;
  const created = trackChangedBlocks(ydoc);
  trackers.set(ydoc, created);
  return created;
}

const armed = new WeakSet<Y.Doc>();

/**
 * The tracker for a connection's document, started once the document has
 * arrived — see "Why the document arriving is not a change" above. Wired once
 * per document, however many components ask for it.
 */
export function changedBlocks(connection: RoomConnection): ChangedBlocks {
  const marks = changedBlocksFor(connection.ydoc);
  if (armed.has(connection.ydoc)) return marks;
  armed.add(connection.ydoc);

  let replicaSettled = false;
  let syncedOnce = false;
  let recording = false;
  let unwatchStatus: (() => void) | null = null;

  /**
   * Stop listening to the room's status. Called the moment the document has
   * arrived: after that the listener answers the same question the same way on
   * every reconnect for the life of the room, and the room's own teardown
   * (`acquireRoom`'s release) would be the only thing left to drop it.
   */
  const stopWatchingStatus = (): void => {
    unwatchStatus?.();
    unwatchStatus = null;
  };

  /** Both conditions, re-asked on every signal — never an order of arrival. */
  const openIfArrived = (status: RoomStatus): void => {
    if (recording || !replicaSettled) return;
    // A connected provider still owes this reader the hub's copy of the
    // document. A disconnected one owes nothing, and waiting on a sync that may
    // never come would mean an offline session marked nothing, ever.
    if (status.connected && !syncedOnce) return;
    recording = true;
    marks.start();
    stopWatchingStatus();
  };

  void connection.whenLocalReplicaLoaded.then(() => {
    replicaSettled = true;
    openIfArrived(connection.status);
  });

  unwatchStatus = connection.onStatusChange((status) => {
    if (status.synced) syncedOnce = true;
    openIfArrived(status);
  });
  // `onStatusChange` calls its listener once, synchronously, before handing
  // back the unsubscribe — so a room that had already arrived by then could not
  // have unsubscribed itself above.
  if (recording) stopWatchingStatus();

  return marks;
}

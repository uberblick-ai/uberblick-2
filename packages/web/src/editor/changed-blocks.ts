/**
 * Changed-block marks: which blocks somebody else edited while you were not
 * looking.
 *
 * ## Session-local and ephemeral, deliberately
 *
 * Nothing here is written to the Y.Doc, to the IndexedDB replica or to
 * localStorage. The marks live in a plain Set held against the open document's
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
 * ## Why the document arriving is not a change
 *
 * Hydration is also "an update from elsewhere": the IndexedDB replay and the
 * hub's first sync both land as remote transactions carrying the whole
 * document. Recording those would paint every block the moment you opened a
 * document, which is noise, not news. So a tracker records nothing until
 * {@link ChangedBlocks.start}, and {@link changedBlocks} starts it once the
 * local replica has been applied and wipes it again on the hub's *first* sync.
 * Later syncs are catch-up after a reconnect — changes made while you were
 * offline, which is exactly what this feature is for — so those do mark.
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
import type { RoomConnection } from "../collab/rooms.js";

/** The marked blocks of one document, and the ways they are marked and cleared. */
export interface ChangedBlocks {
  /** The ids currently marked. Live — do not hold on to it across a change. */
  ids(): ReadonlySet<string>;
  has(id: string): boolean;
  /** Begin recording. Idempotent; nothing is recorded before it is called. */
  start(): void;
  /** This block has been read. */
  clear(id: string): void;
  /** Drop every mark. */
  reset(): void;
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
  const marked = new Set<string>();
  const listeners = new Set<() => void>();
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

  const mark = (id: unknown): boolean => {
    if (typeof id !== "string" || id === "" || marked.has(id)) return false;
    marked.add(id);
    return true;
  };

  /** The id of the top-level block an event happened in, or `undefined`. */
  const blockOfEvent = (path: Array<string | number>): unknown => {
    const index = path[0];
    if (typeof index !== "number") return undefined;
    const block = fragment.get(index);
    return block instanceof Y.XmlElement ? block.getAttribute("id") : undefined;
  };

  const record = (
    events: Array<Y.YEvent<Y.AbstractType<unknown>>>,
    transaction: Y.Transaction,
  ): void => {
    if (!recording || transaction.local) return;
    let touched = false;
    for (const event of events) {
      if (event.path.length === 0) {
        // The fragment itself: blocks arriving or leaving. Only arrivals can be
        // marked — a block that is gone has no gutter left to draw in.
        for (const change of event.changes.delta) {
          if (!Array.isArray(change.insert)) continue;
          for (const child of change.insert) {
            if (child instanceof Y.XmlElement) {
              touched = mark(child.getAttribute("id")) || touched;
            }
          }
        }
        continue;
      }
      // Anything deeper — the block's text, its marks, its attributes — is a
      // change to the block the path starts at.
      touched = mark(blockOfEvent(event.path)) || touched;
    }
    if (touched) notify();
  };
  fragment.observeDeep(record);

  return {
    ids: () => marked,
    has: (id) => marked.has(id),
    start: () => {
      recording = true;
    },
    clear: (id) => {
      if (!marked.delete(id)) return;
      notify();
    },
    reset: () => {
      if (marked.size === 0) return;
      marked.clear();
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
 * The tracker for a connection's document, started at the right moment — see
 * "Why the document arriving is not a change" above. Wired once per document,
 * however many components ask for it.
 */
export function changedBlocks(connection: RoomConnection): ChangedBlocks {
  const marks = changedBlocksFor(connection.ydoc);
  if (armed.has(connection.ydoc)) return marks;
  armed.add(connection.ydoc);

  // The local replica lands before this resolves, so starting here cannot
  // record it. With no IndexedDB (jsdom, private-mode Safari) it resolves
  // immediately, which is right: there is no replay to sit out.
  void connection.whenLocalReplicaLoaded.then(() => marks.start());

  let syncedOnce = false;
  connection.onStatusChange((status) => {
    if (syncedOnce || !status.synced) return;
    syncedOnce = true;
    // The hub's first sync may have landed either side of the replica's, so
    // start (in case it has not happened yet) and wipe (in case it had).
    marks.start();
    marks.reset();
  });

  return marks;
}

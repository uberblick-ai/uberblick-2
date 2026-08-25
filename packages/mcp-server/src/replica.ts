/**
 * Offline-first Y.Doc replicas over the local update log.
 *
 * The contract this module implements, in order of importance:
 *
 * 1. **The log is the replica.** A replica is built by replaying its room's log
 *    (snapshot + tail), never by asking the hub. The hub's updates arrive as
 *    ordinary remote updates and are logged like any other.
 * 2. **Every update is logged synchronously.** One `doc.on("update")` observer
 *    appends to the log inside the Yjs transaction's completion, local and
 *    remote origin alike, so a mutating tool cannot return before its update is
 *    committed to disk. `kill -9` right after a write loses nothing.
 * 3. **Another instance's writes are picked up at tool-call start.** Two MCP
 *    servers on one database is the normal case, so {@link Replicas.settle}
 *    polls the log tail for every replica before any tool serves a read.
 * 4. **Discovery is a synced doc.** The directory replica is hydrated, logged
 *    and attached exactly like a document; `list_docs` reads it and never a
 *    locally-observed set of creations.
 *
 * The derived index (FTS5, tags, links) is maintained here as a side effect of
 * observed updates — never as the source of truth. {@link Replicas.rebuildIndex}
 * throws it away and rebuilds it from the replicas, which is the proof it is
 * derived.
 */

import * as Y from "yjs";
import { Awareness } from "y-protocols/awareness";
import {
  DIRECTORY_SUFFIX,
  directoryRoom,
  getBlocks,
  getBlocksFragment,
  getDirectoryEntry,
  getMeta,
  listDirectory,
  repairDuplicateBlocks,
  roomForDoc,
  upsertDirectoryEntry,
} from "@uberblick/schema";
import type { DocMeta } from "@uberblick/schema";
import type { McpConfig } from "./config.js";
import { log } from "./log.js";
import type { MirrorStore, UpdateOrigin } from "./store.js";
import { HubSync } from "./sync.js";

/**
 * Transaction origin for updates replayed out of the log. The observer skips
 * them: they are, by definition, already logged.
 */
const LOG_ORIGIN = Symbol("uberblick/log");

export interface Replica {
  /** `<workspaceId>/<uuid>`, or the workspace's `_directory` room. */
  readonly room: string;
  /** The document uuid, or `_directory`. */
  readonly id: string;
  readonly isDirectory: boolean;
  readonly doc: Y.Doc;
  readonly awareness: Awareness;
  /** The highest log sequence applied to this replica. */
  lastSeq: number;
}

/**
 * Thrown by every tool once an update could not be appended to the log.
 *
 * Not recoverable in-process: the live replica holds a change the log does not,
 * so it can no longer be trusted to answer anything. A restart rebuilds it from
 * the log — losing the unlogged change, which was never durable in the first
 * place.
 */
export class PersistenceError extends Error {
  readonly room: string;

  constructor(room: string, cause: unknown) {
    super(
      `The update log rejected a write to ${room}, so this replica is ahead of its own log ` +
        `and no longer safe to read or write. Restart the MCP server to rebuild it from the log. ` +
        `Cause: ${String(cause)}`,
      { cause },
    );
    this.name = "PersistenceError";
    this.room = room;
  }
}

/** The Y.XmlText holding a block's source, or null when the block is absent. */
export function blockText(doc: Y.Doc, blockId: string): Y.XmlText | null {
  for (const child of getBlocksFragment(doc).toArray()) {
    if (!(child instanceof Y.XmlElement)) continue;
    if (child.getAttribute("id") !== blockId) continue;
    return child.firstChild instanceof Y.XmlText ? child.firstChild : null;
  }
  return null;
}

function sameSet(a: readonly string[], b: readonly string[]): boolean {
  if (a.length !== b.length) return false;
  const left = new Set(a);
  for (const value of b) {
    if (!left.has(value)) return false;
  }
  return true;
}

export class Replicas {
  readonly config: McpConfig;

  readonly store: MirrorStore;

  readonly sync: HubSync;

  private readonly replicas = new Map<string, Replica>();

  private readonly cursorTimers = new Map<string, NodeJS.Timeout>();

  /** Display name published in awareness. Refined once the client identifies. */
  private agentName: string;

  /** Set on boot and on every hub connect: the next tool call waits for sync. */
  private settleNeeded = true;

  /** The settle currently in flight, so concurrent tool calls share one. */
  private settling: Promise<void> | null = null;

  /**
   * The first failure to persist an update, if any. Sticky and fatal by design
   * — see {@link assertHealthy}.
   */
  private persistenceFailure: { room: string; error: unknown } | null = null;

  private destroyed = false;

  constructor(config: McpConfig, store: MirrorStore) {
    this.config = config;
    this.store = store;
    this.agentName = "agent";
    this.sync = new HubSync(config, () => {
      // A hub that just came up may hold docs (or updates) this replica set has
      // never seen, so the next tool call settles again rather than answering
      // from a state that was complete only while offline.
      this.settleNeeded = true;
    });

    // The directory doc exists from boot: discovery is a synced doc, and every
    // stub repair needs it in hand.
    this.directory();
    for (const pending of this.store.pendingRooms()) {
      this.adoptRoom(pending.room);
    }
  }

  /**
   * Refuse to serve once an update could not be logged.
   *
   * The log is the authoritative replica, so a failed append leaves the live
   * document ahead of the truth: it holds a change that a restart will not
   * bring back. Serving reads from it would hand out state that is about to
   * vanish, and serving writes would stack more of them. The failure is
   * therefore sticky and every tool stops — a restart rebuilds the replica from
   * the log and drops the unlogged change, which is the only honest outcome.
   */
  assertHealthy(): void {
    const failure = this.persistenceFailure;
    if (failure === null) {
      return;
    }
    throw new PersistenceError(failure.room, failure.error);
  }

  /** The sticky persistence failure, for diagnostics that must still answer. */
  persistenceError(): { room: string; message: string } | null {
    const failure = this.persistenceFailure;
    return failure === null
      ? null
      : { room: failure.room, message: String(failure.error) };
  }

  /** The awareness display name for this agent session. */
  get name(): string {
    return this.agentName;
  }

  /** The awareness display name for this agent session. */
  setAgentName(name: string): void {
    this.agentName = name;
    for (const replica of this.replicas.values()) {
      replica.awareness.setLocalStateField("user", {
        name,
        color: this.config.color,
      });
    }
  }

  directory(): Replica {
    return this.ensureRoom(
      directoryRoom(this.config.workspaceId),
      DIRECTORY_SUFFIX,
    );
  }

  /** The replica for one document, hydrated from the log and attached to the hub. */
  replica(uuid: string): Replica {
    return this.ensureRoom(roomForDoc(this.config.workspaceId, uuid), uuid);
  }

  /** Whether a replica for this document is already attached. */
  known(uuid: string): boolean {
    return this.replicas.has(roomForDoc(this.config.workspaceId, uuid));
  }

  /** Whether the log holds anything for this document's room. */
  hasLog(uuid: string): boolean {
    return this.store.hasRoom(roomForDoc(this.config.workspaceId, uuid));
  }

  private ensureRoom(room: string, id: string): Replica {
    const existing = this.replicas.get(room);
    if (existing !== undefined) {
      return existing;
    }

    const doc = new Y.Doc();
    const awareness = new Awareness(doc);
    awareness.setLocalStateField("user", {
      name: this.agentName,
      color: this.config.color,
    });

    const replica: Replica = {
      room,
      id,
      isDirectory: id === DIRECTORY_SUFFIX,
      doc,
      awareness,
      lastSeq: 0,
    };

    // Observe before hydrating. Replayed updates carry LOG_ORIGIN and are
    // skipped, so hydration cannot double-log, and any update that arrives
    // mid-hydration is still recorded.
    doc.on("update", (payload: Uint8Array, origin: unknown) => {
      if (origin === LOG_ORIGIN) {
        return;
      }
      const kind: UpdateOrigin = this.sync.isRemoteOrigin(origin)
        ? "remote"
        : "local";
      // The append (and, for a local change, its pending watermark) is one
      // transaction, so an update is never logged without being remembered.
      //
      // A failure is recorded rather than thrown: this runs inside Yjs'
      // transaction cleanup, where throwing can leave the document unable to
      // emit later updates — which would turn a broken replica into a silent
      // one, reporting `applied: true` for writes nothing ever logged. Recorded
      // here, it stops every tool through `assertHealthy`.
      try {
        this.store.appendUpdate(room, payload, kind);
      } catch (error) {
        this.persistenceFailure ??= { room, error };
        log.error("failed to append to the update log", {
          room,
          error: String(error),
        });
        // Quarantine before returning, and before any other listener on this
        // document runs. Yjs calls every `update` listener in turn, and the
        // Hocuspocus provider's listener is one of them: without this, the very
        // mutation the log just refused would be broadcast to every other
        // client, while this tool call reported `applied: false`.
        this.sync.quarantine();
        return;
      }
      this.afterChange(replica);
    });

    this.replicas.set(room, replica);
    this.poll(replica);
    this.sync.attach({ room, doc, awareness });
    return replica;
  }

  /** Attach a replica for a room name, tolerating a name that is not one. */
  private adoptRoom(room: string): void {
    const workspacePrefix = `${this.config.workspaceId}/`;
    if (!room.startsWith(workspacePrefix)) {
      return;
    }
    const id = room.slice(workspacePrefix.length);
    if (id === "" || id.includes("/")) {
      return;
    }
    this.ensureRoom(room, id);
  }

  /**
   * Apply everything in the log this replica has not seen.
   *
   * The snapshot and the tail come from one consistent read
   * ({@link MirrorStore.readSince}), and that is the whole point: read
   * separately, a compaction landing between them prunes the rows that bridge
   * the two, and this replica would advance `lastSeq` past updates Yjs never
   * received — a gap it can never close, because the snapshot that replaced
   * them is now *behind* `lastSeq`.
   *
   * A snapshot whose `through_seq` is ahead of us is applied first: another
   * instance compacted away the rows we were about to read, and the snapshot is
   * exactly what replaced them.
   */
  private poll(replica: Replica): boolean {
    const slice = this.store.readSince(replica.room, replica.lastSeq);
    let applied = false;
    if (slice.snapshot !== null) {
      Y.applyUpdate(replica.doc, slice.snapshot.state, LOG_ORIGIN);
      replica.lastSeq = slice.snapshot.throughSeq;
      applied = true;
    }
    for (const entry of slice.updates) {
      Y.applyUpdate(replica.doc, entry.payload, LOG_ORIGIN);
      replica.lastSeq = entry.seq;
      applied = true;
    }
    if (applied) {
      this.afterChange(replica);
    }
    return applied;
  }

  private pollAll(): void {
    for (const replica of [...this.replicas.values()]) {
      this.poll(replica);
    }
  }

  /**
   * Repair a changed document's directory stub, then reindex it.
   *
   * The stub write comes first because it is document state — the one thing here
   * that is not rebuildable — and this is the only place stubs are written:
   * "upserted on create/rename" falls out of observing the document's own
   * updates, local and remote alike, rather than being remembered at each call
   * site.
   *
   * Guarded as a whole: the update it reacts to is already logged, so a failure
   * must not turn an applied write into an error. The index is derived; the stub
   * is repaired again on the next observed update or connect. A stub write that
   * cannot itself be logged is *not* swallowed here — the directory replica's
   * own observer records that as a sticky persistence failure, which stops every
   * tool regardless of what this catch does.
   */
  private afterChange(replica: Replica): void {
    if (replica.isDirectory) {
      return;
    }
    this.repairDuplicates(replica);
    try {
      const meta = getMeta(replica.doc);
      if (meta.uuid === "") {
        return;
      }
      // A tombstoned document must not come back through the index — not on a
      // live update, and not on a rebuild.
      if (getDirectoryEntry(this.directory().doc, meta.uuid)?.deleted === true) {
        this.store.unindexDoc(meta.uuid);
        return;
      }
      this.repairStub(meta);
      this.store.indexDoc({
        uuid: meta.uuid,
        title: meta.title,
        tags: meta.tags,
        links: meta.links,
        body: getBlocks(replica.doc)
          .map((block) => block.text)
          .join("\n"),
      });
    } catch (error) {
      log.warn("failed to mirror a document change", error);
    }
  }

  /**
   * Delete shadowed duplicate blocks as soon as this instance observes them.
   *
   * Two replicas re-typing one block concurrently converge on two elements
   * sharing its id. Reads already skip the shadowed copy, but leaving it in the
   * document leaves the stable-block-id invariant dented for every other
   * consumer, so the first instance to see it deletes it. The winner is the
   * document-order one — the same element every replica's reads resolve — so two
   * instances repairing at once delete the same element and converge; a repair
   * with nothing to do writes nothing.
   *
   * This is an ordinary local write: its update goes through the observer above
   * and is logged like any other. Skipped on a poisoned replica for the same
   * reason nothing else touches one — the document is ahead of its log, and a
   * repair would add another change the log will not keep.
   */
  private repairDuplicates(replica: Replica): void {
    if (this.persistenceFailure !== null) {
      return;
    }
    try {
      const removed = repairDuplicateBlocks(replica.doc);
      if (removed > 0) {
        log.debug("deleted shadowed duplicate blocks", {
          room: replica.room,
          removed,
        });
      }
    } catch (error) {
      log.warn("failed to repair duplicate blocks", error);
    }
  }

  /**
   * Bring the directory stub back in line with the document.
   *
   * `meta.title` in the doc is authoritative; the stub is a cache. A tombstone
   * is left alone — `upsertDirectoryEntry` keeps it sticky, but rewriting it on
   * every observed update would churn the directory for nothing.
   */
  private repairStub(meta: DocMeta): void {
    const directory = this.directory();
    const stub = getDirectoryEntry(directory.doc, meta.uuid);
    if (stub?.deleted === true) {
      return;
    }
    if (
      stub !== null &&
      stub.title === meta.title &&
      sameSet(stub.tags, meta.tags)
    ) {
      return;
    }
    upsertDirectoryEntry(directory.doc, {
      uuid: meta.uuid,
      title: meta.title,
      tags: meta.tags,
    });
  }

  /** Attach a replica for every document the directory knows about. */
  private adoptKnownDocs(): number {
    let added = 0;
    for (const entry of listDirectory(this.directory().doc, {
      includeDeleted: true,
    })) {
      if (entry.deleted === true) {
        // A doc deleted elsewhere leaves the derived index; `list_docs` reads
        // the directory, and search must not surface a tombstoned doc.
        this.store.unindexDoc(entry.uuid);
        continue;
      }
      if (!this.known(entry.uuid)) {
        this.replica(entry.uuid);
        added += 1;
      }
    }
    for (const pending of this.store.pendingRooms()) {
      if (!this.replicas.has(pending.room)) {
        this.adoptRoom(pending.room);
        added += 1;
      }
    }
    return added;
  }

  /**
   * Bring this instance up to date before a tool serves.
   *
   * Always: replay the log tail (another MCP instance's writes) and attach any
   * newly discovered document. Additionally, when a hub connection is worth
   * waiting for — boot, or a reconnect — wait briefly for the directory and the
   * documents it names to sync, so a fresh client with an empty database can
   * enumerate and search the whole corpus. Bounded and skipped entirely when
   * the hub is unreachable: no tool call blocks on the network.
   */
  async settle(options: { requireHealthy?: boolean } = {}): Promise<void> {
    const requireHealthy = options.requireHealthy !== false;
    if (requireHealthy) {
      this.assertHealthy();
    }
    if (this.destroyed) {
      return;
    }

    // A poisoned replica does nothing at all — not even the parts that look
    // read-only. Polling reindexes from a document that is ahead of the log and
    // repairs directory stubs from it; compaction would fold the unlogged change
    // into a snapshot and make it durable, which is how a write reported as
    // refused came back after a restart. Diagnostics may look, never touch.
    if (this.persistenceFailure !== null) {
      return;
    }

    // Concurrent tool calls share one settle. Without this, the first caller
    // would clear `settleNeeded` and then await hub hydration while a second
    // caller sails past and answers from a directory, document set or index
    // that is still filling up.
    const inFlight = this.settling;
    if (inFlight !== null) {
      await inFlight;
      // Cheap and local: pick up anything logged while we were waiting.
      if (this.persistenceFailure === null) {
        this.refresh();
      }
      if (requireHealthy) {
        this.assertHealthy();
      }
      return;
    }

    const run = this.runSettle();
    this.settling = run;
    try {
      await run;
    } finally {
      this.settling = null;
    }

    // Re-checked after the waits: an append can fail at any moment, including
    // while this call was waiting on the hub. Serving what follows would answer
    // from a replica that stopped being the log mid-call.
    if (requireHealthy) {
      this.assertHealthy();
    }
  }

  /** Replay the log tail and attach newly discovered documents. Synchronous. */
  private refresh(): void {
    this.pollAll();
    this.adoptKnownDocs();
  }

  private async runSettle(): Promise<void> {
    this.refresh();

    if (this.sync.enabled && this.settleNeeded) {
      try {
        await this.sync.waitForQuiet();
        // Re-checked after every wait: an append that failed while we waited
        // (a remote update, say) means everything below would be working from a
        // document the log does not back.
        if (this.persistenceFailure !== null) return;
        this.pollAll();
        if (this.adoptKnownDocs() > 0) {
          await this.sync.waitForQuiet();
          if (this.persistenceFailure !== null) return;
          this.pollAll();
        }
      } finally {
        // Cleared only once the wait is over — a caller joining this settle is
        // waiting for exactly that, and a caller arriving after it should not
        // repeat it.
        this.settleNeeded = false;
      }
    }

    if (this.persistenceFailure !== null) return;
    this.releaseQuietRooms();
    this.compactLargeLogs();
  }

  /**
   * A room whose local changes reached the hub is no longer pending.
   *
   * Released only through `min(marker, lastSeq)` — at most what *this* replica
   * has applied, and therefore at most what its provider can have had
   * acknowledged. The marker in the database is not a safe watermark on its own:
   * another process can raise it between this replica's poll and this read, and
   * clearing through it would forget a change nobody has seen acknowledged. A
   * room with no replica here is left entirely alone.
   */
  private releaseQuietRooms(): void {
    for (const pending of this.store.pendingRooms()) {
      const replica = this.replicas.get(pending.room);
      if (replica === undefined || !this.sync.isRoomQuiet(pending.room)) {
        continue;
      }
      this.store.clearPending(
        pending.room,
        Math.min(pending.seq, replica.lastSeq),
      );
    }
  }

  /**
   * Replace a long log prefix with a state snapshot.
   *
   * `lastSeq` — everything this replica has provably applied — is the cut, so
   * the snapshot always covers what it deletes, and both happen in one SQLite
   * transaction.
   */
  private compactLargeLogs(): void {
    // Never from a replica that is ahead of its log: the snapshot would make the
    // unlogged change durable, which is worse than the failure that caused it.
    if (this.persistenceFailure !== null) {
      return;
    }
    for (const replica of this.replicas.values()) {
      if (replica.lastSeq <= 0) continue;
      if (this.store.updateCount(replica.room) < this.config.compactAfter) {
        continue;
      }
      try {
        this.store.compact(
          replica.room,
          Y.encodeStateAsUpdate(replica.doc),
          replica.lastSeq,
        );
        log.debug("compacted log", {
          room: replica.room,
          throughSeq: replica.lastSeq,
        });
      } catch (error) {
        log.warn("compaction failed", error);
      }
    }
  }

  /**
   * Throw the derived index away and rebuild it from the replicas.
   *
   * Exists to keep the invariant honest: FTS5, tags and links are derived from
   * the Y.Docs, which are derived from the log. Nothing is lost by deleting
   * them.
   */
  rebuildIndex(): void {
    this.store.clearDerived();
    this.adoptKnownDocs();
    for (const replica of this.replicas.values()) {
      this.afterChange(replica);
    }
  }

  /**
   * Re-derive one document's index rows from its current directory standing.
   *
   * Changes to the *directory* do not reach {@link afterChange} — it ignores
   * the directory replica, because a stub is not a document — so archiving or
   * restoring a doc would otherwise leave search answering from rows the
   * directory no longer agrees with. This runs the same branch a document
   * update runs: tombstoned unindexes, live re-indexes.
   */
  reindex(replica: Replica): void {
    this.afterChange(replica);
  }

  /**
   * Publish this agent's caret in a block, in y-prosemirror's wire format: an
   * encoded relative position under `cursor` (`{anchor, head}`), alongside the
   * `user` field the web UI renders. The cursor is withdrawn after a TTL — an
   * agent that wrote once and went away must not leave a caret behind forever.
   */
  publishCursor(replica: Replica, blockId: string, index: number): void {
    const text = blockText(replica.doc, blockId);
    if (text === null) {
      return;
    }
    const clamped = Math.max(0, Math.min(text.length, index));
    const position = Y.relativePositionToJSON(
      Y.createRelativePositionFromTypeIndex(text, clamped),
    );
    replica.awareness.setLocalStateField("cursor", {
      anchor: position,
      head: position,
    });

    const existing = this.cursorTimers.get(replica.room);
    if (existing !== undefined) {
      clearTimeout(existing);
    }
    const timer = setTimeout(() => {
      this.cursorTimers.delete(replica.room);
      replica.awareness.setLocalStateField("cursor", null);
    }, this.config.cursorTtlMs);
    // Never a reason to hold the process open.
    timer.unref?.();
    this.cursorTimers.set(replica.room, timer);
  }

  /** Whether a room's local changes are known to have reached the hub. */
  isRoomQuiet(room: string): boolean {
    return this.sync.isRoomQuiet(room);
  }

  attachedReplicas(): Replica[] {
    return [...this.replicas.values()];
  }

  destroy(): void {
    if (this.destroyed) {
      return;
    }
    this.destroyed = true;
    for (const timer of this.cursorTimers.values()) {
      clearTimeout(timer);
    }
    this.cursorTimers.clear();
    this.sync.destroy();
    for (const replica of this.replicas.values()) {
      replica.awareness.destroy();
      replica.doc.destroy();
    }
    this.replicas.clear();
  }
}

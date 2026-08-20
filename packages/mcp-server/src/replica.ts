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

  private destroyed = false;

  constructor(config: McpConfig, store: MirrorStore) {
    this.config = config;
    this.store = store;
    this.agentName = "Claude · agent";
    this.sync = new HubSync(config, () => {
      // A hub that just came up may hold docs (or updates) this replica set has
      // never seen, so the next tool call settles again rather than answering
      // from a state that was complete only while offline.
      this.settleNeeded = true;
    });

    // The directory doc exists from boot: discovery is a synced doc, and every
    // stub repair needs it in hand.
    this.directory();
    for (const room of this.store.pendingRooms()) {
      this.adoptRoom(room);
    }
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
      // Not guarded: a log append that fails must fail the tool call. The log
      // is the replica, so "applied" would be a lie without it.
      this.store.appendUpdate(room, payload, kind);
      if (kind === "local") {
        this.store.markPending(room);
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
   * A snapshot whose `through_seq` is ahead of us is applied first: another
   * instance may have compacted away the rows we were about to read, and the
   * snapshot is exactly what replaced them.
   */
  private poll(replica: Replica): boolean {
    let applied = false;
    const snapshot = this.store.snapshot(replica.room);
    if (snapshot !== null && snapshot.throughSeq > replica.lastSeq) {
      Y.applyUpdate(replica.doc, snapshot.state, LOG_ORIGIN);
      replica.lastSeq = snapshot.throughSeq;
      applied = true;
    }
    for (const entry of this.store.updatesAfter(replica.room, replica.lastSeq)) {
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
   * is repaired again on the next observed update or connect.
   */
  private afterChange(replica: Replica): void {
    if (replica.isDirectory) {
      return;
    }
    try {
      const meta = getMeta(replica.doc);
      if (meta.uuid === "") {
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
    for (const room of this.store.pendingRooms()) {
      if (!this.replicas.has(room)) {
        this.adoptRoom(room);
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
  async settle(): Promise<void> {
    if (this.destroyed) {
      return;
    }
    this.pollAll();
    this.adoptKnownDocs();

    if (this.sync.enabled && this.settleNeeded) {
      this.settleNeeded = false;
      await this.sync.waitForQuiet();
      this.pollAll();
      if (this.adoptKnownDocs() > 0) {
        await this.sync.waitForQuiet();
        this.pollAll();
      }
    }

    this.releaseQuietRooms();
    this.compactLargeLogs();
  }

  /** A room whose local changes reached the hub is no longer pending. */
  private releaseQuietRooms(): void {
    for (const room of this.store.pendingRooms()) {
      if (this.sync.isRoomQuiet(room)) {
        this.store.clearPending(room);
      }
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

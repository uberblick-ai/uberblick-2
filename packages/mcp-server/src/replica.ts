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
  FEEDBACK_SUFFIX,
  SIDEBAR_SUFFIX,
  compactFeedback,
  directoryRoom,
  feedbackRoom,
  getBlocksFragment,
  getBlocksWithInline,
  getDirectoryEntry,
  getDirectoryMap,
  getMeta,
  isProseBlockType,
  listDirectory,
  repairDuplicateBlocks,
  roomForDoc,
  sidebarRoom,
  upsertDirectoryEntry,
} from "@uberblick/schema";
import type { Block, DocMeta, InlineRun } from "@uberblick/schema";
import type { McpConfig } from "./config.js";
import { log } from "./log.js";
import type { MirrorStore, UpdateOrigin } from "./store.js";
import { HubSync } from "./sync.js";

/**
 * Transaction origin for updates replayed out of the log. The observer skips
 * them: they are, by definition, already logged.
 */
const LOG_ORIGIN = Symbol("uberblick/log");

/**
 * What an MCP session publishes as its `client` awareness field (#73, #494).
 *
 * The positive counterpart of the web client's own marker: a reader classifies
 * a session by what it *says* it is rather than by what it fails to say, so a
 * browser tab running a bundle too old to have said anything is no longer
 * mistaken for an agent. The value is a wire constant shared with the web
 * client by literal — `packages/web/src/collab/rooms.ts` holds the other end,
 * and neither package imports the other.
 */
export const AGENT_CLIENT = "agent";

export interface Replica {
  /** `<workspaceId>/<uuid>`, or one of the workspace's well-known rooms. */
  readonly room: string;
  /** The document uuid, or `_directory` / `_sidebar` / `_feedback`. */
  readonly id: string;
  readonly isDirectory: boolean;
  readonly isSidebar: boolean;
  readonly isFeedback: boolean;
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

/** One inline reference to another document, in the block that carries it. */
export interface DocLinkRange {
  /** Start offset in the block's text, in UTF-16 code units. */
  start: number;
  /** Exclusive end offset, in the same units. */
  end: number;
  /** The target document's uuid. */
  docId: string;
}

/**
 * The `docLink` ranges in one block, in document order, with adjacent runs of
 * the same target merged — the same shape `commentRuns` gives an annotation
 * anchor, and the offsets `annotate` and `link_range` speak in.
 *
 * The one place the ranges are derived, so `get_doc` reports exactly the edges
 * the index unions in.
 */
export function docLinkRanges(
  block: Block,
  inline: readonly InlineRun[],
): DocLinkRange[] {
  // Source blocks hold source text and carry no inline links, so a docLink on
  // one is foreign content: nothing renders it, and nothing here counts it.
  if (!isProseBlockType(block.type)) return [];
  const ranges: DocLinkRange[] = [];
  let index = 0;
  for (const run of inline) {
    const end = index + run.text.length;
    const docId = run.marks.docLink;
    if (docId !== undefined) {
      const last = ranges[ranges.length - 1];
      if (last !== undefined && last.docId === docId && last.end === index) {
        last.end = end;
      } else {
        ranges.push({ start: index, end, docId });
      }
    }
    index = end;
  }
  return ranges;
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

  /**
   * Document rooms currently publishing this session's presence, and the timer
   * that withdraws each.
   *
   * Its own clock, deliberately not the caret's: a read publishes presence
   * without drawing a caret, and the two expire independently. See
   * {@link touch}.
   */
  private readonly presenceTimers = new Map<string, NodeJS.Timeout>();

  /**
   * Directory uuids whose stub changed and whose index rows have not caught up.
   *
   * Filled by the directory map's own observer, which Yjs runs before the
   * document's `update` listener, and drained by {@link reconcileDirectory}
   * once that listener has the update safely in the log. The two-step exists so
   * reconciliation stays *after* the append — a failed append must not leave
   * the index describing a write the log refused — while still knowing which
   * handful of entries actually changed.
   */
  private readonly staleStubs = new Set<string>();

  /**
   * Entries owed a reconciliation that is paced, and the moment each is due.
   *
   * Separate from {@link staleStubs} because the two deserve opposite
   * treatment: a stub that just changed is reconciled at once, while work that
   * lands here is rationed to one entry per drain. Two things arrive here — a
   * reconciliation the store refused, due again after `reconcileRetryMs`, and a
   * tombstone found still holding index rows at adoption time, due immediately.
   *
   * Insertion order is the queue order, and re-queuing deletes before setting,
   * so an entry the store keeps refusing rotates to the back instead of
   * monopolising the single slot.
   */
  private readonly pacedStubs = new Map<string, number>();

  /**
   * The feedback document changed and has not been offered to compaction since.
   *
   * Armed by any change — local, remote or replayed — and drained at settle.
   * See {@link compactFeedbackIfDue}.
   */
  private feedbackCompactionDue = false;

  /** Re-entrancy guard: compaction's own update must not re-arm the flag. */
  private compactingFeedback = false;

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
    // So does the sidebar, and for the same reason `settle` matters to it: a
    // room attached from boot is one the hub gets to fill in before any tool
    // reads it, so curation made elsewhere is in hand before this replica acts
    // on the absence of it.
    this.sidebar();
    // And the feedback doc: every get_doc reports usage into it, and a report
    // read from a room attached only at the moment of asking would answer from
    // this machine's log alone.
    this.feedback();
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
      // Only where this session is already published. Renaming must not turn a
      // passively attached document room — or one whose presence has expired —
      // into a session the document shows.
      if (replica.awareness.getLocalState()?.user === undefined) continue;
      replica.awareness.setLocalStateField("user", this.userState());
    }
  }

  /** This session's awareness identity, as published in a room. */
  private userState(): { name: string; color: string } {
    return { name: this.agentName, color: this.config.color };
  }

  /**
   * The three fields that together *are* this session's presence: who it is,
   * that it is an agent, and which session it is.
   *
   * Written as one and withdrawn as one. A marker or a session id outliving the
   * `user` beside it would name a session the room no longer holds — a reader
   * counting agents, or drawing an avatar, would answer from a leftover.
   */
  private presenceState(): {
    user: { name: string; color: string };
    client: string;
    session: string;
  } {
    return {
      user: this.userState(),
      client: AGENT_CLIENT,
      session: this.config.sessionId,
    };
  }

  /**
   * Publish this session's presence in a document room, because a tool call is
   * reading or writing it, and withdraw it once the room goes untouched.
   *
   * Presence in a document means "this session is working here", not "this
   * process exists": the server attaches a replica for every live document in
   * the directory, so publishing on attach made one agent show up as a peer in
   * every document at once. Attachment is therefore silent, and this is the one
   * thing that speaks — called from the document-room access boundary in
   * `tools.ts`, so a tool answering from the derived index or the directory
   * stub never announces anything.
   *
   * Withdrawal removes the presence keys rather than the whole state: dropping
   * the state emits an awareness `removed`, which is what the web's departed-agent
   * grace waits for, and a presence timeout would then draw the caret for
   * another 30 seconds. The workspace-level rooms are exempt — the directory
   * publishes from attach because the "MCP connections" count reads it, and
   * nobody renders the sidebar or feedback rooms.
   */
  touch(replica: Replica): void {
    if (replica.isDirectory || replica.isSidebar || replica.isFeedback) {
      return;
    }
    replica.awareness.setLocalState({
      ...replica.awareness.getLocalState(),
      ...this.presenceState(),
    });

    const existing = this.presenceTimers.get(replica.room);
    if (existing !== undefined) {
      clearTimeout(existing);
    }
    const timer = setTimeout(() => {
      this.presenceTimers.delete(replica.room);
      const state = replica.awareness.getLocalState();
      if (state === null) return;
      const { user: _user, client: _client, session: _session, ...rest } = state;
      replica.awareness.setLocalState(rest);
    }, this.config.cursorTtlMs);
    // Never a reason to hold the process open.
    timer.unref?.();
    this.presenceTimers.set(replica.room, timer);
  }

  directory(): Replica {
    return this.ensureRoom(
      directoryRoom(this.config.workspaceId),
      DIRECTORY_SUFFIX,
    );
  }

  /**
   * The workspace's sidebar replica — the curated navigation doc, hydrated,
   * logged and synced exactly like the directory and like any document.
   */
  sidebar(): Replica {
    return this.ensureRoom(
      sidebarRoom(this.config.workspaceId),
      SIDEBAR_SUFFIX,
    );
  }

  /**
   * The workspace's feedback replica — the usage and helpfulness telemetry doc,
   * hydrated, logged and synced exactly like the directory and the sidebar.
   */
  feedback(): Replica {
    return this.ensureRoom(
      feedbackRoom(this.config.workspaceId),
      FEEDBACK_SUFFIX,
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
    // Attaching is not working here. Hydration, sync, search indexing and the
    // directory-driven attach loop all open rooms passively, so a document room
    // publishes nothing until a tool call touches it ({@link touch}); the
    // directory is workspace-level presence and publishes from the moment it
    // attaches.
    if (id === DIRECTORY_SUFFIX) {
      awareness.setLocalState(this.presenceState());
    } else {
      awareness.setLocalState(null);
    }

    const replica: Replica = {
      room,
      id,
      isDirectory: id === DIRECTORY_SUFFIX,
      isSidebar: id === SIDEBAR_SUFFIX,
      isFeedback: id === FEEDBACK_SUFFIX,
      doc,
      awareness,
      lastSeq: 0,
    };

    // Which stubs changed is knowable only here: the update payload says a
    // directory update happened, not which handful of entries it touched, and
    // re-deriving the whole corpus per update would put a SQLite write per
    // document behind every keystroke in a title.
    if (replica.isDirectory) {
      getDirectoryMap(doc).observe((event) => {
        for (const uuid of event.keysChanged) {
          this.staleStubs.add(uuid);
        }
      });
    }

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
      this.reconcileDirectory();
      return;
    }
    // The sidebar holds uuids and the feedback doc holds events — neither has
    // blocks or metadata, so there is no stub to repair and nothing to index.
    // Falling through would ask a document-shaped question of a doc that is not
    // one.
    if (replica.isSidebar) {
      return;
    }
    // The feedback doc has nothing to index either, but its size is this
    // replica's problem however the events arrived: compaction that only ran
    // after a local write would never fold a burst the hub delivered or the log
    // replayed. Arm it here and run it at settle — this is the update
    // observer's own transaction, which is no place to start another one.
    if (replica.isFeedback) {
      if (!this.compactingFeedback) {
        this.feedbackCompactionDue = true;
      }
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
      this.indexRows(replica, meta);
    } catch (error) {
      log.warn("failed to mirror a document change", error);
    }
  }

  /**
   * One document's derived rows, read off the document itself.
   *
   * Link rows are the union of the curated `meta.links` and every inline
   * `docLink` in the document's prose: an inline mention is a link edge, so
   * backlinks answer for it without anyone duplicating the edge by hand.
   * `meta.links` itself is never touched — it stays the curated list a human or
   * an agent wrote. The store de-dupes the union and drops a self-link.
   *
   * One traversal for both the body text and the marks: looking each block's
   * inline runs up by id would rescan the fragment per block.
   */
  private indexRows(replica: Replica, meta: DocMeta): void {
    const blocks = getBlocksWithInline(replica.doc);
    this.store.indexDoc({
      uuid: meta.uuid,
      title: meta.title,
      tags: meta.tags,
      description: meta.description ?? "",
      links: [
        ...meta.links,
        ...blocks.flatMap(({ block, inline }) =>
          docLinkRanges(block, inline).map((range) => range.docId),
        ),
      ],
      body: blocks.map(({ block }) => block.text).join("\n"),
    });
  }

  /**
   * Bring the derived index in line with the directory.
   *
   * A directory update changes which documents are supposed to be findable
   * without changing any document, and nothing else notices: `afterChange`
   * reacts to *document* updates, and `adoptKnownDocs` only ever attaches
   * documents it has not attached before. Without this, an archive or a restore
   * performed on another replica leaves this one's index as it was — and a
   * restored document stays unsearchable here until somebody happens to edit
   * it.
   *
   * Runs from the same observer that logs the directory update, so it fires for
   * local and remote origins alike, and only after that update is durable. Only
   * the entries that update actually changed are touched — see
   * {@link staleStubs} — because the common directory write by far is a title
   * being typed, not a document being archived.
   *
   * Deliberately does not repair stubs: that would write to the directory from
   * inside the directory's own update handler. Titles are cached data, repaired
   * from the document on the document's own updates, and on restore.
   */
  private reconcileDirectory(): void {
    const fresh = [...this.staleStubs];
    this.staleStubs.clear();
    const retry = this.stubDueForRetry(new Set(fresh));
    for (const uuid of retry === null ? fresh : [...fresh, retry]) {
      this.reconcileStub(uuid);
    }
  }

  /**
   * The one previously-failed entry due another attempt, if any.
   *
   * One, not all: a persistent refusal is usually a locked database, where each
   * attempt spends SQLite's busy timeout before failing again. Retrying every
   * queued entry on every settle would multiply that wait by the backlog and
   * charge it to whichever tool call happened to arrive — a slow database would
   * become a stalled server. Taking one per drain keeps any single call's cost
   * flat while still draining the backlog, since every call takes the next one.
   */
  private stubDueForRetry(fresh: Set<string>): string | null {
    const now = Date.now();
    for (const [uuid, dueAt] of this.pacedStubs) {
      if (fresh.has(uuid)) {
        continue;
      }
      if (now >= dueAt) {
        return uuid;
      }
    }
    return null;
  }

  /**
   * Bring one document's index rows in line with its directory entry.
   *
   * Clears the entry's failure record first, so a stub that changed again is
   * treated as fresh work rather than as a pending retry.
   */
  private reconcileStub(uuid: string): void {
    this.pacedStubs.delete(uuid);
    try {
      const entry = getDirectoryEntry(this.directory().doc, uuid);
      if (entry === null) {
        return;
      }
      if (entry.deleted === true) {
        // Ask before deleting: the usual tombstone has no rows left, and a
        // delete that finds nothing still queues behind a write lock.
        if (this.store.isIndexed(uuid)) {
          this.store.unindexDoc(uuid);
        }
        return;
      }
      // A live entry for a document this replica has never attached is left
      // to `adoptKnownDocs`, which attaches and indexes it on the next
      // settle. Attaching from in here would join rooms as a side effect of
      // an observer.
      if (!this.known(uuid)) {
        return;
      }
      const replica = this.replica(uuid);
      const meta = getMeta(replica.doc);
      if (meta.uuid !== "") {
        this.indexRows(replica, meta);
      }
    } catch (error) {
      this.recordStubFailure(uuid, error);
    }
  }

  /**
   * Remember that an entry's reconciliation was refused.
   *
   * Never a give-up: the entry stays queued and a later drain takes it. Deleting
   * before setting moves it to the back of the retry order, so one entry the
   * store keeps refusing cannot starve the rest.
   */
  private recordStubFailure(uuid: string, error: unknown): void {
    this.pace(uuid, Date.now() + this.config.reconcileRetryMs);
    log.warn("failed to reconcile a directory entry", error);
  }

  /** Queue an entry for a paced reconciliation, at the back of the line. */
  private pace(uuid: string, dueAt: number): void {
    this.pacedStubs.delete(uuid);
    this.pacedStubs.set(uuid, dueAt);
  }

  /**
   * Whether this replica's index is in line with the directory for one
   * document.
   *
   * False while a reconciliation is still owed for it — either because none has
   * run yet, or because one ran and the store refused, in which case the uuid
   * stays queued and a later settle retries it.
   */
  indexReconciled(uuid: string): boolean {
    return !this.staleStubs.has(uuid) && !this.pacedStubs.has(uuid);
  }

  /** Whether this replica holds the document itself, not just its stub. */
  hydrated(uuid: string): boolean {
    return this.known(uuid) && getMeta(this.replica(uuid).doc).uuid !== "";
  }

  /**
   * Republish one document's stub from its own metadata, where this replica
   * holds the document. Returns whether it could — i.e. whether the document is
   * hydrated here.
   *
   * Stub repair otherwise rides document updates, and those skip tombstoned
   * entries: a rename or a retag applied while a document was archived never
   * reaches the directory. Restoring is the moment to catch up, or the document
   * comes back under the title it was archived with while search answers from
   * the newer one. Writes only when the stub and the document actually differ.
   */
  republishStub(uuid: string): boolean {
    if (!this.hydrated(uuid)) {
      return false;
    }
    this.repairStub(getMeta(this.replica(uuid).doc));
    return true;
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
   * Bring the directory stub back in line with the document, and stamp it.
   *
   * `meta.title` and `meta.description` in the doc are authoritative; the stub
   * is a cache. A tombstone is left alone — `upsertDirectoryEntry` keeps it
   * sticky, but rewriting it on every observed update would churn the directory
   * for nothing.
   *
   * The description is cached exactly like the title, and costs the directory
   * exactly what a rename costs: it is written wholesale by `set_description`,
   * so a change to it is a metadata change and publishes one directory update.
   * There is no per-keystroke path into it — nothing edits a description a
   * character at a time.
   *
   * Timestamps ride the same write, on this server's own clock:
   *
   * - `createdAt` is set once. Passing it on every repair costs nothing (the
   *   schema keeps the existing one) and is what backfills a stub written
   *   before the field existed, on the first change anyone observes.
   * - `updatedAt` is stamped when the metadata actually changed — that write is
   *   happening anyway — and otherwise only once the stored stamp is older than
   *   `updatedAtCoarsenessMs`. A burst of edits to one document therefore costs
   *   one directory update per window, not one per keystroke.
   *
   * The stamp read back is whatever the directory holds, so a second replica
   * that has already stamped this window suppresses this one's write too. Two
   * replicas that stamp concurrently converge last-write-wins on the entry,
   * which is the accepted outcome for a cache-quality field.
   */
  private repairStub(meta: DocMeta): void {
    const directory = this.directory();
    const stub = getDirectoryEntry(directory.doc, meta.uuid);
    if (stub?.deleted === true) {
      return;
    }
    const now = Date.now();
    const metaChanged =
      stub === null ||
      stub.title !== meta.title ||
      (stub.description ?? null) !== meta.description ||
      !sameSet(stub.tags, meta.tags);
    const staleStamp =
      stub?.updatedAt === undefined ||
      now - stub.updatedAt >= this.config.updatedAtCoarsenessMs;
    if (!metaChanged && !staleStamp && stub.createdAt !== undefined) {
      return;
    }
    upsertDirectoryEntry(directory.doc, {
      uuid: meta.uuid,
      title: meta.title,
      tags: meta.tags,
      // Always stated, never carried forward: this replica holds the document,
      // so it knows the authoritative answer — including that there is none,
      // which the empty string is how to say. It is stated from THIS replica's
      // copy of the document, which is the same discipline the title has: two
      // replicas describing one document converge last-write-wins on the stub,
      // and whichever of them saw the newer document then repairs the entry on
      // its next observed update. The cache heals; it is not arbitrated.
      description: meta.description ?? "",
      createdAt: now,
      ...(metaChanged || staleStamp ? { updatedAt: now } : {}),
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
        // the directory, and search must not surface a tombstoned doc. This is
        // the safety net for rows the observer never saw go stale — a mirror
        // rebuilt from an older corpus, or a tombstone learned by replaying the
        // log, where hydration is not an observed update.
        //
        // It asks rather than deletes, and hands any real work to the paced
        // queue rather than doing it here. In steady state the rows are long
        // gone, so this costs one indexed read and no write at all; when they
        // are not, a whole backlog of deletes must not land on whichever tool
        // call happens to arrive while the database is locked.
        if (!this.pacedStubs.has(entry.uuid) && this.store.isIndexed(entry.uuid)) {
          this.pace(entry.uuid, 0);
        }
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
    // Retry whatever the store refused last time. Reconciliation normally rides
    // directory updates, and a failed entry would otherwise wait for the next
    // one — which may never come for a document nobody touches again. At most
    // one previously-failed entry is retried per call; see stubDueForRetry.
    if (this.staleStubs.size > 0 || this.pacedStubs.size > 0) {
      this.reconcileDirectory();
    }
    this.compactFeedbackIfDue();
  }

  /**
   * Fold the feedback document down, if anything has changed it.
   *
   * Compaction follows the state, never the author. Two replicas can each sit
   * comfortably under the limit and converge well over it, and neither of them
   * has a local write coming — so the receiving replica has to fold what it now
   * holds. Armed by {@link afterChange} on every change to that document; run
   * from here, on the settle every tool call already pays, which is outside the
   * update observer's transaction.
   *
   * Never from a poisoned replica, for the reason compaction is skipped
   * everywhere else: the document is ahead of its own log, and folding it would
   * make an unlogged change durable. Cheap when there is nothing to fold — the
   * schema helper returns on a length check before it reads anything — and
   * guarded so that its own update does not re-arm the flag it just cleared.
   */
  private compactFeedbackIfDue(): void {
    if (!this.feedbackCompactionDue || this.persistenceFailure !== null) {
      return;
    }
    this.feedbackCompactionDue = false;
    this.compactingFeedback = true;
    try {
      compactFeedback(this.feedback().doc);
    } catch (error) {
      // Advisory telemetry: a fold that failed leaves the events where they
      // are, which is only a larger document. A failed *append* is a different
      // matter, and the observer above has already recorded that one.
      log.warn("failed to compact the feedback document", error);
    } finally {
      this.compactingFeedback = false;
    }
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
        //
        // Unless the corpus is still joining the hub: rooms attach in waves and
        // a settle is one wave's budget, so a fresh client's queue outlasts it.
        // Hydration is not complete while rooms are still queued, and the wait
        // does not grow to cover them — this call keeps the budget it promised
        // and the settle stays owed, so the next call resumes the drain instead
        // of answering from a corpus that never finished arriving.
        this.settleNeeded = this.sync.isDraining();
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
    // Not `setLocalStateField`: y-protocols drops a field write on a room whose
    // local state is unset, which is how a document room starts.
    replica.awareness.setLocalState({
      ...replica.awareness.getLocalState(),
      cursor: { anchor: position, head: position },
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
    // Drawing a caret is working in the document, and a caret must never be
    // drawn without the name beside it (#304). Re-arming presence *after* the
    // cursor's own timer is what keeps the identity alive at least as long as
    // the caret it labels, however long the write that drew it took.
    this.touch(replica);
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
    for (const timer of this.presenceTimers.values()) {
      clearTimeout(timer);
    }
    this.presenceTimers.clear();
    this.sync.destroy();
    for (const replica of this.replicas.values()) {
      replica.awareness.destroy();
      replica.doc.destroy();
    }
    this.replicas.clear();
  }
}

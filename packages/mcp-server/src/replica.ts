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
  SETTINGS_SUFFIX,
  SIDEBAR_SUFFIX,
  directoryRoom,
  directoryStubDiffers,
  decisionDirectoryFields,
  decisionTopicArchived,
  getBlocksFragment,
  getBlocksWithInline,
  getDirectoryEntry,
  getDirectoryMap,
  getMeta,
  isProseBlockType,
  listDirectory,
  repairDuplicateBlocks,
  resolveTagAssignments,
  roomForDoc,
  settingsRoom,
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
 * client by literal — `packages/web/src/collab/identity.ts` holds the other
 * end, and neither package imports the other.
 */
export const AGENT_CLIENT = "agent";

export interface Replica {
  /** `<workspaceId>/<uuid>`, or one of the workspace's well-known rooms. */
  readonly room: string;
  /** The document uuid, or one of the workspace's well-known suffixes. */
  readonly id: string;
  readonly isDirectory: boolean;
  readonly isSidebar: boolean;
  readonly isSettings: boolean;
  readonly doc: Y.Doc;
  readonly awareness: Awareness;
  /** The highest log sequence applied to this replica. */
  lastSeq: number;
  /** The highest log cut applied before deriving this replica's index rows. */
  indexedThroughSeq: number;
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

export class Replicas {
  readonly config: McpConfig;

  readonly store: MirrorStore;

  readonly sync: HubSync;

  /** Whether this process publishes its own agent awareness state. */
  private readonly publishOwnPresence: boolean;

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

  constructor(
    config: McpConfig,
    store: MirrorStore,
    options: { publishOwnPresence?: boolean } = {},
  ) {
    this.config = config;
    this.store = store;
    this.publishOwnPresence = options.publishOwnPresence ?? true;
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
    // So do the two curated workspace documents. Rooms attached from boot are
    // ones the hub gets to fill before a tool reads them, so neither sidebar
    // curation nor the tag catalog is guessed from an unhydrated empty doc.
    this.sidebar();
    this.settings();
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
   * Withdrawal removes the presence keys rather than dropping the whole state,
   * because a peer never sees the drop. The hub re-encodes each inbound
   * awareness update from a scratch `Awareness`, relaying only the clients that
   * update leaves alive (`@hocuspocus/server`'s `MessageReceiver`), so a
   * removal's client id is absent from what it broadcasts:
   * `setLocalState(null)` would leave every peer holding this session's last
   * presence — name, agent marker, session id — until y-protocols expires the
   * entry 30 seconds later, showing an agent as working in a document it has
   * left. Removing the keys is an ordinary update and lands at once; the caret
   * is safe either way, because the cursor's own timer fires no later than
   * presence and that update is relayed too. Only an *inbound* removal is
   * swallowed: the hub broadcasts the one it generates itself when a connection
   * closes (`Document.removeConnection`), which is what the web's
   * departed-agent grace waits for.
   *
   * The price is that "not present" then has two shapes. A room this session has
   * touched keeps a non-null local state for the rest of its life in this
   * process — heartbeated by y-protocols and re-sent on every reconnect — where
   * a never-touched room publishes nothing at all. No reader can see the
   * difference today, because that residual is `{cursor: null}` or `{}` — no
   * `user`, no anchor, nothing any reader counts or draws; one that counted
   * awareness *entries* instead would count this server as present in every
   * document it has ever opened, which is the bug #493 exists to fix.
   *
   * The workspace-level rooms are exempt — the directory publishes from attach
   * because the "MCP connections" count reads it, and nobody renders the
   * sidebar room.
   */
  touch(replica: Replica): void {
    if (
      !this.publishOwnPresence ||
      replica.isDirectory ||
      replica.isSidebar ||
      replica.isSettings
    ) {
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

  /** The workspace settings replica, including the curated tag catalog. */
  settings(): Replica {
    return this.ensureRoom(
      settingsRoom(this.config.workspaceId),
      SETTINGS_SUFFIX,
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
    if (this.publishOwnPresence && id === DIRECTORY_SUFFIX) {
      awareness.setLocalState(this.presenceState());
    } else {
      awareness.setLocalState(null);
    }

    const replica: Replica = {
      room,
      id,
      isDirectory: id === DIRECTORY_SUFFIX,
      isSidebar: id === SIDEBAR_SUFFIX,
      isSettings: id === SETTINGS_SUFFIX,
      doc,
      awareness,
      lastSeq: 0,
      indexedThroughSeq: 0,
    };

    // Which stubs changed is knowable only here: the update payload says a
    // directory update happened, not which handful of entries it touched, and
    // re-deriving the whole corpus per update would put a SQLite write per
    // document behind every keystroke in a title.
    if (replica.isDirectory) {
      getDirectoryMap(doc).observe((event) => {
        for (const uuid of event.keysChanged) {
          this.staleStubs.add(uuid);
          const first = getDirectoryEntry(doc, uuid);
          if (first?.kind === "decision" && (first.topic ?? first.uuid) === uuid) {
            for (const record of listDirectory(doc, { includeDeleted: true })) {
              if (record.kind === "decision" && (record.topic ?? record.uuid) === uuid) {
                this.staleStubs.add(record.uuid);
              }
            }
          }
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
      let appendedSeq: number;
      try {
        appendedSeq = this.store.appendUpdate(room, payload, kind);
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
      // Another process can append to this room after our last settle and
      // before this append. Replaying from the last cut used for indexing
      // folds those rows in, plus this already-applied update as a no-op,
      // before any derived row certifies itself through `appendedSeq`.
      try {
        this.catchUpForIndex(replica, appendedSeq);
      } catch (error) {
        // The update is durable and the Y.Doc has it, so this is an index-cache
        // failure rather than a persistence failure. A later settle replays
        // from `lastSeq` and derives the rows again.
        log.warn("failed to catch up before indexing a document change", error);
        return;
      }
      this.afterChange(replica, kind === "local");
    });

    this.replicas.set(room, replica);
    try {
      this.poll(replica);
    } catch (error) {
      this.replicas.delete(room);
      replica.awareness.destroy();
      replica.doc.destroy();
      throw error;
    }
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
    const replayed = this.replayLog(replica, replica.lastSeq);
    replica.lastSeq = replayed.throughSeq;
    replica.indexedThroughSeq = Math.max(
      replica.indexedThroughSeq,
      replayed.throughSeq,
    );
    const applied = replayed.applied;
    if (applied) {
      // A replay is this replica catching up on writes it did not make — its own
      // from before a restart, or another instance's on the same database.
      this.afterChange(replica, false);
    }
    return applied;
  }

  /**
   * Apply the room log after `fromSeq` without changing the settle watermark.
   *
   * Local appends deliberately do not advance `lastSeq`: pending-room release
   * and compaction still use the existing poll-owned watermark. Indexing has a
   * narrower need — prove which contiguous cut the current Y.Doc includes — so
   * it tracks that cut separately and a later settle may harmlessly replay the
   * same idempotent Yjs rows.
   */
  private replayLog(
    replica: Replica,
    fromSeq: number,
  ): { applied: boolean; throughSeq: number } {
    const slice = this.store.readSince(replica.room, fromSeq);
    let applied = false;
    let throughSeq = fromSeq;
    if (slice.snapshot !== null) {
      Y.applyUpdate(replica.doc, slice.snapshot.state, LOG_ORIGIN);
      throughSeq = slice.snapshot.throughSeq;
      applied = true;
    }
    for (const entry of slice.updates) {
      Y.applyUpdate(replica.doc, entry.payload, LOG_ORIGIN);
      throughSeq = entry.seq;
      applied = true;
    }
    return { applied, throughSeq };
  }

  /** Bring the index derivation to at least the update this process appended. */
  private catchUpForIndex(replica: Replica, appendedSeq: number): void {
    const replayed = this.replayLog(replica, replica.indexedThroughSeq);
    if (replayed.throughSeq < appendedSeq) {
      throw new Error(
        `the committed update ${appendedSeq} for ${replica.room} was absent from its log replay`,
      );
    }
    replica.indexedThroughSeq = replayed.throughSeq;
  }

  private pollAll(): void {
    for (const replica of [...this.replicas.values()]) {
      this.poll(replica);
    }
  }

  /**
   * Repair a changed document's directory stub, then reindex it.
   *
   * `authored` says whether this server made the change being reacted to; only
   * the stub's `updatedAt` depends on it, and {@link repairStub} explains why.
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
  private afterChange(replica: Replica, authored: boolean): void {
    if (replica.isDirectory) {
      this.reconcileDirectory();
      return;
    }
    // Workspace-owned docs hold curation rather than document blocks or meta,
    // so there is no stub to repair. A catalog change does affect the derived
    // tag rows: re-index every held document against the new vocabulary.
    if (replica.isSettings) {
      for (const document of this.replicas.values()) {
        if (
          document.isDirectory ||
          document.isSidebar ||
          document.isSettings
        ) {
          continue;
        }
        const meta = getMeta(document.doc);
        if (meta.uuid === "") continue;
        try {
          if (
            decisionTopicArchived(this.directory().doc, meta.uuid)
          ) {
            if (this.store.isIndexed(meta.uuid)) this.store.unindexDoc(meta.uuid);
            continue;
          }
          this.indexRows(document, meta);
        } catch (error) {
          // Catalog state is authoritative and logged; the index is only a
          // cache. Nothing else would come back for this document — the
          // catalog update is already applied, so no later settle replays it —
          // so it joins the paced reconciliation queue that drains one entry
          // per settle, the same one a refused stub reconciliation uses.
          this.recordStubFailure(meta.uuid, error);
        }
      }
      return;
    }
    if (replica.isSidebar) {
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
      if (meta.kind === "decision") this.repairStub(meta, authored);
      if (decisionTopicArchived(this.directory().doc, meta.uuid)) {
        this.store.unindexDoc(meta.uuid);
        return;
      }
      if (meta.kind !== "decision") this.repairStub(meta, authored);
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
    this.store.indexDoc(
      {
        uuid: meta.uuid,
        title: meta.title,
        tags: resolveTagAssignments(this.settings().doc, meta.tags).map(
          (entry) => entry.id,
        ),
        description: meta.description ?? "",
        links: [
          ...meta.links,
          ...blocks.flatMap(({ block, inline }) =>
            docLinkRanges(block, inline).map((range) => range.docId),
          ),
        ],
        body: blocks.map(({ block }) => block.text).join("\n"),
      },
      replica.indexedThroughSeq,
      this.settings().indexedThroughSeq,
    );
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
      if (decisionTopicArchived(this.directory().doc, entry.uuid)) {
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
    // A restore changes the directory, not the document, so it repairs the stub
    // without claiming the document changed now.
    this.repairStub(getMeta(this.replica(uuid).doc), false);
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
   * Bring the directory stub back in line with the document, and stamp it where
   * this server authored the change it is reacting to.
   *
   * The cache-repair rule lives beside {@link directoryStubDiffers}. A
   * tombstone is left alone — `upsertDirectoryEntry` keeps it
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
   *   before the field existed, on the first repair.
   * - `updatedAt` is stamped only for a change this server authored — `authored`
   *   — because the field says when someone changed the document, not when a
   *   replica noticed it. An update that merely arrived, a log replay, an index
   *   rebuild and an archive restore all still repair a stub that disagrees, and
   *   still backfill `createdAt`; they just never claim the document changed
   *   now. A repair this server itself writes is authored even when received
   *   state prompted it: the stamp records that document write, not the receipt.
   *   Without that, hydrating a corpus stamped every document in it with today's
   *   date and made "last changed" unreadable (#544).
   * - An authored change stamps immediately when the metadata changed — that
   *   write is happening anyway — and otherwise once the stored stamp is older
   *   than `updatedAtCoarsenessMs`. A burst of edits to one document therefore
   *   costs one directory update per window, not one per keystroke.
   *
   * The web uses the same comparison, with `transaction.local` where this
   * server uses `authored`, and keeps its own clock, window and write gate.
   *
   * The stamp read back is the directory's resolved maximum, so a second
   * replica that has already stamped this window suppresses this one's write
   * too. Concurrent stamps keep the greater value even when that replica's
   * whole-entry write loses Yjs ordering. A future-skewed value therefore
   * stands until a later authored stamp exceeds it.
   */
  private repairStub(meta: DocMeta, authored: boolean): void {
    const directory = this.directory();
    const stub = getDirectoryEntry(directory.doc, meta.uuid);
    if (meta.kind !== "decision" && stub?.deleted === true) {
      return;
    }
    const now = Date.now();
    const decisionFields = decisionDirectoryFields(this.replica(meta.uuid).doc);
    const metaChanged = directoryStubDiffers(stub, meta, decisionFields);
    const staleStamp =
      stub?.updatedAt === undefined ||
      now - stub.updatedAt >= this.config.updatedAtCoarsenessMs;
    const stamp = authored && (metaChanged || staleStamp);
    // Whether to write and whether to stamp are separate questions: a stub
    // missing `createdAt` is written to backfill it even when nothing else
    // changed and nothing is stamped.
    if (!metaChanged && !stamp && stub?.createdAt !== undefined) {
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
      // Always stated like description: this replica holds the authoritative
      // document, so omission clears a stale cached lifecycle rather than
      // carrying it forward.
      kind: meta.kind ?? "",
      status: meta.status ?? "",
      ...decisionFields,
      createdAt: now,
      ...(stamp ? { updatedAt: now } : {}),
    });
  }

  /** Attach a replica for every document the directory knows about. */
  private adoptKnownDocs(): number {
    let added = 0;
    for (const entry of listDirectory(this.directory().doc, {
      includeDeleted: true,
    })) {
      if (decisionTopicArchived(this.directory().doc, entry.uuid)) {
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
        this.refreshReplicas();
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

  /**
   * Run one hub-free engine pass.
   *
   * This is the local half of {@link settle}: replay the log tail, attach newly
   * discovered documents, repair derived state, release pending markers whose
   * providers are already quiet, and compact. It never waits for the hub, so a
   * transport-free engine may call it on every refresh tick even while the hub
   * is unavailable.
   */
  refresh(): void {
    this.assertHealthy();
    if (this.destroyed || this.persistenceFailure !== null) {
      return;
    }

    this.refreshReplicas();
    if (this.persistenceFailure !== null) {
      this.assertHealthy();
      return;
    }
    this.releaseQuietRooms();
    this.compactLargeLogs();
  }

  /** Replay the log tail and attach newly discovered documents. Synchronous. */
  private refreshReplicas(): void {
    this.pollAll();
    this.adoptKnownDocs();
    // Retry whatever the store refused last time. Reconciliation normally rides
    // directory updates, and a failed entry would otherwise wait for the next
    // one — which may never come for a document nobody touches again. At most
    // one previously-failed entry is retried per call; see stubDueForRetry.
    if (this.staleStubs.size > 0 || this.pacedStubs.size > 0) {
      this.reconcileDirectory();
    }
  }

  private async runSettle(): Promise<void> {
    this.refreshReplicas();

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
      // Rebuilding an index is not editing a document.
      this.afterChange(replica, false);
    }
  }

  /**
   * Publish this agent's caret in a block, in y-prosemirror's wire format: an
   * encoded relative position under `cursor` (`{anchor, head}`), alongside the
   * `user` field the web UI renders. The cursor is withdrawn after a TTL — an
   * agent that wrote once and went away must not leave a caret behind forever.
   */
  publishCursor(replica: Replica, blockId: string, index: number): void {
    if (!this.publishOwnPresence) {
      return;
    }
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

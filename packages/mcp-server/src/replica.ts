import * as Y from "yjs";
import { Awareness } from "y-protocols/awareness";
import {
  DIRECTORY_SUFFIX,
  SETTINGS_SUFFIX,
  SIDEBAR_SUFFIX,
  directoryRoom,
  directoryStubDiffers,
  deleteDirectoryEntry,
  enforceDeletedDirectoryEntries,
  documentDirectoryFields,
  decisionTopicArchived,
  findBlockElement,
  getBlocksFragment,
  getBlocksWithInline,
  getDirectoryEntry,
  getDirectoryMap,
  getMeta,
  isProseBlockType,
  isDirectoryEntryDeleted,
  listDeletedDirectoryUuids,
  listDirectory,
  normalizeLegacyTables,
  removeLegacyMermaidBlocks,
  repairDuplicateBlocks,
  resolveTagAssignments,
  roomForDoc,
  settingsRoom,
  sidebarRoom,
  tableCellText,
  tableRows,
  cardPartTexts,
  cardPartElement,
  figmaCaptionTexts,
  figmaCaptionElement,
  CARD_PARTS,
  upsertDirectoryEntry,
} from "@uberblick/schema";
import { DOC_DELETED_REASON } from "@uberblick/schema/protocol";
import type { Block, CardPart, DocMeta, InlineRun } from "@uberblick/schema";
import type { McpConfig } from "./config.js";
import { githubReference } from "./github-reference.js";
import { log } from "./log.js";
import { collectReplicaSyncState } from "./status.js";
import type { MirrorStore, UpdateOrigin } from "./store.js";
import { WorkspaceRemovedError } from "./store.js";
import { HubSync, type SyncWaitResult } from "./sync.js";

/** Replayed updates are already durable; the update observer must skip them. */
const LOG_ORIGIN = Symbol("uberblick/log");

/**
 * Match the wire marker in web's collab/identity.ts. Readers identify agents
 * positively; an unmarked browser session must not be counted as an agent.
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
 * A failed append leaves live state ahead of the authoritative log. Recovery
 * requires a restart, which drops the unlogged change rather than serving it.
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

export class DocDeletedError extends Error {
  readonly reason = DOC_DELETED_REASON;
  constructor(readonly uuid: string) {
    super(`Document ${uuid} was permanently deleted.`);
    this.name = "DocDeletedError";
  }
}

/** Optional empty parts collapse, so the agent caret belongs to visible prose. */
function cardCursorPart(card: Y.XmlElement): CardPart {
  return [...CARD_PARTS].reverse().find(part => cardPartTexts(card, part).some(text => text.length > 0)) ?? "title";
}

/** A block's editable text for an agent's end-of-write caret. */
export function blockText(doc: Y.Doc, blockId: string): Y.XmlText | null {
  for (const child of getBlocksFragment(doc).toArray()) {
    if (!(child instanceof Y.XmlElement)) continue;
    if (child.getAttribute("id") !== blockId) continue;
    if (child.nodeName === "table") {
      const cell = tableRows(child).at(-1)?.at(-1);
      return cell === undefined ? null : tableCellText(cell);
    }
    if (child.nodeName === "card") return cardPartTexts(child, cardCursorPart(child))[0] ?? null;
    if (child.nodeName === "figma") return figmaCaptionTexts(child)[0] ?? null;
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
 * Merge adjacent same-target runs in document order, using annotation offsets
 * in UTF-16 units. Share this derivation between get_doc and the link index.
 */
export function docLinkRanges(
  block: Block,
  inline: readonly InlineRun[],
): DocLinkRange[] {
  // Block-level ranges belong to prose. Table links are indexed from each
  // cell's runs instead, since GFM offsets do not address stored characters.
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

  /** Reads publish presence without a caret, so each has an independent TTL. */
  private readonly presenceTimers = new Map<string, NodeJS.Timeout>();

  /**
   * The map observer collects changed stubs before the update listener runs;
   * reconcile them only after that listener durably appends the update.
   */
  private readonly staleStubs = new Set<string>();

  /**
   * One due entry drains per pass: refused work waits reconcileRetryMs;
   * indexed tombstones are due immediately. Fresh stubs bypass this queue.
   * Re-queuing at the back prevents one persistent refusal starving the rest.
   */
  private readonly pacedStubs = new Map<string, number>();

  /** Display name published in awareness. Refined once the client identifies. */
  private agentName: string;

  /** Set on boot and on every hub connect: the next tool call waits for sync. */
  private settleNeeded = true;

  /** The settle currently in flight, so concurrent tool calls share one. */
  private settling: Promise<void> | null = null;

  private readonly refreshListeners = new Set<() => void>();

  /** Monotonic process time of the last metadata write attempt. */
  private lastSyncWriteAt: number | null = null;

  /** The first failed append remains fatal until restart; see assertHealthy. */
  private persistenceFailure: { room: string; error: unknown } | null = null;

  private destroyed = false;
  private closing: Promise<void> | null = null;

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
      // A reconnect can reveal unseen documents; settle before serving again.
      this.settleNeeded = true;
    }, { onDocDeleted: (room) => {
      const prefix = `${config.workspaceId}/`;
      if (!room.startsWith(prefix)) return;
      const uuid = room.slice(prefix.length);
      deleteDirectoryEntry(this.directory().doc, uuid);
      this.purgeDeletedDocs();
    } });

    // Discovery reads this synced directory, not this process's creations.
    // Attach from boot so stub repair and the first tool's hydration can use it.
    this.directory();
    // Hydrate curation and tags before tools read an otherwise empty replica.
    this.sidebar();
    this.settings();
    for (const pending of this.store.pendingRooms()) {
      this.adoptRoom(pending.room);
    }
  }

  /** Refuse workspace reads and writes from state the log cannot restore. */
  assertHealthy(): void {
    if (this.store.isRemoved()) {
      this.persistenceFailure ??= {
        room: directoryRoom(this.config.workspaceId),
        error: new WorkspaceRemovedError(),
      };
      this.sync.quarantine();
      throw new WorkspaceRemovedError();
    }
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
      // Renaming must not publish presence in passive or expired rooms.
      if (replica.awareness.getLocalState()?.user === undefined) continue;
      replica.awareness.setLocalStateField("user", this.userState());
    }
  }

  /** This session's awareness identity, as published in a room. */
  private userState(): { name: string; color: string } {
    return { name: this.agentName, color: this.config.color };
  }

  /** Keep user, agent marker and session ID together when publishing or withdrawing. */
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
   * Publish only document-room tool access; index and stub reads stay silent.
   * The directory publishes on attach for the workspace connection count;
   * sidebar and settings rooms publish no document presence.
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
      // Delete presence keys without clearing awareness: caret expiry must not
      // report the still-connected agent as departed. The caret expires no
      // later than this identity withdrawal.
      // A touched room retains heartbeated state across reconnects: readers must
      // count user/marker fields, never raw awareness entries. Actual awareness
      // removals reach the web's departed-agent grace.
      const { user: _user, client: _client, session: _session, ...rest } = state;
      replica.awareness.setLocalState(rest);
    }, this.config.cursorTtlMs);
    // Never a reason to hold the process open.
    timer.unref?.();
    this.presenceTimers.set(replica.room, timer);
  }

  /** Discovery uses a directory hydrated, logged and synced like document rooms. */
  directory(): Replica {
    return this.ensureRoom(
      directoryRoom(this.config.workspaceId),
      DIRECTORY_SUFFIX,
    );
  }

  /** Curated navigation uses the same logged, synced replica as other rooms. */
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
    this.assertNotDeleted(uuid);
    return this.ensureRoom(roomForDoc(this.config.workspaceId, uuid), uuid);
  }

  isDeleted(uuid: string): boolean {
    return isDirectoryEntryDeleted(this.directory().doc, uuid);
  }

  assertNotDeleted(uuid: string): void {
    if (this.isDeleted(uuid)) throw new DocDeletedError(uuid);
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
    if (this.destroyed) {
      throw new Error("Cannot open a room on destroyed replicas.");
    }
    const existing = this.replicas.get(room);
    if (existing !== undefined) {
      return existing;
    }

    const doc = new Y.Doc();
    const awareness = new Awareness(doc);
    // Passive room attachment is silent; only touch publishes document presence.
    // The directory publishes immediately as workspace-level presence.
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

    // Only this observer identifies changed entries; an update payload cannot.
    // Collect them here to avoid reindexing the whole corpus for a title edit.
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

    // Observe before replay so live updates during hydration are still logged.
    // LOG_ORIGIN avoids logging an already durable update twice.
    doc.on("update", (payload: Uint8Array, origin: unknown) => {
      if (origin === LOG_ORIGIN) {
        return;
      }
      if (!replica.isDirectory && !replica.isSidebar && !replica.isSettings && this.isDeleted(id)) {
        this.purgeDeletedDocs();
        return;
      }
      const kind: UpdateOrigin = this.sync.isRemoteOrigin(origin)
        ? "remote"
        : "local";
      // Synchronously commit local and remote updates during Yjs cleanup before
      // a tool can return; local updates and pending watermarks commit together.
      // Record failures instead of throwing from cleanup, which can suppress
      // later update events and allow false applied:true answers. assertHealthy
      // then refuses further workspace tools.
      let appendedSeq: number;
      try {
        appendedSeq = this.store.appendUpdate(room, payload, kind);
      } catch (error) {
        this.persistenceFailure ??= { room, error };
        log.error("failed to append to the update log", {
          room,
          error: String(error),
        });
        // Disconnect before the provider's later update listener can broadcast
        // a mutation the log refused and this tool reports as unapplied.
        this.sync.quarantine();
        return;
      }
      // Replay intervening peer appends before certifying the index's cut.
      // Re-applying this already present Yjs update is harmless.
      try {
        this.catchUpForIndex(replica, appendedSeq);
      } catch (error) {
        // This update is durable; only its index failed. A later settle replays
        // from lastSeq and derives the rows again without poisoning the replica.
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
    if (this.replicas.has(room)) this.sync.attach({ room, doc, awareness });
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
    if (isDirectoryEntryDeleted(this.directory().doc, id)) return;
    this.ensureRoom(room, id);
  }

  /**
   * Hydrate only from the room log. readSince pins snapshot and tail together
   * so compaction cannot prune an unseen gap; apply an ahead snapshot first.
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
      // Replay restores durable writes; it must not claim a new authored change.
      this.afterChange(replica, false);
    }
    return applied;
  }

  /**
   * Keep index replay separate from poll's lastSeq, used by pending release and
   * compaction. A later settle may safely replay the same idempotent Yjs rows.
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
      if (!this.replicas.has(replica.room)) continue;
      this.poll(replica);
    }
  }

  /**
   * Repair the logged, non-rebuildable stub before deriving index rows for local
   * and remote document updates. authored affects only updatedAt. Mirroring
   * failures must not reject an already logged write; retry on updates or connect.
   * A failed stub append still poisons the directory through its own observer.
   */
  private afterChange(replica: Replica, authored: boolean): void {
    if (replica.isDirectory) {
      this.purgeDeletedDocs();
      this.reconcileDirectory();
      return;
    }
    // Workspace curation has no stub; a catalog change re-derives all tag rows.
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
          // The catalog update is already applied and will not replay; queue
          // this cache repair explicitly so it gets a paced retry on settle.
          this.recordStubFailure(meta.uuid, error);
        }
      }
      return;
    }
    if (replica.isSidebar) {
      return;
    }
    if (this.isDeleted(replica.id)) {
      this.purgeDeletedDocs();
      return;
    }
    this.repairDuplicates(replica);
    try {
      const meta = getMeta(replica.doc);
      if (meta.uuid === "") {
        return;
      }
      // Live updates and rebuilds must keep archived documents out of the index.
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
   * Derive body and marks in one traversal to avoid rescanning per block.
   * Union curated links with inline prose/table links without changing meta;
   * the store deduplicates and excludes self-links. Decision GitHub references
   * use only external prose hrefs, with schema docLink precedence retained.
   */
  private indexRows(replica: Replica, meta: DocMeta): void {
    const blocks = getBlocksWithInline(replica.doc);
    const tags = resolveTagAssignments(this.settings().doc, meta.tags);
    this.store.indexDoc(
      {
        uuid: meta.uuid,
        title: meta.title,
        kind: meta.kind === "decision" ? "decision" : "regular",
        tags: tags.map((entry) => entry.id),
        tagNames: tags.flatMap((entry) => entry.name === null ? [] : [entry.name]),
        description: meta.description ?? "",
        links: [
          ...meta.links,
          ...blocks.flatMap(({ block, inline, table, card, figma }) =>
            table === undefined && card === undefined && figma === undefined
              ? docLinkRanges(block, inline).map((range) => range.docId)
              : (table?.flat() ?? Object.values(card ?? figma ?? {})).flatMap((cell: InlineRun[]) => cell.flatMap((run) =>
                run.marks.docLink === undefined ? [] : [run.marks.docLink],
              )),
          ),
        ],
        githubRefs:
          meta.kind === "decision"
            ? blocks.flatMap(({ block, inline }) => {
              if (!isProseBlockType(block.type)) return [];
              return inline.flatMap((run) => {
                const ref = run.marks.link === undefined
                  ? null
                  : githubReference(run.marks.link);
                return ref === null ? [] : [ref];
              });
            })
            : [],
        body: blocks.map(({ block }) => block.text).join("\n"),
      },
      replica.indexedThroughSeq,
      this.settings().indexedThroughSeq,
    );
  }

  /**
   * Reconcile changed entries after local or remote directory updates are logged;
   * archive/restore can change searchability without a document update.
   * Never repair stubs inside their directory observer: repair cached titles
   * from document updates or restore instead.
   */
  private reconcileDirectory(): void {
    const fresh = [...this.staleStubs];
    this.staleStubs.clear();
    const retry = this.stubDueForRetry(new Set(fresh));
    for (const uuid of retry === null ? fresh : [...fresh, retry]) {
      this.reconcileStub(uuid);
    }
  }

  /** Retry one due entry per drain so busy-timeout waits cannot scale with backlog. */
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

  /** Clear the prior failure first: a changed stub counts as fresh reconciliation. */
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
      // Leave attachment and indexing to the next settle's adoptKnownDocs;
      // this observer must not join document rooms.
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

  /** Keep refused entries queued at the back so later drains retry them fairly. */
  private recordStubFailure(uuid: string, error: unknown): void {
    this.pace(uuid, Date.now() + this.config.reconcileRetryMs);
    log.warn("failed to reconcile a directory entry", error);
  }

  /** Queue an entry for a paced reconciliation, at the back of the line. */
  private pace(uuid: string, dueAt: number): void {
    this.pacedStubs.delete(uuid);
    this.pacedStubs.set(uuid, dueAt);
  }

  /** False until fresh or previously refused directory reconciliation succeeds. */
  indexReconciled(uuid: string): boolean {
    return !this.staleStubs.has(uuid) && !this.pacedStubs.has(uuid);
  }

  /** Whether this replica holds the document itself, not just its stub. */
  hydrated(uuid: string): boolean {
    return this.known(uuid) && getMeta(this.replica(uuid).doc).uuid !== "";
  }

  /**
   * Restore must refresh title/tags changed while archived, when ordinary stub
   * repair was skipped. Write only differences; return false if not hydrated.
   */
  republishStub(uuid: string): boolean {
    if (!this.hydrated(uuid)) {
      return false;
    }
    // Restore repairs metadata without stamping a new document edit.
    this.repairStub(getMeta(this.replica(uuid).doc), false);
    return true;
  }

  /**
   * Preserve the document-order winner used by reads so concurrent duplicate
   * repairs converge on stable block IDs. Repairs are logged local writes;
   * skip poisoned replicas and write nothing when no repair is needed.
   */
  private repairDuplicates(replica: Replica): void {
    if (this.persistenceFailure !== null) {
      return;
    }
    try {
      // Repairs run below the tool's content gate, including on decided
      // records and on late legacy writes from an outdated local process.
      removeLegacyMermaidBlocks(replica.doc);
      // Same-id replacement plus duplicate repair makes simultaneous
      // converters converge rather than duplicating rows inside a table.
      normalizeLegacyTables(replica.doc);
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
   * Repair cached metadata without churning sticky tombstones. Description
   * updates are whole-field metadata writes, like renames, not keystrokes.
   * Cache comparisons are shared with web, which uses transaction.local,
   * its own clock and its own coarseness window for authored stamping.
   */
  private repairStub(meta: DocMeta, authored: boolean): void {
    const directory = this.directory();
    if (isDirectoryEntryDeleted(directory.doc, meta.uuid)) return;
    const stub = getDirectoryEntry(directory.doc, meta.uuid);
    if (meta.kind !== "decision" && stub?.deleted === true) {
      return;
    }
    const now = Date.now();
    const fields = documentDirectoryFields(this.replica(meta.uuid).doc);
    const metaChanged = directoryStubDiffers(stub, meta, fields);
    const staleStamp =
      stub?.updatedAt === undefined ||
      now - stub.updatedAt >= this.config.updatedAtCoarsenessMs;
    // Stamp authored writes, including local repairs prompted by remote state,
    // never receipt, replay, rebuild or restore. Metadata changes stamp now;
    // content-only bursts share a coarseness window. The directory's resolved
    // maximum suppresses peer stamps and keeps future-skewed values until a
    // later authored stamp exceeds them, even if a whole-entry write loses.
    const stamp = authored && (metaChanged || staleStamp);
    // Backfill createdAt once even without other changes or an updatedAt stamp.
    if (!metaChanged && !stamp && stub?.createdAt !== undefined) {
      return;
    }
    upsertDirectoryEntry(directory.doc, {
      uuid: meta.uuid,
      title: meta.title,
      tags: meta.tags,
      // State this replica's answer, including absence. Stubs converge LWW;
      // a replica holding newer document state repairs the cache on an update.
      description: meta.description ?? "",
      // Explicit absence clears a stale cached lifecycle instead of retaining it.
      kind: meta.kind ?? "",
      status: meta.status ?? "",
      ...fields,
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
        // Catch tombstones missed by observers during hydration or old rebuilds.
        // Queue actual deletes so lock waits do not multiply with the backlog;
        // an already absent index row costs only a read.
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
   * Before tools read, poll every replica for peer writes and attach discovered
   * documents. Boot/reconnect hydration waits are bounded and skipped when the
   * hub is unreachable, so fresh clients can enumerate and search after syncing.
   */
  async settle(options: { requireHealthy?: boolean } = {}): Promise<void> {
    const requireHealthy = options.requireHealthy !== false;
    if (!requireHealthy && this.store.isRemoved()) {
      this.sync.quarantine();
      return;
    }
    if (requireHealthy) {
      this.assertHealthy();
    }
    if (this.destroyed) {
      return;
    }

    // Diagnostics may inspect poisoned state, never refresh it: index/stub
    // repair would expose unlogged changes, and compaction would make them durable.
    if (this.persistenceFailure !== null) {
      return;
    }

    // Share hydration with concurrent callers so none serves a half-filled corpus.
    const inFlight = this.settling;
    if (inFlight !== null) {
      await inFlight;
      // Cheap and local: pick up anything logged while we were waiting.
      if (this.persistenceFailure === null) {
        this.refreshReplicas();
        this.recordLastSyncIfCaughtUp();
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

    // An append may fail during the waits; re-check before serving any result.
    if (requireHealthy) {
      this.assertHealthy();
    }
  }

  /** Synchronous local settle work, safe on refresh ticks without waiting for the hub. */
  refresh(): void {
    this.refreshLocal();
    for (const listener of this.refreshListeners) listener();
  }

  private refreshLocal(): void {
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
    this.recordLastSyncIfCaughtUp();
  }

  /** Await hub acknowledgement of the replica, never hub storage. */
  async waitForSettled(options: {
    /** Omitted requires acknowledgement of every attached room. */
    rooms?: readonly string[];
    /** Absolute monotonic deadline, also bounded by connect and sync budgets. */
    deadline?: number;
  } = {}): Promise<SyncWaitResult> {
    return this.sync.waitForQuiet({
      ...(options.deadline === undefined ? {} : { deadline: options.deadline }),
      subscribe: (wake) => {
        const unsubscribeAppend = this.store.onAppend(wake);
        this.refreshListeners.add(wake);
        return () => {
          unsubscribeAppend();
          this.refreshListeners.delete(wake);
        };
      },
      isQuiet: () => {
        if (this.destroyed || this.persistenceFailure !== null) return false;
        // Acknowledgement alone does not release local pending markers or
        // discover rooms delivered through the directory handshake.
        this.refreshLocal();
        const state = collectReplicaSyncState(this);
        if (options.rooms === undefined) return state.caughtUp;
        return state.hub.status === "connected" &&
          !this.sync.isDraining() && this.store.pendingRooms().length === 0 &&
          options.rooms.every((room) => state.acknowledged.get(room) === true);
      },
    });
  }

  /** Await only durable local changes, leaving unrelated hydration out of shutdown. */
  async waitForPendingChanges(deadline: number): Promise<number> {
    if (this.store.isRemoved()) {
      this.sync.quarantine();
      return 0;
    }
    if (!this.sync.enabled || this.persistenceFailure !== null) {
      return this.store.pendingRooms().length;
    }
    // Poll before releasing markers: a local append has not advanced lastSeq.
    this.refresh();
    const rooms = this.store.pendingRooms().map(({ room }) => room);
    if (rooms.length > 0) {
      await this.sync.waitForQuiet({
        isQuiet: () => rooms.every((room) => this.sync.isRoomQuiet(room)),
        deadline,
      });
      if (this.persistenceFailure === null) this.refresh();
    }
    return this.store.pendingRooms().length;
  }

  /** Replay the log tail and attach newly discovered documents. Synchronous. */
  private refreshReplicas(): void {
    this.poll(this.directory());
    this.purgeDeletedDocs();
    this.pollAll();
    this.adoptKnownDocs();
    // Retry even without another directory update; each call drains at most
    // one previously refused entry, so untouched documents still recover.
    if (this.staleStubs.size > 0 || this.pacedStubs.size > 0) {
      this.reconcileDirectory();
    }
  }

  /** Run only after directory evidence is logged; stale peers may add rows again. */
  private purgeDeletedDocs(): void {
    if (this.persistenceFailure !== null) return;
    const directory = this.directory();
    enforceDeletedDirectoryEntries(directory.doc);
    this.assertHealthy();
    for (const uuid of listDeletedDirectoryUuids(directory.doc)) {
      const room = roomForDoc(this.config.workspaceId, uuid);
      this.sync.detach(room);
      const replica = this.replicas.get(room);
      if (replica !== undefined) {
        this.replicas.delete(room);
        for (const timers of [this.cursorTimers, this.presenceTimers]) {
          const timer = timers.get(room);
          if (timer !== undefined) clearTimeout(timer);
          timers.delete(room);
        }
        replica.awareness.destroy();
        replica.doc.destroy();
      }
      this.staleStubs.delete(uuid);
      this.pacedStubs.delete(uuid);
      try {
        this.store.purgeDoc(room, uuid);
      } catch (error) {
        this.persistenceFailure ??= { room, error };
        this.sync.quarantine();
        log.error("failed to remove a permanently deleted document", { room, error: String(error) });
        return;
      }
    }
  }

  private async runSettle(): Promise<void> {
    this.refreshReplicas();

    if (this.sync.enabled && this.settleNeeded) {
      try {
        await this.sync.waitForQuiet();
        // Re-check after each await: remote appends can fail while waiting.
        if (this.persistenceFailure !== null) return;
        this.pollAll();
        if (this.adoptKnownDocs() > 0) {
          await this.sync.waitForQuiet();
          if (this.persistenceFailure !== null) return;
          this.pollAll();
        }
      } finally {
        // Clear only after waiting. Queued room waves keep settling owed on
        // the next call without extending this call's hydration budget.
        this.settleNeeded = this.sync.isDraining();
      }
    }

    if (this.persistenceFailure !== null) return;
    this.releaseQuietRooms();
    this.compactLargeLogs();
    this.recordLastSyncIfCaughtUp();
  }

  /**
   * Best-effort acknowledgement metadata, independent of replica persistence.
   * Throttle on a monotonic clock so wall-clock corrections cannot increase
   * the write rate. The store's atomic max handles other processes and skew.
   */
  recordLastSyncIfCaughtUp(): void {
    if (this.destroyed || this.persistenceFailure !== null) return;
    const monotonicNow = performance.now();
    if (this.lastSyncWriteAt !== null && monotonicNow - this.lastSyncWriteAt < 5_000) return;
    if (this.sync.state().status !== "connected") return;
    try {
      if (!collectReplicaSyncState(this).caughtUp) return;
      // Pace failed attempts too: an unavailable metadata key must not flood
      // stderr or starve the replica engine's normal work.
      this.lastSyncWriteAt = monotonicNow;
      this.store.recordLastSync(Date.now());
    } catch (error) {
      log.warn("failed to record last sync time", error);
    }
  }

  /** Read optional metadata without turning its failure into a replica failure. */
  readLastSync(): string | null {
    try {
      const timestamp = this.store.readLastSync();
      return timestamp === null ? null : new Date(timestamp).toISOString().replace(/\.\d{3}Z$/, "Z");
    } catch (error) {
      log.warn("failed to read last sync time", error);
      return null;
    }
  }

  /**
   * Clear quiet rooms only through min(marker, lastSeq), the cut this replica
   * could have acknowledged. A peer may raise the marker after our poll;
   * unknown rooms and updates beyond our applied cut must remain pending.
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

  /** Snapshot and prune atomically through lastSeq, which this replica has applied. */
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

  /** FTS5, tags and links are rebuildable from log-hydrated Y.Docs, never authoritative. */
  rebuildIndex(): void {
    this.store.clearDerived();
    this.adoptKnownDocs();
    for (const replica of this.replicas.values()) {
      // Rebuilding an index is not editing a document.
      this.afterChange(replica, false);
    }
  }

  /** Publish a TTL-bound caret using y-prosemirror's cursor {anchor, head} wire format. */
  publishCursor(replica: Replica, blockId: string, index: number): void {
    if (!this.publishOwnPresence) {
      return;
    }
    let text: Y.XmlText | Y.XmlElement | null = blockText(replica.doc, blockId);
    if (text === null) {
      // y-prosemirror leaves an empty paragraph without an XmlText. Anchor at
      // that paragraph's start rather than creating text just for awareness.
      const element = findBlockElement(replica.doc, blockId);
      const paragraph = element?.nodeName === "table"
        ? tableRows(element).at(-1)?.at(-1)?.firstChild
        : element?.nodeName === "card"
        ? cardPartElement(element, cardCursorPart(element))?.firstChild
        : element?.nodeName === "figma"
        ? figmaCaptionElement(element)?.firstChild
        : null;
      if (paragraph instanceof Y.XmlElement) text = paragraph;
    }
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
    // Arm presence after the caret timer so identity lasts at least as long as
    // the caret, regardless of how long the write took.
    this.touch(replica);
  }

  /** Whether a room's local changes are known to have reached the hub. */
  isRoomQuiet(room: string): boolean {
    return this.sync.isRoomQuiet(room);
  }

  attachedReplicas(): Replica[] {
    return [...this.replicas.values()];
  }

  destroy(): void | Promise<void> {
    if (this.destroyed) {
      return this.closing ?? undefined;
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
    this.closing = this.sync.destroy();
    for (const replica of this.replicas.values()) {
      replica.awareness.destroy();
      replica.doc.destroy();
    }
    this.replicas.clear();
    return this.closing;
  }
}

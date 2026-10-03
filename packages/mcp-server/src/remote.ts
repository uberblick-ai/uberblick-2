/**
 * The two halves of a one-time bridge between a workspace and a hub.
 *
 * `ub remote join` is the one command that composes both: it reads the remote
 * as a fresh client, refuses what it cannot verify, and only then attaches this
 * machine's replica to it. Each half is also used alone — `ub doctor`'s hub
 * probe inspects, `ub init`'s starter seed syncs. They live here because they
 * are about Y.Docs and hub connections rather than about a command line:
 *
 * - {@link syncWorkspace} boots a real replica set over the mirror, hydrates it
 *   from a hub, and reports the corpus that ended up in the update log. It is
 *   the *acting* half: what it pulls down is logged, and what the log already
 *   holds is pushed up, because that is what attaching a replica to a hub does.
 * - {@link inspectRemote} opens throwaway Y.Docs against a hub and reports what
 *   a **fresh client would see there**. It is the *observing* half: no mirror,
 *   no update log, no awareness state, and nothing written to the hub — which
 *   is what lets a refusal ("that hub already holds documents") be reached
 *   without having touched anything.
 *
 * **Why an observer at all, when the replica set already reports `synced`.**
 * `HubSync.waitForQuiet` is a bounded best-effort wait: it returns when every
 * attached room is quiet *or* when the clock runs out, and the caller cannot
 * tell those apart from the outside. A bridge that persisted a new endpoint on
 * the strength of a timer would, on a slow link, tell somebody their documents
 * are on a machine that has never seen them. So completion is established by
 * asking the far side, and by three separate facts, all of which must hold:
 *
 * 1. Every room opened for this reading is *quiet* — {@link Corpus.unsettled}
 *    is empty. A bounded wait that expired is a failure, not a result.
 * 2. The full directory and every room selected for content verification
 *    arrived — {@link Corpus.missing} is empty.
 * 3. The directories agree in **both directions**, tombstones included, and
 *    content agrees for every archived document plus one live document. Not
 *    "the far side has everything we have": also "the far side has nothing we
 *    do not", because a document that appeared over there mid-bridge means the
 *    snapshot this was verified against is already stale.
 *
 * **What counts as agreement.** {@link docFingerprint} covers the whole
 * schema-owned surface — meta, blocks, the inline marks on them, the ordered
 * decisions slot, and the annotations map — because `Block.rev` alone covers
 * type, text and attributes and would let a remote missing every bold run and
 * every comment thread pass.
 * Alongside it, state vectors are compared directly, which catches any struct
 * one side holds and the other does not, whatever it belongs to.
 *
 * A hash of `encodeStateAsUpdate` is deliberately *not* what is compared: those
 * bytes depend on how items happened to be split and merged during
 * integration, so two replicas that have genuinely converged can encode
 * differently and a byte comparison would fail a promotion that worked. State
 * vectors and schema-level content are both representation-independent.
 *
 * Tombstoned documents travel too. The directory doc carries the tombstone and
 * the document room carries the content it hides, so a later restore on a fresh
 * replica can recover the same blocks and annotations rather than an empty
 * room.
 */

import { createHash } from "node:crypto";
import {
  directoryRoom,
  getAnnotationsMap,
  getBlockInline,
  getBlocks,
  getMeta,
  listAnnotationRanges,
  listDirectory,
  readDecisions,
  roomForDoc,
} from "@uberblick/schema";
import { Awareness } from "y-protocols/awareness";
import * as Y from "yjs";
import type { McpConfig } from "./config.js";
import { Replicas } from "./replica.js";
import { MirrorStore } from "./store.js";
import type { HubState } from "./sync.js";
import { HubSync } from "./sync.js";

/**
 * How long a bridge waits for a hub to answer, and for its rooms to go quiet.
 *
 * Deliberately far more generous than a tool call's budget. A tool call must
 * never block on the network, so `resolveMcpConfig` keeps those waits down in
 * the seconds; a bridge is a one-time operation a human is watching, moving a
 * whole corpus over a link that may be a laptop's tether.
 */
export const BRIDGE_CONNECT_TIMEOUT_MS = 5_000;

/**
 * Generous, but finite and short enough to be *reached* rather than endured. A
 * hub that connects and then never finishes syncing is a real failure mode —
 * the far side is up but not serving this room — and it is only distinguishable
 * from success because this budget runs out and says so.
 */
export const BRIDGE_SYNC_TIMEOUT_MS = 15_000;

/** The same configuration, pointed at another hub with a bridge's patience. */
export function bridgeConfig(
  config: McpConfig,
  overrides: { hubUrl?: string; authSecret?: string | null } = {},
): McpConfig {
  return {
    ...config,
    hubUrl: overrides.hubUrl ?? config.hubUrl,
    authSecret:
      overrides.authSecret === undefined ? config.authSecret : overrides.authSecret,
    connectTimeoutMs: BRIDGE_CONNECT_TIMEOUT_MS,
    syncTimeoutMs: BRIDGE_SYNC_TIMEOUT_MS,
  };
}

export interface CorpusDoc {
  uuid: string;
  /**
   * The directory stub's title and tags — not the document's own meta.
   *
   * The stub remains the discovery authority for an archived document. Its
   * room is opened when a bridge moves or verifies it, but its document meta
   * may have changed on a replica that had not seen the tombstone, so the stub
   * is still compared independently.
   */
  title: string;
  tags: string[];
  /** Tombstoned in the directory. The room and its content remain intact. */
  deleted: boolean;
  /**
   * Content hash of the whole document, or null when this reading did not open
   * the room.
   */
  fingerprint: string | null;
  /** The document's Yjs state vector, or null as above. */
  stateVector: Uint8Array | null;
}

export interface Corpus {
  /** Where this reading came from, and whether it can be believed. */
  hub: HubState;
  /** Every directory entry, live and tombstoned alike. */
  entries: CorpusDoc[];
  /**
   * Inspected directory entries whose document did not arrive. Never
   * empty-and-fine: a directory naming a document nothing can produce is an
   * incomplete sync, and every caller here treats it as a failure.
   */
  missing: { uuid: string; title: string }[];
  /**
   * Rooms the hub has not acknowledged. A bounded wait that ran out leaves
   * entries here, which is exactly the case a quiet timer cannot distinguish
   * from success.
   */
  unsettled: string[];
  /**
   * Whether this reading finished. **A corpus that is not complete says nothing
   * about what the hub holds**, and in particular an empty `entries` on an
   * incomplete reading is not an empty hub.
   *
   * This is the third answer, and it exists because the other two are not
   * enough. `waitForQuiet` returns identically when the directory went quiet
   * and when the clock ran out, and in the second case the connection is still
   * up — so `hub.status` says `connected` and `entries` is empty, which reads
   * exactly like a blank hub ready to be attached to. Deciding a refusal from
   * that would attach a populated mirror to a hub whose contents were never
   * read, and attaching is a merge.
   */
  complete: boolean;
}

/** The untombstoned documents of a corpus. */
export function liveDocs(corpus: Corpus): CorpusDoc[] {
  return corpus.entries.filter((entry) => !entry.deleted);
}

/**
 * A value with every object key sorted, recursively.
 *
 * The document fingerprint passes each thread's plain JSON `toJSON()` value
 * here, alongside its metadata and each inline run's marks. One thread's
 * updates can reach two replicas in different orders; nothing guarantees the
 * two decodings enumerate their keys identically. A fingerprint that depends
 * on key order would report
 * divergence between documents that are in fact the same, and this bridge fails
 * closed — so a false difference is a promotion that refuses to finish.
 */
function canonical(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(canonical);
  }
  if (typeof value !== "object" || value === null) {
    return value;
  }
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(value as Record<string, unknown>).sort()) {
    out[key] = canonical((value as Record<string, unknown>)[key]);
  }
  return out;
}

/**
 * A content hash of one document, over everything the schema puts in it.
 *
 * Meta, the ordered blocks, the inline marks on those blocks, the ordered
 * decision references, and the annotations map — which is the whole documented
 * layout (`meta`, `blocks`, `decisions`, `annotations`), so nothing a document
 * can carry is outside this.
 *
 * **Meta is hashed as `getMeta` returns it, not as a list of fields named
 * here.** The list this used to carry went stale three times without anyone
 * noticing: `description`, `kind` and `status` each landed in `DocMeta` after
 * this function was written and none of them reached it (#526). Deriving the
 * coverage is what makes the claim above true rather than aspirational — a
 * field added to `getMeta` is inside the hash the moment it exists, and there
 * is no second place to remember. `getMeta` is also the normalising read, so
 * two documents it reports identically hash identically: a cleared `kind` and
 * one never set are both simply absent. Only `tags` and `links` are reshaped,
 * by sorting, because their order is not content.
 *
 * The annotations map is read through `toJSON()` because a thread's value is a
 * Y.Map with its conversation nested inside it, not plain JSON. That is what
 * brings the comments into the hash, in their stored order: the order is the
 * converged Yjs array order, identical on every replica, and it is content —
 * two replicas holding the same replies in different sequence are not the same
 * document.
 *
 * `Block.rev` supplies the per-block part because it is already the schema's
 * answer to "has this block's content changed" — type, text and attributes. It
 * deliberately does **not** cover inline marks, so the marks are hashed here
 * beside it rather than assumed; a remote that received the text of every block
 * and none of its formatting, or none of its comment threads, must not be able
 * to pass verification.
 *
 * **Anchors are content too, and nothing else here sees them.**
 * `getBlockInline` strips the `comment` mark, the annotations map holds no
 * positions, and a state vector says nothing about a delete set — so an undo
 * that removes an anchor leaves the text, the state vector and the thread record
 * all identical while the range a reader sees has moved or vanished. The
 * anchored runs are therefore hashed per block, which is where they live.
 */
export function docFingerprint(doc: Y.Doc): string {
  const meta = getMeta(doc);
  const annotations = getAnnotationsMap(doc).toJSON();
  const state = {
    meta: canonical({
      ...meta,
      tags: [...meta.tags].sort(),
      links: [...meta.links].sort(),
    }),
    decisions: readDecisions(doc).map((reference) => reference.uuid),
    blocks: getBlocks(doc).map((block) => ({
      id: block.id,
      rev: block.rev,
      inline: getBlockInline(doc, block.id).map((run) => ({
        text: run.text,
        marks: canonical(run.marks),
      })),
      anchors: listAnnotationRanges(doc, block.id).map((run) => ({
        threadId: run.threadId,
        start: run.start,
        end: run.end,
      })),
    })),
    annotations: Object.keys(annotations)
      .sort()
      .map((key) => [key, canonical(annotations[key])]),
  };
  return createHash("sha256")
    .update(JSON.stringify(state))
    .digest("hex")
    .slice(0, 16);
}

/** Whether `target` holds every struct `source` does. */
function coversClocks(source: Uint8Array, target: Uint8Array): boolean {
  const want = Y.decodeStateVector(source);
  const have = Y.decodeStateVector(target);
  for (const [client, clock] of want) {
    if ((have.get(client) ?? 0) < clock) {
      return false;
    }
  }
  return true;
}

/**
 * Whether two readings of the same document agree.
 *
 * Both tests, not either: the fingerprint is schema-level and would miss a
 * struct belonging to nothing the schema reads, and the state vectors are
 * structural and would miss a difference that is only in the delete set. A
 * side that was not opened contributes nothing to its half of the comparison —
 * a directory-only reading is not evidence of agreement, and callers that need
 * evidence open the documents.
 */
function sameDoc(a: CorpusDoc, b: CorpusDoc): boolean {
  if (a.deleted !== b.deleted) {
    return false;
  }
  // The directory stub, compared semantically: it remains discovery truth for
  // a tombstone, and tag order is not meaningful.
  if (a.title !== b.title || !sameTags(a.tags, b.tags)) {
    return false;
  }
  if (a.fingerprint !== null && b.fingerprint !== null && a.fingerprint !== b.fingerprint) {
    return false;
  }
  if (a.stateVector !== null && b.stateVector !== null) {
    if (!coversClocks(a.stateVector, b.stateVector)) return false;
    if (!coversClocks(b.stateVector, a.stateVector)) return false;
  }
  return true;
}

function sameTags(a: readonly string[], b: readonly string[]): boolean {
  if (a.length !== b.length) return false;
  const left = new Set(a);
  for (const tag of b) {
    if (!left.has(tag)) return false;
  }
  return true;
}

function emptyCorpus(hub: HubState): Corpus {
  // Never `complete`: nothing was read, so nothing is known.
  return { hub, entries: [], missing: [], unsettled: [], complete: false };
}

function directoryOnly(entry: {
  uuid: string;
  title: string;
  tags: string[];
  deleted?: boolean;
}): CorpusDoc {
  return {
    uuid: entry.uuid,
    title: entry.title,
    tags: entry.tags,
    deleted: entry.deleted === true,
    fingerprint: null,
    stateVector: null,
  };
}

/**
 * What a fresh client would find on a hub. Reads; never writes.
 *
 * The documents it opens are empty Y.Docs with no mirror behind them, so
 * nothing observed here is logged and nothing held here is uploaded. Its
 * awareness state is left unset as well — a probe must not appear in the web
 * UI as a ghost collaborator.
 *
 * @param options.documents `true` opens every document the directory names and
 * fingerprints it. `"sample"` opens every archived document plus one live
 * document, which keeps large-corpus join verification bounded without ever
 * claiming an archived room moved from its tombstone alone. Off where the
 * caller needs only the directory entries.
 *
 * @param options.silent Keep this probe's hub reading off stderr, for a caller
 * that renders `hub` itself. Off by default, because most callers here are the
 * only place a refusal is ever named: `ub open` reduces its probe to a boolean,
 * so silencing every probe would trade one stray line for a lost diagnostic
 * (#447). {@link HubSync}'s `silent` option names the three lines it covers.
 */
export async function inspectRemote(
  config: McpConfig,
  options: { documents?: boolean | "sample"; silent?: boolean } = {},
): Promise<Corpus> {
  const sync = new HubSync(config, () => {}, { silent: options.silent === true });
  const opened = new Map<string, { doc: Y.Doc; awareness: Awareness }>();

  const open = (room: string): Y.Doc => {
    const doc = new Y.Doc();
    const awareness = new Awareness(doc);
    // Publish nothing: this client observes a hub, it does not join a session.
    awareness.setLocalState(null);
    opened.set(room, { doc, awareness });
    sync.attach({ room, doc, awareness });
    return doc;
  };

  try {
    if (!sync.enabled) {
      return emptyCorpus(sync.state());
    }

    const dirRoom = directoryRoom(config.workspaceId);
    const dirDoc = open(dirRoom);
    await sync.waitForQuiet();
    if (sync.state().status !== "connected") {
      return emptyCorpus(sync.state());
    }
    // "Read it and it holds nothing" and "could not finish reading it" are
    // different answers, and only one of them means the hub is empty. A
    // directory room that connected but never went quiet inside the sync budget
    // is the second, and reporting it as a corpus of zero documents is how a
    // bridge would decide a populated hub was safe to attach a mirror to.
    if (!sync.isRoomQuiet(dirRoom)) {
      return {
        hub: sync.state(),
        entries: [],
        missing: [],
        unsettled: [dirRoom],
        complete: false,
      };
    }

    const all = listDirectory(dirDoc, { includeDeleted: true });
    const live = all.filter((entry) => entry.deleted !== true);
    const dead = all.filter((entry) => entry.deleted === true);

    if (options.documents !== true && options.documents !== "sample") {
      return {
        hub: sync.state(),
        entries: all.map(directoryOnly),
        missing: [],
        unsettled: [],
        complete: true,
      };
    }

    const selected = new Set(
      (options.documents === "sample"
        ? [...dead, ...(live[0] === undefined ? [] : [live[0]])]
        : all
      ).map((entry) => entry.uuid),
    );
    for (const entry of all) {
      if (!selected.has(entry.uuid)) continue;
      open(roomForDoc(config.workspaceId, entry.uuid));
    }
    await sync.waitForQuiet();
    if (sync.state().status !== "connected") {
      return emptyCorpus(sync.state());
    }

    const entries: CorpusDoc[] = [];
    const missing: { uuid: string; title: string }[] = [];
    const unsettled: string[] = [];
    for (const entry of all) {
      if (!selected.has(entry.uuid)) {
        entries.push(directoryOnly(entry));
        continue;
      }
      const room = roomForDoc(config.workspaceId, entry.uuid);
      const held = opened.get(room);
      if (!sync.isRoomQuiet(room)) {
        unsettled.push(room);
      }
      // An empty `meta.uuid` is the one reliable "this document has not
      // arrived": the room is named after the uuid, so its name proves nothing.
      if (held === undefined || getMeta(held.doc).uuid === "") {
        missing.push({ uuid: entry.uuid, title: entry.title });
        continue;
      }
      entries.push({
        uuid: entry.uuid,
        title: entry.title,
        tags: entry.tags,
        deleted: entry.deleted === true,
        fingerprint: docFingerprint(held.doc),
        stateVector: Y.encodeStateVector(held.doc),
      });
    }
    // Complete: the directory was read in full. An inspected document that did
    // not arrive lands in `missing`, which every caller already refuses on —
    // only the directory read can fail in a way that looks like emptiness.
    return {
      hub: sync.state(),
      entries,
      missing,
      unsettled,
      complete: true,
    };
  } finally {
    sync.destroy();
    await sync.waitForDeviceWork();
    for (const { doc, awareness } of opened.values()) {
      awareness.destroy();
      doc.destroy();
    }
  }
}

/** The corpus a hydrated replica set holds, read out of its documents. */
function readCorpus(replicas: Replicas): Corpus {
  const all = listDirectory(replicas.directory().doc, { includeDeleted: true });
  const attached = new Map(
    replicas.attachedReplicas().map((replica) => [replica.id, replica]),
  );

  const entries: CorpusDoc[] = [];
  const missing: { uuid: string; title: string }[] = [];
  const unsettled: string[] = [];
  for (const replica of replicas.attachedReplicas()) {
    if (!replicas.isRoomQuiet(replica.room)) {
      unsettled.push(replica.room);
    }
  }
  for (const entry of all) {
    const replica = attached.get(entry.uuid);
    if (replica === undefined || getMeta(replica.doc).uuid === "") {
      // The stub is still evidence that this workspace has been used, even
      // when nobody can produce its archived room. Callers such as the starter
      // guard need that evidence; `missing` still makes a bridge fail closed.
      if (entry.deleted === true) {
        entries.push(directoryOnly(entry));
      }
      missing.push({ uuid: entry.uuid, title: entry.title });
      continue;
    }
    entries.push({
      uuid: entry.uuid,
      title: entry.title,
      tags: entry.tags,
      deleted: entry.deleted === true,
      fingerprint: docFingerprint(replica.doc),
      stateVector: Y.encodeStateVector(replica.doc),
    });
  }
  return { hub: replicas.sync.state(), entries, missing, unsettled, complete: true };
}

/**
 * Attach the mirror at `config.databasePath` to the hub at `config.hubUrl`,
 * hydrate everything, and report what the update log ends up holding.
 *
 * This has no direction of its own, because attaching a replica to a hub
 * reconciles the two: a populated mirror against an empty hub uploads, an empty
 * mirror against a populated hub downloads, and two populated sides merge as
 * CRDTs with neither discarded. `ub remote join` relies on all three — the
 * machine that ran `ub remote init` joins the workspace it already holds — so
 * what is being joined is established by the caller, before this is called,
 * rather than inferred here from which side happens to be empty.
 *
 * Hydration is the two-pass shape the seed import relies on and for the same
 * reason: the directory has to arrive before the documents it names can be
 * attached. `Replicas.settle` does both passes; the extra wait after it is what
 * gives the last round of attachments a chance to finish.
 *
 * The store is opened and closed around one call, so consecutive phases share
 * the mirror through the file rather than through a handle. That is what "the
 * same MCP mirror" means here, and it keeps a phase from leaving a database
 * open across a network wait.
 */
export async function syncWorkspace(config: McpConfig): Promise<Corpus> {
  const store = new MirrorStore(config.databasePath, config.workspaceId);
  const replicas = new Replicas(config, store);
  try {
    await replicas.settle();
    // Ordinary MCP sessions leave tombstoned rooms detached: discovery and
    // search need only the directory stub. A bridge is different — the hidden
    // room is what makes restore meaningful on another machine, so attach every
    // directory entry before waiting for the corpus to arrive.
    for (const entry of listDirectory(replicas.directory().doc, {
      includeDeleted: true,
    })) {
      replicas.replica(entry.uuid);
    }
    await replicas.sync.waitForQuiet();
    // The log is the replica: a failed append means what follows would be read
    // out of a document the log does not back.
    replicas.assertHealthy();
    return readCorpus(replicas);
  } finally {
    replicas.destroy();
    await replicas.sync.waitForDeviceWork();
    store.close();
  }
}

export interface CorpusDifference {
  /** In `expected`, absent from `found`. */
  missing: CorpusDoc[];
  /** In both, disagreeing about content, marks, annotations or tombstoning. */
  differing: CorpusDoc[];
  /** In `found`, absent from `expected`. */
  extra: CorpusDoc[];
}

export function isIdentical(difference: CorpusDifference): boolean {
  return (
    difference.missing.length === 0 &&
    difference.differing.length === 0 &&
    difference.extra.length === 0
  );
}

/**
 * Compare two corpora by uuid, and by content wherever both sides opened the
 * document.
 *
 * `extra` is what makes the refusals precise: a hub holding documents this
 * workspace has never heard of is a *second populated workspace*, and merging
 * those is out of scope. Reading it as a set difference rather than as "is the
 * other side empty" is also what lets a rerun finish — a promotion interrupted
 * halfway leaves a remote that holds a subset.
 *
 * **A refusal is decided on uuids alone; `differing` is for verification.** An
 * overlapping uuid is the same document, and the same document on two hubs is
 * one lineage that Yjs merges — re-promoting it converges its own history,
 * which is exactly the rerun the two verbs are meant to support. Content only
 * decides anything at read-back time, where the question is not "may this
 * proceed" but "did what just happened actually land".
 *
 * Tombstoned entries take part in the set difference. They carry no content to
 * compare, but their presence is content: a hub whose directory names documents
 * this workspace has never heard of has been used by somebody else, whether or
 * not those documents are still live.
 */
export function compareCorpus(
  expected: readonly CorpusDoc[],
  found: readonly CorpusDoc[],
): CorpusDifference {
  const byUuid = new Map(found.map((doc) => [doc.uuid, doc]));
  const missing: CorpusDoc[] = [];
  const differing: CorpusDoc[] = [];
  for (const doc of expected) {
    const other = byUuid.get(doc.uuid);
    if (other === undefined) {
      missing.push(doc);
    } else if (!sameDoc(doc, other)) {
      differing.push(doc);
    }
  }
  const known = new Set(expected.map((doc) => doc.uuid));
  const extra = found.filter((doc) => !known.has(doc.uuid));
  return { missing, differing, extra };
}

/**
 * The two halves of a one-time bridge between a workspace and a hub.
 *
 * `ub remote promote` and `ub remote join` are compositions of exactly two
 * operations, and both live here because both are about Y.Docs and hub
 * connections rather than about a command line:
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
 * asking the far side: {@link inspectRemote} downloads the directory and every
 * document it names into empty documents and fingerprints them, and the caller
 * compares those fingerprints with the ones it holds. That is the second
 * computer's experience, verified before anything is persisted.
 *
 * Neither function moves a tombstoned document. The directory doc travels
 * wholesale, so tombstones replicate as directory state and an archived
 * document stays archived on the far side; its *room* is not uploaded, because
 * "every live document" is what a bridge is for.
 */

import { createHash } from "node:crypto";
import {
  directoryRoom,
  getBlocks,
  getMeta,
  listDirectory,
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

export const BRIDGE_SYNC_TIMEOUT_MS = 30_000;

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
  title: string;
  /**
   * A content hash of the document, or null when the corpus was read without
   * opening documents — {@link inspectRemote} takes the directory alone unless
   * asked for more, because counting what a hub holds does not require
   * downloading it.
   */
  fingerprint: string | null;
}

export interface Corpus {
  /** Where this reading came from, and whether it can be believed. */
  hub: HubState;
  /** Live documents, in directory order. */
  docs: CorpusDoc[];
  /**
   * Live directory entries whose document did not arrive. Never empty-and-fine:
   * a directory naming a document nothing can produce is an incomplete sync,
   * and every caller here treats it as a failure.
   */
  missing: { uuid: string; title: string }[];
  /** Tombstoned directory entries. They replicate; their rooms do not move. */
  tombstones: number;
}

/**
 * A content hash of one document: its title, tags, links, and the ordered list
 * of its blocks' own content revisions.
 *
 * Built from `Block.rev` rather than from the text, because that hash is
 * already the schema's answer to "has this block's content changed" — type,
 * text and attributes — and reusing it keeps one definition of block identity.
 * Yjs internals are deliberately not part of it: two replicas that converged on
 * the same document through different update orders must fingerprint the same.
 */
export function docFingerprint(doc: Y.Doc): string {
  const meta = getMeta(doc);
  const parts = [
    meta.title,
    [...meta.tags].sort().join(","),
    [...meta.links].sort().join(","),
    ...getBlocks(doc).map((block) => `${block.id}:${block.rev}`),
  ];
  // JSON, not a separator character: a title may contain anything, and a
  // fingerprint that two different documents can share is not one.
  return createHash("sha256")
    .update(JSON.stringify(parts))
    .digest("hex")
    .slice(0, 16);
}

function emptyCorpus(hub: HubState): Corpus {
  return { hub, docs: [], missing: [], tombstones: 0 };
}

/**
 * What a fresh client would find on a hub. Reads; never writes.
 *
 * The documents it opens are empty Y.Docs with no mirror behind them, so
 * nothing observed here is logged and nothing held here is uploaded. Its
 * awareness state is left unset as well — a probe must not appear in the web
 * UI as a ghost collaborator.
 *
 * @param options.documents Open every document the directory names and
 * fingerprint it. Off by default: deciding whether a hub is empty needs the
 * directory alone.
 */
export async function inspectRemote(
  config: McpConfig,
  options: { documents?: boolean } = {},
): Promise<Corpus> {
  const sync = new HubSync(config, () => {});
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
    if (sync.state().status !== "connected" || !sync.isRoomQuiet(dirRoom)) {
      return emptyCorpus(sync.state());
    }

    const entries = listDirectory(dirDoc, { includeDeleted: true });
    const live = entries.filter((entry) => entry.deleted !== true);
    const tombstones = entries.length - live.length;

    if (options.documents !== true) {
      return {
        hub: sync.state(),
        docs: live.map((entry) => ({
          uuid: entry.uuid,
          title: entry.title,
          fingerprint: null,
        })),
        missing: [],
        tombstones,
      };
    }

    for (const entry of live) {
      open(roomForDoc(config.workspaceId, entry.uuid));
    }
    await sync.waitForQuiet();
    if (sync.state().status !== "connected") {
      return emptyCorpus(sync.state());
    }

    const docs: CorpusDoc[] = [];
    const missing: { uuid: string; title: string }[] = [];
    for (const entry of live) {
      const room = roomForDoc(config.workspaceId, entry.uuid);
      const held = opened.get(room);
      // An empty `meta.uuid` is the one reliable "this document has not
      // arrived": the room is named after the uuid, so its name proves nothing.
      if (
        held === undefined ||
        !sync.isRoomQuiet(room) ||
        getMeta(held.doc).uuid === ""
      ) {
        missing.push({ uuid: entry.uuid, title: entry.title });
        continue;
      }
      docs.push({
        uuid: entry.uuid,
        title: getMeta(held.doc).title,
        fingerprint: docFingerprint(held.doc),
      });
    }
    return { hub: sync.state(), docs, missing, tombstones };
  } finally {
    sync.destroy();
    for (const { doc, awareness } of opened.values()) {
      awareness.destroy();
      doc.destroy();
    }
  }
}

/** The live corpus a hydrated replica set holds, read out of its documents. */
function readCorpus(replicas: Replicas): Corpus {
  const entries = listDirectory(replicas.directory().doc, {
    includeDeleted: true,
  });
  const live = entries.filter((entry) => entry.deleted !== true);
  const attached = new Map(
    replicas.attachedReplicas().map((replica) => [replica.id, replica]),
  );

  const docs: CorpusDoc[] = [];
  const missing: { uuid: string; title: string }[] = [];
  for (const entry of live) {
    const replica = attached.get(entry.uuid);
    if (replica === undefined || getMeta(replica.doc).uuid === "") {
      missing.push({ uuid: entry.uuid, title: entry.title });
      continue;
    }
    docs.push({
      uuid: entry.uuid,
      title: getMeta(replica.doc).title,
      fingerprint: docFingerprint(replica.doc),
    });
  }
  return {
    hub: replicas.sync.state(),
    docs,
    missing,
    tombstones: entries.length - live.length,
  };
}

/**
 * Attach the mirror at `config.databasePath` to the hub at `config.hubUrl`,
 * hydrate everything, and report what the update log ends up holding.
 *
 * This is the one operation both bridge directions are built from, and it is
 * the same operation in both: attaching a replica to a hub reconciles the two,
 * so pointing a populated mirror at an empty hub uploads, and pointing an empty
 * mirror at a populated hub downloads. The direction is the caller's decision —
 * which is exactly why `promote` and `join` are separate verbs that each refuse
 * the ambiguous case, rather than one command inferring it from which side
 * happens to be empty.
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
  const store = new MirrorStore(config.databasePath);
  const replicas = new Replicas(config, store);
  try {
    await replicas.settle();
    await replicas.sync.waitForQuiet();
    // The log is the replica: a failed append means what follows would be read
    // out of a document the log does not back.
    replicas.assertHealthy();
    return readCorpus(replicas);
  } finally {
    replicas.destroy();
    store.close();
  }
}

export interface CorpusDifference {
  /** In `expected`, absent from `found`. */
  missing: CorpusDoc[];
  /** In both, with different content. */
  differing: CorpusDoc[];
  /** In `found`, absent from `expected`. */
  extra: CorpusDoc[];
}

/**
 * Compare two corpora by uuid, and by fingerprint where both sides have one.
 *
 * `extra` is what makes the refusals precise: a hub holding documents this
 * workspace has never heard of is a *second populated workspace*, and merging
 * those is out of scope. Reading it as a set difference rather than as "is the
 * other side empty" is also what makes a rerun idempotent — a promotion
 * interrupted halfway leaves a remote that holds a subset, which is a promotion
 * to finish, not a collision to refuse.
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
    } else if (
      doc.fingerprint !== null &&
      other.fingerprint !== null &&
      doc.fingerprint !== other.fingerprint
    ) {
      differing.push(doc);
    }
  }
  const known = new Set(expected.map((doc) => doc.uuid));
  const extra = found.filter((doc) => !known.has(doc.uuid));
  return { missing, differing, extra };
}

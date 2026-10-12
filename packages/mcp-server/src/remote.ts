/** Keep throwaway inspection separate from reconciliation through the durable replica. */

import { createHash } from "node:crypto";
import {
  directoryRoom,
  sidebarRoom,
  settingsRoom,
  getWorkspaceName,
  readSidebar,
  listTagCatalog,
  getAnnotationsMap,
  getBlockInline,
  findBlockElement,
  getBlocks,
  getMeta,
  getDocDataEntries,
  listAnnotationRanges,
  listDirectory,
  roomForDoc,
} from "@uberblick/schema";
import { Awareness } from "y-protocols/awareness";
import * as Y from "yjs";
import type { McpConfig } from "./config.js";
import { usesDeviceLogin } from "./config.js";
import type { Replicas } from "./replica.js";
import { openWorkspaceReplicas } from "./workspace-replicas.js";
import type { HubState } from "./sync.js";
import { HubSync } from "./sync.js";

/**
 * Bridges move a whole corpus over potentially slow links, so their finite
 * connect budget is more generous than an ordinary tool call's.
 */
export const BRIDGE_CONNECT_TIMEOUT_MS = 5_000;

/**
 * A connected hub can still fail to serve a room. Expiry must leave that room
 * unsettled rather than count as successful verification.
 */
export const BRIDGE_SYNC_TIMEOUT_MS = 15_000;

/** The same configuration, pointed at another hub with a bridge's patience. */
export function bridgeConfig(
  config: McpConfig,
  overrides: { hubUrl?: string; authSecret?: string | null } = {},
): McpConfig {
  const hubUrl = overrides.hubUrl ?? config.hubUrl;
  // An endpoint override also changes which authority can admit us. Preserve
  // an explicit stricter loopback fixture, but never carry a remote login to
  // a loopback override or a signing secret to a remote override.
  const authEnv = { ...(config.authEnv ?? config.deviceLogin?.env ?? process.env) };
  if (hubUrl !== config.hubUrl) delete authEnv.HUB_ADMISSION;
  const remote = usesDeviceLogin(hubUrl, authEnv);
  const { deviceLogin, ...rest } = config;
  return {
    ...rest,
    hubUrl,
    authEnv,
    ...(remote ? { deviceLogin: deviceLogin ?? {} }
      : hubUrl === config.hubUrl && deviceLogin !== undefined ? { deviceLogin } : {}),
    authSecret: remote ? null :
      overrides.authSecret === undefined ? config.authSecret : overrides.authSecret,
    connectTimeoutMs: BRIDGE_CONNECT_TIMEOUT_MS,
    syncTimeoutMs: BRIDGE_SYNC_TIMEOUT_MS,
  };
}

export interface CorpusDoc {
  uuid: string;
  /**
   * Compare the discovery stub separately: archived room meta may have changed
   * on a replica that had not yet seen its tombstone.
   */
  title: string;
  tags: string[];
  /** Tombstoned in the directory. The room and its content remain intact. */
  deleted: boolean;
  /** Whole-document content hash, or null when this reading did not open the room. */
  fingerprint: string | null;
  /** The document's Yjs state vector, or null as above. */
  stateVector: Uint8Array | null;
}

export interface Corpus {
  /** Settings and sidebar content/history, when explicitly inspected. */
  workspace?: CorpusDoc[];
  /** Where this reading came from, and whether it can be believed. */
  hub: HubState;
  /** Every directory entry, live and tombstoned alike. */
  entries: CorpusDoc[];
  /**
   * A named document that did not arrive is a verification failure, not an empty room.
   */
  missing: { uuid: string; title: string }[];
  /**
   * Unacknowledged rooms after the bounded wait; any entry fails verification.
   */
  unsettled: string[];
  /**
   * Whether the directory read finished; inspectRemote also waits for quiet.
   * Check unsettled separately. An incomplete empty listing proves nothing
   * about hub contents and must not permit attachment.
   */
  complete: boolean;
}

/** The untombstoned documents of a corpus. */
export function liveDocs(corpus: Corpus): CorpusDoc[] {
  return corpus.entries.filter((entry) => !entry.deleted);
}

/**
 * Sort object keys recursively: replicas can decode identical metadata, marks
 * and threads in different key order, which must not fail closed verification.
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

/** A structured prose subtree, including marks and anchors, without Yjs item ids. */
function structuredContent(element: Y.XmlElement | null): unknown {
  if (element === null) return null;
  return {
    name: element.nodeName,
    attributes: canonical(element.getAttributes()),
    children: element.toArray().map((child) => {
      if (child instanceof Y.XmlElement) return structuredContent(child);
      return canonical(child instanceof Y.XmlText ? child.toDelta() : child.toJSON());
    }),
  };
}

/**
 * Hash the schema-owned surface, including marks, threads, anchors and data.
 * Block.rev omits prose marks; state vectors omit delete-set-only changes, so
 * neither alone can prove that all reader-visible content reached the replica.
 */
export function docFingerprint(doc: Y.Doc): string {
  // Derive metadata coverage from the normalising reader, including future fields.
  const meta = getMeta(doc);
  // Decode nested Y.Maps; reply array order is content and must remain intact.
  const annotations = getAnnotationsMap(doc).toJSON();
  const data = getDocDataEntries(doc);
  const state = {
    meta: canonical({
      ...meta,
      // Tags and links are sets; their enumeration order is not content.
      tags: [...meta.tags].sort(),
      links: [...meta.links].sort(),
    }),
    blocks: getBlocks(doc).map((block) => ({
      id: block.id,
      rev: block.rev,
      inline: getBlockInline(doc, block.id).map((run) => ({
        text: run.text,
        marks: canonical(run.marks),
      })),
      // getBlockInline strips comment marks and thread records hold no positions.
      anchors: listAnnotationRanges(doc, block.id).map((run) => ({
        threadId: run.threadId,
        start: run.start,
        end: run.end,
      })),
      ...(block.type === "table" || block.type === "card" || block.type === "figma" ? {
        // Canonical text/rev can lose edge whitespace and marks. Stored part deltas retain
        // those characters, formatting and comment-anchor deletions for verification.
        cells: structuredContent(findBlockElement(doc, block.id)),
      } : {}),
    })),
    annotations: Object.keys(annotations)
      .sort()
      .map((key) => [key, canonical(annotations[key])]),
    // Include data even with unsupported schemas or invalid records. Omitting
    // empty data keeps fingerprints stable for documents without collections.
    ...(data.length === 0 ? {} : { data: canonical(data) }),
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
 * Check both schema content and struct clocks: neither covers the other's gaps.
 * Encoded-update bytes depend on integration splitting/merging and cannot prove
 * divergence. A directory-only side supplies no content-verification evidence.
 */
function sameDoc(a: CorpusDoc, b: CorpusDoc): boolean {
  if (a.deleted !== b.deleted) {
    return false;
  }
  // Tombstoned stubs remain discovery truth; tag order is not meaningful.
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
 * Inspect with empty, unlogged Y.Docs; no existing content or presence is uploaded.
 * documents: true verifies all rooms; sample verifies every archived room plus
 * one live room, bounding live-content work without trusting tombstones alone.
 * Silent is opt-in for callers rendering hub themselves; boolean-only callers
 * otherwise need this probe's diagnostic.
 */
export async function inspectRemote(
  config: McpConfig,
  options: { documents?: boolean | "sample"; silent?: boolean; workspace?: boolean } = {},
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
    // A connected but unsettled directory cannot prove an empty hub safe to attach to.
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

    const settings = options.workspace ? open(settingsRoom(config.workspaceId)) : null;
    const sidebar = options.workspace ? open(sidebarRoom(config.workspaceId)) : null;
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
      // The room name does not prove hydration; only a nonempty meta.uuid does.
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
    if (options.workspace) {
      for (const room of [settingsRoom(config.workspaceId), sidebarRoom(config.workspaceId)]) {
        if (!sync.isRoomQuiet(room)) unsettled.push(room);
      }
    }
    // Complete describes the directory read; missing and unsettled still fail verification.
    return {
      hub: sync.state(),
      entries,
      missing,
      unsettled,
      ...(settings !== null && sidebar !== null ? { workspace: workspaceSnapshot(settings, sidebar) } : {}),
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
function workspaceSnapshot(settings: Y.Doc, sidebar: Y.Doc): CorpusDoc[] {
  return [
    { uuid: "_settings", doc: settings, content: { name: getWorkspaceName(settings), tags: listTagCatalog(settings) } },
    { uuid: "_sidebar", doc: sidebar, content: readSidebar(sidebar) },
  ].map(({ uuid, doc, content }) => ({
    uuid, title: uuid, tags: [], deleted: false,
    fingerprint: createHash("sha256").update(JSON.stringify(canonical(content))).digest("hex"),
    stateVector: Y.encodeStateVector(doc),
  }));
}

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
      // Retain tombstone evidence for starter guards even without its room;
      // missing still makes bridge verification fail closed.
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
  return { hub: replicas.sync.state(), entries, missing, unsettled, complete: true,
    workspace: workspaceSnapshot(replicas.settings().doc, replicas.sidebar().doc) };
}

/**
 * Reconcile both ways through the local log; populated sides merge without
 * discarding either. The caller must verify the destination before attachment.
 * Settle hydrates directory then documents; the extra wait covers final attaches.
 * Close the store and connection after this phase; later phases reopen the same file.
 */
export async function syncWorkspace(config: McpConfig): Promise<Corpus> {
  const workspace = openWorkspaceReplicas(config);
  const { replicas } = workspace;
  try {
    await replicas.settle();
    // Carry archived content too: a tombstone alone cannot restore blocks and
    // annotations on a fresh machine, though ordinary discovery needs only its stub.
    for (const entry of listDirectory(replicas.directory().doc, {
      includeDeleted: true,
    })) {
      replicas.replica(entry.uuid);
    }
    await replicas.sync.waitForQuiet();
    // Refuse a snapshot that the authoritative log does not back.
    replicas.assertHealthy();
    return readCorpus(replicas);
  } finally {
    await workspace.close();
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
 * Compare UUID sets both ways, tombstones included, so a newly appeared remote
 * document cannot pass read-back against a stale snapshot. Extra UUIDs mean a
 * second workspace; overlapping UUIDs share Yjs lineage and permit interrupted
 * reruns. Content differences verify read-back, not permission to attach.
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

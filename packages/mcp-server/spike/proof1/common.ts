/**
 * Proof 1 — shared rig. Throwaway: nothing here is production code.
 *
 * Everything a child process needs to be an `ub mcp serve`-shaped replica over
 * one shared WAL store: the config, a MirrorStore subclass that times every
 * write transaction, get_doc/edit_block equivalents at the replica level, and
 * percentile helpers.
 */

import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import {
  appendBlock,
  editBlock,
  getBlocksWithInline,
  getBlock,
  getMeta,
  initDoc,
  listAnnotations,
  upsertDirectoryEntry,
} from "@uberblick/schema";
import type { McpConfig } from "../../src/config.js";
import { Replicas } from "../../src/replica.js";
import { MirrorStore } from "../../src/store.js";
import type { IndexedDoc, UpdateOrigin } from "../../src/store.js";

export const WORKSPACE = "3f1d9c2b-84a5-4e17-9f60-2a7b5c8d1e43";

/** Wall clock with sub-millisecond resolution, comparable across processes. */
export function now(): number {
  return performance.timeOrigin + performance.now();
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Block the whole process, the way a slow synchronous derivation would. */
export function blockingSleep(ms: number): void {
  const shared = new Int32Array(new SharedArrayBuffer(4));
  Atomics.wait(shared, 0, 0, ms);
}

export interface TimedOp {
  op: string;
  ms: number;
  at: number;
}

/**
 * A store that records how long each write transaction held SQLite, and lets a
 * case slow one operation down or route index writes through a sequenced
 * prototype.
 */
export class TimedStore extends MirrorStore {
  readonly timings: TimedOp[] = [];

  /** Errors that escaped a store call, e.g. a busy timeout expiring. */
  readonly errors: { op: string; error: string; at: number }[] = [];

  /** Milliseconds to stall inside `indexDoc` before committing (case 3). */
  indexDelayMs = 0;

  /**
   * Milliseconds to stall between being handed a snapshot and committing it,
   * so a compactor can be made to commit a cut another process has overtaken.
   */
  compactDelayMs = 0;

  private time<T>(op: string, body: () => T): T {
    const started = now();
    try {
      const result = body();
      this.timings.push({ op, ms: now() - started, at: started });
      return result;
    } catch (error) {
      this.errors.push({ op, error: String(error), at: started });
      throw error;
    }
  }

  override appendUpdate(
    room: string,
    payload: Uint8Array,
    origin: UpdateOrigin,
  ): number {
    return this.time("append", () => super.appendUpdate(room, payload, origin));
  }

  /** How often `compact` ran, and how often it actually advanced the snapshot. */
  compactCalls = 0;

  compactWrites = 0;

  /** The `throughSeq` of every compaction this process attempted, in order. */
  readonly compactions: { throughSeq: number; wrote: boolean; at: number }[] = [];

  override compact(room: string, state: Uint8Array, throughSeq: number): boolean {
    this.compactCalls += 1;
    if (this.compactDelayMs > 0) blockingSleep(this.compactDelayMs);
    const wrote = this.time("compact", () =>
      super.compact(room, state, throughSeq),
    );
    if (wrote) this.compactWrites += 1;
    this.compactions.push({ throughSeq, wrote, at: now() });
    return wrote;
  }

  override indexDoc(doc: IndexedDoc): void {
    if (this.indexDelayMs > 0) {
      blockingSleep(this.indexDelayMs);
    }
    this.time("index", () => super.indexDoc(doc));
  }

  override unindexDoc(uuid: string): void {
    this.time("unindex", () => super.unindexDoc(uuid));
  }

  override clearPending(room: string, throughSeq: number): void {
    this.time("clearPending", () => super.clearPending(room, throughSeq));
  }

  override readSince(room: string, seq: number) {
    return this.time("readSince", () => super.readSince(room, seq));
  }
}

export interface ConfigOptions {
  databasePath: string;
  hubUrl?: string;
  authSecret?: string | null;
  compactAfter?: number;
  connectTimeoutMs?: number;
  syncTimeoutMs?: number;
}

export function config(options: ConfigOptions): McpConfig {
  return {
    workspaceId: WORKSPACE,
    hubUrl: options.hubUrl ?? "ws://127.0.0.1:1",
    authSecret: options.authSecret === undefined ? null : options.authSecret,
    databasePath: options.databasePath,
    sessionId: `agent-${randomUUID()}`,
    color: "#7b5ec7",
    connectTimeoutMs: options.connectTimeoutMs ?? 150,
    syncTimeoutMs: options.syncTimeoutMs ?? 2_000,
    reconnectMaxDelayMs: 250,
    cursorTtlMs: 30_000,
    compactAfter: options.compactAfter ?? 500,
    reconcileRetryMs: 0,
    updatedAtCoarsenessMs: 5 * 60_000,
  };
}

export interface Engine {
  store: TimedStore;
  replicas: Replicas;
  config: McpConfig;
  destroy(): void;
}

/** The replica engine as `createMcpServer` builds it, minus the MCP transport. */
export function openEngine(options: ConfigOptions): Engine {
  const cfg = config(options);
  const store = new TimedStore(cfg.databasePath, cfg.workspaceId);
  const replicas = new Replicas(cfg, store);
  return {
    store,
    replicas,
    config: cfg,
    destroy() {
      replicas.destroy();
      store.close();
    },
  };
}

/** What `get_doc` does, at the replica level. */
export function readDoc(
  replicas: Replicas,
  uuid: string,
): { title: string; blocks: { id: string; text: string; rev: string }[] } {
  const replica = replicas.replica(uuid);
  replicas.touch(replica);
  const meta = getMeta(replica.doc);
  const blocks = getBlocksWithInline(replica.doc).map(({ block }) => ({
    id: block.id,
    text: block.text,
    rev: block.rev,
  }));
  // get_doc also serialises the annotation threads.
  listAnnotations(replica.doc);
  return { title: meta.title, blocks };
}

/** What `edit_block` does, at the replica level. */
export function writeBlock(
  replicas: Replicas,
  uuid: string,
  blockId: string,
  oldText: string,
  newText: string,
  rev?: string,
): void {
  const replica = replicas.replica(uuid);
  editBlock(replica.doc, blockId, oldText, newText, rev === undefined ? {} : { rev });
  replicas.publishCursor(replica, blockId, newText.length);
}

export function blockText(replicas: Replicas, uuid: string, blockId: string): string {
  return getBlock(replicas.replica(uuid).doc, blockId)?.text ?? "";
}

/** Create a document the way `create_doc` does: document room, then directory. */
export function createDoc(
  replicas: Replicas,
  title: string,
  texts: string[],
): { uuid: string; blockIds: string[] } {
  const uuid = randomUUID();
  const replica = replicas.replica(uuid);
  const blockIds: string[] = [];
  replica.doc.transact(() => {
    initDoc(replica.doc, { uuid, title, description: `${title} description`, tags: ["proof1"] });
    for (const text of texts) {
      blockIds.push(appendBlock(replica.doc, { type: "paragraph", text }));
    }
  });
  const directory = replicas.directory();
  const stamp = Date.now();
  upsertDirectoryEntry(directory.doc, {
    uuid,
    title,
    description: `${title} description`,
    tags: ["proof1"],
    createdAt: stamp,
    updatedAt: stamp,
  });
  return { uuid, blockIds };
}

/** A second connection on the same file, purely for `PRAGMA data_version`. */
export function dataVersionProbe(databasePath: string): {
  read(): number;
  close(): void;
} {
  const db = new DatabaseSync(databasePath);
  db.exec("PRAGMA busy_timeout = 5000");
  const statement = db.prepare("PRAGMA data_version");
  return {
    read: () => (statement.get() as { data_version: number }).data_version,
    close: () => db.close(),
  };
}

export function percentile(values: number[], p: number): number {
  if (values.length === 0) return Number.NaN;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length));
  return sorted[index] as number;
}

export interface Stats {
  n: number;
  p50: number;
  p95: number;
  p99: number;
  max: number;
  mean: number;
}

export function stats(values: number[]): Stats {
  if (values.length === 0) {
    return { n: 0, p50: NaN, p95: NaN, p99: NaN, max: NaN, mean: NaN };
  }
  let sum = 0;
  let max = -Infinity;
  for (const value of values) {
    sum += value;
    if (value > max) max = value;
  }
  return {
    n: values.length,
    p50: percentile(values, 50),
    p95: percentile(values, 95),
    p99: percentile(values, 99),
    max,
    mean: sum / values.length,
  };
}

export function round(value: number, digits = 2): number {
  return Number.isFinite(value) ? Number(value.toFixed(digits)) : value;
}

export function fmt(s: Stats): Record<string, number> {
  return {
    n: s.n,
    p50: round(s.p50),
    p95: round(s.p95),
    p99: round(s.p99),
    max: round(s.max),
    mean: round(s.mean),
  };
}

/** Fork-side message plumbing: children report with `send`, parent awaits them. */
export function send(message: unknown): void {
  process.send?.(message);
}

export function onMessage<T>(handler: (message: T) => void): void {
  process.on("message", (message) => handler(message as T));
}

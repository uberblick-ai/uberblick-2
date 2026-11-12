import { statSync } from "node:fs";
import { monitorEventLoopDelay } from "node:perf_hooks";
import type { DatabaseSync } from "node:sqlite";
import { setTimeout } from "node:timers/promises";
import type { Hocuspocus } from "@hocuspocus/server";
import { parseRoom } from "@uberblick/schema";
import type { HubLogRecord, HubLogger } from "./log.js";
import type { HubDatabase } from "./persistence.js";

/** Passive wall-clock totals; recording a write does no I/O or collection. */
export class HubWriteTiming {
  private roomStoreMs = 0;
  private revisionWriteMs = 0;

  roomStore(start: number): void {
    this.roomStoreMs += performance.now() - start;
  }

  revisionWrite(start: number): void {
    this.revisionWriteMs += performance.now() - start;
  }

  take(): { roomStoreMs: number; revisionWriteMs: number } {
    const result = { roomStoreMs: this.roomStoreMs, revisionWriteMs: this.revisionWriteMs };
    this.roomStoreMs = 0;
    this.revisionWriteMs = 0;
    return result;
  }
}

export interface WorkspaceMetrics {
  storedBytes: number;
  documentCount: number;
}

const RESERVED_ROOMS = new Set(["_directory", "_sidebar", "_settings", "_github_items"]);
const METRICS_BATCH_SIZE = 128;

/** Read blob lengths in bounded batches, releasing each statement before yielding. */
export async function collectWorkspaceMetrics(db: DatabaseSync, signal?: AbortSignal): Promise<Record<string, WorkspaceMetrics>> {
  const workspaces: Record<string, WorkspaceMetrics> = {};
  for (const [table, roomColumn] of [
    ["documents", "name"], ["document_revisions", "room"], ["document_revision_heads", "room"],
  ]) {
    signal?.throwIfAborted();
    // A busy hub can keep appending revisions; each pass has a fixed end.
    const maximum = db.prepare(`SELECT max(rowid) AS maximum FROM ${table}`).get()?.maximum;
    if (typeof maximum !== "number") continue;
    const read = db.prepare(`SELECT rowid AS cursor, ${roomColumn} AS room, coalesce(length(data), 0) AS bytes
      FROM ${table} WHERE rowid > ? AND rowid <= ? ORDER BY rowid LIMIT ${METRICS_BATCH_SIZE}`);
    let cursor = Number.MIN_SAFE_INTEGER;
    while (cursor < maximum) {
      // The timer owns cancellation and must not keep an otherwise idle process alive.
      await setTimeout(0, undefined, { signal, ref: signal === undefined });
      signal?.throwIfAborted();
      const rows = read.all(cursor, maximum);
      if (rows.length === 0) break;
      for (const row of rows) {
        cursor = Number(row.cursor);
        let parsed: ReturnType<typeof parseRoom>;
        // Legacy rows may predate room validation; never turn their names into log fields.
        try { parsed = parseRoom(String(row.room)); } catch { continue; }
        const metrics = workspaces[parsed.workspaceId] ?? { storedBytes: 0, documentCount: 0 };
        workspaces[parsed.workspaceId] = metrics;
        metrics.storedBytes += Number(row.bytes);
        if (table === "documents" && !RESERVED_ROOMS.has(parsed.uuid)) metrics.documentCount++;
      }
    }
  }
  return workspaces;
}

/** Collection and logging failures are observations, never durability failures. */
export function startHubMetrics(
  database: HubDatabase,
  hocuspocus: Hocuspocus,
  log: HubLogger,
  intervalMs = 60_000,
): () => Promise<void> {
  let delay: ReturnType<typeof monitorEventLoopDelay> | undefined;
  try {
    delay = monitorEventLoopDelay({ resolution: 1 });
    delay.enable();
  } catch { /* Other figures remain available without the delay monitor. */ }
  const controller = new AbortController();
  let previous = performance.now();
  let collecting: Promise<void> | undefined;
  const sample = async (): Promise<void> => {
    const start = performance.now();
    const record: HubLogRecord = { event: "hub.metrics", intervalMs: start - previous };
    previous = start;
    let failures = 0;
    const collect = (read: () => void): void => {
      try { read(); } catch { failures++; }
    };
    collect(() => { record.connections = hocuspocus.getConnectionsCount(); });
    collect(() => { record.rooms = hocuspocus.getDocumentsCount(); });
    collect(() => {
      if (delay === undefined) throw new Error("delay monitor unavailable");
      record.eventLoopDelayP50Ms = delay.count === 0 ? 0 : delay.percentile(50) / 1e6;
      record.eventLoopDelayP99Ms = delay.count === 0 ? 0 : delay.percentile(99) / 1e6;
      record.eventLoopDelayMaxMs = delay.max / 1e6;
    });
    collect(() => { delay?.reset(); });
    collect(() => { Object.assign(record, database.writeTiming.take()); });
    collect(() => {
      record.databaseBytes = database.databasePath === ":memory:" || database.databasePath === ""
        ? 0 : statSync(database.databasePath).size;
    });
    try { record.workspaces = await database.collectMetrics(controller.signal); }
    catch { failures++; }
    if (controller.signal.aborted) return;
    record.collectionFailures = failures;
    record.collectionMs = performance.now() - start;
    try { log(record); } catch { /* A logger cannot stop later intervals or sync. */ }
  };
  const timer = setInterval(() => {
    if (collecting !== undefined) return;
    collecting = sample().finally(() => { collecting = undefined; });
  }, intervalMs);
  timer.unref();
  return async () => {
    clearInterval(timer);
    controller.abort();
    try { delay?.disable(); } catch { /* Monitoring cannot prevent hub shutdown. */ }
    await collecting;
  };
}

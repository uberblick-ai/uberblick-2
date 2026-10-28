import * as Y from "yjs";
import type { RevisionEntry, RevisionRequest, RevisionResponse } from "@uberblick/schema";
import type { CachedHistoryCatalog, HistoryCacheResult, HistoryCacheStamp } from "./history-cache.js";
import type { HistoryMirrorCache } from "./history-mirror-cache.js";
import { downloadHistorySnapshot, revalidateHistoryCatalog } from "./history-mirror.js";
import type { HistoryRetention } from "./local-settings.js";
import { RevisionClientError } from "./revision-client.js";

export interface HistoryReadStatus {
  complete: boolean;
  lastRefresh: string | null;
  refreshFailed: boolean;
  offline: boolean;
  newestDownloadedRevision: string | null;
}

export interface HistoryReaderSource {
  stamp(): HistoryCacheStamp | null;
  connected(): boolean;
  request(uuid: string, operation: Omit<RevisionRequest, "requestId">): Promise<RevisionResponse>;
  now(): number;
  retention(): HistoryRetention;
  requireHistory(uuid: string): void;
}

export interface HistoryReaderOptions { timeoutMs?: number; refresh?: true }

function ready<T>(result: HistoryCacheResult<T>): T {
  if (result.status !== "ready") throw new RevisionClientError(
    result.status === "update-required" ? "unsupported" : "unreachable", { reason: `cache-${result.status}` });
  return result.value;
}

/** Foreground reads share the mirror's verified publications, independently of its role. */
export class HistoryReader {
  private readonly jobs = new Set<Promise<unknown>>();
  private readonly refreshes = new Map<string, Promise<CachedHistoryCatalog>>();
  private readonly downloads = new Map<string, Promise<boolean>>();
  private readonly failures = new Map<string, unknown>();
  private closed = false;

  constructor(private readonly source: HistoryReaderSource, private readonly cache: HistoryMirrorCache) {}

  private track<T>(job: Promise<T>): Promise<T> {
    this.jobs.add(job);
    void job.finally(() => this.jobs.delete(job)).catch(() => {});
    return job;
  }

  private check(uuid: string): void {
    if (this.closed) throw new RevisionClientError("unreachable");
    this.source.requireHistory(uuid);
  }

  private async open(uuid: string, refresh = false): Promise<void> {
    this.check(uuid);
    const stamp = this.source.stamp();
    const token = ready(stamp === null ? await this.cache.resume() : await this.cache.open(stamp));
    if (token === null) throw new RevisionClientError(refresh || this.source.connected() ? "sign-in-required" : "not-downloaded", { uuid });
    this.check(uuid);
  }

  private bounded<T>(uuid: string, revision: string | undefined, options: HistoryReaderOptions,
    work: () => Promise<T>, discard?: (value: T) => void): Promise<T> {
    const timeout = options.timeoutMs ?? 5_000;
    if (!Number.isFinite(timeout) || timeout <= 0 || timeout > 2_147_483_647) {
      return Promise.reject(new RangeError("Revision timeout must be between 1 and 2147483647 milliseconds."));
    }
    let expired = false;
    let timer: NodeJS.Timeout;
    const job = this.track(work());
    return new Promise<T>((resolve, reject) => {
      timer = setTimeout(() => {
        expired = true;
        reject(new RevisionClientError("downloading", { uuid, ...(revision === undefined ? {} : { revision }) }));
      }, timeout);
      void job.then(value => {
        clearTimeout(timer);
        if (expired) discard?.(value); else resolve(value);
      }, error => {
        clearTimeout(timer);
        if (!expired) { this.reported(error); reject(error); }
      });
    });
  }

  private reported(error: unknown): void {
    for (const [key, failure] of this.failures) if (failure === error) this.failures.delete(key);
  }

  // Preserve a download failure past the caller's wait until a read can report it.
  private async attempt<T>(key: string, work: () => Promise<T>): Promise<T> {
    if (this.failures.has(key)) {
      throw this.failures.get(key);
    }
    try { return await work(); }
    catch (error) { this.failures.set(key, error); throw error; }
  }

  private refresh(uuid: string): Promise<CachedHistoryCatalog> {
    const existing = this.refreshes.get(uuid);
    if (existing !== undefined) return existing;
    const job = this.attempt(JSON.stringify([this.source.stamp(), uuid, "list"]), async () => {
      for (let attempt = 0; attempt < 3; attempt += 1) {
        const catalog = await revalidateHistoryCatalog(this.cache, uuid, operation => {
          this.check(uuid);
          return this.source.request(uuid, operation);
        }, () => this.source.now());
        if (catalog.complete) return catalog;
      }
      throw new RevisionClientError("unreachable", { uuid, reason: "cache-superseded" });
    });
    this.refreshes.set(uuid, job);
    void job.finally(() => this.refreshes.delete(uuid)).catch(() => {});
    return job;
  }

  private async catalog(uuid: string, refresh = false): Promise<CachedHistoryCatalog> {
    const cached = ready(await this.cache.readCatalog(uuid));
    if (!refresh && cached !== null && (cached.complete || (!this.source.connected() && cached.revisions.length > 0))) return cached;
    if (!this.source.connected() && !refresh) {
      throw new RevisionClientError("not-downloaded", { uuid, history: cached === null ? {
        complete: false, lastRefresh: null, refreshFailed: false, offline: true, newestDownloadedRevision: null,
      } : await this.status(uuid, cached) });
    }
    return this.refresh(uuid);
  }

  private async status(uuid: string, catalog: CachedHistoryCatalog): Promise<HistoryReadStatus> {
    const newestDownloadedRevision = ready(await this.cache.newestDownloadedRevision(uuid, catalog.revisions));
    return { complete: catalog.complete,
      lastRefresh: catalog.refreshedAt === null ? null : new Date(catalog.refreshedAt).toISOString(),
      refreshFailed: catalog.failed, offline: !this.source.connected(), newestDownloadedRevision };
  }

  list(uuid: string, options: HistoryReaderOptions = {}): Promise<{ revisions: RevisionEntry[]; history: HistoryReadStatus }> {
    return this.bounded(uuid, undefined, options, async () => {
      await this.open(uuid, options.refresh);
      const catalog = await this.catalog(uuid, options.refresh);
      const history = await this.status(uuid, catalog);
      this.check(uuid);
      return { revisions: catalog.revisions, history };
    });
  }

  private async snapshot(uuid: string, revision: RevisionEntry, catalog: CachedHistoryCatalog, retryMissing: boolean) {
    const cached = ready(await this.cache.readSnapshot(uuid, revision.id));
    if (cached !== null && cached.checksum === revision.checksum) return cached;
    if (!this.source.connected()) throw new RevisionClientError("not-downloaded", { uuid, revision: revision.id,
      history: await this.status(uuid, catalog) });
    const key = JSON.stringify([uuid, revision.id, revision.checksum]);
    let download = this.downloads.get(key);
    if (download === undefined) {
      download = this.attempt(JSON.stringify([this.source.stamp(), key]),
        () => downloadHistorySnapshot(this.cache, uuid, revision, operation => this.source.request(uuid, operation)));
      this.downloads.set(key, download);
      void download.finally(() => this.downloads.delete(key)).catch(() => {});
    }
    try {
      if (!(await download)) return null;
      return ready(await this.cache.readSnapshot(uuid, revision.id));
    } catch (error) {
      await this.cache.markRefreshFailed(uuid);
      if (retryMissing && error instanceof RevisionClientError && error.code === "revision-not-found") {
        this.reported(error);
        return null;
      }
      throw error;
    }
  }

  get(uuid: string, revisionId: string, options: HistoryReaderOptions = {}): Promise<{ doc: Y.Doc; history: HistoryReadStatus }> {
    return this.bounded(uuid, revisionId, options, async () => {
      await this.open(uuid, options.refresh);
      let catalog = await this.catalog(uuid, options.refresh);
      let refreshed = options.refresh === true;
      // One revalidation handles unknown IDs and open heads that changed during download.
      for (let attempt = 0; attempt < 3; attempt += 1) {
        this.check(uuid);
        const revision = catalog.revisions.find(entry => entry.id === revisionId);
        if (revision === undefined) {
          if (!this.source.connected()) throw new RevisionClientError("not-downloaded", { uuid, revision: revisionId,
            history: await this.status(uuid, catalog) });
          if (refreshed) throw new RevisionClientError("revision-not-found", { uuid, revision: revisionId });
          catalog = await this.refresh(uuid);
          refreshed = true;
          continue;
        }
        if (revision.checksum === undefined) throw new RevisionClientError("unsupported");
        const held = ready(await this.cache.hold(uuid, revisionId));
        let transferred = false;
        try {
          const snapshot = await this.snapshot(uuid, revision, catalog, !refreshed);
          if (snapshot === null) {
            catalog = await this.refresh(uuid);
            refreshed = true;
            continue;
          }
          // A concurrent catalog publication can invalidate an open-head download.
          catalog = ready(await this.cache.readCatalog(uuid)) ?? catalog;
          const current = catalog.revisions.find(entry => entry.id === revisionId);
          if (snapshot.checksum !== current?.checksum) continue;
          this.check(uuid);
          const history = await this.status(uuid, catalog);
          this.check(uuid);
          const doc = new Y.Doc();
          try { Y.applyUpdate(doc, snapshot.state); }
          catch { doc.destroy(); throw new RevisionClientError("unsupported"); }
          doc.once("destroy", () => { this.track(this.release(uuid, held)); });
          transferred = true;
          return { doc, history };
        } finally {
          if (!transferred) await this.release(uuid, held);
        }
      }
      await this.cache.markRefreshFailed(uuid);
      throw new RevisionClientError("unreachable", { uuid, revision: revisionId, reason: "snapshot-verification-failed" });
    }, result => result.doc.destroy());
  }

  private async release(uuid: string, hold: { release(): Promise<void> }): Promise<void> {
    await hold.release();
    if (!this.closed) await this.cache.evict(uuid, this.source.retention(), this.source.now());
  }

  async writeThrough(uuid: string, revision: RevisionEntry): Promise<void> {
    await this.open(uuid);
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const catalog = ready(await this.cache.readCatalog(uuid));
      const revisions = catalog?.revisions ?? [];
      const present = revisions.some(entry => entry.id === revision.id);
      const updated = present ? revisions.map(entry => entry.id === revision.id ? { ...entry, ...revision } : entry)
        : [revision, ...revisions];
      const result = await this.cache.putCatalog(uuid, { revisions: updated, version: null,
        refreshedAt: catalog?.refreshedAt ?? null, complete: catalog?.complete ?? false, failed: catalog?.failed ?? false });
      if (result.status !== "superseded") { ready(result); return; }
    }
    throw new RevisionClientError("unreachable", { reason: "cache-superseded" });
  }

  async close(): Promise<void> {
    this.closed = true;
    await this.cache.close();
    await Promise.allSettled([...this.jobs]);
    this.failures.clear();
  }
}

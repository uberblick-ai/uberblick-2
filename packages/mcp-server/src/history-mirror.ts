import type { RevisionEntry, RevisionRequest, RevisionResponse } from "@uberblick/schema";
import type { CachedHistoryCatalog, HistoryCacheResult, HistoryCacheStamp } from "./history-cache.js";
import type { HistoryMirrorCache } from "./history-mirror-cache.js";
import { selectHistorySnapshots } from "./history-retention.js";
import type { HistoryRetention } from "./local-settings.js";
import { RevisionClientError } from "./revision-client.js";

type RequestHistory = (operation: Omit<RevisionRequest, "requestId">) => Promise<RevisionResponse>;
export type MirrorCache = Pick<HistoryMirrorCache, "open" | "resume" | "readCatalog" | "putCatalog" | "markRefreshFailed" |
  "listPages" | "hasSnapshot" | "putVerifiedSnapshot" | "evict" | "close">;

class CacheError extends Error {
  constructor(readonly status: string) { super(`History cache ${status}`); }
}
function ready<T>(result: HistoryCacheResult<T>): T {
  if (result.status !== "ready") throw new CacheError(result.status);
  return result.value;
}
function requireResponse(response: RevisionResponse): asserts response is Extract<RevisionResponse, { ok: true }> {
  if (!response.ok) throw new RevisionClientError(response.error === "unavailable" ? "unreachable" : response.error);
}

/** Revalidation keeps catalog completeness independent of downloaded snapshots. */
export async function revalidateHistoryCatalog(cache: MirrorCache, uuid: string,
  request: RequestHistory, now: () => number): Promise<CachedHistoryCatalog> {
  const previous = ready(await cache.readCatalog(uuid));
  try {
    const response = await request({ operation: "list", includeNames: true, includeTitles: true,
      ...(previous?.version == null ? {} : { ifVersion: previous.version }) });
    requireResponse(response);
    const revisions = "revisions" in response ? response.revisions
      : "unchanged" in response && previous?.complete ? previous.revisions : null;
    if (revisions === null) throw new RevisionClientError("unsupported");
    ready(await cache.putCatalog(uuid, { revisions,
      version: "version" in response ? response.version ?? null : null,
      refreshedAt: now(), complete: true, failed: false }));
    const catalog = ready(await cache.readCatalog(uuid));
    if (catalog === null) throw new CacheError("superseded");
    return catalog;
  } catch (error) {
    if (previous === null) {
      await cache.putCatalog(uuid, { revisions: [], version: null, refreshedAt: null, complete: false, failed: true });
    } else await cache.markRefreshFailed(uuid);
    throw error;
  }
}

/** Readers may also use this verified download for a viewed open head. */
export async function downloadHistorySnapshot(cache: MirrorCache, uuid: string,
  revision: RevisionEntry, request: RequestHistory): Promise<boolean> {
  if (revision.checksum === undefined) throw new RevisionClientError("unsupported");
  if (ready(await cache.hasSnapshot(uuid, revision.id, revision.checksum))) return true;
  const response = await request({ operation: "get", revisionId: revision.id });
  requireResponse(response);
  if (!("state" in response)) throw new RevisionClientError("unsupported");
  if (response.checksum !== revision.checksum ||
    (response.revisionId !== undefined && response.revisionId !== revision.id)) return false;
  return ready(await cache.putVerifiedSnapshot(uuid, revision.id, revision.checksum, response.state));
}

export interface HistoryMirrorPage {
  uuid: string;
  room: string;
  sequence: number;
  archived: boolean;
}
export interface HistoryMirrorSource {
  /** Only regular pages with already-held rooms; never attach an archived room. */
  pages(): HistoryMirrorPage[];
  retention(): HistoryRetention;
  stamp(): HistoryCacheStamp | null;
  ready(): boolean;
  request(room: string, operation: Omit<RevisionRequest, "requestId">): Promise<RevisionResponse>;
  now(): number;
  /** Translate the hub's wall-clock deadline to a monotonic local delay. */
  deadlineDelay(deadlineAt: number): number;
}

interface Work { recovery: boolean }
class Paused extends Error {}

/** One serial background consumer; live sync owns admission and always runs first. */
export class HistoryMirror {
  private readonly pages = new Map<string, HistoryMirrorPage>();
  private readonly pending = new Map<string, Work>();
  private readonly deadlines = new Map<string, NodeJS.Timeout>();
  private readonly elapsedDeadlines = new Map<string, string>();
  private retention: HistoryRetention;
  private evictPending = true;
  private stampKey: string | null = null;
  private connected = false;
  private refused = false;
  private closed = false;
  private epoch = 0;
  private immediate: NodeJS.Immediate | null = null;
  private running: Promise<void> | null = null;
  private wakeAgain = false;

  constructor(private readonly source: HistoryMirrorSource, private readonly cache: MirrorCache) {
    this.retention = source.retention();
  }

  connectionChanged(connected: boolean): void {
    if (this.closed || connected === this.connected) { this.wake(); return; }
    this.connected = connected;
    this.epoch += 1;
    this.clearDeadlines();
    this.elapsedDeadlines.clear();
    if (connected) {
      this.refused = false;
      for (const uuid of this.pages.keys()) this.enqueue(uuid);
      this.evictPending = true;
    }
    this.wake();
  }

  /** Called after the engine has applied local and foreign log changes. */
  refresh(): void {
    if (this.closed) return;
    const present = new Set<string>();
    for (const page of this.source.pages()) {
      present.add(page.uuid);
      const previous = this.pages.get(page.uuid);
      // An archived page encountered for the first time is not bootstrapped.
      if (previous === undefined && page.archived) continue;
      this.pages.set(page.uuid, page);
      if (previous === undefined || previous.sequence !== page.sequence || previous.archived !== page.archived) {
        this.enqueue(page.uuid);
      }
    }
    for (const uuid of this.pages.keys()) {
      if (present.has(uuid)) continue;
      this.pages.delete(uuid);
      this.pending.delete(uuid);
      this.clearDeadline(uuid);
      this.elapsedDeadlines.delete(uuid);
    }
    this.checkRetention();
    this.wake();
  }

  checkRetention(): void {
    if (this.closed) return;
    const retention = this.source.retention();
    if (JSON.stringify(retention) === JSON.stringify(this.retention)) return;
    this.retention = retention;
    this.evictPending = true;
    for (const page of this.pages.values()) if (!page.archived) this.enqueue(page.uuid);
    this.wake();
  }

  notice(room: string): void {
    for (const page of this.pages.values()) if (page.room === room) this.enqueue(page.uuid);
    this.wake();
  }

  private enqueue(uuid: string, recovery = false): void {
    const previous = this.pending.get(uuid);
    this.pending.set(uuid, { recovery: recovery || previous?.recovery === true });
    this.evictPending = true;
  }

  private wake(): void {
    if (this.closed) return;
    if (this.running !== null) { this.wakeAgain = true; return; }
    if (this.immediate !== null) return;
    if (!this.evictPending && this.pending.size === 0) return;
    this.immediate = setImmediate(() => {
      this.immediate = null;
      this.wakeAgain = false;
      this.running = this.drain().catch(() => {
        // Disposable storage failure suspends this pass; a later trigger retries.
      }).finally(() => {
        this.running = null;
        if (this.wakeAgain && (this.evictPending || (this.connected && !this.refused && this.source.ready()))) this.wake();
      });
    });
    this.immediate.unref();
  }

  private check(epoch: number, stampKey: string): void {
    if (this.closed || !this.connected || this.epoch !== epoch || !this.source.ready() ||
      JSON.stringify(this.source.stamp()) !== stampKey) throw new Paused();
  }

  private async drain(): Promise<void> {
    if (this.closed) return;
    const stamp = this.source.stamp();
    if (stamp === null && this.stampKey === null) {
      const resumed = ready(await this.cache.resume());
      if (resumed === null) return;
      this.stampKey = JSON.stringify({ hub: resumed.hub, workspace: resumed.workspace, account: resumed.account });
    }
    if (stamp !== null && this.stampKey !== JSON.stringify(stamp)) {
      ready(await this.cache.open(stamp));
      this.stampKey = JSON.stringify(stamp);
      this.evictPending = true;
      for (const uuid of this.pages.keys()) this.enqueue(uuid);
    }
    // Retention is local work, including during outages and for archived pages.
    if (this.evictPending) {
      this.evictPending = false;
      try {
        for (const uuid of ready(await this.cache.listPages())) {
          if (this.closed) return;
          ready(await this.cache.evict(uuid, this.retention, this.source.now()));
        }
      } catch (error) { this.evictPending = true; throw error; }
    }
    const stampKey = this.stampKey;
    if (stamp === null || stampKey === null) return;
    while (!this.closed && this.connected && !this.refused && this.source.ready() && this.pending.size > 0) {
      const next = this.pending.entries().next().value;
      if (next === undefined) return;
      const [uuid, work] = next;
      this.pending.delete(uuid);
      if (!(await this.mirrorPage(uuid, work, stampKey))) return;
      // Yield between pages even when every cache operation resolves immediately.
      await new Promise<void>(resolve => setImmediate(resolve));
    }
  }

  private async mirrorPage(uuid: string, work: Work, stampKey: string): Promise<boolean> {
    const page = this.pages.get(uuid);
    if (page === undefined) return true;
    const epoch = this.epoch;
    const request: RequestHistory = async operation => {
      this.check(epoch, stampKey);
      const response = await this.source.request(page.room, operation);
      this.check(epoch, stampKey);
      return response;
    };
    try {
      const catalog = await revalidateHistoryCatalog(this.cache, uuid, request, () => this.source.now());
      this.check(epoch, stampKey);
      ready(await this.cache.evict(uuid, this.retention, this.source.now()));
      if (catalog.version === null || catalog.revisions.some(revision =>
        revision.checksum === undefined || revision.final === undefined)) {
        throw new RevisionClientError("unsupported");
      }
      this.setDeadline(page, catalog);
      const keep = selectHistorySnapshots({ revisions: catalog.revisions, downloaded: new Set() },
        this.retention, this.source.now());
      for (const revision of catalog.revisions) {
        if (!keep.has(revision.id) || revision.final !== true) continue;
        this.check(epoch, stampKey);
        const downloaded = await downloadHistorySnapshot(this.cache, uuid, revision, request);
        this.check(epoch, stampKey);
        if (downloaded) continue;
        await this.cache.markRefreshFailed(uuid);
        if (!work.recovery) this.enqueue(uuid, true);
        break;
      }
    } catch (error) {
      if (error instanceof Paused) {
        if (this.pages.has(uuid)) this.enqueue(uuid, work.recovery);
        return false;
      }
      if (error instanceof CacheError && error.status === "superseded") {
        this.stampKey = null;
        return false;
      }
      if (error instanceof RevisionClientError && ["forbidden", "sign-in-required", "unsupported"].includes(error.code)) {
        this.refused = true;
        this.clearDeadlines();
        return false;
      }
      if (error instanceof RevisionClientError && error.code === "revision-not-found" && !work.recovery) {
        this.enqueue(uuid, true);
      }
      await this.cache.markRefreshFailed(uuid);
    }
    return true;
  }

  private setDeadline(page: HistoryMirrorPage, catalog: CachedHistoryCatalog): void {
    this.clearDeadline(page.uuid);
    const head = catalog.revisions.find(revision => revision.final === false);
    if (head?.deadlineAt === undefined) { this.elapsedDeadlines.delete(page.uuid); return; }
    const key = JSON.stringify([head.id, head.deadlineAt]);
    // A hub clock moving backwards must not turn one deadline into a request loop.
    if (this.elapsedDeadlines.get(page.uuid) === key) return;
    const delay = this.source.deadlineDelay(head.deadlineAt);
    if (!Number.isFinite(delay)) return;
    const timer = setTimeout(() => {
      this.deadlines.delete(page.uuid);
      this.elapsedDeadlines.set(page.uuid, key);
      if (!this.closed && this.pages.has(page.uuid)) { this.enqueue(page.uuid); this.wake(); }
    }, Math.max(1, Math.min(2_147_483_647, delay)));
    timer.unref();
    this.deadlines.set(page.uuid, timer);
  }

  private clearDeadline(uuid: string): void {
    const timer = this.deadlines.get(uuid);
    if (timer !== undefined) clearTimeout(timer);
    this.deadlines.delete(uuid);
  }
  private clearDeadlines(): void {
    for (const uuid of this.deadlines.keys()) this.clearDeadline(uuid);
  }

  async close(): Promise<void> {
    this.closed = true;
    this.clearDeadlines();
    if (this.immediate !== null) clearImmediate(this.immediate);
    await this.running;
    await this.cache.close();
  }
}

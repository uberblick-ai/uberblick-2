import { utimesSync } from "node:fs";
import { join } from "node:path";
import { resolveMcpConfig } from "./config.js";
import { DEFAULT_HOST_LIMITS, ensureHostDiskCapacity } from "./host-capacity.js";
import { hostGrantHash } from "./host-grants.js";
import type { HostSession, McpHostConfig, McpHostDependencies } from "./http-host.js";
import { log } from "./log.js";
import { createMcpRuntime, type UberblickMcpRuntime } from "./server.js";
import { ServerShuttingDownError } from "./server-work.js";
import type { McpHostGrant } from "./host-token-check.js";

export interface HostRuntime {
  grantId: string;
  directory: string;
  opening: Promise<UberblickMcpRuntime>;
  runtime?: UberblickMcpRuntime;
  lastActivity: number;
  lastUsedAt: number;
  sessions: Set<HostSession>;
  admissions: number;
  closing?: Promise<void>;
}

interface HostGrantLifecycle {
  ready(): Promise<void>;
  hasEnded(grantId: string): boolean;
}

export class HostFullError extends Error {}

const IDLE_MS = 15 * 60_000;

/** Own reservations, eviction and mirror exclusion across runtime generations. */
export class HostRuntimes {
  private readonly runtimes = new Map<string, HostRuntime>();
  private readonly allRuntimes = new Set<HostRuntime>();
  private readonly retired = new Set<Promise<void>>();
  private readonly excludedDirectories = new Set<string>();
  private readonly endedGrants = new Set<string>();
  private diskAdmission = Promise.resolve();
  readonly limits;
  readonly now;

  constructor(
    private readonly config: McpHostConfig,
    private readonly dependencies: McpHostDependencies,
    private readonly closeSession: (record: HostSession) => Promise<void>,
    private readonly isStopping: () => boolean,
    private readonly grants?: HostGrantLifecycle,
  ) {
    this.limits = { ...DEFAULT_HOST_LIMITS, ...config.limits };
    this.now = dependencies.now ?? (() => performance.now());
  }

  private touchDirectory(record: HostRuntime): void {
    // Persist LRU order across host restarts without adding another catalog.
    try { const date = new Date(record.lastUsedAt); utimesSync(record.directory, date, date); }
    catch { /* A failed opening may not have created its mirror. */ }
  }

  touch(record: HostRuntime): void {
    record.lastActivity = this.now();
    record.lastUsedAt = Date.now();
    for (const other of this.allRuntimes) {
      if (other.directory === record.directory) other.lastUsedAt = Math.max(other.lastUsedAt, record.lastUsedAt);
    }
  }

  private retire(record: HostRuntime, deadline?: number): Promise<void> {
    if (record.closing !== undefined) return record.closing;
    if (this.runtimes.get(record.grantId) === record) this.runtimes.delete(record.grantId);
    const sessionsClosed = Promise.all([...record.sessions].map(this.closeSession));
    const drained = record.runtime?.close(deadline);
    const closingRuntime = Promise.resolve().then(async () => {
      await sessionsClosed;
      if (drained !== undefined) await drained;
      else await (await record.opening.catch(() => undefined))?.close(deadline);
      this.touchDirectory(record);
      this.allRuntimes.delete(record);
      if (![...this.allRuntimes].some(other => other.directory === record.directory)) {
        this.excludedDirectories.delete(record.directory);
      }
    }).finally(() => {
      this.retired.delete(closingRuntime);
    });
    record.closing = closingRuntime;
    this.retired.add(closingRuntime);
    void closingRuntime.catch(() => { log.error("MCP host runtime close failed"); });
    return closingRuntime;
  }

  async retireGrant(grantId: string): Promise<void> {
    this.endedGrants.add(grantId);
    const records = [...this.allRuntimes].filter(record => record.grantId === grantId);
    // Older generations can still own an open log after an idle replacement starts.
    await Promise.all(records.map(record => this.retire(record, performance.now())));
  }

  private assertAvailable(grantId: string): void {
    if (this.isStopping() || this.endedGrants.has(grantId) || this.grants?.hasEnded(grantId)) {
      throw new ServerShuttingDownError();
    }
  }

  async sweepIdle(): Promise<void> {
    if (this.isStopping()) return;
    const cutoff = this.now() - IDLE_MS;
    const idle = [...this.runtimes.values()].sort((a, b) => a.lastActivity - b.lastActivity);
    const closedSessions: Promise<void>[] = [];
    for (const record of idle) {
      for (const session of record.sessions) {
        if (!session.closed && session.lastActivity <= cutoff && session.requests === 0 && session.session.activeCalls === 0) {
          closedSessions.push(this.closeSession(session));
        }
      }
      if (record.runtime === undefined || record.admissions > 0 || record.lastActivity > cutoff) continue;
      if ([...record.sessions].some(session => session.requests > 0 || session.session.activeCalls > 0)) continue;
      if (record.runtime.store.pendingRooms().length > 0) continue;
      void this.retire(record);
    }
    await Promise.all(closedSessions);
  }

  runtimeFor(grant: McpHostGrant): HostRuntime {
    this.assertAvailable(grant.grantId);
    const existing = this.runtimes.get(grant.grantId);
    if (existing !== undefined) return existing;
    if (this.runtimes.size >= this.limits.maxRuntimes) throw new HostFullError();
    const grantPath = hostGrantHash(grant.grantId);
    const directory = join(this.config.databaseDirectory, grantPath);
    const record: HostRuntime = {
      grantId: grant.grantId, directory, lastActivity: this.now(), lastUsedAt: Date.now(), sessions: new Set(), admissions: 0,
      opening: Promise.resolve().then(async () => {
        await this.grants?.ready();
        this.assertAvailable(grant.grantId);
        const credentials = await this.dependencies.credentialsForGrant?.(grant);
        this.assertAvailable(grant.grantId);
        if (credentials === undefined) throw new Error("Grant credentials are unavailable");
        // Keep the free-space check and synchronous open in one serialized turn.
        const opening = this.diskAdmission.then(async () => {
          const protectedDirectories = new Set(this.excludedDirectories);
          if (![...this.allRuntimes].some(other => other !== record && other.directory === directory)) {
            protectedDirectories.delete(directory);
          }
          const enoughSpace = await ensureHostDiskCapacity({
            databaseDirectory: this.config.databaseDirectory, minFreeBytes: this.limits.minFreeBytes,
            excludedDirectories: protectedDirectories,
            ...(this.dependencies.freeSpace === undefined ? {} : { freeSpace: this.dependencies.freeSpace }),
          });
          this.assertAvailable(grant.grantId);
          if (!enoughSpace) throw new HostFullError();
          const runtimeConfig = resolveMcpConfig({
            WORKSPACE_ID: grant.workspace,
            HUB_URL: this.config.hubUrl,
            UBERBLICK_DB: join(directory, `${grant.workspace}.sqlite`),
          });
          record.runtime = createMcpRuntime(runtimeConfig, { ...credentials, waitForWriteAcknowledgement: true });
          this.touch(record);
          this.touchDirectory(record);
          return record.runtime;
        });
        this.diskAdmission = opening.then(() => {}, () => {});
        return opening;
      }),
    };
    this.runtimes.set(grant.grantId, record);
    this.allRuntimes.add(record);
    this.excludedDirectories.add(directory);
    void record.opening.catch(() => {
      if (this.runtimes.get(grant.grantId) === record) this.runtimes.delete(grant.grantId);
      this.allRuntimes.delete(record);
      if (![...this.allRuntimes].some(other => other.directory === directory)) this.excludedDirectories.delete(directory);
    });
    return record;
  }

  async close(deadline: number): Promise<void> {
    const opened = await Promise.allSettled([...this.allRuntimes].map(async record => ({ record, runtime: await record.opening })));
    await Promise.all(opened.map(async result => {
      if (result.status !== "fulfilled") return;
      await result.value.runtime.close(deadline);
      this.touchDirectory(result.value.record);
    }));
    await Promise.all([...this.retired]);
  }
}

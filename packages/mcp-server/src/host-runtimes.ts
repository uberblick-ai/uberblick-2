import { createHash } from "node:crypto";
import { utimesSync } from "node:fs";
import { join } from "node:path";
import { resolveMcpConfig } from "./config.js";
import { DEFAULT_HOST_LIMITS, ensureHostDiskCapacity } from "./host-capacity.js";
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
}

export class HostFullError extends Error {}

const IDLE_MS = 15 * 60_000;

/** Own reservations, eviction and mirror exclusion across runtime generations. */
export class HostRuntimes {
  private readonly runtimes = new Map<string, HostRuntime>();
  private readonly allRuntimes = new Set<HostRuntime>();
  private readonly retired = new Set<Promise<void>>();
  private readonly excludedDirectories = new Set<string>();
  private diskAdmission = Promise.resolve();
  readonly limits;
  readonly now;

  constructor(
    private readonly config: McpHostConfig,
    private readonly dependencies: McpHostDependencies,
    private readonly closeSession: (record: HostSession) => Promise<void>,
    private readonly isStopping: () => boolean,
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

  private retire(record: HostRuntime): void {
    this.runtimes.delete(record.grantId);
    for (const session of record.sessions) void this.closeSession(session);
    const drained = record.runtime?.close();
    const closingRuntime = Promise.resolve(drained).then(() => {
      this.touchDirectory(record);
      this.allRuntimes.delete(record);
      if (![...this.allRuntimes].some(other => other.directory === record.directory)) {
        this.excludedDirectories.delete(record.directory);
      }
    }).catch(() => {
      log.error("MCP host runtime close failed");
    }).finally(() => {
      this.retired.delete(closingRuntime);
    });
    this.retired.add(closingRuntime);
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
      this.retire(record);
    }
    await Promise.all(closedSessions);
  }

  runtimeFor(grant: McpHostGrant): HostRuntime {
    const existing = this.runtimes.get(grant.grantId);
    if (existing !== undefined) return existing;
    if (this.runtimes.size >= this.limits.maxRuntimes) throw new HostFullError();
    const grantPath = createHash("sha256").update(grant.grantId).digest("hex");
    const directory = join(this.config.databaseDirectory, grantPath);
    const record: HostRuntime = {
      grantId: grant.grantId, directory, lastActivity: this.now(), lastUsedAt: Date.now(), sessions: new Set(), admissions: 0,
      opening: Promise.resolve().then(async () => {
        if (this.isStopping()) throw new ServerShuttingDownError();
        const credentials = await this.dependencies.credentialsForGrant?.(grant);
        if (this.isStopping()) throw new ServerShuttingDownError();
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
          if (this.isStopping()) throw new ServerShuttingDownError();
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

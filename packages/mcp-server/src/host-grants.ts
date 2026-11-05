import { createHash } from "node:crypto";
import { closeSync, constants, fstatSync, lstatSync, mkdirSync, openSync, readFileSync, readdirSync, rmSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { inspectMcpGrant } from "@uberblick/hub/mcp-channel";
import { isUuid } from "@uberblick/schema";
import type { createHostCredentialManager } from "./host-credentials.js";
import { log } from "./log.js";
import { publishOwnerOnly } from "./safe-write.js";
import { readStoredSyncStatus } from "./store.js";

export const HOST_GRANT_CHECK_INTERVAL_MS = 30_000;

export interface StoredHostGrant {
  grantId: string;
  workspace: string;
}

export function hostGrantHash(grantId: string): string {
  return createHash("sha256").update(grantId).digest("hex");
}

/** Unreadable, unfamiliar or incomplete mirrors stay until their contents can be checked. */
export function hostGrantMirrorIsSynced(directory: string, workspace: string): boolean {
  const stat = lstatSync(directory, { throwIfNoEntry: false });
  if (stat === undefined) return true;
  if (!stat.isDirectory()) return false;
  const database = `${workspace}.sqlite`;
  const names = readdirSync(directory);
  if (names.length === 0) return true;
  if (!names.includes(database)) return false;
  for (const name of names) {
    const entry = join(directory, name);
    if (name === `${database}.history-holds`) {
      if (!lstatSync(entry).isDirectory()) return false;
      for (const held of readdirSync(entry)) {
        const id = held.replace(/\.sqlite(?:-(?:wal|shm|journal))?$/, "");
        if (!isUuid(id) || held === id || !lstatSync(join(entry, held)).isFile()) return false;
      }
    } else if (![database, `${database}-wal`, `${database}-shm`, `${database}-journal`, `${database}.history-refresher-lock`].includes(name) ||
      !lstatSync(entry).isFile()) return false;
  }
  return readStoredSyncStatus(join(directory, database), workspace).pendingRooms.length === 0;
}

/** Keep mirror identities when the separate private-key directory is lost. */
export function createHostGrantIndex(databaseDirectory: string) {
  const directory = join(databaseDirectory, "grants");
  const path = (grantId: string) => join(directory, `${hostGrantHash(grantId)}.json`);
  function remember(grant: StoredHostGrant): void {
    if (!isUuid(grant.grantId) || !isUuid(grant.workspace)) throw new Error("Invalid hosted grant identity");
    mkdirSync(directory, { mode: 0o700, recursive: true });
    const stat = lstatSync(directory);
    if (!stat.isDirectory() || (stat.mode & 0o077) !== 0 ||
      (process.getuid !== undefined && stat.uid !== process.getuid())) throw new Error("Hosted grant directory is not private");
    publishOwnerOnly(path(grant.grantId), JSON.stringify(grant));
  }
  function list(): StoredHostGrant[] {
    const grants: StoredHostGrant[] = [];
    let names: string[];
    try {
      if (!lstatSync(directory).isDirectory()) return grants;
      names = readdirSync(directory);
    } catch { return grants; }
    for (const name of names) {
      if (!/^[a-f0-9]{64}\.json$/.test(name)) continue;
      let fd: number | undefined;
      try {
        fd = openSync(join(directory, name), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
        const stat = fstatSync(fd);
        if (!stat.isFile() || stat.size > 1024) continue;
        const value: unknown = JSON.parse(readFileSync(fd, "utf8"));
        if (value === null || typeof value !== "object") continue;
        const grant = value as StoredHostGrant;
        if (isUuid(grant.grantId) && isUuid(grant.workspace) && name === `${hostGrantHash(grant.grantId)}.json`) {
          grants.push({ grantId: grant.grantId, workspace: grant.workspace });
        }
      } catch { /* An uncertain mirror identity never authorizes deletion. */ }
      finally { if (fd !== undefined) closeSync(fd); }
    }
    return grants;
  }
  return {
    remember,
    list,
    remove(grantId: string): void {
      try { unlinkSync(path(grantId)); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    },
  };
}

export function startHostGrantCleanup(options: {
  databaseDirectory: string;
  socketPath: string;
  credentials: ReturnType<typeof createHostCredentialManager>;
  retire(grantId: string): Promise<void>;
}) {
  const index = createHostGrantIndex(options.databaseDirectory);
  const ended = new Set<string>();
  let stopped = false;
  let sweeping: Promise<void> | undefined;

  async function reap(): Promise<void> {
    const known = new Map(index.list().map(grant => [grant.grantId, grant]));
    for (const grant of options.credentials.storedGrants()) {
      if (!known.has(grant.grantId)) known.set(grant.grantId, grant);
    }
    for (const grant of known.values()) {
      if (stopped) return;
      const state = await inspectMcpGrant(options.socketPath, grant.grantId);
      if (state.status !== "ended" || stopped) continue;
      ended.add(grant.grantId);
      await options.retire(grant.grantId);
      try {
        const mirror = join(options.databaseDirectory, hostGrantHash(grant.grantId));
        if (!hostGrantMirrorIsSynced(mirror, grant.workspace)) continue;
        rmSync(mirror, { recursive: true, force: true });
        await options.credentials.removeGrant(grant.grantId);
        index.remove(grant.grantId);
      } catch { log.warn("MCP host kept an ended grant's files because cleanup could not verify or remove them"); }
    }
  }
  function sweep(): Promise<void> {
    if (stopped) return Promise.resolve();
    sweeping ??= reap().catch(() => {
      log.warn("MCP host grant check failed");
    }).finally(() => { sweeping = undefined; });
    return sweeping;
  }
  const ready = sweep();
  const timer = setInterval(() => { void sweep(); }, HOST_GRANT_CHECK_INTERVAL_MS);
  timer.unref();
  return {
    ready,
    sweep,
    remember: index.remember,
    hasEnded: (grantId: string) => ended.has(grantId),
    async close(): Promise<void> {
      stopped = true;
      clearInterval(timer);
      await sweeping;
    },
  };
}

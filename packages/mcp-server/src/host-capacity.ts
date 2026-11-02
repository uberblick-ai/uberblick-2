import { lstatSync, mkdirSync, readdirSync, rmSync, statfsSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { isUuid } from "@uberblick/schema";
import { readStoredSyncStatus } from "./store.js";

export interface McpHostLimits {
  maxRuntimes: number;
  maxSessions: number;
  maxCalls: number;
  minFreeBytes: number;
}

export const DEFAULT_HOST_LIMITS: Readonly<McpHostLimits> = {
  maxRuntimes: 32,
  maxSessions: 128,
  maxCalls: 64,
  minFreeBytes: 256 * 1024 * 1024,
};

function limit(env: NodeJS.ProcessEnv, name: string, fallback: number, minimum = 1): number {
  const raw = env[name];
  if (raw === undefined) return fallback;
  const value = Number(raw);
  if (!/^\d+$/.test(raw) || !Number.isSafeInteger(value) || value < minimum) {
    throw new Error(`${name} must be a safe integer of at least ${minimum}`);
  }
  return value;
}

export function resolveHostLimits(env: NodeJS.ProcessEnv = process.env): McpHostLimits {
  return {
    maxRuntimes: limit(env, "MCP_MAX_RUNTIMES", DEFAULT_HOST_LIMITS.maxRuntimes),
    maxSessions: limit(env, "MCP_MAX_SESSIONS", DEFAULT_HOST_LIMITS.maxSessions),
    maxCalls: limit(env, "MCP_MAX_CALLS", DEFAULT_HOST_LIMITS.maxCalls),
    minFreeBytes: limit(env, "MCP_MIN_FREE_BYTES", DEFAULT_HOST_LIMITS.minFreeBytes, 0),
  };
}

export type HostFreeSpace = (directory: string) => number | Promise<number>;

function freeBytes(directory: string): number {
  const status = statfsSync(directory);
  return status.bavail * status.bsize;
}

function recognizedMirror(databasePath: string, workspace: string): boolean {
  const db = new DatabaseSync(databasePath, { readOnly: true });
  try {
    // A valid but unrelated SQLite database must not become disposable data.
    return db.prepare("SELECT value FROM meta WHERE key = 'workspace'").get()?.value === workspace &&
      db.prepare("SELECT 1 FROM sqlite_schema WHERE type = 'table' AND name = 'pending_rooms'").get() !== undefined;
  } finally { db.close(); }
}

function cleanMirrorDirectory(directory: string): boolean {
  try {
    const entries = readdirSync(directory, { withFileTypes: true });
    const databases = entries.filter(entry => entry.isFile() && entry.name.endsWith(".sqlite"));
    if (databases.length === 0) return false;
    const allowed = new Set(databases.flatMap(entry => {
      const lock = `${entry.name}.history-refresher-lock`;
      return [entry.name, `${entry.name}-wal`, `${entry.name}-shm`, lock, `${lock}-journal`, `${lock}-wal`, `${lock}-shm`];
    }));
    if (entries.some(entry => !entry.isFile() || !allowed.has(entry.name))) return false;
    return databases.every(entry => {
      const workspace = entry.name.slice(0, -".sqlite".length);
      if (!isUuid(workspace)) return false;
      const databasePath = join(directory, entry.name);
      return recognizedMirror(databasePath, workspace) && readStoredSyncStatus(databasePath, workspace).pendingRooms.length === 0;
    });
  } catch {
    // An unreadable or unrecognized mirror cannot establish that deletion is safe.
    return false;
  }
}

/** Reclaim only closed, acknowledged mirrors, oldest use first. */
export async function ensureHostDiskCapacity(options: {
  databaseDirectory: string;
  minFreeBytes: number;
  excludedDirectories: ReadonlySet<string>;
  freeSpace?: HostFreeSpace;
}): Promise<boolean> {
  const { databaseDirectory, minFreeBytes, excludedDirectories } = options;
  mkdirSync(databaseDirectory, { recursive: true, mode: 0o700 });
  const readFreeSpace = options.freeSpace ?? freeBytes;
  if (await readFreeSpace(databaseDirectory) >= minFreeBytes) return true;
  const candidates = readdirSync(databaseDirectory, { withFileTypes: true })
    .filter(entry => entry.isDirectory() && /^[0-9a-f]{64}$/.test(entry.name))
    .map(entry => {
      const directory = join(databaseDirectory, entry.name);
      return { directory, lastUsed: lstatSync(directory).mtimeMs };
    })
    .sort((left, right) => left.lastUsed - right.lastUsed || left.directory.localeCompare(right.directory));
  for (const { directory } of candidates) {
    if (excludedDirectories.has(directory) || !cleanMirrorDirectory(directory)) continue;
    rmSync(directory, { recursive: true });
    if (await readFreeSpace(databaseDirectory) >= minFreeBytes) return true;
  }
  return false;
}

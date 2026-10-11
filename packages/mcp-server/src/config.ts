import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { resolveStorage } from "@uberblick/hub/storage";
import { usesDeviceCredentials as usesDeviceLogin } from "@uberblick/hub/auth-store";
export { usesDeviceCredentials as usesDeviceLogin } from "@uberblick/hub/auth-store";
import { parseWorkspaceId } from "@uberblick/schema";

/** Internal fallback; public startup resolves the project's workspace binding. */
export const DEFAULT_HUB_URL = "ws://localhost:1234";

/** Hash the session id for a stable colour across its cursors. */
const AGENT_COLORS = [
  "#7b5ec7",
  "#2f9e8f",
  "#c2683a",
  "#3a6fc2",
  "#a8407a",
  "#5f8b32",
] as const;

export interface McpConfig {
  /** Bare UUID: decorated spellings must share rooms, token claims and database. */
  workspaceId: string;
  /** Websocket endpoint of the hub (`HUB_URL`). */
  hubUrl: string;
  /** Loopback HMAC secret; missing admission credentials leave local tools available. */
  authSecret: string | null;
  /**
   * Read this machine's private login, never a configured key, for deployed hubs
   * including loopback proxies. Programmatic loopback callers may opt in too.
   */
  deviceLogin?: { env?: NodeJS.ProcessEnv };
  /** Credential-store location for a loopback hub that requires device admission. */
  authEnv?: NodeJS.ProcessEnv;
  /** SQLite file holding the update log, snapshots and the derived index. */
  databasePath: string;
  /** This process's agent session id. Becomes the token's `sub`. */
  sessionId: string;
  /** Awareness colour for this session. */
  color: string;
  /** How long to wait for a first hub connection before serving anyway (ms). */
  connectTimeoutMs: number;
  /** How long to wait for attached rooms to finish syncing (ms). */
  syncTimeoutMs: number;
  /** Upper bound on websocket reconnect backoff (ms). */
  reconnectMaxDelayMs: number;
  /** Upper bound on device-login recovery polling (ms); thirty seconds when unset. */
  deviceRetryMaxDelayMs?: number;
  /** How long a device renewal outcome is shared across rooms and processes (ms); thirty seconds when unset. */
  deviceRenewalCooldownMs?: number;
  /** How long an agent's published cursor lives before it is withdrawn (ms). */
  cursorTtlMs: number;
  /** Log entries per room that trigger a snapshot-and-prune. */
  compactAfter: number;
  /**
   * Retry interval after an index write failure (ms); the entry stays queued.
   * Pacing avoids spending a SQLite busy timeout on every tool call.
   */
  reconcileRetryMs: number;
  /**
   * Minimum age before re-stamping this server's own content edits (ms), to avoid
   * a workspace-wide directory update per keystroke. Observed edits never stamp
   * here; title and tag edits still update the stub immediately.
   */
  updatedAtCoarsenessMs: number;
}

function hashToIndex(value: string, buckets: number): number {
  let hash = 0;
  for (let index = 0; index < value.length; index += 1) {
    hash = (hash * 31 + value.charCodeAt(index)) | 0;
  }
  return Math.abs(hash) % buckets;
}

/**
 * Use the shared storage resolver and bare UUID so CLI and MCP processes for
 * one user's workspace share one path-safe database, regardless of slug.
 * Storage uses absolute XDG_DATA_HOME/uberblick, else ~/.local/share/uberblick.
 */
export function defaultDatabasePath(
  workspaceId: string,
  env: NodeJS.ProcessEnv = process.env,
): string {
  return join(
    resolveStorage({ env }).workspaceDir,
    `${parseWorkspaceId(workspaceId).uuid}.sqlite`,
  );
}

function trimmed(value: string | undefined): string | null {
  const text = value?.trim();
  return text === undefined || text === "" ? null : text;
}

/** Direct server entry is internal; public `ub mcp serve` resolves the binding. */
function missingWorkspace(): string {
  return "WORKSPACE_ID is not set for the internal MCP server. Use `ub mcp serve` with a .uberblick.json binding or UB_WORKSPACE_ID; add UB_HUB_URL (a hub address, or local) if this machine has no record for that workspace. Run `ub workspace create <name>` for local setup or `ub workspace use <link|id>` to use an existing workspace.";
}

/** Internal startup reads environment only; public startup resolves the binding. */
export function resolveMcpConfig(
  env: NodeJS.ProcessEnv = process.env,
): McpConfig {
  const configured = trimmed(env.WORKSPACE_ID);
  if (configured === null) {
    throw new Error(missingWorkspace());
  }
  // Require explicit identity; a guessed workspace could open the wrong corpus.
  const workspaceId = parseWorkspaceId(configured).uuid;
  const sessionId = `agent-${randomUUID()}`;
  const hubUrl = trimmed(env.HUB_URL) ?? DEFAULT_HUB_URL;
  const remote = usesDeviceLogin(hubUrl, env);

  return {
    workspaceId,
    hubUrl,
    authSecret: remote ? null : trimmed(env.HUB_AUTH_TOKEN),
    ...(remote ? { deviceLogin: { env } } : {}),
    authEnv: env,
    databasePath:
      trimmed(env.UBERBLICK_DB) ??
      defaultDatabasePath(workspaceId, env),
    sessionId,
    color: AGENT_COLORS[hashToIndex(sessionId, AGENT_COLORS.length)] ?? "#7b5ec7",
    connectTimeoutMs: 1_500,
    syncTimeoutMs: 3_000,
    reconnectMaxDelayMs: 2_000,
    cursorTtlMs: 30_000,
    compactAfter: 500,
    reconcileRetryMs: 5_000,
    updatedAtCoarsenessMs: 5 * 60_000,
  };
}

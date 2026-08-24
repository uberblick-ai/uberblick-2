/**
 * MCP server configuration.
 *
 * Environment only — no config file, no CLI flags. An MCP client spawns this
 * process over stdio and hands it an environment; that is the whole interface.
 *
 * `HUB_URL` is plaintext config (an endpoint is not a secret) and the only
 * hardcoded address in this package is {@link DEFAULT_HUB_URL}. `HUB_AUTH_TOKEN`
 * is the HMAC *secret* tokens are signed with, delivered by `fnox exec`.
 *
 * A missing secret is not a startup error here, unlike in the hub: this server
 * is offline-first by construction, so it starts and serves every tool with no
 * secret and no hub — it just cannot sync, and `sync_status` says so. A hub that
 * cannot verify tokens would accept anything; an MCP server that cannot mint one
 * simply stays local.
 */

import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { join } from "node:path";
import { DEFAULT_WORKSPACE } from "@uberblick/schema";

/** The only hub address in this package. Matches mise's `HUB_URL` default. */
export const DEFAULT_HUB_URL = "ws://localhost:1234";

/**
 * Awareness colours for agent sessions. Picked by hashing the session id so a
 * session keeps one colour, and two concurrent sessions usually differ.
 */
const AGENT_COLORS = [
  "#7b5ec7",
  "#2f9e8f",
  "#c2683a",
  "#3a6fc2",
  "#a8407a",
  "#5f8b32",
] as const;

export interface McpConfig {
  /** The workspace whose rooms this server opens (`WORKSPACE_ID`). */
  workspaceId: string;
  /** Websocket endpoint of the hub (`HUB_URL`). */
  hubUrl: string;
  /**
   * HMAC secret for minting hub tokens (`HUB_AUTH_TOKEN`), or null when unset —
   * in which case hub sync is disabled and every tool still works.
   */
  authSecret: string | null;
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
  /** How long an agent's published cursor lives before it is withdrawn (ms). */
  cursorTtlMs: number;
  /** Log entries per room that trigger a snapshot-and-prune. */
  compactAfter: number;
}

function hashToIndex(value: string, buckets: number): number {
  let hash = 0;
  for (let index = 0; index < value.length; index += 1) {
    hash = (hash * 31 + value.charCodeAt(index)) | 0;
  }
  return Math.abs(hash) % buckets;
}

/** XDG data home, falling back to `~/.local/share`. */
function dataHome(env: NodeJS.ProcessEnv): string {
  const xdg = env.XDG_DATA_HOME?.trim();
  return xdg === undefined || xdg === ""
    ? join(homedir(), ".local", "share")
    : xdg;
}

/**
 * `<data home>/uberblick/<workspace>.sqlite` — one database per user per
 * workspace. Two MCP server instances sharing it is the normal case, not an
 * edge case: the store runs in WAL with a busy timeout, and every tool call
 * polls the log tail before it serves.
 */
export function defaultDatabasePath(
  workspaceId: string,
  env: NodeJS.ProcessEnv = process.env,
): string {
  return join(dataHome(env), "uberblick", `${workspaceId}.sqlite`);
}

function trimmed(value: string | undefined): string | null {
  const text = value?.trim();
  return text === undefined || text === "" ? null : text;
}

/**
 * The workspace has to be one path segment as well as one room segment: it names
 * the SQLite file, and `path.join` happily follows `..` or a `\` out of the data
 * directory — on Windows both separators count.
 *
 * Exported because `ub` resolves a workspace from files as well as the
 * environment and must apply this exact rule to all of them; `label` names the
 * source in the message, so a bad value in `./uberblick.json` does not report
 * itself as a bad `WORKSPACE_ID`.
 *
 * The rejected value is deliberately not in the message. `label` already says
 * where to look, and a secret mistakenly exported as `WORKSPACE_ID` would
 * otherwise be printed by the very error that refuses it.
 */
export function assertWorkspaceSegment(
  value: string,
  label = "WORKSPACE_ID",
): void {
  const rejected =
    value === "" ||
    value === "." ||
    value === ".." ||
    value.includes("/") ||
    value.includes("\\") ||
    value.includes("\0");
  if (rejected) {
    throw new Error(
      `${label} must be a single path and room segment: no "/", no "\\", ` +
        'not "." or ".."',
    );
  }
}

export function resolveMcpConfig(
  env: NodeJS.ProcessEnv = process.env,
): McpConfig {
  const workspaceId = trimmed(env.WORKSPACE_ID) ?? DEFAULT_WORKSPACE;
  assertWorkspaceSegment(workspaceId);
  const sessionId = `agent-${randomUUID()}`;

  return {
    workspaceId,
    hubUrl: trimmed(env.HUB_URL) ?? DEFAULT_HUB_URL,
    authSecret: trimmed(env.HUB_AUTH_TOKEN),
    databasePath:
      trimmed(env.UBERBLICK_DB) ?? defaultDatabasePath(workspaceId, env),
    sessionId,
    color: AGENT_COLORS[hashToIndex(sessionId, AGENT_COLORS.length)] ?? "#7b5ec7",
    connectTimeoutMs: 1_500,
    syncTimeoutMs: 3_000,
    reconnectMaxDelayMs: 2_000,
    cursorTtlMs: 30_000,
    compactAfter: 500,
  };
}

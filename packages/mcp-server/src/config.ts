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
 * `WORKSPACE_ID` is required and has no default: it names the rooms, the token
 * claim and the local database, and a wrong guess would quietly open somebody
 * else's corpus or start an empty one. A workspace id is a uuid, optionally
 * decorated as `<slug>-<uuid>` for display — schema owns that parse, and only
 * the uuid survives it.
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
import { parseWorkspaceId } from "@uberblick/schema";

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
  /**
   * The workspace whose rooms this server opens — the **bare uuid**, whatever
   * spelling `WORKSPACE_ID` used. Never a decorated `<slug>-<uuid>`: it keys
   * the rooms, the token claim and the database file, and two spellings of one
   * workspace must resolve to one of each.
   */
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
  /**
   * How long to leave a directory entry alone after its index write failed (ms).
   *
   * A refused write is usually a locked database, and retrying it on every tool
   * call would spend one SQLite busy timeout per attempt while the lock is
   * exactly what it is waiting on. The entry stays queued either way — this only
   * paces how often it is tried.
   */
  reconcileRetryMs: number;
  /**
   * How stale a directory stub's `updatedAt` must be before an observed content
   * change re-stamps it (ms).
   *
   * The whole point of the field is to be coarse. Every keystroke in any
   * document is an observed change, and stamping each one would put a directory
   * update — broadcast to every client in the workspace — behind every one of
   * them. A title or tag change still updates the stub immediately, because
   * that write has to happen anyway.
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

/** XDG data home, falling back to `~/.local/share`. */
function dataHome(env: NodeJS.ProcessEnv): string {
  const xdg = env.XDG_DATA_HOME?.trim();
  return xdg === undefined || xdg === ""
    ? join(homedir(), ".local", "share")
    : xdg;
}

/**
 * `<data home>/uberblick/<workspaceUuid>.sqlite` — one database per user per
 * workspace. Two MCP server instances sharing it is the normal case, not an
 * edge case: the store runs in WAL with a busy timeout, and every tool call
 * polls the log tail before it serves.
 *
 * Keyed by the bare uuid, never by a decorated spelling: `<slug>-<uuid>` and
 * `<uuid>` are one workspace, and they must hydrate one file — a slug-prefixed
 * filename would give the same corpus two local replicas that never converge.
 * A uuid is inherently path-safe, so nothing else has to guard this join.
 */
export function defaultDatabasePath(
  workspaceId: string,
  env: NodeJS.ProcessEnv = process.env,
): string {
  return join(
    dataHome(env),
    "uberblick",
    `${parseWorkspaceId(workspaceId).uuid}.sqlite`,
  );
}

function trimmed(value: string | undefined): string | null {
  const text = value?.trim();
  return text === undefined || text === "" ? null : text;
}

/** Every room, the token claim and the database file are keyed by this. */
const MISSING_WORKSPACE =
  "WORKSPACE_ID is not set. It names the rooms this server opens, the " +
  "workspace claim in its hub token, and its local database — there is no " +
  "default. Run `ub init` to create a workspace, or export WORKSPACE_ID " +
  "yourself (`ub status` prints the one in force).";

export function resolveMcpConfig(
  env: NodeJS.ProcessEnv = process.env,
): McpConfig {
  const configured = trimmed(env.WORKSPACE_ID);
  if (configured === null) {
    throw new Error(MISSING_WORKSPACE);
  }
  // A decorated value is accepted and parsed down: the slug is display, the
  // uuid is the identity, and only the identity goes any further.
  const workspaceId = parseWorkspaceId(configured).uuid;
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
    reconcileRetryMs: 5_000,
    updatedAtCoarsenessMs: 5 * 60_000,
  };
}

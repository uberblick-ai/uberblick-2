/**
 * MCP server configuration.
 *
 * Environment only — no config file, no CLI flags. An MCP client spawns this
 * process over stdio and hands it an environment; that is the whole interface.
 *
 * `HUB_URL` is plaintext config (an endpoint is not a secret) and the only
 * hardcoded address in this package is {@link DEFAULT_HUB_URL}. `HUB_AUTH_TOKEN`
 * is used only for loopback hubs; remote hubs use this machine's stored login.
 *
 * `WORKSPACE_ID` is required and has no default: it names the rooms, the token
 * claim and the local database, and a wrong guess would quietly open somebody
 * else's corpus or start an empty one. A workspace id is a uuid, optionally
 * decorated as `<slug>-<uuid>` for display — schema owns that parse, and only
 * the uuid survives it.
 *
 * Missing admission credentials never prevent local operation. Every tool
 * remains available against the durable store; sync_status names the sign-in,
 * workspace access or loopback secret needed to share pending edits.
 */

import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { resolveStorage } from "@uberblick/hub/storage";
import { isLoopbackEndpoint } from "@uberblick/hub/remote-url";
import { parseWorkspaceId } from "@uberblick/schema";

/**
 * The only hub address in this package, and the one a checkout falls back to:
 * `mise.toml` commits no `HUB_URL`, deliberately (#376).
 */
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
  /**
   * Remote endpoints use this machine's stored login. The process reads the
   * private credential store itself, never a key supplied in configuration.
   * Programmatic loopback callers may select the same stricter admission.
   */
  deviceLogin?: { env?: NodeJS.ProcessEnv };
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
   * How stale a directory stub's `updatedAt` must be before a content change
   * this server authored re-stamps it (ms).
   *
   * The whole point of the field is to be coarse. Every keystroke is a change,
   * and stamping each one would put a directory update — broadcast to every
   * client in the workspace — behind every one of them. A title or tag change
   * still updates the stub immediately, because that write has to happen
   * anyway.
   *
   * Only this server's own changes are on that clock at all: a change it merely
   * observed is stamped by whoever made it, never here — see `repairStub`.
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
 * `<workspaceUuid>.sqlite` in the user's workspace directory — one database per
 * user per workspace. Which directory that is belongs to
 * `@uberblick/hub/storage`, so the cli, this server and the hub cannot drift
 * into three answers; it is `$XDG_DATA_HOME/uberblick`, or
 * `~/.local/share/uberblick` when that variable names nothing absolute.
 *
 * Two MCP server instances sharing one file is the normal case, not an edge
 * case: the store runs in WAL with a busy timeout, and every tool call polls
 * the log tail before it serves.
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
    resolveStorage({ env }).workspaceDir,
    `${parseWorkspaceId(workspaceId).uuid}.sqlite`,
  );
}

function trimmed(value: string | undefined): string | null {
  const text = value?.trim();
  return text === undefined || text === "" ? null : text;
}

/**
 * The file `ub` keeps this machine's workspace in. Named here rather than
 * imported because the dependency runs cli → mcp-server: `packages/cli` owns
 * the file and its own `USER_CONFIG_FILE`, and `packages/cli/test/config.test.ts`
 * asserts that the path this message prints is the one the cli resolves.
 */
const USER_CONFIG_FILE = "config.json";

/**
 * Every room, the token claim and the database file are keyed by this — so a
 * machine with none configured gets the whole answer in one line: where `ub`
 * takes it from, and both commands that write there. `ub remote join` is the
 * one a machine binding to an existing hub runs, and the one a flag-day
 * re-bind needs.
 *
 * The path is a directory and a filename and never a secret: the signing
 * secret lives in `credentials.json`, which configuration never opens. The
 * separately composed device sync path reads that store directly.
 */
function missingWorkspace(env: NodeJS.ProcessEnv): string {
  const path = join(resolveStorage({ env }).configDir, USER_CONFIG_FILE);
  return (
    "WORKSPACE_ID is not set. It names the rooms this server opens, the " +
    "workspace claim in its hub token, and its local database — there is no " +
    `default. \`ub\` takes it from ${path}. Run \`ub init\` to create a ` +
    "workspace, or `ub remote join <hub>/<workspace>` to bind this machine to " +
    "one that already exists (`ub status` prints the one in force)."
  );
}

export function resolveMcpConfig(
  env: NodeJS.ProcessEnv = process.env,
): McpConfig {
  const configured = trimmed(env.WORKSPACE_ID);
  if (configured === null) {
    throw new Error(missingWorkspace(env));
  }
  // A decorated value is accepted and parsed down: the slug is display, the
  // uuid is the identity, and only the identity goes any further.
  const workspaceId = parseWorkspaceId(configured).uuid;
  const sessionId = `agent-${randomUUID()}`;
  const hubUrl = trimmed(env.HUB_URL) ?? DEFAULT_HUB_URL;
  const remote = !isLoopbackEndpoint(hubUrl);

  return {
    workspaceId,
    hubUrl,
    authSecret: remote ? null : trimmed(env.HUB_AUTH_TOKEN),
    ...(remote ? { deviceLogin: { env } } : {}),
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

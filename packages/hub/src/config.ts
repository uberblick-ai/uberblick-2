import type { HubLogger } from "./log.js";
import { isLoopbackHost } from "@uberblick/schema/loopback";

/** Loopback by default; exposing a hub requires an explicit bind address. */
export const DEFAULT_PORT = 1234;
export const DEFAULT_HOST = "127.0.0.1";

/**
 * Per-socket auth-in-flight memory bound: each pending room owns a queue and
 * hook payload. Exceeding it terminates the whole socket, including healthy
 * rooms, so clients must bound attach concurrency on every reconnect.
 * Keep the hub ceiling explicit across library upgrades. Per-room byte/message
 * limits remain at library defaults (5 MiB/1000) until measurements justify a change.
 */
export const MAX_PENDING_DOCUMENTS = 100;

export interface HubConfig {
  /** `0` binds an ephemeral port, reported by `Hub.port`; defaults to DEFAULT_PORT. */
  port?: number;
  /** `HUB_HOST`; defaults to loopback. Wildcard binds require device credentials. */
  address?: string;
  /** Only the release proxy's appended forwarded hop may select a sign-in client bucket. */
  behindReleaseProxy?: boolean;
  /** SQLite file; creates its parent. `":memory:"` loses everything on restart. */
  databasePath?: string;
  /** Local-only HMAC signing secret (`HUB_AUTH_TOKEN`). */
  authSecret?: string;
  log?: HubLogger;
  /** Store debounce in ms; defaults to Hocuspocus' 2s / 10s maximum. */
  debounce?: number;
  maxDebounce?: number;
  /** Test-only ceiling override; production uses MAX_PENDING_DOCUMENTS. */
  maxPendingDocuments?: number;
  /**
   * Test-only skew override; production uses the build's SYNC_PROTOCOL_VERSION.
   * createHub requires 1..999999 so clients can read the refusal sentinel.
   */
  protocolVersion?: number;
  /** Drain timeout in ms, after flushing; stop rejects when teardown times out. */
  shutdownTimeoutMs?: number;
}

function parsePort(raw: string | undefined): number {
  if (raw === undefined || raw.trim() === "") {
    return DEFAULT_PORT;
  }
  const port = Number(raw);
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new Error(`PORT must be an integer in 0..65535, got ${JSON.stringify(raw)}`);
  }
  return port;
}

/**
 * Bind HUB_HOST:PORT; HUB_URL selects client endpoints only.
 * @throws when a loopback hub has no `HUB_AUTH_TOKEN`, or the port is invalid.
 */
export function resolveCoreHubConfig(
  env: NodeJS.ProcessEnv,
  databasePath: string,
): HubConfig {
  const host = env.HUB_HOST?.trim();
  const address = host === undefined || host === "" ? DEFAULT_HOST : host;
  // Remote admission uses device credentials and current membership, never a leftover secret.
  const authSecret = isLoopbackHost(address) ? env.HUB_AUTH_TOKEN : undefined;
  if (isLoopbackHost(address) && (authSecret === undefined || authSecret === "")) {
    throw new Error(
      "HUB_AUTH_TOKEN is not set. It is the HMAC secret hub tokens are signed with; " +
        "run `ub workspace create <name>` or `ub open` to create this machine's local secret, or export HUB_AUTH_TOKEN.",
    );
  }

  return {
    port: parsePort(env.PORT),
    address,
    databasePath,
    ...(env.HUB_RELEASE_PROXY === "1" ? { behindReleaseProxy: true } : {}),
    ...(authSecret === undefined ? {} : { authSecret }),
  };
}

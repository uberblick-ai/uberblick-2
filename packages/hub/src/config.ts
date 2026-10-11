import type { HubLogger } from "./log.js";
import type { GithubSignInConfig } from "./github-sign-in.js";
import type { StorageOptions } from "./storage.js";
import { resolveStorage } from "./storage.js";
import { isLoopbackHost } from "./loopback.js";

/** Loopback by default; exposing a hub requires an explicit bind address. */
export const DEFAULT_PORT = 1234;
export const DEFAULT_HOST = "127.0.0.1";

/** Public Uberblick Login GitHub App; device flow needs no client secret. */
export const SHARED_GITHUB_CLIENT_ID = "Iv23liLW6D5SqP77El3z";

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
  /** SQLite file; creates its parent. `":memory:"` loses everything on restart. */
  databasePath?: string;
  /** Local-only HMAC signing secret (`HUB_AUTH_TOKEN`). */
  authSecret?: string;
  /** Remote device admission is unavailable without configured sign-in. */
  github?: GithubSignInConfig;
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

/**
 * Resolve hub.sqlite from the user's data root, independent of cwd/install path
 * so upgrades cannot replace it. Checkout tasks override HUB_DB_PATH to isolate dev data.
 */
export function defaultDatabasePath(options: StorageOptions = {}): string {
  return resolveStorage(options).hubDatabase;
}

/** Shared with ub status: HUB_DB_PATH overrides the user-root database. */
export function hubDatabasePath(
  env: NodeJS.ProcessEnv = process.env,
): string {
  const configured = env.HUB_DB_PATH?.trim();
  return configured === undefined || configured === ""
    ? defaultDatabasePath({ env })
    : configured;
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

/** Public app identifiers, distinct from an App ID or OAuth App client ID. */
export function validateGithubClientId(clientId: string): void {
  if (typeof clientId !== "string" || !/^(?:Iv1\.[a-fA-F0-9]{16}|Iv23[A-Za-z0-9]{16})$/.test(clientId)) {
    throw new Error("HUB_GITHUB_CLIENT_ID must be a GitHub App client ID (Iv1. followed by 16 hex digits, or Iv23 followed by 16 alphanumeric characters)");
  }
}

/**
 * Bind HUB_HOST:PORT; HUB_URL selects client endpoints only.
 * @throws for an invalid port or missing loopback secret; createHub validates GitHub config.
 */
export function resolveHubConfig(
  env: NodeJS.ProcessEnv = process.env,
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

  const githubClientId = env.HUB_GITHUB_CLIENT_ID;

  return {
    port: parsePort(env.PORT),
    address,
    databasePath: hubDatabasePath(env),
    ...(authSecret === undefined ? {} : { authSecret }),
    ...(githubClientId === undefined || githubClientId === "" ? {} : { github: { clientId: githubClientId } }),
  };
}

/** Standalone hubs offer sign-in by default; embedded hubs require explicit config. */
export function resolveRemoteHubConfig(
  env: NodeJS.ProcessEnv = process.env,
): HubConfig {
  const config = resolveHubConfig(env);
  config.github ??= { clientId: SHARED_GITHUB_CLIENT_ID };
  return config;
}

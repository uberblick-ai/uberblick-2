/**
 * Hub configuration.
 *
 * The hub binds `PORT` and never parses `HUB_URL`: the URL is a client-side
 * concern (which endpoint to dial), the port is a server-side one (which socket
 * to own), and conflating them is how hardcoded addresses creep in. `PORT`
 * defaults to 1234 — the one address-ish default in the repo.
 *
 * `HUB_AUTH_TOKEN` is the HMAC secret for {@link mintToken}/{@link verifyToken},
 * delivered by `fnox exec` (see the `mise run hub` task). There is no fallback:
 * a hub with no secret would accept anything, so an absent secret is a startup
 * error, not a warning.
 */

import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { HubLogger } from "./log.js";

/** The only hardcoded address-ish default in the repo. */
export const DEFAULT_PORT = 1234;

export interface HubConfig {
  /**
   * Port to bind. `0` binds an ephemeral port — read the real one back from
   * `Hub.port`. Defaults to {@link DEFAULT_PORT}.
   */
  port?: number;
  /** Bind address. Unset means every interface (Node's default). */
  address?: string;
  /**
   * SQLite file for document persistence. The parent directory is created if
   * missing. `":memory:"` works and loses everything on restart.
   */
  databasePath?: string;
  /** HMAC secret tokens are signed with (`HUB_AUTH_TOKEN`). Required. */
  authSecret: string;
  log?: HubLogger;
  /**
   * How long `onStoreDocument` is debounced (ms). Hocuspocus' own defaults
   * (2s / 10s max) are sane; tests shorten them.
   */
  debounce?: number;
  maxDebounce?: number;
  /**
   * How long `stop()` waits for Hocuspocus to drain its documents before it
   * gives up and closes the socket anyway (ms). The flush has already run by
   * then, so this bounds shutdown without risking data.
   */
  shutdownTimeoutMs?: number;
}

const packageRoot = dirname(dirname(fileURLToPath(import.meta.url)));

/**
 * `packages/hub/data/hub.sqlite`, resolved from this module rather than from
 * `process.cwd()` so the hub writes to the same file whatever directory it is
 * started from. `data/` is gitignored.
 */
export function defaultDatabasePath(): string {
  return join(packageRoot, "data", "hub.sqlite");
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
 * Build a config from the environment.
 *
 * @throws when `HUB_AUTH_TOKEN` is missing or `PORT` is not a valid port.
 */
export function resolveHubConfig(
  env: NodeJS.ProcessEnv = process.env,
): HubConfig {
  const authSecret = env.HUB_AUTH_TOKEN;
  if (authSecret === undefined || authSecret === "") {
    throw new Error(
      "HUB_AUTH_TOKEN is not set. It is the HMAC secret hub tokens are signed with; " +
        "run the hub through `mise run hub`, which wraps the command in `fnox exec`.",
    );
  }

  const databasePath = env.HUB_DB_PATH?.trim();

  return {
    port: parsePort(env.PORT),
    databasePath:
      databasePath === undefined || databasePath === ""
        ? defaultDatabasePath()
        : databasePath,
    authSecret,
  };
}

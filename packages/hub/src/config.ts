/**
 * Hub configuration.
 *
 * The hub binds `HUB_HOST`:`PORT` and never parses `HUB_URL`: the URL is a
 * client-side concern (which endpoint to dial), the bind address is a
 * server-side one (which socket to own), and conflating them is how hardcoded
 * addresses creep in. `PORT` defaults to 1234 and `HUB_HOST` to 127.0.0.1 —
 * the two address-ish defaults in the repo.
 *
 * The loopback default is the security model, not a convenience: the hub's only
 * credential is a single dev secret shared by every client, so a wildcard bind
 * would offer the whole LAN a hub that trusts anyone holding it. A hosted
 * deployment opts in with `HUB_HOST=0.0.0.0`.
 *
 * `HUB_DB_PATH` names the SQLite file outright. With none set the hub opens
 * `hub.sqlite` in the user's data root — see `@uberblick/hub/storage` — and
 * never a path inside the installed package, which an upgrade replaces. Every
 * mise task in this checkout sets `HUB_DB_PATH` to a checkout-local file, so
 * development never touches the packaged user's database.
 *
 * `HUB_AUTH_TOKEN` is the HMAC secret for {@link mintToken}/{@link verifyToken},
 * delivered by `fnox exec` (see the `mise run hub` task). There is no fallback:
 * a hub with no secret would accept anything, so an absent secret is a startup
 * error, not a warning.
 */

import type { HubLogger } from "./log.js";
import type { StorageOptions } from "./storage.js";
import { resolveStorage } from "./storage.js";

/** The only hardcoded address-ish defaults in the repo. */
export const DEFAULT_PORT = 1234;
export const DEFAULT_HOST = "127.0.0.1";

export interface HubConfig {
  /**
   * Port to bind. `0` binds an ephemeral port — read the real one back from
   * `Hub.port`. Defaults to {@link DEFAULT_PORT}.
   */
  port?: number;
  /**
   * Bind address (`HUB_HOST`). Defaults to {@link DEFAULT_HOST} — loopback, so
   * the hub is not on the network by accident. Wildcard is explicit opt-in.
   */
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

/**
 * `hub.sqlite` in the user's data root — see `@uberblick/hub/storage`.
 *
 * Derived from the *user*, never from where this package sits: a Homebrew or
 * tarball upgrade replaces program files, so a database under the install
 * directory is a database an upgrade can delete. Nothing here reads
 * `import.meta.url` or `process.cwd()`, which is what makes the answer the same
 * from any directory and from any copy of the package.
 *
 * This checkout's mise tasks set `HUB_DB_PATH` to a checkout-local file, so
 * development never opens the packaged user's database.
 */
export function defaultDatabasePath(options: StorageOptions = {}): string {
  return resolveStorage(options).hubDatabase;
}

/**
 * The database a hub started with this environment opens: `HUB_DB_PATH` when it
 * names one, and {@link defaultDatabasePath} otherwise. `ub status` reports it,
 * so the rule lives here rather than in two places that could disagree.
 */
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

  const host = env.HUB_HOST?.trim();

  return {
    port: parsePort(env.PORT),
    address: host === undefined || host === "" ? DEFAULT_HOST : host,
    databasePath: hubDatabasePath(env),
    authSecret,
  };
}

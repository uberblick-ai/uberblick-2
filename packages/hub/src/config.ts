/**
 * Hub configuration.
 *
 * The hub binds `HUB_HOST`:`PORT` and never parses `HUB_URL`: the URL is a
 * client-side concern (which endpoint to dial), the bind address is a
 * server-side one (which socket to own), and conflating them is how hardcoded
 * addresses creep in. `PORT` defaults to 1234 and `HUB_HOST` to 127.0.0.1 —
 * the two address-ish defaults in the repo.
 *
 * Loopback hubs use the local shared-secret model. Any other bind, including
 * a wildcard, requires device credentials and current workspace membership.
 *
 * `HUB_DB_PATH` names the SQLite file outright. With none set the hub opens
 * `hub.sqlite` in the user's data root — see `@uberblick/hub/storage` — and
 * never a path inside the installed package, which an upgrade replaces. Every
 * mise task in this checkout sets `HUB_DB_PATH` to a checkout-local file, so
 * development never touches the packaged user's database.
 *
 * `HUB_AUTH_TOKEN` is required only for loopback admission. Remote hubs never
 * read it for admission, including a value left by an earlier deployment.
 */

import type { HubLogger } from "./log.js";
import type { GithubSignInConfig } from "./github-sign-in.js";
import type { StorageOptions } from "./storage.js";
import { resolveStorage } from "./storage.js";
import { isLoopbackHost } from "./loopback.js";

/** The only hardcoded address-ish defaults in the repo. */
export const DEFAULT_PORT = 1234;
export const DEFAULT_HOST = "127.0.0.1";

/** Public Uberblick Login GitHub App; device flow needs no client secret. */
export const SHARED_GITHUB_CLIENT_ID = "Iv23liLW6D5SqP77El3z";

/**
 * How many documents one websocket may have in flight through authentication.
 *
 * A **memory-amplification guard, not a capacity knob.** Hocuspocus counts, per
 * connection, the documents whose `onAuthenticate` has not completed
 * (`ClientConnection.getPendingDocumentCount`): each one holds its own message
 * queue and hook payload, so a client that names hundreds of rooms before any
 * of them authenticates makes the hub allocate hundreds of those. Past the cap
 * Hocuspocus does not refuse the document — it `terminate()`s the whole socket,
 * taking every healthy room on it down with the greedy one. That is why raising
 * this number is never the fix for a client that attaches too fast: it only
 * moves the cliff. The client-side bound is the real guard —
 * `MAX_CONCURRENT_ROOM_ATTACHES` in `packages/mcp-server/src/sync.ts` keeps our
 * own attach/auth concurrency far below this, on first attach and on every
 * reconnect. This number is stated here so the hub owns its ceiling rather than
 * inheriting whatever a library upgrade decides, and it is the library's own
 * 4.6.0 default: nothing we run comes near it.
 *
 * Its two siblings — `maxUnauthenticatedQueueSize` (5 MiB) and
 * `maxUnauthenticatedQueueMessages` (1000) — stay at their defaults. They bound
 * *bytes and messages* buffered before auth, which is a property of how much a
 * client sends per room, not of how many rooms it opens; we have no measurement
 * saying either default is wrong, and an unmeasured number in the config is a
 * number nobody can defend later.
 */
export const MAX_PENDING_DOCUMENTS = 100;

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
  /** Local-only HMAC signing secret (`HUB_AUTH_TOKEN`). */
  authSecret?: string;
  /** Remote device admission is unavailable without configured sign-in. */
  github?: GithubSignInConfig;
  log?: HubLogger;
  /**
   * How long `onStoreDocument` is debounced (ms). Hocuspocus' own defaults
   * (2s / 10s max) are sane; tests shorten them.
   */
  debounce?: number;
  maxDebounce?: number;
  /**
   * The pending-document ceiling, defaulting to {@link MAX_PENDING_DOCUMENTS}.
   *
   * A test seam, not an operator dial: the only caller that sets it is the one
   * proving the MCP client stays below a ceiling, which needs a ceiling small
   * enough to breach in a few rooms rather than a hundred.
   */
  maxPendingDocuments?: number;
  /**
   * The sync protocol this hub speaks, defaulting to `SYNC_PROTOCOL_VERSION`
   * (`./protocol.ts`).
   *
   * A test seam, not an operator dial — a hub's protocol version is a property
   * of the build, and nothing in production sets it. It is settable because the
   * skew this hub refuses cannot otherwise be *observed*: every process in this
   * repository compiles the same constant, so a client-side test that could not
   * move one end would only be asserting the constant against itself.
   *
   * Validated by `createHub` against the range the wire can carry (an integer
   * 1..999999): a hub outside it would refuse every client with a reason none
   * of them could read.
   */
  protocolVersion?: number;
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

/** Public app identifiers, distinct from an App ID or OAuth App client ID. */
export function validateGithubClientId(clientId: string): void {
  if (typeof clientId !== "string" || !/^(?:Iv1\.[a-fA-F0-9]{16}|Iv23[A-Za-z0-9]{16})$/.test(clientId)) {
    throw new Error("HUB_GITHUB_CLIENT_ID must be a GitHub App client ID (Iv1. followed by 16 hex digits, or Iv23 followed by 16 alphanumeric characters)");
  }
}

/**
 * Build a config from the environment.
 *
 * @throws when a loopback hub has no `HUB_AUTH_TOKEN`, or the port is invalid.
 * `createHub` validates GitHub configuration before opening the database.
 */
export function resolveHubConfig(
  env: NodeJS.ProcessEnv = process.env,
): HubConfig {
  const host = env.HUB_HOST?.trim();
  const address = host === undefined || host === "" ? DEFAULT_HOST : host;
  const authSecret = isLoopbackHost(address) ? env.HUB_AUTH_TOKEN : undefined;
  if (isLoopbackHost(address) && (authSecret === undefined || authSecret === "")) {
    throw new Error(
      "HUB_AUTH_TOKEN is not set. It is the HMAC secret hub tokens are signed with; " +
        "set it explicitly, or use `mise run hub` with this machine's private credentials.json.",
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

/**
 * The standalone hub process used by remote deployments offers GitHub sign-in
 * without operator setup. Embedded hubs, including `ub open`, keep the
 * explicit-only configuration of `resolveHubConfig`.
 */
export function resolveRemoteHubConfig(
  env: NodeJS.ProcessEnv = process.env,
): HubConfig {
  const config = resolveHubConfig(env);
  config.github ??= { clientId: SHARED_GITHUB_CLIENT_ID };
  return config;
}

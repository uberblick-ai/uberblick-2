/**
 * Where `ub` gets its configuration.
 *
 * Precedence, highest first: the environment, `./uberblick.json` in the working
 * directory, `$XDG_CONFIG_HOME/uberblick/config.json`, and the built-in
 * defaults — which live in `@uberblick/mcp-server`, not here.
 *
 * What this module produces is an **environment**, not a config object. The MCP
 * server's interface is environment variables and nothing else (see
 * `packages/mcp-server/src/config.ts`), and that contract is what lets `ub mcp
 * serve` stay the one stable spawn line an MCP client is pointed at. So
 * resolution ends by naming `WORKSPACE_ID`, `HUB_URL` and `HUB_AUTH_TOKEN`, and
 * both consumers read them back through `resolveMcpConfig` — one definition of
 * the defaults, of the database path, and of the workspace rule, for the server
 * and for `ub status` alike. Environment beats every file for the same reason:
 * `HUB_URL=… ub mcp serve` has to keep working.
 *
 * Absent files are a default, never an error: nothing here requires `ub init` to
 * have run. A file that exists but cannot be read, parsed, or believed is a
 * warning, and warnings go to stderr — in the `ub mcp serve` path stdout is the
 * JSON-RPC transport.
 *
 * `HUB_AUTH_TOKEN` holds the hub's HMAC **signing secret**, not a token (see
 * `packages/hub/src/token.ts`). It is read from `credentials.json`, passed to the
 * server in its environment, and never printed. A `credentials.json` other users
 * can read is refused rather than used — see {@link credentialsAreExposed} — and
 * the secret is attached only to a hub the *user* chose, never to one a cloned
 * `./uberblick.json` chose — see {@link secretAppliesTo}.
 */

import { mkdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { assertWorkspaceSegment } from "@uberblick/mcp-server";
import {
  publishOwnerOnly,
  publishStaged,
  writeTempBeside,
} from "./safe-write.js";

/** The directory `ub`'s own files live in, under the XDG config home. */
const CONFIG_DIR = "uberblick";

/** Per-user identity, default workspace, remote endpoint. Not committed. */
export const USER_CONFIG_FILE = "config.json";

/** The hub signing secret and, later, remote tokens. Never committed. */
export const CREDENTIALS_FILE = "credentials.json";

/** Binds one checkout to one workspace. Committable, so never secrets. */
export const DIRECTORY_FILE = "uberblick.json";

/** The key holding the hub's HMAC signing secret in `credentials.json`. */
const SIGNING_SECRET_KEY = "signingSecret";

/** Which layer a resolved value came from. Stable strings: `--json` prints them. */
export type Origin = "environment" | "directory file" | "user config" | "default";

/** Where a signing secret came from, or null when none is configured. */
export type CredentialOrigin = "environment" | "credentials file";

export interface ResolvedConfig {
  /**
   * The environment the MCP server is handed: the process environment with what
   * we resolved written over it. Feed it to `resolveMcpConfig`, or to a spawn.
   */
  env: NodeJS.ProcessEnv;
  origins: {
    workspace: Origin;
    hubUrl: Origin;
    /**
     * Null when no signing secret is in force — none configured, or the file
     * holding it refused for its mode. Either way: local-only, by design.
     */
    credential: CredentialOrigin | null;
  };
  /** The files consulted, whether or not they exist. */
  paths: {
    userConfig: string;
    credentials: string;
    directoryFile: string;
  };
  /** Everything questionable about the configuration. For stderr, never stdout. */
  warnings: string[];
}

/** XDG config home, falling back to `~/.config` — the XDG default. */
export function configHome(env: NodeJS.ProcessEnv = process.env): string {
  const xdg = env.XDG_CONFIG_HOME?.trim();
  return xdg === undefined || xdg === "" ? join(homedir(), ".config") : xdg;
}

export function userConfigPath(env: NodeJS.ProcessEnv = process.env): string {
  return join(configHome(env), CONFIG_DIR, USER_CONFIG_FILE);
}

export function credentialsPath(env: NodeJS.ProcessEnv = process.env): string {
  return join(configHome(env), CONFIG_DIR, CREDENTIALS_FILE);
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function trimmed(value: string | undefined): string | null {
  const text = value?.trim();
  return text === undefined || text === "" ? null : text;
}

/**
 * Read a JSON object, or nothing. A missing file is silent; anything else wrong
 * with it is a warning and the layer is skipped — one broken file must not stop
 * `ub` from running with the layers below it.
 *
 * No parser output reaches a warning, for any of these files. Node's
 * `JSON.parse` errors quote the source around the syntax error, so the message
 * for a file someone pasted a bare secret into *is* the secret — and that is not
 * only `credentials.json`: a secret misplaced in `./uberblick.json` or
 * `config.json` is exactly the mistake {@link warnAboutMisplacedSecret} exists
 * to catch, and a file that does not parse never reaches it. An `ub` warning may
 * land in an MCP client's log, a screen-shared terminal or a CI transcript, so
 * the file's name is the whole of what is said about it.
 */
function readJsonObject(
  path: string,
  warnings: string[],
): Record<string, unknown> | null {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (error) {
    // An fs error names the path and the errno, never the file's contents.
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      warnings.push(`ignoring ${path}: ${message(error)}`);
    }
    return null;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    warnings.push(`ignoring ${path}: invalid JSON`);
    return null;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    warnings.push(`ignoring ${path}: expected a JSON object`);
    return null;
  }
  return parsed as Record<string, unknown>;
}

function stringField(
  source: Record<string, unknown> | null,
  key: string,
  path: string,
  warnings: string[],
): string | null {
  if (source === null || !(key in source)) {
    return null;
  }
  const value = source[key];
  if (typeof value !== "string" || value.trim() === "") {
    warnings.push(`ignoring "${key}" in ${path}: expected a non-empty string`);
    return null;
  }
  return value.trim();
}

interface Layer {
  origin: Origin;
  value: string | null;
  /** How to name this layer in an error message. */
  label: string;
}

/** The highest layer that has a value, or the built-in default. */
function pick(layers: Layer[]): { value: string | null; origin: Origin; label: string } {
  for (const layer of layers) {
    if (layer.value !== null) {
      return { value: layer.value, origin: layer.origin, label: layer.label };
    }
  }
  return { value: null, origin: "default", label: "the built-in default" };
}

/**
 * What `config.json` may hold. `ub init` writes it; {@link resolveConfig} reads
 * the two fields that resolve into an environment, and the identity fields ride
 * along for the awareness name and colour a client publishes.
 */
export interface UserConfig {
  // `| undefined` explicitly, under `exactOptionalPropertyTypes`: a field the
  // file does not carry reads as undefined rather than being absent.
  workspace?: string | undefined;
  hubUrl?: string | undefined;
  /** Awareness display name. */
  displayName?: string | undefined;
  /** Awareness colour, 6-digit hex — the only form y-prosemirror accepts. */
  color?: string | undefined;
}

/**
 * Read `config.json` for editing rather than for resolution.
 *
 * `ub init` has to preserve what it did not ask about — a `hubUrl` from
 * `ub remote join`, a field a later version writes — so it gets the raw object
 * back as well as the fields it understands. Resolution stays in
 * {@link resolveConfig}, which needs origins and per-layer labels this does not.
 */
export function readUserConfig(env: NodeJS.ProcessEnv = process.env): {
  /** The file as parsed, or null when it is absent or unusable. */
  raw: Record<string, unknown> | null;
  config: UserConfig;
  warnings: string[];
} {
  const warnings: string[] = [];
  const path = userConfigPath(env);
  const raw = readJsonObject(path, warnings);
  return {
    raw,
    config: {
      workspace: stringField(raw, "workspace", path, warnings) ?? undefined,
      hubUrl: stringField(raw, "hubUrl", path, warnings) ?? undefined,
      displayName: stringField(raw, "displayName", path, warnings) ?? undefined,
      color: stringField(raw, "color", path, warnings) ?? undefined,
    },
    warnings,
  };
}

/**
 * Write `config.json`, and return its path.
 *
 * Owner-only, like `credentials.json` beside it: nothing in here is a secret,
 * but it is one user's configuration and no other account has business reading
 * or — the part that matters — writing the hub URL a signed token is sent to.
 *
 * Written by {@link publishOwnerOnly}, exactly like `credentials.json` beside it:
 * one rule for how this CLI puts a file on disk, rather than a weaker one for
 * the file that happens not to hold the secret.
 */
export function writeUserConfig(
  config: Record<string, unknown>,
  env: NodeJS.ProcessEnv = process.env,
): string {
  const path = userConfigPath(env);
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  publishOwnerOnly(path, serialize(config));
  return path;
}

/**
 * A signing secret in a file that is not `credentials.json` is a mistake worth
 * naming: `./uberblick.json` is meant to be committed, and `config.json` is the
 * file `ub` will happily print fields from.
 */
function warnAboutMisplacedSecret(
  source: Record<string, unknown> | null,
  path: string,
  warnings: string[],
): void {
  if (source !== null && SIGNING_SECRET_KEY in source) {
    warnings.push(
      `ignoring "${SIGNING_SECRET_KEY}" in ${path}: the hub signing secret ` +
        `belongs in ${CREDENTIALS_FILE} (mode 0600), never here`,
    );
  }
}

/**
 * The signing secret is the one value in this layout another user on the machine
 * must not be able to read, so a file anyone else can read is refused, not
 * merely complained about — ssh's contract for a private key. Warning and then
 * using the secret anyway would leave the exposure in place and call it handled.
 *
 * Refusing is only the file layer: `HUB_AUTH_TOKEN` still wins and still works,
 * and with neither this machine is local-only, which is a supported state.
 */
function credentialsAreExposed(path: string, warnings: string[]): boolean {
  let mode: number;
  try {
    mode = statSync(path).mode;
  } catch {
    return false;
  }
  const permissions = mode & 0o777;
  if ((permissions & 0o077) === 0) {
    return false;
  }
  warnings.push(
    `refusing ${path}: mode ${permissions.toString(8).padStart(4, "0")} lets ` +
      "other users read the hub signing secret, so the secret in it was not " +
      `used — fix it with: chmod 600 ${path}`,
  );
  return true;
}

/**
 * Whether the stored secret belongs on this hub.
 *
 * `./uberblick.json` is committable, so a clone can carry one that points the
 * checkout at any endpoint its author likes. If the secret in the user's
 * `credentials.json` followed that URL, `ub status` in a freshly cloned
 * repository would hand a signed read-write token to a stranger's hub — no
 * prompt, no build step, just entering the directory.
 *
 * So the stored secret is scoped to hubs the *user* chose: the environment,
 * their own `config.json`, or the built-in default. `HUB_AUTH_TOKEN` in the
 * environment is itself a deliberate act and always applies, whatever chose the
 * URL, and that is the documented way to sync with a repository-chosen hub.
 */
function secretAppliesTo(hubUrlOrigin: Origin): boolean {
  return hubUrlOrigin !== "directory file";
}

/**
 * Read `credentials.json`.
 *
 * **`signingSecret` is the file's value whether or not the file is exposed.**
 * Anything *resolving* configuration must treat an exposed file as absent — see
 * {@link credentialsAreExposed} and how {@link resolveConfig} uses this. The
 * value is still returned because `ub init` repairs the mode of such a file by
 * rewriting it, and rewriting it means keeping what it held: regenerating would
 * cut this machine off from every other client already holding that secret.
 */
export function readCredentials(env: NodeJS.ProcessEnv = process.env): {
  path: string;
  /** The file as parsed, or null when it is absent or unusable. */
  raw: Record<string, unknown> | null;
  signingSecret: string | null;
  /** True when the file exists and other users can read it. */
  exposed: boolean;
  warnings: string[];
} {
  const warnings: string[] = [];
  const path = credentialsPath(env);
  const exposed = credentialsAreExposed(path, warnings);
  const raw = readJsonObject(path, warnings);
  return {
    path,
    raw,
    signingSecret: stringField(raw, SIGNING_SECRET_KEY, path, warnings),
    exposed,
    warnings,
  };
}

export interface ResolveOptions {
  env?: NodeJS.ProcessEnv;
  cwd?: string;
}

export function resolveConfig(options: ResolveOptions = {}): ResolvedConfig {
  const env = options.env ?? process.env;
  const cwd = options.cwd ?? process.cwd();
  const warnings: string[] = [];

  const paths = {
    userConfig: userConfigPath(env),
    credentials: credentialsPath(env),
    directoryFile: join(cwd, DIRECTORY_FILE),
  };

  const userConfig = readJsonObject(paths.userConfig, warnings);
  const directory = readJsonObject(paths.directoryFile, warnings);
  warnAboutMisplacedSecret(directory, paths.directoryFile, warnings);
  warnAboutMisplacedSecret(userConfig, paths.userConfig, warnings);

  const workspace = pick([
    {
      origin: "environment",
      value: trimmed(env.WORKSPACE_ID),
      label: "WORKSPACE_ID",
    },
    {
      origin: "directory file",
      value: stringField(directory, "workspace", paths.directoryFile, warnings),
      label: `"workspace" in ${paths.directoryFile}`,
    },
    {
      origin: "user config",
      value: stringField(userConfig, "workspace", paths.userConfig, warnings),
      label: `"workspace" in ${paths.userConfig}`,
    },
  ]);
  if (workspace.value !== null) {
    // The same rule the MCP server applies, applied to file-sourced values too:
    // the workspace names the SQLite file as well as the room.
    assertWorkspaceSegment(workspace.value, workspace.label);
  }

  const hubUrl = pick([
    { origin: "environment", value: trimmed(env.HUB_URL), label: "HUB_URL" },
    {
      origin: "directory file",
      value: stringField(directory, "hubUrl", paths.directoryFile, warnings),
      label: `"hubUrl" in ${paths.directoryFile}`,
    },
    {
      origin: "user config",
      value: stringField(userConfig, "hubUrl", paths.userConfig, warnings),
      label: `"hubUrl" in ${paths.userConfig}`,
    },
  ]);

  // Credentials are read last and from one file only. Nothing committable may
  // carry a secret, so there is no directory-file layer here by design. An
  // exposed file is refused outright: its one actionable message is the mode.
  const credentials = readCredentials(env);
  warnings.push(...credentials.warnings);
  const secretFromFile = credentials.exposed ? null : credentials.signingSecret;
  const secretFromEnv = trimmed(env.HUB_AUTH_TOKEN);

  let secret: string | null = secretFromEnv;
  let credentialOrigin: CredentialOrigin | null =
    secretFromEnv === null ? null : "environment";
  if (secret === null && secretFromFile !== null) {
    if (secretAppliesTo(hubUrl.origin)) {
      secret = secretFromFile;
      credentialOrigin = "credentials file";
    } else {
      warnings.push(
        `${paths.directoryFile} points this checkout at ${hubUrl.value}; the ` +
          `signing secret in ${paths.credentials} was not attached to a ` +
          "repository-chosen hub — export HUB_AUTH_TOKEN (or set HUB_URL " +
          "yourself) to sync with it",
      );
    }
  }

  const resolvedEnv: NodeJS.ProcessEnv = { ...env };
  if (workspace.value !== null) {
    resolvedEnv.WORKSPACE_ID = workspace.value;
  }
  if (hubUrl.value !== null) {
    resolvedEnv.HUB_URL = hubUrl.value;
  }
  if (secret !== null) {
    resolvedEnv.HUB_AUTH_TOKEN = secret;
  }

  return {
    env: resolvedEnv,
    origins: {
      workspace: workspace.origin,
      hubUrl: hubUrl.origin,
      credential: credentialOrigin,
    },
    paths,
    warnings,
  };
}

/** What `credentials.json` may hold today. Remote tokens arrive with #84. */
export interface Credentials {
  /** The hub's HMAC signing secret — not a token. */
  signingSecret?: string;
}

function serialize(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

/**
 * Write `credentials.json` with mode 0600, and return its path.
 *
 * The writer lives next to the reader because the mode is the point: this file
 * holds the secret every hub token is signed with, so it must never be readable
 * by another user on the machine. Every guarantee about how that is done — the
 * descriptor tightened before anything is written, symlinks refused rather than
 * followed — belongs to {@link publishOwnerOnly}, which is also what writes
 * `config.json`.
 */
export function writeCredentials(
  credentials: Credentials,
  env: NodeJS.ProcessEnv = process.env,
): string {
  const path = credentialsPath(env);
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  publishOwnerOnly(path, serialize(credentials));
  return path;
}

/**
 * Put a signing secret in `credentials.json` and return the one now on disk —
 * which is not necessarily the candidate.
 *
 * This is the race `ub init` must not lose. Two fresh runs (a `mise run setup`
 * and an editor's MCP client starting at the same moment) would each generate a
 * secret, and last-write-wins leaves one of them convinced of a value that is no
 * longer there. So the claim is exclusive: exactly one process can publish the
 * file, and every loser adopts the winner's secret rather than its own.
 *
 * **Written first, published second.** The mechanism is `link`, not an exclusive
 * `open`. `open(O_CREAT|O_EXCL)` is atomic about the *name* but not about the
 * contents: between the create and the write there is an instant where the file
 * exists and is empty, and a loser that reads it then finds no secret and
 * concludes there is none — which is the whole bug, one syscall further along.
 * `link` publishes a name and complete contents in a single atomic step, and
 * fails with EEXIST if anything already holds that name. There is therefore no
 * moment at which `credentials.json` exists and is not readable, and no lock
 * file is needed to say so.
 *
 * The remaining case is a `credentials.json` that already exists *without* a
 * signing secret in it (a remote token from #84, say). Adding one there is an
 * ordinary read-modify-write of a file this user already owns, and two of those
 * can still interleave. That is accepted: it is not the security-bearing race —
 * no two secrets can exist after this function — and callers re-read the file
 * before deriving anything from it, so they converge on what the last writer
 * left.
 */
export function claimSigningSecret(
  candidate: string,
  env: NodeJS.ProcessEnv = process.env,
): string {
  const path = credentialsPath(env);
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });

  const staged = writeTempBeside(
    path,
    serialize({ [SIGNING_SECRET_KEY]: candidate }),
  );
  if (publishStaged(staged, path, "absent")) {
    return candidate;
  }

  // Somebody else holds the name. Their secret is the one every other client on
  // this machine will use, so it becomes ours.
  const existing = readCredentials(env);
  if (existing.signingSecret !== null) {
    return existing.signingSecret;
  }
  // `link` leaves no empty window, so a file with no secret in it genuinely has
  // none. One re-read anyway, and only when the file did not parse at all — the
  // shape a half-written file would have if some other writer ever produced one.
  if (existing.raw === null) {
    const second = readCredentials(env);
    if (second.signingSecret !== null) {
      return second.signingSecret;
    }
  }
  writeCredentials({ ...existing.raw, [SIGNING_SECRET_KEY]: candidate }, env);
  return candidate;
}

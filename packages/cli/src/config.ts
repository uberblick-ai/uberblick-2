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
 * server in its environment, and never printed.
 */

import {
  chmodSync,
  mkdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { assertWorkspaceSegment } from "@uberblick/mcp-server";

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
    /** Null when no signing secret is configured: local-only, by design. */
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
 */
function readJsonObject(
  path: string,
  warnings: string[],
): Record<string, unknown> | null {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      warnings.push(`ignoring ${path}: ${message(error)}`);
    }
    return null;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    warnings.push(`ignoring ${path}: invalid JSON (${message(error)})`);
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
 * must not be able to read, so a file anyone else can read is a finding.
 */
function warnAboutCredentialsMode(path: string, warnings: string[]): void {
  let mode: number;
  try {
    mode = statSync(path).mode;
  } catch {
    return;
  }
  const permissions = mode & 0o777;
  if ((permissions & 0o077) !== 0) {
    warnings.push(
      `${path} is mode ${permissions.toString(8).padStart(4, "0")}: it holds ` +
        "the hub signing secret and should be 0600",
    );
  }
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
  // carry a secret, so there is no directory-file layer here by design.
  warnAboutCredentialsMode(paths.credentials, warnings);
  const credentials = readJsonObject(paths.credentials, warnings);
  const secretFromFile = stringField(
    credentials,
    SIGNING_SECRET_KEY,
    paths.credentials,
    warnings,
  );
  const secretFromEnv = trimmed(env.HUB_AUTH_TOKEN);
  const secret = secretFromEnv ?? secretFromFile;
  let credentialOrigin: CredentialOrigin | null = null;
  if (secretFromEnv !== null) {
    credentialOrigin = "environment";
  } else if (secretFromFile !== null) {
    credentialOrigin = "credentials file";
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

/**
 * Write `credentials.json` with mode 0600, and return its path.
 *
 * The writer lives next to the reader because the mode is the point: this file
 * holds the secret every hub token is signed with, so it must never be readable
 * by another user on the machine. `ub init` (#78) is its first caller.
 */
export function writeCredentials(
  credentials: Credentials,
  env: NodeJS.ProcessEnv = process.env,
): string {
  const path = credentialsPath(env);
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  writeFileSync(path, `${JSON.stringify(credentials, null, 2)}\n`, {
    mode: 0o600,
  });
  // `mode` on writeFileSync only applies when the file is created, so a file
  // that already existed keeps whatever mode it had. Say it outright instead.
  chmodSync(path, 0o600);
  return path;
}

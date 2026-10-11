/**
 * CLI and MCP resolve roots independently on every platform: absolute XDG config
 * and data roots override ~/.config and ~/.local/share respectively. Resolution
 * creates nothing; callers apply HUB_DB_PATH and UBERBLICK_DB above these defaults.
 * The released hub takes its database path from HUB_DB_PATH.
 */

import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";

export interface StorageOptions {
  env?: NodeJS.ProcessEnv;
}

export interface StoragePaths {
  /** Holds `config.json`, `credentials.json` and `ub workspace create`'s lock. */
  configDir: string;
  /** Root of this layout's durable data. */
  dataDir: string;
  /** The hub's document persistence, absent `HUB_DB_PATH`. */
  hubDatabase: string;
  /** Holds `<workspaceUuid>.sqlite`, absent `UBERBLICK_DB`. */
  workspaceDir: string;
}

/** The directory name both roots end in. */
const XDG_DIR = "uberblick";

const HUB_DATABASE = "hub.sqlite";

/**
 * Keep workspace enumeration consistent with this layout's UUID filenames.
 */
export const WORKSPACE_DATABASE_FILE =
  /^([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.sqlite$/;

function trimmed(value: string | undefined): string | null {
  const text = value?.trim();
  return text === undefined || text === "" ? null : text;
}

/**
 * Ignore empty or relative XDG values so the working directory cannot change
 * storage identity; an ignored value uses the same fallback as an unset one.
 */
function xdgDir(value: string | undefined): string | null {
  const text = trimmed(value);
  return text === null || !isAbsolute(text) ? null : text;
}

/**
 * All first writers use owner-only creation: mkdir's mode cannot repair an
 * existing directory. The umask can only remove permission bits from 0o700.
 */
export function createDataDirectory(path: string): void {
  mkdirSync(path, { recursive: true, mode: 0o700 });
}

/**
 * Resolve against the supplied HOME without mutating the process environment.
 */
function home(env: NodeJS.ProcessEnv): string {
  return trimmed(env.HOME) ?? homedir();
}

/** Resolve paths without opening files or platform-specific branches. */
export function resolveStorage(options: StorageOptions = {}): StoragePaths {
  const env = options.env ?? process.env;
  const configHome = xdgDir(env.XDG_CONFIG_HOME) ?? join(home(env), ".config");
  const dataHome =
    xdgDir(env.XDG_DATA_HOME) ?? join(home(env), ".local", "share");
  const dataDir = join(dataHome, XDG_DIR);
  return {
    configDir: join(configHome, XDG_DIR),
    dataDir,
    hubDatabase: join(dataDir, HUB_DATABASE),
    workspaceDir: dataDir,
  };
}

/** The private machine credential store shared by CLI and sync clients. */
export const CREDENTIALS_FILE = "credentials.json";

export function credentialsPath(env: NodeJS.ProcessEnv = process.env): string {
  return join(resolveStorage({ env }).configDir, CREDENTIALS_FILE);
}

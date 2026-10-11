/**
 * Shared cross-platform defaults, including macOS: uberblick/{config,credentials}.json
 * under XDG_CONFIG_HOME or ~/.config; uberblick/{hub,<uuid>}.sqlite under
 * XDG_DATA_HOME or ~/.local/share.
 * Roots resolve independently and only absolute XDG values apply. Resolution
 * creates nothing; writers create directories. Callers apply explicit HUB_DB_PATH
 * and UBERBLICK_DB file overrides above these defaults.
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
  /** Default root for durable data. */
  dataDir: string;
  /** The hub's document persistence, absent `HUB_DB_PATH`. */
  hubDatabase: string;
  /** Holds `<workspaceUuid>.sqlite`, absent `UBERBLICK_DB`. */
  workspaceDir: string;
}

const XDG_DIR = "uberblick";

const HUB_DATABASE = "hub.sqlite";

/** Shared with workspace enumeration so filename recognition cannot drift from this layout. */
export const WORKSPACE_DATABASE_FILE =
  /^([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.sqlite$/;

function trimmed(value: string | undefined): string | null {
  const text = value?.trim();
  return text === undefined || text === "" ? null : text;
}

/** Ignore relative XDG values rather than make machine storage depend on the working directory. */
function xdgDir(value: string | undefined): string | null {
  const text = trimmed(value);
  return text === null || !isAbsolute(text) ? null : text;
}

/**
 * All first writers create owner-only directories, including parents. mkdir's
 * mode cannot tighten existing directories; umask can only remove these bits.
 */
export function createDataDirectory(path: string): void {
  mkdirSync(path, { recursive: true, mode: 0o700 });
}

/** Resolve the supplied environment's home without mutating the process environment. */
function home(env: NodeJS.ProcessEnv): string {
  return trimmed(env.HOME) ?? homedir();
}

/** Pure, non-throwing path resolution, with no platform branch or filesystem access. */
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

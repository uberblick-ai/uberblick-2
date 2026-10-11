import { resolveCoreHubConfig, type HubConfig } from "@uberblick/hub/config";
import { resolveStorage, type StorageOptions } from "@uberblick/mcp-server/storage";

/** The local hub database belongs to the user, independently of installation. */
export function defaultHubDatabasePath(options: StorageOptions = {}): string {
  return resolveStorage(options).hubDatabase;
}

/** `ub status` and `ub open` resolve the same local database override. */
export function hubDatabasePath(env: NodeJS.ProcessEnv = process.env): string {
  const configured = env.HUB_DB_PATH?.trim();
  return configured === undefined || configured === ""
    ? defaultHubDatabasePath({ env })
    : configured;
}

export function resolveHubConfig(env: NodeJS.ProcessEnv = process.env): HubConfig {
  return resolveCoreHubConfig(env, hubDatabasePath(env));
}

/** Standalone hub configuration; desktop clients supply their own storage. */
import { resolveCoreHubConfig, type HubConfig } from "./config.js";
import type { GithubSignInConfig } from "./github-sign-in.js";

/** Public Uberblick Login GitHub App; device flow needs no client secret. */
export const SHARED_GITHUB_CLIENT_ID = "Iv23liLW6D5SqP77El3z";

export interface TeamHubConfig extends HubConfig {
  /** Remote device admission is unavailable without configured sign-in. */
  github?: GithubSignInConfig;
}

/** Public app identifiers, distinct from an App ID or OAuth App client ID. */
export function validateGithubClientId(clientId: string): void {
  if (typeof clientId !== "string" || !/^(?:Iv1\.[a-fA-F0-9]{16}|Iv23[A-Za-z0-9]{16})$/.test(clientId)) {
    throw new Error("HUB_GITHUB_CLIENT_ID must be a GitHub App client ID (Iv1. followed by 16 hex digits, or Iv23 followed by 16 alphanumeric characters)");
  }
}

export function requiredHubDatabasePath(env: NodeJS.ProcessEnv = process.env): string {
  const databasePath = env.HUB_DB_PATH?.trim();
  if (databasePath === undefined || databasePath === "") {
    throw new Error("HUB_DB_PATH must name the hub database file");
  }
  return databasePath;
}

/** Only standalone hub entry points offer the shared GitHub sign-in app. */
export function resolveRemoteHubConfig(env: NodeJS.ProcessEnv = process.env): TeamHubConfig {
  const config = resolveCoreHubConfig(env, requiredHubDatabasePath(env));
  const clientId = env.HUB_GITHUB_CLIENT_ID;
  return { ...config, github: { clientId: clientId === undefined || clientId === "" ? SHARED_GITHUB_CLIENT_ID : clientId } };
}

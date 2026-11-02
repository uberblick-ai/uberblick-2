import { join } from "node:path";
import { parseHubPublicUrl } from "@uberblick/schema/oauth";
import { DEFAULT_HUB_URL } from "./config.js";
import type { McpHostConfig } from "./http-host.js";
import { resolveStorage } from "./storage.js";

export function resolveMcpHostConfig(env: NodeJS.ProcessEnv = process.env): McpHostConfig & { host: string; port: number } {
  const port = env.MCP_PORT === undefined ? 3001 : Number(env.MCP_PORT);
  if (!Number.isInteger(port) || port < 0 || port > 65535 || env.MCP_PORT?.trim() === "") {
    throw new Error("MCP_PORT must be an integer in 0..65535");
  }
  return {
    issuer: parseHubPublicUrl(env.HUB_PUBLIC_URL),
    allowedOrigins: (env.MCP_ALLOWED_ORIGINS ?? "").split(",").map(origin => origin.trim()).filter(Boolean),
    hubUrl: env.HUB_URL ?? DEFAULT_HUB_URL,
    hubMcpSocket: env.HUB_MCP_SOCKET?.trim() || undefined,
    databaseDirectory: env.MCP_DATA_DIR ?? join(resolveStorage({ env }).dataDir, "mcp-host"),
    host: env.MCP_HOST ?? "127.0.0.1",
    port,
  };
}

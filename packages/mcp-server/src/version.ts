import { readFileSync } from "node:fs";

/**
 * Source runs read the MCP manifest; the installed bundle reads the same CLI
 * manifest as `ub --version`, beside both bundles in packages/cli/lib.
 */
export function mcpVersion(): string {
  const manifest = new URL("../package.json", import.meta.url);
  const parsed = JSON.parse(readFileSync(manifest, "utf8")) as {
    version?: unknown;
  };
  return typeof parsed.version === "string" ? parsed.version : "0.0.0";
}

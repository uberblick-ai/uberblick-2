/** The CLI's version, read from its own package.json — one place to bump. */

import { readFileSync } from "node:fs";

export function cliVersion(): string {
  const manifest = new URL("../package.json", import.meta.url);
  const parsed = JSON.parse(readFileSync(manifest, "utf8")) as {
    version?: unknown;
  };
  return typeof parsed.version === "string" ? parsed.version : "0.0.0";
}

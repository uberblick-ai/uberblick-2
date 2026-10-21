import { readFileSync } from "node:fs";

function manifest(): Record<string, unknown> {
  return JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
}

export function cliVersion(): string {
  const { version } = manifest();
  return typeof version === "string" ? version : "0.0.0";
}

export function isInstallPayload(): boolean {
  try {
    return manifest().uberblickInstallPayload === true;
  } catch {
    return false;
  }
}

/** Whether this running CLI came from a versioned install payload. */

import { readFileSync } from "node:fs";

export function isInstallPayload(): boolean {
  try {
    const manifest = JSON.parse(
      readFileSync(new URL("../package.json", import.meta.url), "utf8"),
    ) as { uberblickInstallPayload?: unknown };
    return manifest.uberblickInstallPayload === true;
  } catch {
    return false;
  }
}

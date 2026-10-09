/** Checkout-only preload; the released hub starts main.ts without this module. */
import { stderrLogger } from "./log.js";
import { requireBinding, resolveConfig } from "./project-config.js";

try {
  const resolved = resolveConfig();
  requireBinding(resolved);
  for (const warning of resolved.warnings) {
    stderrLogger({ event: "hub.config.warning", warning });
  }
  // The hub owns its listen address and database. Only loopback admission uses
  // this machine's signing secret; device-bound projects supply none.
  const secret = resolved.env.HUB_AUTH_TOKEN;
  if (secret === undefined) delete process.env.HUB_AUTH_TOKEN;
  else process.env.HUB_AUTH_TOKEN = secret;
} catch (error: unknown) {
  stderrLogger({ event: "hub.start.failed", error: String(error) });
  process.exit(1);
}

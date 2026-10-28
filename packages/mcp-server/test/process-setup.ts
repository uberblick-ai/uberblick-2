import { build } from "esbuild";
import { join } from "node:path";
import { measureSharedSetup } from "../../../scripts/report-shared-setup.mjs";
import { builtSource, hubCheckoutInvocation, HUB_ROOT, PACKAGE_ROOT } from "./process-helpers.js";

/** Build the server and worker entries once before any process proof runs. */
export default async function setup(): Promise<void> {
  const sources = new Set([
    join(PACKAGE_ROOT, "src/main.ts"),
    join(HUB_ROOT, "src/main.ts"),
    ...hubCheckoutInvocation().sources,
    ...["serving-engine", "store-open", "device-login", "store-upgrade", "shutdown-timeout", "history-holds", "history-cache", "history-refresher-role", "history-refresher", "workspace-detach"]
      .map((name) => join(PACKAGE_ROOT, "test", `${name}-worker.ts`)),
  ]);
  await measureSharedSetup("mcp-server: shared process entry bundle builds", "setup", () => Promise.all([...sources].map((source) => build({
    entryPoints: [source], outfile: builtSource(source), bundle: true,
    platform: "node", format: "esm", target: "node26", minify: true, sourcemap: true,
  }))));
}

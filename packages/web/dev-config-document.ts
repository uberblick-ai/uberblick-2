/**
 * The dev server's answer to `/uberblick-config.json`.
 *
 * One mechanism for every server that is not a deployment: `mise run web`,
 * `mise run dev`, the e2e harness and the first-user proof all reach the client
 * through this middleware, so what a browser reads is the same document in all
 * four and there is no second wiring to keep in step. A deployment has its own
 * server for it — Caddy's `respond`, or `ub open`'s handler — and this file is
 * deliberately not part of the bundle.
 *
 * It resolves the project binding and private credentials on each request,
 * through the same resolver as the CLI. A local binding uses the dev hub's
 * loopback address; an explicit UB_WORKSPACE_ID/UB_HUB_URL pair overrides it.
 *
 * **It serves the signing secret**, because since #426 that is where the client
 * reads it. On a dev server that is the owner's own secret handed to anything
 * that can reach the port — acceptable under the tailnet boundary (
 * REMOTE.md) and on loopback, which is what `vite` binds without `--host`.
 */

import type { Plugin } from "vite";
import { resolveDevProjectConfig } from "./dev-project-config.js";
export { resolveDevProjectConfig } from "./dev-project-config.js";

/** Contract, shared with `src/config.ts`, the Caddyfile and `ub open`. */
const HUB_CONFIG_PATH = "/uberblick-config.json";

/**
 * The document this project's binding and machine credentials describe.
 *
 * The workspace list is the bound workspace first — it is what `/` opens — then
 * `WORKSPACES`, deduplicated, exactly as the build-time defines composed it:
 * naming the default workspace in both is the ordinary configuration, and a
 * menu that offered it twice would be a bug the reader sees.
 */
export function devConfigDocument(env: NodeJS.ProcessEnv, cwd = process.cwd()): string {
  const config = resolveDevProjectConfig({ env, cwd });
  return JSON.stringify({
    hubUrl: config.hubUrl,
    workspaces: config.workspaces,
    hubAuthToken: config.hubAuthToken,
  });
}

/**
 * Serve {@link HUB_CONFIG_PATH} ahead of Vite's own middlewares.
 *
 * Installed from inside `configureServer`, which Vite runs *before* it adds its
 * internal middlewares — so this answers before the history fallback, which
 * would otherwise hand the client the app's own HTML and leave it reporting a
 * configuration error. `no-store` for the same reason the deployments set it: a
 * cached copy is how a retargeted client keeps dialling the old hub.
 */
export function devConfigDocumentPlugin(): Plugin {
  return {
    name: "uberblick:config-document",
    configureServer(server) {
      server.middlewares.use((request, response, next) => {
        const path = (request.url ?? "").split("?")[0];
        if (path !== HUB_CONFIG_PATH) {
          next();
          return;
        }
        response.setHeader("Content-Type", "application/json");
        response.setHeader("Cache-Control", "no-store");
        response.end(devConfigDocument(process.env));
      });
    },
  };
}

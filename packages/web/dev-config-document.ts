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
 * It answers from `process.env`, read per request rather than at config time:
 * the e2e harness sets `HUB_URL`, `HUB_AUTH_TOKEN`, `WORKSPACE_ID` and
 * `WORKSPACES` around `createServer`, and `mise run web` gets them from
 * `fnox exec -- ub env --`, which is this machine's own configuration.
 *
 * **It serves the signing secret**, because since #426 that is where the client
 * reads it. On a dev server that is the owner's own secret handed to anything
 * that can reach the port — acceptable under the tailnet boundary (
 * REMOTE.md) and on loopback, which is what `vite` binds without `--host`.
 */

import type { Plugin } from "vite";

/** Contract, shared with `src/config.ts`, the Caddyfile and `ub open`. */
const HUB_CONFIG_PATH = "/uberblick-config.json";

/**
 * The document this machine's environment describes.
 *
 * The workspace list is `WORKSPACE_ID` first — it is what `/` opens — then
 * `WORKSPACES`, deduplicated, exactly as the build-time defines composed it:
 * naming the default workspace in both is the ordinary configuration, and a
 * menu that offered it twice would be a bug the reader sees.
 */
export function devConfigDocument(env: NodeJS.ProcessEnv): string {
  const workspaces = [
    ...new Set(
      [env.WORKSPACE_ID ?? "", ...(env.WORKSPACES ?? "").split(",")]
        .map((entry) => entry.trim())
        .filter((entry) => entry !== ""),
    ),
  ];
  return JSON.stringify({
    hubUrl: env.HUB_URL ?? "",
    workspaces,
    hubAuthToken: env.HUB_AUTH_TOKEN ?? "",
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

/**
 * Shared runtime config middleware for checkout dev, e2e and first-user proof;
 * excluded from the bundle. Resolve binding and private credentials per request
 * through the CLI resolver. Local binding uses loopback; an explicit workspace/
 * hub environment pair overrides it. This serves the local signing secret to
 * anyone reaching the port: keep Vite on loopback or within REMOTE.md's tailnet
 * boundary. Deployments serve the document through Caddy or ub open instead.
 */

import type { Plugin } from "vite";
import { resolveDevProjectConfig } from "./dev-project-config.js";
export { resolveDevProjectConfig } from "./dev-project-config.js";

/** Contract, shared with `src/config.ts`, the Caddyfile and `ub open`. */
const HUB_CONFIG_PATH = "/uberblick-config.json";

/** Bound workspace first for `/`, then deduplicated WORKSPACES, matching build defines. */
export function devConfigDocument(env: NodeJS.ProcessEnv, cwd = process.cwd()): string {
  const config = resolveDevProjectConfig({ env, cwd });
  return JSON.stringify({
    hubUrl: config.hubUrl,
    workspaces: config.workspaces,
    hubAuthToken: config.hubAuthToken,
  });
}

/** Install before Vite's HTML fallback; no-store prevents dialing a cached old hub. */
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

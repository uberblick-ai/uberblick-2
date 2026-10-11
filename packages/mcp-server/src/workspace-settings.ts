/** Creation-time workspace settings, private to the CLI onboarding path. */

import { setWorkspaceName, validateWorkspaceName } from "@uberblick/schema";
import type { McpConfig } from "./config.js";
import { Replicas } from "./replica.js";
import { MirrorStore } from "./store.js";

/**
 * The caller owns the UUID claim. Persist independently of starter seeding or
 * hub availability; the observer logs synchronously and marks settings pending.
 */
export function storeWorkspaceName(config: McpConfig, name: string): void {
  const validated = validateWorkspaceName(name);
  const store = new MirrorStore(config.databasePath, config.workspaceId);
  let replicas: Replicas | undefined;
  try {
    replicas = new Replicas({ ...config, authSecret: null }, store, {
      publishOwnPresence: false,
    });
    setWorkspaceName(replicas.settings().doc, validated);
    replicas.assertHealthy();
  } finally {
    replicas?.destroy();
    store.close();
  }
}

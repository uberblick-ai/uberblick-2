/** Creation-time workspace settings, private to the CLI onboarding path. */

import { setWorkspaceName, validateWorkspaceName } from "@uberblick/schema";
import type { McpConfig } from "./config.js";
import { Replicas } from "./replica.js";
import { MirrorStore } from "./store.js";

/**
 * Store a newly created workspace's name durably in this machine's replica.
 *
 * The caller owns the UUID claim. This write is independent of starter seeding
 * and needs no hub: the ordinary replica observer commits it to the update log
 * synchronously, marking the settings room pending for the next syncing client.
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

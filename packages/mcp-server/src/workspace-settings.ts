/** Creation-time workspace settings, private to the CLI onboarding path. */

import { setWorkspaceName, validateWorkspaceName } from "@uberblick/schema";
import type { McpConfig } from "./config.js";
import { openWorkspaceReplicas } from "./workspace-replicas.js";

/**
 * Store a newly created workspace's name durably in this machine's replica.
 *
 * The caller owns the UUID claim. This write is independent of starter seeding
 * and needs no hub: the ordinary replica observer commits it to the update log
 * synchronously, marking the settings room pending for the next syncing client.
 */
export function storeWorkspaceName(config: McpConfig, name: string): void {
  const validated = validateWorkspaceName(name);
  const workspace = openWorkspaceReplicas(config, {
    hubFree: true,
    publishOwnPresence: false,
  });
  const { replicas } = workspace;
  try {
    setWorkspaceName(replicas.settings().doc, validated);
    replicas.assertHealthy();
  } finally {
    workspace.close();
  }
}

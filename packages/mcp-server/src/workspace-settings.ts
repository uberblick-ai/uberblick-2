/** Creation-time workspace settings, private to the CLI onboarding path. */

import { setWorkspaceName, validateWorkspaceName } from "@uberblick/schema";
import type { McpConfig } from "./config.js";
import { openWorkspaceReplicas } from "./workspace-replicas.js";

/**
 * The caller owns the UUID claim. Persist independently of starter seeding or
 * hub availability; the observer logs synchronously and marks settings pending.
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

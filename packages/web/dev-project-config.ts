/** Node-only configuration shared by the checkout's web and cursor processes. */
import { requireBinding, resolveConfig, type ResolveOptions } from "@uberblick/hub/project-config";

export function resolveDevProjectConfig(options: ResolveOptions = {}) {
  const resolved = resolveConfig(options);
  const binding = requireBinding(resolved);
  const env = options.env ?? process.env;
  return {
    hubUrl: binding.hubUrl ?? "ws://localhost:1234",
    workspaceId: binding.workspaceId,
    workspaces: [...new Set([binding.workspaceId, ...(env.WORKSPACES ?? "").split(",")]
      .map((entry) => entry.trim()).filter((entry) => entry !== ""))],
    hubAuthToken: resolved.env.HUB_AUTH_TOKEN?.trim() ?? "",
    warnings: resolved.warnings,
  };
}

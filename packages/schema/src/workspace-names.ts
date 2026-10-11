/** Display names shared by credential issuers and their clients. */
import { validateWorkspaceName } from "./workspace-settings.js";

/** Bad display data never invalidates a credential or adds workspace authority. */
export function sanitizeWorkspaceNames(
  value: unknown,
  workspaces: readonly string[],
  credentialKey: string,
  collectionSecret?: string,
): Record<string, string> | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const names: Record<string, string> = {};
  for (const workspace of workspaces) {
    if (!Object.hasOwn(value, workspace)) continue;
    const name = (value as Record<string, unknown>)[workspace];
    if (typeof name !== "string" || name.includes(credentialKey) ||
        (collectionSecret !== undefined && name.includes(collectionSecret))) continue;
    try {
      if (validateWorkspaceName(name) === name) names[workspace] = name;
    } catch { /* Unsafe names remain unnamed. */ }
  }
  return Object.keys(names).length === 0 ? undefined : names;
}

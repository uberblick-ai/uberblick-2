import { readdirSync } from "node:fs";
import { WORKSPACE_DATABASE_FILE, resolveStorage } from "@uberblick/mcp-server/storage";
import { resolveProjectBinding } from "@uberblick/mcp-server/project-binding";
import { recordedWorkspaceIds } from "@uberblick/mcp-server/workspace-registry";
import { describeFsError } from "@uberblick/mcp-server/safe-write";
import { parseWorkspaceId } from "@uberblick/schema";

export function workspaceDatabaseIds(env: NodeJS.ProcessEnv): Set<string> {
  const directory = resolveStorage({ env }).workspaceDir;
  let names: string[];
  try {
    names = readdirSync(directory);
  } catch (error) {
    // Only absence means an empty inventory; other errors would corrupt prefix lookup.
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return new Set();
    throw new Error(`cannot list ${directory}: ${describeFsError(error)}`);
  }
  const ids = new Set<string>();
  for (const name of names) {
    const match = WORKSPACE_DATABASE_FILE.exec(name);
    if (match?.[1] !== undefined) ids.add(match[1]);
  }
  return ids;
}

/** Read after publication so a newly created replica counts as a collision too. */
export function shortWorkspaceId(id: string): string {
  const uuid = parseWorkspaceId(id).uuid;
  try {
    const ids = workspaceDatabaseIds(process.env);
    for (const recorded of recordedWorkspaceIds()) ids.add(recorded);
    const selected = resolveProjectBinding().binding;
    if (selected !== null) ids.add(parseWorkspaceId(selected.workspaceId).uuid);
    let length = 8;
    while ([...ids].some(other => other !== uuid && other.startsWith(uuid.slice(0, length)))) length++;
    return uuid.slice(0, length);
  } catch {
    // A presentation-only read must not turn a published binding into a failed command.
    return uuid;
  }
}

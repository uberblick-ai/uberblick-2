import { randomUUID } from "node:crypto";
import { readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { acquireWorkspaceRemovalRole } from "@uberblick/mcp-server";
import { acquireInitLock } from "@uberblick/mcp-server/init-lock";
import { resolveStorage } from "@uberblick/mcp-server/storage";

function directory(env: NodeJS.ProcessEnv): string {
  return join(resolveStorage({ env }).configDir, ".open-runs");
}

/** Track the whole run, including replicas whose databases are outside the roots. */
export async function registerOpenRun(env: NodeJS.ProcessEnv): Promise<{ close(): void }> {
  const init = await acquireInitLock(env, { command: "ub open" });
  try {
    const path = join(directory(env), randomUUID());
    const role = acquireWorkspaceRemovalRole(path);
    return {
      close() {
        try { rmSync(`${path}.serving-lock`, { force: true }); }
        finally { role.close(); }
      },
    };
  } finally { init.release(); }
}

/** Caller holds the init lock, preventing new runs from registering. */
export function openRunPaths(env: NodeJS.ProcessEnv): string[] {
  const root = directory(env);
  let names: string[];
  try { names = readdirSync(root); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  return names.filter(name => /^[0-9a-f-]{36}\.serving-lock$/.test(name))
    .map(name => join(root, name.slice(0, -".serving-lock".length)));
}

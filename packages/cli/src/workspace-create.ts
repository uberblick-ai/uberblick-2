import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { defaultWorkspaceDatabasePath, storeWorkspaceName } from "@uberblick/mcp-server";
import { validateWorkspaceName } from "@uberblick/schema";
import { ensureLocalSigningSecret, SigningSecretExposureError } from "@uberblick/mcp-server/project-config";
import { resolveMcpConfig } from "./budget.js";
import { type CommandArgs, usageError } from "./command.js";
import { acquireInitLock, seedLockPath } from "@uberblick/mcp-server/init-lock";
import type { Io } from "./io.js";
import { PROJECT_CONFIG_FILE, type ProjectBinding, findProjectConfig, resolveProjectBinding, writeProjectBinding } from "@uberblick/mcp-server/project-binding";
import { seedStarterDocs } from "./starter.js";
import { fillMainRepositoryFromOrigin } from "./workspace-main-repository.js";
import { useBindingLines } from "./workspace-use-output.js";

export const WORKSPACE_CREATE_HELP = `usage: ub workspace create <name>

Create a separate local-only workspace with starter documents, and select it in
this directory's .uberblick.json. No hub or login is needed. Other workspaces,
project bindings and MCP registrations stay as they are.

options:
  -h, --help        show this help
`;

/** A shell override keeps selecting its binding after the project file changes. */
export function reportEnvironmentBinding(io: Io): void {
  if (process.env.UB_WORKSPACE_ID !== undefined || process.env.UB_HUB_URL !== undefined) {
    io.err("ub: environment binding still takes precedence; unset UB_WORKSPACE_ID and UB_HUB_URL to use the project binding.\n");
  }
}

export async function createWorkspaceCommand({ positionals }: CommandArgs<Record<string, never>>, io: Io): Promise<number> {
  let name: string;
  try {
    name = validateWorkspaceName(positionals[0] ?? "");
  } catch (error) {
    usageError(error instanceof Error ? error.message : "invalid name");
  }
  const uuid = randomUUID();
  const binding: ProjectBinding = { workspaceId: uuid, hubUrl: null };
  // Always create in this directory, never overwrite an ancestor project's binding.
  const path = join(process.cwd(), PROJECT_CONFIG_FILE);
  let previous: ProjectBinding | null = null;
  let output = "";
  try {
    const lock = await acquireInitLock(process.env, { command: "ub workspace create" });
    try {
      // Reject an invalid target before creating a replica. An ancestor binding
      // is not this new project's target and is left alone.
      if (findProjectConfig() === path) previous = resolveProjectBinding({ env: {} }).binding;
      try {
        ensureLocalSigningSecret(process.env);
      } catch (error) {
        // Offline workspace creation remains useful even when this computer's
        // secret must be replaced. Never repair or overwrite the exposed file.
        if (!(error instanceof SigningSecretExposureError)) throw error;
        io.err(`ub workspace create: ${error.message}.\n`);
      }
      const env = { ...process.env, WORKSPACE_ID: uuid, UB_WORKSPACE_ID: uuid, UB_HUB_URL: "local", HUB_URL: undefined,
        HUB_AUTH_TOKEN: undefined, HUB_ADMISSION: undefined,
        UBERBLICK_DB: defaultWorkspaceDatabasePath(uuid, process.env) };
      if (existsSync(env.UBERBLICK_DB)) throw new Error("generated workspace already exists; retry creation");
      const { deviceLogin: _deviceLogin, ...base } = resolveMcpConfig(env);
      const config = { ...base, authSecret: null };
      // The explicit config prevents even an existing login for localhost from
      // making creation dial a hub. The seed has its own shared writer lock.
      const seedLock = await acquireInitLock(process.env, { path: seedLockPath(), command: "ub workspace create" });
      try {
        storeWorkspaceName(config, name);
        await seedStarterDocs(env, config);
        await fillMainRepositoryFromOrigin(uuid, null, config.databasePath);
      } finally { seedLock.release(); }
      writeProjectBinding(binding, { path });
      output = `${useBindingLines(binding, previous, path, "created")}open it with: ub open\n`;
    } finally { lock.release(); }
    io.out(output);
    reportEnvironmentBinding(io);
    return 0;
  } catch (error) {
    io.err(`ub workspace create: ${error instanceof Error ? error.message : "creation failed"}. Project binding unchanged.\n`);
    return 1;
  }
}

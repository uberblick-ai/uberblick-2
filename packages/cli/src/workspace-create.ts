import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { defaultDatabasePath, storeWorkspaceName } from "@uberblick/mcp-server";
import { validateWorkspaceName } from "@uberblick/schema";
import { ensureLocalSigningSecret, SigningSecretExposureError } from "./config.js";
import { resolveMcpConfig } from "./budget.js";
import { takeHelp } from "./help.js";
import { acquireInitLock, seedLockPath } from "./init-lock.js";
import type { Io } from "./io.js";
import { PROJECT_CONFIG_FILE, type ProjectBinding, findProjectConfig, resolveProjectBinding, writeProjectBinding } from "./project-binding.js";
import { seedStarterDocs } from "./starter.js";

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

export async function createWorkspaceCommand(argv: string[], io: Io): Promise<number> {
  if (takeHelp(argv, io, WORKSPACE_CREATE_HELP)) return 0;
  let name: string;
  try {
    const { positionals } = parseArgs({ args: argv, options: {}, allowPositionals: true });
    if (positionals.length !== 1) throw new Error("expected exactly one workspace name");
    name = validateWorkspaceName(positionals[0] ?? "");
  } catch (error) {
    io.err(`ub workspace create: ${error instanceof Error ? error.message : "invalid name"}\n`);
    return 2;
  }
  const uuid = randomUUID();
  const binding: ProjectBinding = { workspaceId: uuid, hubUrl: null };
  // Always create in this directory, never overwrite an ancestor project's binding.
  const path = join(process.cwd(), PROJECT_CONFIG_FILE);
  let previous: ProjectBinding | null = null;
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
        UBERBLICK_DB: defaultDatabasePath(uuid, process.env) };
      if (existsSync(env.UBERBLICK_DB)) throw new Error("generated workspace already exists; retry creation");
      const { deviceLogin: _deviceLogin, ...base } = resolveMcpConfig(env);
      const config = { ...base, authSecret: null };
      // The explicit config prevents even an existing login for localhost from
      // making creation dial a hub. The seed has its own shared writer lock.
      const seedLock = await acquireInitLock(process.env, { path: seedLockPath(), command: "ub workspace create" });
      try {
        storeWorkspaceName(config, name);
        await seedStarterDocs(env, config);
      } finally { seedLock.release(); }
      writeProjectBinding(binding, { path });
    } finally { lock.release(); }
    io.out(`Created ${name} (${uuid}), local-only.\nSelected in ${path}.\nRun \`ub open\` to open it.\n`);
    if (previous !== null) {
      io.out(`Previous workspace ${previous.workspaceId} (${previous.hubUrl ?? "local"}) and its documents remain unchanged.\n` +
        `Switch back: ub workspace use ${previous.workspaceId}\n`);
    }
    reportEnvironmentBinding(io);
    return 0;
  } catch (error) {
    io.err(`ub workspace create: ${error instanceof Error ? error.message : "creation failed"}. Project binding unchanged.\n`);
    return 1;
  }
}

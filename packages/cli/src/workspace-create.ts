import { randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { defaultDatabasePath, storeWorkspaceName } from "@uberblick/mcp-server";
import { validateWorkspaceName } from "@uberblick/schema";
import { resolveMcpConfig } from "./budget.js";
import { takeHelp } from "./help.js";
import { acquireInitLock, seedLockPath } from "./init-lock.js";
import type { Io } from "./io.js";
import { TARGETS, targetFile } from "./mcp-config.js";
import { PROJECT_CONFIG_FILE, type ProjectBinding, findProjectConfig, resolveProjectBinding, writeProjectBinding } from "./project-binding.js";
import { seedStarterDocs } from "./starter.js";

export const WORKSPACE_CREATE_HELP = `usage: ub workspace create <name>

Create a separate local-only workspace with starter documents, and select it in
this directory's .uberblick.json. No hub or login is needed. Other workspaces,
project bindings and MCP registrations stay as they are.

options:
  -h, --help        show this help
`;

/** Report pinned clients without reading or printing any credential values. */
export function reportWorkspacePins(binding: ProjectBinding, io: Io): void {
  if (process.env.UB_WORKSPACE_ID !== undefined || process.env.UB_HUB_URL !== undefined) {
    io.err("ub: environment binding still takes precedence; unset UB_WORKSPACE_ID and UB_HUB_URL to use the project binding.\n");
  }
  const files = new Set(TARGETS.flatMap(target => ["project", "user"].map(scope =>
    targetFile(target, scope as "project" | "user", process.cwd()).path)));
  if ([...files].some(path => {
    try { return /\b(?:UB_)?WORKSPACE_ID\b/.test(readFileSync(path, "utf8")); }
    catch { return false; }
  })) {
    io.err("ub: existing MCP registrations retain their previous workspace and hub pins. " +
      `To add this selection, run \`ub mcp install --workspace ${binding.workspaceId} --hub ${binding.hubUrl ?? "local"} --label <label>\`.\n`);
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
    const lock = await acquireInitLock();
    try {
      // Reject an invalid target before creating a replica. An ancestor binding
      // is not this new project's target and is left alone.
      if (findProjectConfig() === path) previous = resolveProjectBinding({ env: {} }).binding;
      const env = { ...process.env, WORKSPACE_ID: uuid, UB_WORKSPACE_ID: uuid, UB_HUB_URL: "local", HUB_URL: undefined,
        HUB_AUTH_TOKEN: undefined, HUB_ADMISSION: undefined,
        UBERBLICK_DB: defaultDatabasePath(uuid, process.env) };
      if (existsSync(env.UBERBLICK_DB)) throw new Error("generated workspace already exists; retry creation");
      const { deviceLogin: _deviceLogin, ...base } = resolveMcpConfig(env);
      const config = { ...base, authSecret: null };
      // The explicit config prevents even an existing login for localhost from
      // making creation dial a hub. The seed uses the same lock as ub init.
      const seedLock = await acquireInitLock(process.env, { path: seedLockPath() });
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
    reportWorkspacePins(binding, io);
    return 0;
  } catch (error) {
    io.err(`ub workspace create: ${error instanceof Error ? error.message : "creation failed"}. Project binding unchanged.\n`);
    return 1;
  }
}

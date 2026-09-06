/**
 * Disposable #909 prototype for project-owned agent launch data.
 *
 * This file lives only on the retained spike branch. It deliberately proves
 * the control/candidate boundary without implementing the standing loop,
 * installation, updates, or workflow policy.
 */

import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import { parseArgs } from "node:util";
import type { Io } from "./io.js";

const HELP = `usage: ub agents launch <role> --project <dir> --candidate <dir> [--model claude|codex]

Disposable #909 probe: load the workflow from the named project while making
an independently selected candidate tree available to the launched role.
`;

interface RoleData {
  contract: string;
  defaultRuntime: "claude" | "codex";
  runtimes: {
    claude: { adapter: string; permissionMode: "auto"; allowedTools: string[] };
    codex: { adapter: string; sandbox: "workspace-write" };
  };
}

function roleData(project: string, role: string): RoleData {
  const launchPath = resolve(project, ".agents/launch.json");
  const raw = JSON.parse(readFileSync(launchPath, "utf8")) as {
    version?: unknown;
    entryRoles?: Record<string, RoleData>;
  };
  const entry = raw.version === 1 ? raw.entryRoles?.[role] : undefined;
  if (entry === undefined) throw new Error(`${launchPath} has no ${JSON.stringify(role)} role`);
  for (const relative of [
    entry.contract,
    entry.runtimes.claude.adapter,
    entry.runtimes.codex.adapter,
  ]) {
    if (isAbsolute(relative) || relative.includes("..") || !existsSync(resolve(project, relative))) {
      throw new Error(`${launchPath} names unreadable project resource ${JSON.stringify(relative)}`);
    }
  }
  return entry;
}

export async function agentsPrototypeCommand(argv: string[], io: Io): Promise<number> {
  const [subcommand, ...rest] = argv;
  if (subcommand === "help" || subcommand === "--help" || subcommand === "-h") {
    io.out(HELP);
    return 0;
  }
  if (subcommand !== "launch") {
    io.err(`ub agents: expected "launch"\n\n${HELP}`);
    return 2;
  }

  let values: { project?: string; candidate?: string; model?: string };
  let positionals: string[];
  try {
    ({ values, positionals } = parseArgs({
      args: rest,
      options: {
        project: { type: "string" },
        candidate: { type: "string" },
        model: { type: "string" },
      },
      allowPositionals: true,
      strict: true,
    }));
  } catch (error) {
    io.err(`ub agents: ${error instanceof Error ? error.message : String(error)}\n\n${HELP}`);
    return 2;
  }
  if (positionals.length !== 1 || values.project === undefined || values.candidate === undefined) {
    io.err(`ub agents: launch needs one role, --project and --candidate\n\n${HELP}`);
    return 2;
  }

  const project = resolve(values.project);
  const candidate = resolve(values.candidate);
  const role = positionals[0] as string;
  const entry = roleData(project, role);
  const runtime = values.model ?? entry.defaultRuntime;
  if (runtime !== "claude" && runtime !== "codex") {
    io.err(`ub agents: unknown --model ${JSON.stringify(runtime)}\n`);
    return 2;
  }

  const prompt =
    `Read ${entry.contract} in the project control tree completely, then follow it exactly. ` +
    `The candidate to inspect is ${candidate}. This is a bounded, read-only spike probe.`;
  const environment = {
    ...process.env,
    PROBE_CANDIDATE: candidate,
    XDG_CONFIG_HOME: join(project, ".runtime/config"),
    XDG_DATA_HOME: join(project, ".runtime/data"),
  };
  const launched = runtime === "claude"
    ? spawnSync(
        "claude",
        [
          "-p",
          prompt,
          "--agent",
          role,
          "--permission-mode",
          entry.runtimes.claude.permissionMode,
          "--allowedTools",
          ...entry.runtimes.claude.allowedTools,
          "--setting-sources",
          "project",
          "--no-session-persistence",
          "--add-dir",
          candidate,
        ],
        { cwd: project, env: environment, stdio: "inherit" },
      )
    : spawnSync(
        "codex",
        [
          "exec",
          "-C",
          project,
          "--add-dir",
          candidate,
          "-s",
          entry.runtimes.codex.sandbox,
          "-c",
          "sandbox_workspace_write.network_access=true",
          "--ephemeral",
          prompt,
        ],
        { cwd: project, env: environment, stdio: "inherit" },
      );

  if (launched.error !== undefined) {
    io.err(`ub agents: ${runtime} could not start (${launched.error.message})\n`);
    return 1;
  }
  return launched.status ?? 1;
}

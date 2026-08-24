/**
 * The `ub` command surface: help, version, dispatch.
 *
 * `ub` is what a *user* of uberblick runs. The contributor verbs — dev, lint,
 * typecheck, test, e2e, review — stay mise tasks and are deliberately not
 * duplicated here.
 *
 * `mcp serve` is missing from the help on purpose: it is the stdio line an MCP
 * client's config points at, written there by machine, and a human has no
 * reason to run it by hand.
 */

import { initCommand } from "./init.js";
import type { Io } from "./io.js";
import { processIo } from "./io.js";
import { mcpCommand } from "./serve.js";
import { statusCommand } from "./status.js";
import { cliVersion } from "./version.js";

export const HELP = `uberblick — local-first, CRDT-backed collaborative documents

usage: ub <command> [options]

commands:
  init [options]    identity, workspace and a local development signing secret
  status [--json]   workspace, hub, credential, database and sync state

init options:
  -y, --yes         take every default; never prompt (also the default with no TTY)
  --name <name>     awareness display name
  --color <#rrggbb> awareness cursor colour
  --workspace <id>  workspace to work in
  --mcp, --no-mcp   whether to wire up an MCP client (--mcp arrives with #88)

options:
  -h, --help        show this help
  -v, --version     print the version
`;

/** Run one `ub` invocation and return its exit code. Never throws for usage. */
export async function runCli(
  argv: string[],
  io: Io = processIo,
): Promise<number> {
  const [command, ...rest] = argv;

  if (command === undefined || command === "help" || command === "--help" || command === "-h") {
    io.out(HELP);
    return 0;
  }
  if (command === "--version" || command === "-v") {
    io.out(`${cliVersion()}\n`);
    return 0;
  }
  if (command === "init") {
    return await initCommand(rest, io);
  }
  if (command === "status") {
    return await statusCommand(rest, io);
  }
  if (command === "mcp") {
    return await mcpCommand(rest, io.err);
  }

  // The help goes to stderr here, so a pipe reading stdout sees nothing at all.
  io.err(`ub: unknown command ${JSON.stringify(command)}\n\n${HELP}`);
  return 2;
}

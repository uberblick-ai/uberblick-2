import { authCommand } from "./auth.js";
import { doctorCommand } from "./doctor.js";
import { dataCommand } from "./data.js";
import { installCommand } from "./install.js";
import type { Io } from "./io.js";
import { processIo } from "./io.js";
import { openCommand } from "./open.js";
import { serveCommand } from "./serve.js";
import { statusCommand } from "./status.js";
import { updateCommand } from "./update.js";
import { cliVersion } from "./version.js";
import { workspaceCommand } from "./workspace.js";

export const HELP = `uberblick — local-first, CRDT-backed collaborative documents

usage: ub <command> [options]

commands:
  update                 update the Homebrew installation; for a checkout, run
                         git pull, then mise run setup
  open [options]         serve the web app and a hub in the foreground, and
                         open the browser
  status [--json]        see whether your work is syncing: hub, sign-in,
                         pending changes and problems
  doctor [--json]        check this project's Uberblick setup and name the fix
                         for each problem
  data [command]         read and write a document's structured data through files
  workspace [command]    create, promote, join, list or select a workspace
  auth [command]         sign in to a remote hub and manage this machine's login
  mcp [command]          register uberblick with an MCP client

options:
  -h, --help        show this help; after a command, that command's help
  -v, --version     print the version
`;

export const MCP_HELP = `usage: ub mcp [command]

commands:
  install <client>   # Register Uberblick with an agent's MCP client: claude or codex

options for install:
  --user             # Register for every project of this user, not just this project
  --print            # Print the entry to paste, and run nothing
`;

/** Contributor commands stay mise tasks; usage failures return an exit code. */
export async function runCli(
  argv: string[],
  io: Io = processIo,
  options: { authCollectTimeoutMs?: number } = {},
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
  if (command === "update") {
    return await updateCommand(rest, io);
  }
  if (command === "open") {
    return await openCommand(rest, io);
  }
  if (command === "status") {
    return await statusCommand(rest, io);
  }
  if (command === "doctor") {
    return await doctorCommand(rest, io);
  }
  if (command === "data") {
    return await dataCommand(rest, io);
  }
  if (command === "workspace") {
    return await workspaceCommand(rest, io);
  }
  if (command === "auth") {
    return await authCommand(rest, io, { collectTimeoutMs: options.authCollectTimeoutMs });
  }
  if (command === "mcp") {
    const [subcommand, ...args] = rest;
    if (subcommand === "serve") {
      return await serveCommand(args, io.err);
    }
    if (subcommand === "install") {
      return await installCommand(args, io);
    }
    // Only the subcommand slot asks for group help; unknown children stay errors.
    if (subcommand === undefined || subcommand === "help" || subcommand === "--help" || subcommand === "-h") {
      io.out(MCP_HELP);
      return 0;
    }
    io.err(`ub mcp: unknown command ${JSON.stringify(subcommand)}\n\n${MCP_HELP}`);
    return 2;
  }

  io.err(`ub: unknown command ${JSON.stringify(command)}\n\n${HELP}`);
  return 2;
}

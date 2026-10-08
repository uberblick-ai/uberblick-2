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

import { authCommand } from "./auth.js";
import { doctorCommand } from "./doctor.js";
import { envCommand } from "./env.js";
import { initCommand } from "./init.js";
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
  init [hub-url]         identity, workspace and a signing secret — with a hub
                         given, the new workspace is created on that hub
  update                 update the Homebrew installation; for a checkout, run
                         git pull, then mise run setup
  open [options]         serve the web app and a hub in the foreground, and
                         open the browser
  status [--json]        workspace, hub, connection, pending work and failures
  doctor [--json]        check the local stack against its known failure modes
  workspace [command]    create, promote, join, list or select a workspace
  auth [command]         sign in to a remote hub and manage this machine's login
  mcp <command>          register uberblick with an MCP client
  env -- <command...>    run a command with uberblick's configuration in its
                         environment

options:
  -h, --help        show this help; after a command, that command's help
  -v, --version     print the version
`;

/**
 * `ub mcp` is a group like `workspace`, with one human child.
 *
 * `serve` is left out for the same reason it is left out of the top-level help:
 * it is the stdio line a client config points at, written there by machine.
 */
export const MCP_HELP = `usage: ub mcp <command>

commands:
  install [client]       register uberblick with an MCP client

options:
  -h, --help             show this help; after a command, that command's help
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
  if (command === "workspace") {
    return await workspaceCommand(rest, io);
  }
  if (command === "auth") {
    return await authCommand(rest, io);
  }
  if (command === "env") {
    return await envCommand(rest, io);
  }
  if (command === "mcp") {
    const [subcommand, ...args] = rest;
    // `serve` is missing from the help on purpose; `install` is not, because a
    // person runs it and a machine runs the other one.
    if (subcommand === "serve") {
      return await serveCommand(args, io.err);
    }
    if (subcommand === "install") {
      return await installCommand(args, io);
    }
    // Only the subcommand slot asks for help here: `ub mcp bogus --help` is an
    // unknown command, the same as `ub bogus --help` is below.
    if (subcommand === "help" || subcommand === "--help" || subcommand === "-h") {
      io.out(MCP_HELP);
      return 0;
    }
    const named = subcommand === undefined ? " nothing" : ` ${JSON.stringify(subcommand)}`;
    io.err(`ub mcp: expected "install" or "serve", got${named}\n\n${MCP_HELP}`);
    return 2;
  }

  // The help goes to stderr here, so a pipe reading stdout sees nothing at all.
  io.err(`ub: unknown command ${JSON.stringify(command)}\n\n${HELP}`);
  return 2;
}

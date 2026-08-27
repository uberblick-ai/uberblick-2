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
 *
 * A command that offers `--json` puts exactly one JSON value on stdout whether
 * it answers or fails, and the exit status decides which — ./failure.ts owns
 * that shape, README's "Machine output" section states the policy.
 */

import { doctorCommand } from "./doctor.js";
import { initCommand } from "./init.js";
import { installCommand } from "./install.js";
import type { Io } from "./io.js";
import { processIo } from "./io.js";
import { openCommand } from "./open.js";
import { remoteCommand } from "./remote.js";
import { serveCommand } from "./serve.js";
import { statusCommand } from "./status.js";
import { cliVersion } from "./version.js";
import { workspaceCommand } from "./workspace.js";

export const HELP = `uberblick — local-first, CRDT-backed collaborative documents

usage: ub <command> [options]

commands:
  init [options]         identity, workspace and a local development signing secret
  open [options]         serve the web app and a hub in the foreground, and
                         open the browser (--no-browser, --port <n>)
  status [--json]        workspace, hub, credential, database and sync state
  doctor [--json]        check the local stack against its known failure modes
  workspace [command]    which workspace is in force, and how to change it
  remote [command]       the endpoint documents sync with, and the one-time bridges
  mcp install [target]   register uberblick with an MCP client

workspace commands:
  workspace              the workspace in force, and which layer chose it
  workspace list         workspaces this machine has a database for ([--json])
  workspace use <id>     make a workspace this machine's default, by uuid,
                         <slug>-<uuid> or a unique prefix

remote commands:
  remote                 the endpoint in force and what sharing it buys
  remote init <target>   stand up the remote hub + web stack on a tailnet host
  remote update <target> deploy origin/main onto that host now
  remote set <url>       point the clients at an endpoint; moves nothing
  remote promote <url>   move this populated workspace onto an empty remote hub
  remote join <url>/<id> bind this machine to the remote workspace the URL names

init options:
  -y, --yes         take every default; never prompt (also the default with no TTY)
  --name <name>     awareness display name
  --color <#rrggbb> awareness cursor colour
  --workspace <id>  workspace to work in
  --mcp, --no-mcp   whether to wire up an MCP client

mcp install options:
  target            claude, codex or cursor (default claude)
  --project         write this directory's config (the default)
  --user            write the per-user config
  --print           print the snippet to paste; write nothing
  --force           replace an existing "uberblick" entry, backing the file up
  --workspace <id>  pin the entry to this workspace, as WORKSPACE_ID
  --name <label>    pin a second entry called "uberblick-<label>" instead of
                    the primary one; needs --workspace
  -- <command>      register this command instead of uberblick's own

options:
  -h, --help        show this help; after a command, that command's help
  -v, --version     print the version
`;

/**
 * `ub mcp` is a group like `workspace` and `remote`, with one human child.
 *
 * `serve` is left out for the same reason it is left out of the top-level help:
 * it is the stdio line a client config points at, written there by machine.
 */
export const MCP_HELP = `usage: ub mcp <command>

commands:
  install [target]       register uberblick with an MCP client

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
  if (command === "remote") {
    return await remoteCommand(rest, io);
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

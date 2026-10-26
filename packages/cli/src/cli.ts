import { authCommand, AUTH_HELP, AUTH_LOGIN_HELP, AUTH_LOGOUT_HELP, AUTH_LOGOUT_OPTIONS, AUTH_STATUS_HELP, AUTH_STATUS_OPTIONS } from "./auth.js";
import { command, type CommandGroup, dispatchCommand, type RunOptions } from "./command.js";
import { doctorCommand, DOCTOR_HELP, DOCTOR_OPTIONS } from "./doctor.js";
import { getDataCommand, updateDataCommand, DATA_HELP, DATA_GET_OPTIONS, DATA_UPDATE_OPTIONS } from "./data.js";
import { installCommand, INSTALL_HELP, INSTALL_OPTIONS } from "./install.js";
import type { Io } from "./io.js";
import { processIo } from "./io.js";
import { openCommand, OPEN_HELP, OPEN_OPTIONS } from "./open.js";
import { serveCommand } from "./serve.js";
import { statusCommand, STATUS_HELP, STATUS_OPTIONS } from "./status.js";
import { updateCommand, UPDATE_HELP } from "./update.js";
import { cliVersion } from "./version.js";
import {
  listWorkspacesCommand, removeWorkspaceCommand, useWorkspaceCommand,
  WORKSPACE_HELP, WORKSPACE_LIST_HELP, WORKSPACE_LIST_OPTIONS,
  WORKSPACE_REMOVE_HELP, WORKSPACE_REMOVE_OPTIONS, WORKSPACE_USE_HELP, WORKSPACE_USE_OPTIONS,
} from "./workspace.js";
import { createWorkspaceCommand, WORKSPACE_CREATE_HELP } from "./workspace-create.js";
import { forkWorkspaceCommand, WORKSPACE_FORK_HELP } from "./workspace-fork.js";
import { promoteWorkspaceCommand, WORKSPACE_PROMOTE_HELP } from "./workspace-promote.js";
import {
  workspaceMemberCommand, WORKSPACE_MEMBER_HELP, WORKSPACE_MEMBER_SUBCOMMAND_HELP,
  WORKSPACE_MEMBER_ADD_OPTIONS, WORKSPACE_MEMBER_LIST_OPTIONS,
} from "./workspace-member.js";

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

const authParseError = (error: unknown): string =>
  error instanceof Error && "code" in error && error.code === "ERR_PARSE_ARGS_UNKNOWN_OPTION"
    ? "unknown option" : "invalid option usage";

export const COMMAND_TREE: CommandGroup = {
  path: [], help: HELP, version: cliVersion,
  children: [
    command({ path: ["update"], help: UPDATE_HELP, options: {}, positionals: false,
      argumentError: args => args.length === 0 ? undefined : `expected no arguments, got ${JSON.stringify(args[0])}`,
      run: (_args, io, options) => updateCommand(io, options.updateHost) }),
    command({ path: ["open"], help: OPEN_HELP, options: OPEN_OPTIONS,
      positionals: { min: 0, max: 0, error: args => `unexpected argument ${JSON.stringify(args[0])}` }, run: openCommand }),
    command({ path: ["status"], help: STATUS_HELP, options: STATUS_OPTIONS, positionals: false, run: statusCommand }),
    command({ path: ["doctor"], help: DOCTOR_HELP, options: DOCTOR_OPTIONS, positionals: false, run: doctorCommand }),
    { path: ["data"], help: DATA_HELP, children: [
      command({ path: ["data", "get"], help: DATA_HELP, options: DATA_GET_OPTIONS, errorPath: "data",
        positionals: { min: 1, max: 2, error: "expected a document and an optional collection" }, run: getDataCommand }),
      command({ path: ["data", "update"], help: DATA_HELP, options: DATA_UPDATE_OPTIONS, errorPath: "data",
        positionals: { min: 1, max: 1, error: "expected one document and --file <path|->" }, run: updateDataCommand }),
    ] },
    { path: ["workspace"], help: WORKSPACE_HELP, children: [
      command({ path: ["workspace", "create"], help: WORKSPACE_CREATE_HELP, options: {},
        positionals: { min: 1, max: 1, error: "expected exactly one workspace name" }, run: createWorkspaceCommand }),
      command({ path: ["workspace", "fork"], help: WORKSPACE_FORK_HELP, options: {}, positionals: false,
        run: (_args, io) => forkWorkspaceCommand(io) }),
      command({ path: ["workspace", "promote"], help: WORKSPACE_PROMOTE_HELP, options: {},
        positionals: { min: 1, max: 1, error: "expected exactly one hub" }, run: promoteWorkspaceCommand }),
      { path: ["workspace", "member"], help: WORKSPACE_MEMBER_HELP, children: [
        command({ path: ["workspace", "member", "add"], help: WORKSPACE_MEMBER_SUBCOMMAND_HELP.add, options: WORKSPACE_MEMBER_ADD_OPTIONS,
          positionals: { min: 1, max: 1, error: "expected 1 argument" }, run: (args, io) => workspaceMemberCommand("add", args, io) }),
        command({ path: ["workspace", "member", "list"], help: WORKSPACE_MEMBER_SUBCOMMAND_HELP.list, options: WORKSPACE_MEMBER_LIST_OPTIONS,
          positionals: { min: 0, max: 0, error: "expected 0 arguments" }, run: (args, io) => workspaceMemberCommand("list", args, io) }),
        command({ path: ["workspace", "member", "role"], help: WORKSPACE_MEMBER_SUBCOMMAND_HELP.role, options: {},
          positionals: { min: 2, max: 2, error: "expected 2 arguments" }, run: (args, io) => workspaceMemberCommand("role", args, io) }),
        command({ path: ["workspace", "member", "remove"], help: WORKSPACE_MEMBER_SUBCOMMAND_HELP.remove, options: {},
          positionals: { min: 1, max: 1, error: "expected 1 argument" }, run: (args, io) => workspaceMemberCommand("remove", args, io) }),
      ] },
      command({ path: ["workspace", "list"], help: WORKSPACE_LIST_HELP, options: WORKSPACE_LIST_OPTIONS, positionals: false, run: listWorkspacesCommand }),
      command({ path: ["workspace", "use"], help: WORKSPACE_USE_HELP, options: WORKSPACE_USE_OPTIONS,
        positionals: { min: 1, max: 1, error: "expected exactly one workspace link or id" }, run: useWorkspaceCommand }),
      command({ path: ["workspace", "remove"], aliases: ["rm"], help: WORKSPACE_REMOVE_HELP, options: WORKSPACE_REMOVE_OPTIONS,
        positionals: { min: 1, max: 1, error: "expected exactly one workspace id or prefix" }, run: removeWorkspaceCommand }),
    ] },
    { path: ["auth"], help: AUTH_HELP, unknownCommand: () => "unknown command", children: [
      command({ path: ["auth", "login"], help: AUTH_LOGIN_HELP, options: {}, parseError: authParseError,
        positionals: { min: 0, max: 1, error: "expected at most one hub" },
        run: (args, io, options) => authCommand("login", args, io, options.authCollectTimeoutMs === undefined
          ? {} : { collectTimeoutMs: options.authCollectTimeoutMs }) }),
      command({ path: ["auth", "status"], help: AUTH_STATUS_HELP, options: AUTH_STATUS_OPTIONS, parseError: authParseError,
        positionals: { min: 0, max: 1, error: "expected at most one hub" }, run: (args, io) => authCommand("status", args, io) }),
      command({ path: ["auth", "logout"], help: AUTH_LOGOUT_HELP, options: AUTH_LOGOUT_OPTIONS, parseError: authParseError,
        positionals: { min: 0, max: 1, error: "expected at most one hub" }, run: (args, io) => authCommand("logout", args, io) }),
    ] },
    { path: ["mcp"], help: MCP_HELP, children: [
      command({ path: ["mcp", "install"], help: INSTALL_HELP, options: INSTALL_OPTIONS,
        argumentError: args => args.includes("--") ? 'unexpected argument "--"' : undefined,
        positionals: { min: 1, max: 1, error: args => args.length === 0 ? "missing client" : `unexpected argument ${JSON.stringify(args[1])}` },
        run: installCommand }),
      { path: ["mcp", "serve"], hidden: true, options: {}, positionals: false,
        argumentError: args => args.length === 0 ? undefined : `unexpected argument ${JSON.stringify(args[0])}`, run: serveCommand },
    ] },
  ],
};

/** Contributor commands stay mise tasks; usage failures return an exit code. */
export async function runCli(argv: string[], io: Io = processIo, options: RunOptions = {}): Promise<number> {
  return dispatchCommand(COMMAND_TREE, argv, io, options);
}

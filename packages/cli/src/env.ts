/**
 * `ub env -- <command…>` — run a command under uberblick's configuration.
 *
 * The checkout's mise tasks need `WORKSPACE_ID` and `HUB_AUTH_TOKEN` (the hub
 * refuses to start without a secret) and the endpoint every client dials. There
 * is exactly one authority for those — this machine's `{config,credentials}.json`,
 * resolved by `config.ts` — and this command is how anything that is not `ub`
 * consumes it. `mise run hub` and `mise run web` wrap their command in this
 * instead of reading a second, derived copy of the configuration, because a
 * derived copy is a second answer, and a second answer to "which hub" is the
 * island trap: writes reported as synced against a hub nobody else is reading
 * (#376).
 *
 * **There is no bare `ub env`.** Printing the resolved environment would print
 * the hub's signing secret to stdout, where a shell history, a CI log or a
 * screen share keeps it. The environment is only ever *handed to a child*, never
 * shown — so the command word is followed by `--` and a command, and every other
 * spelling is a usage error rather than a way to see the values.
 *
 * The environment handed over is exactly the one `ub mcp serve` gives the MCP
 * server: same `resolveConfig`, same {@link runChild}. That equality is the
 * point of the command, so it is a test.
 */

import { runChild } from "./child.js";
import { resolveConfig } from "./config.js";
import { takeHelp } from "./help.js";
import type { Io } from "./io.js";

export const ENV_HELP = `usage: ub env -- <command> [args...]

Run a command with uberblick's resolved configuration in its environment —
WORKSPACE_ID, the hub endpoint and the signing secret, exactly as \`ub mcp
serve\` hands them to the MCP server. The command inherits stdin, stdout and
stderr, signals are forwarded to it, and \`ub\` exits with its status.

The \`--\` is required and there is no form that prints the environment: it
carries the hub's signing secret, and a secret on stdout is a secret in a shell
history and a CI log.

options:
  -h, --help        show this help
`;

export async function envCommand(argv: string[], io: Io): Promise<number> {
  if (takeHelp(argv, io, ENV_HELP)) return 0;

  const separator = argv.indexOf("--");
  // Nothing may come before the separator: an option of our own would be one
  // more spelling to reason about, and the first of them anybody would ask for
  // is the one that prints the secret.
  if (separator !== 0) {
    io.err(
      separator === -1
        ? "ub env: expected `--` followed by a command to run\n"
        : `ub env: unexpected argument ${JSON.stringify(argv[0])} before \`--\`\n`,
    );
    io.err("usage: ub env -- <command> [args...]\n");
    return 2;
  }

  const [command, ...args] = argv.slice(1);
  if (command === undefined) {
    io.err("ub env: expected a command to run after `--`\n");
    io.err("usage: ub env -- <command> [args...]\n");
    return 2;
  }

  const resolved = resolveConfig();
  for (const warning of resolved.warnings) {
    io.err(`ub: warning: ${warning}\n`);
  }

  try {
    return await runChild(command, args, resolved.env);
  } catch (error) {
    // A command that is not on the PATH is the ordinary failure here, and 127
    // is what a shell reports for it — so a task runner sees what it would have
    // seen without the wrapper.
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") {
      io.err(`ub env: ${command}: command not found\n`);
      return 127;
    }
    io.err(
      `ub env: could not run ${command}: ${
        error instanceof Error ? error.message : String(error)
      }\n`,
    );
    return 1;
  }
}

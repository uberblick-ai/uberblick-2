/**
 * `ub mcp serve` — the stdio entry point every MCP client is pointed at.
 *
 * It resolves configuration and runs the MCP server as a child process with that
 * environment. Two things fall out of that split, and both are the point:
 *
 * - The server's interface stays "an environment and a stdio pair". It gains no
 *   flags and no config file, so its documented contract is untouched, and the
 *   process an MCP client ends up talking to is exactly the process it used to
 *   spawn itself — same signals, same stdin-close shutdown, same exit codes.
 * - No client config has to change again when internals move. `ub mcp serve` is
 *   the stable line; where the server lives is our problem, not the client's.
 *
 * The spawn itself is `runChild` — shared with `ub env`, which hands the same
 * environment to any command, so a mise task and an MCP client cannot end up
 * configured differently.
 */

import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { runChild } from "./child.js";
import { resolveConfig } from "./config.js";
import { isInstallPayload } from "./installation.js";

/**
 * tsx's loader, so the child can run the server's TypeScript source — the same
 * thing `node --import tsx` loads, resolved from this package rather than from
 * the caller's working directory.
 */
function tsxLoader(): string {
  return import.meta.resolve("tsx");
}

/** The MCP server's process entry point, beside the package entry it exports. */
function mcpServerMain(): string {
  return fileURLToPath(
    new URL("./main.ts", import.meta.resolve("@uberblick/mcp-server")),
  );
}

/** The precompiled MCP entry shipped beside the installed CLI bundle. */
function installedMcpServerMain(): string {
  return fileURLToPath(new URL("./mcp.mjs", import.meta.url));
}

export async function serveCommand(
  argv: string[],
  err: (text: string) => void = (text) => process.stderr.write(text),
): Promise<number> {
  if (argv.length > 0) {
    err(`ub mcp serve: unexpected argument ${JSON.stringify(argv[0])}\n`);
    return 2;
  }

  const resolved = resolveConfig();
  for (const warning of resolved.warnings) {
    err(`ub: warning: ${warning}\n`);
  }

  if (isInstallPayload()) {
    const main = installedMcpServerMain();
    if (!existsSync(main)) {
      err(`ub mcp serve: the installed MCP server is missing at ${main}; reinstall Uberblick\n`);
      return 1;
    }
    return await runChild(process.execPath, [main], resolved.env);
  }

  return await runChild(process.execPath, ["--import", tsxLoader(), mcpServerMain()], resolved.env);
}

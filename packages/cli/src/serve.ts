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

import { fileURLToPath } from "node:url";
import { createConnection } from "node:net";
import { runChild } from "./child.js";
import { resolveConfig } from "./config.js";

/**
 * Disposable #704 spike seam: keep the public `ub mcp serve` process and its
 * stdio contract, but let the per-machine daemon own the actual MCP session.
 * The environment variable exists only on the unmerged evidence branch.
 */
async function proxyDaemon(socketPath: string): Promise<number> {
  return await new Promise((resolve) => {
    const socket = createConnection(socketPath);
    let settled = false;
    const finish = (code: number): void => {
      if (settled) return;
      settled = true;
      process.stdin.unpipe(socket);
      socket.unpipe(process.stdout);
      resolve(code);
    };
    socket.once("connect", () => {
      process.stdin.pipe(socket);
      socket.pipe(process.stdout);
    });
    socket.once("end", () => finish(0));
    socket.once("close", () => finish(0));
    socket.once("error", (error) => {
      process.stderr.write(`ub mcp serve: daemon unavailable: ${error.message}\n`);
      finish(1);
    });
    process.stdin.once("end", () => socket.end());
  });
}

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

export async function serveCommand(
  argv: string[],
  err: (text: string) => void = (text) => process.stderr.write(text),
): Promise<number> {
  if (argv.length > 0) {
    err(`ub mcp serve: unexpected argument ${JSON.stringify(argv[0])}\n`);
    return 2;
  }

  const daemonSocket = process.env.UBERBLICK_DAEMON_SOCKET?.trim();
  if (daemonSocket) {
    return await proxyDaemon(daemonSocket);
  }

  const resolved = resolveConfig();
  for (const warning of resolved.warnings) {
    err(`ub: warning: ${warning}\n`);
  }

  return await runChild(
    process.execPath,
    ["--import", tsxLoader(), mcpServerMain()],
    resolved.env,
  );
}

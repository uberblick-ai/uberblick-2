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
 * stdio is inherited, so the JSON-RPC stream flows between the client and the
 * server without passing through this process — which is also why every
 * diagnostic here is written to stderr. A byte of ours on stdout would be parsed
 * as a protocol frame.
 */

import { spawn } from "node:child_process";
import { constants } from "node:os";
import { fileURLToPath } from "node:url";
import { resolveConfig } from "./config.js";

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

/**
 * The signals a client or a shell sends a long-running stdio process, forwarded
 * to the child so the server shuts down its replicas and its hub connection.
 * SIGHUP is here because a terminal that goes away sends it and nothing else.
 */
const FORWARDED: NodeJS.Signals[] = ["SIGINT", "SIGTERM", "SIGHUP"];

/** What a shell reports for a process killed by a signal. */
function signalExitCode(signal: NodeJS.Signals): number {
  const numbers = constants.signals as unknown as Record<string, number>;
  return 128 + (numbers[signal] ?? 0);
}

/**
 * Die of the signal the child died of, so that whoever is waiting on `ub mcp
 * serve` cannot tell it apart from a direct spawn of the server: a supervisor
 * reading `WIFSIGNALED` sees the signal, not a plain exit with 128+n, which is
 * what a process that merely *chose* that code looks like.
 *
 * The caller drops our forwarding handler first — with it still installed we
 * would only forward the signal to a child that has already exited. Returns
 * false when the signal cannot be raised at all (an unknown name on this
 * platform), and the caller falls back to the number.
 */
function reraise(signal: NodeJS.Signals): boolean {
  try {
    process.kill(process.pid, signal);
    return true;
  } catch {
    return false;
  }
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

  const child = spawn(
    process.execPath,
    ["--import", tsxLoader(), mcpServerMain()],
    { stdio: "inherit", env: resolved.env },
  );

  return await new Promise<number>((resolve, reject) => {
    const forward = (signal: NodeJS.Signals): void => {
      child.kill(signal);
    };
    const stop = (): void => {
      for (const signal of FORWARDED) {
        process.off(signal, forward);
      }
    };
    for (const signal of FORWARDED) {
      process.on(signal, forward);
    }

    child.on("error", (error) => {
      stop();
      reject(error);
    });
    child.on("exit", (code, signal) => {
      stop();
      if (signal === null) {
        resolve(code ?? 1);
        return;
      }
      if (reraise(signal)) {
        // The raise is delivered by the event loop, so stay alive long enough
        // to receive it; the resolve is only reached if it never arrives.
        setTimeout(() => resolve(signalExitCode(signal)), 200);
        return;
      }
      resolve(signalExitCode(signal));
    });
  });
}

export async function mcpCommand(
  argv: string[],
  err: (text: string) => void = (text) => process.stderr.write(text),
): Promise<number> {
  const [subcommand, ...rest] = argv;
  if (subcommand === "serve") {
    return await serveCommand(rest, err);
  }
  const named = subcommand === undefined ? "" : ` ${JSON.stringify(subcommand)}`;
  err(`ub mcp: expected "serve", got${named || " nothing"}\n`);
  return 2;
}

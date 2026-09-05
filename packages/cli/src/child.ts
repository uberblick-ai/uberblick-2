/**
 * Running another program under `ub`'s resolved configuration.
 *
 * Two commands do it — `ub mcp serve`, which runs the MCP server, and `ub env`,
 * which runs whatever it is given — and they must be the same act, because that
 * is the whole claim `ub env` makes: the environment a mise task gets is the
 * environment an MCP client's server gets. One spawn, one signal policy, one set
 * of exit-code rules, here.
 *
 * stdio is inherited, so the child's streams are this process's streams: for
 * `ub mcp serve` that is what keeps the JSON-RPC transport between the client
 * and the server, which is also why every diagnostic on this path is written to
 * stderr.
 */

import { spawn } from "node:child_process";
import { constants } from "node:os";

/**
 * The signals a client, a shell or a task runner sends a long-running process,
 * forwarded to the child so it shuts down its replicas and its connections.
 *
 * The two beyond SIGINT and SIGTERM are here because a signal we do not forward
 * kills only this process and orphans the child, which keeps the inherited stdio
 * open: the caller's pipe stays alive talking to a process nobody supervises.
 * SIGHUP is what a vanished terminal sends and nothing else; SIGQUIT is what
 * Ctrl-\ and a supervisor escalating past SIGTERM send.
 */
export const FORWARDED: NodeJS.Signals[] = ["SIGINT", "SIGTERM", "SIGHUP", "SIGQUIT"];

export const SIGNAL_DELIVERY_GRACE_MS = 200;

/** What a shell reports for a process killed by a signal. */
export function signalExitCode(signal: NodeJS.Signals): number {
  const numbers = constants.signals as unknown as Record<string, number>;
  return 128 + (numbers[signal] ?? 0);
}

/**
 * Die of the signal the child died of, so that whoever is waiting on `ub`
 * cannot tell it apart from a direct spawn of the child: a supervisor reading
 * `WIFSIGNALED` sees the signal, not a plain exit with 128+n, which is what a
 * process that merely *chose* that code looks like.
 *
 * The caller drops our forwarding handler first — with it still installed we
 * would only forward the signal to a child that has already exited. Returns
 * false when the signal cannot be raised at all (an unknown name on this
 * platform), and the caller falls back to the number.
 */
export function reraise(signal: NodeJS.Signals): boolean {
  try {
    process.kill(process.pid, signal);
    return true;
  } catch {
    return false;
  }
}

/** Run a command with this environment and become its exit status. */
export function runChild(
  command: string,
  args: readonly string[],
  env: NodeJS.ProcessEnv,
): Promise<number> {
  const child = spawn(command, [...args], { stdio: "inherit", env });

  return new Promise<number>((resolve, reject) => {
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
        setTimeout(() => resolve(signalExitCode(signal)), SIGNAL_DELIVERY_GRACE_MS);
        return;
      }
      resolve(signalExitCode(signal));
    });
  });
}

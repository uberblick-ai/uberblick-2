import { spawn } from "node:child_process";
import { constants } from "node:os";

/**
 * Forward terminal loss (SIGHUP) and Ctrl-\ (SIGQUIT) as well as normal stop
 * signals. Otherwise the orphaned child keeps its inherited pipes open.
 */
const FORWARDED: NodeJS.Signals[] = ["SIGINT", "SIGTERM", "SIGHUP", "SIGQUIT"];

/** What a shell reports for a process killed by a signal. */
function signalExitCode(signal: NodeJS.Signals): number {
  const numbers = constants.signals as unknown as Record<string, number>;
  return 128 + (numbers[signal] ?? 0);
}

/**
 * Re-raise after removing forwarding handlers so supervisors see WIFSIGNALED,
 * not a normal numeric exit. Unsupported signals fall back to the shell code.
 */
function reraise(signal: NodeJS.Signals): boolean {
  try {
    process.kill(process.pid, signal);
    return true;
  } catch {
    return false;
  }
}

/** Inherited stdio preserves MCP framing; diagnostics on this path use stderr. */
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
        // Keep the loop alive for signal delivery; resolve only if it never arrives.
        setTimeout(() => resolve(signalExitCode(signal)), 200);
        return;
      }
      resolve(signalExitCode(signal));
    });
  });
}

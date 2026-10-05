import { spawn } from "node:child_process";
import type { Io } from "./io.js";

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function trimmed(value: string | undefined): string | null {
  const text = value?.trim();
  return text === undefined || text === "" ? null : text;
}

/** The command that opens a URL on this platform, or null when asked not to. */
export function browserCommand(
  url: string,
  env: NodeJS.ProcessEnv,
): { command: string; args: string[] } | null {
  const configured = trimmed(env.BROWSER);
  if (configured === "none") {
    return null;
  }
  if (configured !== null) {
    return { command: configured, args: [url] };
  }
  if (process.platform === "darwin") {
    return { command: "open", args: [url] };
  }
  if (process.platform === "win32") {
    return { command: "cmd", args: ["/c", "start", "", url] };
  }
  return { command: "xdg-open", args: [url] };
}

/**
 * Hand the URL to a browser, and carry on regardless.
 *
 * A machine with no `xdg-open` is a headless one, and the URL is already on
 * stdout — failing the command over it would be refusing to serve because
 * nobody could be shown the door.
 */
export function openBrowser(url: string, env: NodeJS.ProcessEnv, io: Io): void {
  const opener = browserCommand(url, env);
  if (opener === null) {
    return;
  }
  const child = spawn(opener.command, opener.args, {
    stdio: "ignore",
    detached: true,
  });
  child.on("error", (error) => {
    io.err(`ub: warning: could not open a browser (${message(error)})\n`);
  });
  child.unref();
}

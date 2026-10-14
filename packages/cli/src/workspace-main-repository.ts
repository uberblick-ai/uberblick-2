import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fillWorkspaceMainRepository } from "@uberblick/mcp-server";
import { githubRepository } from "@uberblick/schema";

const runFile = promisify(execFile);

/** Optional checkout metadata never changes the command's result or output. */
export async function fillMainRepositoryFromOrigin(workspaceId: string, databasePath?: string): Promise<void> {
  try {
    const options = {
      cwd: process.cwd(),
      env: process.env,
      encoding: "utf8" as const,
      maxBuffer: 8_192,
      timeout: 1_000,
      killSignal: "SIGKILL" as const,
    };
    const checkout = await runFile("git", ["rev-parse", "--is-inside-work-tree"], options);
    if (checkout.stdout.trim() !== "true") return;
    const { stdout } = await runFile("git", ["remote", "get-url", "origin"], options);
    const origin = stdout.trim();
    if (!/^(?:https:\/\/|ssh:\/\/git@|git@github\.com:)/i.test(origin)) return;
    const repository = githubRepository(origin);
    if (repository !== null) fillWorkspaceMainRepository(workspaceId, repository, databasePath);
  } catch {
    // No checkout, missing git, failed or stalled lookup and unreadable replicas
    // leave this optional setting alone without changing the binding operation.
  }
}

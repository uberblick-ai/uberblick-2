import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fillWorkspaceMainRepository } from "@uberblick/mcp-server";
import { readDeviceLogin, sameCredential } from "@uberblick/mcp-server/device-login";
import { manageRequest, sanitizeManagementReply } from "@uberblick/mcp-server/management-client";
import { githubRepository, parseWorkspaceId } from "@uberblick/schema";

const runFile = promisify(execFile);

/** Optional checkout metadata never changes the command's result or output. */
export async function fillMainRepositoryFromOrigin(workspaceId: string, hubUrl: string | null, databasePath?: string): Promise<void> {
  try {
    workspaceId = parseWorkspaceId(workspaceId).uuid;
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
    if (repository === null) return;
    if (hubUrl !== null && !await confirmedWorkspaceAdmin(workspaceId, hubUrl)) return;
    fillWorkspaceMainRepository(workspaceId, repository, databasePath);
  } catch {
    // No checkout, missing git, failed or stalled lookup and unreadable replicas
    // leave this optional setting alone without changing the binding operation.
  }
}

async function confirmedWorkspaceAdmin(workspaceId: string, hubUrl: string): Promise<boolean> {
  const current = readDeviceLogin(hubUrl, workspaceId);
  if (current.status !== "ready") return false;
  const action = { operation: "own-role", workspaceId } as const;
  const reply = sanitizeManagementReply(action, await manageRequest(current.origin, action, current.login, {
    signal: AbortSignal.timeout(4_000),
  }));
  if (reply.status !== 200 || reply.body.status !== "ok" || reply.body.role !== "admin") return false;
  const latest = readDeviceLogin(hubUrl, workspaceId);
  return latest.status === "ready" && sameCredential(latest.login, current.login);
}

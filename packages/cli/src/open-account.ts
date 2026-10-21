import { isGithubUsername } from "@uberblick/schema/github-identity";
import { readDeviceLogin, sameCredential } from "@uberblick/mcp-server/device-login";
import { manageRequest, sanitizeManagementReply } from "@uberblick/mcp-server/management-client";
import { hubTransportProblem } from "@uberblick/mcp-server/remote-url";
import type { ServingSyncStatus } from "@uberblick/mcp-server";
import type { AccessBinding } from "./open-access.js";

export type ServingAccount = { state: "signed-in"; handle: string; accountId?: string; name?: string; githubAccountId?: string }
  | { state: "signed-out" | "unavailable" };

type NotSharedReason = ServingSyncStatus["notSharedReason"];

function refused(reason: NotSharedReason): ServingAccount | null {
  if (reason === null) return null;
  return { state: reason === "sign-in-required" || reason === "no-hub-credentials" ? "signed-out" : "unavailable" };
}

/** Stored sign-in is local information, independent of current hub acceptance. */
export function requestDeviceLogin(binding: AccessBinding, rebound = false): ServingAccount {
  if (binding.hubUrl === null) return { state: "signed-out" };
  if (rebound) return { state: "unavailable" };
  try {
    const current = readDeviceLogin(binding.hubUrl, binding.workspaceId, binding.env);
    if (current.status !== "ready") {
      return { state: current.status === "sign-in-required" ? "signed-out" : "unavailable" };
    }
    return isGithubUsername(current.login.identity.githubUsername)
      ? { state: "signed-in", handle: current.login.identity.githubUsername, accountId: current.login.identity.githubAccountId }
      : { state: "unavailable" };
  } catch {
    return { state: "unavailable" };
  }
}

/** Never copy login objects or upstream fields into the browser answer. */
export async function requestAccount(
  binding: AccessBinding,
  notSharedReason: () => NotSharedReason,
  signal: AbortSignal,
): Promise<ServingAccount> {
  if (binding.hubUrl === null) return { state: "signed-out" };
  try {
    if (hubTransportProblem(binding.hubUrl, binding.env) !== null) return { state: "unavailable" };
    const current = readDeviceLogin(binding.hubUrl, binding.workspaceId, binding.env);
    if (current.status !== "ready") {
      return { state: current.status === "sign-in-required" ? "signed-out" : "unavailable" };
    }
    const unavailable = refused(notSharedReason());
    if (unavailable !== null) return unavailable;
    const login = current.login;
    if (!isGithubUsername(login.identity.githubUsername)) return { state: "unavailable" };
    // Verify access to this served workspace without renewing or changing the login.
    const action = { operation: "own-role", workspaceId: binding.workspaceId } as const;
    const reply = sanitizeManagementReply(action, await manageRequest(current.origin, action, login, {
      signal: AbortSignal.any([signal, AbortSignal.timeout(4_000)]),
      env: binding.env,
    }));
    if (reply.status === 401 && reply.body.status === "sign-in-required") return { state: "signed-out" };
    if (reply.status !== 200 || reply.body.status !== "ok") return { state: "unavailable" };
    // Login/logout and sync refusals can arrive while the hub answers. An old
    // proof must never present a replacement or removed login as verified.
    const latest = readDeviceLogin(binding.hubUrl, binding.workspaceId, binding.env);
    if (latest.status !== "ready") {
      return { state: latest.status === "sign-in-required" ? "signed-out" : "unavailable" };
    }
    if (!sameCredential(latest.login, login) ||
        latest.login.identity.githubUsername !== login.identity.githubUsername) return { state: "unavailable" };
    return refused(notSharedReason()) ?? {
      state: "signed-in", handle: login.identity.githubUsername,
      githubAccountId: login.identity.githubAccountId,
      ...(login.identity.name === undefined ? {} : { name: login.identity.name }),
    };
  } catch {
    // Credential-store and transport errors may contain private data.
    return { state: "unavailable" };
  }
}

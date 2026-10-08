/** Public account display for the frozen workspace served by `ub open`. */
import { isGithubUsername } from "@uberblick/hub";
import { readDeviceLogin } from "@uberblick/hub/device-login";
import { manageRequest, sanitizeManagementReply } from "@uberblick/hub/management-client";
import type { ServingSyncStatus } from "@uberblick/mcp-server";
import type { AccessBinding } from "./open-access.js";

export type ServingAccount = { state: "signed-in"; handle: string }
  | { state: "signed-out" | "unavailable" };

type NotSharedReason = ServingSyncStatus["notSharedReason"];

function refused(reason: NotSharedReason): ServingAccount | null {
  if (reason === null) return null;
  return { state: reason === "sign-in-required" || reason === "no-hub-credentials" ? "signed-out" : "unavailable" };
}

/** Never copy login objects or upstream fields into the browser answer. */
export async function requestAccount(
  binding: AccessBinding,
  notSharedReason: () => NotSharedReason,
  signal: AbortSignal,
): Promise<ServingAccount> {
  if (binding.hubUrl === null) return { state: "signed-out" };
  try {
    const current = readDeviceLogin(binding.hubUrl, binding.workspaceId, binding.env);
    if (current.status !== "ready") {
      return { state: current.status === "sign-in-required" ? "signed-out" : "unavailable" };
    }
    const unavailable = refused(notSharedReason());
    if (unavailable !== null) return unavailable;
    const login = current.login;
    if (!isGithubUsername(login.identity.githubUsername)) return { state: "unavailable" };
    // The existing read-only own-role request verifies this credential and
    // access to this served workspace, without renewing or changing the login.
    const action = { operation: "own-role", workspaceId: binding.workspaceId } as const;
    const reply = sanitizeManagementReply(action, await manageRequest(current.origin, action, login, {
      signal: AbortSignal.any([signal, AbortSignal.timeout(4_000)]),
    }));
    if (reply.status === 401 && reply.body.status === "sign-in-required") return { state: "signed-out" };
    if (reply.status !== 200 || reply.body.status !== "ok") return { state: "unavailable" };
    // Login/logout and sync refusals can arrive while the hub answers. An old
    // proof must never present a replacement or removed login as verified.
    const latest = readDeviceLogin(binding.hubUrl, binding.workspaceId, binding.env);
    if (latest.status !== "ready") {
      return { state: latest.status === "sign-in-required" ? "signed-out" : "unavailable" };
    }
    if (latest.login.credential.record.id !== login.credential.record.id ||
        latest.login.credential.key !== login.credential.key ||
        latest.login.identity.githubUsername !== login.identity.githubUsername) return { state: "unavailable" };
    return refused(notSharedReason()) ?? { state: "signed-in", handle: login.identity.githubUsername };
  } catch {
    // Credential-store and transport errors may contain private data.
    return { state: "unavailable" };
  }
}

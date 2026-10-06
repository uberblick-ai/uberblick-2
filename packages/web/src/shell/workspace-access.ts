/** Live access requests use the local browser key; hub credentials stay in ub open. */
import { mintHubAuthMessage } from "../collab/rooms.js";
import type { RequestAction } from "@uberblick/hub/token";

export type AccessAction = Exclude<RequestAction, { operation: "renew-credential" | "promote-workspace" }>;
export type AccessRole = "member" | "admin";
export interface AccessMember {
  principalId: string;
  githubAccountId: string;
  githubUsername: string;
  role: AccessRole;
}
export interface AccessDevice {
  deviceId: string;
  signedInAt: number;
  current: boolean;
}
export interface AccessAnswer {
  status: string;
  hub: string | null;
  applied?: true;
  role?: AccessRole;
  githubAccountId?: string;
  githubUsername?: string;
  member?: AccessMember;
  members?: AccessMember[];
  devices?: AccessDevice[];
}

function object(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown> : null;
}
function role(value: unknown): value is AccessRole {
  return value === "member" || value === "admin";
}
function member(value: unknown): AccessMember {
  const item = object(value);
  if (item === null || typeof item.principalId !== "string" ||
    typeof item.githubAccountId !== "string" || typeof item.githubUsername !== "string" ||
    !role(item.role)) throw new Error("Invalid access answer");
  return { principalId: item.principalId, githubAccountId: item.githubAccountId,
    githubUsername: item.githubUsername, role: item.role };
}

/** Keep only the response fields this page needs, never arbitrary diagnostics. */
function answer(value: unknown, action: AccessAction): AccessAnswer {
  const body = object(value);
  // Local refusals can occur before the bridge selects a hub.
  if (body === null || typeof body.status !== "string" ||
    (body.hub !== undefined && body.hub !== null && typeof body.hub !== "string")) throw new Error("Invalid access answer");
  const parsed: AccessAnswer = { status: body.status, hub: body.hub ?? null };
  if (body.status === "closure-failed" && body.applied === true) parsed.applied = true;
  if (body.status !== "ok" && body.status !== "already-member") return parsed;
  switch (action.operation) {
    case "own-role":
      if (!role(body.role)) throw new Error("Invalid access answer");
      parsed.role = body.role;
      break;
    case "resolve-account":
      if (typeof body.githubAccountId !== "string" || typeof body.githubUsername !== "string") {
        throw new Error("Invalid access answer");
      }
      parsed.githubAccountId = body.githubAccountId;
      parsed.githubUsername = body.githubUsername;
      break;
    case "grant-member": parsed.member = member(body.member); break;
    case "list-members":
      if (!Array.isArray(body.members)) throw new Error("Invalid access answer");
      parsed.members = body.members.map(member);
      break;
    case "list-devices":
      if (!Array.isArray(body.devices)) throw new Error("Invalid access answer");
      parsed.devices = body.devices.map((value) => {
        const device = object(value);
        if (device === null || typeof device.deviceId !== "string" ||
          typeof device.signedInAt !== "number" || !Number.isFinite(new Date(device.signedInAt).getTime()) ||
          typeof device.current !== "boolean") throw new Error("Invalid access answer");
        return { deviceId: device.deviceId, signedInAt: device.signedInAt, current: device.current };
      });
      break;
  }
  return parsed;
}

export function createWorkspaceAccessClient(workspace: string, subject: string) {
  return async (action: AccessAction, signal: AbortSignal): Promise<AccessAnswer> => {
    const response = await fetch("/api/access", {
      method: "POST",
      cache: "no-store",
      redirect: "error",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json",
        Authorization: `Bearer ${await mintHubAuthMessage(workspace, subject)}`,
      },
      body: JSON.stringify(action),
      signal: AbortSignal.any([signal, AbortSignal.timeout(40_000)]),
    });
    return answer(await response.json(), action);
  };
}

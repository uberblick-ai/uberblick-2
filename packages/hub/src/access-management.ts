/** Actor-facing access management; admission remains a separate authority. */
import type { IncomingMessage, ServerResponse } from "node:http";
import type { CredentialRegistry } from "./credentials.js";
import type { GithubAccountLookup } from "./github-account-lookup.js";
import type { HubLogger } from "./log.js";
import { MembershipRefusal, type MembershipRegistry } from "./memberships.js";
import type { PrincipalRegistry } from "./principals.js";
import { protocolMismatchReason } from "@uberblick/schema/protocol";
import { clampToken, readRequestAction, type RequestAction } from "@uberblick/schema/token";
import { isJsonPost, readJsonRequest, replyJson } from "./http.js";

import type { WorkspacePromotions } from "./workspace-promotion.js";
import { HubAdminRefusal, type HubAdminRegistry } from "./hub-admins.js";

type ManagementAction = Exclude<RequestAction, { operation: "renew-credential" }>;
type ManagementOperation = ManagementAction["operation"];
type ManagementPolicy<Action extends ManagementAction> = {
  scope: Action extends { workspaceId: string } ? "workspace" | "hub" : "own" | "hub";
  role: "signed-in" | "member" | "admin" | "admin-or-receipt";
  target: readonly Exclude<keyof Action, "operation" | "cursor" | "role">[];
  changesState: boolean;
};

export const MANAGEMENT_OPERATIONS = {
  "list-devices": { scope: "own", role: "signed-in", target: [], changesState: false },
  "revoke-device": { scope: "own", role: "signed-in", target: ["deviceId"], changesState: true },
  "own-hub-role": { scope: "hub", role: "admin", target: [], changesState: false },
  "list-hub-admins": { scope: "hub", role: "admin", target: [], changesState: false },
  "list-hub-workspaces": { scope: "hub", role: "admin", target: [], changesState: false },
  "remove-hub-admin": { scope: "hub", role: "admin", target: ["principalId"], changesState: true },
  "suspend-workspace": { scope: "hub", role: "admin", target: ["workspaceId"], changesState: true },
  "restore-workspace": { scope: "hub", role: "admin", target: ["workspaceId"], changesState: true },
  // Promotion checks hub administration or receipt-based resumption atomically in its registry.
  "promote-workspace": { scope: "hub", role: "admin-or-receipt", target: ["workspaceId", "attemptId"], changesState: true },
  "own-role": { scope: "workspace", role: "member", target: ["workspaceId"], changesState: false },
  "list-members": { scope: "workspace", role: "admin", target: ["workspaceId"], changesState: false },
  "resolve-account": { scope: "workspace", role: "admin", target: ["workspaceId", "githubUsername"], changesState: false },
  "grant-member": { scope: "workspace", role: "admin", target: ["workspaceId", "githubAccountId"], changesState: true },
  "change-role": { scope: "workspace", role: "admin", target: ["workspaceId", "principalId"], changesState: true },
  "remove-member": { scope: "workspace", role: "admin", target: ["workspaceId", "principalId"], changesState: true },
} as const satisfies { [Operation in ManagementOperation]: ManagementPolicy<Extract<ManagementAction, { operation: Operation }>> };

function undeclaredOperation(_action: never): { status: "invalid-request" } {
  return { status: "invalid-request" };
}

async function readManagementRequest(request: IncomingMessage): Promise<{ token: string; version: number; action: ManagementAction }> {
  const { token, protocolVersion, ...fields } = (await readJsonRequest(request)).body;
  const action = readRequestAction(fields);
  if (typeof token !== "string" || !Number.isSafeInteger(protocolVersion) ||
    (protocolVersion as number) <= 0 || action === null || action.operation === "renew-credential" ||
    Object.keys(fields).some(field => !Object.hasOwn(action, field))) throw new Error();
  return { token, version: protocolVersion as number, action };
}

// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: This function predates the complexity limit.
export async function handleAccessManagement(
  credentials: CredentialRegistry | undefined,
  memberships: MembershipRegistry | undefined,
  principals: PrincipalRegistry | undefined,
  protocolVersion: number,
  log: HubLogger,
  request: IncomingMessage,
  response: ServerResponse,
  promotions?: WorkspacePromotions,
  accounts?: GithubAccountLookup,
  hubAdmins?: HubAdminRegistry,
  hubVersion?: string,
): Promise<boolean> {
  if (request.url !== "/auth/manage") return false;
  const reply = (status: number, body: unknown): void => replyJson(response, status, body);
  if (credentials === undefined || memberships === undefined || principals === undefined) {
    reply(503, { status: "not-configured" });
    return true;
  }
  if (!isJsonPost(request)) {
    reply(400, { status: "invalid-request" });
    return true;
  }
  let management: Awaited<ReturnType<typeof readManagementRequest>>;
  try {
    management = await readManagementRequest(request);
  } catch {
    reply(400, { status: "invalid-request" });
    return true;
  }
  const { token, version, action } = management;
  if (version !== protocolVersion) {
    reply(409, { status: "protocol-mismatch", reason: protocolMismatchReason(protocolVersion) });
    return true;
  }
  const policy = MANAGEMENT_OPERATIONS[action.operation];
  let closesAccess = false;
  try {
    const verified = await credentials.verifyRequest(token, action);
    if (verified === null) {
      reply(401, { status: "sign-in-required" });
      return true;
    }
    // Verification and GitHub lookup both yield. Each continuation must read
    // the credential and proof time again, then check current actor authority
    // synchronously with the write, on the hub's shared database handle.
    const readCurrent = () => {
      const usable = credentials.usable(credentials.get(verified.record.id));
      if ("failure" in usable || clampToken(verified.claims, Math.floor(Date.now() / 1000)) !== null) {
        reply(401, { status: "sign-in-required" });
        return null;
      }
      const current = usable.record;
      if (policy.scope === "workspace") {
        if (!("workspaceId" in action) || !current.workspaces.includes(action.workspaceId) || hubAdmins?.isSuspended(action.workspaceId)) {
          reply(403, { status: "forbidden" });
          return null;
        }
        if (policy.role === "admin") memberships.requireAdmin(action.workspaceId, current.principalId);
        else memberships.ownRole(action.workspaceId, current.principalId);
      }
      if (policy.scope === "hub" && policy.role === "admin") hubAdmins?.requireAdmin(current.principalId);
      return current;
    };
    const current = readCurrent();
    if (current === null) return true;
    switch (action.operation) {
      case "resolve-account":
      case "grant-member": {
        if (accounts === undefined) {
          reply(503, { status: "not-configured" });
          break;
        }
        const account = await accounts.lookup(action, current.principalId, action.workspaceId);
        if (account.status !== "ok") {
          reply(account.status === "account-not-found" ? 404 : 503, account);
          break;
        }
        const refreshed = readCurrent();
        if (refreshed === null) return true;
        if (action.operation === "resolve-account") {
          reply(200, account);
          break;
        }
        // A lookup never refreshes an existing principal's stored login. Only
        // its later sign-in does that; a never-seen identity comes from GitHub.
        const principal = principals.getByGithubAccountId(account.githubAccountId) ??
          principals.identify(account.githubAccountId, account.githubUsername);
        const existing = memberships.roleFor(action.workspaceId, principal.id);
        const member = memberships.grantMember({ workspaceId: action.workspaceId, actorPrincipalId: refreshed.principalId,
          principalId: principal.id, role: action.role ?? "member" });
        reply(200, { status: existing === null ? "ok" : "already-member", member: {
          principalId: principal.id, githubAccountId: principal.githubAccountId,
          githubUsername: principal.githubUsername, role: member.role,
        } });
        break;
      }
      case "promote-workspace": {
        if (promotions === undefined) {
          reply(503, { status: "not-configured" });
          break;
        }
        const status = promotions.reserve(action.workspaceId, action.attemptId, current.principalId);
        reply(status === "hub-admin-required" ? 403 : status === "workspace-conflict" || status === "workspace-suspended" ? 409 : 200,
          { status, workspaceId: action.workspaceId, attemptId: action.attemptId });
        break;
      }
      case "own-hub-role":
      case "list-hub-admins":
      case "remove-hub-admin":
      case "suspend-workspace":
      case "restore-workspace":
      case "list-hub-workspaces": {
        if (hubAdmins === undefined) {
          reply(503, { status: "not-configured" });
          break;
        }
        if (action.operation === "own-hub-role") reply(200, { status: "ok", role: "admin" });
        else if (action.operation === "list-hub-admins") reply(200, { status: "ok", ...hubAdmins.pageAdmins(current.principalId, action.cursor) });
        else if (action.operation === "list-hub-workspaces") reply(200, { status: "ok", ...hubAdmins.pageWorkspaces(current.principalId, action.cursor) });
        else if (action.operation === "suspend-workspace" || action.operation === "restore-workspace") {
          closesAccess = action.operation === "suspend-workspace";
          const workspaceStatus = action.operation === "suspend-workspace" ? "suspended" : "active";
          hubAdmins.setWorkspaceStatus(current.principalId, action.workspaceId, workspaceStatus);
          reply(200, { status: "ok", workspaceId: action.workspaceId, workspaceStatus });
        }
        else {
          hubAdmins.remove(current.principalId, action.principalId);
          reply(200, { status: "ok" });
        }
        break;
      }
      case "list-devices":
        reply(200, { status: "ok", ...(hubVersion === undefined ? {} : { hubVersion }), devices: credentials.listDevices(current.principalId)
          .map(device => ({ ...device, current: device.deviceId === current.deviceId })) });
        break;
      case "revoke-device": {
        closesAccess = true;
        const found = credentials.revokeDevice(current.principalId, action.deviceId);
        // The result contains no information about another principal's device.
        reply(found ? 200 : 404, { status: found ? "ok" : "device-not-found" });
        break;
      }
      case "own-role":
        reply(200, { status: "ok", role: memberships.ownRole(action.workspaceId, current.principalId) });
        break;
      case "list-members": {
        const members = memberships.listMembers(action.workspaceId, current.principalId).map(member => {
          const principal = principals.get(member.principalId);
          if (principal === null) throw new Error("Access management: member identity is missing");
          return { principalId: member.principalId, githubAccountId: principal.githubAccountId,
            githubUsername: principal.githubUsername, role: member.role };
        });
        reply(200, { status: "ok", members });
        break;
      }
      case "change-role":
        memberships.changeRole({ ...action, actorPrincipalId: current.principalId });
        reply(200, { status: "ok" });
        break;
      case "remove-member":
        closesAccess = true;
        memberships.remove({ ...action, actorPrincipalId: current.principalId });
        reply(200, { status: "ok" });
        break;
      default:
        reply(400, undeclaredOperation(action));
        break;
    }
  } catch (error) {
    if (error instanceof HubAdminRefusal) {
      const statuses = { "hub-admin-required": 403, "self-admin": 409, "last-admin": 409, "admin-not-found": 404,
        "workspace-not-found": 404, "invalid-request": 400 };
      reply(statuses[error.code], { status: error.code === "hub-admin-required" ? "forbidden" : error.code });
    } else if (error instanceof MembershipRefusal) {
      const statuses = { "admin-required": 403, "member-required": 403, "member-not-found": 404, "last-admin": 409 };
      reply(statuses[error.code], { status: error.code === "admin-required" || error.code === "member-required"
        ? "forbidden" : error.code });
    } else {
      // Registries throw AggregateError only after committing an access-ending
      // mutation and attempting every closure listener. Do not call it refused.
      const applied = closesAccess && error instanceof AggregateError;
      log({ event: "hub.access.management.failed", applied });
      reply(500, applied ? { status: "closure-failed", applied: true } : { status: "failed" });
    }
  }
  return true;
}

/** Actor-facing access management; admission remains a separate authority. */
import type { IncomingMessage, ServerResponse } from "node:http";
import type { CredentialRegistry } from "./credentials.js";
import type { GithubAccountLookup } from "./github-account-lookup.js";
import type { HubLogger } from "./log.js";
import { MembershipRefusal, type MembershipRegistry } from "./memberships.js";
import type { PrincipalRegistry } from "./principals.js";
import { protocolMismatchReason } from "./protocol.js";
import { clampToken, readRequestAction, type RequestAction } from "./token.js";

import type { WorkspacePromotions } from "./workspace-promotion.js";

type ManagementAction = Exclude<RequestAction, { operation: "renew-credential" }>;

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
): Promise<boolean> {
  if (request.url !== "/auth/manage") return false;
  const reply = (status: number, body: unknown): void => {
    response.writeHead(status, { "Content-Type": "application/json", "Cache-Control": "no-store" });
    response.end(JSON.stringify(body));
  };
  if (credentials === undefined || memberships === undefined || principals === undefined) {
    reply(503, { status: "not-configured" });
    return true;
  }
  if (request.method !== "POST" || request.headers.authorization !== undefined ||
    request.headers["content-type"]?.split(";")[0] !== "application/json") {
    reply(400, { status: "invalid-request" });
    return true;
  }
  let token: string;
  let version: number;
  let action: ManagementAction;
  try {
    let size = 0;
    const chunks: Buffer[] = [];
    for await (const chunk of request) {
      const bytes = Buffer.from(chunk as Uint8Array);
      size += bytes.length;
      if (size > 4096) throw new Error();
      chunks.push(bytes);
    }
    const body: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    if (body === null || typeof body !== "object" || Array.isArray(body)) throw new Error();
    const { token: proof, protocolVersion: suppliedVersion, ...fields } = body as Record<string, unknown>;
    const parsed = readRequestAction(fields);
    if (typeof proof !== "string" || !Number.isSafeInteger(suppliedVersion) ||
      (suppliedVersion as number) <= 0 || parsed === null || parsed.operation === "renew-credential" ||
      Object.keys(fields).some(field => !Object.hasOwn(parsed, field))) throw new Error();
    token = proof;
    version = suppliedVersion as number;
    action = parsed;
  } catch {
    reply(400, { status: "invalid-request" });
    return true;
  }
  if (version !== protocolVersion) {
    reply(409, { status: "protocol-mismatch", reason: protocolMismatchReason(protocolVersion) });
    return true;
  }
  let closesAccess = false;
  try {
    const verified = await credentials.verifyRequest(token, action);
    // Verification and GitHub lookup both yield. Each continuation must read
    // the credential and proof time again, then check current actor authority
    // synchronously with the write, on the hub's shared database handle.
    const readCurrent = () => {
      const current = verified === null ? null : credentials.get(verified.record.id);
      if (current === null || current.revokedAt !== null || current.replacedAt !== null ||
        verified === null || clampToken(verified.claims, Math.floor(Date.now() / 1000)) !== null) {
        reply(401, { status: "sign-in-required" });
        return null;
      }
      if (action.operation !== "promote-workspace" && "workspaceId" in action && !current.workspaces.includes(action.workspaceId)) {
        reply(403, { status: "forbidden" });
        return null;
      }
      return current;
    };
    const current = readCurrent();
    if (current === null) return true;
    switch (action.operation) {
      case "resolve-account":
      case "grant-member": {
        memberships.requireAdmin(action.workspaceId, current.principalId);
        if (accounts === undefined) {
          reply(503, { status: "not-configured" });
          break;
        }
        const account = await accounts.lookup(action);
        if (account.status !== "ok") {
          reply(account.status === "account-not-found" ? 404 : 503, account);
          break;
        }
        const refreshed = readCurrent();
        if (refreshed === null) return true;
        memberships.requireAdmin(action.workspaceId, refreshed.principalId);
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
        reply(status === "member-required" ? 403 : status === "workspace-conflict" ? 409 : 200,
          { status, workspaceId: action.workspaceId, attemptId: action.attemptId });
        break;
      }
      case "list-devices":
        reply(200, { status: "ok", devices: credentials.listDevices(current.principalId)
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
    }
  } catch (error) {
    if (error instanceof MembershipRefusal) {
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

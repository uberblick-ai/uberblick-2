/** Signed access requests share transport, never command-specific authority. */
import type { StoredHubLogin } from "./auth-store.js";
import { isGithubAccountId, isGithubUsername } from "@uberblick/schema/github-identity";
import { sanitizeDeviceName } from "@uberblick/schema/device-name";
import { sanitizeWorkspaceNames } from "@uberblick/schema/workspace-names";
import { SYNC_PROTOCOL_VERSION, readProtocolMismatch } from "@uberblick/schema/protocol";
import { importCredentialKey, mintRequestProof, REQUEST_PROOF_LIFETIME_SECONDS, type RequestAction } from "@uberblick/schema/token";

export type ManagementAction = Exclude<RequestAction, { operation: "renew-credential" }>;
export interface ManagementReply { status: number; body: Record<string, unknown> }

export class ManagementResponseError extends Error {
  constructor(readonly updateRequired = false) {
    super("hub returned an invalid management response");
  }
}

/** Bound headers and body together; proofs go only to the selected origin. */
export async function manageRequest(
  origin: string,
  action: ManagementAction,
  login: StoredHubLogin | null,
  options: { signal?: AbortSignal; maxResponseBytes?: number } = {},
): Promise<ManagementReply> {
  options.signal?.throwIfAborted();
  // Credential-free requests diagnose sign-in/protocol state without management authority.
  const token = login === null ? "" : await mintRequestProof(await importCredentialKey(Buffer.from(login.credential.key, "base64url")), {
    ...action, kid: login.credential.record.id, lifetimeSeconds: REQUEST_PROOF_LIFETIME_SECONDS,
  });
  const signal = AbortSignal.any([...(options.signal === undefined ? [] : [options.signal]), AbortSignal.timeout(10_000)]);
  const response = await fetch(`${origin}/auth/manage`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ...action, token, protocolVersion: SYNC_PROTOCOL_VERSION }),
    redirect: "error",
    signal,
  });
  signal.throwIfAborted();
  const reader = response.body?.getReader();
  if (reader === undefined) throw new ManagementResponseError(true);
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    for (;;) {
      const chunk = await reader.read();
      signal.throwIfAborted();
      if (chunk.done) break;
      length += chunk.value.length;
      if (length > (options.maxResponseBytes ?? 65_536)) throw new ManagementResponseError();
      chunks.push(chunk.value);
    }
  } finally { await reader.cancel(); }
  let body: unknown;
  try { body = JSON.parse(Buffer.concat(chunks).toString("utf8")); }
  catch { throw new ManagementResponseError(true); }
  if (body === null || typeof body !== "object" || Array.isArray(body)) throw new ManagementResponseError();
  return { status: response.status, body: body as Record<string, unknown> };
}

function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function uuid(value: unknown): value is string {
  return typeof value === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(value);
}
function member(value: unknown): Record<string, unknown> {
  if (!object(value) || !uuid(value.principalId) || !isGithubAccountId(value.githubAccountId) ||
      !isGithubUsername(value.githubUsername) || (value.role !== "member" && value.role !== "admin")) {
    throw new ManagementResponseError();
  }
  return { principalId: value.principalId, githubAccountId: value.githubAccountId,
    githubUsername: value.githubUsername, role: value.role };
}

function count(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}

function hubAdmin(value: unknown, login?: StoredHubLogin): Record<string, unknown> {
  if (!object(value) || !uuid(value.principalId) || !isGithubAccountId(value.githubAccountId) ||
      !isGithubUsername(value.githubUsername) || !count(value.workspaces) ||
      (value.lastSignedInAt !== null && !count(value.lastSignedInAt)) || typeof value.current !== "boolean" ||
      (login !== undefined && value.current !== (value.principalId === login.identity.id))) {
    throw new ManagementResponseError();
  }
  return { principalId: value.principalId, githubAccountId: value.githubAccountId,
    githubUsername: value.githubUsername, workspaces: value.workspaces,
    lastSignedInAt: value.lastSignedInAt, current: value.current };
}

function hubWorkspace(value: unknown, login?: StoredHubLogin): Record<string, unknown> {
  if (!object(value) || !uuid(value.workspaceId) || !count(value.members) ||
      !Array.isArray(value.admins) || !value.admins.every(isGithubUsername)) {
    throw new ManagementResponseError();
  }
  const name = sanitizeWorkspaceNames({ [value.workspaceId]: value.name }, [value.workspaceId],
    login?.credential.key ?? "\u0000")?.[value.workspaceId];
  return { workspaceId: value.workspaceId, members: value.members, admins: value.admins,
    ...(name === undefined ? {} : { name }) };
}

/** Project only public contract fields; upstream extras and messages may contain credentials. */
// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: This function predates the complexity limit.
export function sanitizeManagementReply(
  action: ManagementAction,
  reply: ManagementReply,
  login?: StoredHubLogin,
): ManagementReply {
  const { status, body } = reply;
  const result = (body: Record<string, unknown>): ManagementReply => ({ status, body });
  const state = body.status;
  if ((status === 400 && state === "invalid-request") ||
      (status === 401 && state === "sign-in-required") ||
      (status === 403 && state === "forbidden") ||
      (status === 500 && state === "failed") ||
      (status === 503 && state === "not-configured")) return result({ status: state });
  if (status === 409 && state === "protocol-mismatch" && typeof body.reason === "string") {
    const version = readProtocolMismatch(body.reason);
    if (version !== null) return result({ status: state, reason: `protocol-mismatch:${version}` });
  }
  if (status === 500 && state === "closure-failed" && body.applied === true &&
      (action.operation === "remove-member" || action.operation === "revoke-device")) {
    return result({ status: state, applied: true });
  }
  switch (action.operation) {
    case "own-hub-role":
      if (status === 200 && state === "ok" && body.role === "admin") {
        return result({ status: state, role: "admin" });
      }
      break;
    case "list-hub-admins":
      if (status === 200 && state === "ok" && Array.isArray(body.admins)) {
        const admins = body.admins.map(value => hubAdmin(value, login));
        if (new Set(admins.map(row => row.principalId)).size !== admins.length ||
            admins.filter(row => row.current).length !== 1) throw new ManagementResponseError();
        return result({ status: state, admins });
      }
      break;
    case "list-hub-workspaces":
      if (status === 200 && state === "ok" && Array.isArray(body.workspaces)) {
        const workspaces = body.workspaces.map(value => hubWorkspace(value, login));
        if (new Set(workspaces.map(row => row.workspaceId)).size !== workspaces.length) throw new ManagementResponseError();
        return result({ status: state, workspaces });
      }
      break;
    case "resolve-account":
      if (status === 200 && state === "ok" && isGithubAccountId(body.githubAccountId) &&
          isGithubUsername(body.githubUsername)) {
        return result({ status: state, githubAccountId: body.githubAccountId, githubUsername: body.githubUsername });
      }
      break;
    case "grant-member":
      if (status === 200 && (state === "ok" || state === "already-member")) {
        const resolved = member(body.member);
        if (resolved.githubAccountId !== action.githubAccountId) throw new ManagementResponseError();
        return result({ status: state, member: resolved });
      }
      break;
    case "own-role":
      if (status === 200 && state === "ok" && (body.role === "member" || body.role === "admin")) {
        return result({ status: state, role: body.role });
      }
      break;
    case "list-members":
      if (status === 200 && state === "ok" && Array.isArray(body.members)) {
        const members = body.members.map(member);
        if (new Set(members.map(row => row.principalId)).size !== members.length) throw new ManagementResponseError();
        return result({ status: state, members });
      }
      break;
    case "list-devices":
      if (status === 200 && state === "ok" && Array.isArray(body.devices)) {
        const devices = body.devices.map(value => {
          if (!object(value) || !uuid(value.deviceId) || !Number.isSafeInteger(value.signedInAt) ||
              (value.signedInAt as number) < 0 || typeof value.current !== "boolean" ||
              (login !== undefined && value.current !== (value.deviceId === login.credential.record.deviceId))) {
            throw new ManagementResponseError();
          }
          const name = sanitizeDeviceName(value.deviceName);
          const deviceName = name !== undefined && login !== undefined && name.includes(login.credential.key)
            ? undefined : name;
          return { deviceId: value.deviceId, signedInAt: value.signedInAt, current: value.current,
            ...(deviceName === undefined ? {} : { deviceName }) };
        });
        if (new Set(devices.map(row => row.deviceId)).size !== devices.length ||
            devices.filter(row => row.current).length !== 1) throw new ManagementResponseError();
        return result({ status: state, devices });
      }
      break;
    case "revoke-device":
    case "change-role":
    case "remove-member":
    case "remove-hub-admin":
      if (status === 200 && state === "ok") return result({ status: state });
      break;
  }
  if ((action.operation === "resolve-account" || action.operation === "grant-member") &&
      ((status === 404 && state === "account-not-found") || (status === 503 && state === "lookup-unavailable"))) {
    return result({ status: state });
  }
  if (status === 404 && state === "device-not-found" && action.operation === "revoke-device") return result({ status: state });
  if (status === 404 && state === "member-not-found" && action.operation === "change-role") return result({ status: state });
  if (action.operation === "remove-hub-admin" &&
      ((status === 404 && state === "admin-not-found") ||
       (status === 409 && (state === "self-admin" || state === "last-admin")))) return result({ status: state });
  if (status === 409 && state === "last-admin" &&
      (action.operation === "change-role" || action.operation === "remove-member")) return result({ status: state });
  throw new ManagementResponseError();
}

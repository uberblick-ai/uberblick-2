/** Signed access requests share transport, never command-specific authority. */
import type { StoredHubLogin } from "./auth-store.js";
import { isGithubAccountId, isGithubUsername } from "./github-identity.js";
import { SYNC_PROTOCOL_VERSION, readProtocolMismatch } from "./protocol.js";
import { importCredentialKey, mintRequestProof, REQUEST_PROOF_LIFETIME_SECONDS, type RequestAction } from "./token.js";

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
  // A credential-free request can distinguish missing sign-in from an older or
  // shared-secret hub. It has no authority to read or mutate management state.
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

/**
 * A local browser bridge projects only the delivered contract. Upstream extra
 * fields and messages never enter its responses, including otherwise-valid
 * responses with credential material beside the public data.
 */
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
          return { deviceId: value.deviceId, signedInAt: value.signedInAt, current: value.current };
        });
        if (new Set(devices.map(row => row.deviceId)).size !== devices.length ||
            devices.filter(row => row.current).length !== 1) throw new ManagementResponseError();
        return result({ status: state, devices });
      }
      break;
    case "revoke-device":
    case "change-role":
    case "remove-member":
      if (status === 200 && state === "ok") return result({ status: state });
      break;
  }
  if ((action.operation === "resolve-account" || action.operation === "grant-member") &&
      ((status === 404 && state === "account-not-found") || (status === 503 && state === "lookup-unavailable"))) {
    return result({ status: state });
  }
  if (status === 404 && state === "device-not-found" && action.operation === "revoke-device") return result({ status: state });
  if (status === 404 && state === "member-not-found" && action.operation === "change-role") return result({ status: state });
  if (status === 409 && state === "last-admin" &&
      (action.operation === "change-role" || action.operation === "remove-member")) return result({ status: state });
  throw new ManagementResponseError();
}

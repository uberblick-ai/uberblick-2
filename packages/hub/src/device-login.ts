/** Inactive client credential path; callers select it only programmatically. */
import { createHash } from "node:crypto";
import { closeSync, constants, fstatSync, openSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { type StoredHubLogin, isHubLogin, readHubLogins, replaceHubLogin } from "./auth-store.js";
import { LockWaitTimeoutError, acquireInitLock } from "./init-lock.js";
import { SYNC_PROTOCOL_VERSION, isProtocolVersion, readProtocolMismatch, wrapToken } from "./protocol.js";
import { authenticationOrigin } from "./remote-url.js";
import { publishOwnerOnly } from "./safe-write.js";
import { credentialsPath } from "./storage.js";
import { importCredentialKey, mintRequestProof } from "./token.js";

const REQUEST_MS = 10_000;
const MAX_RESPONSE_BYTES = 65_536;
/** Retryable outcomes are shared by rooms and processes for this long. */
export const DEVICE_RENEWAL_COOLDOWN_MS = 30_000;

type FailureStatus = "sign-in-required" | "credential-store-refused" | "credential-store-unreadable"
  | "no-access" | "hub-down" | "renewal-unavailable" | "update-required";
export interface DeviceLoginFailure {
  status: FailureStatus;
  origin: string;
  message: string;
  hubVersion?: number;
}
export type DeviceLoginResult = { status: "ready"; origin: string; login: StoredHubLogin } | DeviceLoginFailure;
export interface DeviceLoginOptions {
  env?: NodeJS.ProcessEnv;
  /** Credential used by the refused connection, never a credential from configuration. */
  rejected?: StoredHubLogin;
  signal?: AbortSignal;
}

function signIn(origin: string): DeviceLoginFailure {
  return { status: "sign-in-required", origin,
    message: `Sign-in is required for ${origin}; run \`ub auth login ${origin}\`.` };
}
function offline(origin: string): DeviceLoginFailure {
  return { status: "hub-down", origin, message: `The hub ${origin} is unreachable or credential renewal is temporarily unavailable; retry when it returns.` };
}
function unavailable(origin: string): DeviceLoginFailure {
  return { status: "renewal-unavailable", origin, message: `The hub ${origin} could not complete credential renewal; update or repair the hub and retry.` };
}
function noAccess(origin: string, workspace: string): DeviceLoginFailure {
  return { status: "no-access", origin,
    message: `This GitHub account has no access to workspace ${workspace} on ${origin}; ask a workspace administrator for access.` };
}

/** Owner-only store is the sole source, consulted for each new connection. */
export function readDeviceLogin(endpoint: string, _workspace: string, env: NodeJS.ProcessEnv = process.env): DeviceLoginResult {
  const origin = authenticationOrigin(endpoint);
  const store = readHubLogins(env);
  if (store.state === "refused" || store.state === "unreadable" || store.unreadableHubs.includes(origin)) {
    return { status: store.state === "refused" ? "credential-store-refused" : "credential-store-unreadable", origin,
      message: store.diagnostic ?? `The stored login for ${origin} is unreadable; repair the credential store and run \`ub auth login ${origin}\`.` };
  }
  const login = store.logins[origin];
  return login === undefined ? signIn(origin) : { status: "ready", origin, login };
}

function sameCredential(a: StoredHubLogin, b: StoredHubLogin): boolean {
  return a.credential.record.id === b.credential.record.id && a.credential.key === b.credential.key;
}
function fingerprint(login: StoredHubLogin): string {
  return createHash("sha256").update(login.credential.record.id).update(login.credential.key).digest("hex");
}
function paths(origin: string, env: NodeJS.ProcessEnv): { lock: string; outcome: string } {
  const hub = createHash("sha256").update(origin).digest("hex");
  const base = join(dirname(credentialsPath(env)), `.credential-renewal-${hub}`);
  return { lock: `${base}.lock`, outcome: `${base}.json` };
}

interface Outcome {
  fingerprint: string;
  retryAt: number;
  status: "renewed" | FailureStatus;
  hubVersion?: number;
}
function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
/** Sidecar contains no identity, token or key; damaged state never authorizes use. */
function readOutcome(path: string): Outcome | null {
  let fd: number | undefined;
  try {
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const stat = fstatSync(fd);
    if (!stat.isFile() || (stat.mode & 0o077) !== 0 ||
      (process.getuid !== undefined && stat.uid !== process.getuid())) return null;
    if (stat.size > 1024) return null;
    const parsed: unknown = JSON.parse(readFileSync(fd, "utf8"));
    if (!object(parsed) || typeof parsed.fingerprint !== "string" || !/^[0-9a-f]{64}$/.test(parsed.fingerprint) ||
      !Number.isSafeInteger(parsed.retryAt) || typeof parsed.status !== "string" ||
      !["renewed", "sign-in-required", "hub-down", "renewal-unavailable", "update-required"].includes(parsed.status) ||
      (parsed.status === "update-required" && (!isProtocolVersion(parsed.hubVersion) || parsed.hubVersion === SYNC_PROTOCOL_VERSION))) return null;
    return parsed as unknown as Outcome;
  } catch {
    return null;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}
function cachedResult(cached: Outcome, origin: string, workspace: string, login: StoredHubLogin): DeviceLoginResult {
  if (cached.status === "renewed") {
    return login.credential.record.workspaces.includes(workspace)
      ? { status: "ready", origin, login } : noAccess(origin, workspace);
  }
  if (cached.status === "sign-in-required") return signIn(origin);
  if (cached.status === "update-required") return { status: "update-required", origin, message: "Update the client or hub to use the same sync protocol.", ...(cached.hubVersion === undefined ? {} : { hubVersion: cached.hubVersion }) };
  return cached.status === "hub-down" ? offline(origin) : unavailable(origin);
}

/** Bound both headers and body; proof goes only to the stored authentication origin. */
async function renew(origin: string, login: StoredHubLogin, signal?: AbortSignal): Promise<StoredHubLogin | DeviceLoginFailure | "already-replaced"> {
  const requestSignal = AbortSignal.any([...(signal === undefined ? [] : [signal]), AbortSignal.timeout(REQUEST_MS)]);
  try {
    signal?.throwIfAborted();
    const key = await importCredentialKey(Buffer.from(login.credential.key, "base64url"));
    const proof = await mintRequestProof(key, {
      kid: login.credential.record.id, operation: "renew-credential", lifetimeSeconds: 60,
    });
    requestSignal.throwIfAborted();
    const response = await fetch(`${origin}/auth/credential/renew`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: wrapToken(proof),
      redirect: "error", signal: requestSignal,
    });
    const invalid = () => offline(origin);
    if (response.body === null) return invalid();
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    try {
      for (;;) {
        const chunk = await reader.read();
        if (chunk.done) break;
        size += chunk.value.length;
        if (size > MAX_RESPONSE_BYTES) return invalid();
        chunks.push(chunk.value);
      }
    } finally {
      await reader.cancel();
    }
    let body: unknown;
    try { body = JSON.parse(Buffer.concat(chunks).toString("utf8")); } catch { return invalid(); }
    if (!object(body)) return invalid();
    if (response.status === 200 && body.status === "renewed") {
      const replacement = { identity: login.identity, credential: body.credential };
      if (!isHubLogin(replacement) || replacement.credential.record.principalId !== login.credential.record.principalId ||
        replacement.credential.record.deviceId !== login.credential.record.deviceId ||
        replacement.credential.record.id === login.credential.record.id ||
        replacement.credential.record.revokedAt !== null ||
        ((replacement.credential.record as typeof replacement.credential.record & { replacedAt?: unknown }).replacedAt ?? null) !== null) return offline(origin);
      return replacement;
    }
    if (response.status === 401 && body.status === "already-replaced") return "already-replaced";
    if (response.status === 401 && body.status === "sign-in-required") return signIn(origin);
    if (response.status === 409 && body.status === "protocol-mismatch" && typeof body.reason === "string") {
      const hubVersion = readProtocolMismatch(body.reason);
      if (hubVersion !== null) return { status: "update-required", origin, hubVersion,
        message: "Update the client or hub to use the same sync protocol." };
    }
    if (response.status === 503 && body.status === "not-configured") return unavailable(origin);
    return invalid();
  } catch {
    signal?.throwIfAborted();
    return offline(origin);
  }
}

/**
 * One exchange for a machine's need. The separate origin lock spans the bounded
 * network request; the config writers' lock spans only conditional publication.
 * Rereading after either lock preserves another process's renewal/login/logout.
 */
export async function ensureDeviceLogin(endpoint: string, workspace: string, options: DeviceLoginOptions = {}): Promise<DeviceLoginResult> {
  const env = options.env ?? process.env;
  options.signal?.throwIfAborted();
  let current = readDeviceLogin(endpoint, workspace, env);
  if (current.status !== "ready") return current;
  const origin = current.origin;
  const needsRenewal = (login: StoredHubLogin) => !login.credential.record.workspaces.includes(workspace) ||
    (options.rejected !== undefined && sameCredential(login, options.rejected));
  if (!needsRenewal(current.login)) return current;
  const path = paths(origin, env);
  let lock: Awaited<ReturnType<typeof acquireInitLock>>;
  try {
    lock = await acquireInitLock(env, { path: path.lock, waitMs: REQUEST_MS + 2_500, command: "ub auth login", ...(options.signal === undefined ? {} : { signal: options.signal }) });
  } catch (error) {
    options.signal?.throwIfAborted();
    return { status: "credential-store-unreadable", origin,
      message: error instanceof LockWaitTimeoutError ? error.message : "Could not coordinate credential renewal; check the credential store directory." };
  }
  try {
    options.signal?.throwIfAborted();
    current = readDeviceLogin(endpoint, workspace, env);
    if (current.status !== "ready") return current;
    if (!needsRenewal(current.login)) return current;
    const cached = readOutcome(path.outcome);
    if (cached?.fingerprint === fingerprint(current.login) &&
      (cached.retryAt > Date.now() || (cached.status === "renewed" && !current.login.credential.record.workspaces.includes(workspace)))) {
      // A renewal has already confirmed this credential's missing access.
      // Only a changed stored credential can change that manual reading;
      // polling it must not keep retiring other workspaces' connections.
      // A replacement with workspace access is ready for an old refused
      // connection. A refusal of the newly issued credential waits, rather than
      // repeatedly retiring every process's working credential.
      if (cached.status === "renewed" && options.rejected !== undefined &&
        sameCredential(current.login, options.rejected) && current.login.credential.record.workspaces.includes(workspace)) return offline(origin);
      return cachedResult(cached, origin, workspace, current.login);
    }
    const expected = current.login;
    const result = await renew(origin, expected, options.signal);
    if (typeof result === "object" && "identity" in result) {
      try {
        // Once issued, the old key is retired. Finish bounded, conditional
        // publication even if the caller stops; login/logout still wins.
        await replaceHubLogin(origin, expected, result, env);
      } catch {
        options.signal?.throwIfAborted();
        return { status: "credential-store-unreadable", origin, message: "Could not store the renewed device login; check the credential store directory and sign in again if its replacement was lost." };
      }
      current = readDeviceLogin(endpoint, workspace, env);
      if (current.status !== "ready") return current;
      // If login changed concurrently, this exchange's result does not describe
      // its authority. Use that newer login; its next need may renew it.
      if (!sameCredential(current.login, result)) return current.login.credential.record.workspaces.includes(workspace) ? current : offline(origin);
      publishOwnerOnly(path.outcome, JSON.stringify({ fingerprint: fingerprint(result), retryAt: Date.now() + DEVICE_RENEWAL_COOLDOWN_MS, status: "renewed" } satisfies Outcome));
      options.signal?.throwIfAborted();
      return result.credential.record.workspaces.includes(workspace) ? current : noAccess(origin, workspace);
    }
    options.signal?.throwIfAborted();
    current = readDeviceLogin(endpoint, workspace, env);
    if (current.status !== "ready") return current;
    if (!sameCredential(current.login, expected)) return current.login.credential.record.workspaces.includes(workspace) ? current : offline(origin);
    const failure = result === "already-replaced" ? signIn(origin) : result;
    publishOwnerOnly(path.outcome, JSON.stringify({ fingerprint: fingerprint(expected), retryAt: Date.now() + DEVICE_RENEWAL_COOLDOWN_MS,
      status: failure.status, ...(failure.hubVersion === undefined ? {} : { hubVersion: failure.hubVersion }) } satisfies Outcome));
    return failure;
  } catch {
    options.signal?.throwIfAborted();
    return { status: "credential-store-unreadable", origin, message: "Could not record credential renewal; check the credential store directory." };
  } finally {
    lock.release();
  }
}

import { createHash, createPrivateKey, createPublicKey } from "node:crypto";
import { closeSync, constants, fstatSync, lstatSync, mkdirSync, openSync, readFileSync, readdirSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { inspectMcpGrant, requestMcpCredential } from "@uberblick/hub/mcp-channel";
import { isUuid } from "@uberblick/schema";
import { protocolSkew, readProtocolMismatch, SYNC_PROTOCOL_VERSION, wrapToken } from "@uberblick/schema/protocol";
import { generateCredentialKeyPair, importCredentialKey, mintRequestProof, REQUEST_PROOF_LIFETIME_SECONDS } from "@uberblick/schema/token";
import { isHubLogin, type StoredHubLogin } from "./auth-store.js";
import type { CredentialEnsureOptions, CredentialProvider } from "./credential-provider.js";
import { DEVICE_CREDENTIAL_RENEWAL_AGE_MS, readRenewalReply, type DeviceLoginResult } from "./device-login.js";
import { authenticationOrigin } from "./remote-url.js";
import { publishStaged, writeTempBeside } from "./safe-write.js";

/** Expiry itself remains admissible, so recovery waits for the following second. */
export const HOST_CREDENTIAL_RECOVERY_MS = (REQUEST_PROOF_LIFETIME_SECONDS + 1) * 1000;
const MAX_BYTES = 65_536;
const REQUEST_MS = 10_000;

interface GrantState {
  version: 1;
  grantId: string;
  workspace: string;
  login: StoredHubLogin;
  renewalPendingUntil?: number;
}

interface HostCredentialOptions {
  directory: string;
  endpoint: string;
  socketPath: string;
}

function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function hostCredentialPath(directory: string, grantId: string): string {
  return join(directory, `${createHash("sha256").update(grantId).digest("hex")}.json`);
}

function ownerDirectory(directory: string): void {
  mkdirSync(directory, { mode: 0o700, recursive: true });
  const stat = lstatSync(directory);
  if (!stat.isDirectory() || (stat.mode & 0o777) !== 0o700 ||
    (process.getuid !== undefined && stat.uid !== process.getuid())) {
    throw new Error("MCP grant key directory must be an owner-only directory owned by the host");
  }
}

function readState(path: string): Record<string, unknown> | null {
  let fd: number | undefined;
  try {
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.size > MAX_BYTES || (stat.mode & 0o777) !== 0o600 ||
      (process.getuid !== undefined && stat.uid !== process.getuid())) return null;
    const state: unknown = JSON.parse(readFileSync(fd, "utf8"));
    return object(state) ? state : null;
  } catch {
    return null;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

function publicKey(login: StoredHubLogin): Uint8Array {
  const privateKey = createPrivateKey({ key: Buffer.from(login.credential.key, "base64url"), format: "der", type: "pkcs8" });
  const key = createPublicKey(privateKey).export({ format: "jwk" });
  if (key.crv !== "Ed25519" || key.x === undefined) throw new Error("MCP grant key is unusable");
  return Buffer.from(key.x, "base64url");
}

function grantLogin(value: unknown, grantId: string, workspace: string): value is StoredHubLogin {
  if (!isHubLogin(value)) return false;
  const record = value.credential.record as StoredHubLogin["credential"]["record"] & { ceiling?: unknown; replacedAt?: unknown };
  return record.revokedAt === null && (record.replacedAt ?? null) === null && object(record.ceiling) &&
    record.ceiling.grantId === grantId && record.ceiling.workspaceId === workspace &&
    value.credential.record.workspaces.length === 1 && value.credential.record.workspaces[0] === workspace &&
    (record.ceiling.scope === "read-only" || record.ceiling.scope === "read-write");
}

/** One process owns these grant providers; no key or renewal work is shared with ub. */
export function createHostCredentialManager(options: HostCredentialOptions) {
  const providers = new Map<string, HostGrantCredentials>();
  return {
    providerForGrant(grantId: string, workspace: string): CredentialProvider {
      const existing = providers.get(grantId);
      if (existing !== undefined) {
        if (existing.workspace !== workspace) throw new Error("MCP grant workspace changed");
        return existing;
      }
      const provider = new HostGrantCredentials(options, grantId, workspace);
      providers.set(grantId, provider);
      return provider;
    },
    storedGrants(): Array<{ grantId: string; workspace: string }> {
      let files: string[];
      try { ownerDirectory(options.directory); files = readdirSync(options.directory); } catch { return []; }
      return files.flatMap(name => {
        if (!/^[a-f0-9]{64}\.json$/.test(name)) return [];
        const state = readState(join(options.directory, name));
        return state !== null && typeof state.grantId === "string" && state.grantId !== "" &&
            typeof state.workspace === "string" && isUuid(state.workspace) &&
            hostCredentialPath(options.directory, state.grantId) === join(options.directory, name)
          ? [{ grantId: state.grantId, workspace: state.workspace }] : [];
      });
    },
    async removeGrant(grantId: string): Promise<void> {
      await providers.get(grantId)?.retire();
      let files: string[];
      try { ownerDirectory(options.directory); files = readdirSync(options.directory); } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
        throw error;
      }
      const name = `${createHash("sha256").update(grantId).digest("hex")}.json`;
      for (const file of files) {
        if (file !== name && !(file.startsWith(`.${name}.`) && file.endsWith(".tmp"))) continue;
        try { unlinkSync(join(options.directory, file)); } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        }
      }
    },
  };
}

class HostGrantCredentials implements CredentialProvider {
  private readonly origin: string;
  private readonly path: string;
  private work: Promise<unknown> = Promise.resolve();
  private stopped = false;
  private startupRenewalFence: number | undefined;
  private recoveryUntil: number | undefined;
  private pendingUntil = 0;
  private readonly uncertainKeys = new Set<string>();

  constructor(private readonly options: HostCredentialOptions, private readonly grantId: string, readonly workspace: string) {
    this.origin = authenticationOrigin(options.endpoint);
    this.path = hostCredentialPath(options.directory, grantId);
  }

  private failure(status: "hub-down" | "no-access" | "credential-store-unreadable" | "sign-in-required", message: string): DeviceLoginResult {
    return { status, origin: this.origin, message };
  }

  private recovering(): DeviceLoginResult {
    return this.failure("hub-down", "The host is recovering this connection's credential; retry shortly.");
  }

  private state(): GrantState | null {
    const state = readState(this.path);
    if (state === null || state.version !== 1 || state.grantId !== this.grantId || state.workspace !== this.workspace ||
      !grantLogin(state.login, this.grantId, this.workspace) ||
      (state.renewalPendingUntil !== undefined && (!Number.isSafeInteger(state.renewalPendingUntil) || (state.renewalPendingUntil as number) < 0))) return null;
    return state as unknown as GrantState;
  }

  read(): DeviceLoginResult {
    if (this.stopped) return this.failure("sign-in-required", "This hosted connection has ended.");
    try { ownerDirectory(this.options.directory); } catch {
      return this.failure("credential-store-unreadable", "The host key directory is unavailable or is not owner-only.");
    }
    const state = this.state();
    return state === null || state.renewalPendingUntil !== undefined || this.uncertainKeys.has(state.login.credential.record.id)
      ? this.recovering() : { status: "ready", origin: this.origin, login: state.login };
  }

  ensure(options: CredentialEnsureOptions = {}): Promise<DeviceLoginResult> {
    const result = this.work.catch(() => {}).then(() => this.ensureCurrent(options));
    this.work = result;
    return result;
  }

  async retire(): Promise<void> {
    this.stopped = true;
    await this.work.catch(() => {});
  }

  private publish(login: StoredHubLogin, renewalPendingUntil?: number): void {
    ownerDirectory(this.options.directory);
    try {
      const stat = lstatSync(this.path);
      if (!stat.isFile() || (process.getuid !== undefined && stat.uid !== process.getuid())) {
        throw new Error("MCP grant key must be a regular file owned by the host");
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    const staged = writeTempBeside(this.path, `${JSON.stringify({ version: 1, grantId: this.grantId, workspace: this.workspace, login,
      ...(renewalPendingUntil === undefined ? {} : { renewalPendingUntil }) })}\n`);
    publishStaged(staged, this.path, "regular");
    const prefix = `.${createHash("sha256").update(this.grantId).digest("hex")}.json.`;
    for (const file of readdirSync(this.options.directory)) {
      if (file.startsWith(prefix) && file.endsWith(".tmp")) unlinkSync(join(this.options.directory, file));
    }
  }

  private uncertain(state: GrantState | null, now: number): void {
    if (state !== null) this.uncertainKeys.add(state.login.credential.record.id);
    this.recoveryUntil ??= now + HOST_CREDENTIAL_RECOVERY_MS;
    this.recoveryUntil = Math.max(this.recoveryUntil, this.pendingUntil, state?.renewalPendingUntil ?? 0);
  }

  private async inspect(state: GrantState | null) {
    return inspectMcpGrant(this.options.socketPath, this.grantId, state === null ? undefined : {
      id: state.login.credential.record.id, publicKey: publicKey(state.login),
    });
  }

  private async ensureCurrent(options: CredentialEnsureOptions): Promise<DeviceLoginResult> {
    options.signal?.throwIfAborted();
    if (this.stopped) return this.failure("sign-in-required", "This hosted connection has ended.");
    try {
      ownerDirectory(this.options.directory);
      return await this.withStore(options);
    } catch {
      options.signal?.throwIfAborted();
      return this.failure("credential-store-unreadable", "The host could not read or publish this connection's private key.");
    }
  }

  private async withStore(options: CredentialEnsureOptions): Promise<DeviceLoginResult> {
    const state = this.state();
    const inspected = await this.inspect(state);
    options.signal?.throwIfAborted();
    if (inspected.status === "unavailable") return this.failure("hub-down", "The hub credential channel is unavailable.");
    if (inspected.status === "ended") return this.failure("sign-in-required", "This hosted connection has ended.");
    if (inspected.status === "inaccessible") return this.failure("no-access", "This hosted connection currently has no workspace access.");
    const firstObservation = this.startupRenewalFence === undefined;
    this.startupRenewalFence ??= inspected.now + HOST_CREDENTIAL_RECOVERY_MS;
    const refused = options.rejected !== undefined && state !== null &&
      state.login.credential.record.id === options.rejected.credential.record.id;
    const unsafe = state === null || !inspected.current || state.renewalPendingUntil !== undefined ||
      (firstObservation && inspected.now - state.login.credential.record.issuedAt >= DEVICE_CREDENTIAL_RENEWAL_AGE_MS) ||
      this.uncertainKeys.has(state.login.credential.record.id) || refused;
    if (unsafe) {
      if (inspected.hasCredential) {
        this.uncertain(state, inspected.now);
        if (inspected.now < (this.recoveryUntil ?? 0)) return this.recovering();
      }
      return this.issue(inspected.identity, options);
    }
    if (inspected.now - state.login.credential.record.issuedAt < DEVICE_CREDENTIAL_RENEWAL_AGE_MS) {
      return { status: "ready", origin: this.origin, login: state.login };
    }
    // Restored files may predate a still-running request from the previous process.
    if (inspected.now < this.startupRenewalFence) return this.recovering();
    return this.renew(state.login, inspected.now, options);
  }

  private async issue(identity: StoredHubLogin["identity"], options: CredentialEnsureOptions): Promise<DeviceLoginResult> {
    const key = await generateCredentialKeyPair();
    options.signal?.throwIfAborted();
    let record: Awaited<ReturnType<typeof requestMcpCredential>>;
    try { record = await requestMcpCredential(this.options.socketPath, this.grantId, key.publicKey); } catch {
      return this.failure("hub-down", "The hub credential channel is unavailable.");
    }
    if (record === null) return this.failure("no-access", "The hub refused this connection's credential.");
    const login = { identity, credential: { record, key: Buffer.from(key.privateKey).toString("base64url") } };
    if (!grantLogin(login, this.grantId, this.workspace)) return this.failure("hub-down", "The hub returned an unusable grant credential.");
    if (this.stopped) return this.failure("sign-in-required", "This hosted connection has ended.");
    this.publish(login);
    this.recoveryUntil = undefined;
    this.pendingUntil = 0;
    return { status: "ready", origin: this.origin, login };
  }

  private async renew(login: StoredHubLogin, now: number, options: CredentialEnsureOptions): Promise<DeviceLoginResult> {
    const iat = Math.floor(now / 1000);
    this.pendingUntil = (iat + REQUEST_PROOF_LIFETIME_SECONDS + 1) * 1000;
    this.uncertainKeys.add(login.credential.record.id);
    this.publish(login, this.pendingUntil);
    try {
      return await this.exchange(login, iat, options);
    } catch {
      options.signal?.throwIfAborted();
      return this.recovering();
    }
  }

  private async exchange(login: StoredHubLogin, iat: number, options: CredentialEnsureOptions): Promise<DeviceLoginResult> {
    const key = await generateCredentialKeyPair();
    const publicKey = Buffer.from(key.publicKey).toString("base64url");
    const proof = await mintRequestProof(await importCredentialKey(Buffer.from(login.credential.key, "base64url")), {
      kid: login.credential.record.id, operation: "renew-credential", publicKey, iat,
      lifetimeSeconds: REQUEST_PROOF_LIFETIME_SECONDS,
    });
    options.signal?.throwIfAborted();
    const response = await fetch(`${this.origin}/auth/credential/renew`, { method: "POST", redirect: "error",
      headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ...JSON.parse(wrapToken(proof)), publicKey }),
      signal: AbortSignal.any([...(options.signal === undefined ? [] : [options.signal]), AbortSignal.timeout(REQUEST_MS)]),
    });
    const body = await readRenewalReply(response);
    if (response.status === 409 && body?.status === "protocol-mismatch" && typeof body.reason === "string") {
      const hubVersion = readProtocolMismatch(body.reason);
      if (hubVersion !== null) return { status: "update-required", origin: this.origin, hubVersion,
        message: protocolSkew(hubVersion, SYNC_PROTOCOL_VERSION) };
    }
    if (response.status !== 200 || body?.status !== "renewed" || !object(body.credential) || Object.hasOwn(body.credential, "key")) return this.recovering();
    const replacement = { identity: login.identity, credential: { ...body.credential, key: Buffer.from(key.privateKey).toString("base64url") } };
    if (!grantLogin(replacement, this.grantId, this.workspace) ||
      replacement.credential.record.id === login.credential.record.id ||
      replacement.credential.record.principalId !== login.credential.record.principalId ||
      replacement.credential.record.deviceId !== login.credential.record.deviceId) return this.recovering();
    if (this.stopped) return this.failure("sign-in-required", "This hosted connection has ended.");
    this.publish(replacement);
    this.pendingUntil = 0;
    this.recoveryUntil = undefined;
    return { status: "ready", origin: this.origin, login: replacement };
  }
}

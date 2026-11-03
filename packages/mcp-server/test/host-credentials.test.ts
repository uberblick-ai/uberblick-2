import { randomUUID } from "node:crypto";
import { chmodSync, closeSync, fstatSync, mkdirSync, openSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { inspectMcpGrant, requestMcpCredential } from "@uberblick/hub/mcp-channel";
import { importCredentialPublicKey, inspectRequestProof } from "@uberblick/schema/token";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CredentialRecord } from "../../hub/src/credentials.js";
import type { StoredHubLogin } from "../src/auth-store.js";
import type { CredentialProvider } from "../src/credential-provider.js";
import { DEVICE_CREDENTIAL_RENEWAL_AGE_MS } from "../src/device-login.js";
import { createHostCredentialManager, HOST_CREDENTIAL_RECOVERY_MS, hostCredentialPath } from "../src/host-credentials.js";
import * as safeWrite from "../src/safe-write.js";
import { removeTempDirs, tempDir } from "./shared.js";

vi.mock("@uberblick/hub/mcp-channel", () => ({ inspectMcpGrant: vi.fn(), requestMcpCredential: vi.fn() }));

const WORKSPACE = "9c1f0b4a-6d27-4e83-9b5a-1f2e3d4c5b6a";
const GRANT = "hosted-grant";
const ORIGIN = "https://hub.example";
const identity = { id: randomUUID(), githubAccountId: "1234", githubUsername: "person" };
let directory: string;
let now: number;
let current: { record: CredentialRecord; publicKey: Uint8Array } | undefined;
let historical: boolean;
let access: "active" | "inaccessible" | "ended";
let manager: ReturnType<typeof createHostCredentialManager>;

beforeEach(() => {
  directory = tempDir();
  now = Date.now();
  current = undefined;
  historical = false;
  access = "active";
  vi.mocked(inspectMcpGrant).mockImplementation(async (_path, grantId, credential) => {
    if (access === "ended") return { status: "ended", current: false, now };
    return { status: access, now, identity, hasCredential: historical, current: grantId === GRANT &&
      current !== undefined && credential?.id === current.record.id &&
      Buffer.from(credential.publicKey).equals(current.publicKey) };
  });
  vi.mocked(requestMcpCredential).mockImplementation(async (_path, grantId, publicKey) => {
    if (access !== "active" || grantId !== GRANT) return null;
    current = { record: record(current?.record.deviceId), publicKey };
    historical = true;
    return current.record;
  });
  manager = restart();
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.mocked(inspectMcpGrant).mockReset();
  vi.mocked(requestMcpCredential).mockReset();
  removeTempDirs();
});

function record(deviceId: string = randomUUID()): CredentialRecord {
  return { id: randomUUID(), principalId: identity.id, deviceId, workspaces: [WORKSPACE], issuedAt: now,
    revokedAt: null, replacedAt: null, ceiling: { grantId: GRANT, workspaceId: WORKSPACE, scope: "read-write" } };
}

function restart() {
  return createHostCredentialManager({ directory: join(directory, "keys"), endpoint: `${ORIGIN}/ws`, socketPath: "private/hub.sock" });
}

function provider(): CredentialProvider { return manager.providerForGrant(GRANT, WORKSPACE); }
function keyPath(): string { return hostCredentialPath(join(directory, "keys"), GRANT); }

async function login(): Promise<StoredHubLogin> {
  const result = await provider().ensure();
  expect(result.status).toBe("ready");
  if (result.status !== "ready") throw new Error("Grant did not become ready");
  return result.login;
}

function renewalEndpoint(mode: "reply" | "lost" | "malformed") {
  const fetcher = vi.fn(async (url: string | URL | Request, options?: RequestInit) => {
    expect(url).toBe(`${ORIGIN}/auth/credential/renew`);
    const request = JSON.parse(options?.body as string);
    expect(Object.keys(request).sort()).toEqual(["protocolVersion", "publicKey", "token"]);
    if (current === undefined) throw new Error("No credential to renew");
    const proof = await inspectRequestProof(await importCredentialPublicKey(current.publicKey), request.token,
      { operation: "renew-credential", publicKey: request.publicKey });
    expect(proof).toMatchObject({ iat: Math.floor(now / 1000), exp: Math.floor(now / 1000) + 60, kid: current.record.id });
    current = { record: record(current.record.deviceId), publicKey: Buffer.from(request.publicKey, "base64url") };
    if (mode === "lost") throw new Error("Renewal reply lost after commit");
    if (mode === "malformed") return new Response("not json");
    return Response.json({ status: "renewed", credential: { record: current.record } });
  });
  vi.stubGlobal("fetch", fetcher);
  return fetcher;
}

describe("host grant credential lifecycle", () => {
  it("issues only a public key, keeps one owner-only atomic key file, and uses it after a restart", async () => {
    const first = await login();
    expect(requestMcpCredential).toHaveBeenCalledExactlyOnceWith("private/hub.sock", GRANT, expect.any(Uint8Array));
    const supplied = vi.mocked(requestMcpCredential).mock.calls[0]![2];
    expect(supplied.byteLength).toBe(32);
    expect(Buffer.from(supplied).toString("base64url")).not.toBe(first.credential.key);
    expect(statSync(join(directory, "keys")).mode & 0o777).toBe(0o700);
    expect(statSync(keyPath()).mode & 0o777).toBe(0o600);
    expect(readdirSync(join(directory, "keys"))).toEqual([keyPath().split("/").at(-1)]);
    expect(manager.storedGrants()).toEqual([{ grantId: GRANT, workspace: WORKSPACE }]);
    manager = restart();
    expect((await login()).credential.key).toBe(first.credential.key);
    expect(requestMcpCredential).toHaveBeenCalledTimes(1);
  });

  it("renews at renewal age and atomically publishes the replacement before retiring the old file", async () => {
    const first = await login();
    const before = openSync(keyPath(), "r");
    const fetcher = renewalEndpoint("reply");
    now += DEVICE_CREDENTIAL_RENEWAL_AGE_MS;
    const renewed = await login();
    expect(renewed.credential.record.id).not.toBe(first.credential.record.id);
    expect(renewed.credential.key).not.toBe(first.credential.key);
    try {
      expect(statSync(keyPath()).ino).not.toBe(fstatSync(before).ino);
      expect(JSON.parse(readFileSync(before, "utf8")).login.credential.key).toBe(first.credential.key);
    } finally {
      closeSync(before);
    }
    expect(JSON.parse(readFileSync(keyPath(), "utf8")).login.credential.key).toBe(renewed.credential.key);
    expect(readdirSync(join(directory, "keys"))).toHaveLength(1);
    manager = restart();
    expect((await login()).credential.record.id).toBe(renewed.credential.record.id);
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(requestMcpCredential).toHaveBeenCalledTimes(1);
  });

  it.each(["lost", "malformed"] as const)("never renews again after a %s renewal reply and recovers by grant", async mode => {
    const first = await login();
    const fetcher = renewalEndpoint(mode);
    now += DEVICE_CREDENTIAL_RENEWAL_AGE_MS;
    expect(await provider().ensure()).toMatchObject({ status: "hub-down" });
    expect(JSON.parse(readFileSync(keyPath(), "utf8"))).toHaveProperty("renewalPendingUntil");
    expect(provider().read()).toMatchObject({ status: "hub-down" });
    expect(await provider().ensure()).toMatchObject({ status: "hub-down" });
    now += HOST_CREDENTIAL_RECOVERY_MS;
    const recovered = await login();
    expect(recovered.credential.record.id).not.toBe(first.credential.record.id);
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(requestMcpCredential).toHaveBeenCalledTimes(2);
  });

  it("recovers after a crash between staging a new key and publishing it without reusing the old key", async () => {
    const first = await login();
    const fetcher = renewalEndpoint("reply");
    const publish = safeWrite.publishStaged;
    let crash = true;
    vi.spyOn(safeWrite, "publishStaged").mockImplementation((staged, path, onto) => {
      const contents = JSON.parse(readFileSync(staged, "utf8"));
      if (crash && contents.renewalPendingUntil === undefined) {
        crash = false;
        throw new Error("Host stopped before replacement rename");
      }
      return publish(staged, path, onto);
    });
    now += DEVICE_CREDENTIAL_RENEWAL_AGE_MS;
    expect(await provider().ensure()).toMatchObject({ status: "hub-down" });
    const interrupted = JSON.parse(readFileSync(keyPath(), "utf8"));
    expect(interrupted.login.credential.record.id).toBe(first.credential.record.id);
    expect(interrupted.renewalPendingUntil).toBeGreaterThan(now);
    expect(readdirSync(join(directory, "keys"))).toHaveLength(2);
    manager = restart();
    expect(await provider().ensure()).toMatchObject({ status: "hub-down" });
    now += HOST_CREDENTIAL_RECOVERY_MS;
    expect((await login()).credential.record.id).not.toBe(first.credential.record.id);
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(readdirSync(join(directory, "keys"))).toHaveLength(1);
  });

  it.each(["missing-directory", "unreadable-file", "expired", "restored"] as const)("recovers a %s key by issuance and never renews the uncertain key", async damage => {
    const first = await login();
    const backup = readFileSync(keyPath(), "utf8");
    const fetcher = renewalEndpoint("reply");
    if (damage === "missing-directory") rmSync(join(directory, "keys"), { recursive: true });
    if (damage === "unreadable-file") chmodSync(keyPath(), 0o000);
    if (damage === "expired") { now += 30 * 24 * 60 * 60_000; current = undefined; }
    if (damage === "restored") {
      now += DEVICE_CREDENTIAL_RENEWAL_AGE_MS;
      await login();
      writeFileSync(keyPath(), backup, { mode: 0o600 });
    }
    manager = restart();
    expect(await provider().ensure()).toMatchObject({ status: "hub-down" });
    const previousRenewals = fetcher.mock.calls.length;
    now += HOST_CREDENTIAL_RECOVERY_MS;
    expect((await login()).credential.record.id).not.toBe(first.credential.record.id);
    expect(fetcher).toHaveBeenCalledTimes(previousRenewals);
    expect(statSync(keyPath()).mode & 0o777).toBe(0o600);
  });

  it("bounds repeated scope refusals while preserving the grant's files through membership loss and suspension", async () => {
    const first = await login();
    expect(await provider().ensure({ rejected: first })).toMatchObject({ status: "hub-down" });
    expect(await provider().ensure({ rejected: first })).toMatchObject({ status: "hub-down" });
    expect(requestMcpCredential).toHaveBeenCalledTimes(1);
    now += HOST_CREDENTIAL_RECOVERY_MS;
    const recovered = await provider().ensure({ rejected: first });
    expect(recovered.status).toBe("ready");
    if (recovered.status !== "ready") throw new Error("Recovery failed");
    expect(await provider().ensure({ rejected: recovered.login })).toMatchObject({ status: "hub-down" });
    expect(await provider().ensure({ rejected: recovered.login })).toMatchObject({ status: "hub-down" });
    expect(requestMcpCredential).toHaveBeenCalledTimes(2);
    const contents = readFileSync(keyPath(), "utf8");
    access = "inaccessible";
    expect(await provider().ensure()).toMatchObject({ status: "no-access" });
    expect(readFileSync(keyPath(), "utf8")).toBe(contents);
    access = "active";
    now += HOST_CREDENTIAL_RECOVERY_MS;
    expect(await provider().ensure()).toMatchObject({ status: "ready" });
  });

  it("retires pending work before deleting the grant key and its orphaned staged key", async () => {
    const first = await login();
    const keyFile = keyPath().split("/").at(-1)!;
    writeFileSync(join(directory, "keys", `.${keyFile}.stopped.tmp`), "orphan", { mode: 0o600 });
    await provider().ensure({ rejected: first });
    now += HOST_CREDENTIAL_RECOVERY_MS;
    let entered!: () => void;
    const started = new Promise<void>(resolve => { entered = resolve; });
    let release!: (value: CredentialRecord) => void;
    vi.mocked(requestMcpCredential).mockImplementationOnce(() => {
      entered();
      return new Promise(resolve => { release = resolve; });
    });
    const inFlight = provider().ensure({ rejected: first });
    await started;
    const removing = manager.removeGrant(GRANT);
    release(record());
    expect(await inFlight).toMatchObject({ status: "sign-in-required" });
    await removing;
    expect(readdirSync(join(directory, "keys"))).toEqual([]);
    expect(await provider().ensure()).toMatchObject({ status: "sign-in-required" });
    expect(requestMcpCredential).toHaveBeenCalledTimes(2);
  });

  it("refuses a key directory with permissions that expose it to other users", async () => {
    mkdirSync(join(directory, "keys"), { mode: 0o755 });
    expect(await provider().ensure()).toMatchObject({ status: "credential-store-unreadable" });
    expect(provider().read()).toMatchObject({ status: "credential-store-unreadable" });
    expect(requestMcpCredential).not.toHaveBeenCalled();
  });
});

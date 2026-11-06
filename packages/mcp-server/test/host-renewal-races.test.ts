import { createPrivateKey, createPublicKey } from "node:crypto";
import { once } from "node:events";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SYNC_PROTOCOL_VERSION } from "@uberblick/schema/protocol";
import { importCredentialKey, mintToken, REQUEST_PROOF_LIFETIME_SECONDS } from "@uberblick/schema/token";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AgentGrantRegistry } from "../../hub/src/agent-grants.js";
import { handleCredentialRenewal } from "../../hub/src/credential-renewal.js";
import { CredentialRegistry } from "../../hub/src/credentials.js";
import { HubAdminRegistry } from "../../hub/src/hub-admins.js";
import { inspectMcpGrant, startMcpChannel } from "../../hub/src/mcp-channel.js";
import { MembershipRegistry } from "../../hub/src/memberships.js";
import { OAuthAuthorizations } from "../../hub/src/oauth-authorizations.js";
import { HubDatabase } from "../../hub/src/persistence.js";
import { PrincipalRegistry } from "../../hub/src/principals.js";
import { WorkspaceNameReader } from "../../hub/src/workspace-names.js";
import { DEVICE_CREDENTIAL_RENEWAL_AGE_MS } from "../src/device-login.js";
import { createHostCredentialManager, hostCredentialPath } from "../src/host-credentials.js";
import { cleanupTestResources, trackListener, WORKSPACE } from "./shared.js";

const releases: Array<() => void> = [];
const pending: Promise<unknown>[] = [];
const listeners: Array<() => Promise<void>> = [];
const databases: HubDatabase[] = [];
let originalDirectory: string;
let directory: string;

afterEach(async () => {
  for (const release of releases.splice(0)) release();
  await Promise.allSettled(pending.splice(0));
  try {
    await cleanupTestResources({ hubs: listeners.splice(0), after: databases.splice(0).map(database => () => database.close()) });
  } finally {
    vi.restoreAllMocks();
    if (originalDirectory !== undefined) process.chdir(originalDirectory);
    if (directory !== undefined) rmSync(directory, { recursive: true, force: true });
  }
});

function holdFirstVerification() {
  let release!: () => void;
  let entered!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  const reached = new Promise<void>(resolve => { entered = resolve; });
  const verify = crypto.subtle.verify.bind(crypto.subtle);
  let first = true;
  vi.spyOn(crypto.subtle, "verify").mockImplementation(async (...args) => {
    if (first) {
      first = false;
      entered();
      await held;
    }
    return verify(...args);
  });
  releases.push(release);
  return { reached, release };
}

async function fixture() {
  originalDirectory = process.cwd();
  directory = mkdtempSync(join(process.env.UB_AGENTS_SCRATCH ?? tmpdir(), `host-renewal-${process.env.UB_AGENTS_RUN ?? "test"}-`));
  process.chdir(directory);
  const database = new HubDatabase(":memory:", error => { throw error; });
  database.open();
  databases.push(database);
  const clock = { now: Math.floor(Date.now() / 1000) * 1000 };
  const principals = new PrincipalRegistry(database);
  const person = principals.identify("1234", "hosted-person");
  const memberships = new MembershipRegistry(database);
  memberships.grant({ workspaceId: WORKSPACE, principalId: person.id, role: "member" });
  const admins = new HubAdminRegistry(database);
  const credentials = new CredentialRegistry(database, admins, () => {}, () => clock.now);
  const grants = new AgentGrantRegistry(database, () => clock.now);
  const authorizations = new OAuthAuthorizations(database, memberships, new WorkspaceNameReader(database), credentials, () => clock.now);
  const channel = await startMcpChannel({ path: "private/mcp.sock", principals, admins, credentials, grants, authorizations });
  listeners.push(() => channel.stop());
  const responses: ServerResponse[] = [];
  const server = createServer((request, response) => {
    responses.push(response);
    pending.push(handleCredentialRenewal(credentials, memberships, SYNC_PROTOCOL_VERSION, () => {}, request, response));
  });
  const listener = trackListener(server);
  listeners.unshift(() => listener.close());
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("test listener has no port");
  const grant = grants.create({ clientId: "hosted-client", clientName: "Hosted client", principalId: person.id,
    workspaceId: WORKSPACE, scope: "read-write" });
  const options = { directory: join(directory, "keys"), endpoint: `ws://127.0.0.1:${address.port}`, socketPath: "private/mcp.sock" };
  const provider = () => createHostCredentialManager(options).providerForGrant(grant.id, WORKSPACE);
  return { database, clock, credentials, grants, memberships, person, grant, provider, options, responses };
}

describe("host credential renewal through the hub", () => {
  it("publishes a usable renewed key and reuses it after a manager restart", async () => {
    const rig = await fixture();
    const issuance = vi.spyOn(rig.credentials, "issueForGrant");
    const renew = vi.spyOn(rig.credentials, "renew");
    const provider = rig.provider();
    const initial = await provider.ensure();
    if (initial.status !== "ready") throw new Error("initial issuance failed");
    rig.clock.now += DEVICE_CREDENTIAL_RENEWAL_AGE_MS;
    const renewed = await provider.ensure();
    if (renewed.status !== "ready") throw new Error(`renewal failed: ${renewed.status}`);
    expect(renewed.login.credential.record.id).not.toBe(initial.login.credential.record.id);
    expect(renewed.login.credential.key).not.toBe(initial.login.credential.key);
    const saved = JSON.parse(readFileSync(hostCredentialPath(rig.options.directory, rig.grant.id), "utf8"));
    expect(saved.login).toEqual(renewed.login);
    expect(saved).not.toHaveProperty("renewalPendingUntil");
    expect(rig.credentials.get(initial.login.credential.record.id)?.replacedAt).toBe(rig.clock.now);
    expect(rig.database.connection.prepare("SELECT id FROM hub_credentials WHERE revoked_at IS NULL AND replaced_at IS NULL").all())
      .toEqual([{ id: renewed.login.credential.record.id }]);
    expect(rig.grants.isLive(rig.grant.id)).toBe(true);
    expect(rig.credentials.listDevices(rig.person.id)).toEqual([expect.objectContaining({ deviceId: rig.grant.deviceId, hosted: true })]);

    const restarted = rig.provider();
    const reloaded = await restarted.ensure();
    if (reloaded.status !== "ready") throw new Error(`stored credential failed: ${reloaded.status}`);
    expect(reloaded.login).toEqual(renewed.login);
    expect(issuance).toHaveBeenCalledTimes(1);
    expect(renew).toHaveBeenCalledTimes(1);
    expect(rig.responses).toHaveLength(1);
    const roomToken = await mintToken(await importCredentialKey(Buffer.from(reloaded.login.credential.key, "base64url")), {
      typ: "room", sub: "restarted-hosted-session", workspace: WORKSPACE, scope: "read-write", kid: reloaded.login.credential.record.id,
      iat: Math.floor(rig.clock.now / 1000), lifetimeSeconds: 60,
    });
    expect(await rig.credentials.verify(roomToken)).toHaveProperty("record.id", renewed.login.credential.record.id);
  });

  it.each(["pending marker", "restored pre-marker backup"])("waits out the proof and reissues after a crash with %s", async storage => {
    const rig = await fixture();
    const issuance = vi.spyOn(rig.credentials, "issueForGrant");
    const renew = vi.spyOn(rig.credentials, "renew");
    const first = rig.provider();
    const initial = await first.ensure();
    if (initial.status !== "ready") throw new Error("initial issuance failed");
    const path = hostCredentialPath(rig.options.directory, rig.grant.id);
    const beforeRenewal = readFileSync(path, "utf8");
    rig.clock.now += DEVICE_CREDENTIAL_RENEWAL_AGE_MS;
    const proofExpiresAt = rig.clock.now + REQUEST_PROOF_LIFETIME_SECONDS * 1000;
    const verification = holdFirstVerification();
    const attempting = first.ensure();
    pending.push(attempting);
    await verification.reached;
    expect(renew).toHaveBeenCalledTimes(1);
    expect(rig.credentials.get(initial.login.credential.record.id)?.replacedAt).toBeNull();
    rig.responses[0]!.destroy();
    expect(await attempting).toHaveProperty("status", "hub-down");
    expect(JSON.parse(readFileSync(path, "utf8"))).toHaveProperty("renewalPendingUntil", proofExpiresAt + 1000);
    if (storage === "restored pre-marker backup") writeFileSync(path, beforeRenewal);
    const key = createPublicKey(createPrivateKey({ key: Buffer.from(initial.login.credential.key, "base64url"), format: "der", type: "pkcs8" }))
      .export({ format: "jwk" });
    expect(await inspectMcpGrant("private/mcp.sock", rig.grant.id, {
      id: initial.login.credential.record.id, publicKey: Buffer.from(key.x!, "base64url"),
    })).toMatchObject({ status: "active", current: true });

    const restarted = rig.provider();
    expect(await restarted.ensure()).toHaveProperty("status", "hub-down");
    rig.clock.now = proofExpiresAt;
    expect(await restarted.ensure()).toHaveProperty("status", "hub-down");
    expect(renew).toHaveBeenCalledTimes(1);
    expect(issuance).toHaveBeenCalledTimes(1);
    expect(rig.credentials.get(initial.login.credential.record.id)?.replacedAt).toBeNull();

    rig.clock.now = proofExpiresAt + 1000;
    const recovered = await restarted.ensure();
    if (recovered.status !== "ready") throw new Error(`recovery failed: ${recovered.status}`);
    expect(recovered.login.credential.record.id).not.toBe(initial.login.credential.record.id);
    expect(renew).toHaveBeenCalledTimes(1);
    expect(issuance).toHaveBeenCalledTimes(2);
    verification.release();
    expect(await renew.mock.results[0]!.value).toEqual({ status: "sign-in-required" });
    expect(rig.grants.isLive(rig.grant.id)).toBe(true);
    expect(rig.credentials.listDevices(rig.person.id)).toEqual([expect.objectContaining({ deviceId: rig.grant.deviceId, hosted: true })]);
    const roomToken = await mintToken(await importCredentialKey(Buffer.from(recovered.login.credential.key, "base64url")), {
      typ: "room", sub: "hosted-session", workspace: WORKSPACE, scope: "read-write", kid: recovered.login.credential.record.id,
      iat: Math.floor(rig.clock.now / 1000), lifetimeSeconds: 60,
    });
    expect(await rig.credentials.verify(roomToken)).toHaveProperty("record.id", recovered.login.credential.record.id);
  });
});

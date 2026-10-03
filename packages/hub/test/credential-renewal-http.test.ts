import { afterEach, describe, expect, it, vi } from "vitest";
import { CredentialRegistry, type CredentialRenewal, type IssuedCredential } from "../src/credentials.js";
import type { HubLogRecord } from "../src/log.js";
import { MembershipRegistry } from "../src/memberships.js";
import { HubDatabase } from "../src/persistence.js";
import { SYNC_PROTOCOL_VERSION } from "../src/protocol.js";
import type { Hub } from "../src/server.js";
import { importCredentialKey, mintRequestProof } from "../src/token.js";
import { removeTempDatabases, startHub, tempDatabasePath, WORKSPACE } from "./helpers.js";

const hubs: Hub[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const hub of hubs.splice(0)) await hub.stop();
  removeTempDatabases();
});

async function rig() {
  const databasePath = tempDatabasePath();
  const database = new HubDatabase(databasePath, (error) => { throw error; });
  database.open();
  let issued: IssuedCredential;
  try {
    const credentials = new CredentialRegistry(database);
    issued = credentials.issue({ principalId: "person", deviceId: "laptop", workspaces: [] });
    new MembershipRegistry(database).grant({ workspaceId: WORKSPACE, principalId: "person", role: "admin" });
  } finally {
    database.close();
  }
  const github = vi.fn<typeof fetch>(async () => { throw new Error("GitHub is unreachable"); });
  const logs: HubLogRecord[] = [];
  const hub = await startHub({ databasePath, github: { clientId: "Iv1.0123456789abcdef", fetch: github },
    log: (record) => logs.push(record) });
  hubs.push(hub);
  const key = await importCredentialKey(issued.keyBytes);
  const proof = await mintRequestProof(key, { kid: issued.record.id, operation: "renew-credential", lifetimeSeconds: 60 });
  return { hub, github, logs, issued, proof, key };
}

async function post(hub: Hub, body: unknown, options: { raw?: string; headers?: Record<string, string> } = {}) {
  const response = await fetch(`http://127.0.0.1:${hub.port}/auth/credential/renew`, {
    method: "POST", headers: { "Content-Type": "application/json", ...options.headers },
    body: options.raw ?? JSON.stringify(body),
  });
  expect(response.headers.get("cache-control")).toBe("no-store");
  return { code: response.status, result: await response.json() as CredentialRenewal | { status: string; reason?: string } };
}

const envelope = (token: string, protocolVersion = SYNC_PROTOCOL_VERSION) => ({ protocolVersion, token });

describe("public credential renewal", () => {
  it("renews a zero-workspace device against current membership with GitHub unreachable, and delivers its key once", async () => {
    const { hub, github, logs, issued, proof } = await rig();
    const renewed = await post(hub, envelope(proof));
    expect(renewed.code).toBe(200);
    if (!("credential" in renewed.result)) throw new Error("renewal failed");
    expect(renewed.result).toEqual({ status: "renewed", credential: {
      record: { ...issued.record, id: expect.any(String), issuedAt: expect.any(Number), workspaces: [WORKSPACE] },
      key: expect.stringMatching(/^[A-Za-z0-9_-]{43}$/),
    } });
    expect(renewed.result.credential.record.id).not.toBe(issued.record.id);
    const replay = await post(hub, envelope(proof));
    expect(replay).toEqual({ code: 401, result: { status: "already-replaced" } });
    expect(await post(hub, envelope("github-token")))
      .toEqual({ code: 401, result: { status: "sign-in-required" } });
    expect(github).not.toHaveBeenCalled();
    const key = renewed.result.credential.key;
    expect(JSON.stringify(logs)).not.toContain(key);
    expect(JSON.stringify(logs)).not.toContain(Buffer.from(issued.keyBytes).toString("base64url"));
    expect(JSON.stringify(logs)).not.toContain(proof);
    expect(JSON.stringify(replay.result)).not.toContain(key);
  });

  it("distinguishes malformed requests and protocol skew from proof refusals without changing credentials", async () => {
    const { hub, proof, key, issued } = await rig();
    for (const body of [null, [], {}, { token: proof }, { ...envelope(proof), key: "extra" },
      envelope(proof, 0), envelope(1 as unknown as string)]) {
      expect(await post(hub, body)).toEqual({ code: 400, result: { status: "invalid-request" } });
    }
    for (const raw of ["{", "x".repeat(4097)]) {
      expect(await post(hub, {}, { raw })).toEqual({ code: 400, result: { status: "invalid-request" } });
    }
    for (const headers of [{ Authorization: "Bearer github-token" }, { "Content-Type": "text/plain" }]) {
      expect(await post(hub, envelope(proof), { headers }))
        .toEqual({ code: 400, result: { status: "invalid-request" } });
    }
    const get = await fetch(`http://127.0.0.1:${hub.port}/auth/credential/renew`);
    expect(get.status).toBe(400);
    expect(await get.json()).toEqual({ status: "invalid-request" });
    expect(await post(hub, envelope(proof, SYNC_PROTOCOL_VERSION + 1))).toEqual({ code: 409,
      result: { status: "protocol-mismatch", reason: `protocol-mismatch:${SYNC_PROTOCOL_VERSION}` } });
    const expired = await mintRequestProof(key, { kid: issued.record.id, operation: "renew-credential", iat: 0, lifetimeSeconds: 60 });
    expect(await post(hub, envelope(expired)))
      .toEqual({ code: 401, result: { status: "sign-in-required" } });
    expect((await post(hub, envelope(proof))).code).toBe(200);
  });

  it("lets at most one concurrent HTTP exchange succeed", async () => {
    const { hub, proof } = await rig();
    const results = await Promise.all([post(hub, envelope(proof)), post(hub, envelope(proof))]);
    expect(results.map((reply) => reply.result.status).sort()).toEqual(["already-replaced", "renewed"]);
  });

  it("uses sign-in's not-configured refusal when no sign-in is configured", async () => {
    const hub = await startHub();
    hubs.push(hub);
    expect(await post(hub, {})).toEqual({ code: 503, result: { status: "not-configured" } });
    const signIn = await fetch(`http://127.0.0.1:${hub.port}/auth/github/start`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: "{}",
    });
    expect(signIn.status).toBe(503);
    expect(await signIn.json()).toEqual({ status: "not-configured" });
  });

  it("reports internal failures separately and logs no exception, request or key material", async () => {
    const { hub, proof, logs, issued } = await rig();
    const secret = Buffer.from(issued.keyBytes).toString("base64url");
    vi.spyOn(CredentialRegistry.prototype, "renew").mockRejectedValueOnce(new Error(`${secret} ${proof}`));
    expect(await post(hub, envelope(proof))).toEqual({ code: 500, result: { status: "failed" } });
    expect(logs).toContainEqual({ event: "hub.credential.renewal.failed" });
    expect(JSON.stringify(logs)).not.toContain(secret);
    expect(JSON.stringify(logs)).not.toContain(proof);
  });
});

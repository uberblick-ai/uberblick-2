import { createHash } from "node:crypto";
import { Agent, request } from "node:http";
import { DatabaseSync } from "node:sqlite";
import { workspaceResourceUrl } from "@uberblick/schema/oauth";
import { afterEach, describe, expect, it, vi } from "vitest";
import { silentLogger } from "../src/log.js";
import {
  MAX_REGISTRATIONS_PER_ADDRESS,
  MAX_REGISTRATIONS_PER_WINDOW,
  OAUTH_REGISTRATION_LIFETIME_MS,
  OAUTH_REGISTRATION_WINDOW_MS,
} from "../src/oauth-registration.js";
import { createHub, type Hub } from "../src/server.js";
import { createTeamHub, type TeamHubOptions } from "../src/team.js";
import { removeTempDatabases, tempDatabasePath, TEST_SECRET, WORKSPACE } from "./helpers.js";

const ISSUER = "https://hub.example.com";
const REDIRECT = "cursor://anysphere.cursor-mcp/oauth/callback";
const METADATA_ID = "https://agent.example/client.json";
const TOKEN = "b".repeat(43);
const hubs: Hub[] = [];
const agents: Agent[] = [];

afterEach(async () => {
  for (const agent of agents.splice(0)) agent.destroy();
  for (const hub of hubs.splice(0)) await hub.stop();
  removeTempDatabases();
  vi.restoreAllMocks();
});

function inspect<T>(path: string, read: (db: DatabaseSync) => T): T {
  const db = new DatabaseSync(path);
  try { return read(db); } finally { db.close(); }
}

function registrations(path: string) {
  return inspect(path, db => db.prepare("SELECT * FROM hub_oauth_clients").all());
}

async function rig(options: TeamHubOptions = {}) {
  const path = tempDatabasePath();
  const clock = { time: 1_800_000_000_000 };
  const agent = new Agent({ keepAlive: true, maxSockets: 16 });
  agents.push(agent);
  async function start() {
    const hub = await createTeamHub({ databasePath: path, address: "127.0.0.1", port: 0,
      authSecret: TEST_SECRET, publicUrl: ISSUER, log: silentLogger, behindReleaseProxy: true,
      github: { clientId: "Iv1.0123456789abcdef", now: () => clock.time,
        fetch: async () => { throw new Error("registration must not require GitHub"); } } }, options);
    hubs.push(hub);
    return hub;
  }
  let hub = await start();
  const principal = hub.principals!.identify("1234", "workspace-member");
  hub.memberships!.grant({ workspaceId: WORKSPACE, principalId: principal.id, role: "member" });
  return { get hub() { return hub; }, path, clock, principal, agent,
    async restart() {
      await hub.stop();
      hubs.splice(hubs.indexOf(hub), 1);
      hub = await start();
    } };
}

type Rig = Awaited<ReturnType<typeof rig>>;

function http(hub: Hub, path: string, options: {
  method?: string; headers?: Record<string, string>; text?: string; agent?: Agent;
} = {}) {
  return new Promise<{ code: number; headers: import("node:http").IncomingHttpHeaders; text: string }>((resolve, reject) => {
    const outgoing = request({ hostname: "127.0.0.1", port: hub.port, path, method: options.method ?? "GET",
      agent: options.agent, headers: { ...(options.agent === undefined ? { Connection: "close" } : {}), ...options.headers } }, response => {
      const chunks: Buffer[] = [];
      response.on("data", chunk => chunks.push(Buffer.from(chunk)));
      response.on("error", reject);
      response.on("end", () => resolve({ code: response.statusCode!, headers: response.headers,
        text: Buffer.concat(chunks).toString("utf8") }));
    });
    outgoing.on("error", reject);
    outgoing.end(options.text);
  });
}

async function register(r: Rig, metadata: unknown = { client_name: "Cursor", redirect_uris: [REDIRECT] },
  options: { address?: string; text?: string; headers?: Record<string, string> } = {}) {
  const response = await http(r.hub, "/oauth/register", { method: "POST",
    agent: r.agent,
    headers: { "Content-Type": "application/json", "X-Forwarded-For": options.address ?? "192.0.2.1", ...options.headers },
    text: options.text ?? JSON.stringify(metadata) });
  expect(response.headers["cache-control"]).toBe("no-store");
  expect(response.headers["access-control-allow-origin"]).toBeUndefined();
  return { ...response, result: JSON.parse(response.text) as Record<string, unknown> };
}

function authorize(r: Rig, clientId: string, redirectUri = REDIRECT) {
  const params = new URLSearchParams({ client_id: clientId, redirect_uri: redirectUri, response_type: "code",
    code_challenge: "a".repeat(43), code_challenge_method: "S256", resource: workspaceResourceUrl(ISSUER, WORKSPACE) });
  return http(r.hub, `/oauth/authorize?${params}`);
}

async function consent(r: Rig, requestId: string) {
  const origin = `http://127.0.0.1:${r.hub.port}`;
  inspect(r.path, db => db.prepare(`INSERT INTO hub_browser_sessions (token_hash, principal_id, origin, expires_at)
    VALUES (?, ?, ?, ?)`).run(createHash("sha256").update(TOKEN).digest("hex"), r.principal.id, origin, r.clock.time + 60_000));
  const response = await http(r.hub, "/oauth/consent/read", { method: "POST",
    headers: { "Content-Type": "application/json", Origin: origin, "Sec-Fetch-Site": "same-origin", "X-Uberblick-Session": TOKEN },
    text: JSON.stringify({ requestId }) });
  expect(response.code).toBe(200);
  return JSON.parse(response.text) as Record<string, unknown>;
}

describe("OAuth dynamic client registration", () => {
  it("issues public client metadata durably without granting workspace access", async () => {
    const r = await rig();
    const metadata = { client_name: "Cursor", redirect_uris: [REDIRECT, "http://127.0.0.1:3000/callback"],
      grant_types: ["authorization_code", "refresh_token"], response_types: ["code"] };
    const registered = await register(r, metadata);
    expect(registered.code).toBe(201);
    expect(registered.result).toMatchObject({ ...metadata, token_endpoint_auth_method: "none",
      client_id: expect.any(String), client_id_issued_at: Math.floor(r.clock.time / 1000) });
    const clientId = registered.result.client_id as string;
    expect(clientId.length).toBeGreaterThan(20);
    expect(registered.result).not.toHaveProperty("client_secret");
    expect(registrations(r.path)).toHaveLength(1);
    for (const table of ["hub_agent_grants", "hub_oauth_authorization_codes", "hub_credentials", "hub_oauth_pending_authorizations"]) {
      expect(inspect(r.path, db => db.prepare(`SELECT * FROM ${table}`).all())).toEqual([]);
    }
    await r.restart();
    const authorization = await authorize(r, clientId);
    expect(authorization.code).toBe(302);
    const requestId = new URL(authorization.headers.location!).searchParams.get("request")!;
    expect(await consent(r, requestId)).toMatchObject({ clientName: "Cursor" });
    const second = await register(r);
    expect(second.code).toBe(201);
    expect(second.result).toMatchObject({ token_endpoint_auth_method: "none",
      grant_types: ["authorization_code"], response_types: ["code"] });
    expect(second.result.client_id).not.toBe(clientId);
  });

  it("keeps registration beside the injected metadata source and applies registered redirect matching", async () => {
    const lookup = vi.fn(async (clientId: string) => clientId === METADATA_ID
      ? { name: "Metadata Agent", redirectUriAllowed: (uri: string) => uri === "https://agent.example/callback" } : null);
    const r = await rig({ oauthClients: lookup });
    const response = await register(r, { client_name: "Cursor", token_endpoint_auth_method: "none",
      redirect_uris: [REDIRECT, "http://127.0.0.1:3000/callback", "http://localhost:3000/callback"] });
    const clientId = response.result.client_id as string;
    expect((await authorize(r, clientId)).code).toBe(302);
    expect((await authorize(r, clientId, "http://127.0.0.1:4567/callback")).code).toBe(302);
    expect((await authorize(r, clientId, "http://localhost:4567/callback")).code).toBe(400);
    expect((await authorize(r, clientId, `${REDIRECT}?changed=1`)).code).toBe(400);
    expect(lookup).not.toHaveBeenCalled();
    expect((await authorize(r, METADATA_ID, "https://agent.example/callback")).code).toBe(302);
    expect(lookup).toHaveBeenCalledWith(METADATA_ID);
    expect((await authorize(r, "unknown-client-id")).code).toBe(400);
  });

  const invalid: { name: string; metadata: unknown; error: string }[] = [
    { name: "confidential authentication", metadata: { token_endpoint_auth_method: "client_secret_basic" }, error: "invalid_client_metadata" },
    { name: "unsupported grant", metadata: { grant_types: ["authorization_code", "client_credentials"] }, error: "invalid_client_metadata" },
    { name: "unsupported response", metadata: { response_types: ["token"] }, error: "invalid_client_metadata" },
    { name: "non-array grants", metadata: { grant_types: "authorization_code" }, error: "invalid_client_metadata" },
    { name: "non-array responses", metadata: { response_types: "code" }, error: "invalid_client_metadata" },
    { name: "null grants", metadata: { grant_types: null }, error: "invalid_client_metadata" },
    { name: "null responses", metadata: { response_types: null }, error: "invalid_client_metadata" },
    { name: "empty grants", metadata: { grant_types: [] }, error: "invalid_client_metadata" },
    { name: "empty responses", metadata: { response_types: [] }, error: "invalid_client_metadata" },
    { name: "missing name", metadata: { client_name: undefined }, error: "invalid_client_metadata" },
    { name: "empty name", metadata: { client_name: " " }, error: "invalid_client_metadata" },
    { name: "control character name", metadata: { client_name: "Cursor\nAgent" }, error: "invalid_client_metadata" },
    { name: "oversized name", metadata: { client_name: "x".repeat(254) }, error: "invalid_client_metadata" },
    { name: "missing redirects", metadata: { redirect_uris: undefined }, error: "invalid_redirect_uri" },
    { name: "empty redirects", metadata: { redirect_uris: [] }, error: "invalid_redirect_uri" },
    { name: "non-array redirects", metadata: { redirect_uris: REDIRECT }, error: "invalid_redirect_uri" },
    { name: "non-string redirect", metadata: { redirect_uris: [REDIRECT, 42] }, error: "invalid_redirect_uri" },
    { name: "script scheme", metadata: { redirect_uris: [REDIRECT, "JaVaScRiPt:alert(1)"] }, error: "invalid_redirect_uri" },
    { name: "remote HTTP", metadata: { redirect_uris: ["http://localhost.example.com/callback"] }, error: "invalid_redirect_uri" },
    { name: "userinfo", metadata: { redirect_uris: ["cursor://user@app/callback"] }, error: "invalid_redirect_uri" },
    { name: "fragment", metadata: { redirect_uris: [`${REDIRECT}#fragment`] }, error: "invalid_redirect_uri" },
  ];
  it.each(invalid)("refuses $name without storing a registration", async ({ metadata, error }) => {
    const r = await rig();
    const response = await register(r, { client_name: "Cursor", redirect_uris: [REDIRECT], ...metadata as object });
    expect(response.code).toBe(400);
    expect(response.result).toMatchObject({ error, error_description: expect.any(String) });
    expect(response.result.error_description).not.toBe("");
    expect(registrations(r.path)).toEqual([]);
  });

  it.each(["null", "[]", "42", "\"name\"", "{", JSON.stringify({ client_name: "Cursor", redirect_uris: [REDIRECT], padding: "x".repeat(4096) })])(
    "returns JSON metadata errors for non-object, malformed or oversized bodies (%#)", async text => {
      const r = await rig();
      const response = await register(r, undefined, { text });
      expect(response.code).toBe(400);
      expect(response.result).toMatchObject({ error: "invalid_client_metadata", error_description: expect.any(String) });
      expect(registrations(r.path)).toEqual([]);
    });

  it("refuses a failed storage insert without leaking input or leaving a registration", async () => {
    const r = await rig();
    inspect(r.path, db => db.exec(`CREATE TRIGGER registration_failure BEFORE INSERT ON hub_oauth_clients
      BEGIN SELECT RAISE(ABORT, 'private storage failure detail'); END`));
    const response = await register(r, { client_name: "Private registration name", redirect_uris: [REDIRECT] });
    expect(response.code).toBe(500);
    expect(response.result).toEqual({ error: "server_error", error_description: "Registration failed." });
    expect(response.text).not.toContain("private storage failure detail");
    expect(response.text).not.toContain("Private registration name");
    expect(response.text).not.toContain(REDIRECT);
    expect(registrations(r.path)).toEqual([]);
    inspect(r.path, db => db.exec("DROP TRIGGER registration_failure"));
    expect((await register(r)).code).toBe(201);
    expect(registrations(r.path)).toHaveLength(1);
  });

  it("removes unused registrations at thirty days and retains live and revoked grant references across restart", async () => {
    const r = await rig();
    const unused = (await register(r)).result.client_id as string;
    const live = (await register(r)).result.client_id as string;
    const revoked = (await register(r)).result.client_id as string;
    inspect(r.path, db => {
      const insert = db.prepare(`INSERT INTO hub_agent_grants
        (id, client_id, client_name, principal_id, workspace_id, scope, device_id, created_at, revoked_at)
        VALUES (?, ?, 'Cursor', ?, ?, 'read-only', ?, ?, ?)`);
      insert.run("live-grant", live, r.principal.id, WORKSPACE, "live-device", r.clock.time, null);
      insert.run("revoked-grant", revoked, r.principal.id, WORKSPACE, "revoked-device", r.clock.time, r.clock.time);
    });
    r.clock.time += OAUTH_REGISTRATION_LIFETIME_MS - 1;
    expect((await authorize(r, unused)).code).toBe(302);
    r.clock.time++;
    const expired = await authorize(r, unused);
    expect(expired.code).toBe(400);
    expect(expired.headers.location).toBeUndefined();
    expect(registrations(r.path).map(row => row.client_id).sort()).toEqual([live, revoked].sort());
    r.clock.time += OAUTH_REGISTRATION_LIFETIME_MS;
    await r.restart();
    expect((await authorize(r, live)).code).toBe(302);
    expect((await authorize(r, revoked)).code).toBe(302);
    expect(registrations(r.path)).toHaveLength(2);
  });

  it("limits each address independently and allows it again after the sliding window", async () => {
    const r = await rig();
    for (let index = 0; index < MAX_REGISTRATIONS_PER_ADDRESS; index++) {
      expect((await register(r)).code).toBe(201);
    }
    const refused = await register(r);
    expect(refused.code).toBe(429);
    expect(Number(refused.headers["retry-after"])).toBeGreaterThan(0);
    expect(registrations(r.path)).toHaveLength(MAX_REGISTRATIONS_PER_ADDRESS);
    expect((await register(r, undefined, { address: "192.0.2.2" })).code).toBe(201);
    r.clock.time += OAUTH_REGISTRATION_WINDOW_MS;
    expect((await register(r)).code).toBe(201);
  });

  it("limits the whole hub even when each registration uses an address with capacity", async () => {
    const r = await rig();
    expect((await register(r)).code).toBe(201);
    // Invalid attempts spend the same budget without a durable insert for each request.
    const invalidAttempts = MAX_REGISTRATIONS_PER_WINDOW - 2;
    for (let start = 0; start < invalidAttempts; start += 16) {
      const responses = await Promise.all(Array.from({ length: Math.min(16, invalidAttempts - start) }, (_, offset) => {
        const address = `198.51.100.${Math.floor((start + offset) / MAX_REGISTRATIONS_PER_ADDRESS) + 1}`;
        return register(r, undefined, { address, headers: { "Content-Type": "text/plain" } });
      }));
      for (const response of responses) {
        expect(response.code).toBe(400);
      }
    }
    expect((await register(r, undefined, { address: "192.0.2.2" })).code).toBe(201);
    expect(registrations(r.path)).toHaveLength(2);
    for (const address of ["203.0.113.1", "203.0.113.2"]) {
      const refused = await register(r, undefined, { address });
      expect(refused.code).toBe(429);
      expect(Number(refused.headers["retry-after"])).toBeGreaterThan(0);
    }
    expect(registrations(r.path)).toHaveLength(2);
    r.clock.time += OAUTH_REGISTRATION_WINDOW_MS;
    expect((await register(r, undefined, { address: "203.0.113.1" })).code).toBe(201);
    expect(registrations(r.path)).toHaveLength(3);
  });

  it("answers only POST and hides registration when OAuth is unconfigured", async () => {
    const r = await rig();
    for (const method of ["GET", "PUT", "DELETE", "OPTIONS"]) {
      const response = await http(r.hub, "/oauth/register", { method });
      expect(response.code).toBe(405);
      expect(response.headers.allow).toBe("POST");
    }
    const config = { databasePath: ":memory:", port: 0, authSecret: TEST_SECRET, log: silentLogger };
    const candidates = [
      await createTeamHub({ ...config, github: { clientId: "Iv1.0123456789abcdef" } }),
      await createTeamHub({ ...config, publicUrl: ISSUER }),
      await createHub({ ...config, publicUrl: ISSUER }),
    ];
    hubs.push(...candidates);
    for (const hub of candidates) {
      for (const method of ["POST", "GET"]) {
        expect((await http(hub, "/oauth/register", { method })).code).toBe(404);
      }
    }
    expect(registrations(r.path)).toEqual([]);
  });
});

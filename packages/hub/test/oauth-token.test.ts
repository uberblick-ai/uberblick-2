import { createHash } from "node:crypto";
import { request, type IncomingHttpHeaders } from "node:http";
import { DatabaseSync } from "node:sqlite";
import { workspaceResourceUrl } from "@uberblick/schema/oauth";
import { afterEach, describe, expect, it } from "vitest";
import { silentLogger } from "../src/log.js";
import { createHub, type Hub } from "../src/server.js";
import { createTeamHub } from "../src/team.js";
import { removeTempDatabases, tempDatabasePath, TEST_SECRET, WORKSPACE } from "./helpers.js";

const ISSUER = "https://hub.example.com";
const CLIENT = "https://agent.example.com/client.json";
const REDIRECT = "https://agent.example.com/callback?existing=kept";
const VERIFIER = "verifier_with-unreserved.characters~".repeat(2);
const SESSION = "b".repeat(43);
const RESOURCE = workspaceResourceUrl(ISSUER, WORKSPACE);
const FORM_HEADERS = { "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8" };
const hubs: Hub[] = [];

afterEach(async () => {
  for (const hub of hubs.splice(0)) await hub.stop();
  removeTempDatabases();
});

function inspect<T>(path: string, read: (db: DatabaseSync) => T): T {
  const db = new DatabaseSync(path);
  try { return read(db); } finally { db.close(); }
}

function authority(path: string) {
  return inspect(path, db => ({
    grants: db.prepare("SELECT * FROM hub_agent_grants").all(),
    codes: db.prepare("SELECT * FROM hub_oauth_authorization_codes").all(),
    tokens: db.prepare("SELECT * FROM hub_oauth_access_tokens").all(),
    refreshTokens: db.prepare("SELECT * FROM hub_oauth_refresh_tokens").all(),
    refreshAccessTokens: db.prepare("SELECT * FROM hub_oauth_refresh_access_tokens").all(),
  }));
}

function http(hub: Hub, path: string, options: {
  method?: string; headers?: Record<string, string>; text?: string; chunks?: string[];
} = {}) {
  return new Promise<{ code: number; headers: IncomingHttpHeaders; text: string }>((resolve, reject) => {
    const outgoing = request({ hostname: "127.0.0.1", port: hub.port, path, method: options.method ?? "GET",
      headers: { Connection: "close", ...options.headers } }, response => {
      const chunks: Buffer[] = [];
      response.on("data", chunk => chunks.push(Buffer.from(chunk)));
      response.on("error", reject);
      response.on("end", () => resolve({ code: response.statusCode!, headers: response.headers,
        text: Buffer.concat(chunks).toString("utf8") }));
    });
    outgoing.on("error", reject);
    for (const chunk of options.chunks ?? []) outgoing.write(chunk);
    outgoing.end(options.text);
  });
}

async function rig() {
  const path = tempDatabasePath();
  const clock = { time: 1000 };
  const hub = await createTeamHub({ databasePath: path, address: "127.0.0.1", port: 0,
    authSecret: TEST_SECRET, publicUrl: ISSUER, log: silentLogger,
    github: { clientId: "Iv1.0123456789abcdef", now: () => clock.time,
      fetch: async () => { throw new Error("token exchange must not fetch client metadata or identity"); } } }, {
    oauthClients: async clientId => clientId === CLIENT
      ? { name: "Example MCP client", redirectUriAllowed: uri => uri === REDIRECT } : null,
  });
  hubs.push(hub);
  const principal = hub.principals!.identify("1234", "workspace-member");
  hub.memberships!.grant({ workspaceId: WORKSPACE, principalId: principal.id, role: "member" });
  const origin = `http://127.0.0.1:${hub.port}`;
  inspect(path, db => db.prepare(`INSERT INTO hub_browser_sessions (token_hash, principal_id, origin, expires_at)
    VALUES (?, ?, ?, ?)`).run(createHash("sha256").update(SESSION).digest("hex"), principal.id, origin, clock.time + 86_400_000));
  return { hub, path, clock, origin };
}

type Rig = Awaited<ReturnType<typeof rig>>;

async function code(r: Rig, accessLevel: "read-only" | "read-write" = "read-write") {
  const parameters = new URLSearchParams({ client_id: CLIENT, redirect_uri: REDIRECT, response_type: "code",
    code_challenge: createHash("sha256").update(VERIFIER).digest("base64url"), code_challenge_method: "S256", resource: RESOURCE });
  const authorization = await http(r.hub, `/oauth/authorize?${parameters}`);
  expect(authorization.code).toBe(302);
  const requestId = new URL(authorization.headers.location!).searchParams.get("request");
  const consent = await http(r.hub, "/oauth/consent/submit", { method: "POST",
    headers: { "Content-Type": "application/json", Origin: r.origin, "Sec-Fetch-Site": "same-origin", "X-Uberblick-Session": SESSION },
    text: JSON.stringify({ requestId, decision: "approve", accessLevel }) });
  expect(consent.code).toBe(200);
  return new URL(JSON.parse(consent.text).redirectUrl as string).searchParams.get("code")!;
}

function parameters(value: string) {
  return new URLSearchParams({ grant_type: "authorization_code", code: value, code_verifier: VERIFIER,
    client_id: CLIENT, redirect_uri: REDIRECT, resource: RESOURCE });
}

function refreshParameters(value: string) {
  return new URLSearchParams({ grant_type: "refresh_token", refresh_token: value, client_id: CLIENT });
}

async function exchange(r: Rig, body: URLSearchParams) {
  const response = await http(r.hub, "/oauth/token", { method: "POST", headers: FORM_HEADERS, text: body.toString() });
  expect(response.headers["cache-control"]).toBe("no-store");
  expect(response.headers.pragma).toBe("no-cache");
  expect(response.headers["access-control-allow-origin"]).toBeUndefined();
  return { ...response, body: JSON.parse(response.text) as Record<string, unknown> };
}

describe("OAuth authorization code token endpoint", () => {
  it.each(["read-only", "read-write"] as const)("exchanges a consent code for the approved %s scope", async accessLevel => {
    const r = await rig();
    const body = parameters(await code(r, accessLevel));
    if (accessLevel === "read-only") body.delete("resource");
    const response = await exchange(r, body);
    expect(response.code).toBe(200);
    expect(response.headers["content-type"]).toBe("application/json");
    const scope = accessLevel === "read-only" ? "docs:read" : "docs:read docs:write";
    expect(response.body).toEqual({ access_token: expect.stringMatching(/^[A-Za-z0-9_-]{43}$/),
      token_type: "Bearer", expires_in: 3600, scope, refresh_token: expect.stringMatching(/^[A-Za-z0-9_-]{43}$/) });
    const state = authority(r.path);
    expect(state.tokens).toHaveLength(1);
    expect(state.tokens[0]).toMatchObject({
      token_hash: createHash("sha256").update(response.body.access_token as string).digest("hex"),
      grant_id: state.grants[0]!.id, resource: RESOURCE, scope, expires_at: r.clock.time + 3_600_000, revoked_at: null,
    });
    expect(state.refreshTokens).toHaveLength(1);
    expect(state.refreshTokens[0]).toMatchObject({
      token_hash: createHash("sha256").update(response.body.refresh_token as string).digest("hex"),
      grant_id: state.grants[0]!.id, client_id: CLIENT, resource: RESOURCE, scope,
      expires_at: r.clock.time + 30 * 86_400_000, spent_at: null, revoked_at: null,
    });
    expect(JSON.stringify(state)).not.toContain(response.body.access_token);
    expect(JSON.stringify(state)).not.toContain(response.body.refresh_token);
  });

  it("treats an empty optional resource as omitted", async () => {
    const r = await rig();
    const body = parameters(await code(r));
    body.set("resource", "");
    expect((await exchange(r, body)).code).toBe(200);
    expect(authority(r.path).tokens[0]).toMatchObject({ resource: RESOURCE });
  });

  const invalid: { name: string; error: string; change: (body: URLSearchParams) => void }[] = [
    ...["grant_type", "code", "code_verifier", "client_id", "redirect_uri"].map(name => ({
      name: `missing ${name}`, error: "invalid_request", change: (body: URLSearchParams) => body.delete(name),
    })),
    ...["grant_type", "code", "code_verifier", "client_id", "redirect_uri", "resource", "extension"].map(name => ({
      name: `repeated ${name}`, error: "invalid_request", change: (body: URLSearchParams) => {
        body.append(name, "request-only-marker");
        if (name === "extension") body.append(name, "request-only-marker");
      },
    })),
    { name: "empty code", error: "invalid_request", change: body => body.set("code", "") },
    { name: "unknown grant", error: "unsupported_grant_type", change: body => body.set("grant_type", "request-only-marker") },
    { name: "wrong verifier", error: "invalid_grant", change: body => body.set("code_verifier", "x".repeat(43)) },
    { name: "wrong resource", error: "invalid_target", change: body => body.set("resource", "https://request-only-marker.example/mcp") },
  ];
  it.each(invalid)("refuses $name without changing authority or consuming the code", async ({ change, error }) => {
    const r = await rig();
    const valid = parameters(await code(r));
    const before = authority(r.path);
    const body = new URLSearchParams(valid);
    change(body);
    const response = await exchange(r, body);
    expect(response.code).toBe(400);
    expect(response.body).toEqual({ error });
    expect(response.text).not.toContain("request-only-marker");
    expect(authority(r.path)).toEqual(before);
    expect((await exchange(r, valid)).code).toBe(200);
  });

  it.each([
    { name: "Basic", header: "Basic request-only-credentials", scheme: "Basic" },
    { name: "Bearer", header: "Bearer request-only-credentials", scheme: "Bearer" },
    { name: "malformed", header: "request-only-credentials", scheme: "Basic" },
  ])("refuses $name header authentication without reflecting credentials", async ({ header, scheme }) => {
    const r = await rig();
    const body = parameters(await code(r));
    const before = authority(r.path);
    const response = await http(r.hub, "/oauth/token", { method: "POST", headers: {
      ...FORM_HEADERS, Authorization: header,
    }, text: body.toString() });
    expect(response.code).toBe(401);
    expect(JSON.parse(response.text)).toEqual({ error: "invalid_client" });
    expect(response.headers["www-authenticate"]).toBe(`${scheme} realm="oauth"`);
    expect(response.headers["cache-control"]).toBe("no-store");
    expect(response.headers.pragma).toBe("no-cache");
    expect(JSON.stringify(response)).not.toContain("request-only-credentials");
    expect(authority(r.path)).toEqual(before);
    expect((await exchange(r, body)).code).toBe(200);
  });

  it("serializes in-flight redemptions and revokes the grant's tokens after a valid code replay", async () => {
    const r = await rig();
    const body = parameters(await code(r));
    const text = body.toString();
    let outgoing!: ReturnType<typeof request>;
    const stalled = new Promise<{ code: number; text: string }>((resolve, reject) => {
      outgoing = request({ hostname: "127.0.0.1", port: r.hub.port, path: "/oauth/token", method: "POST",
        headers: { ...FORM_HEADERS, Connection: "close" } }, response => {
        const chunks: Buffer[] = [];
        response.on("data", chunk => chunks.push(Buffer.from(chunk)));
        response.on("error", reject);
        response.on("end", () => resolve({ code: response.statusCode!, text: Buffer.concat(chunks).toString("utf8") }));
      });
      outgoing.on("error", reject);
    });
    // A failure before the stalled response is awaited must still reach this test's cleanup.
    void stalled.catch(() => {});
    try {
      await new Promise<void>((resolve, reject) => {
        outgoing.once("error", reject);
        outgoing.write(text.slice(0, -1), error => error ? reject(error) : resolve());
      });
      const first = await exchange(r, body);
      expect(first.code).toBe(200);
      expect(authority(r.path).tokens).toHaveLength(1);
      expect(authority(r.path).tokens[0]).toMatchObject({ revoked_at: null });
      const refreshed = await exchange(r, refreshParameters(first.body.refresh_token as string));
      expect(refreshed.code).toBe(200);
      outgoing.end(text.slice(-1));
      const replay = await stalled;
      expect(replay.code).toBe(400);
      expect(JSON.parse(replay.text)).toEqual({ error: "invalid_grant" });
      const state = authority(r.path);
      expect(state.tokens).toHaveLength(1);
      expect(state.tokens[0]).toMatchObject({ revoked_at: r.clock.time });
      expect(state.refreshAccessTokens).toHaveLength(1);
      expect(state.refreshAccessTokens[0]).toMatchObject({ revoked_at: r.clock.time });
      expect(state.refreshTokens).toHaveLength(2);
      expect(state.refreshTokens.every(token => token.revoked_at === r.clock.time)).toBe(true);
      expect(state.grants[0]).toMatchObject({ revoked_at: null });
      expect(await exchange(r, refreshParameters(refreshed.body.refresh_token as string)))
        .toMatchObject({ code: 400, body: { error: "invalid_grant" } });
    } finally {
      outgoing.destroy(new Error("stalled request cleanup"));
      await stalled.catch(() => {});
    }
  });

  it("requires form bodies and bounds both fixed-length and chunked requests", async () => {
    const r = await rig();
    const body = parameters(await code(r));
    const before = authority(r.path);
    const oversized = `${body}&extension=${"x".repeat(16_384)}`;
    const cases = [
      { headers: { "Content-Type": "application/json" }, text: JSON.stringify(Object.fromEntries(body)) },
      { headers: {}, text: body.toString() },
      { headers: { ...FORM_HEADERS, "Content-Length": String(Buffer.byteLength(oversized)) }, text: oversized },
      { headers: FORM_HEADERS, chunks: [body.toString(), "&extension=", "x".repeat(9000), "x".repeat(9000)] },
    ];
    for (const options of cases) {
      const response = await http(r.hub, "/oauth/token", { method: "POST", ...options });
      expect(response.code).toBe(400);
      expect(JSON.parse(response.text)).toEqual({ error: "invalid_request" });
      expect(response.headers["cache-control"]).toBe("no-store");
      expect(response.headers.pragma).toBe("no-cache");
      expect(authority(r.path)).toEqual(before);
    }
    expect((await exchange(r, body)).code).toBe(200);
  });

  it("returns safe server errors and leaves a code redeemable after failed token storage", async () => {
    const r = await rig();
    const body = parameters(await code(r));
    const before = authority(r.path);
    inspect(r.path, db => db.exec(`CREATE TRIGGER token_failure BEFORE INSERT ON hub_oauth_access_tokens
      BEGIN SELECT RAISE(ABORT, 'request-only-marker storage failure'); END`));
    const response = await exchange(r, body);
    expect(response.code).toBe(500);
    expect(response.body).toEqual({ error: "server_error" });
    expect(authority(r.path)).toEqual(before);
    inspect(r.path, db => db.exec("DROP TRIGGER token_failure"));
    expect((await exchange(r, body)).code).toBe(200);
  });

  it("refuses an expired consent code without issuing a token", async () => {
    const r = await rig();
    const body = parameters(await code(r));
    r.clock.time += 60_000;
    const before = authority(r.path);
    expect(await exchange(r, body)).toMatchObject({ code: 400, body: { error: "invalid_grant" } });
    expect(authority(r.path)).toEqual(before);
  });

  it.each(["GET", "PUT", "DELETE", "OPTIONS", "HEAD"])("answers %s with 405 and no authority change", async method => {
    const r = await rig();
    const before = authority(r.path);
    const response = await http(r.hub, "/oauth/token", { method });
    expect(response.code).toBe(405);
    expect(response.headers.allow).toBe("POST");
    expect(response.headers["cache-control"]).toBe("no-store");
    expect(response.headers["access-control-allow-origin"]).toBeUndefined();
    expect(authority(r.path)).toEqual(before);
  });
});

describe("OAuth refresh token endpoint", () => {
  it("rotates tokens, narrows access scope and restores the grant scope on a later refresh", async () => {
    const r = await rig();
    const initial = await exchange(r, parameters(await code(r)));
    const body = refreshParameters(initial.body.refresh_token as string);
    body.set("scope", "docs:read");
    body.set("resource", RESOURCE);
    const narrowed = await exchange(r, body);
    expect(narrowed.code).toBe(200);
    expect(narrowed.body).toEqual({ access_token: expect.stringMatching(/^[A-Za-z0-9_-]{43}$/),
      token_type: "Bearer", expires_in: 3600, scope: "docs:read", refresh_token: expect.stringMatching(/^[A-Za-z0-9_-]{43}$/) });
    expect(narrowed.body.access_token).not.toBe(initial.body.access_token);
    expect(narrowed.body.refresh_token).not.toBe(initial.body.refresh_token);
    const state = authority(r.path);
    expect(state.refreshAccessTokens).toHaveLength(1);
    expect(state.refreshAccessTokens[0]).toMatchObject({
      token_hash: createHash("sha256").update(narrowed.body.access_token as string).digest("hex"),
      grant_id: state.grants[0]!.id, resource: RESOURCE, scope: "docs:read",
      expires_at: r.clock.time + 3_600_000, revoked_at: null,
    });
    expect(state.refreshTokens).toHaveLength(2);
    expect(state.refreshTokens[0]).toMatchObject({ spent_at: r.clock.time });
    expect(state.refreshTokens[1]).toMatchObject({
      token_hash: createHash("sha256").update(narrowed.body.refresh_token as string).digest("hex"),
      grant_id: state.grants[0]!.id, client_id: CLIENT, resource: RESOURCE, scope: "docs:read docs:write",
      expires_at: r.clock.time + 30 * 86_400_000, spent_at: null, revoked_at: null,
    });
    expect(JSON.stringify(state)).not.toContain(narrowed.body.access_token);
    expect(JSON.stringify(state)).not.toContain(narrowed.body.refresh_token);
    const restored = refreshParameters(narrowed.body.refresh_token as string);
    restored.set("resource", "");
    expect(await exchange(r, restored)).toMatchObject({ code: 200, body: { scope: "docs:read docs:write" } });
  });

  const invalid: { name: string; error: string; change: (body: URLSearchParams) => void }[] = [
    ...["grant_type", "refresh_token", "client_id"].map(name => ({
      name: `missing ${name}`, error: "invalid_request", change: (body: URLSearchParams) => body.delete(name),
    })),
    ...["grant_type", "refresh_token", "client_id"].map(name => ({
      name: `empty ${name}`, error: "invalid_request", change: (body: URLSearchParams) => body.set(name, ""),
    })),
    ...["grant_type", "refresh_token", "client_id", "scope", "resource", "extension"].map(name => ({
      name: `repeated ${name}`, error: "invalid_request", change: (body: URLSearchParams) => {
        body.append(name, "request-only-marker");
        if (name === "scope" || name === "resource" || name === "extension") body.append(name, "request-only-marker");
      },
    })),
    { name: "unknown token", error: "invalid_grant", change: body => body.set("refresh_token", "request-only-marker") },
    { name: "wrong client", error: "invalid_grant", change: body => body.set("client_id", "https://request-only-marker.example") },
    { name: "wrong resource", error: "invalid_target", change: body => body.set("resource", "https://request-only-marker.example/mcp") },
    ...["", "docs:write", "docs:read unknown", "docs:read docs:write"].map(scope => ({
      name: `invalid scope ${JSON.stringify(scope)}`, error: "invalid_scope", change: (body: URLSearchParams) => body.set("scope", scope),
    })),
  ];
  it.each(invalid)("refuses $name without issuing tokens or consuming the refresh token", async ({ change, error }) => {
    const r = await rig();
    const initial = await exchange(r, parameters(await code(r, "read-only")));
    const valid = refreshParameters(initial.body.refresh_token as string);
    const before = authority(r.path);
    const body = new URLSearchParams(valid);
    change(body);
    const response = await exchange(r, body);
    expect(response.code).toBe(400);
    expect(response.body).toEqual({ error });
    expect(response.text).not.toContain("request-only-marker");
    expect(authority(r.path)).toEqual(before);
    expect((await exchange(r, valid)).code).toBe(200);
  });

  it("serializes in-flight refreshes so the second presentation ends the grant", async () => {
    const r = await rig();
    const initial = await exchange(r, parameters(await code(r)));
    const body = refreshParameters(initial.body.refresh_token as string);
    const text = body.toString();
    let outgoing!: ReturnType<typeof request>;
    const stalled = new Promise<{ code: number; text: string }>((resolve, reject) => {
      outgoing = request({ hostname: "127.0.0.1", port: r.hub.port, path: "/oauth/token", method: "POST",
        headers: { ...FORM_HEADERS, Connection: "close" } }, response => {
        const chunks: Buffer[] = [];
        response.on("data", chunk => chunks.push(Buffer.from(chunk)));
        response.on("error", reject);
        response.on("end", () => resolve({ code: response.statusCode!, text: Buffer.concat(chunks).toString("utf8") }));
      });
      outgoing.on("error", reject);
    });
    void stalled.catch(() => {});
    try {
      await new Promise<void>((resolve, reject) => {
        outgoing.once("error", reject);
        outgoing.write(text.slice(0, -1), error => error ? reject(error) : resolve());
      });
      const first = await exchange(r, body);
      expect(first.code).toBe(200);
      expect(authority(r.path).grants[0]).toMatchObject({ revoked_at: null });
      outgoing.end(text.slice(-1));
      const replay = await stalled;
      expect(replay.code).toBe(400);
      expect(JSON.parse(replay.text)).toEqual({ error: "invalid_grant" });
      expect(authority(r.path).grants[0]).toMatchObject({ revoked_at: expect.any(Number) });
      expect(authority(r.path).refreshAccessTokens).toHaveLength(1);
      expect(authority(r.path).refreshTokens).toHaveLength(2);
      expect(await exchange(r, refreshParameters(first.body.refresh_token as string)))
        .toMatchObject({ code: 400, body: { error: "invalid_grant" } });
    } finally {
      outgoing.destroy(new Error("stalled request cleanup"));
      await stalled.catch(() => {});
    }
  });

  it("returns a safe server error and preserves the refresh token after failed rotation storage", async () => {
    const r = await rig();
    const initial = await exchange(r, parameters(await code(r)));
    const body = refreshParameters(initial.body.refresh_token as string);
    const before = authority(r.path);
    inspect(r.path, db => db.exec(`CREATE TRIGGER token_failure BEFORE INSERT ON hub_oauth_refresh_access_tokens
      BEGIN SELECT RAISE(ABORT, 'request-only-marker storage failure'); END`));
    const response = await exchange(r, body);
    expect(response.code).toBe(500);
    expect(response.body).toEqual({ error: "server_error" });
    expect(authority(r.path)).toEqual(before);
    inspect(r.path, db => db.exec("DROP TRIGGER token_failure"));
    expect((await exchange(r, body)).code).toBe(200);
  });
});

it("hides the token route without public URL or browser sign-in and on core hubs", async () => {
  const config = { databasePath: ":memory:", port: 0, authSecret: TEST_SECRET, log: silentLogger };
  const candidates = [
    await createTeamHub({ ...config, github: { clientId: "Iv1.0123456789abcdef" } }),
    await createTeamHub({ ...config, publicUrl: ISSUER }),
    await createHub({ ...config, publicUrl: ISSUER }),
  ];
  hubs.push(...candidates);
  for (const hub of candidates) {
    const response = await http(hub, "/oauth/token", { method: "POST", headers: FORM_HEADERS, text: "grant_type=authorization_code" });
    expect(response.code).toBe(404);
  }
});

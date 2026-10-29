import { createHash } from "node:crypto";
import { request } from "node:http";
import { DatabaseSync } from "node:sqlite";
import { settingsRoom, setWorkspaceName } from "@uberblick/schema";
import { workspaceResourceUrl } from "@uberblick/schema/oauth";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as Y from "yjs";
import { silentLogger } from "../src/log.js";
import { createHub, type Hub } from "../src/server.js";
import { createTeamHub } from "../src/team.js";
import * as metadataFetch from "../src/oauth-metadata-fetch.js";
import { removeTempDatabases, tempDatabasePath, TEST_SECRET, WORKSPACE, OTHER_WORKSPACE } from "./helpers.js";

const ISSUER = "https://hub.example.com";
const CLIENT_ID = "test-mcp-client";
const CLIENT_NAME = "Example MCP Agent";
const REDIRECT = "https://agent.example.com/callback?existing=kept";
const STATE = "original state?&/";
const CHALLENGE = "a".repeat(43);
const TOKEN = "b".repeat(43);
const hubs: Hub[] = [];

afterEach(async () => {
  for (const hub of hubs.splice(0)) await hub.stop();
  removeTempDatabases();
  vi.restoreAllMocks();
});

function inspect<T>(path: string, read: (db: DatabaseSync) => T): T {
  const db = new DatabaseSync(path);
  try { return read(db); } finally { db.close(); }
}

function rows(path: string, table: string) {
  return inspect(path, db => db.prepare(`SELECT * FROM ${table}`).all());
}

function authorityRows(path: string) {
  return {
    grants: rows(path, "hub_agent_grants"),
    codes: rows(path, "hub_oauth_authorization_codes"),
    credentials: rows(path, "hub_credentials"),
  };
}

async function rig(productionClients = false) {
  const path = tempDatabasePath();
  const clock = { time: 1000 };
  const hub = await createTeamHub({ databasePath: path, address: "127.0.0.1", port: 0,
    authSecret: TEST_SECRET, publicUrl: ISSUER, log: silentLogger,
    github: { clientId: "Iv1.0123456789abcdef", now: () => clock.time,
      fetch: async () => { throw new Error("consent must reuse the browser identity"); } } }, productionClients ? {} : {
    oauthClients: async clientId => {
      if (clientId === "refused") throw new Error("client source refused");
      return clientId === CLIENT_ID ? { name: CLIENT_NAME, redirectUriAllowed: uri => uri === REDIRECT } : null;
    },
  });
  hubs.push(hub);
  const principal = hub.principals!.identify("1234", "workspace-member");
  const outsider = hub.principals!.identify("5678", "nonmember");
  hub.memberships!.grant({ workspaceId: WORKSPACE, principalId: principal.id, role: "member" });
  const origin = `http://127.0.0.1:${hub.port}`;
  function session(token: string, principalId: string, sessionOrigin = origin, expiresAt = clock.time + 86_400_000) {
    inspect(path, db => db.prepare(`INSERT INTO hub_browser_sessions (token_hash, principal_id, origin, expires_at)
      VALUES (?, ?, ?, ?)`).run(createHash("sha256").update(token).digest("hex"), principalId, sessionOrigin, expiresAt));
  }
  session(TOKEN, principal.id);
  const settings = new Y.Doc();
  try {
    setWorkspaceName(settings, "Private workspace name");
    inspect(path, db => db.prepare("INSERT INTO documents (name, data) VALUES (?, ?)")
      .run(settingsRoom(WORKSPACE), Y.encodeStateAsUpdate(settings)));
  } finally { settings.destroy(); }
  return { hub, path, clock, origin, principal, outsider, session };
}

type Rig = Awaited<ReturnType<typeof rig>>;

function http(hub: Hub, path: string, options: { method?: string; headers?: Record<string, string>; text?: string } = {}) {
  return new Promise<{ code: number; headers: import("node:http").IncomingHttpHeaders; text: string }>((resolve, reject) => {
    const outgoing = request({ hostname: "127.0.0.1", port: hub.port, path, method: options.method ?? "GET",
      headers: { Connection: "close", ...options.headers } }, response => {
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

function parameters() {
  return new URLSearchParams({ client_id: CLIENT_ID, redirect_uri: REDIRECT, response_type: "code",
    code_challenge: CHALLENGE, code_challenge_method: "S256", resource: workspaceResourceUrl(ISSUER, WORKSPACE), state: STATE });
}

async function authorize(r: Rig, params = parameters(), headers: Record<string, string> = {}) {
  return http(r.hub, `/oauth/authorize?${params}`, { headers });
}

async function pending(r: Rig, scope?: string) {
  const params = parameters();
  if (scope !== undefined) params.set("scope", scope);
  const response = await authorize(r, params, { "X-Forwarded-Host": "attacker.example", "X-Forwarded-Proto": "http" });
  expect(response.code).toBe(302);
  expect(response.headers["cache-control"]).toBe("no-store");
  const location = new URL(response.headers.location!);
  expect(location.origin + location.pathname).toBe(`${ISSUER}/connect`);
  expect([...location.searchParams.keys()]).toEqual(["request"]);
  const requestId = location.searchParams.get("request")!;
  expect(requestId.length).toBeGreaterThan(20);
  return requestId;
}

async function consent(r: Rig, route: "read" | "submit", body: unknown, options: {
  token?: string | null; headers?: Record<string, string | null>; text?: string; method?: string;
} = {}) {
  const headers: Record<string, string> = { "Content-Type": "application/json", Origin: r.origin,
    "Sec-Fetch-Site": "same-origin" };
  if (options.token !== null) headers["X-Uberblick-Session"] = options.token ?? TOKEN;
  for (const [key, value] of Object.entries(options.headers ?? {})) {
    if (value === null) delete headers[key];
    else headers[key] = value;
  }
  const response = await http(r.hub, `/oauth/consent/${route}`, { method: options.method ?? "POST", headers,
    ...(options.method === "GET" ? {} : { text: options.text ?? JSON.stringify(body) }) });
  expect(response.headers["cache-control"]).toBe("no-store");
  expect(response.headers["set-cookie"]).toBeUndefined();
  expect(response.headers["access-control-allow-origin"]).toBeUndefined();
  return { code: response.code, result: JSON.parse(response.text) as Record<string, unknown> };
}

describe("OAuth authorize validation", () => {
  const unsafe: { name: string; change: (params: URLSearchParams) => void }[] = [
    { name: "missing client", change: p => p.delete("client_id") },
    { name: "repeated client", change: p => p.append("client_id", CLIENT_ID) },
    { name: "unknown client", change: p => p.set("client_id", "unknown") },
    { name: "refused client", change: p => p.set("client_id", "refused") },
    { name: "missing redirect", change: p => p.delete("redirect_uri") },
    { name: "repeated redirect", change: p => p.append("redirect_uri", REDIRECT) },
    { name: "unregistered redirect", change: p => p.set("redirect_uri", "https://attacker.example/<script>") },
  ];
  it.each(unsafe)("shows a safe error page for $name without storing or redirecting", async ({ change }) => {
    const r = await rig();
    const params = parameters();
    change(params);
    const response = await authorize(r, params);
    expect(response.code).toBe(400);
    expect(response.headers.location).toBeUndefined();
    expect(response.headers["content-type"]).toMatch(/^text\/html/);
    expect(response.headers["cache-control"]).toBe("no-store");
    expect(response.headers["content-security-policy"]).toContain("default-src 'none'");
    expect(response.headers["x-content-type-options"]).toBe("nosniff");
    expect(response.headers["referrer-policy"]).toBe("no-referrer");
    expect(response.text).not.toContain(CLIENT_ID);
    expect(response.text).not.toContain("attacker.example");
    expect(response.text).not.toContain(STATE);
    expect(rows(r.path, "hub_oauth_pending_authorizations")).toEqual([]);
    expect(authorityRows(r.path)).toEqual({ grants: [], codes: [], credentials: [] });
  });

  const redirected: { name: string; error: string; change: (params: URLSearchParams) => void }[] = [
    { name: "missing response type", error: "unsupported_response_type", change: p => p.delete("response_type") },
    { name: "unsupported response type", error: "unsupported_response_type", change: p => p.set("response_type", "token") },
    { name: "missing PKCE challenge", error: "invalid_request", change: p => p.delete("code_challenge") },
    { name: "missing PKCE method", error: "invalid_request", change: p => p.delete("code_challenge_method") },
    { name: "plain PKCE", error: "invalid_request", change: p => p.set("code_challenge_method", "plain") },
    { name: "lowercase PKCE method", error: "invalid_request", change: p => p.set("code_challenge_method", "s256") },
    { name: "missing resource", error: "invalid_target", change: p => p.delete("resource") },
    { name: "another issuer", error: "invalid_target", change: p => p.set("resource", workspaceResourceUrl("https://other.example", WORKSPACE)) },
    { name: "unknown workspace", error: "invalid_target", change: p => p.set("resource", workspaceResourceUrl(ISSUER, OTHER_WORKSPACE)) },
    { name: "noncanonical resource", error: "invalid_target", change: p => p.set("resource", `${workspaceResourceUrl(ISSUER, WORKSPACE)}/`) },
    { name: "unknown scope", error: "invalid_scope", change: p => p.set("scope", "docs:read admin") },
    { name: "write-only scope", error: "invalid_scope", change: p => p.set("scope", "docs:write") },
    ...["response_type", "code_challenge", "code_challenge_method", "resource", "scope", "state", "extension"].map(name => ({
      name: `repeated ${name}`, error: "invalid_request", change: (p: URLSearchParams) => {
        if (!p.has(name)) p.set(name, name === "scope" ? "docs:read" : "value");
        p.append(name, p.get(name)!);
      },
    })),
  ];
  it.each(redirected)("redirects $name to the validated client with OAuth error and state", async ({ error, change }) => {
    const r = await rig();
    const params = parameters();
    change(params);
    const response = await authorize(r, params);
    expect(response.code).toBe(302);
    const location = new URL(response.headers.location!);
    expect(location.origin + location.pathname).toBe("https://agent.example.com/callback");
    expect(location.searchParams.get("existing")).toBe("kept");
    expect(location.searchParams.get("error")).toBe(error);
    expect(location.searchParams.get("state")).toBe(STATE);
    expect(location.searchParams.has("code")).toBe(false);
    expect(rows(r.path, "hub_oauth_pending_authorizations")).toEqual([]);
  });

  it("defaults to no client sources until one is configured", async () => {
    const hub = await createTeamHub({ databasePath: ":memory:", port: 0, authSecret: TEST_SECRET, publicUrl: ISSUER,
      log: silentLogger, github: { clientId: "Iv1.0123456789abcdef" } });
    hubs.push(hub);
    const response = await http(hub, `/oauth/authorize?${parameters()}`);
    expect(response.code).toBe(400);
    expect(response.headers.location).toBeUndefined();
  });
});

describe("production metadata client lookup", () => {
  const clientId = "https://agent.example/client.json";
  const redirectUri = "http://127.0.0.1:56789/callback";
  function metadata() {
    return { client_id: clientId, client_name: "Document Agent", redirect_uris: ["http://127.0.0.1/callback"],
      token_endpoint_auth_method: "none" };
  }
  function params() {
    const params = parameters();
    params.set("client_id", clientId);
    params.set("redirect_uri", redirectUri);
    return params;
  }

  it("creates only pending consent with the document name and requested callback port", async () => {
    const fetch = vi.spyOn(metadataFetch, "fetchMetadataDocument").mockResolvedValue(metadata());
    const r = await rig(true);
    const response = await authorize(r, params());
    expect(response.code).toBe(302);
    const location = new URL(response.headers.location!);
    expect(location.origin + location.pathname).toBe(`${ISSUER}/connect`);
    const requestId = location.searchParams.get("request")!;
    expect(rows(r.path, "hub_oauth_pending_authorizations")).toMatchObject([
      { client_id: clientId, client_name: "Document Agent", redirect_uri: redirectUri },
    ]);
    expect(await consent(r, "read", { requestId })).toMatchObject({ code: 200,
      result: { status: "pending", clientName: "Document Agent", redirectHost: "127.0.0.1:56789" } });
    expect(authorityRows(r.path)).toEqual({ grants: [], codes: [], credentials: [] });
    await authorize(r, params());
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it.each(["omitted", "private_key_jwt"])('shows fixed unsupported-authentication wording for %s without state or redirect', async method => {
    const value: Record<string, unknown> = metadata();
    if (method === "omitted") delete value.token_endpoint_auth_method;
    else value.token_endpoint_auth_method = method;
    vi.spyOn(metadataFetch, "fetchMetadataDocument").mockResolvedValue(value);
    const r = await rig(true);
    const response = await authorize(r, params());
    expect(response.code).toBe(400);
    expect(response.headers.location).toBeUndefined();
    expect(response.text).toContain("The hub does not support this client's authentication method.");
    expect(response.text).not.toContain(method);
    expect(response.text).not.toContain(clientId);
    expect(response.text).not.toContain("Document Agent");
    expect(rows(r.path, "hub_oauth_pending_authorizations")).toEqual([]);
    expect(authorityRows(r.path)).toEqual({ grants: [], codes: [], credentials: [] });
  });

  it.each(["fetch refused", "id mismatch", "unregistered redirect"])("keeps the generic page for %s without storing or redirecting", async failure => {
    const fetch = vi.spyOn(metadataFetch, "fetchMetadataDocument");
    if (failure === "fetch refused") fetch.mockRejectedValue(new Error("untrusted error text"));
    else fetch.mockResolvedValue({ ...metadata(), ...(failure === "id mismatch" ? { client_id: "other" } : { redirect_uris: [REDIRECT] }) });
    const r = await rig(true);
    const response = await authorize(r, params());
    expect(response.code).toBe(400);
    expect(response.headers.location).toBeUndefined();
    expect(response.text).toContain("Start again from your agent.");
    expect(response.text).not.toContain("untrusted error text");
    expect(rows(r.path, "hub_oauth_pending_authorizations")).toEqual([]);
    expect(authorityRows(r.path)).toEqual({ grants: [], codes: [], credentials: [] });
  });
});

describe("OAuth browser consent", () => {
  it("lets members read without consuming and hides workspace names from non-members", async () => {
    const r = await rig();
    const requestId = await pending(r);
    expect(rows(r.path, "hub_oauth_pending_authorizations")).toHaveLength(1);
    const expected = { code: 200, result: { status: "pending", clientName: CLIENT_NAME,
      redirectHost: "agent.example.com", workspaceId: WORKSPACE, workspaceName: "Private workspace name",
      accessLevels: ["read-only", "read-write"] } };
    expect(await consent(r, "read", { requestId })).toEqual(expected);
    expect(await consent(r, "read", { requestId })).toEqual(expected);
    const outsiderToken = "c".repeat(43);
    r.session(outsiderToken, r.outsider.id);
    expect(await consent(r, "read", { requestId }, { token: outsiderToken })).toEqual({ code: 403, result: { status: "not-a-member" } });
    expect(authorityRows(r.path)).toEqual({ grants: [], codes: [], credentials: [] });
  });

  it.each(["read", "submit"] as const)("guards the %s route before reading or consuming pending state", async route => {
    const r = await rig();
    const requestId = await pending(r);
    const body = route === "read" ? { requestId } : { requestId, decision: "approve", accessLevel: "read-write" };
    for (const options of [
      { headers: { Origin: null } },
      { headers: { Origin: "https://attacker.example" } },
      { headers: { "Sec-Fetch-Site": "cross-site" } },
      { headers: { "Sec-Fetch-Site": "same-site" } },
      { headers: { "Sec-Fetch-Site": "none" } },
      { headers: { "Content-Type": "text/plain" } },
      { headers: { Authorization: "Bearer any-token" } },
      { method: "GET" },
      { text: "invalid json" },
      { text: "[]" },
      { text: JSON.stringify({ ...body, padding: "x".repeat(4096) }) },
    ]) {
      expect(await consent(r, route, body, options)).toEqual({ code: 400, result: { status: "invalid-request" } });
    }
    expect(rows(r.path, "hub_oauth_pending_authorizations")).toHaveLength(1);
    expect(authorityRows(r.path)).toEqual({ grants: [], codes: [], credentials: [] });
    expect(await consent(r, "read", { requestId })).toMatchObject({ code: 200 });
  });

  it.each(["read", "submit"] as const)("requires a live browser session bound to this origin on %s", async route => {
    const r = await rig();
    const requestId = await pending(r);
    const body = route === "read" ? { requestId } : { requestId, decision: "deny" };
    const expiredToken = "d".repeat(43);
    const otherOriginToken = "e".repeat(43);
    r.session(expiredToken, r.principal.id, r.origin, r.clock.time);
    r.session(otherOriginToken, r.principal.id, "https://other.example");
    for (const token of [null, "unknown", expiredToken, otherOriginToken]) {
      expect(await consent(r, route, body, { token })).toEqual({ code: 401, result: { status: "signed-out" } });
    }
    expect(rows(r.path, "hub_oauth_pending_authorizations")).toHaveLength(1);
    expect(authorityRows(r.path)).toEqual({ grants: [], codes: [], credentials: [] });
  });

  it("rejects tampering, invalid access and denial extras without consuming the request", async () => {
    const r = await rig();
    const requestId = await pending(r, "docs:read");
    expect(await consent(r, "read", { requestId })).toMatchObject({ result: { accessLevels: ["read-only"] } });
    for (const body of [
      { requestId, decision: "approve", accessLevel: "read-write" },
      { requestId, decision: "approve", accessLevel: "write-only" },
      { requestId, decision: "approve" },
      { requestId, decision: "approve", accessLevel: "read-only", clientId: "other-client" },
      { requestId, decision: "approve", accessLevel: "read-only", resource: workspaceResourceUrl(ISSUER, OTHER_WORKSPACE) },
      { requestId, decision: "deny", accessLevel: "read-only" },
      { requestId, decision: "unknown" },
    ]) {
      expect(await consent(r, "submit", body)).toEqual({ code: 400, result: { status: "invalid-request" } });
    }
    expect(rows(r.path, "hub_oauth_pending_authorizations")).toHaveLength(1);
    expect(authorityRows(r.path)).toEqual({ grants: [], codes: [], credentials: [] });
    expect(await consent(r, "submit", { requestId, decision: "approve", accessLevel: "read-only" })).toMatchObject({ code: 200 });
  });

  it("rechecks membership at submit and consumes a valid non-member decision", async () => {
    const r = await rig();
    const requestId = await pending(r);
    expect(await consent(r, "read", { requestId })).toMatchObject({ code: 200 });
    inspect(r.path, db => db.prepare("DELETE FROM hub_memberships WHERE workspace_id = ? AND principal_id = ?")
      .run(WORKSPACE, r.principal.id));
    expect(await consent(r, "submit", { requestId, decision: "approve", accessLevel: "read-write" }))
      .toEqual({ code: 403, result: { status: "not-a-member" } });
    expect(authorityRows(r.path)).toEqual({ grants: [], codes: [], credentials: [] });
    r.hub.memberships!.grant({ workspaceId: WORKSPACE, principalId: r.principal.id, role: "member" });
    expect(await consent(r, "submit", { requestId, decision: "approve", accessLevel: "read-write" }))
      .toEqual({ code: 404, result: { status: "unknown-request" } });
  });

  it.each([
    { scope: "docs:read", accessLevel: "read-only", granted: "docs:read" },
    { scope: "docs:read docs:write", accessLevel: "read-only", granted: "docs:read" },
    { scope: "docs:read docs:write", accessLevel: "read-write", granted: "docs:read docs:write" },
    { scope: undefined, accessLevel: "read-only", granted: "docs:read" },
    { scope: undefined, accessLevel: "read-write", granted: "docs:read docs:write" },
  ])("persists only the approved $accessLevel scope for requested $scope", async ({ scope, accessLevel, granted }) => {
    const r = await rig();
    const requestId = await pending(r, scope);
    const response = await consent(r, "submit", { requestId, decision: "approve", accessLevel });
    expect(response).toMatchObject({ code: 200, result: { status: "approved", redirectUrl: expect.any(String) } });
    const redirect = new URL(response.result.redirectUrl as string);
    expect(redirect.origin + redirect.pathname).toBe("https://agent.example.com/callback");
    expect(redirect.searchParams.get("existing")).toBe("kept");
    expect(redirect.searchParams.get("state")).toBe(STATE);
    const code = redirect.searchParams.get("code")!;
    expect(code.length).toBeGreaterThan(20);
    const snapshot = authorityRows(r.path);
    expect(snapshot.credentials).toEqual([]);
    expect(snapshot.grants).toHaveLength(1);
    expect(snapshot.grants[0]).toMatchObject({ client_id: CLIENT_ID, client_name: CLIENT_NAME,
      principal_id: r.principal.id, workspace_id: WORKSPACE, scope: accessLevel });
    expect(snapshot.codes).toHaveLength(1);
    expect(snapshot.codes[0]).toMatchObject({ grant_id: snapshot.grants[0]!.id, client_id: CLIENT_ID,
      redirect_uri: REDIRECT, code_challenge: CHALLENGE, resource: workspaceResourceUrl(ISSUER, WORKSPACE),
      scope: granted, expires_at: r.clock.time + 60_000 });
    expect(JSON.stringify(rows(r.path, "hub_oauth_pending_authorizations"))).not.toContain(code);
    expect(JSON.stringify(snapshot)).not.toContain(code);
    expect(snapshot.codes[0]).toMatchObject({ code_hash: createHash("sha256").update(code).digest("hex") });
    expect(await consent(r, "read", { requestId })).toEqual({ code: 404, result: { status: "unknown-request" } });
    expect(await consent(r, "submit", { requestId, decision: "approve", accessLevel }))
      .toEqual({ code: 404, result: { status: "unknown-request" } });
    expect(authorityRows(r.path)).toEqual(snapshot);
  });

  it("returns denial to the stored redirect with state and creates no authority", async () => {
    const r = await rig();
    const requestId = await pending(r);
    const response = await consent(r, "submit", { requestId, decision: "deny" });
    expect(response).toMatchObject({ code: 200, result: { status: "denied", redirectUrl: expect.any(String) } });
    const redirect = new URL(response.result.redirectUrl as string);
    expect(redirect.origin + redirect.pathname).toBe("https://agent.example.com/callback");
    expect(redirect.searchParams.get("error")).toBe("access_denied");
    expect(redirect.searchParams.get("state")).toBe(STATE);
    expect(redirect.searchParams.has("code")).toBe(false);
    expect(authorityRows(r.path)).toEqual({ grants: [], codes: [], credentials: [] });
    expect(await consent(r, "read", { requestId })).toEqual({ code: 404, result: { status: "unknown-request" } });
  });

  it("lets exactly one simultaneous submit create a grant and code", async () => {
    const r = await rig();
    const requestId = await pending(r);
    const submissions = await Promise.all(Array.from({ length: 8 }, () => consent(r, "submit", {
      requestId, decision: "approve", accessLevel: "read-write",
    })));
    expect(submissions.filter(response => response.code === 200)).toHaveLength(1);
    expect(submissions.filter(response => response.code === 404)).toHaveLength(7);
    expect(authorityRows(r.path)).toMatchObject({ grants: [expect.any(Object)], codes: [expect.any(Object)], credentials: [] });
  });

  it("rolls back consumption and the grant if code insertion fails", async () => {
    const r = await rig();
    const requestId = await pending(r);
    inspect(r.path, db => db.exec(`CREATE TRIGGER code_failure BEFORE INSERT ON hub_oauth_authorization_codes
      BEGIN SELECT RAISE(ABORT, 'injected authorization code failure'); END`));
    expect(await consent(r, "submit", { requestId, decision: "approve", accessLevel: "read-write" }))
      .toEqual({ code: 500, result: { status: "failed" } });
    expect(authorityRows(r.path)).toEqual({ grants: [], codes: [], credentials: [] });
    expect(await consent(r, "read", { requestId })).toMatchObject({ code: 200 });
    inspect(r.path, db => db.exec("DROP TRIGGER code_failure"));
    expect(await consent(r, "submit", { requestId, decision: "approve", accessLevel: "read-write" }))
      .toMatchObject({ code: 200 });
    expect(rows(r.path, "hub_agent_grants")).toHaveLength(1);
    expect(rows(r.path, "hub_oauth_authorization_codes")).toHaveLength(1);
  });

  it("uses the same start-again refusal for unknown and expired requests", async () => {
    const r = await rig();
    const requestId = await pending(r);
    r.clock.time += 5 * 60_000;
    for (const id of [requestId, "unknown-request-id"]) {
      expect(await consent(r, "read", { requestId: id })).toEqual({ code: 404, result: { status: "unknown-request" } });
      expect(await consent(r, "submit", { requestId: id, decision: "deny" }))
        .toEqual({ code: 404, result: { status: "unknown-request" } });
    }
    expect(authorityRows(r.path)).toEqual({ grants: [], codes: [], credentials: [] });
  });
});

it("does not expose OAuth routes without public URL and browser sign-in, or on core hubs", async () => {
  const config = { databasePath: ":memory:", port: 0, authSecret: TEST_SECRET, log: silentLogger };
  const github = { clientId: "Iv1.0123456789abcdef" };
  const candidates = [
    await createTeamHub({ ...config, github }),
    await createTeamHub({ ...config, publicUrl: ISSUER }),
    await createHub({ ...config, publicUrl: ISSUER }),
  ];
  hubs.push(...candidates);
  for (const hub of candidates) {
    for (const path of ["/oauth/authorize", "/oauth/consent/read", "/oauth/consent/submit"]) {
      const response = await http(hub, path);
      expect(response.code).toBe(404);
      expect(response.headers.location).toBeUndefined();
    }
  }
});

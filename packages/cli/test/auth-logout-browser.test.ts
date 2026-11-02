/** A consent approval racing all-device logout must enter its revocation snapshot. */
import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { introspectMcpToken } from "@uberblick/hub/mcp-channel";
import { workspaceResourceUrl } from "@uberblick/schema/oauth";
import { afterAll, afterEach, expect, it } from "vitest";
import { assertPublicOnly, cleanUp, readStore, rig, seedLogin, WORKSPACE } from "./auth-fixtures.js";
import { removeTempDirs, sandbox } from "./helpers.js";
import { runInProcess } from "./in-process.js";

const ISSUER = "https://logout-hub.example";
const CLIENT = "logout-race-client";
const REDIRECT = "https://agent.example/callback";
const VERIFIER = "logout_race_verifier_with-enough-characters_1234567890";
const SESSION = "b".repeat(43);
const SOCKET = "private/mcp.sock";

afterEach(cleanUp);
afterAll(removeTempDirs);

type Remote = Awaited<ReturnType<typeof rig>>;

function inspect<T>(remote: Remote, read: (database: DatabaseSync) => T): T {
  const database = new DatabaseSync(remote.databasePath);
  try { return read(database); } finally { database.close(); }
}

async function pending(remote: Remote): Promise<string> {
  const parameters = new URLSearchParams({ client_id: CLIENT, redirect_uri: REDIRECT, response_type: "code",
    code_challenge: createHash("sha256").update(VERIFIER).digest("base64url"), code_challenge_method: "S256",
    resource: workspaceResourceUrl(ISSUER, WORKSPACE) });
  const response = await fetch(`http://127.0.0.1:${remote.hub.port}/oauth/authorize?${parameters}`, { redirect: "manual" });
  await response.text();
  expect(response.status).toBe(302);
  return new URL(response.headers.get("location")!).searchParams.get("request")!;
}

async function approve(remote: Remote, requestId: string): Promise<string> {
  const response = await fetch(`http://127.0.0.1:${remote.hub.port}/oauth/consent/submit`, {
    method: "POST", headers: { "Content-Type": "application/json", Origin: `http://127.0.0.1:${remote.hub.port}`,
      "Sec-Fetch-Site": "same-origin", "X-Uberblick-Session": SESSION },
    body: JSON.stringify({ requestId, decision: "approve", accessLevel: "read-write" }),
  });
  const body = await response.json() as { status: string; redirectUrl: string };
  expect(response.status).toBe(200);
  expect(body.status).toBe("approved");
  return new URL(body.redirectUrl).searchParams.get("code")!;
}

async function token(remote: Remote, fields: Record<string, string>) {
  const response = await fetch(`http://127.0.0.1:${remote.hub.port}/oauth/token`, {
    method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ client_id: CLIENT, ...fields }).toString(),
  });
  return { status: response.status, body: await response.json() as Record<string, unknown> };
}

function exchange(remote: Remote, code: string) {
  return token(remote, { grant_type: "authorization_code", code, code_verifier: VERIFIER, redirect_uri: REDIRECT });
}

it("revokes existing tokens and a grant approved after logout starts but before browser sign-out", async () => {
  const previousDirectory = process.cwd();
  // Relative socket names retain the real private-channel proof on long scratch paths.
  process.chdir(sandbox().cwd);
  try {
    const remote = await rig([WORKSPACE], true, false, true, undefined, undefined, {
      publicUrl: ISSUER, mcpSocketPath: SOCKET,
      oauthClients: async clientId => clientId === CLIENT
        ? { name: "Logout race agent", redirectUriAllowed: uri => uri === REDIRECT } : null,
    });
    const login = await seedLogin(remote);
    const hubOrigin = `http://127.0.0.1:${remote.hub.port}`;
    inspect(remote, database => database.prepare(`INSERT INTO hub_browser_sessions
      (token_hash, principal_id, origin, expires_at) VALUES (?, ?, ?, ?)`).run(
      createHash("sha256").update(SESSION).digest("hex"), login.identity.id, hubOrigin, Date.now() + 86_400_000));
    const existing = await exchange(remote, await approve(remote, await pending(remote)));
    expect(existing.status).toBe(200);
    expect(await introspectMcpToken(SOCKET, existing.body.access_token as string)).toMatchObject({
      status: "positive", principal: login.identity.id, workspace: WORKSPACE, scope: "docs:read docs:write",
    });
    const racingRequest = await pending(remote);
    let racingCode: string | undefined;
    const interleaving: string[] = [];
    remote.controls.onManagement = async body => {
      if (body.operation !== "revoke-browser-sessions" || racingCode !== undefined) return;
      expect(remote.requests.length).toBeGreaterThan(0);
      racingCode = await approve(remote, racingRequest);
      interleaving.push("approved");
    };
    remote.controls.transform = (path, status, result, body) => {
      if (path === "/auth/manage" && body.operation === "revoke-browser-sessions") {
        expect(inspect(remote, database => database.prepare("SELECT COUNT(*) AS count FROM hub_browser_sessions").get()?.count)).toBe(0);
        interleaving.push("signed-out");
      }
      return { status, result };
    };

    const run = await runInProcess(["auth", "logout", "--all-devices", remote.origin], remote.box);
    expect(run.status, run.stderr).toBe(0);
    expect(interleaving).toEqual(["approved", "signed-out"]);
    expect(racingCode).toBeDefined();
    expect(readStore(remote.box).hubLogins?.[remote.origin]).toBeUndefined();
    const grants = inspect(remote, database => database.prepare("SELECT device_id, revoked_at FROM hub_agent_grants").all());
    expect(grants).toHaveLength(2);
    expect(grants.every(grant => grant.revoked_at !== null)).toBe(true);
    const actions = remote.requests.map(request => request.body);
    const signedOut = actions.findIndex(action => action.operation === "revoke-browser-sessions");
    const snapshot = actions.findLastIndex(action => action.operation === "list-devices");
    expect(snapshot).toBeGreaterThan(signedOut);
    expect(actions.filter(action => action.operation === "revoke-device").slice(0, -1).map(action => action.deviceId).sort())
      .toEqual(grants.map(grant => grant.device_id).sort());
    expect(actions.at(-1)).toMatchObject({ operation: "revoke-device", deviceId: login.credential.record.deviceId });
    expect(await introspectMcpToken(SOCKET, existing.body.access_token as string)).toEqual({ status: "negative" });
    expect(await token(remote, { grant_type: "refresh_token", refresh_token: existing.body.refresh_token as string }))
      .toEqual({ status: 400, body: { error: "invalid_grant" } });

    // Redemption can still return a token, whose revoked grant cannot reach the workspace.
    const raced = await exchange(remote, racingCode!);
    expect(raced.status).toBe(200);
    expect(await introspectMcpToken(SOCKET, raced.body.access_token as string)).toEqual({ status: "negative" });
    expect(await token(remote, { grant_type: "refresh_token", refresh_token: raced.body.refresh_token as string }))
      .toEqual({ status: 400, body: { error: "invalid_grant" } });
    assertPublicOnly(run, remote, login.credential.key);
  } finally {
    try { await cleanUp(); } finally { process.chdir(previousDirectory); }
  }
});

/** The local browser's access authority is bounded to its frozen binding. */
import { readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { request as httpRequest } from "node:http";
import { join } from "node:path";
import { createHub, silentLogger, type Hub } from "@uberblick/hub";
import { writeHubLogin, type StoredHubLogin } from "@uberblick/hub/auth-store";
import { afterEach, describe, expect, it, vi } from "vitest";
import { localBrowserKey } from "../src/browser-key.js";
import { pointAt } from "./helpers.js";
import { authMessage, bearer, cleanUp, configured, configDir, freePort, get, hubs, open, startHub,
  WORKSPACE, REBOUND_WORKSPACE, SECRET, writeBinding } from "./open-fixtures.js";

afterEach(async () => { vi.restoreAllMocks(); await cleanUp(); });

function issue(hub: Hub, id: string, username: string, role?: "admin" | "member", workspaces?: string[]) {
  const identity = hub.principals!.identify(id, username);
  if (role !== undefined) hub.memberships!.grant({ workspaceId: WORKSPACE, principalId: identity.id, role });
  const issued = hub.credentials!.issue({ principalId: identity.id, deviceId: crypto.randomUUID(),
    workspaces: workspaces ?? (role === undefined ? [] : [WORKSPACE]) });
  const { replacedAt: _replaced, ...record } = issued.record;
  const login: StoredHubLogin = { identity, credential: { record, key: Buffer.from(issued.keyBytes).toString("base64url") } };
  return login;
}

async function rig(role: "admin" | "member" | null = "admin", snapshot?: string[]) {
  const { box, env } = configured();
  const github = vi.fn<typeof fetch>(async input => {
    const path = new URL(String(input)).pathname;
    if (path === "/users/missing") return Response.json({}, { status: 404 });
    if (path === "/users/rate-limited" || path === "/user/9009") return Response.json({}, { status: 429 });
    if (path === "/users/CONFIRMED-person" || path === "/user/9876") {
      return Response.json({ id: 9876, login: "confirmed-person", type: "User" });
    }
    throw new Error("unexpected GitHub lookup");
  });
  const hub = await createHub({ port: 0, address: "127.0.0.1",
    databasePath: join(box.cwd, "access-hub.sqlite"), github: { clientId: "Iv1.0123456789abcdef", fetch: github }, log: silentLogger }, { deviceCredentials: true });
  hubs.push(hub);
  const origin = `http://127.0.0.1:${hub.port}`;
  pointAt(box, `ws://127.0.0.1:${hub.port}/proxy/ws`);
  const other = issue(hub, "6789", "other-admin", "admin");
  const login = issue(hub, "1234", "this-person", role ?? undefined, snapshot);
  await writeHubLogin(origin, login, box.env);
  const app = await open(box, ["--port", String(await freePort())], env);
  const auth = await authMessage(localBrowserKey(WORKSPACE, box.env));
  const headers = { ...bearer(auth), "content-type": "application/json", origin: new URL(app.url).origin };
  const post = async (action: object) => {
    const response = await fetch(`${app.url}api/access`, { method: "POST", headers, body: JSON.stringify(action) });
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("access-control-allow-origin")).toBeNull();
    return { code: response.status, body: await response.json() as Record<string, unknown> };
  };
  return { box, env, hub, login, other, github, origin, app, headers, post };
}

describe("ub open: live Access bridge", () => {
  it("distinguishes an explicitly local workspace, a shared-secret hub and an unreachable hub", async () => {
    const { box, env } = configured();
    const app = await open(box, ["--port", String(await freePort())], env);
    try {
      const local = await fetch(`${app.url}api/access`, { method: "POST", headers: {
        ...bearer(await authMessage(localBrowserKey(WORKSPACE, box.env))),
        origin: new URL(app.url).origin, "content-type": "application/json",
      }, body: JSON.stringify({ operation: "own-role", workspaceId: WORKSPACE }) });
      expect(await local.json()).toEqual({ status: "local-only", hub: null });
    } finally { expect((await app.interrupt()).status).toBe(0); }

    const remote = configured();
    const hub = await startHub(remote.box);
    const origin = `http://127.0.0.1:${hub.port}`;
    pointAt(remote.box, `ws://127.0.0.1:${hub.port}`);
    const shared = await open(remote.box, ["--port", String(await freePort())], remote.env);
    try {
      const headers = { ...bearer(await authMessage(localBrowserKey(WORKSPACE, remote.box.env))),
        origin: new URL(shared.url).origin, "content-type": "application/json" };
      const read = async () => await (await fetch(`${shared.url}api/access`, { method: "POST", headers,
        body: JSON.stringify({ operation: "list-devices" }) })).json();
      expect(await read()).toEqual({ status: "not-configured", hub: origin });
      await hub.stop();
      expect(await read()).toEqual({ status: "hub-down", hub: origin });
    } finally { expect((await shared.interrupt()).status).toBe(0); }
  });

  it("refuses unauthorized host, origin, URL tokens, other workspaces and broader operations before contacting the hub", async () => {
    const { app, hub, box, headers, post } = await rig();
    const verify = vi.spyOn(hub.credentials!, "verifyRequest");
    const action = { operation: "remove-member", workspaceId: WORKSPACE, principalId: hub.principals!.getByGithubAccountId("6789")!.id };
    try {
      for (const sample of [
        { headers: { ...headers, authorization: "" }, status: 401 },
        { headers: { ...headers, authorization: `Bearer ${await authMessage(SECRET)}` }, status: 401 },
        { headers: { ...headers, origin: "http://attacker.example" }, status: 403 },
        { headers: { ...headers, origin: "null" }, status: 403 },
        { headers: Object.fromEntries(Object.entries(headers).filter(([name]) => name !== "origin")), status: 403 },
        { headers, suffix: "?token=private", status: 401 },
        { headers, suffix: "?access_token=private", status: 401 },
        { headers, suffix: "?auth=private", status: 401 },
        { headers, suffix: "?authToken=private", status: 401 },
        { headers, body: { ...action, workspaceId: REBOUND_WORKSPACE }, status: 403 },
        { headers, body: { operation: "promote-workspace", workspaceId: WORKSPACE, attemptId: crypto.randomUUID() }, status: 400 },
        { headers, body: { operation: "renew-credential" }, status: 400 },
        { headers, body: { ...action, hubUrl: "https://another-hub.example" }, status: 400 },
        { headers, body: { ...action, token: "private" }, status: 400 },
        { headers, raw: "{", status: 400 },
        { headers, raw: " ".repeat(4097), status: 400 },
      ]) {
        const response = await fetch(`${app.url}api/access${sample.suffix ?? ""}`, {
          method: "POST", headers: sample.headers,
          body: sample.raw ?? JSON.stringify(sample.body ?? action),
        });
        expect(response.status).toBe(sample.status);
        expect(response.headers.get("cache-control")).toBe("no-store");
        await response.text();
      }
      const wrongHost = await new Promise<number>((resolve, reject) => {
        const request = httpRequest(`${app.url}api/access`, { method: "POST", headers: { ...headers, host: "attacker.example" } }, response => {
          response.resume(); response.on("end", () => resolve(response.statusCode!));
        });
        request.on("error", reject); request.end(JSON.stringify(action));
      });
      expect(wrongHost).toBe(421);
      expect(verify).not.toHaveBeenCalled();
      expect(hub.memberships!.roleFor(WORKSPACE, action.principalId)).toBe("admin");
      expect((await post({ operation: "own-role", workspaceId: WORKSPACE })).body.role).toBe("admin");
      expect(verify).toHaveBeenCalledOnce();
      expect(readFileSync(join(box.cwd, ".uberblick.json"), "utf8")).toContain("proxy/ws");
      const get = await fetch(`${app.url}api/access`, { headers });
      expect(get.status).toBe(405);
      expect(get.headers.get("allow")).toBe("POST");
    } finally { expect((await app.interrupt()).status).toBe(0); }
  });

  it("resolves without granting, grants the confirmed ID, reads live roles and preserves existing roles", async () => {
    const { app, post, hub, login, github, origin } = await rig();
    try {
      expect(await post({ operation: "resolve-account", workspaceId: WORKSPACE, githubUsername: "CONFIRMED-person" }))
        .toEqual({ code: 200, body: { status: "ok", githubUsername: "confirmed-person", githubAccountId: "9876", hub: origin } });
      expect(hub.principals!.getByGithubAccountId("9876")).toBeNull();
      const added = await post({ operation: "grant-member", workspaceId: WORKSPACE, githubAccountId: "9876" });
      expect(added.body).toMatchObject({ status: "ok", member: { githubUsername: "confirmed-person", githubAccountId: "9876", role: "member" } });
      expect(github.mock.calls.map(([input]) => String(input))).toEqual(["https://api.github.com/users/CONFIRMED-person", "https://api.github.com/user/9876"]);
      const rows = (await post({ operation: "list-members", workspaceId: WORKSPACE })).body.members as { principalId: string; githubAccountId: string; role: string }[];
      const target = rows.find(row => row.githubAccountId === "9876")!;
      expect(target.role).toBe("member");
      expect((await post({ operation: "change-role", workspaceId: WORKSPACE, principalId: target.principalId, role: "admin" })).body.status).toBe("ok");
      const repeat = await post({ operation: "grant-member", workspaceId: WORKSPACE, githubAccountId: "9876", role: "member" });
      expect(repeat.body).toMatchObject({ status: "already-member", member: { role: "admin" } });
      const members = (await post({ operation: "list-members", workspaceId: WORKSPACE })).body.members as object[];
      expect(members).toEqual(expect.arrayContaining([expect.objectContaining({ principalId: target.principalId, role: "admin" })]));
      expect((await post({ operation: "remove-member", workspaceId: WORKSPACE, principalId: target.principalId })).body.status).toBe("ok");
      expect(hub.memberships!.roleFor(WORKSPACE, target.principalId)).toBeNull();
      for (const [username, state] of [["missing", "account-not-found"], ["rate-limited", "lookup-unavailable"]]) {
        expect((await post({ operation: "resolve-account", workspaceId: WORKSPACE, githubUsername: username })).body.status).toBe(state);
      }
      expect((await post({ operation: "grant-member", workspaceId: WORKSPACE, githubAccountId: "9009" })).body.status).toBe("lookup-unavailable");
      expect(hub.principals!.getByGithubAccountId("9009")).toBeNull();
      const visible = JSON.stringify({ added, repeat, members, config: await (await get(`${app.url}uberblick-config.json`)).json(), stdout: app.stdout(), stderr: app.stderr() });
      expect(visible).not.toContain(login.credential.key);
      expect(visible).not.toContain('"token"');
      expect(visible).not.toContain(SECRET);
    } finally { expect((await app.interrupt()).status).toBe(0); }
  });

  it("enforces current roles and last-admin rules and exposes only the account's own devices", async () => {
    const { app, post, hub, login, other, origin } = await rig("member");
    const second = issue(hub, "1234", "this-person", undefined);
    try {
      expect((await post({ operation: "own-role", workspaceId: WORKSPACE })).body).toEqual({ status: "ok", role: "member", hub: origin });
      expect((await post({ operation: "list-members", workspaceId: WORKSPACE })).body.status).toBe("forbidden");
      const devices = (await post({ operation: "list-devices" })).body.devices as { deviceId: string; current: boolean; signedInAt: number }[];
      expect(devices).toHaveLength(2);
      expect(devices.map(row => row.deviceId)).toEqual(expect.arrayContaining([login.credential.record.deviceId, second.credential.record.deviceId]));
      expect(devices.find(row => row.deviceId === login.credential.record.deviceId)).toEqual({ deviceId: login.credential.record.deviceId, current: true, signedInAt: login.credential.record.issuedAt });
      expect((await post({ operation: "revoke-device", deviceId: other.credential.record.deviceId })).body.status).toBe("device-not-found");
      expect((await post({ operation: "revoke-device", deviceId: second.credential.record.deviceId })).body.status).toBe("ok");
      hub.memberships!.changeRole({ workspaceId: WORKSPACE, actorPrincipalId: other.identity.id, principalId: login.identity.id, role: "admin" });
      hub.memberships!.remove({ workspaceId: WORKSPACE, actorPrincipalId: login.identity.id, principalId: other.identity.id });
      expect((await post({ operation: "own-role", workspaceId: WORKSPACE })).body.role).toBe("admin");
      expect((await post({ operation: "change-role", workspaceId: WORKSPACE, principalId: login.identity.id, role: "member" })).body.status).toBe("last-admin");
      expect((await post({ operation: "remove-member", workspaceId: WORKSPACE, principalId: login.identity.id })).body.status).toBe("last-admin");
      expect(hub.memberships!.roleFor(WORKSPACE, login.identity.id)).toBe("admin");
    } finally { expect((await app.interrupt()).status).toBe(0); }
  });

  it("keeps own-device access after self-removal and preserves applied closure failure and this-device revocation", async () => {
    const { app, post, hub, login } = await rig();
    const closure = hub.memberships!.onRemove(() => { throw new Error("closure contains private material"); });
    try {
      expect((await post({ operation: "remove-member", workspaceId: WORKSPACE, principalId: login.identity.id })).body)
        .toMatchObject({ status: "closure-failed", applied: true });
      expect((await post({ operation: "own-role", workspaceId: WORKSPACE })).body.status).toBe("forbidden");
      expect((await post({ operation: "list-devices" })).body.status).toBe("ok");
      expect((await post({ operation: "revoke-device", deviceId: login.credential.record.deviceId })).body.status).toBe("ok");
      expect((await post({ operation: "list-devices" })).body.status).toBe("sign-in-required");
      expect(app.stderr()).not.toContain("private material");
    } finally { closure(); expect((await app.interrupt()).status).toBe(0); }
  });

  it("keeps account-scoped own-device operations available with an empty workspace credential", async () => {
    const { app, post, login, box, hub } = await rig(null, []);
    try {
      // A renewal cooldown is credential coordination, never Access state.
      // Its failure must not replace a new live management answer.
      const sidecar = readdirSync(configDir(box)).find(name => name.startsWith(".credential-renewal-") && name.endsWith(".json"));
      expect(sidecar).toBeDefined();
      const path = join(configDir(box), sidecar!);
      const outcome = JSON.parse(readFileSync(path, "utf8"));
      writeFileSync(path, JSON.stringify({ ...outcome, status: "hub-down", retryAt: Date.now() + 60_000 }));
      const verify = vi.spyOn(hub.credentials!, "verifyRequest");
      expect((await post({ operation: "own-role", workspaceId: WORKSPACE })).body.status).toBe("forbidden");
      expect(verify).toHaveBeenCalledOnce();
      expect((await post({ operation: "list-devices" })).body).toMatchObject({ status: "ok", devices: [
        { deviceId: login.credential.record.deviceId, current: true },
      ] });
      expect((await post({ operation: "revoke-device", deviceId: login.credential.record.deviceId })).body.status).toBe("ok");
    } finally { expect((await app.interrupt()).status).toBe(0); }
  });

  it("refuses chunked oversized and stalled JSON bodies without upstream authority", async () => {
    const { app, headers, hub } = await rig();
    const verify = vi.spyOn(hub.credentials!, "verifyRequest");
    const send = (stall: boolean) => new Promise<{ status: number; body: string }>((resolve, reject) => {
      const request = httpRequest(`${app.url}api/access`, { method: "POST", headers }, response => {
        const chunks: Buffer[] = [];
        response.on("data", (chunk: Buffer) => chunks.push(chunk));
        response.on("end", () => resolve({ status: response.statusCode!, body: Buffer.concat(chunks).toString("utf8") }));
      });
      request.on("error", reject);
      request.write(stall ? "{" : " ".repeat(4097));
      // Send neither an end nor a fixed Content-Length: input must be bounded
      // independently of a browser finishing its request.
    });
    try {
      expect(await send(false)).toEqual({ status: 400, body: '{"status":"invalid-request"}\n' });
      expect(await send(true)).toEqual({ status: 400, body: '{"status":"invalid-request"}\n' });
      expect(verify).not.toHaveBeenCalled();
    } finally { expect((await app.interrupt()).status).toBe(0); }
  });

  it("uses the frozen hub after rebind and diagnoses later missing sign-in live", async () => {
    const { app, post, box, origin, other, hub } = await rig();
    try {
      writeBinding(box, "wss://another-hub.example/ws", REBOUND_WORKSPACE);
      expect((await post({ operation: "own-role", workspaceId: WORKSPACE })).body).toEqual({ status: "ok", role: "admin", hub: origin });
      expect(hub.memberships!.roleFor(WORKSPACE, other.identity.id)).toBe("admin");
      rmSync(join(configDir(box), "credentials.json"));
      expect((await post({ operation: "list-devices" })).body).toEqual({ status: "sign-in-required", hub: origin });
    } finally { expect((await app.interrupt()).status).toBe(0); }
  });
});

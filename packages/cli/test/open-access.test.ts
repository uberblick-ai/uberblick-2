/** The local browser's access authority is bounded to its frozen binding. */
import { existsSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { request as httpRequest } from "node:http";
import { join } from "node:path";
import { silentLogger } from "@uberblick/hub";
import { createTeamHub as createHub, type TeamHub as Hub } from "@uberblick/hub/team";
import { removeHubLogin, writeHubLogin, type StoredHubLogin } from "@uberblick/mcp-server/auth-store";
import { build } from "esbuild";
import { afterEach, describe, expect, it, vi } from "vitest";
import { localBrowserKey } from "../src/browser-key.js";
import { requestAccess } from "../src/open-access.js";
import { PACKAGE_ROOT, REPO_ROOT, pointAt, waitUntil } from "./helpers.js";
import { authMessage, bearer, cleanUp, configured, configDir, freePort, get, hubs, open, startHub,
  WORKSPACE, REBOUND_WORKSPACE, SECRET, silentListener, writeBinding } from "./open-fixtures.js";

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

function storedLogin(handle: string): StoredHubLogin {
  const principalId = crypto.randomUUID();
  return { identity: { id: principalId, githubAccountId: "1234", githubUsername: handle }, credential: {
    key: Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("base64url"),
    record: { id: crypto.randomUUID(), principalId, deviceId: crypto.randomUUID(), workspaces: [WORKSPACE],
      issuedAt: Date.now(), revokedAt: null },
  } };
}

describe("ub open: Devices identity projection", () => {
  const origin = "https://devices-hub.example";

  it.each([false, true])("sends no credential or empty proof to an unencrypted remote hub (stored login=%s)", async stored => {
    const { box } = configured();
    const endpoint = "ws://devices-hub.example:1234/proxy/ws";
    const origin = "http://devices-hub.example:1234";
    if (stored) await writeHubLogin(origin, storedLogin("account-person"), box.env);
    const fetch = vi.spyOn(globalThis, "fetch").mockResolvedValue(Response.json({ status: "ok", role: "admin" }));
    const binding = { workspaceId: WORKSPACE, hubUrl: endpoint, env: { ...box.env, UB_INSECURE_HUBS: "another-hub:1234" } };
    expect(await requestAccess(binding, { operation: "own-role", workspaceId: WORKSPACE }, new AbortController().signal))
      .toEqual({ status: 503, body: { status: "hub-down", hub: origin } });
    expect(fetch).not.toHaveBeenCalled();
    binding.env.UB_INSECURE_HUBS = "devices-hub.example:1234";
    expect((await requestAccess(binding, { operation: "own-role", workspaceId: WORKSPACE }, new AbortController().signal)).status).toBe(200);
    expect(fetch).toHaveBeenCalledOnce();
  });

  it("uses the login that answers after credential recovery replaces the first login", async () => {
    const { box } = configured();
    const original = storedLogin("original-person");
    const replacement = storedLogin("replacement-person");
    await writeHubLogin(origin, original, box.env);
    const device = { deviceId: replacement.credential.record.deviceId, signedInAt: replacement.credential.record.issuedAt, current: true };
    const fetch = vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(Response.json({ status: "sign-in-required" }, { status: 401 }))
      .mockImplementationOnce(async () => {
        await writeHubLogin(origin, replacement, box.env);
        return Response.json({ status: "already-replaced" }, { status: 401 });
      })
      .mockResolvedValueOnce(Response.json({ status: "ok", devices: [device], handle: "upstream-person",
        identity: original.identity, credential: original.credential, token: "private-token" }));
    const answer = await requestAccess({ workspaceId: WORKSPACE, hubUrl: `${origin}/proxy/ws`, env: box.env },
      { operation: "list-devices" }, new AbortController().signal);
    expect(answer).toEqual({ status: 200, body: { status: "ok", hub: origin, handle: "replacement-person", devices: [device] } });
    expect(fetch.mock.calls.map(([url]) => String(url))).toEqual([
      `${origin}/auth/manage`, `${origin}/auth/credential/renew`, `${origin}/auth/manage`,
    ]);
    expect(JSON.stringify(answer)).not.toContain(original.credential.key);
    expect(JSON.stringify(answer)).not.toContain(replacement.credential.key);
  });

  it("exposes no identity for failed or malformed device answers", async () => {
    const { box } = configured();
    const login = storedLogin("account-person");
    await writeHubLogin(origin, login, box.env);
    const binding = { workspaceId: WORKSPACE, hubUrl: `${origin}/proxy/ws`, env: box.env };
    const fetch = vi.spyOn(globalThis, "fetch");
    for (const [status, body, expected] of [
      [403, { status: "forbidden", handle: "upstream-person", credential: login.credential }, "forbidden"],
      [503, { status: "not-configured", handle: "upstream-person" }, "not-configured"],
      [200, { status: "ok", devices: [], handle: "upstream-person" }, "hub-down"],
    ] as const) {
      fetch.mockResolvedValueOnce(Response.json(body, { status }));
      expect((await requestAccess(binding, { operation: "list-devices" }, new AbortController().signal)).body)
        .toEqual({ status: expected, hub: origin });
    }
  });
});

describe("ub open: live Access bridge", () => {
  it("protects the stored-login read and keeps it independent of membership, hub availability and replica preparation", async () => {
    const { app, box, hub, login, headers, origin } = await rig(null, []);
    const read = async () => {
      const response = await fetch(`${app.url}api/device-login`, { headers });
      expect(response.headers.get("cache-control")).toBe("no-store");
      expect(response.headers.get("access-control-allow-origin")).toBeNull();
      return await response.json();
    };
    try {
      const verify = vi.spyOn(hub.credentials!, "verifyRequest");
      expect(await read()).toEqual({ state: "signed-in", handle: "this-person", accountId: login.identity.githubAccountId });
      expect(verify).not.toHaveBeenCalled();
      expect(JSON.stringify(await read())).not.toContain(login.credential.key);
      for (const sample of [
        { headers: { authorization: "" } },
        { headers: bearer(await authMessage(SECRET)) },
        { headers, suffix: "?token=private" },
        { headers, suffix: `?workspace=${REBOUND_WORKSPACE}` },
      ]) {
        const response = await fetch(`${app.url}api/device-login${sample.suffix ?? ""}`, { headers: sample.headers });
        expect(response.status).toBe(401);
        await response.text();
      }
      const mutation = await fetch(`${app.url}api/device-login`, { method: "POST", headers });
      expect(mutation.status).toBe(405);
      expect(mutation.headers.get("allow")).toBe("GET");
      await mutation.text();
      await hub.stop();
      expect(await read()).toEqual({ state: "signed-in", handle: "this-person", accountId: login.identity.githubAccountId });
      await removeHubLogin(origin, box.env);
      expect(await read()).toEqual({ state: "signed-out" });
      await writeHubLogin(origin, login, box.env);
      writeBinding(box, "wss://another-hub.example/ws", REBOUND_WORKSPACE);
      expect(await read()).toEqual({ state: "unavailable" });
    } finally { expect((await app.interrupt()).status).toBe(0); }
  });

  it("uses current hub authority independently of workspace membership and credential scope", async () => {
    const { app, post, hub, login, other, origin } = await rig(null, []);
    hub.hubAdmins!.grant(login.identity.id);
    hub.hubAdmins!.grant(other.identity.id);
    try {
      expect((await post({ operation: "own-role", workspaceId: WORKSPACE })).body.status).toBe("forbidden");
      expect(await post({ operation: "own-hub-role" })).toEqual({ code: 200,
        body: { status: "ok", role: "admin", hub: origin } });
      expect((await post({ operation: "list-hub-admins" })).body).toMatchObject({ status: "ok", admins: [
        { principalId: other.identity.id, current: false, workspaces: 1 },
        { principalId: login.identity.id, current: true, workspaces: 0 },
      ] });
      expect((await post({ operation: "list-hub-workspaces" })).body).toMatchObject({ status: "ok", workspaces:
        expect.arrayContaining([{ workspaceId: WORKSPACE, status: "active", members: 1, admins: ["other-admin"] }]) });
      expect((await post({ operation: "remove-hub-admin", principalId: login.identity.id })).body.status).toBe("self-admin");
      hub.hubAdmins!.remove(other.identity.id, login.identity.id);
      for (const action of [{ operation: "own-hub-role" }, { operation: "list-hub-admins" },
        { operation: "list-hub-workspaces" }, { operation: "remove-hub-admin", principalId: other.identity.id }]) {
        expect((await post(action)).body).toEqual({ status: "forbidden", hub: origin });
      }
      expect((await post({ operation: "list-devices" })).body.status).toBe("ok");
      expect(hub.memberships!.roleFor(WORKSPACE, other.identity.id)).toBe("admin");
    } finally { expect((await app.interrupt()).status).toBe(0); }
  });

  it("suspends another workspace and restores its own suspended workspace through only the bound hub", async () => {
    const { app, post, hub, login, other, origin, box } = await rig(null, []);
    hub.hubAdmins!.grant(login.identity.id);
    hub.memberships!.grant({ workspaceId: REBOUND_WORKSPACE, principalId: other.identity.id, role: "admin" });
    const verify = vi.spyOn(hub.credentials!, "verifyRequest");
    const renew = vi.spyOn(hub.credentials!, "renew");
    try {
      expect(await post({ operation: "suspend-workspace", workspaceId: REBOUND_WORKSPACE })).toEqual({ code: 200,
        body: { status: "ok", workspaceId: REBOUND_WORKSPACE, workspaceStatus: "suspended", hub: origin } });
      expect(hub.hubAdmins!.isSuspended(REBOUND_WORKSPACE)).toBe(true);
      verify.mockClear();
      expect((await post({ operation: "list-members", workspaceId: REBOUND_WORKSPACE })).body.status).toBe("workspace-mismatch");
      expect(verify).not.toHaveBeenCalled();
      expect((await post({ operation: "restore-workspace", workspaceId: REBOUND_WORKSPACE })).body.workspaceStatus).toBe("active");
      expect((await post({ operation: "suspend-workspace", workspaceId: WORKSPACE })).body.workspaceStatus).toBe("suspended");
      expect((await post({ operation: "own-hub-role" })).body.role).toBe("admin");
      writeBinding(box, "wss://another-hub.example/ws", REBOUND_WORKSPACE);
      expect(await post({ operation: "restore-workspace", workspaceId: WORKSPACE })).toEqual({ code: 200,
        body: { status: "ok", workspaceId: WORKSPACE, workspaceStatus: "active", hub: origin } });
      expect(renew).not.toHaveBeenCalled();
      expect(hub.credentials!.get(login.credential.record.id)?.revokedAt).toBeNull();
    } finally { expect((await app.interrupt()).status).toBe(0); }
  });

  it("refuses workspace administrators and accounts after hub administration is removed without renewing account authority", async () => {
    const { app, post, hub, login, other, origin } = await rig();
    const renew = vi.spyOn(hub.credentials!, "renew");
    try {
      for (const operation of ["suspend-workspace", "restore-workspace"]) {
        expect(await post({ operation, workspaceId: WORKSPACE })).toEqual({ code: 403, body: { status: "forbidden", hub: origin } });
      }
      hub.hubAdmins!.grant(login.identity.id);
      hub.hubAdmins!.grant(other.identity.id);
      expect((await post({ operation: "suspend-workspace", workspaceId: WORKSPACE })).body.workspaceStatus).toBe("suspended");
      hub.hubAdmins!.remove(other.identity.id, login.identity.id);
      expect(await post({ operation: "restore-workspace", workspaceId: WORKSPACE })).toEqual({ code: 403,
        body: { status: "forbidden", hub: origin } });
      expect(hub.hubAdmins!.isSuspended(WORKSPACE)).toBe(true);
      expect(renew).not.toHaveBeenCalled();
    } finally { expect((await app.interrupt()).status).toBe(0); }
  });

  it("never borrows another hub's login or accepts workspace targets for hub operations", async () => {
    const { app, post, hub, login, box, origin } = await rig();
    try {
      expect((await post({ operation: "own-hub-role" })).body).toEqual({ status: "forbidden", hub: origin });
      const verify = vi.spyOn(hub.credentials!, "verifyRequest");
      expect((await post({ operation: "own-hub-role", workspaceId: WORKSPACE })).body.status).toBe("invalid-request");
      expect(verify).not.toHaveBeenCalled();
      await writeHubLogin("https://another-hub.example", login, box.env);
      await removeHubLogin(origin, box.env);
      expect((await post({ operation: "own-hub-role" })).body).toEqual({ status: "sign-in-required", hub: origin });
    } finally { expect((await app.interrupt()).status).toBe(0); }
  });

  it("relays own device names beside legacy rows with no new upstream fields", async () => {
    const { app, post, hub, login, other, origin } = await rig("member");
    const named = hub.credentials!.issue({ principalId: login.identity.id, deviceId: crypto.randomUUID(),
      deviceName: "agent-server", workspaces: [] });
    hub.credentials!.issue({ principalId: other.identity.id, deviceId: crypto.randomUUID(),
      deviceName: "foreign-server", workspaces: [WORKSPACE] });
    try {
      expect(await post({ operation: "list-devices" })).toEqual({ code: 200, body: { status: "ok", hub: origin, handle: "this-person",
        devices: expect.arrayContaining([
          { deviceId: login.credential.record.deviceId, signedInAt: login.credential.record.issuedAt, current: true },
          { deviceId: named.record.deviceId, signedInAt: named.record.issuedAt, current: false, deviceName: "agent-server" },
        ]),
      } });
      const listed = (await post({ operation: "list-devices" })).body;
      expect(listed.devices).toHaveLength(2);
      expect(JSON.stringify(listed)).not.toContain("foreign-server");
      expect(JSON.stringify(listed)).not.toContain(login.credential.key);
      expect((await post({ operation: "revoke-device", deviceId: named.record.deviceId })).body.status).toBe("ok");
      expect((await post({ operation: "list-devices" })).body.devices).toEqual([
        { deviceId: login.credential.record.deviceId, signedInAt: login.credential.record.issuedAt, current: true },
      ]);
    } finally { expect((await app.interrupt()).status).toBe(0); }
  });

  it("authenticates account reads and exposes only the served hub's verified handle after a rebind", async () => {
    const { app, box, login, headers } = await rig();
    try {
      await writeHubLogin("https://another-hub.example", { ...login, identity: { ...login.identity, githubUsername: "other-person" } }, box.env);
      const account = async () => {
        const response = await fetch(`${app.url}api/account`, { headers });
        expect(response.headers.get("cache-control")).toBe("no-store");
        expect(response.headers.get("access-control-allow-origin")).toBeNull();
        return await response.json() as Record<string, unknown>;
      };
      await waitUntil("verified served account", async () => (await account()).state === "signed-in");
      expect(await account()).toEqual({ state: "signed-in", handle: "this-person" });
      writeBinding(box, "wss://another-hub.example/ws", REBOUND_WORKSPACE);
      expect(await account()).toEqual({ state: "signed-in", handle: "this-person" });
      for (const request of [
        { headers: { authorization: "" } },
        { headers: bearer(await authMessage(SECRET)) },
        { headers, suffix: "?token=private" },
      ]) {
        const response = await fetch(`${app.url}api/account${request.suffix ?? ""}`, { headers: request.headers });
        expect(response.status).toBe(401);
        await response.text();
      }
      const mutation = await fetch(`${app.url}api/account`, { method: "POST", headers });
      expect(mutation.status).toBe(405);
      expect(mutation.headers.get("allow")).toBe("GET");
      await mutation.text();
    } finally { expect((await app.interrupt()).status).toBe(0); }
  });

  it("reflects removed and replaced logins and live workspace refusal without restarting", async () => {
    const { app, box, hub, login, other, headers, origin } = await rig();
    const account = async () => await (await fetch(`${app.url}api/account`, { headers })).json() as Record<string, unknown>;
    try {
      await waitUntil("initial verified account", async () => (await account()).state === "signed-in");
      await removeHubLogin(origin, box.env);
      expect(await account()).toEqual({ state: "signed-out" });
      const replacement = issue(hub, "9876", "replacement-person", "member");
      await writeHubLogin(origin, replacement, box.env);
      await waitUntil("replacement account without restart", async () => (await account()).handle === "replacement-person", 80_000);
      hub.memberships!.remove({ workspaceId: WORKSPACE, actorPrincipalId: other.identity.id, principalId: replacement.identity.id });
      expect(await account()).toEqual({ state: "unavailable" });
      await writeHubLogin(origin, login, box.env);
      await waitUntil("original account returns", async () => (await account()).handle === "this-person", 80_000);
      hub.credentials!.revoke(login.credential.record.id);
      expect(await account()).toEqual({ state: "signed-out" });
    } finally { expect((await app.interrupt()).status).toBe(0); }
  });

  it("distinguishes an explicitly local workspace, a shared-secret hub and an unreachable hub", async () => {
    const { box, env } = configured();
    // A local binding cannot override its fallback endpoint through HUB_URL.
    // Isolate that default in this test build; keep the real binding and startup.
    const fallbackPort = await freePort();
    const fallback = `ws://127.0.0.1:${fallbackPort}`;
    const cli = join(box.cwd, "local-access.mjs");
    await build({ entryPoints: [join(PACKAGE_ROOT, "src/main.ts")], outfile: cli,
      bundle: true, platform: "node", format: "esm", target: "node26", minify: true,
      plugins: [{ name: "local-access-default", setup(builder) {
        builder.onResolve({ filter: /^@uberblick\/mcp-server$/ }, () => ({ path: "local-access-default", namespace: "fixture" }));
        builder.onLoad({ filter: /.*/, namespace: "fixture" }, () => ({ contents:
          `export * from ${JSON.stringify(join(REPO_ROOT, "packages/mcp-server/src/index.ts"))};\n` +
          `export const DEFAULT_HUB_URL = ${JSON.stringify(fallback)};`, loader: "ts", resolveDir: REPO_ROOT }));
      } }],
    });
    await silentListener(fallbackPort);
    const credentials = join(configDir(box), "credentials.json");
    rmSync(credentials);
    const binding = readFileSync(join(box.cwd, ".uberblick.json"), "utf8");
    const app = await open(box, ["--port", String(await freePort())], env, cli);
    try {
      const local = await fetch(`${app.url}api/access`, { method: "POST", headers: {
        ...bearer(await authMessage(localBrowserKey(WORKSPACE, box.env))),
        origin: new URL(app.url).origin, "content-type": "application/json",
      }, body: JSON.stringify({ operation: "own-role", workspaceId: WORKSPACE }) });
      expect(await local.json()).toEqual({ status: "local-only", hub: null });
      expect(JSON.parse(binding)).toEqual({ workspaceId: WORKSPACE, hubUrl: null });
      expect(readFileSync(join(box.cwd, ".uberblick.json"), "utf8")).toBe(binding);
      expect(app.stdout()).toContain(`${fallback} (not started: no signing secret`);
      expect(existsSync(credentials)).toBe(false);
      expect(existsSync(env.HUB_DB_PATH!)).toBe(false);
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
      expect((await post({ operation: "list-devices" })).body).toMatchObject({ status: "ok", handle: "this-person" });
      expect((await post({ operation: "revoke-device", deviceId: login.credential.record.deviceId })).body.status).toBe("ok");
      expect((await post({ operation: "list-devices" })).body.status).toBe("sign-in-required");
      expect(app.stderr()).not.toContain("private material");
    } finally { closure(); expect((await app.interrupt()).status).toBe(0); }
  });

  it("keeps account-scoped own-device operations available with an empty workspace credential", async () => {
    const { app, post, login, box, hub, headers } = await rig(null, []);
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
      expect(verify).toHaveBeenCalledWith(expect.any(String), { operation: "own-role", workspaceId: WORKSPACE });
      const listed = (await post({ operation: "list-devices" })).body;
      expect(listed).toMatchObject({ status: "ok", handle: "this-person", devices: [
        { deviceId: login.credential.record.deviceId, current: true },
      ] });
      expect(JSON.stringify(listed)).not.toContain(login.credential.key);
      expect(listed).not.toHaveProperty("identity");
      expect(listed).not.toHaveProperty("credential");
      expect(await (await fetch(`${app.url}api/account`, { headers })).json())
        .toEqual({ state: "unavailable" });
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

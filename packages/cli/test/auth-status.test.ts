/** Current login and hub-authority evidence stay separate from the stored snapshot. */
import { existsSync, readFileSync } from "node:fs";
import { createPrivateKey, createPublicKey } from "node:crypto";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { importCredentialPublicKey, inspectRequestProof } from "@uberblick/schema/token";
import { SYNC_PROTOCOL_VERSION } from "@uberblick/schema/protocol";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { runInProcess } from "./in-process.js";
import { removeTempDirs, sandbox, unboundSandbox, type Sandbox, type SandboxFiles } from "./helpers.js";
import { cleanUp, credentialPath, fixture, OTHER_HUB, OTHER_WORKSPACE, rig, seedLogin, serve, WORKSPACE } from "./auth-fixtures.js";

afterEach(async () => { vi.restoreAllMocks(); await cleanUp(); });
afterAll(removeTempDirs);

const PRIVATE_REPLY = "private-upstream-body";
const snapshot = { account: { login: "previous-user", provider: "github" }, workspaces: [{ id: WORKSPACE }] };
const modes = [false, true];

function report(run: { stdout: string }) {
  expect(run.stdout.trim().split("\n")).toHaveLength(1);
  const value = JSON.parse(run.stdout);
  expect(Object.keys(value).sort()).toEqual(["hub", "hubAdmin", "loginAccepted", "outcome", "storedLogin"]);
  return value;
}

function storedBytes(box: Sandbox) {
  return [credentialPath(box), join(box.cwd, ".uberblick.json")].map(path => existsSync(path) ? readFileSync(path) : null);
}

const replies = [
  { name: "current admin", status: 200, body: { status: "ok", role: "admin" }, outcome: "hub-admin", accepted: true, admin: true },
  { name: "confirmed non-admin", status: 403, body: { status: "forbidden" }, outcome: "not-hub-admin", accepted: true, admin: false },
  { name: "refused login", status: 401, body: { status: "sign-in-required" }, outcome: "login-refused", accepted: false, admin: null },
  { name: "operation unsupported", status: 400, body: { status: "invalid-request" }, outcome: "hub-unsupported", accepted: null, admin: null },
  { name: "management unconfigured", status: 503, body: { status: "not-configured" }, outcome: "hub-unsupported", accepted: null, admin: null },
  { name: "hub needs update", status: 409, body: { status: "protocol-mismatch", reason: `protocol-mismatch:${SYNC_PROTOCOL_VERSION - 1}` }, outcome: "update-required", accepted: null, admin: null },
  { name: "client needs update", status: 409, body: { status: "protocol-mismatch", reason: `protocol-mismatch:${SYNC_PROTOCOL_VERSION + 1}` }, outcome: "update-required", accepted: null, admin: null },
  { name: "hub failed", status: 500, body: { status: "failed" }, outcome: "hub-error", accepted: null, admin: null },
  ...[
    [200, { status: "forbidden" }], [403, { status: "ok", role: "admin" }],
    [200, { status: "ok", role: "member" }], [200, { status: "ok" }],
    [401, { status: "forbidden" }], [409, { status: "protocol-mismatch", reason: PRIVATE_REPLY }],
    [409, { status: "protocol-mismatch", reason: `protocol-mismatch:${SYNC_PROTOCOL_VERSION}` }],
    [500, { status: "not-configured" }], [200, []], [200, null],
  ].map(([status, body], index) => ({ name: `invalid response ${index}`, status: status as number, body, outcome: "hub-error", accepted: null, admin: null })),
];

describe.each(modes)("ub auth status current replies, JSON=%s", json => {
  it.each(replies)("reports $name with validated evidence only", async ({ name, status, body, outcome, accepted, admin }) => {
    const login = fixture();
    const box = sandbox({ credentials: { hubLogins: { [OTHER_HUB]: login } } });
    const before = storedBytes(box);
    const response = body !== null && typeof body === "object" && !Array.isArray(body)
      ? { ...body, message: PRIVATE_REPLY, key: login.credential.key } : body;
    const fetch = vi.spyOn(globalThis, "fetch").mockResolvedValue(Response.json(response, { status }));
    const run = await runInProcess(["auth", "status", OTHER_HUB, ...(json ? ["--json"] : [])], box);
    expect(run.status, run.stderr).toBe(admin === null ? 1 : 0);
    if (json) expect(report(run)).toEqual({ hub: OTHER_HUB, outcome, loginAccepted: accepted, hubAdmin: admin, storedLogin: snapshot });
    else {
      expect(run.stdout).toContain("stored account  previous-user (github)");
      expect(run.stdout).toContain(`stored available workspaces:\n  ${WORKSPACE}\n`);
      expect(run.stdout).toContain(`login (hub)  ${accepted === null ? `not verified (${outcome})` : accepted ? "accepted" : "refused"}`);
      expect(run.stdout).toContain(`hub admin (hub)  ${admin === null ? `not verified (${outcome})` : admin ? "yes" : "no"}`);
    }
    if (outcome === "login-refused") expect(run.stderr).toContain(`ub auth login ${OTHER_HUB}`);
    else if (outcome === "hub-unsupported") expect(run.stderr).toMatch(/runs the hub.*update or configure/);
    else if (outcome === "hub-error") expect(run.stderr).toContain("ask whoever runs the hub");
    else if (outcome === "update-required") expect(run.stderr).toMatch(name === "hub needs update" ? /hub.*older|update.*hub/i : /client.*older|update.*client/i);
    else expect(run.stderr).toBe("");
    expect(fetch).toHaveBeenCalledOnce();
    const [url, options] = fetch.mock.calls[0]!;
    expect(url).toBe(`${OTHER_HUB}/auth/manage`);
    expect(options).toMatchObject({ method: "POST", redirect: "error" });
    const request = JSON.parse(options!.body as string);
    expect(request).toEqual({ operation: "own-hub-role", protocolVersion: SYNC_PROTOCOL_VERSION, token: expect.any(String) });
    const publicKey = createPublicKey(createPrivateKey({ key: Buffer.from(login.credential.key, "base64url"), type: "pkcs8", format: "der" })).export({ format: "jwk" }).x!;
    const proof = await inspectRequestProof(await importCredentialPublicKey(Buffer.from(publicKey, "base64url")), request.token, { operation: "own-hub-role" });
    expect(proof).not.toHaveProperty("failure");
    expect(proof).toMatchObject({ operation: "own-hub-role", kid: login.credential.record.id });
    for (const secret of [PRIVATE_REPLY, login.credential.key, request.token]) expect(run.output.includes(secret)).toBe(false);
    expect(storedBytes(box)).toEqual(before);
  });

  it.each([200, 400, 404, 502, 503, 504])("classifies a non-JSON HTTP %s page", async status => {
    const box = sandbox({ credentials: { hubLogins: { [OTHER_HUB]: fixture() } } });
    const fetch = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(PRIVATE_REPLY, { status }));
    const run = await runInProcess(["auth", "status", OTHER_HUB, ...(json ? ["--json"] : [])], box);
    const outcome = status < 500 ? "hub-unsupported" : "hub-unreachable";
    expect(run.status).toBe(1);
    if (json) expect(report(run)).toEqual({ hub: OTHER_HUB, outcome, loginAccepted: null, hubAdmin: null, storedLogin: snapshot });
    else expect(run.stdout).toContain(`hub admin (hub)  not verified (${outcome})`);
    expect(run.stdout).not.toMatch(/not a hub admin|hub admin \(hub\)\s+no\n/);
    expect(run.output).not.toContain(PRIVATE_REPLY);
    expect(fetch).toHaveBeenCalledOnce();
    if (status >= 500) expect(run.stderr).toMatch(/network or VPN.*retry/);
  });

  it.each([
    { status: 502, body: { error: PRIVATE_REPLY } },
    { status: 503, body: { error: PRIVATE_REPLY } },
    { status: 504, body: { error: PRIVATE_REPLY } },
    { status: 502, body: null },
    { status: 503, body: [] },
    { status: 504, body: { error: PRIVATE_REPLY.repeat(5_000) } },
  ])("classifies a JSON gateway HTTP $status reply without hub status fields", async ({ status, body }) => {
    const box = sandbox({ credentials: { hubLogins: { [OTHER_HUB]: fixture() } } });
    vi.spyOn(globalThis, "fetch").mockResolvedValue(Response.json(body, { status }));
    const run = await runInProcess(["auth", "status", OTHER_HUB, ...(json ? ["--json"] : [])], box);
    expect(run.status).toBe(1);
    if (json) expect(report(run)).toEqual({ hub: OTHER_HUB, outcome: "hub-unreachable", loginAccepted: null, hubAdmin: null, storedLogin: snapshot });
    else expect(run.stdout).toContain("hub admin (hub)  not verified (hub-unreachable)");
    expect(run.stderr).toMatch(/network or VPN.*retry/);
    expect(run.output).not.toContain(PRIVATE_REPLY);
  });

  it("reports a network failure without treating stored login as current authority", async () => {
    const box = sandbox({ credentials: { hubLogins: { [OTHER_HUB]: fixture() } } });
    const fetch = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error(PRIVATE_REPLY));
    const run = await runInProcess(["auth", "status", OTHER_HUB, ...(json ? ["--json"] : [])], box);
    expect(run.status).toBe(1);
    if (json) expect(report(run)).toEqual({ hub: OTHER_HUB, outcome: "hub-unreachable", loginAccepted: null, hubAdmin: null, storedLogin: snapshot });
    else expect(run.stdout).toContain("stored account  previous-user (github)");
    expect(run.stderr).toMatch(/network or VPN.*retry/);
    expect(run.output).not.toContain(PRIVATE_REPLY);
    expect(fetch).toHaveBeenCalledOnce();
  });
});

const localCases: Array<{ name: string; files?: SandboxFiles; unbound?: boolean; env?: NodeJS.ProcessEnv; outcome: string; hub: string | null; stored?: boolean }> = [
  { name: "unbound project", unbound: true, outcome: "no-hub", hub: null },
  { name: "local project", outcome: "no-hub", hub: null },
  { name: "local project with unreadable credentials", files: { raw: { credentials: "{broken" } }, outcome: "no-hub", hub: null },
  { name: "local environment pair", env: { UB_WORKSPACE_ID: WORKSPACE, UB_HUB_URL: "local" }, outcome: "no-hub", hub: null },
  { name: "malformed binding", files: { raw: { projectBinding: "{broken" } }, outcome: "binding-invalid", hub: null },
  { name: "invalid binding", files: { projectBinding: { workspaceId: "bad", hubUrl: OTHER_HUB } }, outcome: "binding-invalid", hub: null },
  { name: "legacy ambient variables", env: { HUB_URL: PRIVATE_REPLY }, outcome: "binding-invalid", hub: null },
  { name: "incomplete environment override", env: { UB_HUB_URL: OTHER_HUB }, outcome: "binding-invalid", hub: null },
  { name: "no stored login", files: { projectBinding: { workspaceId: WORKSPACE, hubUrl: OTHER_HUB } }, outcome: "not-signed-in", hub: OTHER_HUB },
  { name: "revoked stored login", files: { projectBinding: { workspaceId: WORKSPACE, hubUrl: OTHER_HUB }, credentials: { hubLogins: { [OTHER_HUB]: (() => { const login = fixture(); return { ...login, credential: { ...login.credential, record: { ...login.credential.record, revokedAt: Date.now() } } }; })() } } }, outcome: "not-signed-in", hub: OTHER_HUB, stored: true },
  { name: "unreadable store", files: { projectBinding: { workspaceId: WORKSPACE, hubUrl: OTHER_HUB }, raw: { credentials: "{broken" } }, outcome: "credential-store", hub: OTHER_HUB },
  { name: "refused store", files: { projectBinding: { workspaceId: WORKSPACE, hubUrl: OTHER_HUB }, credentials: { hubLogins: { [OTHER_HUB]: fixture() } }, credentialsMode: 0o644 }, outcome: "credential-store", hub: OTHER_HUB },
  { name: "unusable stored login", files: { projectBinding: { workspaceId: WORKSPACE, hubUrl: OTHER_HUB }, credentials: { hubLogins: { [OTHER_HUB]: {} } } }, outcome: "credential-store", hub: OTHER_HUB },
];

describe.each(modes)("ub auth status without usable remote login, JSON=%s", json => {
  it.each(localCases)("reports $name without contacting anything", async ({ files, unbound, env, outcome, hub, stored }) => {
    const box = (unbound ? unboundSandbox : sandbox)(files);
    const before = storedBytes(box);
    const fetch = vi.spyOn(globalThis, "fetch");
    const run = await runInProcess(["auth", "status", ...(json ? ["--json"] : [])], box, env);
    expect(run.status).toBe(outcome === "no-hub" ? 0 : 1);
    if (json) expect(report(run)).toEqual({ hub, outcome, loginAccepted: null, hubAdmin: null, storedLogin: stored ? snapshot : null });
    else if (outcome === "no-hub") {
      expect(run.stdout).toContain("none (local-only)");
      expect(run.stdout).toContain("Local-only work needs no login.");
    } else expect(run.stdout).toContain(`hub admin (hub)  not verified (${outcome})`);
    if (hub !== null) expect(run.stderr).toContain(`ub auth login ${hub}`);
    expect(run.output).not.toContain(PRIVATE_REPLY);
    expect(fetch).not.toHaveBeenCalled();
    expect(storedBytes(box)).toEqual(before);
  });
});

describe("ub auth status bounded read-only check", () => {
  it("asks the real hub once per invocation and follows current authority without changing credentials or access", async () => {
    const remote = await rig();
    const login = await seedLogin(remote);
    const authority = remote.hub.hubAdmins!;
    const other = remote.hub.principals!.identify("5678", "other-admin");
    authority.grant(login.identity.id);
    authority.grant(other.id);
    const database = new DatabaseSync(remote.databasePath, { readOnly: true });
    const state = () => ({
      credentials: database.prepare("SELECT * FROM hub_credentials ORDER BY id").all(),
      memberships: database.prepare("SELECT * FROM hub_memberships ORDER BY workspace_id, principal_id").all(),
      admins: database.prepare("SELECT * FROM hub_admins ORDER BY principal_id").all(),
    });
    const bytes = storedBytes(remote.box);
    try {
      for (const admin of [true, false]) {
        if (!admin) authority.remove(other.id, login.identity.id);
        const before = state();
        const run = await runInProcess(["auth", "status", remote.origin, "--json"], remote.box);
        expect(run.status, run.stderr).toBe(0);
        expect(report(run)).toEqual({ hub: remote.origin, outcome: admin ? "hub-admin" : "not-hub-admin", loginAccepted: true, hubAdmin: admin,
          storedLogin: { account: { login: login.identity.githubUsername, provider: "github" }, workspaces: [] } });
        expect(state()).toEqual(before);
        expect(storedBytes(remote.box)).toEqual(bytes);
        const proof = remote.requests.at(-1)?.body.token;
        expect(run.output.includes(login.credential.key)).toBe(false);
        expect(typeof proof === "string" && run.output.includes(proof)).toBe(false);
      }
      expect(remote.requests).toHaveLength(2);
      expect(remote.requests.every(request => request.path === "/auth/manage" && request.body.operation === "own-hub-role")).toBe(true);
      expect(remote.github.calls).toEqual([]);
    } finally { database.close(); }
  });

  it.each(["headers", "body"])("caps a hung %s request including response consumption", async phase => {
    const requests: string[] = [];
    const remote = await serve((request, response) => {
      requests.push(request.url ?? "");
      if (phase === "body") { response.writeHead(200); response.write('{"status":"ok",'); }
    });
    const box = sandbox({ credentials: { hubLogins: { [remote.origin]: fixture() } } });
    const before = storedBytes(box);
    const started = Date.now();
    const run = await runInProcess(["auth", "status", remote.origin, "--json"], box, { UB_TEST_MAX_WAIT_MS: "60" });
    expect(Date.now() - started).toBeLessThan(2_000);
    expect(run.status).toBe(1);
    expect(report(run)).toMatchObject({ outcome: "hub-unreachable", loginAccepted: null, hubAdmin: null, storedLogin: snapshot });
    expect(requests).toEqual(["/auth/manage"]);
    expect(storedBytes(box)).toEqual(before);
  });

  it("rejects an oversized reply without printing it or changing the login", async () => {
    const remote = await serve((_request, response) => {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ status: "ok", role: "admin", private: PRIVATE_REPLY.repeat(5_000) }));
    });
    const box = sandbox({ credentials: { hubLogins: { [remote.origin]: fixture() } } });
    const before = storedBytes(box);
    const run = await runInProcess(["auth", "status", remote.origin, "--json"], box);
    expect(run.status).toBe(1);
    expect(report(run)).toMatchObject({ outcome: "hub-error", loginAccepted: null, hubAdmin: null, storedLogin: snapshot });
    expect(run.output).not.toContain(PRIVATE_REPLY);
    expect(storedBytes(box)).toEqual(before);
  });

  it.each([".uberblick.json", "UB_WORKSPACE_ID"])("keeps cached names and the %s bound-workspace note in JSON", async source => {
    const login = fixture([WORKSPACE, OTHER_WORKSPACE]);
    const credentials = { hubLogins: { [OTHER_HUB]: { ...login, credential: { ...login.credential, workspaceNames: {
      [WORKSPACE]: "Stored name", [OTHER_WORKSPACE]: "unsafe\u009bname", "00000000-0000-4000-8000-000000000000": "not issued",
    } } } } };
    const boundId = "11111111-1111-4111-8111-111111111111";
    const box = sandbox({ credentials, projectBinding: { workspaceId: boundId, hubUrl: OTHER_HUB } });
    vi.spyOn(globalThis, "fetch").mockResolvedValue(Response.json({ status: "forbidden" }, { status: 403 }));
    const run = await runInProcess(["auth", "status", "--json"], box, source === "UB_WORKSPACE_ID" ? { UB_WORKSPACE_ID: boundId, UB_HUB_URL: OTHER_HUB } : {});
    expect(report(run).storedLogin).toEqual({ account: snapshot.account,
      workspaces: [{ id: WORKSPACE, name: "Stored name" }, { id: OTHER_WORKSPACE }],
      boundWorkspace: { id: boundId, source, note: expect.stringContaining("absent from the stored login") } });
  });
});

describe.each(["login", "status", "logout"])("ub auth %s usage errors", subcommand => {
  it.each([
    { operands: [`--unsupported=${PRIVATE_REPLY}`], error: /unknown option/i },
    { operands: ["--unsupported", PRIVATE_REPLY], error: /unknown option/i },
    { operands: ["--live", "--json"], error: /unknown option/i },
    { operands: ["--offline"], error: /unknown option/i },
    { operands: [PRIVATE_REPLY, PRIVATE_REPLY], error: /expected at most one hub/ },
    { operands: [`https://user:${PRIVATE_REPLY}@hub.invalid`], error: /invalid hub/ },
  ])("redacts values in $operands", async ({ operands, error }) => {
    const box = sandbox();
    const fetch = vi.spyOn(globalThis, "fetch");
    const run = await runInProcess(["auth", subcommand, ...operands], box);
    expect(run.status).toBe(2);
    expect(run.stdout).toBe("");
    expect(run.stderr).toMatch(error);
    expect(run.stderr).not.toContain(PRIVATE_REPLY);
    expect(fetch).not.toHaveBeenCalled();
    expect(existsSync(credentialPath(box))).toBe(false);
  });
});

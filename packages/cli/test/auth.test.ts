/** Remote sign-in contracts across the real CLI, HTTP hub and owner-only store. */
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  chmodSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync,
  statSync, writeFileSync,
} from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { createHub, type Hub } from "@uberblick/hub";
import { resolveMcpConfig } from "@uberblick/mcp-server";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import { authenticationOrigin } from "../src/auth.js";
import { resolveConfig } from "../src/config.js";
import {
  DEAD_HUB_URL, removeTempDirs, runUbAsync, sandbox, sleep, UB_BIN, waitUntil,
  type Run, type Sandbox,
} from "./helpers.js";

const WORKSPACE = "5c1f9a72-4d38-4e02-9b6a-7e3f10c85b94";
const OTHER_WORKSPACE = "073a832a-b9e5-475f-8b59-3f8fa67a66f3";
const SIGNING_SECRET = "auth-test-existing-shared-signing-secret";
const GITHUB_TOKEN = "ghu_auth-test-provider-token";
const DEVICE_CODE = "auth-test-private-github-device-code";
const USERNAME = "auth-test-user";
const OTHER_HUB = "https://other-hub.invalid";

interface Login {
  identity: { id: string; githubAccountId: string; githubUsername: string };
  credential: {
    record: {
      id: string; principalId: string; deviceId: string; workspaces: string[];
      issuedAt: number; revokedAt: null;
    };
    key: string;
  };
}

/** Synthetic fixture keys may be shown by a failed assertion; issued keys may not. */
function fixture(workspaces = [WORKSPACE]): Login {
  const principalId = randomUUID();
  return {
    identity: { id: principalId, githubAccountId: "1234", githubUsername: "previous-user" },
    credential: {
      record: {
        id: randomUUID(), principalId, deviceId: randomUUID(), workspaces,
        issuedAt: Date.now(), revokedAt: null,
      },
      key: Buffer.alloc(32, 7).toString("base64url"),
    },
  };
}

function credentialPath(box: Sandbox): string {
  return join(box.configHome, "uberblick", "credentials.json");
}

function configPath(box: Sandbox): string {
  return join(box.configHome, "uberblick", "config.json");
}

function readStore(box: Sandbox): { signingSecret?: string; hubLogins?: Record<string, Login> } {
  return JSON.parse(readFileSync(credentialPath(box), "utf8"));
}

function savedLogin(box: Sandbox, origin: string): Login {
  const login = readStore(box).hubLogins?.[origin];
  if (!login) throw new Error("expected selected hub login to be persisted");
  return login;
}

class GithubFake {
  lifetime = 10;
  tokenResult: Record<string, unknown> = { access_token: GITHUB_TOKEN, token_type: "bearer", scope: "" };
  calls: string[] = [];
  failAt: string | undefined;
  tokenHook: (() => void | Promise<void>) | undefined;
  identityHook: (() => void | Promise<void>) | undefined;
  fetch: typeof fetch = async (input) => {
    const url = String(input);
    this.calls.push(url);
    if (url === this.failAt) throw new Error(`${GITHUB_TOKEN} ${DEVICE_CODE}`);
    if (url === "https://github.com/login/device/code") {
      return Response.json({
        device_code: DEVICE_CODE, user_code: "ABCD-EFGH",
        verification_uri: "https://github.com/login/device",
        expires_in: this.lifetime, interval: 1,
      });
    }
    if (url === "https://github.com/login/oauth/access_token") {
      await this.tokenHook?.();
      return Response.json(this.tokenResult);
    }
    await this.identityHook?.();
    return Response.json({ id: 1234, login: USERNAME });
  };
}

const hubs: Hub[] = [];
const servers: Server[] = [];

afterEach(async () => {
  // End held HTTP bodies before stopping their backing hubs.
  for (const server of servers.splice(0)) {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
  for (const hub of hubs.splice(0)) await hub.stop();
});
afterAll(removeTempDirs);

async function serve(handler: (request: IncomingMessage, response: ServerResponse) => void) {
  const server = createServer(handler);
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("missing HTTP test port");
  return { server, origin: `http://127.0.0.1:${address.port}` };
}

async function rig(workspaces: string[] = [], configured = true, initializeDefaultWorkspace = false) {
  const box = sandbox();
  const github = new GithubFake();
  const logs: unknown[] = [];
  const databasePath = join(box.cwd, "hub.sqlite");
  const startHub = async () => {
    const hub = await createHub({
      authSecret: SIGNING_SECRET, port: 0, databasePath, log: (line) => logs.push(line),
      ...(configured ? { github: { clientId: "Iv23AbCdEF0123456789", fetch: github.fetch } } : {}),
    }, { initializeDefaultWorkspace });
    hubs.push(hub);
    return hub;
  };
  let hub = await startHub();
  if (workspaces.length > 0) {
    const database = new DatabaseSync(databasePath);
    const principalId = randomUUID();
    try {
      database.prepare("INSERT INTO hub_principals VALUES (?, ?, ?)").run(principalId, "1234", USERNAME);
      for (const workspace of workspaces) {
        database.prepare("INSERT INTO hub_memberships VALUES (?, ?, ?)").run(workspace, principalId, "member");
      }
    } finally { database.close(); }
  }

  const requests: { path: string; method: string | undefined; authorization: string | undefined; body: Record<string, unknown> }[] = [];
  const collectionStatuses: string[] = [];
  const controls: {
    onStart: ((result: Record<string, unknown>) => Promise<void> | void) | undefined;
    holdCollection: boolean;
    unavailableCollection: boolean;
    claimStateFailure: "lost" | "hung-body" | "oversized" | undefined;
    transform: ((path: string, status: number, result: Record<string, unknown>) => { status: number; result: unknown }) | undefined;
  } = { onStart: undefined, holdCollection: false, unavailableCollection: false, claimStateFailure: undefined, transform: undefined };
  const proxy = await serve((request, response) => {
    void (async () => {
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      const body = chunks.length > 0 ? JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown> : {};
      const path = request.url ?? "";
      requests.push({ path, method: request.method, authorization: request.headers.authorization, body });
      if (path === "/auth/claim-state" && controls.claimStateFailure !== undefined) {
        if (controls.claimStateFailure === "lost") { response.destroy(); return; }
        response.writeHead(200, { "Content-Type": "application/json" });
        if (controls.claimStateFailure === "hung-body") response.write('{"unclaimed":true,');
        else response.end(JSON.stringify({ unclaimed: true, canClaim: true, extra: "x".repeat(65_536) }));
        return;
      }
      if (controls.unavailableCollection && path === "/auth/github/collect") {
        response.writeHead(502);
        response.end();
        return;
      }
      if (controls.holdCollection && path === "/auth/github/collect") {
        response.writeHead(200, { "Content-Type": "application/json" });
        response.write('{"status":"');
        return;
      }
      const upstream = await fetch(`http://127.0.0.1:${hub.port}${path}`, {
        method: request.method ?? "POST", headers: { "Content-Type": "application/json" },
        ...(request.method === "GET" ? {} : { body: JSON.stringify(body) }),
      });
      const result = await upstream.json() as Record<string, unknown>;
      if (path === "/auth/github/collect") collectionStatuses.push(String(result.status));
      if (path === "/auth/github/start") await controls.onStart?.(result);
      const reply = controls.transform?.(path, upstream.status, result) ?? { status: upstream.status, result };
      response.writeHead(reply.status, { "Content-Type": "application/json" });
      response.end(JSON.stringify(reply.result));
    })().catch(() => {
      if (!response.headersSent) response.writeHead(502);
      response.end();
    });
  });
  return {
    ...proxy, box, github, logs, requests, collectionStatuses, databasePath, controls,
    get hub() { return hub; },
    async restart() { await hub.stop(); hub = await startHub(); },
    async cancel(body: Record<string, unknown>) {
      return fetch(`http://127.0.0.1:${hub.port}/auth/github/cancel`, {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
      });
    },
  };
}

function privateDeviceRows(databasePath: string) {
  const database = new DatabaseSync(databasePath, { readOnly: true });
  try {
    return database.prepare("SELECT id, revoked_at FROM hub_credentials ORDER BY id").all();
  } finally { database.close(); }
}

function assertPublicOnly(run: Run, testRig: Awaited<ReturnType<typeof rig>>, key?: string) {
  const printed = run.output + JSON.stringify(testRig.logs);
  for (const secret of [GITHUB_TOKEN, DEVICE_CODE, SIGNING_SECRET, key,
    ...testRig.requests.map((request) => request.body.collectionSecret as string | undefined)]) {
    if (secret) expect(printed.includes(secret), "no private flow or credential value was printed").toBe(false);
  }
}

describe("ub auth local selection and command surface", () => {
  it("provides progressive help and refuses unsupported usage without writing", async () => {
    const box = sandbox();
    const root = await runUbAsync(["--help"], box);
    expect(root.stdout.match(/^ {2}auth\s/gm)).toHaveLength(1);
    for (const args of [["auth"], ["auth", "login"], ["auth", "status"], ["auth", "logout"]]) {
      const help = await runUbAsync([...args, "--help"], box);
      expect(help.status).toBe(0);
      expect(help.stdout).toContain(`ub ${args.join(" ")}`);
      expect(help.stderr).toBe("");
      if (args[1] === "login") {
        expect(help.stdout).toContain("GitHub's approval page shows the app's name, not the hub.");
        expect(help.stdout.replace(/\s+/g, " ")).toContain("Approve only a login you started for the displayed hub");
        expect(help.stdout.replace(/\s+/g, " ")).toContain("the first GitHub account to complete approval claims its default workspace as administrator");
      }
    }
    for (const args of [["auth", "unknown"], ["auth", "login", "--json"], ["auth", "logout", "a", "b"]]) {
      expect((await runUbAsync(args, box)).status).toBe(2);
    }
    expect(existsSync(credentialPath(box))).toBe(false);
  });

  it("requires an explicit or file-bound hub, ignores ambient HUB_URL and keeps local-only work quiet", async () => {
    const box = sandbox({ projectBinding: { workspaceId: WORKSPACE, hubUrl: null }, userConfig: { workspace: WORKSPACE } });
    for (const subcommand of ["login", "status", "logout"]) {
      const run = await runUbAsync(["auth", subcommand], box, { HUB_URL: "ws://ambient.invalid" });
      expect(run.status).toBe(1);
      expect(run.stderr).toMatch(/local.only.*no login|local.only.*no sign.in/i);
    }
    const status = await runUbAsync(["status"], box);
    expect(status.output).not.toMatch(/auth login|sign.in/i);
    expect(existsSync(credentialPath(box))).toBe(false);
  });

  it("never uses a legacy machine hub and resolves a complete environment pair for implicit auth", async () => {
    const origin = "https://selected.example.test";
    const box = sandbox({
      userConfig: { workspace: WORKSPACE, hubUrl: "https://legacy.example.test" },
      credentials: { hubLogins: { [origin]: fixture() } },
    });
    const unbound = await runUbAsync(["auth", "status"], box);
    expect(unbound.status).toBe(1);
    expect(unbound.stderr).toContain("no hub given and none bound");
    const selected = await runUbAsync(["auth", "status"], box, {
      UB_WORKSPACE_ID: WORKSPACE, UB_HUB_URL: origin,
    });
    expect(selected.status, selected.output).toBe(0);
    expect(selected.stdout).toContain(origin);
    expect(selected.stdout).not.toContain("legacy.example.test");
  });

  it("refuses malformed project selection for an implicit hub but permits an explicit login target", async () => {
    const origin = "https://hub.example.test";
    const box = sandbox({ raw: { projectBinding: '{"workspaceId":' },
      credentials: { hubLogins: { [origin]: fixture() } },
    });
    const implicit = await runUbAsync(["auth", "status"], box);
    expect(implicit.status).toBe(1);
    expect(implicit.stderr).toContain(".uberblick.json");
    const explicit = await runUbAsync(["auth", "status", origin], box);
    expect(explicit.status, explicit.output).toBe(0);
    expect(explicit.stdout).toContain(origin);
    expect(explicit.stdout).toContain("previous-user");
  });

  it("finds one offline login across host case, default-port and endpoint spellings without rebinding", async () => {
    const origin = "https://hub.example.ts.net";
    const endpoint = "wss://Hub.Example.TS.net:443/ws";
    const old = fixture();
    const other = fixture([]);
    const box = sandbox({ projectBinding: { workspaceId: WORKSPACE, hubUrl: endpoint },
      userConfig: { workspace: WORKSPACE, hubUrl: endpoint },
      credentials: { signingSecret: SIGNING_SECRET, hubLogins: { [origin]: old, [OTHER_HUB]: other } },
    });
    const binding = readFileSync(configPath(box));
    for (const spelling of [undefined, "Hub.Example.TS.net:443", "https://Hub.Example.TS.net:443", endpoint]) {
      const run = await runUbAsync(["auth", "status", ...(spelling ? [spelling] : [])], box);
      expect(run.status, run.stderr).toBe(0);
      expect(run.stdout).toContain(origin);
      expect(run.stdout).toContain(old.identity.githubUsername);
      expect(run.stdout).toContain(WORKSPACE);
      expect(run.stdout).toContain(OTHER_HUB);
      expect(run.output).toMatch(/local|not.*check|not.*verified/i);
      expect(run.output.includes(old.credential.key)).toBe(false);
    }
    const logout = await runUbAsync(["auth", "logout", "Hub.Example.TS.net:443"], box);
    expect(logout.status).toBe(0);
    expect(logout.stdout).toMatch(/until.*revok|revok.*device/i);
    expect(readStore(box)).toEqual({ signingSecret: SIGNING_SECRET, hubLogins: { [OTHER_HUB]: other } });
    expect(readFileSync(configPath(box))).toEqual(binding);
    const missing = await runUbAsync(["auth", "status"], box);
    expect(missing.status).toBe(1);
    expect(missing.output).toMatch(/no.*login|not.*signed/i);
    expect(missing.output).toContain("ub auth login");
    expect(missing.output).toContain(OTHER_HUB);
  });

  it("explains renewal for a bound workspace outside the credential snapshot", async () => {
    const box = sandbox({ projectBinding: { workspaceId: OTHER_WORKSPACE, hubUrl: DEAD_HUB_URL },
      userConfig: { workspace: OTHER_WORKSPACE, hubUrl: DEAD_HUB_URL },
      credentials: { hubLogins: { "http://127.0.0.1:1": fixture() } },
    });
    const status = await runUbAsync(["auth", "status"], box);
    expect(status.status).toBe(0);
    expect(status.output).toContain(OTHER_WORKSPACE);
    expect(status.output).toContain("renews this login");
    expect(status.output).not.toContain("ub auth login");
  });

  it.each(["exposed", "unreadable", "invalid-entry"])("refuses %s local credentials without presenting identity as signed in", async (kind) => {
    const origin = "http://127.0.0.1:1";
    const old = fixture();
    const box = sandbox({ projectBinding: { workspaceId: WORKSPACE, hubUrl: DEAD_HUB_URL },
      userConfig: { workspace: WORKSPACE, hubUrl: DEAD_HUB_URL },
      credentials: { hubLogins: { [origin]: kind === "invalid-entry" ? {} : old } },
    });
    if (kind === "exposed") chmodSync(credentialPath(box), 0o644);
    if (kind === "unreadable") { rmSync(credentialPath(box)); mkdirSync(credentialPath(box)); }
    const run = await runUbAsync(["auth", "status"], box);
    expect(run.status).toBe(1);
    expect(run.output).not.toContain(old.identity.githubUsername);
    expect(run.output).toContain("ub auth login");
    if (kind === "exposed") expect(run.output).toMatch(/chmod.*600/);
    else expect(run.output).toMatch(/unreadable|cannot read|invalid|refused/i);
  });
});

describe("hub-driven CLI GitHub sign-in", () => {
  it("claims a fresh deployed hub before storing its workspace credential and leaves the binding unchanged", async () => {
    const remote = await rig([], true, true);
    const box = sandbox({ projectBinding: { workspaceId: WORKSPACE, hubUrl: DEAD_HUB_URL }, userConfig: { workspace: WORKSPACE, hubUrl: DEAD_HUB_URL } });
    const binding = readFileSync(configPath(box));
    const login = await runUbAsync(["auth", "login", remote.origin], box);
    expect(login.status, login.stderr).toBe(0);
    const stored = savedLogin(box, remote.origin);
    const workspace = stored.credential.record.workspaces[0];
    expect(stored.credential.record.workspaces).toHaveLength(1);
    expect(workspace).toMatch(/^[0-9a-f-]{36}$/);
    expect(workspace).not.toBe(WORKSPACE);
    const notice = "This hub is unclaimed. The first GitHub account to complete approval becomes administrator of its default workspace.";
    expect(login.stdout).toContain(notice);
    expect(login.stdout.indexOf(notice)).toBeLessThan(login.stdout.indexOf("Approve in a browser:"));
    const completion = `This login claimed the hub. Default workspace: ${workspace}`;
    expect(login.stdout).toContain(completion);
    expect(login.stdout.indexOf(completion)).toBeLessThan(login.stdout.indexOf("Stored login"));
    expect(readFileSync(configPath(box))).toEqual(binding);
    expect(remote.requests[0]).toMatchObject({ path: "/auth/claim-state", method: "GET", body: {} });
    const again = await runUbAsync(["auth", "login", remote.origin], box);
    expect(again.status, again.stderr).toBe(0);
    expect(again.stdout).not.toContain("This hub is unclaimed");
    expect(again.stdout).not.toContain("This login claimed");
    expect(savedLogin(box, remote.origin).credential.record.workspaces).toEqual([workspace]);
    expect(readFileSync(configPath(box))).toEqual(binding);
    assertPublicOnly(login, remote, stored.credential.key);
  });

  it("reports ordinary completion when another account claimed after the unclaimed notice", async () => {
    const remote = await rig();
    remote.controls.transform = (path, status, result) => path === "/auth/claim-state"
      ? { status: 200, result: { unclaimed: true, canClaim: true } } : { status, result };
    const box = sandbox();
    const login = await runUbAsync(["auth", "login", remote.origin], box);
    expect(login.status, login.stderr).toBe(0);
    expect(login.stdout).toContain("This hub is unclaimed");
    expect(login.stdout).not.toContain("This login claimed");
    expect(login.stdout).toContain("Credential covers no workspaces. Sign-in grants no membership.");
    expect(savedLogin(box, remote.origin).credential.record.workspaces).toEqual([]);
  });

  it.each(["already-claimed", "failed-read"])("reports a committed claim independently of an earlier %s answer", async (kind) => {
    const remote = await rig([WORKSPACE]);
    remote.controls.transform = (path, status, result) => {
      if (path === "/auth/claim-state") return kind === "failed-read"
        ? { status: 503, result: { unclaimed: true, canClaim: true } }
        : { status: 200, result: { unclaimed: false, canClaim: false } };
      if (path === "/auth/github/collect" && result.status === "complete") {
        return { status, result: { ...result, claimedWorkspaceId: WORKSPACE } };
      }
      return { status, result };
    };
    const login = await runUbAsync(["auth", "login", remote.origin], sandbox());
    expect(login.status, login.stderr).toBe(0);
    expect(login.stdout).not.toContain("This hub is unclaimed");
    expect(login.stdout).toContain(`This login claimed the hub. Default workspace: ${WORKSPACE}`);
  });

  it.each(["lost", "hung-body", "oversized", "old-hub", "unavailable", "wrong-shape", "unexpected-field"])("continues ordinary login after a %s claim-state read without an unclaimed notice", async (kind) => {
    const remote = await rig();
    if (kind === "lost" || kind === "hung-body" || kind === "oversized") remote.controls.claimStateFailure = kind;
    remote.controls.transform = (path, status, result) => {
      if (path !== "/auth/claim-state") return { status, result };
      if (kind === "old-hub") return { status: 404, result: { status: "unknown-request" } };
      if (kind === "unavailable") return { status: 503, result: { unclaimed: true, canClaim: true } };
      if (kind === "wrong-shape") return { status: 200, result: { unclaimed: "true", canClaim: true } };
      return { status: 200, result: { unclaimed: true, canClaim: true, workspaceName: GITHUB_TOKEN } };
    };
    const box = sandbox();
    const startedAt = Date.now();
    const login = await runUbAsync(["auth", "login", remote.origin], box);
    expect(login.status, login.stderr).toBe(0);
    expect(login.stdout).not.toContain("This hub is unclaimed");
    expect(login.stdout).not.toContain("This login claimed");
    expect(login.output).not.toContain(GITHUB_TOKEN);
    expect(savedLogin(box, remote.origin).credential.record.workspaces).toEqual([]);
    if (kind === "hung-body") expect(Date.now() - startedAt).toBeLessThan(6_000);
  });

  it.each(["not-a-uuid", "not-covered", "not-a-string", "room-id"])("refuses a %s committed claim field without printing it or replacing stored credentials", async (kind) => {
    const remote = await rig();
    remote.controls.transform = (path, status, result) => {
      if (path !== "/auth/github/collect" || result.status !== "complete") return { status, result };
      const claimedWorkspaceId = kind === "not-a-uuid" ? GITHUB_TOKEN
        : kind === "not-covered" ? WORKSPACE : kind === "room-id" ? `${WORKSPACE}/_settings` : null;
      return { status, result: { ...result, claimedWorkspaceId } };
    };
    const box = sandbox({ credentials: { hubLogins: { [remote.origin]: fixture() } } });
    const before = readFileSync(credentialPath(box));
    const login = await runUbAsync(["auth", "login", remote.origin], box);
    expect(login.status).toBe(1);
    expect(login.stderr).toContain("invalid sign-in claim result");
    expect(login.stdout).not.toContain("This login claimed");
    expect(login.output).not.toContain(GITHUB_TOKEN);
    expect(readFileSync(credentialPath(box))).toEqual(before);
    expect(privateDeviceRows(remote.databasePath)).toHaveLength(1);
    assertPublicOnly(login, remote);
  });

  it("keeps loopback sync disabled without a local secret and does not export its login key", async () => {
    const login = fixture();
    const box = sandbox({ projectBinding: { workspaceId: WORKSPACE, hubUrl: DEAD_HUB_URL },
      userConfig: { workspace: WORKSPACE, hubUrl: DEAD_HUB_URL },
      credentials: { hubLogins: { [authenticationOrigin(DEAD_HUB_URL)]: login } },
    });
    const resolved = resolveConfig({ env: box.env, cwd: box.cwd });
    const config = resolveMcpConfig(resolved.env);
    expect(config.authSecret).toBeNull();
    expect(config.deviceLogin).toBeUndefined();
    expect(Object.values(resolved.env).every((value) => !value?.includes(login.credential.key)),
      "the child environment contains no stored device key").toBe(true);
    expect(JSON.stringify(config).includes(login.credential.key),
      "MCP configuration contains no stored device key").toBe(false);

    const status = await runUbAsync(["status", "--json"], box);
    expect(status.status, status.stderr).toBe(0);
    const report = JSON.parse(status.stdout);
    expect(report.credentialPresent).toBe(false);
    expect(report.hub.status).toBe("disabled");
    const snippet = await runUbAsync(["mcp", "install", "zed", "--print"], box);
    expect(snippet.status, snippet.stderr).toBe(0);
    for (const output of [status.output, snippet.output, readFileSync(configPath(box), "utf8")]) {
      expect(output.includes(login.credential.key), "the device key stays in its owner-only store").toBe(false);
    }
  });

  it("stores identity and every issued workspace privately, preserving binding and other hubs", async () => {
    const remote = await rig([WORKSPACE, OTHER_WORKSPACE]);
    const other = fixture([]);
    const box = sandbox({ projectBinding: { workspaceId: WORKSPACE, hubUrl: `${remote.origin.replace("http:", "ws:")}/ws` },
      userConfig: { workspace: WORKSPACE, hubUrl: `${remote.origin.replace("http:", "ws:")}/ws` },
      credentials: { signingSecret: SIGNING_SECRET, hubLogins: { [OTHER_HUB]: other } },
    });
    const before = readFileSync(configPath(box));
    const login = await runUbAsync(["auth", "login"], box);
    expect(login.status, login.stderr).toBe(0);
    expect(login.stdout.split("\n")[0]).toBe(`Hub: ${remote.origin}`);
    expect(login.stdout).toContain(`GitHub sign-in for ${remote.origin}\nApprove in a browser: https://github.com/login/device\nCode: ABCD-EFGH\n`);
    expect(login.stdout).toContain(USERNAME);
    for (const workspace of [WORKSPACE, OTHER_WORKSPACE]) expect(login.stdout).toContain(workspace);
    const stored = savedLogin(box, remote.origin);
    expect(stored.identity).toMatchObject({ githubAccountId: "1234", githubUsername: USERNAME });
    expect(stored.credential.record.workspaces).toEqual([OTHER_WORKSPACE, WORKSPACE].sort());
    expect(stored.credential.record.principalId).toBe(stored.identity.id);
    expect(stored.credential.key.length).toBe(43);
    expect(readStore(box).hubLogins?.[OTHER_HUB]).toEqual(other);
    expect(readStore(box).signingSecret).toBe(SIGNING_SECRET);
    expect(statSync(credentialPath(box)).mode & 0o077).toBe(0);
    expect(readFileSync(configPath(box))).toEqual(before);
    expect(login.output).toContain("Remote sync uses this stored login");
    assertPublicOnly(login, remote, stored.credential.key);
    for (const request of remote.requests) {
      expect(request.method).toBe(request.path === "/auth/claim-state" ? "GET" : "POST");
      expect(request.authorization).toBeUndefined();
      expect(Object.keys(request.body).sort()).toEqual(request.path.endsWith("start") || request.path === "/auth/claim-state" ? [] : ["collectionSecret", "requestId"]);
    }
    // The child compares private values in memory and prints only conclusions.
    // A successful test must not teach people to dump a resolved environment.
    const bridgeCheck = `
      const fs = require("node:fs");
      const path = require("node:path");
      const stored = JSON.parse(fs.readFileSync(path.join(process.env.XDG_CONFIG_HOME, "uberblick", "credentials.json"), "utf8"));
      const values = Object.values(process.env);
      process.stdout.write(JSON.stringify({
        deviceCredentialsAbsent: Object.values(stored.hubLogins).every(login => values.every(value => !value.includes(login.credential.key))),
        signingSecretPresent: process.env.HUB_AUTH_TOKEN === stored.signingSecret,
        workspace: process.env.WORKSPACE_ID,
        hub: process.env.HUB_URL
      }));
    `;
    const bridge = await runUbAsync(["env", "--", process.execPath, "-e", bridgeCheck], box);
    const snippet = await runUbAsync(["mcp", "install", "zed", "--print"], box);
    for (const text of [bridge.output, snippet.output, readFileSync(configPath(box), "utf8")]) {
      expect(text.includes(stored.credential.key), "credential key is only persisted in its private store").toBe(false);
      for (const request of remote.requests) {
        const secret = request.body.collectionSecret;
        if (typeof secret === "string") expect(text.includes(secret)).toBe(false);
      }
    }
    expect(bridge.status).toBe(0);
    expect(JSON.parse(bridge.stdout)).toEqual({
      deviceCredentialsAbsent: true, signingSecretPresent: true,
      workspace: WORKSPACE, hub: `${remote.origin.replace("http:", "ws:")}/ws`,
    });
    await remote.hub.stop();
    const requestCount = remote.requests.length;
    expect((await runUbAsync(["auth", "status"], box)).status).toBe(0);
    const logout = await runUbAsync(["auth", "logout"], box);
    expect(logout.status).toBe(0);
    expect(logout.output).toMatch(/until.*revok|revok.*device/i);
    expect(privateDeviceRows(remote.databasePath)).toHaveLength(1);
    expect(privateDeviceRows(remote.databasePath)[0]?.revoked_at).toBeNull();
    expect(readStore(box).hubLogins?.[OTHER_HUB]).toEqual(other);
    expect(readFileSync(configPath(box))).toEqual(before);
    expect(remote.requests).toHaveLength(requestCount);
  });

  it("signs in with zero workspaces and explicitly leaves a different hub binding unchanged", async () => {
    const remote = await rig();
    const box = sandbox({ projectBinding: { workspaceId: WORKSPACE, hubUrl: DEAD_HUB_URL }, userConfig: { workspace: WORKSPACE, hubUrl: DEAD_HUB_URL } });
    const binding = readFileSync(configPath(box));
    const login = await runUbAsync(["auth", "login", remote.origin], box);
    expect(login.status, login.stderr).toBe(0);
    expect(login.stdout).toContain(`GitHub sign-in for ${remote.origin}\nApprove in a browser: https://github.com/login/device\nCode: ABCD-EFGH\n`);
    expect(login.stdout).toContain("GitHub's approval page shows the app's name, not the hub.");
    expect(login.stdout).toContain(`Approve only if you started this login for ${remote.origin}; the app does not vouch for this hub.`);
    expect(login.stdout).not.toContain("http://127.0.0.1:1");
    expect(login.output).toContain(USERNAME);
    expect(login.output).toMatch(/no.*workspace|workspaces.*none/i);
    expect(login.output).toMatch(/sign.in.*no membership|sign.in.*does not.*membership|no.*membership/i);
    expect(login.output).toMatch(/binding.*unchanged|unchanged.*binding/i);
    expect(savedLogin(box, remote.origin).credential.record.workspaces).toEqual([]);
    const status = await runUbAsync(["auth", "status", remote.origin], box);
    expect(status.status).toBe(0);
    expect(status.stdout).toMatch(/no.*workspace|workspaces.*none/i);
    const logout = await runUbAsync(["auth", "logout", remote.origin], box);
    expect(logout.status).toBe(0);
    expect(logout.output).toMatch(/binding.*unchanged|unchanged.*binding/i);
    expect(readFileSync(configPath(box))).toEqual(binding);
  });

  it("keeps an existing login byte-for-byte on denial and replaces it only after completion without revoking", async () => {
    const remote = await rig([WORKSPACE]);
    const box = sandbox({ projectBinding: { workspaceId: WORKSPACE, hubUrl: remote.origin.replace("http:", "ws:") },
      userConfig: { workspace: WORKSPACE, hubUrl: remote.origin.replace("http:", "ws:") },
      credentials: { signingSecret: SIGNING_SECRET },
    });
    expect((await runUbAsync(["auth", "login"], box)).status).toBe(0);
    const before = readFileSync(credentialPath(box));
    remote.github.tokenResult = { error: "access_denied" };
    const denied = await runUbAsync(["auth", "login"], box);
    expect(denied.status).toBe(1);
    expect(denied.stderr).toMatch(/denied/i);
    expect(readFileSync(credentialPath(box))).toEqual(before);
    remote.github.tokenResult = { access_token: GITHUB_TOKEN, token_type: "bearer", scope: "" };
    remote.github.identityHook = () => { expect(readFileSync(credentialPath(box))).toEqual(before); };
    const complete = await runUbAsync(["auth", "login"], box);
    expect(complete.status, complete.stderr).toBe(0);
    expect(complete.output).toMatch(/replaced.*device|previous.*device|old.*device/i);
    expect(complete.output).toMatch(/until.*revok/i);
    expect(savedLogin(box, remote.origin).identity.githubUsername).toBe(USERNAME);
    expect(privateDeviceRows(remote.databasePath)).toHaveLength(2);
    expect(privateDeviceRows(remote.databasePath).every((row) => row.revoked_at === null)).toBe(true);
  });

  it.each(["denied", "expired", "abandoned", "failed", "unknown-request"])("reports terminal %s without storing or disturbing earlier state", async (outcome) => {
    const remote = await rig();
    const box = sandbox({ credentials: { signingSecret: SIGNING_SECRET, hubLogins: { [remote.origin]: fixture() } } });
    const before = readFileSync(credentialPath(box));
    if (outcome === "denied") remote.github.tokenResult = { error: "access_denied" };
    if (outcome === "expired") remote.github.tokenResult = { error: "expired_token" };
    if (outcome === "failed") remote.github.failAt = "https://github.com/login/oauth/access_token";
    if (outcome === "abandoned") remote.controls.onStart = async (result) => {
      await remote.cancel({ requestId: result.requestId, collectionSecret: result.collectionSecret });
    };
    if (outcome === "unknown-request") remote.controls.onStart = () => remote.restart();
    const run = await runUbAsync(["auth", "login", remote.origin], box);
    expect(run.status).toBe(1);
    expect(run.stderr).toMatch(outcome === "unknown-request" ? /lost|restart|unknown.request/i : new RegExp(outcome, "i"));
    expect(readFileSync(credentialPath(box))).toEqual(before);
    expect(privateDeviceRows(remote.databasePath)).toHaveLength(0);
    assertPublicOnly(run, remote);
  });

  it("refuses exposed or impossible stores before contacting the configured sign-in hub", async () => {
    const remote = await rig();
    const exposed = sandbox({ credentials: { hubLogins: { [remote.origin]: fixture() } }, credentialsMode: 0o644 });
    const before = readFileSync(credentialPath(exposed));
    const refused = await runUbAsync(["auth", "login", remote.origin], exposed);
    expect(refused.status).toBe(1);
    expect(refused.stderr).toMatch(/chmod.*600/);
    expect(readFileSync(credentialPath(exposed))).toEqual(before);
    const impossible = sandbox();
    mkdirSync(impossible.configHome, { recursive: true });
    writeFileSync(join(impossible.configHome, "uberblick"), "not a directory");
    expect((await runUbAsync(["auth", "login", remote.origin], impossible)).status).toBe(1);
    expect(remote.requests).toHaveLength(0);
    expect(remote.github.calls).toHaveLength(0);
  });

  it("reports an issued device left on the hub when publication fails after collection", async () => {
    const remote = await rig([], true, true);
    const box = sandbox({ credentials: { signingSecret: SIGNING_SECRET, hubLogins: { [remote.origin]: fixture() } } });
    const before = readFileSync(credentialPath(box));
    const backup = `${credentialPath(box)}.previous`;
    remote.github.identityHook = () => {
      renameSync(credentialPath(box), backup);
      mkdirSync(credentialPath(box));
    };
    try {
      const run = await runUbAsync(["auth", "login", remote.origin], box);
      expect(run.status).toBe(1);
      expect(run.stdout).toMatch(/This login claimed the hub\. Default workspace: [0-9a-f-]{36}/);
      expect(run.stderr).toMatch(/issued.*device.*remain|issued.*device.*hub|device.*remain.*hub/i);
      expect(privateDeviceRows(remote.databasePath)).toHaveLength(1);
      expect(readFileSync(backup)).toEqual(before);
      assertPublicOnly(run, remote);
    } finally {
      rmSync(credentialPath(box), { recursive: true, force: true });
      renameSync(backup, credentialPath(box));
    }
  });

  it.each(["SIGINT", "SIGTERM"] as const)("%s abandons the hub attempt and exits without a credential or keyboard input", async (signal) => {
    const remote = await rig();
    remote.github.tokenResult = { error: "authorization_pending" };
    const box = sandbox({ credentials: { hubLogins: { [remote.origin]: fixture() } } });
    const before = readFileSync(credentialPath(box));
    const child = spawn(process.execPath, [UB_BIN, "auth", "login", remote.origin], {
      cwd: box.cwd, env: box.env, timeout: 15_000,
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => { stdout += chunk.toString(); });
    child.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString(); });
    const done = new Promise<Run>((resolve, reject) => {
      child.on("error", reject);
      child.on("close", (status) => resolve({ status, stdout, stderr, output: stdout + stderr }));
    });
    try {
      await waitUntil("CLI sign-in approval code", () => stdout.includes("ABCD-EFGH"), 10_000);
      child.kill(signal);
      const run = await done;
      expect(run.status).not.toBe(0);
      expect(run.stderr).toMatch(/interrupted/i);
      const cancellation = remote.requests.find((request) => request.path === "/auth/github/cancel");
      expect(cancellation).toBeDefined();
      if (!cancellation) throw new Error("missing cancellation request");
      expect((await (await remote.cancel(cancellation.body)).json() as { status: string }).status).toBe("abandoned");
      expect(readFileSync(credentialPath(box))).toEqual(before);
      expect(privateDeviceRows(remote.databasePath)).toHaveLength(0);
      assertPublicOnly(run, remote);
    } finally {
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
      await done;
    }
  });

  it("SIGINT while start is awaiting its reply abandons the late attempt without showing an approval code", async () => {
    const remote = await rig();
    const box = sandbox({ credentials: { hubLogins: { [remote.origin]: fixture() } } });
    const before = readFileSync(credentialPath(box));
    let startEntered = false;
    let release!: () => void;
    const heldReply = new Promise<void>((resolve) => { release = resolve; });
    remote.controls.onStart = async () => { startEntered = true; await heldReply; };
    const child = spawn(process.execPath, [UB_BIN, "auth", "login", remote.origin], {
      cwd: box.cwd, env: box.env, timeout: 15_000,
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => { stdout += chunk.toString(); });
    child.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString(); });
    const done = new Promise<Run>((resolve, reject) => {
      child.on("error", reject);
      child.on("close", (status) => resolve({ status, stdout, stderr, output: stdout + stderr }));
    });
    try {
      // The real hub has created the request; the CLI has not received its
      // cancellation authority yet. Keep that response held across the signal.
      await waitUntil("hub created sign-in request before its reply", () => startEntered, 10_000);
      child.kill("SIGINT");
      await sleep(100);
      release();
      const run = await done;
      expect(run.status).toBe(1);
      expect(run.stderr).toMatch(/interrupted/i);
      expect(run.stdout).not.toContain("ABCD-EFGH");
      const cancellation = remote.requests.find((request) => request.path === "/auth/github/cancel");
      expect(cancellation).toBeDefined();
      if (!cancellation) throw new Error("missing cancellation of late start reply");
      expect((await (await remote.cancel(cancellation.body)).json() as { status: string }).status).toBe("abandoned");
      expect(readFileSync(credentialPath(box))).toEqual(before);
      expect(privateDeviceRows(remote.databasePath)).toHaveLength(0);
      assertPublicOnly(run, remote);
    } finally {
      release();
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
      await done;
    }
  });
});

describe("CLI sign-in validates availability and has a finite lifetime", () => {
  it("reports unreachable and unconfigured hubs without changing the store", async () => {
    const remote = await rig([], false);
    const box = sandbox({ credentials: { signingSecret: SIGNING_SECRET } });
    const before = readFileSync(credentialPath(box));
    const unconfigured = await runUbAsync(["auth", "login", remote.origin], box);
    expect(unconfigured.status).toBe(1);
    expect(unconfigured.stderr).toMatch(/not configured|not.configured/i);
    const unreachable = await runUbAsync(["auth", "login", DEAD_HUB_URL], box);
    expect(unreachable.status).toBe(1);
    expect(unreachable.stderr).toMatch(/unreachable|cannot reach/i);
    expect(readFileSync(credentialPath(box))).toEqual(before);
  });

  it.each([502, 503, 504])("reports an empty proxy %s as unreachable and preserves existing credentials", async (status) => {
    const proxy = await serve((_request, response) => { response.writeHead(status); response.end(); });
    const box = sandbox({ credentials: { hubLogins: { [proxy.origin]: fixture() } } });
    const before = readFileSync(credentialPath(box));
    const run = await runUbAsync(["auth", "login", proxy.origin], box);
    expect(run.status).toBe(1);
    expect(run.stderr).toMatch(/unreachable|cannot reach/i);
    expect(run.stderr).not.toMatch(/update.*hub/i);
    expect(readFileSync(credentialPath(box))).toEqual(before);
  });

  it("reports a proxy outage during collection and abandons the existing attempt", async () => {
    const remote = await rig();
    remote.controls.unavailableCollection = true;
    const box = sandbox({ credentials: { hubLogins: { [remote.origin]: fixture() } } });
    const before = readFileSync(credentialPath(box));
    const run = await runUbAsync(["auth", "login", remote.origin], box);
    expect(run.status).toBe(1);
    expect(run.stderr).toMatch(/unreachable|cannot reach/i);
    expect(run.stderr).not.toMatch(/update.*hub/i);
    const cancellation = remote.requests.find((request) => request.path === "/auth/github/cancel");
    expect(cancellation).toBeDefined();
    if (!cancellation) throw new Error("missing cancellation after proxy outage");
    expect((await (await remote.cancel(cancellation.body)).json() as { status: string }).status).toBe("abandoned");
    expect(readFileSync(credentialPath(box))).toEqual(before);
    expect(privateDeviceRows(remote.databasePath)).toHaveLength(0);
    assertPublicOnly(run, remote);
  });

  it("cancels a timed-out collection before slow GitHub reads can issue a device", async () => {
    const remote = await rig();
    remote.github.lifetime = 30;
    // Both provider reads fit the hub's individual ten-second budgets; their
    // combined wait exceeds the CLI's collection request limit.
    remote.github.tokenHook = () => sleep(6_000);
    let identityRead: Promise<void> | undefined;
    remote.github.identityHook = () => { identityRead = sleep(6_000); return identityRead; };
    const box = sandbox({ credentials: { hubLogins: { [remote.origin]: fixture() } } });
    const before = readFileSync(credentialPath(box));
    try {
      const run = await runUbAsync(["auth", "login", remote.origin], box);
      expect(run.status).toBe(1);
      expect(run.stderr).toMatch(/unreachable|timed out/i);
      const cancellation = remote.requests.find((request) => request.path === "/auth/github/cancel");
      expect(cancellation).toBeDefined();
      if (!cancellation) throw new Error("missing cancellation after collection timeout");
      expect((await (await remote.cancel(cancellation.body)).json() as { status: string }).status).toBe("abandoned");
      expect(remote.github.calls).toContain("https://api.github.com/user");
      expect(identityRead).toBeDefined();
      await identityRead;
      await waitUntil("slow hub collection finished after cancellation", () => remote.collectionStatuses.length === 1, 5_000);
      expect(remote.collectionStatuses).toEqual(["abandoned"]);
      expect(readFileSync(credentialPath(box))).toEqual(before);
      expect(privateDeviceRows(remote.databasePath)).toHaveLength(0);
      assertPublicOnly(run, remote);
    } finally { await identityRead; }
  });

  it("reports a device already issued when failure cleanup finds a collected attempt", async () => {
    const remote = await rig();
    let issuedKey: string | undefined;
    remote.controls.transform = (path, status, result) => {
      if (!path.endsWith("collect") || result.status !== "complete") return { status, result };
      issuedKey = (result.credential as Login["credential"]).key;
      return { status, result: { status: "failed" } };
    };
    const box = sandbox({ credentials: { hubLogins: { [remote.origin]: fixture() } } });
    const before = readFileSync(credentialPath(box));
    const run = await runUbAsync(["auth", "login", remote.origin], box);
    expect(run.status).toBe(1);
    expect(run.stderr).toMatch(/failed/i);
    expect(run.stderr).toMatch(/issued.*device.*remain.*hub/i);
    expect(remote.requests.some((request) => request.path === "/auth/github/cancel")).toBe(true);
    expect(readFileSync(credentialPath(box))).toEqual(before);
    expect(privateDeviceRows(remote.databasePath)).toHaveLength(1);
    expect(privateDeviceRows(remote.databasePath)[0]?.revoked_at).toBeNull();
    assertPublicOnly(run, remote, issuedKey);
  });

  it("recognizes busy and failed starts by their validated body", async () => {
    const remote = await rig();
    remote.github.failAt = "https://github.com/login/device/code";
    const box = sandbox();
    const failure = await runUbAsync(["auth", "login", remote.origin], box);
    expect(failure.status).toBe(1);
    expect(failure.stderr).toMatch(/failed/i);
    assertPublicOnly(failure, remote);
    remote.github.failAt = undefined;
    remote.github.lifetime = 60;
    await Promise.all(Array.from({ length: 100 }, () => fetch(`http://127.0.0.1:${remote.hub.port}/auth/github/start`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: "{}",
    }).then((response) => response.arrayBuffer())));
    const busy = await runUbAsync(["auth", "login", remote.origin], box);
    expect(busy.status).toBe(1);
    expect(busy.stderr).toMatch(/busy/i);
    expect(existsSync(credentialPath(box))).toBe(false);
  });

  it.each(["old-hub", "wrong-shape", "wrong-status", "invalid-envelope", "unsafe-verification-url", "unsafe-code", "invalid-lifetime", "invalid-interval"])("refuses %s responses without trusting or printing their contents", async (kind) => {
    const remote = await rig();
    if (kind !== "old-hub") remote.controls.transform = (path, status, result) => {
      if (!path.endsWith("start")) return { status, result };
      if (kind === "wrong-shape") return { status, result: { status: "pending", collectionSecret: GITHUB_TOKEN } };
      if (kind === "wrong-status") return { status: 201, result };
      if (kind === "invalid-envelope") return { status, result: { ...result, status: "unsupported" } };
      if (kind === "unsafe-verification-url") return { status, result: { ...result, verificationUri: `https://attacker.invalid/${GITHUB_TOKEN}` } };
      if (kind === "invalid-lifetime") return { status, result: { ...result, expiresIn: 901 } };
      if (kind === "invalid-interval") return { status, result: { ...result, interval: 0 } };
      return { status, result: { ...result, userCode: GITHUB_TOKEN } };
    };
    const old = kind === "old-hub" ? await serve((_request, response) => {
      response.writeHead(200, { "Content-Type": "text/plain" });
      response.end("Welcome to Hocuspocus!");
    }) : undefined;
    const box = sandbox({ credentials: { signingSecret: SIGNING_SECRET } });
    const before = readFileSync(credentialPath(box));
    const run = await runUbAsync(["auth", "login", old?.origin ?? remote.origin], box);
    expect(run.status).toBe(1);
    expect(run.stderr).toMatch(/offer|invalid|malformed|unsupported|response/i);
    expect(run.output).not.toContain(GITHUB_TOKEN);
    expect(readFileSync(credentialPath(box))).toEqual(before);
    if (!["old-hub", "wrong-shape"].includes(kind)) {
      const cancellation = remote.requests.find((request) => request.path === "/auth/github/cancel");
      expect(cancellation).toBeDefined();
      if (!cancellation) throw new Error("missing cancellation authority from malformed start");
      expect((await (await remote.cancel(cancellation.body)).json() as { status: string }).status).toBe("abandoned");
      expect(remote.requests.some((request) => request.path === "/auth/github/collect")).toBe(false);
      expect(run.stdout).not.toContain("Approve in a browser");
      expect(privateDeviceRows(remote.databasePath)).toHaveLength(0);
      assertPublicOnly(run, remote);
    } else {
      expect(remote.requests.some((request) => request.path === "/auth/github/cancel")).toBe(false);
    }
  });

  it.each(["invalid-key", "username-echoes-key", "username-echoes-collection-secret"])("refuses a complete response with %s and explains the issued device", async (kind) => {
    const remote = await rig();
    let issuedKey: string | undefined;
    remote.controls.transform = (path, status, result) => {
      if (!path.endsWith("collect") || result.status !== "complete") return { status, result };
      const credential = result.credential as Login["credential"];
      const identity = result.identity as Login["identity"];
      issuedKey = credential.key;
      if (kind === "invalid-key") return { status, result: { ...result, credential: { ...credential, key: GITHUB_TOKEN } } };
      const echoed = kind === "username-echoes-key" ? credential.key
        : remote.requests.at(-1)?.body.collectionSecret;
      return { status, result: { ...result, identity: { ...identity, githubUsername: echoed } } };
    };
    const box = sandbox({ credentials: { hubLogins: { [remote.origin]: fixture() } } });
    const before = readFileSync(credentialPath(box));
    const run = await runUbAsync(["auth", "login", remote.origin], box);
    expect(run.status).toBe(1);
    expect(run.stderr).toMatch(/invalid.*credential|invalid.*sign.in|invalid.*response/i);
    expect(run.stderr).toMatch(/issued.*device.*remain.*hub/i);
    expect(readFileSync(credentialPath(box))).toEqual(before);
    expect(privateDeviceRows(remote.databasePath)).toHaveLength(1);
    assertPublicOnly(run, remote, issuedKey);
  });

  it.each(["pending", "slow-down", "hung-body"])("ends %s by announced lifetime even with the shorter unrelated test seam", async (kind) => {
    const remote = await rig();
    remote.github.lifetime = 3;
    remote.github.tokenResult = { error: kind === "slow-down" ? "slow_down" : "authorization_pending" };
    remote.controls.holdCollection = kind === "hung-body";
    let announcedLifetime = 0;
    remote.controls.onStart = (result) => { announcedLifetime = result.expiresIn as number; };
    const box = sandbox();
    const startedAt = Date.now();
    const run = await runUbAsync(["auth", "login", remote.origin], box, { UB_TEST_MAX_WAIT_MS: "1" }, 12_000);
    const elapsed = Date.now() - startedAt;
    expect(run.status).toBe(1);
    expect(run.stderr).toMatch(/expired|timed out|timeout/i);
    expect(announcedLifetime).toBeGreaterThan(0);
    expect(elapsed).toBeGreaterThanOrEqual(announcedLifetime * 1000 - 100);
    expect(elapsed).toBeLessThan(announcedLifetime * 1000 + 5_000);
    expect(existsSync(credentialPath(box))).toBe(false);
    expect(privateDeviceRows(remote.databasePath)).toHaveLength(0);
    assertPublicOnly(run, remote);
  });
});

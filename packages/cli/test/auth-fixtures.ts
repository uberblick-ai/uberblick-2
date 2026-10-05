/** Fixtures shared by the `ub auth` suites: a fake GitHub, a real hub and its HTTP front. */

import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { createHub, type Hub } from "@uberblick/hub";
import { expect } from "vitest";
import { type Run, type Sandbox, sandbox } from "./helpers.js";

export const WORKSPACE = "5c1f9a72-4d38-4e02-9b6a-7e3f10c85b94";
export const OTHER_WORKSPACE = "073a832a-b9e5-475f-8b59-3f8fa67a66f3";
export const SIGNING_SECRET = "auth-test-existing-shared-signing-secret";
export const GITHUB_TOKEN = "ghu_auth-test-provider-token";
export const DEVICE_CODE = "auth-test-private-github-device-code";
export const USERNAME = "auth-test-user";
export const OTHER_HUB = "https://other-hub.invalid";

export interface Login {
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
export function fixture(workspaces = [WORKSPACE]): Login {
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

export function credentialPath(box: Sandbox): string {
  return join(box.configHome, "uberblick", "credentials.json");
}

export function configPath(box: Sandbox): string {
  return join(box.configHome, "uberblick", "config.json");
}

export function readStore(box: Sandbox): { signingSecret?: string; hubLogins?: Record<string, Login> } {
  return JSON.parse(readFileSync(credentialPath(box), "utf8"));
}

export function savedLogin(box: Sandbox, origin: string): Login {
  const login = readStore(box).hubLogins?.[origin];
  if (!login) throw new Error("expected selected hub login to be persisted");
  return login;
}

export class GithubFake {
  identity = { id: 1234, login: USERNAME };
  lifetime = 10;
  tokenResult: Record<string, unknown> = { access_token: GITHUB_TOKEN, token_type: "bearer", scope: "" };
  calls: string[] = [];
  failAt: string | undefined;
  tokenHook: (() => void | Promise<void>) | undefined;
  identityHook: (() => void | Promise<void>) | undefined;
  lookupHook: ((url: string) => Response | Promise<Response>) | undefined;
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
    if (url.startsWith("https://api.github.com/users/") || url.startsWith("https://api.github.com/user/")) {
      return this.lookupHook?.(url) ?? Response.json({ id: 1234, login: USERNAME, type: "User" });
    }
    await this.identityHook?.();
    return Response.json(this.identity);
  };
}

export const hubs: Hub[] = [];
export const servers: Server[] = [];

/** Close every server and hub a test started; both auth suites run it after each test. */
export async function cleanUp(): Promise<void> {
  // End held HTTP bodies before stopping their backing hubs.
  for (const server of servers.splice(0)) {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
  for (const hub of hubs.splice(0)) await hub.stop();
}

export async function serve(handler: (request: IncomingMessage, response: ServerResponse) => void) {
  const server = createServer(handler);
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("missing HTTP test port");
  return { server, origin: `http://127.0.0.1:${address.port}` };
}

export async function rig(workspaces: string[] = [], configured = true, initializeDefaultWorkspace = false, deviceCredentials = false) {
  const box = sandbox();
  const github = new GithubFake();
  const logs: unknown[] = [];
  const databasePath = join(box.cwd, "hub.sqlite");
  const startHub = async () => {
    const hub = await createHub({
      authSecret: SIGNING_SECRET, port: 0, databasePath, log: (line) => logs.push(line),
      ...(configured ? { github: { clientId: "Iv23AbCdEF0123456789", fetch: github.fetch } } : {}),
    }, { initializeDefaultWorkspace, ...(deviceCredentials ? { deviceCredentials: true } : {}) });
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
    claimStateFailure: "hung-body" | undefined;
    onManagement: ((body: Record<string, unknown>) => { status: number; result: unknown } | undefined | Promise<{ status: number; result: unknown } | undefined>) | undefined;
    transform: ((path: string, status: number, result: Record<string, unknown>, body: Record<string, unknown>) => { status: number; result: unknown }) | undefined;
  } = { onStart: undefined, holdCollection: false, unavailableCollection: false, claimStateFailure: undefined, onManagement: undefined, transform: undefined };
  const proxy = await serve((request, response) => {
    void (async () => {
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      const body = chunks.length > 0 ? JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown> : {};
      const path = request.url ?? "";
      requests.push({ path, method: request.method, authorization: request.headers.authorization, body });
      const managementReply = path === "/auth/manage" ? await controls.onManagement?.(body) : undefined;
      if (managementReply !== undefined) {
        response.writeHead(managementReply.status, { "Content-Type": "application/json" });
        response.end(JSON.stringify(managementReply.result));
        return;
      }
      if (path === "/auth/claim-state" && controls.claimStateFailure === "hung-body") {
        response.writeHead(200, { "Content-Type": "application/json" });
        response.write('{"unclaimed":true,');
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
      const reply = controls.transform?.(path, upstream.status, result, body) ?? { status: upstream.status, result };
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

export function privateDeviceRows(databasePath: string) {
  const database = new DatabaseSync(databasePath, { readOnly: true });
  try {
    return database.prepare("SELECT id, revoked_at FROM hub_credentials ORDER BY id").all();
  } finally { database.close(); }
}

export function assertPublicOnly(run: Run, testRig: Awaited<ReturnType<typeof rig>>, key?: string) {
  const printed = run.output + JSON.stringify(testRig.logs);
  for (const secret of [GITHUB_TOKEN, DEVICE_CODE, SIGNING_SECRET, key,
    ...testRig.requests.map((request) => request.body.collectionSecret as string | undefined)]) {
    if (secret) expect(printed.includes(secret), "no private flow or credential value was printed").toBe(false);
  }
}

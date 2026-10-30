import { once } from "node:events";
import { request, type IncomingHttpHeaders } from "node:http";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createMcpHost, type McpHostConfig, type McpHostDependencies } from "../src/http-host.js";
import type { McpHostTokenResult } from "../src/host-token-check.js";
import { cleanupTestResources, tempDir, WORKSPACE } from "./shared.js";

const ISSUER = "https://hub.example.com";
const PATH = `/mcp/${WORKSPACE}`;
const METHODS = ["POST", "GET", "DELETE"] as const;
const POSITIVE: McpHostTokenResult = {
  status: "positive", grantId: "grant-one", principal: "principal-one", workspace: WORKSPACE,
  scope: "docs:read docs:write", expiresAt: 2_000_000_000_000,
};
const hosts: ReturnType<typeof createMcpHost>[] = [];

afterEach(async () => {
  await cleanupTestResources({ peers: hosts.splice(0).map(host => () => host.close()) });
});

async function fixture(
  dependencies: McpHostDependencies = {},
  overrides: Partial<McpHostConfig> = {},
) {
  const credentialsForGrant = vi.fn<NonNullable<McpHostDependencies["credentialsForGrant"]>>(async () => {
    throw new Error("A refused request must not open grant credentials");
  });
  const host = createMcpHost({ issuer: ISSUER, allowedOrigins: [], hubUrl: "ws://127.0.0.1:1",
    databaseDirectory: tempDir(), ...overrides }, { credentialsForGrant, ...dependencies });
  hosts.push(host);
  host.server.listen(0, "127.0.0.1");
  await once(host.server, "listening");
  const address = host.server.address();
  if (address === null || typeof address === "string") throw new Error("Missing host listener");
  return { port: address.port, credentialsForGrant };
}

function send(
  port: number,
  method: string,
  path = PATH,
  headers: Record<string, string> = {},
) {
  return new Promise<{ status: number; headers: IncomingHttpHeaders; body: string }>((resolve, reject) => {
    const outgoing = request({ hostname: "127.0.0.1", port, method, path, headers }, response => {
      const chunks: Buffer[] = [];
      response.on("data", chunk => chunks.push(Buffer.from(chunk)));
      response.on("error", reject);
      response.on("end", () => resolve({ status: response.statusCode!, headers: response.headers,
        body: Buffer.concat(chunks).toString("utf8") }));
    });
    outgoing.on("error", reject);
    outgoing.setTimeout(5_000, () => outgoing.destroy(new Error("Host request timed out")));
    outgoing.end();
  });
}

function expectUnauthorized(response: Awaited<ReturnType<typeof send>>) {
  expect(response.status).toBe(401);
  expect(response.headers["www-authenticate"])
    .toBe(`Bearer resource_metadata="${ISSUER}/.well-known/oauth-protected-resource${PATH}", scope="docs:read docs:write"`);
}

function expectNoCors(response: Awaited<ReturnType<typeof send>>) {
  expect(Object.keys(response.headers).filter(name => name.startsWith("access-control-"))).toEqual([]);
}

describe("MCP host admission", () => {
  it("routes only raw canonical lowercase workspace paths before auth or runtime opening", async () => {
    const checkToken = vi.fn(async (): Promise<McpHostTokenResult> => ({ status: "negative" }));
    const host = await fixture({ checkToken });
    for (const path of ["/mcp", "/mcp/", `/mcp/team-${WORKSPACE}`, `/mcp/${WORKSPACE.toUpperCase()}`,
      "/mcp/bad-id", `${PATH}/`, `${PATH}%0A`, `/mcp/%39${WORKSPACE.slice(1)}`,
      `/mcp/../mcp/${WORKSPACE}`, `/other/${WORKSPACE}`]) {
      const response = await send(host.port, "POST", path, { Authorization: "Bearer presented", Origin: "null" });
      expect(response.status, path).toBe(404);
    }
    expect(checkToken).not.toHaveBeenCalled();
    expectUnauthorized(await send(host.port, "POST", PATH, { Authorization: "Bearer presented" }));
    expect(checkToken).toHaveBeenCalledExactlyOnceWith("presented");
    expect(host.credentialsForGrant).not.toHaveBeenCalled();
  });

  it("refuses every present Origin when none are configured before inspecting any token", async () => {
    const checkToken = vi.fn(async (): Promise<McpHostTokenResult> => ({ status: "unavailable" }));
    const host = await fixture({ checkToken });
    for (const method of METHODS) {
      for (const origin of ["null", "https://client.example"]) {
        for (const headers of [{}, { Authorization: "Bearer presented" }, { Authorization: "Basic presented" }]) {
          const response = await send(host.port, method, PATH, { ...headers, Origin: origin });
          expect(response.status).toBe(403);
          expectNoCors(response);
        }
      }
    }
    expect(checkToken).not.toHaveBeenCalled();
    expectUnauthorized(await send(host.port, "POST"));
    expect((await send(host.port, "POST", PATH, { Authorization: "Bearer presented" })).status).toBe(503);
    expect(checkToken).toHaveBeenCalledExactlyOnceWith("presented");
    expect(host.credentialsForGrant).not.toHaveBeenCalled();
  });

  it("matches configured origins exactly without granting CORS support", async () => {
    const checkToken = vi.fn(async (): Promise<McpHostTokenResult> => ({ status: "negative" }));
    const host = await fixture({ checkToken }, { allowedOrigins: ["https://client.example"] });
    const allowed = await send(host.port, "POST", PATH, { Origin: "https://client.example", Authorization: "Bearer presented" });
    expectUnauthorized(allowed);
    expectNoCors(allowed);
    for (const origin of ["null", "https://CLIENT.example", "https://client.example/", "https://client.example.evil",
      "https://client.example, https://evil.example"]) {
      expect((await send(host.port, "POST", PATH, { Origin: origin, Authorization: "Bearer presented" })).status).toBe(403);
    }
    const preflight = await send(host.port, "OPTIONS", PATH, { Origin: "https://client.example",
      "Access-Control-Request-Method": "POST", "Access-Control-Request-Headers": "authorization" });
    expect(preflight.status).toBe(405);
    expectNoCors(preflight);
    expect(checkToken).toHaveBeenCalledExactlyOnceWith("presented");
    expect(host.credentialsForGrant).not.toHaveBeenCalled();
  });

  it("accepts tokens only from the Bearer header and challenges missing or query-only tokens without checking them", async () => {
    const checkToken = vi.fn(async (): Promise<McpHostTokenResult> => ({ status: "negative" }));
    const host = await fixture({ checkToken });
    for (const method of METHODS) {
      expectUnauthorized(await send(host.port, method));
      expectUnauthorized(await send(host.port, method, `${PATH}?access_token=presented`));
      for (const authorization of ["Basic presented", "Bearer", "Bearer one two"]) {
        expectUnauthorized(await send(host.port, method, PATH, { Authorization: authorization }));
      }
    }
    expect(checkToken).not.toHaveBeenCalled();
    expectUnauthorized(await send(host.port, "POST", `${PATH}?access_token=ignored`, { Authorization: "Bearer header-token" }));
    expect(checkToken).toHaveBeenCalledExactlyOnceWith("header-token");
    expect(host.credentialsForGrant).not.toHaveBeenCalled();
  });

  it("checks every method afresh before session handling, including workspace, negative and unavailable answers", async () => {
    const checkToken = vi.fn<NonNullable<McpHostDependencies["checkToken"]>>();
    const host = await fixture({ checkToken });
    for (const method of METHODS) {
      checkToken.mockResolvedValueOnce({ ...POSITIVE, workspace: "00000000-0000-0000-0000-000000000000" });
      expectUnauthorized(await send(host.port, method, PATH, { Authorization: "Bearer same-token", "Mcp-Session-Id": "unknown" }));
      checkToken.mockResolvedValueOnce({ status: "negative" });
      expectUnauthorized(await send(host.port, method, PATH, { Authorization: "Bearer same-token", "Mcp-Session-Id": "unknown" }));
      checkToken.mockResolvedValueOnce({ status: "unavailable" });
      expect((await send(host.port, method, PATH, { Authorization: "Bearer same-token", "Mcp-Session-Id": "unknown" })).status).toBe(503);
      checkToken.mockResolvedValueOnce(POSITIVE);
      expect((await send(host.port, method, PATH, { Authorization: "Bearer same-token", "Mcp-Session-Id": "unknown" })).status).toBe(404);
    }
    expect(checkToken.mock.calls).toEqual(Array.from({ length: 12 }, () => ["same-token"]));
    expect(host.credentialsForGrant).not.toHaveBeenCalled();
  });

  it("refuses missing GET/DELETE and unknown sessions without opening grant credentials", async () => {
    const checkToken = vi.fn(async (): Promise<McpHostTokenResult> => POSITIVE);
    const host = await fixture({ checkToken });
    for (const method of ["GET", "DELETE"]) {
      expect((await send(host.port, method, PATH, { Authorization: "Bearer presented" })).status).toBe(400);
    }
    for (const method of METHODS) {
      expect((await send(host.port, method, PATH, { Authorization: "Bearer presented", "Mcp-Session-Id": "unknown" })).status).toBe(404);
    }
    expect(checkToken).toHaveBeenCalledTimes(5);
    expect(host.credentialsForGrant).not.toHaveBeenCalled();
  });

  it("fails closed with the production default while preserving earlier refusals", async () => {
    const host = await fixture();
    for (const method of METHODS) {
      expect((await send(host.port, method, PATH, { Authorization: "Bearer presented" })).status).toBe(503);
      expectUnauthorized(await send(host.port, method));
      expect((await send(host.port, method, PATH, { Authorization: "Bearer presented", Origin: "null" })).status).toBe(403);
      expect((await send(host.port, method, `${PATH}/`, { Authorization: "Bearer presented" })).status).toBe(404);
    }
    expect(host.credentialsForGrant).not.toHaveBeenCalled();
  });

  it("mounts resource metadata independently of token and session admission without CORS headers", async () => {
    const checkToken = vi.fn(async (): Promise<McpHostTokenResult> => ({ status: "unavailable" }));
    const host = await fixture({ checkToken });
    const metadata = await send(host.port, "GET", `/.well-known/oauth-protected-resource${PATH}`, { Origin: "https://client.example" });
    expect(metadata.status).toBe(200);
    expect(JSON.parse(metadata.body)).toEqual({ resource: `${ISSUER}${PATH}`, authorization_servers: [ISSUER],
      scopes_supported: ["docs:read", "docs:write"], bearer_methods_supported: ["header"] });
    expectNoCors(metadata);
    const withoutIssuer = await fixture({ checkToken }, { issuer: undefined });
    expect((await send(withoutIssuer.port, "GET", `/.well-known/oauth-protected-resource${PATH}`)).status).toBe(404);
    const unauthorized = await send(withoutIssuer.port, "POST");
    expect(unauthorized.status).toBe(401);
    expect(unauthorized.headers["www-authenticate"]).toBeUndefined();
    expect(checkToken).not.toHaveBeenCalled();
    expect(host.credentialsForGrant).not.toHaveBeenCalled();
    expect(withoutIssuer.credentialsForGrant).not.toHaveBeenCalled();
  });
});

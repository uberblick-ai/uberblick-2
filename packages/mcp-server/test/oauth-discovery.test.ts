import { createServer, request, type IncomingHttpHeaders, type Server } from "node:http";
import { once } from "node:events";
import { afterEach, describe, expect, it } from "vitest";
import { OAuthMetadataSchema, OAuthProtectedResourceMetadataSchema } from "@modelcontextprotocol/sdk/shared/auth.js";
import { checkResourceAllowed } from "@modelcontextprotocol/sdk/shared/auth-utils.js";
import { createTeamHub } from "@uberblick/hub/team";
import { resolveCoreHubConfig } from "@uberblick/hub/config";
import { parseHubPublicUrl } from "@uberblick/schema/oauth";
import { handleProtectedResourceMetadata, replyMcpUnauthorized } from "../src/oauth-discovery.js";

const WORKSPACE = "722007fa-8921-45ee-a580-e20311030fef";
const ISSUER = "https://hub.example.com";
const PATH = `/.well-known/oauth-protected-resource/mcp/${WORKSPACE}`;
const servers: Server[] = [];

function get(base: string, path: string, headers: Record<string, string>) {
  return new Promise<{ status: number; headers: IncomingHttpHeaders; body: string }>((resolve, reject) => {
    const outgoing = request(new URL(path, base), { headers }, response => {
      const chunks: Buffer[] = [];
      response.on("data", chunk => chunks.push(Buffer.from(chunk)));
      response.on("error", reject);
      response.on("end", () => resolve({ status: response.statusCode!, headers: response.headers,
        body: Buffer.concat(chunks).toString("utf8") }));
    });
    outgoing.on("error", reject);
    outgoing.setTimeout(5000, () => outgoing.destroy(new Error("discovery request timed out")));
    outgoing.end();
  });
}

async function discovery(issuer: string | undefined): Promise<string> {
  const server = createServer((request, response) => {
    if (handleProtectedResourceMetadata(issuer, request, response)) return;
    if (request.url === `/mcp/${WORKSPACE}`) {
      replyMcpUnauthorized(response, issuer, WORKSPACE);
      return;
    }
    response.writeHead(404);
    response.end();
  });
  servers.push(server);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("missing HTTP address");
  return `http://127.0.0.1:${address.port}`;
}

afterEach(async () => {
  for (const server of servers.splice(0)) {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  }
});

describe("protected resource discovery", () => {
  it("returns exact SDK-readable metadata without a hub or workspace lookup", async () => {
    const base = await discovery(ISSUER);
    for (const id of [WORKSPACE, "00000000-0000-0000-0000-000000000000"]) {
      const response = await fetch(`${base}/.well-known/oauth-protected-resource/mcp/${id}`);
      expect(response.status).toBe(200);
      expect(response.headers.get("content-type")).toBe("application/json");
      const metadata = await response.json();
      expect(metadata).toEqual({
        resource: `${ISSUER}/mcp/${id}`,
        authorization_servers: [ISSUER],
        scopes_supported: ["docs:read", "docs:write"],
        bearer_methods_supported: ["header"],
      });
      const parsed = OAuthProtectedResourceMetadataSchema.parse(metadata);
      expect(checkResourceAllowed({ requestedResource: new URL(`${ISSUER}/mcp/${id}`),
        configuredResource: new URL(parsed.resource) })).toBe(true);
    }
  });

  it.each([`team-${WORKSPACE}`, WORKSPACE.toUpperCase(), "bad-id", "", `${WORKSPACE}/`, `${WORKSPACE}%0A`])(
    "has no metadata for noncanonical id %j", async id => {
      const base = await discovery(ISSUER);
      const response = await fetch(`${base}/.well-known/oauth-protected-resource/mcp/${id}`);
      expect(response.status).toBe(404);
      expect(await response.text()).toBe("");
    },
  );

  it("sends the exact 401 challenge", async () => {
    const base = await discovery(ISSUER);
    const response = await fetch(`${base}/mcp/${WORKSPACE}`);
    expect(response.status).toBe(401);
    expect(response.headers.get("www-authenticate"))
      .toBe(`Bearer resource_metadata="${ISSUER}${PATH}", scope="docs:read docs:write"`);
  });

  it.each([
    { Host: "attacker.example" },
    { "X-Forwarded-Host": "attacker.example" },
    { "X-Forwarded-Proto": "http" },
    { Forwarded: "host=attacker.example;proto=http" },
  ])("ignores forged URL headers %j for metadata and challenges", async headers => {
    const base = await discovery(ISSUER);
    const metadata = await get(base, PATH, headers);
    expect(metadata.status).toBe(200);
    expect(JSON.parse(metadata.body)).toEqual(await (await fetch(`${base}${PATH}`)).json());
    const challenge = await get(base, `/mcp/${WORKSPACE}`, headers);
    expect(challenge.status).toBe(401);
    expect(challenge.headers["www-authenticate"])
      .toBe(`Bearer resource_metadata="${ISSUER}${PATH}", scope="docs:read docs:write"`);
  });

  it("does not infer an issuer from headers when configuration is absent", async () => {
    const base = await discovery(parseHubPublicUrl(undefined));
    const headers = { Host: "attacker.example", "X-Forwarded-Host": "attacker.example",
      "X-Forwarded-Proto": "https", Forwarded: "host=attacker.example;proto=https" };
    const metadata = await get(base, PATH, headers);
    expect(metadata.status).toBe(404);
    expect(metadata.body).toBe("");
    const unauthorized = await get(base, `/mcp/${WORKSPACE}`, headers);
    expect(unauthorized.status).toBe(401);
    expect(unauthorized.headers["www-authenticate"]).toBeUndefined();
  });

  it("serves only GET metadata", async () => {
    const base = await discovery(ISSUER);
    const response = await fetch(`${base}${PATH}`, { method: "POST" });
    expect(response.status).toBe(405);
    expect(response.headers.get("allow")).toBe("GET");
  });

  it.each(["HTTPS://HUB.EXAMPLE.COM:443/", "http://localhost:8080/", "http://127.0.0.1:8080/", "http://[::1]:8080/"])(
    "uses the same configured issuer in both SDK-readable documents for %s", async publicUrl => {
      const config = resolveCoreHubConfig({ HUB_AUTH_TOKEN: "test-secret", HUB_PUBLIC_URL: publicUrl, PORT: "0" }, ":memory:");
      const hub = await createTeamHub({ ...config, github: { clientId: "Iv23liLW6D5SqP77El3z" }, log: () => {} });
      try {
        const base = await discovery(parseHubPublicUrl(publicUrl));
        const resource = OAuthProtectedResourceMetadataSchema.parse(await (await fetch(`${base}${PATH}`)).json());
        const authorization = OAuthMetadataSchema.parse(await (await fetch(
          `http://127.0.0.1:${hub.port}/.well-known/oauth-authorization-server`,
        )).json());
        expect(resource.authorization_servers).toEqual([authorization.issuer]);
        expect(authorization.issuer).toBe(new URL(publicUrl).origin);
      } finally { await hub.stop(); }
    },
  );
});

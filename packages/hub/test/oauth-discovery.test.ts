import { request } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { OAUTH_AUTHORIZATION_SERVER_METADATA_PATH } from "@uberblick/schema/oauth";
import { resolveCoreHubConfig } from "../src/config.js";
import { silentLogger } from "../src/log.js";
import { createHub, type Hub } from "../src/server.js";
import { createTeamHub } from "../src/team.js";
import type { TeamHubConfig } from "../src/team-config.js";

const ISSUER = "https://hub.example.com";
const github = { clientId: "Iv1.0123456789abcdef", fetch: async () => { throw new Error("discovery must not contact GitHub"); } };
const hubs: Hub[] = [];

afterEach(async () => {
  for (const hub of hubs.splice(0)) await hub.stop();
});

async function team(config: Partial<TeamHubConfig> = {}) {
  const hub = await createTeamHub({ authSecret: "secret", databasePath: ":memory:", port: 0,
    log: silentLogger, ...config });
  hubs.push(hub);
  return hub;
}

function metadata(hub: Hub, headers: Record<string, string> = {}, method = "GET") {
  return new Promise<{ status: number; contentType: string | undefined; allow: string | undefined; body: string }>((resolve, reject) => {
    const outgoing = request({ hostname: "127.0.0.1", port: hub.port,
      path: OAUTH_AUTHORIZATION_SERVER_METADATA_PATH, method, headers }, (response) => {
      const chunks: Buffer[] = [];
      response.on("data", chunk => chunks.push(Buffer.from(chunk)));
      response.on("error", reject);
      response.on("end", () => resolve({ status: response.statusCode!, contentType: response.headers["content-type"],
        allow: response.headers.allow, body: Buffer.concat(chunks).toString("utf8") }));
    });
    outgoing.on("error", reject);
    outgoing.end();
  });
}

function expectedMetadata() {
  return {
    issuer: ISSUER,
    authorization_endpoint: `${ISSUER}/oauth/authorize`,
    token_endpoint: `${ISSUER}/oauth/token`,
    registration_endpoint: `${ISSUER}/oauth/register`,
    response_types_supported: ["code"],
    grant_types_supported: ["authorization_code", "refresh_token"],
    code_challenge_methods_supported: ["S256"],
    token_endpoint_auth_methods_supported: ["none"],
    client_id_metadata_document_supported: true,
    scopes_supported: ["docs:read", "docs:write"],
  };
}

describe("authorization server discovery over HTTP", () => {
  it("advertises exactly the configured OAuth contract without authenticating", async () => {
    const config = resolveCoreHubConfig({ HUB_AUTH_TOKEN: "secret", HUB_PUBLIC_URL: `${ISSUER}/`, PORT: "0" }, ":memory:");
    const hub = await team({ ...config, github });
    const response = await metadata(hub);
    expect(response.status).toBe(200);
    expect(response.contentType).toBe("application/json");
    expect(JSON.parse(response.body)).toEqual(expectedMetadata());
  });

  it.each([
    { Host: "attacker.example" },
    { "X-Forwarded-Host": "attacker.example" },
    { "X-Forwarded-Proto": "http" },
    { Forwarded: "host=attacker.example;proto=http" },
  ])("ignores forged origin headers %j", async (headers) => {
    const hub = await team({ publicUrl: ISSUER, github });
    const response = await metadata(hub, headers);
    expect(response.status).toBe(200);
    expect(JSON.parse(response.body)).toEqual(expectedMetadata());
  });

  it.each([
    { github },
    { publicUrl: ISSUER },
    {},
  ])("returns no metadata when team configuration is incomplete %j", async (config) => {
    const hub = await team(config);
    const response = await metadata(hub, { Host: "attacker.example", "X-Forwarded-Host": "attacker.example",
      "X-Forwarded-Proto": "https", Forwarded: "host=attacker.example;proto=https" });
    expect(response.status).toBe(404);
    expect(response.body).toBe("");
  });

  it("returns an explicit 404 on the embedded core even when it has a public URL", async () => {
    const hub = await createHub({ authSecret: "secret", databasePath: ":memory:", port: 0, publicUrl: ISSUER, log: silentLogger });
    hubs.push(hub);
    const response = await metadata(hub);
    expect(response.status).toBe(404);
    expect(response.body).toBe("");
  });

  it("restricts configured discovery to GET", async () => {
    const hub = await team({ publicUrl: ISSUER, github });
    const response = await metadata(hub, {}, "POST");
    expect(response.status).toBe(405);
    expect(response.allow).toBe("GET");
    expect(response.body).toBe("");
  });
});

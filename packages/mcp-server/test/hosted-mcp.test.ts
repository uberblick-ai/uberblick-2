import { once } from "node:events";
import { createServer, type IncomingHttpHeaders, type RequestListener, type Server } from "node:http";
import { afterEach, describe, expect, it, vi } from "vitest";
import { discoverHostedMcp } from "../src/hosted-mcp.js";
import { handleProtectedResourceMetadata } from "../src/oauth-discovery.js";

const WORKSPACE = "722007fa-8921-45ee-a580-e20311030fef";
const OTHER_WORKSPACE = "00000000-0000-0000-0000-000000000000";
const ISSUER = "https://public.example.com";
const RESOURCE = `${ISSUER}/mcp/${WORKSPACE}`;
const METADATA_PATH = `/.well-known/oauth-protected-resource/mcp/${WORKSPACE}`;
const servers: Server[] = [];

async function serve(handler: RequestListener): Promise<string> {
  const server = createServer(handler);
  servers.push(server);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("missing HTTP address");
  return `http://127.0.0.1:${address.port}`;
}

afterEach(async () => {
  vi.restoreAllMocks();
  for (const server of servers.splice(0)) {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  }
});

describe("hosted MCP discovery", () => {
  it("uses public workspace metadata at the sync origin, without credentials or a cached answer", async () => {
    const requests: { url: string | undefined; headers: IncomingHttpHeaders }[] = [];
    let issuer: string | undefined = ISSUER;
    const base = await serve((request, response) => {
      requests.push({ url: request.url, headers: request.headers });
      handleProtectedResourceMetadata(issuer, request, response);
    });
    const hub = base.replace("http:", "ws:");
    const env = { HUB_AUTH_TOKEN: "private-local-secret", UB_HUB_TOKEN: "private-stored-secret" };
    expect(await discoverHostedMcp(`${hub}/custom-sync-path`, `team-${WORKSPACE}`, 1_000, env)).toBe(RESOURCE);
    issuer = undefined;
    expect(await discoverHostedMcp(`${hub}/custom-sync-path`, WORKSPACE, 1_000, env)).toBeNull();
    expect(requests).toHaveLength(2);
    for (const request of requests) {
      expect(request.url).toBe(METADATA_PATH);
      expect(request.headers.authorization).toBeUndefined();
      expect(request.headers.cookie).toBeUndefined();
      expect(request.headers["cache-control"]).toBe("no-cache");
      expect(JSON.stringify(request)).not.toContain("private-");
    }
  });

  it("allows a validated loopback HTTP issuer", async () => {
    const resource = `http://localhost:8080/mcp/${WORKSPACE}`;
    const base = await serve((_request, response) => response.end(JSON.stringify({ resource })));
    expect(await discoverHostedMcp(base, WORKSPACE, 1_000.5, {})).toBe(resource);
  });

  it.each(["HTTPS://PUBLIC.EXAMPLE.COM", "https://public.example.com:443"])(
    "normalizes an origin accepted by HUB_PUBLIC_URL validation: %s", async issuer => {
      const base = await serve((_request, response) => response.end(JSON.stringify({ resource: `${issuer}/mcp/${WORKSPACE}` })));
      expect(await discoverHostedMcp(base, WORKSPACE, 1_000, {})).toBe(RESOURCE);
    },
  );

  it.each([
    null,
    [],
    {},
    { resource: 5 },
    { resource: `${ISSUER}/mcp/${OTHER_WORKSPACE}` },
    { resource: `${ISSUER}/mcp/team-${WORKSPACE}` },
    { resource: `${RESOURCE}/` },
    { resource: `${RESOURCE}?token=secret` },
    { resource: `${RESOURCE}#fragment` },
    { resource: `http://remote.example.com/mcp/${WORKSPACE}` },
    { resource: `https://user:secret@public.example.com/mcp/${WORKSPACE}` },
    { resource: `https://public.example.com/nested/../mcp/${WORKSPACE}` },
    { resource: `https://public.example.com//mcp/${WORKSPACE}` },
    { resource: `https://public.example.com\n/mcp/${WORKSPACE}` },
    { resource: `https://public.example.com?/mcp/${WORKSPACE}` },
    { resource: `https://public.example.com#/mcp/${WORKSPACE}` },
  ])("does not expose an invalid or mismatched answer: %j", async metadata => {
    const base = await serve((_request, response) => response.end(JSON.stringify(metadata)));
    expect(await discoverHostedMcp(base, WORKSPACE, 1_000, {})).toBeNull();
  });

  it.each(["ws://remote.example.com/ws", "http://remote.example.com", "wss://user:secret@hub.example/ws", "not a hub", ""]) (
    "refuses insecure or invalid endpoints before any request: %s", async hub => {
      const fetch = vi.spyOn(globalThis, "fetch");
      expect(await discoverHostedMcp(hub, WORKSPACE, 1_000, {})).toBeNull();
      expect(fetch).not.toHaveBeenCalled();
    },
  );

  it("refuses an invalid workspace before any request", async () => {
    const fetch = vi.spyOn(globalThis, "fetch");
    expect(await discoverHostedMcp("wss://hub.example/ws", "invalid", 1_000, {})).toBeNull();
    expect(fetch).not.toHaveBeenCalled();
  });

  it("does not follow a redirect or contact its destination", async () => {
    let destinationRequests = 0;
    const destination = await serve((_request, response) => {
      destinationRequests++;
      response.end(JSON.stringify({ resource: RESOURCE }));
    });
    const base = await serve((_request, response) => {
      response.writeHead(302, { Location: `${destination}${METADATA_PATH}` });
      response.end();
    });
    expect(await discoverHostedMcp(base, WORKSPACE, 1_000, {})).toBeNull();
    expect(destinationRequests).toBe(0);
  });

  it("treats malformed JSON and connection failure as no hosted access", async () => {
    let fail = false;
    const base = await serve((request, response) => {
      if (fail) request.socket.destroy();
      else response.end("not JSON");
    });
    expect(await discoverHostedMcp(base, WORKSPACE, 1_000, {})).toBeNull();
    fail = true;
    expect(await discoverHostedMcp(base, WORKSPACE, 1_000, {})).toBeNull();
  });

  it.each([false, true])("bounds headers and body with a fractional timeout (body stalled: %s)", async headers => {
    let close: Promise<unknown> | undefined;
    const base = await serve((_request, response) => {
      close = once(response, "close");
      if (headers) {
        response.writeHead(200, { "Content-Type": "application/json" });
        response.write('{"resource":');
      }
    });
    expect(await discoverHostedMcp(base, WORKSPACE, 100.5, {})).toBeNull();
    expect(close).toBeDefined();
    await close;
  });

  it("cancels a non-success response body instead of waiting for it", async () => {
    let close: Promise<unknown> | undefined;
    const base = await serve((_request, response) => {
      close = once(response, "close");
      response.writeHead(404);
      response.write("hosted access unavailable");
    });
    expect(await discoverHostedMcp(base, WORKSPACE, 1_000, {})).toBeNull();
    expect(close).toBeDefined();
    await close;
  });
});

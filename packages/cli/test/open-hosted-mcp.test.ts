import { handleProtectedResourceMetadata } from "@uberblick/mcp-server/oauth-discovery";
import { afterEach, describe, expect, it } from "vitest";
import { localBrowserKey } from "../src/browser-key.js";
import { pointAt } from "./helpers.js";
import {
  WORKSPACE, authMessage, bearer, cleanUp, configured, freePort,
  getWithHost, holdDefaultHub, open, startHub,
} from "./open-fixtures.js";

afterEach(cleanUp);

describe("ub open hosted MCP discovery", () => {
  it("serves fresh public metadata only through the authenticated workspace boundary", async () => {
    const { box, env } = configured();
    const hub = await startHub(box);
    pointAt(box, `ws://127.0.0.1:${hub.port}`);
    let issuer: string | undefined = "https://public.example.test";
    const requests: { path: string; authorization: string | undefined }[] = [];
    const handlers = hub.server.httpServer.listeners("request");
    hub.server.httpServer.removeAllListeners("request");
    hub.server.httpServer.on("request", (request, response) => {
      if (request.url?.startsWith("/.well-known/oauth-protected-resource/mcp/")) {
        requests.push({ path: request.url, authorization: request.headers.authorization });
        handleProtectedResourceMetadata(issuer, request, response);
        return;
      }
      for (const handler of handlers) handler.call(hub.server.httpServer, request, response);
    });
    const app = await open(box, ["--port", String(await freePort())], env);
    const path = `${app.url}api/hosted-mcp`;
    const token = await authMessage(localBrowserKey(WORKSPACE, box.env), "read-only");
    const headers = bearer(token);
    expect((await fetch(path)).status).toBe(401);
    expect((await fetch(path, { headers: { authorization: `Bearer ${token}` } })).status).toBe(401);
    expect((await getWithHost(path, "attacker.example", token)).status).toBe(421);
    expect((await fetch(`${path}?token=${encodeURIComponent(token)}`, { headers })).status).toBe(401);
    expect((await fetch(`${path}?workspace=another-workspace`, { headers })).status).toBe(401);
    expect((await fetch(path, { method: "POST", headers })).status).toBe(405);
    expect(requests).toEqual([]);

    const reading = await fetch(`${path}?workspace=${WORKSPACE}`, { headers });
    expect(reading.status).toBe(200);
    expect(reading.headers.get("cache-control")).toBe("no-store");
    expect(reading.headers.get("access-control-allow-origin")).toBeNull();
    expect(await reading.json()).toEqual({ hostedMcp: `${issuer}/mcp/${WORKSPACE}` });
    expect(requests).toEqual([{ path: `/.well-known/oauth-protected-resource/mcp/${WORKSPACE}`, authorization: undefined }]);

    issuer = undefined;
    expect(await (await fetch(path, { headers })).json()).toEqual({ hostedMcp: null });
    issuer = "https://changed.example.test";
    expect(await (await fetch(path, { headers })).json()).toEqual({ hostedMcp: `${issuer}/mcp/${WORKSPACE}` });
  });

  it("returns no hosted URL for a local workspace", async () => {
    await holdDefaultHub();
    const { box, env } = configured();
    const app = await open(box, ["--port", String(await freePort())], env);
    const headers = bearer(await authMessage(localBrowserKey(WORKSPACE, box.env)));
    expect(await (await fetch(`${app.url}api/hosted-mcp`, { headers })).json()).toEqual({ hostedMcp: null });
  });
});

import { defaultWorkspaceDatabasePath } from "@uberblick/mcp-server";
import { MirrorStore } from "../../mcp-server/src/store.js";
import { afterEach, describe, expect, it } from "vitest";
import { localBrowserKey } from "../src/browser-key.js";
import { pointAt } from "./helpers.js";
import {
  WORKSPACE, authMessage, bearer, cleanUp, configured, freePort,
  getWithHost, holdDefaultHub, open, startHub,
} from "./open-fixtures.js";

afterEach(cleanUp);

describe("ub open machine-local settings", () => {
  it("protects the local boundary and shares read-only retention changes with live peers and a restarted browser server", async () => {
    const { box, env } = configured();
    const hub = await startHub(box);
    pointAt(box, `ws://127.0.0.1:${hub.port}`);
    const port = await freePort();
    const app = await open(box, ["--port", String(port)], env);
    const path = `${app.url}api/local-settings`;
    const token = await authMessage(localBrowserKey(WORKSPACE, box.env), "read-only");
    const headers = bearer(token);
    const mutationHeaders = { ...headers, origin: app.url.slice(0, -1), "content-type": "application/json" };
    expect((await fetch(path)).status).toBe(401);
    expect((await fetch(path, { headers: { authorization: `Bearer ${token}` } })).status).toBe(401);
    expect((await getWithHost(path, "attacker.example", token)).status).toBe(421);
    expect((await fetch(`${path}?token=${encodeURIComponent(token)}`, { headers })).status).toBe(401);
    expect((await fetch(`${path}?workspace=another-workspace`, { headers })).status).toBe(401);
    const initial = await fetch(path, { headers });
    expect(initial.status).toBe(200);
    expect(initial.headers.get("cache-control")).toBe("no-store");
    expect(initial.headers.get("access-control-allow-origin")).toBeNull();
    expect(await initial.json()).toEqual({
      retention: { mode: "recent", days: 30, keepNamed: true },
      size: { bytes: expect.any(Number), usedFraction: expect.any(Number) },
    });
    expect((await fetch(path, { method: "POST", headers,
      body: JSON.stringify({ retention: { mode: "named" } }) })).status).toBe(403);
    expect((await fetch(path, { method: "POST", headers: { ...mutationHeaders, origin: "https://attacker.example" },
      body: JSON.stringify({ retention: { mode: "named" } }) })).status).toBe(403);
    expect((await fetch(path, { method: "DELETE", headers })).status).toBe(405);
    for (const body of [
      {}, { retention: { mode: "recent", days: 365, keepNamed: true } },
      { retention: { mode: "everything" }, workspace: "another-workspace" },
      { retention: { mode: "named", keepNamed: false } },
    ]) {
      expect((await fetch(path, { method: "POST", headers: mutationHeaders, body: JSON.stringify(body) })).status).toBe(400);
    }
    expect((await fetch(path, { method: "POST", headers: mutationHeaders, body: "{" })).status).toBe(400);
    expect((await fetch(path, { method: "POST", headers: mutationHeaders, body: " ".repeat(4097) })).status).toBe(400);

    const mcp = new MirrorStore(defaultWorkspaceDatabasePath(WORKSPACE, box.env), WORKSPACE);
    try {
      const logSize = mcp.logSize();
      const pending = mcp.pendingRooms();
      for (const retention of [
        { mode: "named" }, { mode: "recent", days: 7, keepNamed: false },
        { mode: "recent", days: 90, keepNamed: true }, { mode: "everything" },
      ]) {
        const changed = await fetch(path, { method: "POST", headers: mutationHeaders, body: JSON.stringify({ retention }) });
        expect(changed.status).toBe(200);
        expect(await changed.json()).toMatchObject({ retention });
        expect(mcp.readHistoryRetention()).toEqual(retention);
      }
      expect(mcp.logSize()).toBe(logSize);
      expect(mcp.pendingRooms()).toEqual(pending);
      mcp.setHistoryRetention({ mode: "recent", days: 30, keepNamed: false });
      expect(await (await fetch(path, { headers })).json()).toMatchObject({ retention: { mode: "recent", days: 30, keepNamed: false } });
      expect((await app.interrupt()).status).toBe(0);
      const restarted = await open(box, ["--port", String(port)], env);
      expect(await (await fetch(`${restarted.url}api/local-settings`, { headers })).json())
        .toMatchObject({ retention: { mode: "recent", days: 30, keepNamed: false } });
    } finally { mcp.close(); }
  });

  it("reports size alone for local-only workspaces and refuses retention changes", async () => {
    await holdDefaultHub();
    const { box, env } = configured();
    const app = await open(box, ["--port", String(await freePort())], env);
    const path = `${app.url}api/local-settings`;
    const headers = bearer(await authMessage(localBrowserKey(WORKSPACE, box.env)));
    expect(await (await fetch(path, { headers })).json()).toEqual({
      size: { bytes: expect.any(Number), usedFraction: expect.any(Number) },
    });
    const refused = await fetch(path, { method: "POST",
      headers: { ...headers, origin: app.url.slice(0, -1), "content-type": "application/json" },
      body: JSON.stringify({ retention: { mode: "everything" } }),
    });
    expect(refused.status).toBe(400);
    expect(await refused.json()).toEqual({ error: "local_only_workspace" });
  });
});

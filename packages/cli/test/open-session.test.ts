/**
 * `ub open` hands the page its admission only through the address it printed:
 * the launch fragment trades once for a session, and the session buys
 * short-lived room tokens. Loopback requests without one learn no key.
 */

import { createHash } from "node:crypto";
import { readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { resolveStorage } from "@uberblick/mcp-server/storage";
import { importRootSecret, verifyToken } from "@uberblick/schema/token";
import { wrapToken } from "@uberblick/schema/protocol";
import { afterEach, describe, expect, it } from "vitest";
import { localBrowserKey } from "../src/browser-key.js";
import { LAUNCH_LIFETIME_MS, LaunchSecret } from "../src/open-session.js";
import { WORKSPACE, authMessage, cleanUp, configured, freePort, get, open } from "./open-fixtures.js";

afterEach(cleanUp);

const json = { "content-type": "application/json" };

function client(url: string) {
  const origin = new URL(url).origin;
  const post = async (path: string, body: object, headers: Record<string, string> = {}) => {
    const response = await fetch(`${url}${path}`, { method: "POST", headers: { origin, ...json, ...headers }, body: JSON.stringify(body) });
    return { status: response.status, body: await response.json() as Record<string, unknown> };
  };
  return {
    exchange: (launch: string | null) => post("api/session", { launch }),
    roomToken: (headers: Record<string, string>, workspace = WORKSPACE) =>
      post("api/room-token", { workspace, subject: "session-test" }, headers),
    access: (headers: Record<string, string>) => post("api/access", { operation: "own-role", workspaceId: WORKSPACE }, headers),
  };
}

describe("ub open browser sessions", () => {
  it("serves no key without a session and trades the printed launch secret exactly once", async () => {
    const { box, env } = configured();
    const app = await open(box, ["--port", String(await freePort())], env);
    try {
      const key = localBrowserKey(WORKSPACE, box.env);
      const document = await (await get(`${app.url}uberblick-config.json`)).text();
      expect(document).not.toContain(key);
      expect(JSON.parse(document)).toMatchObject({ hubAuthToken: "", workspaces: [WORKSPACE] });
      expect(Object.keys(JSON.parse(document).servedWorkspaces[WORKSPACE]).sort()).toEqual(["name", "remoteHubUrl"]);

      const local = client(app.url);
      // Even a room token signed by the on-disk key needs the page's session.
      const signed = { authorization: `Bearer ${await authMessage(key)}` };
      expect(await local.access({})).toEqual({ status: 401, body: { error: "unauthorized" } });
      expect(await local.access(signed)).toEqual({ status: 401, body: { error: "session_required" } });
      expect(await local.roomToken({})).toEqual({ status: 401, body: { error: "session_required" } });
      expect(await local.roomToken({ "x-uberblick-session": "x".repeat(43) })).toEqual({ status: 401, body: { error: "session_required" } });

      expect(app.launch).toMatch(/^[A-Za-z0-9_-]{43}$/);
      expect(await local.exchange("y".repeat(43))).toEqual({ status: 401, body: { error: "launch_refused" } });
      const wrongOrigin = await fetch(`${app.url}api/session`, { method: "POST",
        headers: { ...json, origin: "http://attacker.example" }, body: JSON.stringify({ launch: app.launch }) });
      expect(wrongOrigin.status).toBe(403);

      const traded = await local.exchange(app.launch);
      expect(traded.status).toBe(200);
      const session = traded.body.session;
      expect(session).toMatch(/^[A-Za-z0-9_-]{43}$/);
      expect(await local.exchange(app.launch)).toEqual({ status: 401, body: { error: "launch_refused" } });

      const withSession = { "x-uberblick-session": session as string };
      const minted = await local.roomToken(withSession);
      expect(minted.status).toBe(200);
      const token = minted.body.token as string;
      expect(await verifyToken(await importRootSecret(key), token)).toMatchObject({
        typ: "room", sub: "session-test", workspace: WORKSPACE, scope: "read-write", kid: null,
      });
      expect(await local.roomToken(withSession, "11111111-1111-4111-8111-111111111111"))
        .toEqual({ status: 400, body: { error: "invalid_request" } });
      // The bridge now answers from its upstream reading instead of refusing the caller.
      const bridged = await local.access({ authorization: `Bearer ${wrapToken(token)}`, ...withSession });
      expect(bridged.status).not.toBe(401);
      expect(bridged.body).not.toHaveProperty("error");

      // Persisted hashed and owner-only, never as the token itself.
      const directory = join(resolveStorage({ env: box.env }).configDir, "browser-sessions");
      const name = createHash("sha256").update(session as string).digest("hex");
      expect(readdirSync(directory)).toContain(name);
      expect(readdirSync(directory)).not.toContain(session);
      expect(statSync(directory).mode & 0o777).toBe(0o700);
      expect(statSync(join(directory, name)).mode & 0o777).toBe(0o600);
    } finally {
      expect((await app.interrupt()).status).toBe(0);
    }
  });

  it("keeps a session across a restart, which prints a new launch secret", async () => {
    const { box, env } = configured();
    const port = await freePort();
    const first = await open(box, ["--port", String(port)], env);
    let session: string;
    try {
      session = (await client(first.url).exchange(first.launch)).body.session as string;
    } finally {
      expect((await first.interrupt()).status).toBe(0);
    }
    const second = await open(box, ["--port", String(port)], env);
    try {
      const local = client(second.url);
      expect(second.launch).not.toBe(first.launch);
      expect(await local.exchange(first.launch)).toEqual({ status: 401, body: { error: "launch_refused" } });
      expect((await local.roomToken({ "x-uberblick-session": session })).status).toBe(200);
    } finally {
      expect((await second.interrupt()).status).toBe(0);
    }
  });

  it("refuses a launch secret after its lifetime, and any other value", () => {
    let now = 1_000_000;
    const expired = new LaunchSecret(() => now);
    now += LAUNCH_LIFETIME_MS;
    expect(expired.take(expired.value)).toBe(false);

    const fresh = new LaunchSecret(() => now);
    now += LAUNCH_LIFETIME_MS - 1;
    const altered = `${fresh.value.slice(0, -1)}${fresh.value.endsWith("A") ? "B" : "A"}`;
    expect(fresh.take(altered)).toBe(false);
    expect(fresh.take(undefined)).toBe(false);
    expect(fresh.take(fresh.value)).toBe(true);
    expect(fresh.take(fresh.value)).toBe(false);
  });
});

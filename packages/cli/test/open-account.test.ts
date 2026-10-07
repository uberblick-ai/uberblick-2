/** The account projection is read-only, live, and contains no private fields. */
import { chmodSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { removeHubLogin, writeHubLogin, type StoredHubLogin } from "@uberblick/hub/auth-store";
import type { ServingSyncStatus } from "@uberblick/mcp-server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { requestAccount } from "../src/open-account.js";
import { cleanUp, configured, configDir, WORKSPACE } from "./open-fixtures.js";

const ORIGIN = "https://account-hub.example";

function login(handle = "account-person"): StoredHubLogin {
  const principalId = crypto.randomUUID();
  return { identity: { id: principalId, githubAccountId: "1234", githubUsername: handle }, credential: {
    key: Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("base64url"),
    record: { id: crypto.randomUUID(), principalId, deviceId: crypto.randomUUID(), workspaces: [WORKSPACE],
      issuedAt: Date.now(), revokedAt: null },
  } };
}

async function rig() {
  const { box } = configured();
  const stored = login();
  await writeHubLogin(ORIGIN, stored, box.env);
  const binding = { workspaceId: WORKSPACE, hubUrl: `${ORIGIN}/proxy/ws`, env: box.env };
  const read = (reason: () => ServingSyncStatus["notSharedReason"] = () => null) => requestAccount(binding, reason, new AbortController().signal);
  return { box, stored, binding, read };
}

afterEach(async () => { vi.restoreAllMocks(); await cleanUp(); });

describe("ub open: account projection", () => {
  it("projects only the handle and state after a live bound-workspace check", async () => {
    const { stored, read } = await rig();
    const fetch = vi.spyOn(globalThis, "fetch").mockResolvedValue(Response.json({ status: "ok", role: "admin",
      credential: stored.credential, token: "private-upstream-token", signingSecret: "private-signing-secret" }));
    const answer = await read();
    expect(answer).toEqual({ state: "signed-in", handle: "account-person" });
    expect(JSON.stringify(answer)).not.toContain(stored.credential.key);
    expect(JSON.stringify(answer)).not.toContain(stored.identity.id);
    expect(JSON.stringify(answer)).not.toContain(stored.credential.record.deviceId);
    expect(fetch).toHaveBeenCalledOnce();
    expect(fetch.mock.calls[0]?.[0]).toBe(`${ORIGIN}/auth/manage`);
    const request = JSON.parse(String(fetch.mock.calls[0]?.[1]?.body));
    expect(request).toMatchObject({ operation: "own-role", workspaceId: WORKSPACE });
  });

  it("returns no handle for local, missing, unreadable or refused stores without contacting a hub", async () => {
    const { box, binding, read } = await rig();
    const fetch = vi.spyOn(globalThis, "fetch");
    expect(await requestAccount({ ...binding, hubUrl: null }, () => null, new AbortController().signal)).toEqual({ state: "signed-out" });
    const path = join(configDir(box), "credentials.json");
    rmSync(path);
    expect(await read()).toEqual({ state: "signed-out" });
    writeFileSync(path, "{", { mode: 0o600 });
    expect(await read()).toEqual({ state: "unavailable" });
    writeFileSync(path, JSON.stringify({ hubLogins: { [ORIGIN]: login() } }));
    chmodSync(path, 0o644);
    expect(await read()).toEqual({ state: "unavailable" });
    chmodSync(path, 0o600);
    const privateLogin = login();
    privateLogin.identity.githubUsername = privateLogin.credential.key;
    writeFileSync(path, JSON.stringify({ hubLogins: { [ORIGIN]: privateLogin } }));
    expect(await read()).toEqual({ state: "unavailable" });
    expect(fetch).not.toHaveBeenCalled();
  });

  it("returns no handle for hub refusal, missing or invalid answers and network failures", async () => {
    const { read } = await rig();
    const fetch = vi.spyOn(globalThis, "fetch");
    for (const [status, body, state] of [
      [401, { status: "sign-in-required" }, "signed-out"],
      [403, { status: "forbidden" }, "unavailable"],
      [503, { status: "not-configured" }, "unavailable"],
      [200, { status: "ok" }, "unavailable"],
      [200, { status: "ok", role: "owner" }, "unavailable"],
    ] as const) {
      fetch.mockResolvedValueOnce(Response.json(body, { status }));
      expect(await read()).toEqual({ state });
    }
    fetch.mockResolvedValueOnce(new Response("not JSON"));
    expect(await read()).toEqual({ state: "unavailable" });
    fetch.mockRejectedValueOnce(new Error("private transport diagnostics"));
    expect(await read()).toEqual({ state: "unavailable" });
  });

  it("suppresses every live sync refusal before or during account verification", async () => {
    const { read } = await rig();
    const fetch = vi.spyOn(globalThis, "fetch");
    for (const reason of ["no-hub-credentials", "sign-in-required", "no-workspace-access", "credential-store", "renewal-unavailable"] as const) {
      const state = reason === "no-hub-credentials" || reason === "sign-in-required" ? "signed-out" : "unavailable";
      expect(await read(() => reason)).toEqual({ state });
      expect(fetch).not.toHaveBeenCalled();
      let live: ServingSyncStatus["notSharedReason"] = null;
      fetch.mockImplementationOnce(async () => {
        live = reason;
        return Response.json({ status: "ok", role: "member" });
      });
      expect(await read(() => live)).toEqual({ state });
      fetch.mockClear();
    }
  });

  it("never reports a login removed or replaced while the hub is answering", async () => {
    const { box, read } = await rig();
    const fetch = vi.spyOn(globalThis, "fetch").mockImplementationOnce(async () => {
      await removeHubLogin(ORIGIN, box.env);
      return Response.json({ status: "ok", role: "member" });
    });
    expect(await read()).toEqual({ state: "signed-out" });
    await writeHubLogin(ORIGIN, login(), box.env);
    fetch.mockImplementationOnce(async () => {
      await writeHubLogin(ORIGIN, login("replacement-person"), box.env);
      return Response.json({ status: "ok", role: "member" });
    });
    expect(await read()).toEqual({ state: "unavailable" });
  });
});

/** Signed transport and the public projection used by the local Access page. */
import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { StoredHubLogin } from "../src/auth-store.js";
import { ManagementResponseError, manageRequest, sanitizeManagementReply, type ManagementAction } from "../src/management-client.js";
import { SYNC_PROTOCOL_VERSION } from "../src/protocol.js";
import { importCredentialKey, inspectRequestProof } from "../src/token.js";

const WORKSPACE = randomUUID();
const PRINCIPAL = randomUUID();
const DEVICE = randomUUID();
const login: StoredHubLogin = {
  identity: { id: PRINCIPAL, githubAccountId: "1234", githubUsername: "octocat" },
  credential: { key: Buffer.alloc(32, 7).toString("base64url"), record: {
    id: randomUUID(), principalId: PRINCIPAL, deviceId: DEVICE, workspaces: [WORKSPACE],
    issuedAt: Date.now(), revokedAt: null,
  } },
};
const member = { principalId: PRINCIPAL, githubAccountId: "1234", githubUsername: "octocat", role: "member" };
const device = { deviceId: DEVICE, signedInAt: Date.now(), current: true };

afterEach(() => vi.restoreAllMocks());

describe("shared management transport", () => {
  it("binds every target in a 60 second proof with the current protocol and refuses redirects", async () => {
    const action = { operation: "grant-member", workspaceId: WORKSPACE, githubAccountId: "5678", role: "member" } as const;
    const fetch = vi.spyOn(globalThis, "fetch").mockResolvedValue(Response.json({ status: "forbidden" }, { status: 403 }));
    expect(await manageRequest("https://hub.example", action, login)).toEqual({ status: 403, body: { status: "forbidden" } });
    const [url, options] = fetch.mock.calls[0]!;
    expect(url).toBe("https://hub.example/auth/manage");
    expect(options).toMatchObject({ method: "POST", redirect: "error", headers: { "Content-Type": "application/json" } });
    const body = JSON.parse(options!.body as string) as Record<string, unknown>;
    expect(body).toEqual({ ...action, protocolVersion: SYNC_PROTOCOL_VERSION, token: expect.any(String) });
    const proof = await inspectRequestProof(await importCredentialKey(Buffer.from(login.credential.key, "base64url")), body.token as string, action);
    expect(proof).not.toHaveProperty("failure");
    if ("failure" in proof) throw new Error("the target-bound proof was refused");
    expect(proof).toMatchObject({ ...action, kid: login.credential.record.id });
    expect(proof.exp - proof.iat).toBe(60);
    expect(JSON.stringify(body)).not.toContain(login.credential.key);
    expect(options?.signal).toBeInstanceOf(AbortSignal);
  });

  it("diagnoses hub admission with an empty proof when no login exists", async () => {
    const fetch = vi.spyOn(globalThis, "fetch").mockResolvedValue(Response.json({ status: "not-configured" }, { status: 503 }));
    const action = { operation: "list-devices" } as const;
    expect(await manageRequest("https://hub.example", action, null)).toEqual({ status: 503, body: { status: "not-configured" } });
    expect(JSON.parse(fetch.mock.calls[0]![1]!.body as string)).toEqual({ ...action, protocolVersion: SYNC_PROTOCOL_VERSION, token: "" });
  });

  it.each([
    ["over-limit", () => Response.json({ status: "ok", private: "x".repeat(256) }), 64],
    ["non-object", () => Response.json([]), undefined],
    ["non-JSON", () => new Response("private-provider-error"), undefined],
    ["empty body", () => new Response(null), undefined],
  ])("rejects %s replies with only a fixed error", async (_name, response, limit) => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(response());
    const request = manageRequest("https://hub.example", { operation: "list-devices" }, login,
      limit === undefined ? {} : { maxResponseBytes: limit });
    await expect(request).rejects.toThrow(ManagementResponseError);
    await expect(request).rejects.toThrow("hub returned an invalid management response");
  });

  it("cancels an over-limit stream without reading the remainder", async () => {
    const cancel = vi.fn();
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(new ReadableStream({
      start(controller) { controller.enqueue(new Uint8Array(65_537)); }, cancel,
    })));
    await expect(manageRequest("https://hub.example", { operation: "list-devices" }, login)).rejects.toThrow(ManagementResponseError);
    expect(cancel).toHaveBeenCalledOnce();
  });

  it("propagates a caller's cancellation without sending a proof", async () => {
    const controller = new AbortController();
    controller.abort();
    const fetch = vi.spyOn(globalThis, "fetch");
    await expect(manageRequest("https://hub.example", { operation: "list-devices" }, login, { signal: controller.signal })).rejects.toThrow();
    expect(fetch).not.toHaveBeenCalled();
  });
});

describe("management replies exposed to a browser", () => {
  it.each([
    [{ operation: "own-role", workspaceId: WORKSPACE }, { status: "ok", role: "admin" }],
    [{ operation: "resolve-account", workspaceId: WORKSPACE, githubUsername: "octocat" }, { status: "ok", githubAccountId: "1234", githubUsername: "octocat" }],
    [{ operation: "grant-member", workspaceId: WORKSPACE, githubAccountId: "1234" }, { status: "already-member", member }],
    [{ operation: "list-members", workspaceId: WORKSPACE }, { status: "ok", members: [member] }],
    [{ operation: "list-devices" }, { status: "ok", devices: [device] }],
    [{ operation: "revoke-device", deviceId: DEVICE }, { status: "ok" }],
  ] satisfies [ManagementAction, Record<string, unknown>][]) ("projects public %j replies and removes extra secrets", (action, publicBody) => {
    const privateBody: Record<string, unknown> = structuredClone(publicBody);
    privateBody.key = login.credential.key;
    privateBody.token = "private-proof";
    privateBody.message = "private-provider-message";
    if (Array.isArray(privateBody.devices)) privateBody.devices = privateBody.devices.map(value => ({ ...value as Record<string, unknown>, key: "private-device-key", workspaces: [WORKSPACE] }));
    if (Array.isArray(privateBody.members)) privateBody.members = privateBody.members.map(value => ({ ...value as Record<string, unknown>, token: "private-token" }));
    if (typeof privateBody.member === "object") privateBody.member = { ...privateBody.member as Record<string, unknown>, key: "private-member-key" };
    expect(sanitizeManagementReply(action, { status: 200, body: privateBody }, login)).toEqual({ status: 200, body: publicBody });
  });

  it.each([
    [404, "account-not-found"], [503, "lookup-unavailable"], [401, "sign-in-required"], [503, "not-configured"],
  ])("preserves %s %s and drops provider text", (status, state) => {
    expect(sanitizeManagementReply({ operation: "resolve-account", workspaceId: WORKSPACE, githubUsername: "octocat" },
      { status, body: { status: state, message: "private-provider-error", key: login.credential.key } })).toEqual({ status, body: { status: state } });
  });

  it("preserves applied closure failure separately from a last-admin refusal", () => {
    const action = { operation: "remove-member", workspaceId: WORKSPACE, principalId: PRINCIPAL } as const;
    expect(sanitizeManagementReply(action, { status: 500, body: { status: "closure-failed", applied: true, reason: "private" } }))
      .toEqual({ status: 500, body: { status: "closure-failed", applied: true } });
    expect(sanitizeManagementReply(action, { status: 409, body: { status: "last-admin", message: "private" } }))
      .toEqual({ status: 409, body: { status: "last-admin" } });
    expect(() => sanitizeManagementReply(action, { status: 500, body: { status: "closure-failed", applied: false } })).toThrow(ManagementResponseError);
  });

  it("admits only the fixed protocol sentinel with a different valid version", () => {
    const action = { operation: "list-devices" } as const;
    const reply = { status: 409, body: { status: "protocol-mismatch", reason: `protocol-mismatch:${SYNC_PROTOCOL_VERSION + 1}`, key: "private" } };
    expect(sanitizeManagementReply(action, reply)).toEqual({ status: 409, body: { status: "protocol-mismatch", reason: `protocol-mismatch:${SYNC_PROTOCOL_VERSION + 1}` } });
    expect(() => sanitizeManagementReply(action, { ...reply, body: { ...reply.body, reason: "private-provider-error" } })).toThrow(ManagementResponseError);
  });

  it.each([
    [{ operation: "list-devices" }, { status: "ok", devices: [{ ...device, current: false }] }],
    [{ operation: "list-devices" }, { status: "ok", devices: [{ ...device, signedInAt: "private" }] }],
    [{ operation: "list-devices" }, { status: "ok", devices: [device, device] }],
    [{ operation: "list-devices" }, { status: "ok", devices: [{ ...device, deviceId: "private-token" }] }],
    [{ operation: "list-members", workspaceId: WORKSPACE }, { status: "ok", members: [{ ...member, githubUsername: "private/provider" }] }],
    [{ operation: "list-members", workspaceId: WORKSPACE }, { status: "ok", members: [member, member] }],
    [{ operation: "own-role", workspaceId: WORKSPACE }, { status: "ok", role: "owner" }],
    [{ operation: "grant-member", workspaceId: WORKSPACE, githubAccountId: "5678" }, { status: "ok", member }],
    [{ operation: "list-devices" }, { status: "last-admin" }],
  ] satisfies [ManagementAction, Record<string, unknown>][]) ("refuses malformed or mismatched %j replies", (action, body) => {
    expect(() => sanitizeManagementReply(action, { status: 200, body }, login)).toThrow(ManagementResponseError);
  });
});

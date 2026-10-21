/** Signed transport and the public projection used by the local Access page. */
import { generateKeyPairSync, randomUUID } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { StoredHubLogin } from "../src/auth-store.js";
import { ManagementResponseError, manageRequest, sanitizeManagementReply, type ManagementAction } from "../src/management-client.js";
import { SYNC_PROTOCOL_VERSION } from "@uberblick/schema/protocol";
import { importCredentialPublicKey, inspectRequestProof } from "@uberblick/schema/token";

const WORKSPACE = randomUUID();
const PRINCIPAL = randomUUID();
const DEVICE = randomUUID();
const keyPair = generateKeyPairSync("ed25519");
const login: StoredHubLogin = {
  identity: { id: PRINCIPAL, githubAccountId: "1234", githubUsername: "octocat" },
  credential: { key: keyPair.privateKey.export({ type: "pkcs8", format: "der" }).toString("base64url"), record: {
    id: randomUUID(), principalId: PRINCIPAL, deviceId: DEVICE, workspaces: [WORKSPACE],
    issuedAt: Date.now(), revokedAt: null,
  } },
};
const member = { principalId: PRINCIPAL, githubAccountId: "1234", githubUsername: "octocat", role: "member" };
const device = { deviceId: DEVICE, signedInAt: Date.now(), current: true };
const admin = { principalId: PRINCIPAL, githubAccountId: "1234", githubUsername: "octocat",
  workspaces: 0, lastSignedInAt: Date.now(), current: true };
const workspace = { workspaceId: WORKSPACE, status: "active", name: "Example project", members: 2, admins: ["octocat"] };

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
    const publicKey = keyPair.publicKey.export({ format: "jwk" }).x!;
    const proof = await inspectRequestProof(await importCredentialPublicKey(Buffer.from(publicKey, "base64url")), body.token as string, action);
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
    ["over-limit", () => Response.json({ status: "ok", private: "x".repeat(256) }), 64, false],
    ["non-object", () => Response.json([]), undefined, false],
    ["non-JSON", () => new Response("private-provider-error"), undefined, true],
    ["empty body", () => new Response(null), undefined, true],
  ])("rejects %s replies with only a fixed error and transport status", async (_name, response, limit, updateRequired) => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(response());
    const request = manageRequest("https://hub.example", { operation: "list-devices" }, login,
      limit === undefined ? {} : { maxResponseBytes: limit });
    await expect(request).rejects.toThrow(ManagementResponseError);
    await expect(request).rejects.toMatchObject({ message: "hub returned an invalid management response", status: 200, updateRequired });
  });

  it.each([404, 502, 503, 504])("retains HTTP %s on a non-JSON reply without exposing its body", async status => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("private-provider-error", { status }));
    const error: unknown = await manageRequest("https://hub.example", { operation: "own-hub-role" }, login)
      .catch((error: unknown) => error);
    expect(error).toBeInstanceOf(ManagementResponseError);
    expect(error).toMatchObject({ message: "hub returned an invalid management response", updateRequired: true, status });
    expect(JSON.stringify(error)).not.toContain("private-provider-error");
  });

  it("retains HTTP status on a missing response body", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(null, { status: 503 }));
    await expect(manageRequest("https://hub.example", { operation: "own-hub-role" }, login))
      .rejects.toMatchObject({ updateRequired: true, status: 503 });
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

  it("ends a request aborted after the response headers arrive", async () => {
    const controller = new AbortController();
    const reason = new Error("caller cancelled after headers");
    vi.spyOn(globalThis, "fetch").mockImplementation(async () => {
      const response = new Response(new ReadableStream());
      controller.abort(reason);
      return response;
    });
    await expect(manageRequest("https://hub.example", { operation: "list-devices" }, login,
      { signal: controller.signal })).rejects.toBe(reason);
  });
});

describe("management replies exposed to a browser", () => {
  it.each(["0.0.0", "0.4.7", "12.345.6789", `${"1".repeat(60)}.2.3`])(
    "keeps a valid release version %s in a successful device list", hubVersion => {
      expect(sanitizeManagementReply({ operation: "list-devices" }, {
        status: 200, body: { status: "ok", devices: [device], hubVersion },
      }, login)).toEqual({ status: 200, body: { status: "ok", devices: [device], hubVersion } });
    },
  );

  it.each([
    undefined, null, 7, {}, "", "0.4", "v0.4.7", "0.4.7-rc.1", "0.4.7+build", "01.4.7", "0.04.7", "0.4.07",
    " 0.4.7", "0.4.7 ", "0.4.7\n", "0.4.7\r", "0.4.7\r\n", "0.4.7\u2028", "0.4.7\u2029", "0.4.7\u001b[31m",
    "０.4.7", `${"1".repeat(61)}.2.3`, login.credential.key,
  ])("drops an invalid or missing hub version %j without dropping devices", hubVersion => {
    expect(sanitizeManagementReply({ operation: "list-devices" }, {
      status: 200, body: { status: "ok", devices: [device], hubVersion },
    }, login)).toEqual({ status: 200, body: { status: "ok", devices: [device] } });
  });

  it("keeps credential text out of the hub version projection", () => {
    const keyedLogin = { ...login, credential: { ...login.credential, key: "2.3" } };
    expect(sanitizeManagementReply({ operation: "list-devices" }, {
      status: 200, body: { status: "ok", devices: [device], hubVersion: "1.2.3" },
    }, keyedLogin)).toEqual({ status: 200, body: { status: "ok", devices: [device] } });
  });

  it.each([
    [400, "invalid-request"], [401, "sign-in-required"], [403, "forbidden"], [500, "failed"], [503, "not-configured"],
  ])("drops release identity from %s %s device-list refusals", (status, state) => {
    expect(sanitizeManagementReply({ operation: "list-devices" }, {
      status, body: { status: state, hubVersion: "0.4.7" },
    }, login)).toEqual({ status, body: { status: state } });
  });

  it("adds only acceptable device names to the public projection", () => {
    const named = { ...device, deviceName: "agent-server" };
    const upstream = { status: "ok", devices: [{ ...named, key: "private-device-key",
      workspaces: [WORKSPACE], credential: login.credential }], key: login.credential.key };
    expect(sanitizeManagementReply({ operation: "list-devices" }, { status: 200, body: upstream }, login))
      .toEqual({ status: 200, body: { status: "ok", devices: [named] } });
  });

  it.each([undefined, null, 42, {}, "", " ", "x".repeat(254), "host\nname", "host\u202ename",
    "host\u2028name", login.credential.key, `host-${login.credential.key}`])(
    "omits unsafe name metadata without dropping the device", deviceName => {
      expect(sanitizeManagementReply({ operation: "list-devices" }, { status: 200, body: {
        status: "ok", devices: [{ ...device, deviceName }],
      } }, login)).toEqual({ status: 200, body: { status: "ok", devices: [device] } });
    },
  );

  it.each([
    [{ operation: "own-hub-role" }, { status: "ok", role: "admin" }],
    [{ operation: "list-hub-admins" }, { status: "ok", admins: [admin], nextCursor: null }],
    [{ operation: "list-hub-workspaces" }, { status: "ok", workspaces: [workspace], nextCursor: null }],
    [{ operation: "remove-hub-admin", principalId: PRINCIPAL }, { status: "ok" }],
    [{ operation: "suspend-workspace", workspaceId: WORKSPACE }, { status: "ok", workspaceId: WORKSPACE, workspaceStatus: "suspended" }],
    [{ operation: "restore-workspace", workspaceId: WORKSPACE }, { status: "ok", workspaceId: WORKSPACE, workspaceStatus: "active" }],
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
    if (action.operation !== "list-devices") privateBody.hubVersion = "0.4.7";
    if (Array.isArray(privateBody.devices)) privateBody.devices = privateBody.devices.map(value => ({ ...value as Record<string, unknown>, key: "private-device-key", workspaces: [WORKSPACE] }));
    if (Array.isArray(privateBody.members)) privateBody.members = privateBody.members.map(value => ({ ...value as Record<string, unknown>, token: "private-token" }));
    if (Array.isArray(privateBody.admins)) privateBody.admins = privateBody.admins.map(value => ({ ...value as Record<string, unknown>, credential: login.credential }));
    if (Array.isArray(privateBody.workspaces)) privateBody.workspaces = privateBody.workspaces.map(value => ({ ...value as Record<string, unknown>, documents: "private-document-content" }));
    if (typeof privateBody.member === "object") privateBody.member = { ...privateBody.member as Record<string, unknown>, key: "private-member-key" };
    expect(sanitizeManagementReply(action, { status: 200, body: privateBody }, login)).toEqual({ status: 200, body: publicBody });
  });

  it("projects continuation pages without requiring the current admin in every page", () => {
    const other = { ...admin, principalId: WORKSPACE, current: false };
    expect(sanitizeManagementReply({ operation: "list-hub-admins", cursor: "WzFd" },
      { status: 200, body: { status: "ok", admins: [other], nextCursor: null, key: "private" } }, login))
      .toEqual({ status: 200, body: { status: "ok", admins: [other], nextCursor: null } });
    expect(sanitizeManagementReply({ operation: "list-hub-workspaces" },
      { status: 200, body: { status: "ok", workspaces: [workspace], nextCursor: "WzEsMF0" } }, login))
      .toEqual({ status: 200, body: { status: "ok", workspaces: [workspace], nextCursor: "WzEsMF0" } });
    for (const nextCursor of [undefined, "", "private/token", "a".repeat(161), 1, login.credential.key]) {
      expect(() => sanitizeManagementReply({ operation: "list-hub-workspaces" },
        { status: 200, body: { status: "ok", workspaces: [workspace], nextCursor } }, login))
        .toThrow(ManagementResponseError);
    }
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
    const reply = { status: 409, body: { status: "protocol-mismatch", reason: `protocol-mismatch:${SYNC_PROTOCOL_VERSION + 1}`, key: "private", hubVersion: "0.4.7" } };
    expect(sanitizeManagementReply(action, reply)).toEqual({ status: 409, body: { status: "protocol-mismatch", reason: `protocol-mismatch:${SYNC_PROTOCOL_VERSION + 1}` } });
    expect(() => sanitizeManagementReply(action, { ...reply, body: { ...reply.body, reason: "private-provider-error" } })).toThrow(ManagementResponseError);
  });

  it.each([
    [{ operation: "own-hub-role" }, { status: "ok", role: "member" }],
    [{ operation: "list-hub-admins" }, { status: "ok", admins: [{ ...admin, current: false }] }],
    [{ operation: "list-hub-admins" }, { status: "ok", admins: [admin, admin] }],
    [{ operation: "list-hub-admins" }, { status: "ok", admins: [{ ...admin, workspaces: -1 }] }],
    [{ operation: "list-hub-admins" }, { status: "ok", admins: [{ ...admin, lastSignedInAt: "private" }] }],
    [{ operation: "list-hub-workspaces" }, { status: "ok", workspaces: [workspace, workspace] }],
    [{ operation: "list-hub-workspaces" }, { status: "ok", workspaces: [{ ...workspace, members: 1.5 }] }],
    [{ operation: "list-hub-workspaces" }, { status: "ok", workspaces: [{ ...workspace, admins: ["private/token"] }] }],
    [{ operation: "list-hub-workspaces" }, { status: "ok", workspaces: [{ ...workspace, status: undefined }] }],
    [{ operation: "list-hub-workspaces" }, { status: "ok", workspaces: [{ ...workspace, status: "private-provider-text" }] }],
    [{ operation: "suspend-workspace", workspaceId: WORKSPACE }, { status: "ok", workspaceId: PRINCIPAL, workspaceStatus: "suspended" }],
    [{ operation: "suspend-workspace", workspaceId: WORKSPACE }, { status: "ok", workspaceId: WORKSPACE, workspaceStatus: "active" }],
    [{ operation: "restore-workspace", workspaceId: WORKSPACE }, { status: "ok", workspaceId: WORKSPACE, workspaceStatus: "suspended" }],
    [{ operation: "restore-workspace", workspaceId: WORKSPACE }, { status: "ok", workspaceId: WORKSPACE }],
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

  it("keeps unsigned display names out of the hub workspace projection without dropping rows", () => {
    for (const name of [undefined, 7, "", " name ", "line\nname", login.credential.key]) {
      expect(sanitizeManagementReply({ operation: "list-hub-workspaces" }, { status: 200,
        body: { status: "ok", workspaces: [{ ...workspace, name }], nextCursor: null } }, login)).toEqual({ status: 200,
        body: { status: "ok", workspaces: [{ workspaceId: WORKSPACE, status: "active", members: 2, admins: ["octocat"] }], nextCursor: null } });
    }
  });

  it("preserves fixed hub admin removal refusals without provider text", () => {
    const action = { operation: "remove-hub-admin", principalId: PRINCIPAL } as const;
    for (const [status, state] of [[409, "self-admin"], [409, "last-admin"], [404, "admin-not-found"]] as const) {
      expect(sanitizeManagementReply(action, { status, body: { status: state, key: login.credential.key } }))
        .toEqual({ status, body: { status: state } });
    }
    expect(sanitizeManagementReply({ operation: "list-hub-admins" }, { status: 200,
      body: { status: "ok", admins: [{ ...admin, lastSignedInAt: null }], nextCursor: null } }, login).body.admins)
      .toEqual([{ ...admin, lastSignedInAt: null }]);
  });

  it("keeps suspension results and fixed failures distinct from arbitrary upstream text", () => {
    for (const operation of ["suspend-workspace", "restore-workspace"] as const) {
      const action = { operation, workspaceId: WORKSPACE };
      expect(sanitizeManagementReply(action, { status: 404,
        body: { status: "workspace-not-found", message: "private", key: login.credential.key } }))
        .toEqual({ status: 404, body: { status: "workspace-not-found" } });
    }
    expect(sanitizeManagementReply({ operation: "list-hub-workspaces" }, { status: 200,
      body: { status: "ok", workspaces: [{ ...workspace, status: "suspended" }], nextCursor: null } }, login).body.workspaces)
      .toEqual([{ ...workspace, status: "suspended" }]);
    const action = { operation: "suspend-workspace", workspaceId: WORKSPACE } as const;
    expect(sanitizeManagementReply(action, { status: 500,
      body: { status: "closure-failed", applied: true, message: "private" } }))
      .toEqual({ status: 500, body: { status: "closure-failed", applied: true } });
    expect(() => sanitizeManagementReply(action, { status: 500,
      body: { status: "closure-failed", applied: false } })).toThrow(ManagementResponseError);
  });
});

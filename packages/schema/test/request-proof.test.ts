/** HTTP proof authority stays separate from rooms and bound to its exact request. */
import { describe, expect, it } from "vitest";
import type {
  RequestAction,
  RequestProofRequest,
} from "../src/token.js";
import {
  CLOCK_SKEW_SECONDS,
  MAX_TOKEN_LENGTH,
  MAX_TOKEN_LIFETIME_SECONDS,
  REQUEST_PROOF_LIFETIME_SECONDS,
  clampToken,
  generateCredentialKeyPair,
  importCredentialKey,
  importCredentialPublicKey,
  importRootSecret,
  inspectRequestProof,
  inspectToken,
  mintRequestProof,
  mintToken,
  readRequestAction,
  readTokenKeyId,
  verifyToken,
} from "../src/token.js";

const KID = "6c1f0f4a-2b3d-4c5e-8f90-1a2b3c4d5e6f";
const WORKSPACE = "3f6a1c20-9d84-4b1e-8a77-2c5e9b0d4411";
const OTHER_WORKSPACE = "4f6a1c20-9d84-4b1e-8a77-2c5e9b0d4411";
const NOW = 1_800_000_000;
const pair = await generateCredentialKeyPair();
const key = await importCredentialKey(pair.privateKey);
const verificationKey = await importCredentialPublicKey(pair.publicKey);
const publicKey = Buffer.from((await generateCredentialKeyPair()).publicKey).toString("base64url");
const renewal = { operation: "renew-credential", publicKey } as const;
const ACTIONS: RequestAction[] = [
  renewal,
  { operation: "promote-workspace", workspaceId: WORKSPACE, attemptId: KID },
  { operation: "list-devices" },
  { operation: "own-hub-role" },
  { operation: "list-hub-admins" },
  { operation: "list-hub-admins", cursor: "WzFd" },
  { operation: "list-hub-workspaces" },
  { operation: "list-hub-workspaces", cursor: "WzEsMl0" },
  { operation: "suspend-workspace", workspaceId: WORKSPACE },
  { operation: "restore-workspace", workspaceId: WORKSPACE },
  { operation: "remove-hub-admin", principalId: "principal" },
  { operation: "revoke-device", deviceId: "device" },
  { operation: "own-role", workspaceId: WORKSPACE },
  { operation: "list-members", workspaceId: WORKSPACE },
  { operation: "resolve-account", workspaceId: WORKSPACE, githubUsername: "octocat" },
  { operation: "grant-member", workspaceId: WORKSPACE, githubAccountId: "42", role: "member" },
  { operation: "grant-member", workspaceId: WORKSPACE, githubAccountId: "42", role: "admin" },
  { operation: "change-role", workspaceId: WORKSPACE, principalId: "principal", role: "member" },
  { operation: "remove-member", workspaceId: WORKSPACE, principalId: "principal" },
];

function request(overrides: Record<string, unknown> = {}): RequestProofRequest {
  return {
    kid: KID,
    ...(overrides.operation === undefined || overrides.operation === "renew-credential" ? renewal : {}),
    iat: NOW,
    lifetimeSeconds: 60,
    ...overrides,
  } as RequestProofRequest;
}

/** A holder can sign arbitrary claims, which remain subject to validation. */
async function forge(claims: Record<string, unknown>): Promise<string> {
  const payload = Buffer.from(JSON.stringify(claims)).toString("base64url");
  const signature = Buffer.from(
    await crypto.subtle.sign("Ed25519", key, new TextEncoder().encode(payload)),
  ).toString("base64url");
  return `${payload}.${signature}`;
}

describe("credential request proofs", () => {
  it("requires no workspace or client-provided identity and exposes only a key lookup hint before verification", async () => {
    const proof = await mintRequestProof(key, request());
    expect(readTokenKeyId(proof)).toEqual({ kid: KID });
    const inspected = await inspectRequestProof(verificationKey, proof, renewal);
    expect(inspected).toEqual({
      typ: "request", kid: KID, operation: "renew-credential", publicKey, iat: NOW, exp: NOW + 60,
    });
    expect(proof).toMatch(/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
    expect(proof.length).toBeLessThanOrEqual(MAX_TOKEN_LENGTH);

    const before = Math.floor(Date.now() / 1000);
    const defaultTime = await inspectRequestProof(
      verificationKey,
      await mintRequestProof(key, { kid: KID, operation: "renew-credential", publicKey, lifetimeSeconds: 60 }),
      renewal,
    );
    expect(defaultTime).toMatchObject({ iat: expect.any(Number) });
    if ("failure" in defaultTime) throw new Error("proof did not verify");
    expect(defaultTime.iat).toBeGreaterThanOrEqual(before);
    expect(defaultTime.iat).toBeLessThanOrEqual(Math.floor(Date.now() / 1000));
  });

  it("cannot authenticate a room, and a room token cannot authorize a request", async () => {
    const room = await mintToken(key, {
      typ: "room", kid: KID, sub: "principal", workspace: WORKSPACE,
      scope: "read-write", iat: NOW, lifetimeSeconds: 60,
    });
    for (const action of ACTIONS) {
      const proof = await mintRequestProof(key, request(action));
      expect(await inspectToken(verificationKey, proof)).toHaveProperty("failure", "unsupported-claims");
      expect(await verifyToken(verificationKey, proof)).toBeNull();
      expect(await inspectRequestProof(verificationKey, room, action))
        .toHaveProperty("failure", "unsupported-claims");
    }
  });

  it("distinguishes independently minted same-second requests while accepting proofs without a nonce", async () => {
    const action: RequestAction = { operation: "remove-member", workspaceId: WORKSPACE, principalId: "principal" };
    const expected = { typ: "request", kid: KID, ...action, iat: NOW, exp: NOW + 60 };
    const first = await mintRequestProof(key, request(action));
    const second = await mintRequestProof(key, request(action));

    expect(first).not.toBe(second);
    for (const proof of [first, second, await forge(expected)]) {
      expect(await inspectRequestProof(verificationKey, proof, action)).toEqual(expected);
    }
  });

  it("refuses unknown operations even when signed by the credential holder", async () => {
    const foreignProof = await forge({
      typ: "request", kid: KID, operation: "unknown-operation", iat: NOW, exp: NOW + 60,
    });
    expect(await inspectRequestProof(verificationKey, foreignProof, renewal))
      .toHaveProperty("failure", "unsupported-claims");
    const proof = await mintRequestProof(key, request());
    expect(await inspectRequestProof(verificationKey, proof, { operation: "unknown-operation" } as unknown as RequestAction))
      .toHaveProperty("failure", "unsupported-claims");
  });

  it("binds every operation and authority-bearing target, including management versus renewal", async () => {
    for (const action of ACTIONS) {
      const proof = await mintRequestProof(key, request(action));
      expect(await inspectRequestProof(verificationKey, proof, action)).toEqual({
        typ: "request", kid: KID, ...action, iat: NOW, exp: NOW + 60,
      });
      for (const replacement of ACTIONS.filter((candidate) => candidate.operation !== action.operation)) {
        expect(await inspectRequestProof(verificationKey, proof, replacement))
          .toHaveProperty("failure", "unsupported-claims");
      }
      for (const [field, value] of Object.entries(action)) {
        if (field === "operation") continue;
        const replacement = field === "workspaceId" ? OTHER_WORKSPACE
          : field === "attemptId" ? WORKSPACE
          : field === "githubAccountId" ? "43"
          : field === "role" ? value === "admin" ? "member" : "admin" : `${value}-other`;
        expect(await inspectRequestProof(verificationKey, proof, { ...action, [field]: replacement } as RequestAction))
          .toHaveProperty("failure", "unsupported-claims");
      }
    }
  });

  it("rejects missing or malformed targets and signed authority fields irrelevant to the operation", async () => {
    const fields = {
      deviceId: "device", workspaceId: WORKSPACE, principalId: "principal", role: "member",
      attemptId: KID, githubUsername: "octocat", githubAccountId: "42", publicKey,
    };
    for (const action of ACTIONS) {
      for (const [field, value] of Object.entries(fields)) {
        const changes = Object.hasOwn(action, field)
          ? [
            ...(action.operation === "grant-member" && field === "role" ? [] : [{ [field]: undefined }]),
            { [field]: "" }, { [field]: 7 },
          ]
          : [{ [field]: value }];
        for (const changed of changes) {
          expect(await inspectRequestProof(verificationKey, await forge({
            typ: "request", kid: KID, ...action, ...changed, iat: NOW, exp: NOW + 60,
          }), action)).toHaveProperty("failure", "unsupported-claims");
          await expect(mintRequestProof(key, request({ ...action, ...changed })))
            .rejects.toThrow(/mintRequestProof/);
        }
      }
    }
    for (const workspaceId of [WORKSPACE.toUpperCase(), `workspace-${WORKSPACE}`]) {
      await expect(mintRequestProof(key, request({ operation: "own-role", workspaceId })))
        .rejects.toThrow(/mintRequestProof/);
    }
    await expect(mintRequestProof(key, request({
      operation: "change-role", workspaceId: WORKSPACE, principalId: "principal", role: "owner",
    }))).rejects.toThrow(/mintRequestProof/);
    await expect(mintRequestProof(key, request({
      operation: "revoke-device", deviceId: "x".repeat(MAX_TOKEN_LENGTH),
    }))).rejects.toThrow(/mintRequestProof/);
  });

  it("bounds inventory cursors and binds both their value and presence", async () => {
    for (const operation of ["list-hub-admins", "list-hub-workspaces"] as const) {
      const first = { operation };
      const next = { operation, cursor: "WzFd" };
      const proof = await mintRequestProof(key, request(next));
      expect(await inspectRequestProof(verificationKey, proof, first)).toHaveProperty("failure", "unsupported-claims");
      const firstProof = await mintRequestProof(key, request(first));
      expect(await inspectRequestProof(verificationKey, firstProof, next)).toHaveProperty("failure", "unsupported-claims");
      for (const cursor of [null, undefined, "", 7, "x".repeat(161)]) {
        expect(readRequestAction({ operation, cursor })).toBeNull();
      }
      expect(readRequestAction({ operation, cursor: "x".repeat(160) })).toEqual({ operation, cursor: "x".repeat(160) });
    }
    expect(readRequestAction({ operation: "own-hub-role", cursor: "WzFd" })).toBeNull();
  });

  it("binds a default member grant to the same role as an explicit member grant", async () => {
    const grant: RequestAction = { operation: "grant-member", workspaceId: WORKSPACE, githubAccountId: "42" };
    const memberGrant: RequestAction = { ...grant, role: "member" };
    const adminGrant: RequestAction = { ...grant, role: "admin" };
    const expected = { typ: "request", kid: KID, ...memberGrant, iat: NOW, exp: NOW + 60 };
    for (const action of [grant, memberGrant]) {
      const proof = await mintRequestProof(key, request(action));
      expect(await inspectRequestProof(verificationKey, proof, grant)).toEqual(expected);
      expect(await inspectRequestProof(verificationKey, proof, memberGrant)).toEqual(expected);
      expect(await inspectRequestProof(verificationKey, proof, adminGrant))
        .toHaveProperty("failure", "unsupported-claims");
    }
    const omittedRole = await forge({ typ: "request", kid: KID, ...grant, iat: NOW, exp: NOW + 60 });
    expect(await inspectRequestProof(verificationKey, omittedRole, memberGrant)).toEqual(expected);
    const adminProof = await mintRequestProof(key, request(adminGrant));
    expect(await inspectRequestProof(verificationKey, adminProof, grant))
      .toHaveProperty("failure", "unsupported-claims");
  });

  it("validates GitHub handles and permanent account IDs on both sides of the proof", async () => {
    for (const githubUsername of ["a", "Octocat-1", "a".repeat(39)]) {
      const action: RequestAction = { operation: "resolve-account", workspaceId: WORKSPACE, githubUsername };
      expect(await inspectRequestProof(verificationKey, await mintRequestProof(key, request(action)), action))
        .toMatchObject(action);
    }
    for (const githubAccountId of ["1", String(Number.MAX_SAFE_INTEGER)]) {
      const action: RequestAction = { operation: "grant-member", workspaceId: WORKSPACE, githubAccountId, role: "member" };
      expect(await inspectRequestProof(verificationKey, await mintRequestProof(key, request(action)), action))
        .toMatchObject(action);
    }
    const malformed = [
      ...["", "-name", "name-", "two--hyphens", "with_under", "é", "a".repeat(40), "../users", "name?q=x", "name%2fother"]
        .map((githubUsername) => ({ operation: "resolve-account", workspaceId: WORKSPACE, githubUsername })),
      ...["0", "-1", "+1", "01", "1.0", "1e2", " 42", "9007199254740992", 42]
        .map((githubAccountId) => ({ operation: "grant-member", workspaceId: WORKSPACE, githubAccountId, role: "member" })),
    ];
    for (const action of malformed) {
      await expect(mintRequestProof(key, request(action))).rejects.toThrow(/mintRequestProof/);
      expect(await inspectRequestProof(verificationKey, await forge({
        typ: "request", kid: KID, ...action, iat: NOW, exp: NOW + 60,
      }), action as RequestAction)).toHaveProperty("failure", "unsupported-claims");
    }
  });

  it("refuses unrelated renewal targets and binds the replacement public key", async () => {
    const metadata = { workspaceId: WORKSPACE, role: "admin", githubUsername: "octocat", githubAccountId: "42" };
    const expected = { typ: "request", kid: KID, operation: "renew-credential", publicKey, iat: NOW, exp: NOW + 60 };
    expect(await inspectRequestProof(verificationKey, await forge({ ...expected, ...metadata }), renewal))
      .toHaveProperty("failure", "unsupported-claims");
    await expect(mintRequestProof(key, request(metadata))).rejects.toThrow(/mintRequestProof/);
    const proof = await mintRequestProof(key, request());
    const replacement = Buffer.from((await generateCredentialKeyPair()).publicKey).toString("base64url");
    expect(await inspectRequestProof(verificationKey, proof, { ...renewal, publicKey: replacement }))
      .toHaveProperty("failure", "unsupported-claims");
    for (const value of [undefined, "", 7, `${publicKey}=`, `${publicKey} `, Buffer.alloc(31).toString("base64url")]) {
      await expect(mintRequestProof(key, request({ publicKey: value }))).rejects.toThrow(/mintRequestProof/);
      expect(await inspectRequestProof(verificationKey, await forge({ ...expected, publicKey: value }), renewal))
        .toHaveProperty("failure", "unsupported-claims");
    }
  });

  it("rejects another device's signature and the shared root signature without reflecting claims or key material", async () => {
    const secret = "a-secret-that-is-not-the-credential-key";
    for (const wrongKey of [
      await importCredentialKey((await generateCredentialKeyPair()).privateKey),
      await importRootSecret(secret),
    ]) {
      const proof = await mintRequestProof(wrongKey, request());
      expect(await inspectRequestProof(verificationKey, proof, renewal))
        .toEqual({ failure: "bad-signature", identity: { typ: null, sub: null } });
    }
    const reflected = await forge({
      typ: secret, sub: secret, kid: KID, operation: "renew-credential", publicKey, iat: NOW, exp: NOW + 60,
    });
    const rejection = await inspectRequestProof(verificationKey, reflected, renewal);
    expect(rejection).toEqual({ failure: "unsupported-claims", identity: { typ: null, sub: null } });
    expect(JSON.stringify(rejection)).not.toContain(secret);
  });

  it("uses canonical bounded parsing and never throws on malformed input or unusable keys", async () => {
    const proof = await mintRequestProof(key, request());
    const [payload, signature] = proof.split(".");
    for (const candidate of [
      "", "github_pat_not_a_proof", "a.b.c", "!!!.!!!", "a".repeat(MAX_TOKEN_LENGTH + 1),
      `${payload}.${signature}=`, `${payload} .${signature}`,
    ]) {
      expect(await inspectRequestProof(verificationKey, candidate, renewal))
        .toEqual({ failure: "unparseable", identity: null });
    }
    expect(await inspectRequestProof({} as CryptoKey, proof, renewal))
      .toEqual({ failure: "unparseable", identity: null });
  });

  it("requires a credential UUID and supported temporal claims on both sides", async () => {
    const claims = { typ: "request", kid: KID, operation: "renew-credential", publicKey, iat: NOW, exp: NOW + 60 };
    for (const changed of [
      { kid: null }, { kid: "not-a-uuid" }, { kid: KID.toUpperCase() },
      { operation: "unknown-operation" }, { iat: -1 }, { iat: 1.5 },
      { exp: NOW }, { exp: Number.MAX_SAFE_INTEGER + 1 },
    ]) {
      expect(await inspectRequestProof(verificationKey, await forge({ ...claims, ...changed }), renewal))
        .toHaveProperty("failure", "unsupported-claims");
    }
    for (const changed of [
      { kid: null }, { kid: "not-a-uuid" }, { operation: "unknown-operation" },
      { iat: -1 }, { iat: 1.5 }, { iat: Number.MAX_SAFE_INTEGER },
      { lifetimeSeconds: 0 }, { lifetimeSeconds: 1.5 },
      { lifetimeSeconds: REQUEST_PROOF_LIFETIME_SECONDS + 1 },
      { lifetimeSeconds: MAX_TOKEN_LIFETIME_SECONDS },
      { lifetimeSeconds: MAX_TOKEN_LIFETIME_SECONDS + 1 },
    ]) {
      await expect(mintRequestProof(key, request(changed))).rejects.toThrow(/mintRequestProof/);
    }
  });

  it("caps every request proof at 60 seconds while preserving the clock-skew and expiry rules", async () => {
    for (const action of ACTIONS) {
      for (const [iat, exp, expected] of [
        [NOW - 60, NOW - 1, "expired"],
        [NOW - 60, NOW, null],
        [NOW + CLOCK_SKEW_SECONDS, NOW + CLOCK_SKEW_SECONDS + 60, null],
        [NOW + CLOCK_SKEW_SECONDS + 1, NOW + CLOCK_SKEW_SECONDS + 61, "not-yet-issued"],
        [NOW, NOW + REQUEST_PROOF_LIFETIME_SECONDS + 1, "lifetime-too-long"],
        [NOW, NOW + MAX_TOKEN_LIFETIME_SECONDS, "lifetime-too-long"],
        [NOW, NOW + REQUEST_PROOF_LIFETIME_SECONDS, null],
      ] as const) {
        const proof = await forge({ typ: "request", kid: KID, ...action, iat, exp });
        const inspected = await inspectRequestProof(verificationKey, proof, action);
        if ("failure" in inspected) throw new Error("proof did not verify");
        expect(clampToken(inspected, NOW)).toBe(expected);
      }
    }
  });
});

/** HTTP proof authority stays separate from rooms and bound to its exact request. */
import { describe, expect, it } from "vitest";
import type {
  RequestAction,
  RequestProofRequest,
} from "../src/token.js";
import {
  MAX_TOKEN_LENGTH,
  MAX_TOKEN_LIFETIME_SECONDS,
  clampToken,
  importCredentialKey,
  importRootSecret,
  inspectRequestProof,
  inspectToken,
  mintRequestProof,
  mintToken,
  readTokenKeyId,
  verifyToken,
} from "../src/token.js";

const KID = "6c1f0f4a-2b3d-4c5e-8f90-1a2b3c4d5e6f";
const WORKSPACE = "3f6a1c20-9d84-4b1e-8a77-2c5e9b0d4411";
const OTHER_WORKSPACE = "4f6a1c20-9d84-4b1e-8a77-2c5e9b0d4411";
const NOW = 1_800_000_000;
const key = await importCredentialKey(new Uint8Array(32).fill(7));
const ACTIONS: RequestAction[] = [
  { operation: "renew-credential" },
  { operation: "list-devices" },
  { operation: "revoke-device", deviceId: "device" },
  { operation: "own-role", workspaceId: WORKSPACE },
  { operation: "list-members", workspaceId: WORKSPACE },
  { operation: "change-role", workspaceId: WORKSPACE, principalId: "principal", role: "member" },
  { operation: "remove-member", workspaceId: WORKSPACE, principalId: "principal" },
];

function request(overrides: Record<string, unknown> = {}): RequestProofRequest {
  return {
    kid: KID,
    operation: "renew-credential",
    iat: NOW,
    lifetimeSeconds: 60,
    ...overrides,
  } as RequestProofRequest;
}

/** A holder can sign arbitrary claims, which remain subject to validation. */
async function forge(claims: Record<string, unknown>): Promise<string> {
  const payload = Buffer.from(JSON.stringify(claims)).toString("base64url");
  const signature = Buffer.from(
    await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(payload)),
  ).toString("base64url");
  return `${payload}.${signature}`;
}

describe("credential request proofs", () => {
  it("requires no workspace or client-provided identity and exposes only a key lookup hint before verification", async () => {
    const proof = await mintRequestProof(key, request());
    expect(readTokenKeyId(proof)).toEqual({ kid: KID });
    const inspected = await inspectRequestProof(key, proof, "renew-credential");
    expect(inspected).toEqual({
      typ: "request", kid: KID, operation: "renew-credential", iat: NOW, exp: NOW + 60,
    });
    expect(proof).toMatch(/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
    expect(proof.length).toBeLessThanOrEqual(MAX_TOKEN_LENGTH);

    const before = Math.floor(Date.now() / 1000);
    const defaultTime = await inspectRequestProof(
      key,
      await mintRequestProof(key, { kid: KID, operation: "renew-credential", lifetimeSeconds: 60 }),
      "renew-credential",
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
      expect(await inspectToken(key, proof)).toHaveProperty("failure", "unsupported-claims");
      expect(await verifyToken(key, proof)).toBeNull();
      expect(await inspectRequestProof(key, room, action))
        .toHaveProperty("failure", "unsupported-claims");
    }
  });

  it("refuses unknown operations even when signed by the credential holder", async () => {
    const foreignProof = await forge({
      typ: "request", kid: KID, operation: "unknown-operation", iat: NOW, exp: NOW + 60,
    });
    expect(await inspectRequestProof(key, foreignProof, "renew-credential"))
      .toHaveProperty("failure", "unsupported-claims");
    const proof = await mintRequestProof(key, request());
    expect(await inspectRequestProof(key, proof, { operation: "unknown-operation" } as unknown as RequestAction))
      .toHaveProperty("failure", "unsupported-claims");
  });

  it("binds every operation and authority-bearing target, including management versus renewal", async () => {
    for (const action of ACTIONS) {
      const proof = await mintRequestProof(key, request(action));
      expect(await inspectRequestProof(key, proof, action)).toEqual({
        typ: "request", kid: KID, ...action, iat: NOW, exp: NOW + 60,
      });
      for (const replacement of ACTIONS.filter((candidate) => candidate.operation !== action.operation)) {
        expect(await inspectRequestProof(key, proof, replacement))
          .toHaveProperty("failure", "unsupported-claims");
      }
      for (const [field, value] of Object.entries(action)) {
        if (field === "operation") continue;
        const replacement = field === "workspaceId" ? OTHER_WORKSPACE
          : field === "role" ? "admin" : `${value}-other`;
        expect(await inspectRequestProof(key, proof, { ...action, [field]: replacement } as RequestAction))
          .toHaveProperty("failure", "unsupported-claims");
      }
    }
  });

  it("rejects missing or malformed targets and signed authority fields irrelevant to the operation", async () => {
    const fields = {
      deviceId: "device", workspaceId: WORKSPACE, principalId: "principal", role: "member",
    };
    for (const action of ACTIONS) {
      for (const [field, value] of Object.entries(fields)) {
        const changes = Object.hasOwn(action, field)
          ? [{ [field]: undefined }, { [field]: "" }, { [field]: 7 }]
          : [{ [field]: value }];
        for (const changed of changes) {
          expect(await inspectRequestProof(key, await forge({
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

  it("rejects another device's signature and the shared root signature without reflecting claims or key material", async () => {
    const secret = "a-secret-that-is-not-the-credential-key";
    for (const wrongKey of [
      await importCredentialKey(new Uint8Array(32).fill(8)),
      await importRootSecret(secret),
    ]) {
      const proof = await mintRequestProof(wrongKey, request());
      expect(await inspectRequestProof(key, proof, "renew-credential"))
        .toEqual({ failure: "bad-signature", identity: { typ: null, sub: null } });
    }
    const reflected = await forge({
      typ: secret, sub: secret, kid: KID, operation: "renew-credential", iat: NOW, exp: NOW + 60,
    });
    const rejection = await inspectRequestProof(key, reflected, "renew-credential");
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
      expect(await inspectRequestProof(key, candidate, "renew-credential"))
        .toEqual({ failure: "unparseable", identity: null });
    }
    expect(await inspectRequestProof({} as CryptoKey, proof, "renew-credential"))
      .toEqual({ failure: "unparseable", identity: null });
  });

  it("requires a credential UUID and supported temporal claims on both sides", async () => {
    const claims = { typ: "request", kid: KID, operation: "renew-credential", iat: NOW, exp: NOW + 60 };
    for (const changed of [
      { kid: null }, { kid: "not-a-uuid" }, { kid: KID.toUpperCase() },
      { operation: "unknown-operation" }, { iat: -1 }, { iat: 1.5 },
      { exp: NOW }, { exp: Number.MAX_SAFE_INTEGER + 1 },
    ]) {
      expect(await inspectRequestProof(key, await forge({ ...claims, ...changed }), "renew-credential"))
        .toHaveProperty("failure", "unsupported-claims");
    }
    for (const changed of [
      { kid: null }, { kid: "not-a-uuid" }, { operation: "unknown-operation" },
      { iat: -1 }, { iat: 1.5 }, { iat: Number.MAX_SAFE_INTEGER },
      { lifetimeSeconds: 0 }, { lifetimeSeconds: 1.5 },
      { lifetimeSeconds: MAX_TOKEN_LIFETIME_SECONDS + 1 },
    ]) {
      await expect(mintRequestProof(key, request(changed))).rejects.toThrow(/mintRequestProof/);
    }
  });

  it("applies the existing hub clock and lifetime ceiling after verifying the proof", async () => {
    for (const [iat, exp, expected] of [
      [NOW - 60, NOW - 1, "expired"],
      [NOW + 61, NOW + 121, "not-yet-issued"],
      [NOW, NOW + MAX_TOKEN_LIFETIME_SECONDS + 1, "lifetime-too-long"],
      [NOW, NOW + 60, null],
    ] as const) {
      const proof = await forge({ typ: "request", kid: KID, operation: "renew-credential", iat, exp });
      const inspected = await inspectRequestProof(key, proof, "renew-credential");
      if ("failure" in inspected) throw new Error("proof did not verify");
      expect(clampToken(inspected, NOW)).toBe(expected);
    }
  });
});

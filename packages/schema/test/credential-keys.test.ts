import { describe, expect, it } from "vitest";
import {
  generateCredentialKeyPair,
  importCredentialKey,
  importCredentialPublicKey,
  importRootSecret,
  isCredentialPublicKey,
  mintToken,
  verifyToken,
} from "../src/token.js";

const claims = {
  typ: "room", sub: "device", workspace: "3f6a1c20-9d84-4b1e-8a77-2c5e9b0d4411",
  scope: "read-write", kid: "6c1f0f4a-2b3d-4c5e-8f90-1a2b3c4d5e6f", lifetimeSeconds: 60,
} as const;

describe("device signing keys", () => {
  it("exports an owner-held private key and a verification-only public key", async () => {
    const pair = await generateCredentialKeyPair();
    expect(pair.privateKey).toHaveLength(48);
    expect(pair.publicKey).toHaveLength(32);
    const signingKey = await importCredentialKey(pair.privateKey);
    const verificationKey = await importCredentialPublicKey(pair.publicKey);
    expect(signingKey.usages).toEqual(["sign"]);
    expect(verificationKey.usages).toEqual(["verify"]);
    const token = await mintToken(signingKey, claims);
    expect(await verifyToken(verificationKey, token)).toMatchObject({
      typ: "room", sub: claims.sub, workspace: claims.workspace, scope: claims.scope, kid: claims.kid,
    });
    await expect(mintToken(verificationKey, claims)).rejects.toThrow();
    await expect(importCredentialKey(pair.publicKey)).rejects.toThrow();
    await expect(importCredentialKey(crypto.getRandomValues(new Uint8Array(32)))).rejects.toThrow();
  });

  it("refuses a different device and root-secret signatures under the public key", async () => {
    const pair = await generateCredentialKeyPair();
    const other = await generateCredentialKeyPair();
    const verificationKey = await importCredentialPublicKey(pair.publicKey);
    for (const signingKey of [await importCredentialKey(other.privateKey), await importRootSecret("local root")]) {
      expect(await verifyToken(verificationKey, await mintToken(signingKey, claims))).toBeNull();
    }
  });

  it("accepts only canonical raw public keys on the wire", async () => {
    const value = Buffer.from((await generateCredentialKeyPair()).publicKey).toString("base64url");
    expect(isCredentialPublicKey(value)).toBe(true);
    for (const invalid of [null, 32, "", `${value}=`, `${value} `, "!".repeat(43), Buffer.alloc(31).toString("base64url")]) {
      expect(isCredentialPublicKey(invalid)).toBe(false);
    }
  });
});

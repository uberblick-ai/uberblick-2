/** The credential key import contract: independent bytes, never the root. */

import { describe, expect, it } from "vitest";
import { MAX_TOKEN_LIFETIME_SECONDS, generateCredentialKeyPair, importCredentialKey, importCredentialPublicKey, importRootSecret, mintToken, verifyToken } from "@uberblick/schema/token";

const ROOT = "a-dev-root-secret";
const WORKSPACE = "3f6a1c20-9d84-4b1e-8a77-2c5e9b0d4411";
const CRED_ID = "6c1f0f4a-2b3d-4c5e-8f90-1a2b3c4d5e6f";

/** The claims a client mints once it has imported its credential's bytes. */
function roomClaims(kid: string) {
  return {
    typ: "room",
    sub: "agent:claude",
    workspace: WORKSPACE,
    scope: "read-write",
    kid,
    lifetimeSeconds: MAX_TOKEN_LIFETIME_SECONDS,
  } as const;
}

describe("importCredentialKey", () => {
  it("imports a device's PKCS8 private key and refuses old shared-key bytes", async () => {
    await expect(importCredentialKey(new Uint8Array(32))).rejects.toThrow();
    const pair = await generateCredentialKeyPair();
    await expect(importCredentialKey(pair.privateKey)).resolves.toBeInstanceOf(CryptoKey);
  });

  it("mints a token its own bytes verify and the root secret cannot", async () => {
    const pair = await generateCredentialKeyPair();
    const token = await mintToken(
      await importCredentialKey(pair.privateKey),
      roomClaims(CRED_ID),
    );

    expect(
      await verifyToken(await importCredentialPublicKey(pair.publicKey), token),
    ).toMatchObject({ workspace: WORKSPACE, kid: CRED_ID });
    expect(await verifyToken(await importRootSecret(ROOT), token)).toBeNull();
  });
});

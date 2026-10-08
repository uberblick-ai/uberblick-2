/** The credential key import contract: independent bytes, never the root. */

import { describe, expect, it } from "vitest";
import {
  MAX_TOKEN_LIFETIME_SECONDS,
  importCredentialKey,
  importRootSecret,
  mintToken,
  verifyToken,
} from "../src/token.js";

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
  it("takes 32 bytes and nothing else", async () => {
    await expect(importCredentialKey(new Uint8Array(31))).rejects.toThrow(/32/);
    await expect(importCredentialKey(new Uint8Array(33))).rejects.toThrow(/32/);
    await expect(
      importCredentialKey(new Uint8Array(32)),
    ).resolves.toBeInstanceOf(CryptoKey);
  });

  it("mints a token its own bytes verify and the root secret cannot", async () => {
    const keyBytes = crypto.getRandomValues(new Uint8Array(32));
    const token = await mintToken(
      await importCredentialKey(keyBytes),
      roomClaims(CRED_ID),
    );

    expect(
      await verifyToken(await importCredentialKey(keyBytes), token),
    ).toMatchObject({ workspace: WORKSPACE, kid: CRED_ID });
    expect(await verifyToken(await importRootSecret(ROOT), token)).toBeNull();
  });
});

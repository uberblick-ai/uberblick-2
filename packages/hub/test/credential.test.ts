/** The credential encoding and key import contract used by future clients. */

import { describe, expect, it } from "vitest";
import {
  MAX_TOKEN_LIFETIME_SECONDS,
  formatCredential,
  importCredentialKey,
  importRootSecret,
  mintToken,
  parseCredential,
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

describe("the credential key round trip", () => {
  it("formats, parses, imports, mints and verifies under independently issued bytes", async () => {
    const keyBytes = crypto.getRandomValues(new Uint8Array(32));
    const issued = formatCredential({ workspaceUuid: WORKSPACE, credId: CRED_ID, keyBytes });
    const parsed = parseCredential(issued);
    if ("invalid" in parsed) throw new Error("issued fixture did not parse");
    const token = await mintToken(await importCredentialKey(parsed.keyBytes), roomClaims(parsed.credId));

    expect(await verifyToken(await importCredentialKey(keyBytes), token)).toMatchObject({
      workspace: WORKSPACE, kid: CRED_ID,
    });
    expect(await verifyToken(await importRootSecret(ROOT), token)).toBeNull();
  });
});

describe("parseCredential", () => {
  const valid = formatCredential({
    workspaceUuid: WORKSPACE,
    credId: CRED_ID,
    keyBytes: new Uint8Array(32).fill(0xab),
  });

  it("is synchronous and touches no crypto", () => {
    // The boot path is where a credential is read, and it may have no hub, no
    // network and — if a browser ever served this over plain http — no
    // WebCrypto at all. A bad credential still has to be diagnosable there.
    const subtle = globalThis.crypto.subtle;
    Object.defineProperty(globalThis.crypto, "subtle", {
      configurable: true,
      get() {
        throw new Error("parseCredential must not touch WebCrypto");
      },
    });
    try {
      const parsed = parseCredential(valid);
      expect("invalid" in parsed).toBe(false);
      expect(parseCredential("ubc1.x.y.z.0")).toEqual({
        invalid: "malformed-workspace",
      });
    } finally {
      Object.defineProperty(globalThis.crypto, "subtle", {
        configurable: true,
        value: subtle,
      });
    }
  });

  it("round-trips what formatCredential wrote", () => {
    const parsed = parseCredential(valid);

    expect(parsed).toEqual({
      workspaceUuid: WORKSPACE,
      credId: CRED_ID,
      keyBytes: new Uint8Array(32).fill(0xab),
    });
  });

  it("pins the checksum: CRC-32 (IEEE, reflected), 8 lowercase hex digits", () => {
    const [, , , , checksum] = valid.split(".");

    expect(checksum).toMatch(/^[0-9a-f]{8}$/);
    expect(checksum).toBe("33cafe1e");
  });

  it.each([
    ["a flipped byte in the key", flipKeyChar(valid), "checksum-mismatch"],
    ["a truncated string", valid.slice(0, -3), "checksum-mismatch"],
    ["a key that is not 32 bytes", shortKey(), "malformed-key"],
    [
      "a key in the standard base64 alphabet, padded",
      standardAlphabetKey(),
      "malformed-key",
    ],
    ["a wrong prefix", valid.replace(/^ubc1/, "ubc2"), "not-a-credential"],
    ["too few segments", valid.split(".").slice(0, 4).join("."), "not-a-credential"],
    ["too many segments", `${valid}.extra`, "not-a-credential"],
    ["a decorated workspace", valid.replace(WORKSPACE, `ws-${WORKSPACE}`), "malformed-workspace"],
    ["a credential id that is not a uuid", valid.replace(CRED_ID, "nope"), "malformed-cred-id"],
  ])("refuses %s", (_name, candidate, problem) => {
    expect(parseCredential(candidate)).toEqual({ invalid: problem });
  });
});

/** Change one character of `<key>` and leave everything else intact. */
function flipKeyChar(credential: string): string {
  const parts = credential.split(".");
  const key = parts[3] as string;
  const first = key[0] === "A" ? "B" : "A";
  parts[3] = `${first}${key.slice(1)}`;
  return parts.join(".");
}

/**
 * The right 32 bytes, spelled in standard base64 with padding instead of
 * base64url. `atob` would forgive it and hand back exactly the right key;
 * `ubc1` specifies one spelling, so this is not a credential.
 */
function standardAlphabetKey(): string {
  const bytes = new Uint8Array(32);
  bytes.fill(0xff, 0, 16);
  for (let index = 16; index < 32; index += 1) {
    bytes[index] = [0xfb, 0xef, 0xbe][(index - 16) % 3] as number;
  }
  const parts = formatCredential({
    workspaceUuid: WORKSPACE,
    credId: CRED_ID,
    keyBytes: bytes,
  }).split(".");
  parts[3] = Buffer.from(bytes).toString("base64");
  return parts.join(".");
}

/** A credential whose key decodes to 16 bytes rather than 32. */
function shortKey(): string {
  const parts = formatCredential({
    workspaceUuid: WORKSPACE,
    credId: CRED_ID,
    keyBytes: new Uint8Array(32).fill(0xab),
  }).split(".");
  // 22 base64url characters carry 16 bytes. The checksum is left alone on
  // purpose: the key length is checked before it, so this case is diagnosed
  // as the wrong length rather than as a typo.
  parts[3] = (parts[3] as string).slice(0, 22);
  return parts.join(".");
}

describe("importCredentialKey", () => {
  it("takes 32 bytes and nothing else", async () => {
    await expect(importCredentialKey(new Uint8Array(31))).rejects.toThrow(/32/);
    await expect(importCredentialKey(new Uint8Array(33))).rejects.toThrow(/32/);
    await expect(
      importCredentialKey(new Uint8Array(32)),
    ).resolves.toBeInstanceOf(CryptoKey);
  });

  it("mints a token the root secret cannot verify", async () => {
    const credentialKey = await importCredentialKey(
      crypto.getRandomValues(new Uint8Array(32)),
    );
    const token = await mintToken(credentialKey, roomClaims(CRED_ID));

    expect(await verifyToken(await importRootSecret(ROOT), token)).toBeNull();
  });
});

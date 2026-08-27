/**
 * The credential contract, end to end and in the dark corners.
 *
 * The blocker this file exists to close: an earlier design had a client call
 * `deriveCredentialKey(root, workspace, keyVersion, credId)`, which a client
 * cannot do — it holds neither the root secret nor the `keyVersion`. Nothing
 * caught it, twice, because no test drove a credential from issuance through a
 * client mint to a hub verification. {@link round-trip} is that test, and the
 * golden vector below is what stops the wire format drifting under it.
 */

import { describe, expect, it } from "vitest";
import {
  MAX_TOKEN_LIFETIME_SECONDS,
  deriveCredentialKey,
  formatCredential,
  importCredentialKey,
  importRootSecret,
  mintToken,
  parseCredential,
  verifyToken,
} from "../src/token.js";

const ROOT = "a-dev-root-secret";
const WORKSPACE = "3f6a1c20-9d84-4b1e-8a77-2c5e9b0d4411";
const KEY_VERSION = "0f1e2d3c4b5a69788796a5b4c3d2e1f0";
const CRED_ID = "6c1f0f4a-2b3d-4c5e-8f90-1a2b3c4d5e6f";

function hex(bytes: Uint8Array): string {
  return [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
}

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

describe("the round-trip vector", () => {
  it("issues, parses, imports, mints, and verifies under an independently derived key", async () => {
    // Hub, at issuance: derive and format. The `keyVersion` never leaves here.
    const issued = formatCredential({
      workspaceUuid: WORKSPACE,
      credId: CRED_ID,
      keyBytes: await deriveCredentialKey(ROOT, WORKSPACE, KEY_VERSION, CRED_ID),
    });
    expect(issued.startsWith("ubc1.")).toBe(true);
    expect(issued).not.toContain(KEY_VERSION);

    // Client: parse, import, mint. It never touches the root secret or the
    // key version, because it has neither.
    const parsed = parseCredential(issued);
    if ("invalid" in parsed) {
      throw new Error(`the issued credential did not parse: ${parsed.invalid}`);
    }
    expect(parsed.workspaceUuid).toBe(WORKSPACE);
    expect(parsed.credId).toBe(CRED_ID);
    const token = await mintToken(
      await importCredentialKey(parsed.keyBytes),
      roomClaims(parsed.credId),
    );

    // Hub, at verification: re-derive from the row's own fields — never from
    // anything the client sent — and verify.
    const hubKey = await importCredentialKey(
      await deriveCredentialKey(ROOT, WORKSPACE, KEY_VERSION, CRED_ID),
    );
    const claims = await verifyToken(hubKey, token);

    expect(claims?.workspace).toBe(WORKSPACE);
    expect(claims?.kid).toBe(CRED_ID);
  });

  it("refuses a token minted under a credential issued at another key version", async () => {
    // A rekey regenerates `key_version`; the credential string does not carry
    // it, so the hub re-derives under the *current* version and the client's
    // bytes no longer match. This is the second of the two refusals — the
    // first is the row's precondition, which arrives with the registry.
    const stale = formatCredential({
      workspaceUuid: WORKSPACE,
      credId: CRED_ID,
      keyBytes: await deriveCredentialKey(ROOT, WORKSPACE, KEY_VERSION, CRED_ID),
    });
    const parsed = parseCredential(stale);
    if ("invalid" in parsed) throw new Error("fixture did not parse");

    const token = await mintToken(
      await importCredentialKey(parsed.keyBytes),
      roomClaims(CRED_ID),
    );
    const afterRekey = await importCredentialKey(
      await deriveCredentialKey(
        ROOT,
        WORKSPACE,
        "ffffffffffffffffffffffffffffffff",
        CRED_ID,
      ),
    );

    expect(await verifyToken(afterRekey, token)).toBeNull();
  });
});

describe("deriveCredentialKey", () => {
  it("pins the derivation to a golden vector", async () => {
    // A fixed root secret, workspace, key version and credential id produce
    // exactly these 32 bytes. Change this value and every credential ever
    // issued stops verifying — so a diff that changes it is a wire-format
    // change and has to say so.
    const derived = await deriveCredentialKey(
      ROOT,
      WORKSPACE,
      KEY_VERSION,
      CRED_ID,
    );

    expect(derived).toHaveLength(32);
    expect(hex(derived)).toBe(
      "6f5d64120f8362799e6ae006a1ceaeef71e1441ad4b56f88a8b083d2267a5107",
    );
  });

  it("lets no field bleed into the next", async () => {
    // The bleed this rules out: a `keyVersion` that ends one character early
    // and a `credId` that starts one character early would concatenate to the
    // same string as the honest pair, and a derivation that merely joined its
    // fields would hand both the same key. Every neighbouring pair below moves
    // exactly one character across a boundary, and all four keys differ.
    const otherVersion = `${KEY_VERSION.slice(0, 31)}1`;
    const otherId = `1${CRED_ID.slice(1)}`;
    expect(otherVersion).not.toBe(KEY_VERSION);
    expect(otherId).not.toBe(CRED_ID);

    const keys = await Promise.all(
      [
        [KEY_VERSION, CRED_ID],
        [otherVersion, CRED_ID],
        [KEY_VERSION, otherId],
        [otherVersion, otherId],
      ].map(([version, id]) =>
        deriveCredentialKey(ROOT, WORKSPACE, version as string, id as string),
      ),
    );

    expect(new Set(keys.map(hex)).size).toBe(4);

    // And a different workspace, same everything else, is a different key.
    const elsewhere = await deriveCredentialKey(
      ROOT,
      "11111111-2222-3333-4444-555555555555",
      KEY_VERSION,
      CRED_ID,
    );
    expect(hex(elsewhere)).not.toBe(hex(keys[0] as Uint8Array));
  });

  it("refuses a field that is not in its fixed format", async () => {
    // The format checks are what make the previous test's guarantee absolute:
    // a `keyVersion` carrying a newline could otherwise spell any derivation
    // string it liked.
    await expect(
      deriveCredentialKey(ROOT, `uberblick-${WORKSPACE}`, KEY_VERSION, CRED_ID),
    ).rejects.toThrow(/workspaceUuid/);
    await expect(
      deriveCredentialKey(ROOT, WORKSPACE, `abc\n${CRED_ID}`, CRED_ID),
    ).rejects.toThrow(/keyVersion/);
    await expect(
      deriveCredentialKey(ROOT, WORKSPACE, KEY_VERSION.toUpperCase(), CRED_ID),
    ).rejects.toThrow(/keyVersion/);
    await expect(
      deriveCredentialKey(ROOT, WORKSPACE, KEY_VERSION, "not-a-uuid"),
    ).rejects.toThrow(/credId/);
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
    // The two key spaces are disjoint, which is the point of deriving at all:
    // a credential is not a smaller root secret.
    const credentialKey = await importCredentialKey(
      await deriveCredentialKey(ROOT, WORKSPACE, KEY_VERSION, CRED_ID),
    );
    const token = await mintToken(credentialKey, roomClaims(CRED_ID));

    expect(await verifyToken(await importRootSecret(ROOT), token)).toBeNull();
  });
});

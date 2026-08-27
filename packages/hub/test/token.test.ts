/**
 * The token half of the wire format: what a signed token must say, what the
 * hub's clamp does with it, and the fact that a key — never a secret string,
 * never a credential — is what mints and verifies one.
 */

import { describe, expect, it } from "vitest";
import type { ClampFailure, TokenClaims, TokenRequest } from "../src/token.js";
import {
  CLOCK_SKEW_SECONDS,
  MAX_TOKEN_LENGTH,
  MAX_TOKEN_LIFETIME_SECONDS,
  clampToken,
  formatCredential,
  importRootSecret,
  mintToken,
  verifyToken,
} from "../src/token.js";

const SECRET = "a-dev-secret";
/** A workspace id is a uuid; a token claim carries it bare. */
const WORKSPACE = "3f6a1c20-9d84-4b1e-8a77-2c5e9b0d4411";
const CRED_ID = "6c1f0f4a-2b3d-4c5e-8f90-1a2b3c4d5e6f";

const key = await importRootSecret(SECRET);

/** The claims every test starts from, so each one varies exactly one thing. */
function request(overrides: Record<string, unknown> = {}): TokenRequest {
  // The cast is what lets one table feed both the valid and the invalid cases:
  // a test that mints `scope: "admin"` is asserting the refusal.
  return {
    typ: "room",
    sub: "agent:claude",
    workspace: WORKSPACE,
    scope: "read-write",
    kid: null,
    lifetimeSeconds: MAX_TOKEN_LIFETIME_SECONDS,
    ...overrides,
  } as TokenRequest;
}

/** Correctly sign an arbitrary payload — a token the minter would refuse. */
async function forge(claims: Record<string, unknown>): Promise<string> {
  const payload = Buffer.from(JSON.stringify(claims)).toString("base64url");
  const signature = Buffer.from(
    await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(payload)),
  ).toString("base64url");
  return `${payload}.${signature}`;
}

describe("mintToken / verifyToken", () => {
  it("round-trips claims, and every token carries typ, kid and exp", async () => {
    const token = await mintToken(key, request({ lifetimeSeconds: 900 }));

    const claims = await verifyToken(key, token);

    expect(claims).not.toBeNull();
    expect(claims?.typ).toBe("room");
    expect(claims?.sub).toBe("agent:claude");
    expect(claims?.workspace).toBe(WORKSPACE);
    expect(claims?.scope).toBe("read-write");
    expect(claims?.kid).toBeNull();
    expect(claims?.iat).toBeTypeOf("number");
    expect((claims as TokenClaims).exp - (claims as TokenClaims).iat).toBe(900);

    // The wire shape a token has to keep: two base64url parts, so it survives
    // Hocuspocus's auth message and anything that reads it as one word.
    expect(token.split(".")).toHaveLength(2);
    expect(token).toMatch(/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
  });

  it("refuses to sign a token it would not read back", async () => {
    // The hub must not sign what it will not accept. A `sub` is any non-empty
    // string, so a long enough one would push a correctly minted token past
    // the length `verifyToken` reads at all.
    const skeleton = await mintToken(key, request({ sub: "s" }));
    // Four base64url characters carry three payload bytes, so this is the
    // longest `sub` that still fits under the bound.
    const longest = "s".repeat(
      1 + Math.floor(((MAX_TOKEN_LENGTH - skeleton.length) * 3) / 4),
    );

    const maximal = await mintToken(key, request({ sub: longest }));
    expect(maximal.length).toBeLessThanOrEqual(MAX_TOKEN_LENGTH);
    expect(maximal.length).toBeGreaterThan(MAX_TOKEN_LENGTH - 8);
    expect((await verifyToken(key, maximal))?.sub).toBe(longest);

    await expect(
      mintToken(key, request({ sub: `${longest}${"s".repeat(64)}` })),
    ).rejects.toThrow(/mintToken/);
  });

  it("carries a credential id in kid when one signed it", async () => {
    const token = await mintToken(key, request({ kid: CRED_ID }));

    expect((await verifyToken(key, token))?.kid).toBe(CRED_ID);
  });

  it("rejects a token signed with another key", async () => {
    const token = await mintToken(key, request());

    expect(
      await verifyToken(await importRootSecret("another-secret"), token),
    ).toBeNull();
  });

  it("rejects a tampered payload", async () => {
    const token = await mintToken(key, request({ scope: "read-only", iat: 0 }));
    const forged = await mintToken(
      await importRootSecret("irrelevant"),
      request({ scope: "read-write", iat: 0 }),
    );
    const [, signature] = token.split(".");
    const [payload] = forged.split(".");

    // Escalating read-only to read-write invalidates the signature.
    expect(await verifyToken(key, `${payload}.${signature}`)).toBeNull();
  });

  it("rejects the raw secret, a credential string, garbage and empty input", async () => {
    const credential = formatCredential({
      workspaceUuid: WORKSPACE,
      credId: CRED_ID,
      keyBytes: new Uint8Array(32).fill(7),
    });

    // The rig: a token that does verify, so the non-canonical spellings of it
    // below prove something.
    const minted = await mintToken(key, request());
    const [payload, signature] = minted.split(".") as [string, string];
    expect(await verifyToken(key, minted)).not.toBeNull();

    for (const candidate of [
      SECRET,
      credential,
      "",
      ".",
      "not-a-token",
      "one-part",
      "a.b.c",
      "!!!.!!!",
      Buffer.from('{"sub":"s"}').toString("base64url"),
      // One spelling only. `atob` is forgiving about all three of these and
      // would decode each to the bytes of the token above — which is what
      // would let a replay cache (#242) keyed on the token string be walked
      // straight past.
      `${payload.slice(0, 8)} ${payload.slice(8)}.${signature}`,
      `${payload}.${Buffer.from(signature, "base64url").toString("base64")}`,
      `${payload}.${signature}=`,
    ]) {
      expect(await verifyToken(key, candidate), candidate).toBeNull();
    }
  });

  it("refuses a v1 token — no typ, no exp — however well it is signed", async () => {
    // The exact payload this hub minted before claims v2. There is no
    // compatibility branch, and nobody may add one back.
    const v1 = await forge({
      sub: "s",
      workspace: WORKSPACE,
      scope: "read-write",
      iat: 1_700_000_000,
    });

    expect(await verifyToken(key, v1)).toBeNull();
  });

  it("accepts only claims the minter could have produced", async () => {
    const minted = {
      typ: "room",
      sub: "s",
      workspace: WORKSPACE,
      scope: "read-only",
      kid: null,
      iat: 0,
      exp: 900,
    };

    // The forging rig itself has to produce a valid token, or the rejections
    // below would prove nothing.
    expect(await verifyToken(key, await forge(minted))).not.toBeNull();

    for (const claims of [
      { ...minted, typ: undefined }, // v1: no type at all
      { ...minted, typ: "admin" }, // admin authority never rides a room token
      { ...minted, exp: undefined }, // v1: never expires
      { ...minted, sub: "" },
      { ...minted, workspace: "" },
      // The hub compares the claim against the workspace segment it parses out
      // of a room name, and that segment is the bare uuid. A decorated
      // spelling, a name, or anything spanning two segments is not a claim the
      // minter would sign — so a hand-forged one is not a token.
      { ...minted, workspace: `${WORKSPACE}/other` },
      { ...minted, workspace: `uberblick-${WORKSPACE}` },
      { ...minted, workspace: "main" },
      { ...minted, kid: "not-a-uuid" },
      { ...minted, iat: 1.5 },
      { ...minted, iat: -1 },
      { ...minted, iat: "0" },
      { ...minted, exp: 0 }, // expires when it was issued
      { ...minted, exp: 1.5 },
    ]) {
      expect(
        await verifyToken(key, await forge(claims)),
        `should reject ${JSON.stringify(claims)}`,
      ).toBeNull();
    }
  });

  it("refuses to mint nonsense", async () => {
    for (const sub of ["", undefined, 1, { id: "s" }]) {
      await expect(
        mintToken(key, request({ sub })),
        `should refuse to mint sub ${JSON.stringify(sub)}`,
      ).rejects.toThrow(/sub/);
    }
    // Mint and verify apply one workspace rule: the hub must not sign a claim
    // it would refuse — including the decorated spelling, which is a display
    // form and never an identity.
    for (const workspace of [
      "",
      "a/b",
      "main",
      `uberblick-${WORKSPACE}`,
      WORKSPACE.toUpperCase(),
    ]) {
      await expect(
        mintToken(key, request({ workspace })),
        `should refuse to mint workspace ${JSON.stringify(workspace)}`,
      ).rejects.toThrow(/workspace/);
    }
    await expect(mintToken(key, request({ scope: "admin" }))).rejects.toThrow(
      /scope/,
    );
    await expect(mintToken(key, request({ typ: "admin" }))).rejects.toThrow(
      /typ/,
    );
    await expect(mintToken(key, request({ kid: "nope" }))).rejects.toThrow(
      /kid/,
    );
    await expect(mintToken(key, request({ iat: 1.5 }))).rejects.toThrow(/iat/);
    // The ceiling binds the minter too: the hub must not sign what its own
    // clamp would then refuse.
    for (const lifetimeSeconds of [
      0,
      -1,
      1.5,
      MAX_TOKEN_LIFETIME_SECONDS + 1,
      365 * 24 * 60 * 60,
    ]) {
      await expect(
        mintToken(key, request({ lifetimeSeconds })),
        `should refuse to mint lifetime ${lifetimeSeconds}`,
      ).rejects.toThrow(/lifetimeSeconds/);
    }
  });

  it("refuses an empty root secret", async () => {
    await expect(importRootSecret("")).rejects.toThrow(/root secret/);
  });
});

describe("clampToken", () => {
  const NOW = 1_800_000_000;

  /** A verified token's claims, before the clamp has looked at the clock. */
  function claims(iat: number, exp: number): TokenClaims {
    return {
      typ: "room",
      sub: "s",
      workspace: WORKSPACE,
      scope: "read-write",
      kid: null,
      iat,
      exp,
    };
  }

  const cases: [string, TokenClaims, ClampFailure | null][] = [
    // The ceiling, regardless of what the minter claimed. This is the one that
    // stops a compromised local minter signing itself a decade.
    [
      "a one-year lifetime",
      claims(NOW, NOW + 365 * 24 * 60 * 60),
      "lifetime-too-long",
    ],
    ["fifteen minutes", claims(NOW, NOW + MAX_TOKEN_LIFETIME_SECONDS), null],
    [
      "issued five minutes ahead",
      claims(NOW + 300, NOW + 300 + 60),
      "not-yet-issued",
    ],
    [
      "issued thirty seconds ahead, inside the grace",
      claims(NOW + 30, NOW + 30 + 60),
      null,
    ],
    ["already expired", claims(NOW - 900, NOW - 1), "expired"],
  ];

  it.each(cases)("%s", (_name, token, expected) => {
    expect(clampToken(token, NOW)).toBe(expected);
  });

  it("takes the grace exactly to the second", () => {
    const inside = claims(NOW + CLOCK_SKEW_SECONDS, NOW + CLOCK_SKEW_SECONDS + 60);
    const outside = claims(
      NOW + CLOCK_SKEW_SECONDS + 1,
      NOW + CLOCK_SKEW_SECONDS + 61,
    );

    expect(clampToken(inside, NOW)).toBeNull();
    expect(clampToken(outside, NOW)).toBe("not-yet-issued");
  });
});

describe("the key type is the contract", () => {
  it("does not typecheck a credential string, a secret or raw bytes as a key", async () => {
    const credential = formatCredential({
      workspaceUuid: WORKSPACE,
      credId: CRED_ID,
      keyBytes: new Uint8Array(32).fill(7),
    });

    // Each of these is a compile error, and `tsc` fails the typecheck if one
    // ever stops being one. That is the whole assertion: no overload of
    // `mintToken` or `verifyToken` accepts anything but a `CryptoKey`, so the
    // impossible "client derives its own key" instruction cannot be written.
    // @ts-expect-error a credential string is not a key
    await expect(mintToken(credential, request())).rejects.toThrow();
    // @ts-expect-error the root secret is not a key
    await expect(mintToken(SECRET, request())).rejects.toThrow();
    // @ts-expect-error raw key bytes are not a key
    await expect(mintToken(new Uint8Array(32), request())).rejects.toThrow();
    // @ts-expect-error a credential string is not a key
    await expect(verifyToken(credential, "x.y")).resolves.toBeNull();
  });
});

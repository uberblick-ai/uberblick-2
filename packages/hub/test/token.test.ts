import { describe, expect, it } from "vitest";
import { mintToken, verifyToken } from "../src/token.js";

const SECRET = "a-dev-secret";
/** A workspace id is a uuid; a token claim carries it bare. */
const WORKSPACE = "3f6a1c20-9d84-4b1e-8a77-2c5e9b0d4411";

/** Correctly sign an arbitrary payload — a token the minter would refuse. */
async function forge(claims: Record<string, unknown>): Promise<string> {
  const payload = Buffer.from(JSON.stringify(claims)).toString("base64url");
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(SECRET),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = Buffer.from(
    await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(payload)),
  ).toString("base64url");
  return `${payload}.${signature}`;
}

describe("mintToken / verifyToken", () => {
  it("round-trips claims", async () => {
    const token = await mintToken(SECRET, {
      sub: "agent:claude",
      workspace: WORKSPACE,
      scope: "read-write",
    });

    const claims = await verifyToken(SECRET, token);

    expect(claims).not.toBeNull();
    expect(claims?.sub).toBe("agent:claude");
    expect(claims?.workspace).toBe(WORKSPACE);
    expect(claims?.scope).toBe("read-write");
    expect(claims?.iat).toBeTypeOf("number");

    // The wire shape a token has to keep: two base64url parts, so it survives
    // Hocuspocus's auth message and anything that reads it as one word.
    expect(token.split(".")).toHaveLength(2);
    expect(token).toMatch(/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
  });

  it("rejects a token signed with another secret", async () => {
    const token = await mintToken(SECRET, {
      sub: "s",
      workspace: WORKSPACE,
      scope: "read-write",
    });

    expect(await verifyToken("another-secret", token)).toBeNull();
  });

  it("rejects a tampered payload", async () => {
    const token = await mintToken(SECRET, {
      sub: "s",
      workspace: WORKSPACE,
      scope: "read-only",
      iat: 0,
    });
    const forged = await mintToken("irrelevant", {
      sub: "s",
      workspace: WORKSPACE,
      scope: "read-write",
      iat: 0,
    });
    const [, signature] = token.split(".");
    const [payload] = forged.split(".");

    // Escalating read-only to read-write invalidates the signature.
    expect(await verifyToken(SECRET, `${payload}.${signature}`)).toBeNull();
  });

  it("rejects the raw secret, garbage and empty input", async () => {
    for (const candidate of [
      SECRET,
      "",
      ".",
      "not-a-token",
      "one-part",
      "a.b.c",
      "!!!.!!!",
      Buffer.from('{"sub":"s"}').toString("base64url"),
    ]) {
      expect(await verifyToken(SECRET, candidate)).toBeNull();
    }
  });

  it("accepts only claims the minter could have produced", async () => {
    const minted = { sub: "s", workspace: WORKSPACE, scope: "read-only", iat: 0 };

    // The forging rig itself has to produce a valid token, or the rejections
    // below would prove nothing.
    expect(await verifyToken(SECRET, await forge(minted))).not.toBeNull();

    for (const claims of [
      { sub: "s", workspace: WORKSPACE, iat: 0 }, // incomplete: no scope
      { ...minted, sub: "" },
      { ...minted, workspace: "" },
      // The hub compares the claim against the workspace segment it parses out
      // of a room name, and that segment is the bare uuid. A decorated
      // spelling, a name, or anything spanning two segments is not a claim the
      // minter would sign — so a hand-forged one is not a token.
      { ...minted, workspace: `${WORKSPACE}/other` },
      { ...minted, workspace: `uberblick-${WORKSPACE}` },
      { ...minted, workspace: "main" },
      { ...minted, iat: 1.5 },
      { ...minted, iat: -1 },
      { ...minted, iat: "0" },
    ]) {
      expect(
        await verifyToken(SECRET, await forge(claims)),
        `should reject ${JSON.stringify(claims)}`,
      ).toBeNull();
    }
  });

  it("refuses to mint nonsense", async () => {
    await expect(
      mintToken("", { sub: "s", workspace: WORKSPACE, scope: "read-write" }),
    ).rejects.toThrow(/secret/);
    // Mint and verify apply one subject rule, so a token can never be signed
    // with a subject `verifyToken` would then refuse — `sub: undefined` reaching
    // the payload as a missing claim is the shape that actually happens.
    for (const sub of ["", undefined, 1, { id: "s" }]) {
      await expect(
        mintToken(SECRET, {
          sub: sub as string,
          workspace: WORKSPACE,
          scope: "read-write",
        }),
        `should refuse to mint sub ${JSON.stringify(sub)}`,
      ).rejects.toThrow(/sub/);
    }
    // Mint and verify apply one workspace rule too: the hub must not sign a
    // claim it would refuse — including the decorated spelling, which is a
    // display form and never an identity.
    for (const workspace of [
      "",
      "a/b",
      "main",
      `uberblick-${WORKSPACE}`,
      WORKSPACE.toUpperCase(),
    ]) {
      await expect(
        mintToken(SECRET, { sub: "s", workspace, scope: "read-write" }),
        `should refuse to mint workspace ${JSON.stringify(workspace)}`,
      ).rejects.toThrow(/workspace/);
    }
    await expect(
      mintToken(SECRET, {
        sub: "s",
        workspace: WORKSPACE,
        scope: "admin" as "read-write",
      }),
    ).rejects.toThrow(/scope/);
    await expect(
      mintToken(SECRET, {
        sub: "s",
        workspace: WORKSPACE,
        scope: "read-write",
        iat: 1.5,
      }),
    ).rejects.toThrow(/iat/);
  });
});

import { describe, expect, it } from "vitest";
import { isTokenScope, mintToken, verifyToken } from "../src/token.js";

const SECRET = "a-dev-secret";

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
      workspace: "main",
      scope: "read-write",
    });

    const claims = await verifyToken(SECRET, token);

    expect(claims).not.toBeNull();
    expect(claims?.sub).toBe("agent:claude");
    expect(claims?.workspace).toBe("main");
    expect(claims?.scope).toBe("read-write");
    expect(claims?.iat).toBeTypeOf("number");
  });

  it("produces a two-part base64url token", async () => {
    const token = await mintToken(SECRET, {
      sub: "s",
      workspace: "main",
      scope: "read-only",
      iat: 0,
    });

    expect(token.split(".")).toHaveLength(2);
    expect(token).toMatch(/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
  });

  it("rejects a token signed with another secret", async () => {
    const token = await mintToken(SECRET, {
      sub: "s",
      workspace: "main",
      scope: "read-write",
    });

    expect(await verifyToken("another-secret", token)).toBeNull();
  });

  it("rejects a tampered payload", async () => {
    const token = await mintToken(SECRET, {
      sub: "s",
      workspace: "main",
      scope: "read-only",
      iat: 0,
    });
    const forged = await mintToken("irrelevant", {
      sub: "s",
      workspace: "main",
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
    const minted = { sub: "s", workspace: "main", scope: "read-only", iat: 0 };

    // The forging rig itself has to produce a valid token, or the rejections
    // below would prove nothing.
    expect(await verifyToken(SECRET, await forge(minted))).not.toBeNull();

    for (const claims of [
      { sub: "s", workspace: "main", iat: 0 }, // incomplete: no scope
      { ...minted, sub: "" },
      { ...minted, workspace: "" },
      // A workspace is one room segment; the hub compares it against the
      // segment it parses out of a room name, so anything else is not a claim
      // the minter would sign.
      { ...minted, workspace: "main/other" },
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
      mintToken("", { sub: "s", workspace: "main", scope: "read-write" }),
    ).rejects.toThrow(/secret/);
    await expect(
      mintToken(SECRET, { sub: "", workspace: "main", scope: "read-write" }),
    ).rejects.toThrow(/sub/);
    await expect(
      mintToken(SECRET, { sub: "s", workspace: "", scope: "read-write" }),
    ).rejects.toThrow(/workspace/);
    await expect(
      mintToken(SECRET, { sub: "s", workspace: "a/b", scope: "read-write" }),
    ).rejects.toThrow(/workspace/);
    await expect(
      mintToken(SECRET, {
        sub: "s",
        workspace: "main",
        scope: "admin" as "read-write",
      }),
    ).rejects.toThrow(/scope/);
    await expect(
      mintToken(SECRET, {
        sub: "s",
        workspace: "main",
        scope: "read-write",
        iat: 1.5,
      }),
    ).rejects.toThrow(/iat/);
  });

  it("knows its scopes", () => {
    expect(isTokenScope("read-write")).toBe(true);
    expect(isTokenScope("read-only")).toBe(true);
    expect(isTokenScope("readonly")).toBe(false);
    expect(isTokenScope(undefined)).toBe(false);
  });
});

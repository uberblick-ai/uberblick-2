/**
 * The hub token, as the client mints it.
 *
 * `src/collab/token.ts` re-exports `@uberblick/hub/token` — one definition of
 * the wire format, shared by the minter and the verifier. This suite is the
 * cross-package check that the client's call site actually produces something
 * the hub accepts: it mints through the client's import and verifies with the
 * hub's own verifier. If these two ever drift, every browser connection fails
 * its auth handshake, which is a miserable thing to debug live.
 */

import { describe, expect, it } from "vitest";
import { verifyToken } from "@uberblick/hub/token";
import { DEFAULT_WORKSPACE } from "@uberblick/schema";
import { mintToken } from "../src/collab/token.js";

const SECRET = "dev-secret";

describe("client-minted tokens", () => {
  it("verifies against the hub with the claims intact", async () => {
    const token = await mintToken(SECRET, {
      sub: "loitering otter",
      workspace: DEFAULT_WORKSPACE,
      scope: "read-write",
    });
    const claims = await verifyToken(SECRET, token);
    expect(claims).not.toBeNull();
    expect(claims?.sub).toBe("loitering otter");
    expect(claims?.workspace).toBe(DEFAULT_WORKSPACE);
    expect(claims?.scope).toBe("read-write");
    expect(typeof claims?.iat).toBe("number");
  });

  it("is rejected under a different secret", async () => {
    const token = await mintToken(SECRET, {
      sub: "agent",
      workspace: DEFAULT_WORKSPACE,
      scope: "read-write",
    });
    expect(await verifyToken("other-secret", token)).toBeNull();
  });

  it("carries a read-only scope through, so the hub can downgrade a connection", async () => {
    const token = await mintToken(SECRET, {
      sub: "viewer",
      workspace: DEFAULT_WORKSPACE,
      scope: "read-only",
    });
    expect((await verifyToken(SECRET, token))?.scope).toBe("read-only");
  });

  it("is two base64url segments", async () => {
    const token = await mintToken(SECRET, {
      sub: "agent",
      workspace: DEFAULT_WORKSPACE,
      scope: "read-write",
      iat: 1_700_000_000,
    });
    const parts = token.split(".");
    expect(parts).toHaveLength(2);
    for (const part of parts) expect(part).toMatch(/^[A-Za-z0-9_-]+$/);
  });

  it("is byte-stable when `iat` is pinned", async () => {
    const request = {
      sub: "agent",
      workspace: DEFAULT_WORKSPACE,
      scope: "read-write",
      iat: 1_700_000_000,
    } as const;
    expect(await mintToken(SECRET, request)).toBe(await mintToken(SECRET, request));
  });

  it("refuses a workspace that would break the room key", async () => {
    // Rooms are `<workspace>/<uuid>`; a slash in the workspace claim would let a
    // token authorise a room name it does not name.
    await expect(
      mintToken(SECRET, {
        sub: "agent",
        workspace: "main/evil",
        scope: "read-write",
      }),
    ).rejects.toThrow(/workspace/);
  });
});

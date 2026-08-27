/**
 * Auth is claims-based, so these tests are about *what the token says*, not
 * about whether a string matched: a valid signature is not enough if the room
 * belongs to another workspace, and a read-only scope has to actually stop
 * writes at the server rather than merely being advertised to the client.
 */

import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { HocuspocusProvider } from "@hocuspocus/provider";
import * as Y from "yjs";
import type { Hub } from "../src/server.js";
import { importRootSecret } from "../src/token.js";
import {
  OTHER_WORKSPACE,
  TEST_SECRET,
  WORKSPACE,
  TEXT_KEY,
  createClient,
  removeTempDatabases,
  sleep,
  startHub,
  testRoom,
  token,
  waitForText,
  type TestClient,
} from "./helpers.js";

let hub: Hub;
const clients: TestClient[] = [];

/**
 * Correctly sign an arbitrary payload with the hub's own secret — a token the
 * minter would refuse to produce, which is exactly what the clamp is for.
 */
async function forgeToken(claims: Record<string, unknown>): Promise<string> {
  const payload = Buffer.from(JSON.stringify(claims)).toString("base64url");
  const key = await importRootSecret(TEST_SECRET);
  const signature = Buffer.from(
    await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(payload)),
  ).toString("base64url");
  return `${payload}.${signature}`;
}

function client(room: string, jwt: string, doc?: Y.Doc): TestClient {
  const created = createClient({
    port: hub.port,
    room,
    token: jwt,
    ...(doc === undefined ? {} : { doc }),
  });
  clients.push(created);
  return created;
}

beforeAll(async () => {
  hub = await startHub();
});

afterEach(() => {
  for (const created of clients.splice(0)) {
    created.destroy();
  }
});

afterAll(async () => {
  await hub.stop();
  removeTempDatabases();
});

describe("token auth", () => {
  it("accepts a valid read-write token", async () => {
    const connected = client(testRoom(), await token("read-write"));

    await expect(connected.synced).resolves.toBeUndefined();
  });

  it("rejects garbage", async () => {
    const rejected = client(testRoom(), "not-a-token");

    await expect(rejected.denied).resolves.toBe("invalid-token");
    await expect(rejected.synced).rejects.toThrow(/invalid-token/);
  });

  it("rejects the raw HUB_AUTH_TOKEN secret", async () => {
    // The secret signs tokens; it is not one. An opaque-string auth scheme
    // would have accepted this.
    const rejected = client(testRoom(), TEST_SECRET);

    await expect(rejected.denied).resolves.toBe("invalid-token");
  });

  it("rejects a valid token from another workspace", async () => {
    const foreign = await token("read-write", {
      workspace: OTHER_WORKSPACE,
      sub: "intruder",
    });
    const rejected = client(testRoom(), foreign);

    await expect(rejected.denied).resolves.toBe("workspace-mismatch");
  });

  it("lets a token open its own workspace's rooms", async () => {
    const other = await token("read-write", { workspace: OTHER_WORKSPACE });
    const connected = client(testRoom(OTHER_WORKSPACE), other);

    await expect(connected.synced).resolves.toBeUndefined();
  });

  it("rejects a room name that is not <workspace>/<uuid>", async () => {
    const rejected = client("bare-room-name", await token("read-write"));

    await expect(rejected.denied).resolves.toBe("workspace-mismatch");
  });

  it("rejects a room whose workspace segment is not a workspace id", async () => {
    // A slug-decorated spelling names no room: the identity is the uuid, and
    // the token claim the hub compares against carries only that.
    const rejected = client(
      `uberblick-${testRoom()}`,
      await token("read-write"),
    );

    await expect(rejected.denied).resolves.toBe("workspace-mismatch");
  });

  it("rejects a token passed in the URL query string", async () => {
    // Even though the auth message also carries a valid token: query strings
    // leak into access logs and proxy traces, so their presence is fatal.
    const valid = await token("read-write");
    const provider = new HocuspocusProvider({
      url: `ws://127.0.0.1:${hub.port}/?token=${valid}`,
      name: testRoom(),
      token: valid,
      document: new Y.Doc(),
    });
    const denied = new Promise<string>((resolve) => {
      provider.on("authenticationFailed", ({ reason }: { reason: string }) => {
        resolve(reason);
      });
    });

    try {
      await expect(denied).resolves.toBe("token-in-query");
    } finally {
      provider.destroy();
    }
  });

  it("refuses a token that outlived the hub's ceiling, whatever it claimed", async () => {
    // Signed with the hub's own secret and correct in every other way: only
    // the lifetime is wrong. Forged rather than minted, because `mintToken`
    // refuses to sign this — and a compromised local minter would not use it.
    const now = Math.floor(Date.now() / 1000);
    const decade = await forgeToken({
      typ: "room",
      sub: "a-compromised-machine",
      workspace: WORKSPACE,
      scope: "read-write",
      kid: null,
      iat: now,
      exp: now + 10 * 365 * 24 * 60 * 60,
    });

    const rejected = client(testRoom(), decade);

    await expect(rejected.denied).resolves.toBe("invalid-token");
  });

  it("refuses an expired token", async () => {
    const now = Math.floor(Date.now() / 1000);
    const stale = await forgeToken({
      typ: "room",
      sub: "yesterday",
      workspace: WORKSPACE,
      scope: "read-write",
      kid: null,
      iat: now - 1_800,
      exp: now - 900,
    });

    const rejected = client(testRoom(), stale);

    await expect(rejected.denied).resolves.toBe("invalid-token");
  });

  describe("read-only scope", () => {
    it("syncs down but cannot write", async () => {
      const room = testRoom();
      const writer = client(room, await token("read-write", { sub: "writer" }));
      await writer.synced;
      writer.text.insert(0, "written by the hub client");

      const reader = client(room, await token("read-only", { sub: "reader" }));
      await reader.synced;

      // Down: the reader sees the writer's content.
      await waitForText("reader", reader.text, "written by the hub client");

      // Up: nothing. The update is refused at the server, so it neither
      // reaches the writer nor the server's copy of the document.
      reader.text.insert(0, "SMUGGLED ");
      await sleep(400);

      expect(writer.text.toString()).toBe("written by the hub client");
      const serverDoc = hub.hocuspocus.documents.get(room);
      expect(serverDoc?.getText(TEXT_KEY).toString()).toBe(
        "written by the hub client",
      );
    });
  });
});

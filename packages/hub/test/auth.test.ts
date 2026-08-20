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
import {
  TEST_SECRET,
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
    expect(connected.provider.isAuthenticated).toBe(true);
    expect(connected.provider.authorizedScope).toBe("read-write");
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
      workspace: "other",
      sub: "intruder",
    });
    const rejected = client(testRoom("main"), foreign);

    await expect(rejected.denied).resolves.toBe("workspace-mismatch");
  });

  it("lets a token open its own workspace's rooms", async () => {
    const other = await token("read-write", { workspace: "other" });
    const connected = client(testRoom("other"), other);

    await expect(connected.synced).resolves.toBeUndefined();
  });

  it("rejects a room name that is not <workspace>/<uuid>", async () => {
    const rejected = client("bare-room-name", await token("read-write"));

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
      expect(reader.provider.authorizedScope).toBe("readonly");

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

    it("does not persist its writes", async () => {
      const room = testRoom();
      const reader = client(room, await token("read-only"));
      await reader.synced;

      reader.text.insert(0, "SMUGGLED");
      await sleep(200);
      await hub.flush();

      // Reconnecting read-write to the same room shows the server's state, not
      // the read-only client's local one.
      const writer = client(room, await token("read-write"));
      await writer.synced;
      await sleep(200);

      expect(writer.text.toString()).toBe("");
    });
  });
});

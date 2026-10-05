/**
 * Auth is claims-based, so these tests are about *what the token says*, not
 * about whether a string matched: a valid signature is not enough if the room
 * belongs to another workspace, and a read-only scope has to actually stop
 * writes at the server rather than merely being advertised to the client.
 * Every refused token — garbage, the raw secret, a forged lifetime, an expired
 * or foreign-workspace token — is presented in `auth-log.test.ts`, which
 * checks what the client is told and what the hub logs.
 */

import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { HocuspocusProvider } from "@hocuspocus/provider";
import * as Y from "yjs";
import type { Hub } from "../src/server.js";
import {
  OTHER_WORKSPACE,
  TEXT_KEY,
  createClient,
  removeTempDatabases,
  startHub,
  testRoom,
  token,
  waitForText,
  waitUntil,
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
  });

  it("lets a token open its own workspace's rooms", async () => {
    const other = await token("read-write", { workspace: OTHER_WORKSPACE });
    const connected = client(testRoom(OTHER_WORKSPACE), other);

    await expect(connected.synced).resolves.toBeUndefined();
  });

  it("rejects a room name that is not <workspace>/<uuid>", async () => {
    const rejected = client("bare-room-name", await token("read-write"));
    await expect(rejected.denied).resolves.toBe("workspace-mismatch");

    // A slug-decorated spelling names no room either: the identity is the
    // uuid, and the token claim the hub compares against carries only that.
    const decorated = client(`uberblick-${testRoom()}`, await token("read-write"));
    await expect(decorated.denied).resolves.toBe("workspace-mismatch");
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

      // Up: nothing. The update is refused at the server, so it neither
      // reaches the writer nor the server's copy of the document. The
      // awareness frame sent behind it on the same socket is the barrier: the
      // server drains a connection in order, so once that arrives the update
      // has already been handled (see hocuspocus-seams.test.ts).
      reader.text.insert(0, "SMUGGLED ");
      reader.provider.setAwarenessField("name", "the reader");
      const serverDoc = hub.hocuspocus.documents.get(room);
      await waitUntil("the reader's awareness to reach the hub", () =>
        [...(serverDoc?.awareness.getStates().values() ?? [])].some(
          (state) => (state as { name?: string }).name === "the reader",
        ),
      );

      expect(writer.text.toString()).toBe("written by the hub client");
      expect(serverDoc?.getText(TEXT_KEY).toString()).toBe(
        "written by the hub client",
      );
    });
  });
});

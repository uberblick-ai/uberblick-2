/**
 * Auth is claims-based, so these tests are about *what the token says*, not
 * about whether a string matched: a valid signature is not enough if the room
 * belongs to another workspace, and a read-only scope has to actually stop
 * writes at the server rather than merely being advertised to the client.
 * Refused tokens and query-string tokens are presented in `auth-log.test.ts`,
 * which checks what the client is told and what the hub logs; refused room
 * names are in `room-admission.test.ts`.
 */

import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import type * as Y from "yjs";
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
      // library accepts awareness from a read-only connection and drains a
      // connection in order, so once that arrives the update has been handled.
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

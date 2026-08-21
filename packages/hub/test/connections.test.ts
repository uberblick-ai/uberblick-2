/**
 * Connection lifecycle logging. The hub is the first log a human opens when
 * sync misbehaves, so a connection coming and going has to be readable there —
 * per room, with the token's identity, and with a reason for the close.
 */

import { afterAll, describe, expect, it } from "vitest";
import type { HubLogRecord } from "../src/log.js";
import type { Hub } from "../src/server.js";
import {
  createClient,
  removeTempDatabases,
  startHub,
  testRoom,
  token,
  waitUntil,
} from "./helpers.js";

const hubs: Hub[] = [];

afterAll(async () => {
  for (const hub of hubs) {
    await hub.stop();
  }
  removeTempDatabases();
});

describe("connection lifecycle", () => {
  it("logs a room opening and closing", async () => {
    const records: HubLogRecord[] = [];
    const hub = await startHub({
      log: (record) => {
        records.push(record);
      },
    });
    hubs.push(hub);

    const room = testRoom();
    const client = createClient({
      port: hub.port,
      room,
      token: await token("read-write", { sub: "lifecycle-client" }),
    });
    await client.synced;

    expect(records).toContainEqual(
      expect.objectContaining({
        event: "hub.room.connected",
        room,
        sub: "lifecycle-client",
      }),
    );

    client.destroy();
    await waitUntil("the close to be logged", () =>
      records.some((record) => record.event === "hub.room.closed"),
    );

    const closed = records.find((record) => record.event === "hub.room.closed");
    expect(closed).toMatchObject({ room, sub: "lifecycle-client" });
    // A close always says why, even when the socket left without a reason.
    expect(closed?.reason).toBeTruthy();
  });
});

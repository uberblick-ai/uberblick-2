/**
 * A stop the clients can see.
 *
 * `Hub.stop()` promises to quiesce connections, and what Hocuspocus closes are
 * *rooms*: the socket underneath survives its last document, so an in-process
 * shutdown is indistinguishable from silence to everyone connected until their
 * own dead-connection timer fires half a minute later — while a killed hub is
 * noticed in milliseconds. This is that promise, held to the client's side of
 * the wire; `shutdown.test.ts` covers the signal path around it.
 */

import { afterEach, expect, it } from "vitest";
import type { Hub } from "../src/server.js";
import {
  createClient,
  removeTempDatabases,
  startHub,
  testRoom,
  token,
  waitUntil,
  type TestClient,
} from "./helpers.js";

/** How long after `stop()` the close frame may still be in flight. */
const SHUTDOWN_GRACE_MS = 2_000;

/**
 * The provider's own dead-connection timer, pushed past any deadline this test
 * will wait for: a pass has to be the frame the hub sent, never the client
 * eventually concluding the socket was dead.
 */
const OUT_OF_REACH_MS = 60_000;

const clients: TestClient[] = [];
const hubs: Hub[] = [];

afterEach(async () => {
  // Clients first: a live provider redials the hub it is being torn down with.
  for (const client of clients.splice(0)) {
    client.destroy();
  }
  for (const hub of hubs.splice(0)) {
    await hub.stop();
  }
  removeTempDatabases();
});

it("closes every client websocket when it stops", async () => {
  const started = await startHub();
  hubs.push(started);

  const subs = ["one", "two"];
  const disconnected = new Set<string>();

  for (const sub of subs) {
    const client = createClient({
      port: started.port,
      room: testRoom(),
      token: await token("read-write", { sub }),
      messageReconnectTimeout: OUT_OF_REACH_MS,
    });
    clients.push(client);
    // Latched rather than read back afterwards: a disconnected provider starts
    // redialling, so the status itself does not stay put long enough to assert.
    client.provider.on("status", ({ status }: { status: string }) => {
      if (status === "disconnected") {
        disconnected.add(sub);
      }
    });
    await client.synced;
  }

  await started.stop();

  await waitUntil(
    "both clients to see the hub go",
    () => disconnected.size === subs.length,
    SHUTDOWN_GRACE_MS,
  );
  expect([...disconnected].sort()).toEqual(subs);
});

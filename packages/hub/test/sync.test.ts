/**
 * Convergence through a real hub: concurrent editing and reconnect after an
 * offline stretch. Raw Y.Text rather than the schema block model on purpose —
 * what is under test is the transport and the server's document handling, and
 * the CRDT guarantees the rest.
 */

import { afterEach, describe, expect, it } from "vitest";
import type { Hub } from "../src/server.js";
import {
  TEXT_KEY,
  createClient,
  removeTempDatabases,
  sleep,
  startHub,
  testRoom,
  token,
  waitUntil,
  type TestClient,
} from "./helpers.js";

const clients: TestClient[] = [];
const hubs: Hub[] = [];

async function hub(): Promise<Hub> {
  const started = await startHub();
  hubs.push(started);
  return started;
}

async function client(
  started: Hub,
  room: string,
  sub: string,
): Promise<TestClient> {
  const created = createClient({
    port: started.port,
    room,
    token: await token("read-write", { sub }),
  });
  clients.push(created);
  await created.synced;
  return created;
}

afterEach(async () => {
  for (const created of clients.splice(0)) {
    created.destroy();
  }
  for (const started of hubs.splice(0)) {
    await started.stop();
  }
  removeTempDatabases();
});

describe("co-editing", () => {
  it("converges two clients with no lost updates", async () => {
    const started = await hub();
    const room = testRoom();
    const alice = await client(started, room, "alice");
    const bob = await client(started, room, "bob");

    // Interleaved, unsynchronised inserts from both sides: whoever wins each
    // race, every fragment has to survive.
    const fragments: string[] = [];
    for (let index = 0; index < 20; index += 1) {
      const a = `a${index}.`;
      const b = `b${index}.`;
      alice.text.insert(alice.text.length, a);
      bob.text.insert(bob.text.length, b);
      fragments.push(a, b);
      if (index % 5 === 0) {
        await sleep(5);
      }
    }

    await waitUntil(
      "alice and bob to converge",
      () =>
        alice.text.toString() === bob.text.toString() &&
        alice.text.length === fragments.join("").length,
    );

    const converged = alice.text.toString();
    expect(bob.text.toString()).toBe(converged);
    for (const fragment of fragments) {
      expect(converged).toContain(fragment);
    }

    // The server's own replica converged to the same thing.
    const serverDoc = started.hocuspocus.documents.get(room);
    expect(serverDoc?.getText(TEXT_KEY).toString()).toBe(converged);
  });
});

describe("offline convergence", () => {
  it("merges edits made while a client was disconnected", async () => {
    const started = await hub();
    const room = testRoom();
    const alice = await client(started, room, "alice");
    const bob = await client(started, room, "bob");

    alice.text.insert(0, "[shared]");
    await waitUntil(
      "bob to see the shared prefix",
      () => bob.text.toString() === "[shared]",
    );

    // Bob goes offline. The provider clears its outgoing queue on disconnect,
    // so his edits genuinely live only in his local replica until he is back.
    bob.provider.disconnect();
    await waitUntil("bob to be disconnected", () => !bob.provider.isSynced);

    alice.text.insert(alice.text.length, "[alice-online]");
    bob.text.insert(bob.text.length, "[bob-offline]");
    await sleep(200);

    expect(alice.text.toString()).not.toContain("[bob-offline]");
    expect(bob.text.toString()).not.toContain("[alice-online]");

    await bob.provider.connect();
    await waitUntil(
      "alice and bob to converge after reconnect",
      () =>
        alice.text.toString() === bob.text.toString() &&
        alice.text.toString().includes("[bob-offline]"),
    );

    const converged = alice.text.toString();
    expect(converged).toContain("[shared]");
    expect(converged).toContain("[alice-online]");
    expect(converged).toContain("[bob-offline]");
    expect(bob.text.toString()).toBe(converged);

    const serverDoc = started.hocuspocus.documents.get(room);
    expect(serverDoc?.getText(TEXT_KEY).toString()).toBe(converged);
  });
});

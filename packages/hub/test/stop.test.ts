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

import {
  HocuspocusProvider,
  HocuspocusProviderWebsocket,
  type onCloseParameters,
} from "@hocuspocus/provider";
import { afterEach, expect, it, vi } from "vitest";
import * as Y from "yjs";
import { wrapToken } from "../src/protocol.js";
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

it("closes a multiplexed socket before its rooms can provoke the pending guard", async () => {
  const started = await startHub({ maxPendingDocuments: 1 });
  hubs.push(started);

  const warnings: string[] = [];
  const warning = vi.spyOn(console, "warn").mockImplementation((...args) => {
    const line = args.map(String).join(" ");
    if (line.includes("too many pending unauthenticated documents")) {
      warnings.push(line);
    }
  });
  const websocket = new HocuspocusProviderWebsocket({
    url: `ws://127.0.0.1:${started.port}`,
    autoConnect: false,
    delay: OUT_OF_REACH_MS,
    minDelay: OUT_OF_REACH_MS,
  });
  const providers: HocuspocusProvider[] = [];
  let releaseStore!: () => void;
  const storeReleased = new Promise<void>((resolve) => {
    releaseStore = resolve;
  });
  let storeStarted = false;
  let stopping: Promise<void> | undefined;

  try {
    let closed: { code: number; reason: string } | undefined;
    websocket.on("close", ({ event }: onCloseParameters) => {
      closed = { code: event.code, reason: event.reason };
    });

    const wireToken = wrapToken(await token());
    const docs: Y.Doc[] = [];
    for (let index = 0; index < 2; index += 1) {
      const doc = new Y.Doc();
      docs.push(doc);
      const provider = new HocuspocusProvider({
        websocketProvider: websocket,
        name: testRoom(),
        token: wireToken,
        document: doc,
        onClose: () => {
          // A per-room Close while the socket remains open provokes one frame
          // from that room. A websocket close queues it for the next handshake.
          doc.getText("reply").insert(0, String(index));
        },
      });
      providers.push(provider);

      const synced = new Promise<void>((resolve) => {
        provider.on("synced", () => resolve());
      });
      provider.attach();
      if (index === 0) {
        await websocket.connect();
      }
      await synced;
    }

    docs[0]?.getText("stored").insert(0, "hold the final flush");
    await waitUntil(
      "the update to reach the hub",
      () =>
        [...started.hocuspocus.documents.values()].some(
          (doc) => doc.getText("stored").toString() === "hold the final flush",
        ),
    );

    const storeDocumentHooks = started.hocuspocus.storeDocumentHooks.bind(
      started.hocuspocus,
    );
    vi.spyOn(started.hocuspocus, "storeDocumentHooks").mockImplementation(
      async (...args) => {
        storeStarted = true;
        await storeReleased;
        return storeDocumentHooks(...args);
      },
    );

    stopping = started.stop();
    await waitUntil("the final store to start", () => storeStarted);
    await waitUntil("the websocket close to land", () => closed !== undefined);

    expect(closed).toEqual({ code: 1001, reason: "hub shutting down" });
    expect(warnings).toEqual([]);

    releaseStore();
    await stopping;
  } finally {
    releaseStore();
    await stopping?.catch(() => {});
    for (const provider of providers) {
      provider.destroy();
    }
    websocket.destroy();
    warning.mockRestore();
  }
});

/**
 * Spike: can the hub fill a document collection from an outside source?
 * Throwaway measurements, never merged. Prints findings with console.log.
 */
import { afterEach, describe, expect, it } from "vitest";
import * as Y from "yjs";
import { DATA_KEY, initDoc, prepareDocData, readDocData } from "@uberblick/schema";
import type { Hub } from "../src/server.js";
import {
  createClient, removeTempDatabases, startHub, tempDatabasePath, testRoom, token,
  waitUntil, type TestClient,
} from "./helpers.js";

const clients: TestClient[] = [];
const hubs: Hub[] = [];
afterEach(async () => {
  for (const c of clients.splice(0)) c.provider.destroy();
  for (const h of hubs.splice(0)) await h.stop().catch(() => {});
  removeTempDatabases();
});

const SCHEMA = {
  version: 1,
  schema: {
    type: "object",
    properties: { time: { type: "string" }, p95: { type: "number" }, throughput: { type: "number" } },
    required: ["time"],
    additionalProperties: false,
  },
} as const;

const HOUR = 3_600_000;
function rows(endHour: number, hours: number, bump = 0) {
  return Array.from({ length: hours }, (_, i) => {
    const h = endHour - hours + 1 + i;
    const t = new Date(h * HOUR).toISOString();
    return { id: t, value: { time: t, p95: 180 + ((h * 37) % 50) + (i === hours - 1 ? bump : 0), throughput: 1200 + ((h * 53) % 400) } };
  });
}

async function client(hub: Hub, room: string, doc?: Y.Doc): Promise<TestClient> {
  const created = createClient({ port: hub.port, room, token: await token("read-write"), ...(doc ? { doc } : {}) });
  clients.push(created);
  await created.synced;
  return created;
}

describe("spike: live data written by the hub", () => {
  it("fills a sourced collection through a direct connection and measures sync cost", async () => {
    const databasePath = tempDatabasePath();
    const hub = await startHub({ databasePath });
    hubs.push(hub);
    const room = testRoom();
    const uuid = room.split("/")[1] ?? "";
    const reader = await client(hub, room);
    reader.doc.transact(() => {
      initDoc(reader.doc, { uuid, title: "Release 0.4.8" });
      reader.doc.getMap(DATA_KEY).set(JSON.stringify(["source", "latency"]), {
        version: 1, connection: "newrelic", template: "nrql",
        params: { nrql: "SELECT percentile(duration, 95) AS p95, rate(count(*), 1 minute) AS throughput FROM Transaction TIMESERIES 1 hour SINCE 7 days ago" },
        refresh: "15m",
      });
    });
    await waitUntil("hub has the source", () =>
      hub.hocuspocus.documents.get(room)?.getMap(DATA_KEY).has(JSON.stringify(["source", "latency"])) === true);

    const received: number[] = [];
    reader.doc.on("update", (update: Uint8Array, origin: unknown) => {
      if (origin !== null && typeof origin === "object" && "provider" in (origin as object)) received.push(update.byteLength);
      else if (origin !== null) received.push(update.byteLength);
    });

    // What the runner would do: write records and fetch status as the hub.
    const context = { writer: "live-data", connection: "newrelic" };
    const direct = await hub.hocuspocus.openDirectConnection(room, context);
    const origins: unknown[] = [];
    const hubDoc = hub.hocuspocus.documents.get(room);
    hubDoc?.on("afterTransaction", (t: Y.Transaction) => { if (t.local) origins.push(t.origin); });
    const refresh = async (data: ReturnType<typeof rows>, fetchedAt: string) => {
      await direct.transact((doc) => {
        const plan = prepareDocData(doc, new Y.Doc(), [{ collection: "latency", schema: SCHEMA, replaceRecords: data }]);
        plan.commit();
        doc.getMap(DATA_KEY).set(JSON.stringify(["fetch", "latency"]), { state: "ok", fetchedAt });
      });
    };

    const end = 494_000; // an arbitrary hour index
    await refresh(rows(end, 168), "2026-10-21T08:00:00Z");
    await waitUntil("reader has 168 records", () => readDocData(reader.doc)?.collections[0]?.records.length === 168);
    const firstFill = received.reduce((a, b) => a + b, 0);
    const areaBytes = readDocData(reader.doc)?.bytes ?? 0;

    // Same hour, the current bucket moved: one record changes.
    received.length = 0;
    await refresh(rows(end, 168, 25), "2026-10-21T08:15:00Z");
    await waitUntil("reader sees the bump", () => received.length > 0);
    await new Promise((r) => setTimeout(r, 200));
    const sameHour = received.reduce((a, b) => a + b, 0);

    // Next hour: window slides, one record added, one dropped, last changes.
    received.length = 0;
    await refresh(rows(end + 1, 168), "2026-10-21T09:15:00Z");
    await waitUntil("reader sees the slide", () => received.length > 0);
    await new Promise((r) => setTimeout(r, 200));
    const nextHour = received.reduce((a, b) => a + b, 0);

    // Identical result: nothing but the fetch timestamp should travel.
    received.length = 0;
    await refresh(rows(end + 1, 168), "2026-10-21T09:30:00Z");
    await waitUntil("reader sees the timestamp", () => received.length > 0);
    await new Promise((r) => setTimeout(r, 200));
    const unchanged = received.reduce((a, b) => a + b, 0);

    // A day of 15-minute refreshes: the last bucket moves each time, the window slides hourly.
    received.length = 0;
    for (let q = 1; q <= 96; q++) {
      await refresh(rows(end + 1 + Math.floor(q / 4), 168, q % 4 * 7), `day-${q}`);
    }
    await new Promise((r) => setTimeout(r, 500));
    const dayBytes = received.reduce((a, b) => a + b, 0);
    console.log(JSON.stringify({ spike: "a day of refreshes", refreshes: 96, bytesSynced: dayBytes,
      docStateBytes: Y.encodeStateAsUpdate(reader.doc).byteLength }));

    const view = readDocData(reader.doc);
    const stateBytes = Y.encodeStateAsUpdate(reader.doc).byteLength;
    console.log(JSON.stringify({
      spike: "sync cost", firstFillBytes: firstFill, dataAreaBytes: areaBytes,
      sameHourRefreshBytes: sameHour, nextHourRefreshBytes: nextHour, unchangedRefreshBytes: unchanged,
      docStateBytesAfter4Refreshes: stateBytes,
      oldClientView: { collectionValid: view?.collections.find((c) => c.name === "latency")?.valid,
        topLevelErrors: view?.errors.map((e) => e.reason) },
      hubTransactionOrigins: origins.slice(0, 1),
    }, null, 1));
    expect(view?.collections.find((c) => c.name === "latency")?.records.length).toBe(168);

    // An old client can still write into the hub-owned collection today.
    const plan = prepareDocData(reader.doc, new Y.Doc(), [{ collection: "latency", upsert: [{ id: "x", value: { time: "2026-01-01T00:00:00Z" } }] }]);
    console.log(JSON.stringify({ spike: "old client may write into a sourced collection", changed: plan.changed }));

    // Durable: restart and read back.
    await direct.disconnect({ unloadImmediately: false });
    await hub.flush();
    reader.provider.destroy();
    clients.length = 0;
    await hub.stop();
    hubs.length = 0;
    const again = await startHub({ databasePath });
    hubs.push(again);
    const later = await client(again, room);
    const persisted = readDocData(later.doc)?.collections.find((c) => c.name === "latency")?.records.length;
    console.log(JSON.stringify({ spike: "persisted after restart", records: persisted }));
    expect(persisted).toBe(168);
  });

  it("tells a viewer or agent apart from a bare replica in awareness", async () => {
    const hub = await startHub();
    hubs.push(hub);
    const room = testRoom();
    const replica = await client(hub, room);
    const browser = await client(hub, room);
    const agent = await client(hub, room);
    // A bare replica publishes nothing; the web and MCP set user + client.
    replica.provider.awareness?.setLocalState(null);
    browser.provider.setAwarenessField("user", { name: "Ben", color: "#5a3fd0" });
    browser.provider.setAwarenessField("client", "web");
    agent.provider.setAwarenessField("user", { name: "Claude Code", color: "#bc7509" });
    agent.provider.setAwarenessField("client", "agent");
    const hubAwareness = () => hub.hocuspocus.documents.get(room)?.awareness;
    const lookers = () => [...(hubAwareness()?.getStates().values() ?? [])]
      .filter((s) => typeof s.user === "object" && (s.client === "web" || s.client === "agent"))
      .map((s) => s.client as string).sort();
    await waitUntil("hub sees both lookers", () => lookers().length === 2);
    const all = [...(hubAwareness()?.getStates().values() ?? [])];
    console.log(JSON.stringify({ spike: "presence at hub", states: all.length, lookers: lookers() }));

    // Leaving: the web withdraws user/client with an ordinary update.
    browser.provider.awareness?.setLocalState({});
    await waitUntil("hub drops the viewer", () => lookers().length === 1);
    const started = Date.now();
    agent.provider.destroy();
    let agentGoneMs: number | null = null;
    try {
      await waitUntil("hub drops the agent", () => lookers().length === 0, 40_000);
      agentGoneMs = Date.now() - started;
    } catch { agentGoneMs = null; }
    console.log(JSON.stringify({ spike: "presence removal", agentGoneAfterDisconnectMs: agentGoneMs }));
  }, 60_000);
});

// Loopback probe: can a durable-before-ack gate be built on pinned Hocuspocus 4.6.0?
// A: throwing `beforeSync` (pre-apply hook)        -> expect: no apply, no ack, no broadcast
// B: throwing `document.on('update')` listener      -> expect: applied, ack suppressed, broadcast still leaks, Yjs cleanup damaged
// C: recording (non-throwing) `update` listener     -> baseline: ack and broadcast both happen
import { Server } from "/Users/ben/Projects/Uberblick/uberblick-crdt/node_modules/.pnpm/@hocuspocus+server@4.6.0_y-protocols@1.0.7_yjs@13.6.32__yjs@13.6.32/node_modules/@hocuspocus/server/dist/hocuspocus-server.esm.js";
import { HocuspocusProvider } from "/Users/ben/Projects/Uberblick/uberblick-crdt/node_modules/.pnpm/@hocuspocus+provider@4.6.0_y-protocols@1.0.7_yjs@13.6.32__yjs@13.6.32/node_modules/@hocuspocus/provider/dist/hocuspocus-provider.esm.js";
import * as Y from "/Users/ben/Projects/Uberblick/uberblick-crdt/node_modules/.pnpm/yjs@13.6.32/node_modules/yjs/dist/yjs.mjs";

const messageYjsSyncStep2 = 1;
const messageYjsUpdate = 2;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function provider(url, name, doc) {
  const events = { unsynced: [], close: [], synced: 0 };
  const p = new HocuspocusProvider({
    url, name, document: doc, token: "x", WebSocketPolyfill: WebSocket,
    onUnsyncedChanges: ({ number }) => events.unsynced.push(number),
    onClose: ({ event }) => events.close.push(event?.reason ?? "?"),
    onSynced: () => { events.synced += 1; },
  });
  const t0 = Date.now();
  while (!p.isSynced && Date.now() - t0 < 3000) await sleep(10);
  if (!p.isSynced) throw new Error(`${name}: never synced`);
  return { p, events };
}

async function scenario(label, hooks, opts = {}) {
  const state = { refuse: false, serverUpdates: [], beforeSyncSeen: [] };
  const server = new Server({
    port: 0, address: "127.0.0.1", quiet: true, stopOnSignals: false,
    ...(opts.flushDelay !== undefined ? { flushDelay: opts.flushDelay } : {}),
    ...hooks(state),
  });
  await server.listen();
  const url = `ws://127.0.0.1:${server.address.port}`;
  const d1 = new Y.Doc(); const d2 = new Y.Doc();
  const A = await provider(url, "room", d1);
  const B = await provider(url, "room", d2);
  await sleep(50);
  A.events.unsynced.length = 0; A.events.close.length = 0;

  // Refused write from A.
  state.refuse = true;
  d1.getText("t").insert(0, "REFUSED");
  await sleep(300);
  const serverDoc = server.hocuspocus.documents.get("room");
  const afterRefusal = {
    A_unsynced_events: [...A.events.unsynced],
    A_hasUnsyncedChanges: A.p.hasUnsyncedChanges,
    A_isSynced: A.p.isSynced,
    A_close_events: [...A.events.close],
    server_text: serverDoc?.getText("t").toString() ?? "<unloaded>",
    server_connections: serverDoc?.getConnectionsCount() ?? 0,
    B_text: d2.getText("t").toString(),
    beforeSync_types_seen: [...state.beforeSyncSeen],
  };

  // Then a legitimate write from B: does the server still emit/broadcast sanely?
  state.refuse = false;
  const before = state.serverUpdates.length;
  d2.getText("t").insert(0, "OK-");
  await sleep(300);
  const afterLegit = {
    server_text: serverDoc?.getText("t").toString(),
    server_update_emissions_for_one_write: state.serverUpdates.length - before,
    B_isSynced: B.p.isSynced, B_hasUnsynced: B.p.hasUnsyncedChanges,
    A_text: d1.getText("t").toString(),
  };

  // Reconnect path: a fresh provider whose doc already holds an unsent edit sends it as SyncStep2.
  let step2 = null;
  if (opts.step2) {
    const d3 = new Y.Doc(); d3.getText("t").insert(0, "FROM-STEP2-");
    state.refuse = true; state.beforeSyncSeen.length = 0;
    const C = new HocuspocusProvider({ url, name: "room", document: d3, token: "x", WebSocketPolyfill: WebSocket });
    await sleep(400);
    step2 = { beforeSync_types_seen: [...state.beforeSyncSeen], server_text: serverDoc?.getText("t").toString(), C_isSynced: C.p?.isSynced ?? C.isSynced, C_unsynced: C.unsyncedChanges };
    C.destroy();
    state.refuse = false;
  }

  A.p.destroy(); B.p.destroy();
  await server.destroy();
  console.log(JSON.stringify({ scenario: label, afterRefusal, afterLegit, step2 }, null, 2));
}

const recordUpdates = (state) => async ({ document }) => {
  document.on("update", (u) => { state.serverUpdates.push(u.length); });
};

await scenario("A: throwing beforeSync (pre-apply hook)", (state) => ({
  afterLoadDocument: recordUpdates(state),
  beforeSync: async ({ type, payload }) => {
    state.beforeSyncSeen.push({ type, bytes: payload.length });
    if (state.refuse && (type === messageYjsUpdate || type === messageYjsSyncStep2)) throw new Error("store refused the append");
  },
}), { step2: true });

await scenario("B: throwing document.on('update') listener (registered after the server's own)", (state) => ({
  afterLoadDocument: async ({ document }) => {
    document.on("update", (u) => { state.serverUpdates.push(u.length); });
    document.on("update", (u, origin) => {
      if (state.refuse && origin && origin.source === "connection") throw new Error("store refused the append");
    });
  },
}));

await scenario("B2: same as B with flushDelay:false (synchronous broadcast)", (state) => ({
  afterLoadDocument: async ({ document }) => {
    document.on("update", (u) => { state.serverUpdates.push(u.length); });
    document.on("update", (u, origin) => {
      if (state.refuse && origin && origin.source === "connection") throw new Error("store refused the append");
    });
  },
}), { flushDelay: false });

await scenario("C: recording listener, never throws (baseline)", (state) => ({
  afterLoadDocument: recordUpdates(state),
}));

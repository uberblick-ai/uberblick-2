/**
 * Scale probe — the hub, in its own process.
 *
 * `createHub` exactly as `packages/hub/src/main.ts` runs it (the owner's Docker
 * hub is this same code in a container), given a temp SQLite file and a port.
 * It lives in its own process only so that RSS and CPU are attributable to the
 * hub and nothing else.
 *
 * Forked with IPC. Messages in: {type:"stats"}, {type:"flush"}, {type:"stop"}.
 */

import { createHub, type Hub } from "@uberblick/hub";
import { monitorEventLoopDelay } from "node:perf_hooks";

const databasePath = process.argv[2] ?? ":memory:";
const port = Number(process.argv[3] ?? 0);

const loopDelay = monitorEventLoopDelay({ resolution: 5 });
loopDelay.enable();

/** Longest single `onStoreDocument` seen, and how many ran. */
let storeWrites = 0;
let storeMaxMs = 0;
let storeTotalMs = 0;
/** Sockets the hub terminated for naming too many unauthenticated documents. */
let pendingCeilingHits = 0;

const originalWarn = console.warn.bind(console);
console.warn = (...args: unknown[]): void => {
  const text = args.map(String).join(" ");
  if (text.includes("too many pending unauthenticated documents")) {
    pendingCeilingHits += 1;
    originalWarn(text);
    return;
  }
  originalWarn(...(args as []));
};

let lastCpu = process.cpuUsage();
let lastCpuAt = Date.now();

async function main(): Promise<void> {
  const hub: Hub = await createHub({
    port,
    address: "127.0.0.1",
    databasePath,
    authSecret: process.env.PROBE_SECRET ?? "scale-probe-hmac-secret",
    log: () => {},
  });

  // Time the hub's own persistence writes. The extension instance is the one
  // `createHub` put on the server configuration; wrapping it here measures the
  // real synchronous full-state upsert without changing it.
  const extensions = (hub.server.configuration as { extensions?: unknown[] })
    .extensions;
  for (const extension of extensions ?? []) {
    const store = extension as {
      onStoreDocument?: (payload: unknown) => Promise<void>;
    };
    if (typeof store.onStoreDocument !== "function") continue;
    const original = store.onStoreDocument.bind(store);
    store.onStoreDocument = async (payload: unknown): Promise<void> => {
      const started = performance.now();
      try {
        await original(payload);
      } finally {
        const elapsed = performance.now() - started;
        storeWrites += 1;
        storeTotalMs += elapsed;
        if (elapsed > storeMaxMs) storeMaxMs = elapsed;
      }
    };
  }

  process.send?.({ type: "ready", port: hub.port, pid: process.pid });

  process.on("message", (message: { type: string }) => {
    if (message.type === "stats") {
      const now = Date.now();
      const cpu = process.cpuUsage();
      const wallMs = now - lastCpuAt;
      const cpuMs = (cpu.user - lastCpu.user + (cpu.system - lastCpu.system)) / 1000;
      lastCpu = cpu;
      lastCpuAt = now;
      const memory = process.memoryUsage();
      process.send?.({
        type: "stats",
        rssMb: memory.rss / 1e6,
        heapUsedMb: memory.heapUsed / 1e6,
        externalMb: memory.external / 1e6,
        arrayBuffersMb: memory.arrayBuffers / 1e6,
        cpuPercent: wallMs > 0 ? (cpuMs / wallMs) * 100 : 0,
        documents: hub.hocuspocus.getDocumentsCount(),
        connections: hub.hocuspocus.getConnectionsCount(),
        roomSubscriptions: [...hub.hocuspocus.documents.values()].reduce(
          (total, document) => total + document.getConnectionsCount(),
          0,
        ),
        storeWrites,
        storeMaxMs,
        storeMeanMs: storeWrites === 0 ? 0 : storeTotalMs / storeWrites,
        pendingCeilingHits,
        loopDelayMaxMs: loopDelay.max / 1e6,
        loopDelayP99Ms: loopDelay.percentile(99) / 1e6,
      });
      loopDelay.reset();
      return;
    }
    if (message.type === "resetStoreStats") {
      storeWrites = 0;
      storeMaxMs = 0;
      storeTotalMs = 0;
      process.send?.({ type: "resetStoreStats" });
      return;
    }
    if (message.type === "flush") {
      void hub
        .flush()
        .then(() => process.send?.({ type: "flush", ok: true }))
        .catch((error: unknown) =>
          process.send?.({ type: "flush", ok: false, error: String(error) }),
        );
      return;
    }
    if (message.type === "stop") {
      void hub
        .stop()
        .catch(() => {})
        .then(() => {
          process.send?.({ type: "stopped" });
          setTimeout(() => process.exit(0), 50);
        });
    }
  });
}

void main().catch((error: unknown) => {
  process.send?.({ type: "error", error: String(error) });
  process.exit(1);
});

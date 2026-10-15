

import type { HocuspocusProviderWebsocket } from "@hocuspocus/provider";
import { afterEach, expect, it, vi } from "vitest";

import { HubSync } from "../src/sync.js";
import { cleanupTestResources, testConfig, type trackListener } from "./core-helpers.js";

const clients: HubSync[] = [];
const listeners: ReturnType<typeof trackListener>[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
  await cleanupTestResources({
    clients: clients.splice(0).map((sync) => () => sync.destroy()),
    hubs: listeners.splice(0).map((listener) => () => listener.close()),
  });
});

function socketProvider(sync: HubSync): HocuspocusProviderWebsocket | null {
  return (sync as unknown as { socket: HocuspocusProviderWebsocket | null }).socket;
}

function nativeSocket(sync: HubSync): WebSocket | null {
  return socketProvider(sync)?.webSocket ?? null;
}

it("destroys immediately when hub synchronization has no socket", async () => {
  const sync = new HubSync(testConfig(), () => {});
  clients.push(sync);
  expect(nativeSocket(sync)).toBeNull();
  let reentrant: Promise<void> | undefined;
  sync.onStateChange(() => { reentrant = sync.destroy(); });
  const closing = sync.destroy();
  expect(reentrant).toBe(closing);
  await closing;
});

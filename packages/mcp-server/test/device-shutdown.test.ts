/** Shutdown must finish storing a replacement already received from the hub. */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { readHubLogins, writeHubLogin } from "@uberblick/mcp-server/auth-store";
import { acquireInitLock } from "@uberblick/mcp-server/init-lock";
import { startDeviceSyncHub } from "@uberblick/hub/test-device-sync";
import { createMcpServer } from "../src/server.js";
import { inspectRemote } from "../src/remote.js";
import { cleanupTestResources, sleep, testConfig, type TestCleanup, WORKSPACE } from "./helpers.js";

const clients: TestCleanup[] = [];
const hubs: TestCleanup[] = [];
const after: TestCleanup[] = [];
afterEach(async () => {
  await cleanupTestResources({ clients: clients.splice(0), hubs: hubs.splice(0), after: after.splice(0) });
});

it("waits for conditional credential publication before completing server shutdown", async () => {
  const directory = mkdtempSync(join(tmpdir(), `device-shutdown-${process.env.UB_AGENTS_RUN ?? "test"}-`));
  after.push(() => rmSync(directory, { recursive: true, force: true }));
  const fixture = await startDeviceSyncHub({ directory });
  hubs.push(() => fixture.close());
  const env = { XDG_CONFIG_HOME: directory };
  fixture.grant(WORKSPACE);
  const login = fixture.issue({ workspaces: [] });
  await writeHubLogin(fixture.origin, login, env);
  const configLock = await acquireInitLock(env);
  clients.push(() => configLock.release());
  const fetchResponse = globalThis.fetch;
  let delivered!: () => void;
  const responseDelivered = new Promise<void>(resolve => { delivered = resolve; });
  const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async (...args) => {
    const response = await fetchResponse(...args);
    const body = await response.text();
    delivered();
    return new Response(body, { status: response.status, headers: response.headers });
  });
  after.unshift(() => fetchSpy.mockRestore());
  const config = {
    ...testConfig({ hubUrl: fixture.url, databasePath: join(directory, "mirror.sqlite"), connectTimeoutMs: 3_000 }),
    deviceLogin: { env },
  };
  const server = createMcpServer(config);
  clients.push(() => server.close());
  let closing: Promise<void> | undefined;
  try {
    await responseDelivered;
    let closed = false;
    closing = server.close().then(() => { closed = true; });
    await sleep(25);
    expect(closed).toBe(false);
    expect(readHubLogins(env).logins[fixture.origin]).toEqual(login);
    configLock.release();
    await closing;
    fetchSpy.mockRestore();
    expect(readHubLogins(env).logins[fixture.origin]!.credential.record.id).not.toBe(login.credential.record.id);
    expect((await inspectRemote(config)).hub.status).toBe("connected");
    expect(fixture.renewalCount).toBe(1);
  } finally {
    configLock.release();
    await (closing ?? server.close());
    fetchSpy.mockRestore();
  }
});

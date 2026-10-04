/** Shutdown must finish storing a replacement already received from the hub. */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { readHubLogins, writeHubLogin } from "@uberblick/hub/auth-store";
import { acquireInitLock } from "@uberblick/hub/init-lock";
import { startDeviceSyncHub } from "@uberblick/hub/test-device-sync";
import { createMcpServer } from "../src/server.js";
import { inspectRemote } from "../src/remote.js";
import { sleep, testConfig, WORKSPACE } from "./helpers.js";

it("waits for conditional credential publication before completing server shutdown", async () => {
  const directory = mkdtempSync(join(tmpdir(), `device-shutdown-${process.env.UB_AGENTS_RUN ?? "test"}-`));
  const fixture = await startDeviceSyncHub({ directory });
  const env = { XDG_CONFIG_HOME: directory };
  fixture.grant(WORKSPACE);
  const login = fixture.issue({ workspaces: [] });
  await writeHubLogin(fixture.origin, login, env);
  const configLock = await acquireInitLock(env);
  const fetchResponse = globalThis.fetch;
  let delivered!: () => void;
  const responseDelivered = new Promise<void>(resolve => { delivered = resolve; });
  const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async (...args) => {
    const response = await fetchResponse(...args);
    const body = await response.text();
    delivered();
    return new Response(body, { status: response.status, headers: response.headers });
  });
  const config = {
    ...testConfig({ hubUrl: fixture.url, databasePath: join(directory, "mirror.sqlite"), connectTimeoutMs: 3_000 }),
    deviceLogin: { env },
  };
  const server = createMcpServer(config);
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
    await fixture.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

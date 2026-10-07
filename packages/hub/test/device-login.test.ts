import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { chmodSync, existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { credentialsPath, readHubLogins, removeHubLogin, writeHubLogin } from "../src/auth-store.js";
import { SYNC_PROTOCOL_VERSION } from "../src/protocol.js";
import { ensureDeviceLogin, readDeviceLogin } from "../src/device-login.js";
import { acquireInitLock } from "../src/init-lock.js";
import { startDeviceSyncHub } from "./device-sync-hub.js";

const WORKSPACE = randomUUID();
const OTHER_WORKSPACE = randomUUID();
/** Concurrent renewal processes: two are enough to contend for the lock. */
const WORKERS = 2;
const directories: string[] = [];
const hubs: Awaited<ReturnType<typeof startDeviceSyncHub>>[] = [];
function box(): { directory: string; env: NodeJS.ProcessEnv } {
  const directory = mkdtempSync(join(tmpdir(), `device-login-${process.env.UB_AGENTS_RUN ?? "test"}-`));
  directories.push(directory);
  return { directory, env: { ...process.env, XDG_CONFIG_HOME: directory } };
}
async function setup() {
  const test = box();
  const hub = await startDeviceSyncHub({ directory: test.directory });
  hubs.push(hub);
  return { ...test, hub };
}
afterEach(async () => {
  await Promise.all(hubs.splice(0).map((hub) => hub.close()));
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

async function waitForRequest(hub: Awaited<ReturnType<typeof startDeviceSyncHub>>): Promise<void> {
  const deadline = Date.now() + 2_000;
  while (hub.renewalCount === 0) {
    if (Date.now() >= deadline) throw new Error("renewal request did not arrive");
    await new Promise<void>(resolve => setTimeout(resolve, 5));
  }
}

async function workers(endpoint: string, workspace: string, test: ReturnType<typeof box>, rejected: boolean): Promise<unknown[]> {
  const worker = join(test.directory, "renew.mjs");
  const helper = pathToFileURL(fileURLToPath(new URL("../src/device-login.ts", import.meta.url))).href;
  writeFileSync(worker, `
import { ensureDeviceLogin, readDeviceLogin } from ${JSON.stringify(helper)};
const endpoint = process.argv[2], workspace = process.argv[3];
const before = readDeviceLogin(endpoint, workspace);
process.once("message", async () => {
  try {
    const result = await ensureDeviceLogin(endpoint, workspace, {
      ...(process.argv[4] === "true" && before.status === "ready" ? { rejected: before.login } : {}),
    });
    process.send({ status: result.status, id: result.status === "ready" ? result.login.credential.record.id : null });
    process.disconnect();
  } catch { process.exitCode = 1; process.disconnect(); }
});
process.send("ready");
`);
  const children: { child: ChildProcess; ready: Promise<void>; done: Promise<unknown> }[] = [];
  for (let i = 0; i < WORKERS; i++) {
    const child = spawn(process.execPath, ["--import", createRequire(import.meta.url).resolve("tsx"), worker, endpoint, workspace, String(rejected)], {
      cwd: test.directory, env: test.env, stdio: ["ignore", "ignore", "pipe", "ipc"], timeout: 15_000,
    });
    let output = "";
    let answer: unknown;
    child.stderr?.on("data", (chunk: Buffer) => { output += chunk.toString("utf8"); });
    const ready = new Promise<void>((resolve, reject) => {
      let started = false;
      child.on("message", (message) => {
        if (message === "ready") { started = true; resolve(); } else answer = message;
      });
      child.on("error", reject);
      child.on("close", () => { if (!started) reject(new Error("renewal worker did not start")); });
    });
    const done = new Promise<unknown>((resolve, reject) => {
      child.on("error", reject);
      child.on("close", (code) => code === 0 ? resolve(answer) : reject(new Error(`renewal worker ${code}: ${output}`)));
    });
    children.push({ child, ready, done });
  }
  try {
    await Promise.all(children.map((worker) => worker.ready));
    for (const worker of children) worker.child.send("go");
    return await Promise.all(children.map((worker) => worker.done));
  } finally {
    for (const worker of children) if (worker.child.exitCode === null) worker.child.kill("SIGKILL");
    await Promise.allSettled(children.map((worker) => worker.done));
  }
}

describe("stored device login renewal", () => {
  it("replaces names with each stored credential, including an older hub's unnamed reply", async () => {
    const test = await setup();
    const before = test.hub.issue({ workspaces: [WORKSPACE] });
    before.credential.workspaceNames = { [WORKSPACE]: "Before rename" };
    await writeHubLogin(test.hub.origin, before, test.env);
    expect((await ensureDeviceLogin(test.hub.url, WORKSPACE, { env: test.env })).status).toBe("ready");
    expect(test.hub.renewalCount).toBe(0);

    const next = test.hub.issue({ workspaces: [WORKSPACE, OTHER_WORKSPACE], deviceId: before.credential.record.deviceId });
    next.credential.workspaceNames = { [WORKSPACE]: "After rename", [OTHER_WORKSPACE]: "New grant" };
    test.hub.setRenewalReply({ status: 200, body: { status: "renewed", credential: next.credential } });
    const renewed = await ensureDeviceLogin(test.hub.url, OTHER_WORKSPACE, { env: test.env, renewalCooldownMs: 0 });
    expect(renewed.status).toBe("ready");
    const stored = readHubLogins(test.env).logins[test.hub.origin]!;
    expect(stored.credential).toEqual(next.credential);
    expect(test.hub.renewalCount).toBe(1);

    const unnamed = test.hub.issue({ workspaces: [WORKSPACE, OTHER_WORKSPACE], deviceId: before.credential.record.deviceId });
    test.hub.setRenewalReply({ status: 200, body: { status: "renewed", credential: unnamed.credential } });
    const refreshed = await ensureDeviceLogin(test.hub.url, WORKSPACE, { env: test.env, rejected: stored });
    expect(refreshed.status).toBe("ready");
    expect(readHubLogins(test.env).logins[test.hub.origin]!.credential).toEqual(unnamed.credential);
    expect(test.hub.renewalCount).toBe(2);
  });

  it("renews one missing-workspace need across processes and preserves the store", async () => {
    const test = await setup();
    test.hub.grant(WORKSPACE);
    const before = test.hub.issue({ workspaces: [] });
    const other = test.hub.issue({ workspaces: [OTHER_WORKSPACE] });
    await writeHubLogin(test.hub.origin, before, test.env);
    await writeHubLogin("https://another-hub.example", other, test.env);
    const path = credentialsPath(test.env);
    const raw = JSON.parse(readFileSync(path, "utf8"));
    writeFileSync(path, JSON.stringify({ ...raw, signingSecret: "preserved", future: { opaque: true } }), { mode: 0o600 });
    test.hub.setRenewalDelay(100);
    const answers = await workers(test.hub.url, WORKSPACE, test, false);
    const after = readHubLogins(test.env).logins[test.hub.origin]!;
    expect(answers).toEqual(Array(WORKERS).fill({ status: "ready", id: after.credential.record.id }));
    expect(after.credential.record.id).not.toBe(before.credential.record.id);
    expect(after.identity).toEqual(before.identity);
    expect(after.credential.record).not.toHaveProperty("replacedAt");
    expect(test.hub.renewalCount).toBe(1);
    expect(JSON.parse(readFileSync(path, "utf8"))).toEqual({
      ...raw, hubLogins: { ...raw.hubLogins, [test.hub.origin]: after }, signingSecret: "preserved", future: { opaque: true },
    });
    for (const name of readdirSync(dirname(path)).filter(name => name !== "credentials.json")) {
      const contents = readFileSync(join(dirname(path), name), "utf8");
      expect(contents).not.toContain(before.credential.key);
      expect(contents).not.toContain(after.credential.key);
    }
  });

  it("shares a generic refusal's replacement without sign-in or repeated retirement", async () => {
    const test = await setup();
    test.hub.grant(WORKSPACE);
    const before = test.hub.issue({ workspaces: [WORKSPACE] });
    await writeHubLogin(test.hub.origin, before, test.env);
    test.hub.setRenewalDelay(100);
    const answers = await workers(test.hub.url, WORKSPACE, test, true);
    const after = readHubLogins(test.env).logins[test.hub.origin]!;
    expect(answers).toEqual(Array(WORKERS).fill({ status: "ready", id: after.credential.record.id }));
    expect(test.hub.renewalCount).toBe(1);
    const refusedAgain = await ensureDeviceLogin(test.hub.url, WORKSPACE, { env: test.env, rejected: after });
    expect(refusedAgain.status).toBe("hub-down");
    expect(test.hub.renewalCount).toBe(1);
  });

  it("reports no access from renewal, with one exchange across other missing workspaces", async () => {
    const test = await setup();
    await writeHubLogin(test.hub.origin, test.hub.issue({ workspaces: [] }), test.env);
    const answers = await workers(test.hub.url, WORKSPACE, test, false);
    expect(answers).toEqual(Array(WORKERS).fill({ status: "no-access", id: null }));
    const anotherNeed = await ensureDeviceLogin(test.hub.url, OTHER_WORKSPACE, { env: test.env });
    expect(anotherNeed.status).toBe("no-access");
    expect(test.hub.renewalCount).toBe(1);
  });

  it.each(["login", "logout"])("does not overwrite concurrent %s during its network request", async (action) => {
    const test = await setup();
    test.hub.grant(WORKSPACE);
    await writeHubLogin(test.hub.origin, test.hub.issue({ workspaces: [] }), test.env);
    test.hub.setRenewalDelay(150);
    const renewal = ensureDeviceLogin(test.hub.url, WORKSPACE, { env: test.env });
    await waitForRequest(test.hub);
    const next = test.hub.issue({ workspaces: [WORKSPACE] });
    if (action === "login") await writeHubLogin(test.hub.origin, next, test.env);
    else await removeHubLogin(test.hub.origin, test.env);
    const result = await renewal;
    expect(result.status).toBe(action === "login" ? "ready" : "sign-in-required");
    expect(readHubLogins(test.env).logins[test.hub.origin]).toEqual(action === "login" ? next : undefined);
  });

  it("keeps configuration writers available and cancels without late publication", async () => {
    const test = await setup();
    test.hub.grant(WORKSPACE);
    const before = test.hub.issue({ workspaces: [] });
    await writeHubLogin(test.hub.origin, before, test.env);
    test.hub.setRenewalDelay(150);
    const abort = new AbortController();
    const renewal = ensureDeviceLogin(test.hub.url, WORKSPACE, { env: test.env, signal: abort.signal });
    await waitForRequest(test.hub);
    const configWriter = await acquireInitLock(test.env, { waitMs: 0 });
    configWriter.release();
    abort.abort();
    await expect(renewal).rejects.toMatchObject({ name: "AbortError" });
    expect(readHubLogins(test.env).logins[test.hub.origin]).toEqual(before);
  });

  it.each([
    { status: 401, body: { status: "sign-in-required" }, reading: "sign-in-required" },
    { status: 409, body: { status: "protocol-mismatch", reason: `protocol-mismatch:${SYNC_PROTOCOL_VERSION + 1}` }, reading: "update-required" },
    { status: 503, body: { status: "not-configured" }, reading: "renewal-unavailable" },
    { status: 200, body: { status: "renewed", credential: { key: "private-invalid-key" } }, reading: "hub-down" },
  ])("classifies renewal reply $status/$reading without inventing access", async ({ reading, ...reply }) => {
    const test = await setup();
    const before = test.hub.issue({ workspaces: [] });
    await writeHubLogin(test.hub.origin, before, test.env);
    test.hub.setRenewalReply(reply);
    const result = await ensureDeviceLogin(test.hub.url, WORKSPACE, { env: test.env });
    expect(result.status).toBe(reading);
    expect(JSON.stringify(result)).not.toContain(before.credential.key);
    expect(JSON.stringify(result)).not.toContain("private-invalid-key");
    expect((await ensureDeviceLogin(test.hub.url, WORKSPACE, { env: test.env })).status).toBe(reading);
    expect(test.hub.renewalCount).toBe(1);
    expect(readHubLogins(test.env).logins[test.hub.origin]).toEqual(before);
  });

  it("uses origin identity and refuses exposed or malformed stores without network", async () => {
    const test = await setup();
    const before = test.hub.issue({ workspaces: [WORKSPACE] });
    await writeHubLogin(test.hub.origin, before, test.env);
    expect(readDeviceLogin(`${test.hub.origin}/path`, WORKSPACE, test.env).status).toBe("ready");
    expect((await ensureDeviceLogin("wss://another-hub.example/ws", WORKSPACE, { env: test.env })).status).toBe("sign-in-required");
    const path = credentialsPath(test.env);
    chmodSync(path, 0o644);
    expect((await ensureDeviceLogin(test.hub.url, WORKSPACE, { env: test.env })).status).toBe("credential-store-refused");
    chmodSync(path, 0o600);
    writeFileSync(path, "invalid-private-contents");
    const result = await ensureDeviceLogin(test.hub.url, WORKSPACE, { env: test.env });
    expect(result.status).toBe("credential-store-unreadable");
    expect(JSON.stringify(result)).not.toContain("invalid-private-contents");
    expect(test.hub.renewalCount).toBe(0);
  });

  it("never follows a renewal redirect to another authentication origin", async () => {
    const test = await setup();
    const other = await setup();
    await writeHubLogin(test.hub.origin, test.hub.issue({ workspaces: [] }), test.env);
    test.hub.setRenewalReply({ status: 307, location: `${other.hub.origin}/auth/credential/renew` });
    expect((await ensureDeviceLogin(test.hub.url, WORKSPACE, { env: test.env })).status).toBe("hub-down");
    expect(other.hub.renewalCount).toBe(0);
  });

  it("cancels a renewal lock wait without taking another holder's lock", async () => {
    const test = await setup();
    await writeHubLogin(test.hub.origin, test.hub.issue({ workspaces: [] }), test.env);
    test.hub.setRenewalDelay(150);
    const first = ensureDeviceLogin(test.hub.url, WORKSPACE, { env: test.env });
    await waitForRequest(test.hub);
    const abort = new AbortController();
    const next = ensureDeviceLogin(test.hub.url, WORKSPACE, { env: test.env, signal: abort.signal });
    abort.abort();
    await expect(next).rejects.toMatchObject({ name: "AbortError" });
    const locks = readdirSync(dirname(credentialsPath(test.env))).filter(name => name.endsWith(".lock"));
    expect(locks).toHaveLength(1);
    expect(existsSync(join(dirname(credentialsPath(test.env)), locks[0]!))).toBe(true);
    await first;
    expect(test.hub.renewalCount).toBe(1);
  });
});

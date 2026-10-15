import { startDeviceSyncHub } from "@uberblick/hub/test-device-sync";
import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { credentialsPath, readHubLogins, writeHubLogin } from "../src/auth-store.js";
import { ensureDeviceLogin } from "../src/device-login.js";
import { cleanupTestResources, closeChild, trackChild } from "./helpers.js";
import { builtWorker } from "./process-helpers.js";

const WORKSPACE = randomUUID();
const OTHER_WORKSPACE = randomUUID();
/** Concurrent renewal processes: two are enough to contend for the lock. */
const WORKERS = 2;
const directories: string[] = [];
const hubs: Awaited<ReturnType<typeof startDeviceSyncHub>>[] = [];
const renewalChildren: ChildProcess[] = [];
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
  await cleanupTestResources({
    clients: renewalChildren.splice(0).map((child) => () => closeChild(child)),
    hubs: hubs.splice(0).map((hub) => () => hub.close()),
    after: directories.splice(0).map((directory) => () => rmSync(directory, { recursive: true, force: true })),
  });
});

async function workers(endpoint: string, workspace: string, test: ReturnType<typeof box>, rejected: boolean): Promise<unknown[]> {
  const worker = builtWorker("device-login");
  const children: { child: ChildProcess; ready: Promise<void>; done: Promise<unknown> }[] = [];
  for (let i = 0; i < WORKERS; i++) {
    const child = spawn(process.execPath, [worker, endpoint, workspace, String(rejected)], {
      cwd: test.directory, env: test.env, stdio: ["ignore", "ignore", "pipe", "ipc"], timeout: 15_000,
    });
    renewalChildren.push(trackChild(child));
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
});

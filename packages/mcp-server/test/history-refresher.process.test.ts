import { fork, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { createTeamHub } from "@uberblick/hub/team";
import { issueCredential } from "@uberblick/hub/test-device-credentials";
import { roomForDoc, type RevisionRequest } from "@uberblick/schema";
import { afterEach, expect, it, vi } from "vitest";
import { writeHubLogin } from "../src/auth-store.js";
import { HistoryCache, type HistoryCacheResult } from "../src/history-cache.js";
import { tryAcquireHistoryRefresherRole } from "../src/history-refresher-role.js";
import { acquireInitLock } from "../src/init-lock.js";
import { rememberWorkspaceBindings } from "../src/workspace-registry.js";
import { cleanupTestResources, closeChild, hubUrl, LIVE_HUB_SETTLE, startServer, tempDir, testConfig, trackChild, waitUntil, WORKSPACE } from "./helpers.js";
import { builtWorker } from "./process-helpers.js";

const clients: Array<() => unknown> = [];
const hubs: Array<() => unknown> = [];

afterEach(async () => {
  await cleanupTestResources({ clients: clients.splice(0), hubs: hubs.splice(0) });
});

it("lets an idle refresher with its cache worker exit when the serving process has no other work", async () => {
  const root = tempDir();
  const config = { ...testConfig(), localWorkspace: false,
    authEnv: { XDG_CONFIG_HOME: root, XDG_DATA_HOME: root, HOME: root } };
  const child = trackChild(fork(builtWorker("history-refresher"), ["unref", JSON.stringify(config)], {
    execArgv: [], stdio: ["ignore", "ignore", "pipe", "ipc"],
  }));
  clients.push(() => closeChild(child));
  let cacheReady = false;
  child.on("message", (message: { type: string }) => { if (message.type === "cache-ready") cacheReady = true; });
  await waitUntil("the idle refresher's real cache worker to answer", () => cacheReady);
  expect(tryAcquireHistoryRefresherRole(config.databasePath)).toBeNull();
  const exited = once(child, "exit");
  child.send({ type: "abandon" });
  await waitUntil("the process to exit after dropping only the fixture keepalive", () => child.exitCode !== null || child.signalCode !== null);
  expect(await exited).toEqual([0, null]);
  const successor = tryAcquireHistoryRefresherRole(config.databasePath);
  expect(successor).not.toBeNull();
  successor?.close();
});

function ready<T>(result: HistoryCacheResult<T>): T {
  if (result.status !== "ready") throw new Error(`History cache returned ${result.status}.`);
  return result.value;
}

it("takes over an idle MCP refresher after SIGKILL and downloads only unfinished snapshots", async () => {
  const hub = await createTeamHub({
    address: "127.0.0.1", port: 0, databasePath: ":memory:",
    github: { clientId: "Iv1.0123456789abcdef", fetch: vi.fn(() => { throw new Error("Unexpected GitHub request."); }) },
    log() {},
  }, { deviceCredentials: true });
  hubs.push(() => hub.stop());
  if (hub.credentials === undefined || hub.memberships === undefined || hub.principals === undefined) {
    throw new Error("The team hub requires device authority.");
  }
  const principal = hub.principals.identify("12345", "process-history-author");
  hub.memberships.grant({ workspaceId: WORKSPACE, principalId: principal.id, role: "admin" });
  const issued = issueCredential(hub.credentials, { principalId: principal.id, deviceId: randomUUID(), workspaces: [WORKSPACE] });
  const root = tempDir();
  const env = { XDG_CONFIG_HOME: root, XDG_DATA_HOME: root, HOME: root };
  const endpoint = hubUrl(hub.port);
  const lock = await acquireInitLock(env);
  try { rememberWorkspaceBindings([{ workspaceId: WORKSPACE, hubUrl: endpoint }], env, WORKSPACE); }
  finally { lock.release(); }
  const { replacedAt: _replacedAt, ...record } = issued.record;
  await writeHubLogin(`http://127.0.0.1:${hub.port}`, {
    identity: principal,
    credential: { record, key: Buffer.from(issued.keyBytes).toString("base64url") },
  }, env);
  const config = () => ({ ...testConfig({ hubUrl: endpoint, ...LIVE_HUB_SETTLE }), deviceLogin: { env } });
  const author = await startServer(config());
  clients.push(() => author.close());
  const page = await author.ok("create_doc", { title: "Partly downloaded before a crash", description: "The successor resumes from durable snapshots.",
    blocks: [{ type: "paragraph", text: "Earlier content" }] });
  expect(await author.instance.replicas.waitForSettled()).toMatchObject({ caughtUp: true });
  const earlier = (await author.ok("name_revision", { uuid: page.uuid, name: "Earlier" })).revision;
  await author.ok("set_metadata", { uuid: page.uuid, title: "Latest content" });
  expect(await author.instance.replicas.waitForSettled()).toMatchObject({ caughtUp: true });
  const latest = (await author.ok("name_revision", { uuid: page.uuid, name: "Latest" })).revision;
  const sharedConfig = config();
  type Request = { room: string; operation: Omit<RevisionRequest, "requestId"> };
  function worker(mode: "agent" | "browser", blockRevision = ""): {
    child: ChildProcess;
    requests: Request[];
    started: Promise<void>;
    blocked(): boolean;
  } {
    const child = trackChild(fork(builtWorker("history-refresher"), [mode,
      JSON.stringify({ ...sharedConfig, sessionId: `history-process-${randomUUID()}` }), blockRevision], {
      execArgv: [], stdio: ["ignore", "ignore", "pipe", "ipc"],
    }));
    clients.push(() => closeChild(child));
    const requests: Request[] = [];
    let blocked = false;
    const started = new Promise<void>((resolve, reject) => {
      let stderr = "";
      child.stderr?.setEncoding("utf8");
      child.stderr?.on("data", (chunk: string) => { stderr += chunk; });
      child.on("message", (message: { type: string } & Request) => {
        if (message.type === "request") requests.push({ room: message.room, operation: message.operation });
        if (message.type === "blocked") blocked = true;
        if (message.type === "ready") resolve();
      });
      child.once("exit", (code, signal) => reject(new Error(`history worker exited ${String(code ?? signal)}: ${stderr.trim()}`)));
    });
    return { child, requests, started, blocked: () => blocked };
  }
  const holder = worker("agent", earlier.id);
  await holder.started;
  const cache = new HistoryCache(sharedConfig.databasePath, WORKSPACE, env);
  clients.push(() => cache.close());
  const token = ready(cache.open({ hub: endpoint, workspace: WORKSPACE, account: "12345" }));
  const snapshot = (revision: string) => ready(cache.readSnapshot(token, page.uuid, revision));
  await waitUntil("the first snapshot durable and the next held inside the idle MCP process", () =>
    snapshot(latest.id) !== null && holder.blocked());
  expect(snapshot(earlier.id)).toBeNull();
  const catalog = ready(cache.readCatalog(token, page.uuid))!;
  const follower = worker("browser");
  await follower.started;
  expect(follower.requests).toEqual([]);
  const exited = once(holder.child, "exit");
  holder.child.kill("SIGKILL");
  await exited;
  await waitUntil("the running browser process to resume and complete the interrupted mirror", () => snapshot(earlier.id) !== null);
  expect(follower.requests).toContainEqual({ room: roomForDoc(WORKSPACE, page.uuid), operation: {
    operation: "list", includeNames: true, includeTitles: true, ifVersion: catalog.version,
  } });
  expect(follower.requests.filter(item => item.operation.operation === "get")).toEqual([
    { room: roomForDoc(WORKSPACE, page.uuid), operation: { operation: "get", revisionId: earlier.id } },
  ]);
  expect(snapshot(latest.id)).not.toBeNull();
});

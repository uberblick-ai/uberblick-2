/** A departing stdio process waits for acknowledgement while its replicas live. */

import { mainProcess } from "./process-helpers.js";
import { ReadBuffer, serializeMessage } from "@modelcontextprotocol/sdk/shared/stdio.js";
import type { JSONRPCMessage } from "@modelcontextprotocol/sdk/types.js";
import { getBlocks } from "@uberblick/schema";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { afterEach, expect, it } from "vitest";
import { messageYjsUpdate } from "y-protocols/sync";
import { cleanupTestResources, closeChild, hubUrl, LIVE_HUB_SETTLE, PACKAGE_ROOT, peerClient, sleep, startHub, startServer, tempDatabasePath, TEST_SECRET, testConfig, trackChild, WAIT_TIMEOUT_MS, waitUntil, WORKSPACE, type PeerClient, type Rig, type TestHub, } from "./helpers.js";

const SESSION = "shutdown-proof";
const NAME = "Departing agent";
const ORIGINAL = "before the last write";
const WRITTEN = "written just before shutdown";
const children: ChildProcessWithoutNullStreams[] = [];
const hubs: TestHub[] = [];
const peers: PeerClient[] = [];
const rigs: Rig[] = [];

afterEach(async () => {
  await cleanupTestResources({
    clients: [
      ...rigs.splice(0).map((rig) => () => rig.close()),
      ...children.splice(0).map((child) => () => closeChild(child)),
    ],
    peers: peers.splice(0).map((peer) => () => peer.destroy()),
    hubs: hubs.splice(0).map((hub) => () => hub.stop()),
  });
});

async function startProcess(options: { hubUrl?: string; authSecret?: string } = {}) {
  const databasePath = tempDatabasePath();
  const { command, args } = mainProcess();
  const child = spawn(command, args, {
    cwd: PACKAGE_ROOT,
    env: {
      PATH: process.env.PATH ?? "",
      WORKSPACE_ID: WORKSPACE,
      UBERBLICK_DB: databasePath,
      UB_AGENT_SESSION: SESSION,
      ...(options.hubUrl === undefined ? {} : { HUB_URL: options.hubUrl }),
      ...(options.authSecret === undefined ? {} : { HUB_AUTH_TOKEN: options.authSecret }),
    },
    stdio: ["pipe", "pipe", "pipe"],
    timeout: 35_000,
    killSignal: "SIGKILL",
  });
  children.push(trackChild(child));
  const frames = new ReadBuffer();
  const replies = new Map<number, JSONRPCMessage>();
  let stdout = "";
  let stderr = "";
  let parseFailure: unknown;
  let nextId = 1;
  child.stdout.on("data", (chunk: Buffer) => {
    stdout += chunk.toString();
    try {
      frames.append(chunk);
      for (let frame = frames.readMessage(); frame !== null; frame = frames.readMessage()) {
        if ("id" in frame && typeof frame.id === "number") replies.set(frame.id, frame);
      }
    } catch (error) {
      parseFailure = error;
    }
  });
  child.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString(); });
  const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code, signal) => resolve({ code, signal }));
  });
  async function request(method: string, params: Record<string, unknown>) {
    const id = nextId++;
    child.stdin.write(serializeMessage({ jsonrpc: "2.0", id, method, params }));
    await waitUntil(`the stdio response to ${method}`, () => {
      if (parseFailure !== undefined) throw parseFailure;
      if (child.exitCode !== null || child.signalCode !== null) {
        throw new Error(`MCP process exited before ${method}: ${stderr}`);
      }
      return replies.has(id);
    });
    const reply = replies.get(id)!;
    replies.delete(id);
    if (!("result" in reply)) throw new Error(`MCP request failed: ${JSON.stringify(reply)}`);
    return reply.result;
  }
  await request("initialize", {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "shutdown-tests", title: NAME, version: "0.0.0" },
  });
  child.stdin.write(serializeMessage({ jsonrpc: "2.0", method: "notifications/initialized" }));
  return {
    child,
    databasePath,
    async call(name: string, args: Record<string, unknown> = {}) {
      const result = await request("tools/call", { name, arguments: args });
      const payload = JSON.parse((result.content as { text: string }[])[0]!.text);
      if (result.isError === true) throw new Error(`Tool failed: ${JSON.stringify(payload)}`);
      return payload;
    },
    async close(signal: "EOF" | "SIGINT" | "SIGTERM" = "EOF") {
      if (signal === "EOF") child.stdin.end();
      else child.kill(signal);
      const exit = await exited;
      expect(parseFailure).toBeUndefined();
      for (const line of stdout.trim().split("\n")) {
        if (line !== "") expect(JSON.parse(line)).toHaveProperty("jsonrpc", "2.0");
      }
      return { ...exit, stdout, stderr };
    },
  };
}

async function offlineStatus(databasePath: string) {
  const rig = await startServer({ ...testConfig({ databasePath }), localWorkspace: false });
  rigs.push(rig);
  return { rig, status: await rig.ok("sync_status") };
}

async function pendingWrite() {
  const hub = await startHub();
  hubs.push(hub);
  const seed = await startServer(testConfig({ ...LIVE_HUB_SETTLE, authSecret: TEST_SECRET, hubUrl: hubUrl(hub.port) }));
  rigs.push(seed);
  const created = await seed.ok("create_doc", {
    title: "The last write",
    description: "Shutdown must give this write a chance to reach its peer.",
    blocks: [{ type: "paragraph", text: ORIGINAL }],
  });
  expect(await seed.instance.replicas.waitForSettled({ deadline: performance.now() + WAIT_TIMEOUT_MS })).toMatchObject({ caughtUp: true });
  await seed.close();
  rigs.splice(rigs.indexOf(seed), 1);
  const room = `${WORKSPACE}/${created.uuid}`;
  const peer = await peerClient(hub.port, room);
  peers.push(peer);
  await peer.synced;
  const writer = await startProcess({ hubUrl: hubUrl(hub.port), authSecret: TEST_SECRET });
  await writer.call("get_doc", { uuid: created.uuid });
  const writerConnection = () => hub.hocuspocus.documents.get(room)?.getConnections()
    .find((candidate) => "sub" in candidate.context && candidate.context.sub === SESSION);
  await waitUntil("the writer to join its hub room", () => writerConnection() !== undefined);
  const connection = writerConnection();
  if (connection === undefined) throw new Error("the writer left its hub room before the sync gate was armed");
  let release!: () => void;
  const withheld = new Promise<void>((resolve) => { release = resolve; });
  const beforeSync = connection.callbacks.beforeSync;
  connection.beforeSync(async (active, payload) => {
    if (payload.type === messageYjsUpdate) await withheld;
    await beforeSync(active, payload);
  });
  const published: Record<string, any>[] = [];
  const awareness = peer.provider.awareness!;
  const agentClients = new Set<number>();
  const observe = () => {
    for (const [client, state] of awareness.getStates()) {
      if (state.session === SESSION) agentClients.add(client);
      if (agentClients.has(client)) published.push(JSON.parse(JSON.stringify(state)));
    }
  };
  awareness.on("update", observe);
  try {
    const answer = await writer.call("edit_block", {
      uuid: created.uuid,
      block_id: created.blocks[0].id,
      old_text: ORIGINAL,
      new_text: WRITTEN,
    });
    expect(answer).toMatchObject({ applied: true, synced: false });
    expect(getBlocks(peer.doc)[0]?.text).toBe(ORIGINAL);
    return { writer, created, peer, published, release };
  } catch (error) {
    release();
    throw error;
  }
}

it.each(["EOF", "SIGINT", "SIGTERM"] as const)("acknowledges the final write before %s exits and retains its named departure", async (signal) => {
  const pending = await pendingWrite();
  try {
    const began = Date.now();
    const closing = pending.writer.close(signal);
    await sleep(150);
    expect(pending.writer.child.exitCode).toBeNull();
    expect(pending.writer.child.signalCode).toBeNull();
    pending.release();
    const result = await closing;
    expect(Date.now() - began).toBeLessThan(5_000);
    expect(result).toMatchObject({ code: 0, signal: null });
    expect(result.stderr).not.toContain("changes are still only local");
    expect(getBlocks(pending.peer.doc)[0]?.text).toBe(WRITTEN);
    await waitUntil("the peer to remove the departed live session", () =>
      [...pending.peer.provider.awareness!.getStates().values()].every((state) => state.session !== SESSION));
    // Presence has no acknowledgement: the final cursor can still be queued
    // behind the acknowledged write when the writer leaves, so this proves the
    // named departure, not the last cursor (awareness.test.ts owns the cursor).
    expect(pending.published.at(-1)).toMatchObject({
      user: { name: NAME, color: expect.any(String) },
      client: "agent",
      session: SESSION,
    });
    const { status } = await offlineStatus(pending.writer.databasePath);
    expect(status.unsyncedChanges).toBe(0);
  } finally {
    pending.release();
  }
}, 35_000);

it.each(["unreachable", "refused"] as const)("exits promptly with durable local changes when the hub is %s", async (failure) => {
  const hub = failure === "refused" ? await startHub() : undefined;
  if (hub !== undefined) hubs.push(hub);
  const writer = await startProcess({
    hubUrl: hub === undefined ? "ws://127.0.0.1:1" : hubUrl(hub.port),
    authSecret: hub === undefined ? TEST_SECRET : "a-refused-test-secret",
  });
  const created = await writer.call("create_doc", {
    title: "Held locally",
    description: "A failed connection must not lose this write.",
    blocks: [{ type: "paragraph", text: WRITTEN }],
  });
  const before = await writer.call("sync_status");
  expect(before.hub.status).toBe(failure === "refused" ? "auth-failed" : "hub-down");
  expect(before.unsyncedChanges).toBeGreaterThan(1);
  const began = Date.now();
  const result = await writer.close();
  expect(Date.now() - began).toBeLessThan(1_500);
  expect(result).toMatchObject({ code: 0, signal: null });
  expect(result.stderr.split("\n").filter((line) => line.includes("changes are still only local"))).toEqual([
    expect.stringContaining(`${before.unsyncedChanges} changes are still only local; they sync the next time Uberblick on this machine reaches the hub.`),
  ]);
  const { rig, status } = await offlineStatus(writer.databasePath);
  expect(status.unsyncedChanges).toBe(before.unsyncedChanges);
  expect((await rig.ok("get_doc", { uuid: created.uuid })).blocks[0].text).toBe(WRITTEN);
}, 25_000);

it("exits inside the shutdown deadline when a connected hub withholds acknowledgement", async () => {
  const pending = await pendingWrite();
  try {
    const began = Date.now();
    const result = await pending.writer.close();
    expect(Date.now() - began).toBeLessThan(12_000);
    expect(result).toMatchObject({ code: 0, signal: null });
    const { rig, status } = await offlineStatus(pending.writer.databasePath);
    expect(status.unsyncedChanges).toBeGreaterThan(0);
    expect(result.stderr).toContain(`${status.unsyncedChanges} changes are still only local; they sync the next time Uberblick on this machine reaches the hub.`);
    expect(result.stderr).not.toContain("shutdown timed out");
    expect((await rig.ok("get_doc", { uuid: pending.created.uuid })).blocks[0].text).toBe(WRITTEN);
  } finally {
    pending.release();
  }
}, 35_000);

it("does not wait or warn when hub synchronization is disabled", async () => {
  const writer = await startProcess();
  await writer.call("create_doc", {
    title: "Local only",
    description: "A deliberately local workspace has no hub to wait for.",
    blocks: [{ type: "paragraph", text: WRITTEN }],
  });
  const began = Date.now();
  const result = await writer.close();
  expect(Date.now() - began).toBeLessThan(1_500);
  expect(result).toMatchObject({ code: 0, signal: null });
  expect(result.stderr).not.toContain("changes are still only local");
  const { status } = await offlineStatus(writer.databasePath);
  expect(status.unsyncedChanges).toBeGreaterThan(0);
}, 15_000);

/** Sessions share workspace state while admission and transport lifetime stay private. */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { createTagCatalogEntry, getMeta } from "@uberblick/schema";
import { afterEach, expect, it, vi } from "vitest";
import { STARTUP_ORIENTATION } from "../src/help-topics.js";
import { createMcpRuntime, type UberblickMcpRuntime, type UberblickMcpSession } from "../src/server.js";
import { cleanupTestResources, testConfig } from "./helpers.js";

const runtimes: UberblickMcpRuntime[] = [];
const clients: Client[] = [];
const releases: (() => void)[] = [];

afterEach(async () => {
  for (const release of releases.splice(0)) release();
  await cleanupTestResources({
    clients: clients.splice(0).map(client => () => client.close()),
    after: [...runtimes.splice(0).map(runtime => () => runtime.close()), () => vi.restoreAllMocks()],
  });
});

function runtime(agentName?: string): UberblickMcpRuntime {
  const instance = createMcpRuntime(testConfig(), agentName === undefined ? {} : { agentName });
  runtimes.push(instance);
  return instance;
}

async function connect(session: UberblickMcpSession, name: string) {
  const client = new Client({ name, title: `${name} title`, version: "1" });
  clients.push(client);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([session.connect(serverTransport), client.connect(clientTransport)]);
  return {
    client,
    async ok(name: string, args: Record<string, unknown> = {}): Promise<any> {
      const result = await client.callTool({ name, arguments: args });
      expect(result.isError).not.toBe(true);
      return result.structuredContent;
    },
  };
}

function renameCallback(session: UberblickMcpSession) {
  const registered = session.server as unknown as {
    _registeredTools: Record<string, {
      handler(args: { uuid: string; title: string }): Promise<CallToolResult>;
    }>;
  };
  return registered._registeredTools.set_metadata!.handler;
}

function failure(result: CallToolResult): unknown {
  expect(result.isError).toBe(true);
  const content = result.content[0];
  if (content?.type !== "text") throw new Error("A refusal must contain its JSON failure payload.");
  return JSON.parse(content.text);
}

function gate() {
  let enter!: () => void;
  let release!: () => void;
  const entered = new Promise<void>(resolve => { enter = resolve; });
  const held = new Promise<void>(resolve => { release = resolve; });
  releases.push(release);
  return { entered, release, async wait() { enter(); await held; } };
}

it("shares documents across sessions and keeps the runtime serving after one session closes", async () => {
  const instance = runtime();
  const firstSession = instance.openSession();
  const secondSession = instance.openSession();
  const [first, second] = await Promise.all([connect(firstSession, "first"), connect(secondSession, "second")]);
  expect(firstSession.replicas).toBe(secondSession.replicas);
  expect(firstSession.store).toBe(instance.store);
  const created = await first.ok("create_doc", {
    title: "Shared runtime", description: "Both sessions read the same replicas.",
    blocks: [{ type: "paragraph", text: "Shared discovery phrase" }],
  });
  expect((await second.ok("search", { query: "discovery phrase" })).hits)
    .toContainEqual(expect.objectContaining({ uuid: created.uuid }));
  expect(await second.ok("get_doc", { uuid: created.uuid })).toMatchObject({
    title: "Shared runtime", blocks: [expect.objectContaining({ text: "Shared discovery phrase" })],
  });
  const rename = renameCallback(firstSession);
  const destroy = vi.spyOn(instance.replicas, "destroy");
  await firstSession.close();
  expect(failure(await rename({ uuid: created.uuid, title: "Too late" }))).toMatchObject({
    error: "server_shutting_down", applied: false, partial: false, synced: false,
  });
  expect(destroy).not.toHaveBeenCalled();
  await second.ok("set_metadata", { uuid: created.uuid, title: "Still serving" });
  const third = await connect(instance.openSession(), "third");
  expect((await third.ok("get_doc", { uuid: created.uuid })).title).toBe("Still serving");
  await secondSession.close();
  expect(destroy).not.toHaveBeenCalled();
  await instance.close();
  expect(destroy).toHaveBeenCalledTimes(1);
});

it("drains an admitted session call while another session continues serving", async () => {
  const instance = runtime();
  const firstSession = instance.openSession();
  const secondSession = instance.openSession();
  const first = await connect(firstSession, "closing");
  const second = await connect(secondSession, "survivor");
  const created = await first.ok("create_doc", { title: "Before close", description: "Admitted writes finish." });
  const held = gate();
  const settle = instance.replicas.settle.bind(instance.replicas);
  vi.spyOn(instance.replicas, "settle").mockImplementationOnce(async () => { await held.wait(); await settle(); });
  const rename = renameCallback(firstSession);
  const admitted = first.client.callTool({
    name: "set_metadata", arguments: { uuid: created.uuid, title: "Admitted write" },
  }).catch((error: unknown) => error);
  await held.entered;
  const closing = firstSession.close();
  let closed = false;
  void closing.then(() => { closed = true; });
  expect(firstSession.close()).toBe(closing);
  expect(failure(await rename({ uuid: created.uuid, title: "Rejected write" })))
    .toMatchObject({ error: "server_shutting_down", applied: false });
  expect((await second.ok("get_doc", { uuid: created.uuid })).title).toBe("Before close");
  expect(closed).toBe(false);
  held.release();
  await closing;
  expect(await admitted).toBeInstanceOf(Error);
  expect((await second.ok("get_doc", { uuid: created.uuid })).title).toBe("Admitted write");
});

it("stops all sessions synchronously and drains them before releasing the runtime", async () => {
  const instance = runtime();
  const firstSession = instance.openSession();
  const secondSession = instance.openSession();
  const first = await connect(firstSession, "first");
  await connect(secondSession, "second");
  const created = await first.ok("create_doc", { title: "Before shutdown", description: "Runtime owns release." });
  const held = gate();
  const settle = instance.replicas.settle.bind(instance.replicas);
  vi.spyOn(instance.replicas, "settle").mockImplementationOnce(async () => { await held.wait(); await settle(); });
  const admitted = first.client.callTool({
    name: "set_metadata", arguments: { uuid: created.uuid, title: "Finished before release" },
  }).catch((error: unknown) => error);
  await held.entered;
  let reentered: Promise<void> | undefined;
  firstSession.server.server.onclose = () => { reentered = instance.close(); };
  const titleAtRelease: string[] = [];
  const destroy = instance.replicas.destroy.bind(instance.replicas);
  vi.spyOn(instance.replicas, "destroy").mockImplementation(() => {
    titleAtRelease.push(getMeta(instance.replicas.replica(created.uuid).doc).title);
    destroy();
  });
  const storeClose = vi.spyOn(instance.store, "close");
  const closing = instance.close();
  expect(instance.close()).toBe(closing);
  expect(() => instance.openSession()).toThrow();
  for (const session of [firstSession, secondSession]) {
    expect(failure(await renameCallback(session)({ uuid: created.uuid, title: "Too late" })))
      .toMatchObject({ error: "server_shutting_down", applied: false });
  }
  expect(titleAtRelease).toEqual([]);
  expect(storeClose).not.toHaveBeenCalled();
  held.release();
  await closing;
  await admitted;
  expect(reentered).toBe(closing);
  expect(titleAtRelease).toEqual(["Finished before release"]);
  expect(storeClose).toHaveBeenCalledTimes(1);
});

it("takes startup instructions when each session opens and gives each session its own help catalog", async () => {
  const instance = runtime();
  const firstSession = instance.openSession();
  const first = await connect(firstSession, "first");
  const openedBeforeGuidance = instance.openSession();
  const marker = createTagCatalogEntry(instance.replicas.settings().doc, "guidance");
  const guide = await first.ok("create_doc", {
    title: "Runtime guidance", description: "Read applicable guidance.", tags: [marker.id],
  });
  const second = await connect(openedBeforeGuidance, "second");
  const thirdSession = instance.openSession();
  const third = await connect(thirdSession, "third");
  expect(first.client.getInstructions()).toBe(STARTUP_ORIENTATION);
  expect(second.client.getInstructions()).toBe(STARTUP_ORIENTATION);
  expect(third.client.getInstructions()).toContain(`Runtime guidance (\`${guide.uuid}\`)`);
  await firstSession.close();
  expect((await third.ok("get_help", { topic: "orientation" })).text).toBe(STARTUP_ORIENTATION);
  const resource = await third.client.readResource({ uri: "uberblick://help/orientation" });
  expect(resource.contents[0]).toMatchObject({ text: STARTUP_ORIENTATION });
  expect((await second.client.listResources()).resources.length).toBeGreaterThan(0);
});

it("keeps a fixed runtime name on cursors and write origins across initialized clients", async () => {
  const instance = runtime("Grant agent");
  const first = await connect(instance.openSession(), "first client");
  const created = await first.ok("create_doc", {
    title: "Fixed identity", description: "The runtime owns identity.",
    blocks: [{ type: "paragraph", text: "Original" }],
  });
  const second = await connect(instance.openSession(), "second client");
  await second.ok("edit_block", {
    uuid: created.uuid, block_id: created.blocks[0].id, old_text: "Original", new_text: "Edited",
  });
  const replica = instance.replicas.replica(created.uuid);
  expect(replica.awareness.getLocalState()).toMatchObject({
    user: { name: "Grant agent" }, cursor: { anchor: expect.any(Object), head: expect.any(Object) },
  });
  expect(instance.store.updatesAfter(replica.room, 0).every(row =>
    row.metadata?.surface?.kind === "mcp" && row.metadata.surface.name === "Grant agent")).toBe(true);
});

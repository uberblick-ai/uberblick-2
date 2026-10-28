import { randomUUID } from "node:crypto";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { startDeviceSyncHub } from "@uberblick/hub/test-device-sync";
import { addComment, createAnnotation, getAnnotation } from "@uberblick/schema";
import { afterEach, describe, expect, it } from "vitest";
import { removeHubLogin, writeHubLogin } from "../src/auth-store.js";
import { createMcpRuntime } from "../src/server.js";
import {
  cleanupTestResources, startServer, tempDir, testConfig, WORKSPACE,
} from "./helpers.js";
import type { Rig } from "./helpers.js";

const clients: Array<() => Promise<void>> = [];
const hubs: Array<Awaited<ReturnType<typeof startDeviceSyncHub>>> = [];

afterEach(async () => {
  await cleanupTestResources({
    clients: clients.splice(0),
    hubs: hubs.splice(0).map(hub => () => hub.close()),
  });
});

async function rig(config = testConfig(), name = "Claude Code"): Promise<Rig> {
  const value = await startServer(config, undefined, { name, version: "1" });
  clients.push(() => value.close());
  return value;
}

async function document(client: Pick<Rig, "ok">) {
  return client.ok("create_doc", {
    title: "Comment attribution", description: "Comment identity remains display data.",
    blocks: [{ type: "paragraph", text: "Original context" }, { type: "paragraph", text: "New context" }],
  });
}

async function storedLogin() {
  const hub = await startDeviceSyncHub({ directory: tempDir() });
  hubs.push(hub);
  const login = hub.issue({ workspaces: [WORKSPACE] });
  const env = { XDG_CONFIG_HOME: tempDir() };
  // No hub transport is enabled: attribution must use the stored sign-in offline.
  const config = { ...testConfig({ hubUrl: hub.url }), authEnv: env };
  await writeHubLogin(hub.origin, login, env);
  return { hub, login, env, config };
}

describe("comment attribution through MCP", () => {
  it.each([
    ["CLAUDE Code", "claude"],
    ["cOdEx desktop", "codex"],
    ["Cursor", undefined],
    ["Codex and Claude", "claude"],
  ])("stores agent kind for every %s comment mode, independently of the author", async (name, agent) => {
    const client = await rig(testConfig(), name);
    const doc = await document(client);
    const opened = await client.ok("annotate", {
      uuid: doc.uuid, block_id: doc.blocks[0].id, start: 0, end: 3, text: "Open",
    });
    await client.ok("annotate", {
      uuid: doc.uuid, thread_id: opened.annotation.id, author: "Chosen author", text: "Reply",
    });
    const moved = await client.ok("annotate", {
      uuid: doc.uuid, thread_id: opened.annotation.id, block_id: doc.blocks[1].id,
      start: 0, end: 3, text: "Move",
    });
    const expected = [
      { author: name, text: "Open" },
      { author: "Chosen author", text: "Reply" },
      { author: name, text: "Move" },
    ].map(comment => ({ ...comment, createdAt: expect.any(String), ...(agent === undefined ? {} : { agent }) }));
    const stored = getAnnotation(client.instance.replicas.replica(doc.uuid).doc, opened.annotation.id)!;
    expect(stored.comments).toEqual(expected.map(comment => ({ ...comment, kind: "agent" })));
    expect(moved.annotation.comments).toEqual(expected.map(comment => ({ ...comment, id: expect.any(String) })));
    expect((await client.ok("get_doc", { uuid: doc.uuid })).annotations[0].comments).toEqual(moved.annotation.comments);
  });

  it("reads the current sign-in on each offline write and omits identity after sign-out", async () => {
    const { hub, login, env, config } = await storedLogin();
    const client = await rig(config);
    const doc = await document(client);
    const opened = await client.ok("annotate", {
      uuid: doc.uuid, block_id: doc.blocks[0].id, start: 0, end: 3, text: "First sign-in",
    });
    const replacement = hub.issue({ workspaces: [WORKSPACE], principalId: randomUUID() });
    replacement.identity.githubUsername = "another-person";
    await writeHubLogin(hub.origin, replacement, env);
    await client.ok("annotate", { uuid: doc.uuid, thread_id: opened.annotation.id, text: "Second sign-in" });
    await removeHubLogin(hub.origin, env);
    const moved = await client.ok("annotate", {
      uuid: doc.uuid, thread_id: opened.annotation.id, block_id: doc.blocks[1].id,
      start: 0, end: 3, text: "Signed out",
    });
    const comments = getAnnotation(client.instance.replicas.replica(doc.uuid).doc, opened.annotation.id)!.comments;
    expect(comments[0]).toMatchObject({ kind: "agent", agent: "claude", account: login.identity.githubUsername, principalId: login.identity.id });
    expect(comments[1]).toMatchObject({ kind: "agent", agent: "claude", account: "another-person", principalId: replacement.identity.id });
    expect(comments[2]).toEqual({ author: "Claude Code", text: "Signed out", createdAt: expect.any(String), kind: "agent", agent: "claude" });
    expect(moved.annotation.comments).toEqual(comments.map(({ kind: _kind, principalId: _principalId, ...comment }) => ({ ...comment, id: expect.any(String) })));
  });

  it("ignores a stored hub sign-in for a local workspace", async () => {
    const { config } = await storedLogin();
    const client = await rig({ ...config, localWorkspace: true });
    const doc = await document(client);
    const opened = await client.ok("annotate", {
      uuid: doc.uuid, block_id: doc.blocks[0].id, start: 0, end: 3, text: "Local comment",
    });
    expect(getAnnotation(client.instance.replicas.replica(doc.uuid).doc, opened.annotation.id)!.comments).toEqual([{
      author: "Claude Code", text: "Local comment", createdAt: expect.any(String), kind: "agent", agent: "claude",
    }]);
  });

  it("preserves browser, Claude, other-product and legacy rows through persistence and projects get_doc", async () => {
    const { config, login } = await storedLogin();
    const claude = await rig(config);
    const doc = await document(claude);
    const ydoc = claude.instance.replicas.replica(doc.uuid).doc;
    const person = { kind: "person" as const, account: "browser-person", principalId: randomUUID() };
    const thread = createAnnotation(ydoc, doc.blocks[0].id, 0, 3, "Presence name", "Browser opener", undefined, person);
    await claude.ok("annotate", { uuid: doc.uuid, thread_id: thread.id, text: "Claude reply" });
    addComment(ydoc, thread.id, "Old reader", "Legacy reply");
    await claude.close();

    const cursor = await rig(config, "Cursor");
    await cursor.ok("annotate", { uuid: doc.uuid, thread_id: thread.id, text: "Other MCP reply" });
    const comments = getAnnotation(cursor.instance.replicas.replica(doc.uuid).doc, thread.id)!.comments;
    expect(comments).toEqual([
      { author: "Presence name", text: "Browser opener", createdAt: expect.any(String), ...person },
      { author: "Claude Code", text: "Claude reply", createdAt: expect.any(String), kind: "agent", agent: "claude", account: login.identity.githubUsername, principalId: login.identity.id },
      { author: "Old reader", text: "Legacy reply", createdAt: expect.any(String) },
      { author: "Cursor", text: "Other MCP reply", createdAt: expect.any(String), kind: "agent", account: login.identity.githubUsername, principalId: login.identity.id },
    ]);
    const read = await cursor.ok("get_doc", { uuid: doc.uuid });
    expect(read.annotations[0].comments).toEqual(comments.map(({ kind: _kind, principalId: _principalId, ...comment }) => ({ ...comment, id: expect.any(String) })));
  });

  it("uses the runtime's fixed agent name instead of a session's reported product", async () => {
    const runtime = createMcpRuntime(testConfig(), { agentName: "Claude grant" });
    const server = runtime.openSession();
    const client = new Client({ name: "Codex session", version: "1" });
    clients.push(async () => { await client.close(); await runtime.close(); });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    const call = async (name: string, args: Record<string, unknown>) => {
      const result = await client.callTool({ name, arguments: args });
      expect(result.isError).not.toBe(true);
      return result.structuredContent as any;
    };
    const doc = await call("create_doc", { title: "Fixed runtime", description: "One shared write identity.", blocks: [{ type: "paragraph", text: "Context" }] });
    const opened = await call("annotate", { uuid: doc.uuid, block_id: doc.blocks[0].id, start: 0, end: 3, text: "Runtime comment" });
    expect(getAnnotation(runtime.replicas.replica(doc.uuid).doc, opened.annotation.id)!.comments).toEqual([{
      author: "Claude grant", text: "Runtime comment", createdAt: expect.any(String), kind: "agent", agent: "claude",
    }]);
  });
});

/**
 * `ub remote` — the show/set surface, and the two bridges end to end.
 *
 * Every bridge test runs two real hubs on ephemeral ports with their own SQLite
 * databases, and a real mirror in a throwaway XDG home. That is the whole point:
 * the properties worth defending here are about what is actually on the far side
 * and what is actually on disk when a command exits, and neither survives being
 * mocked.
 *
 * The corpus is built the two ways a corpus really arrives: a plain
 * `HocuspocusProvider` against the local hub, which is exactly what the web
 * client is, and an MCP `create_doc`, which lands in the update log. A promotion
 * that only moved one of those would look fine in a test that only made one.
 *
 * What is asserted, and nothing else: the refusal matrix, that a refusal writes
 * nothing, that the endpoint is persisted only after the far side is verified,
 * that a rerun finishes rather than collides, and that no secret and no token
 * ever reaches either stream.
 */

import { randomUUID } from "node:crypto";
import { chmodSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { HocuspocusProvider } from "@hocuspocus/provider";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { Hub } from "@uberblick/hub";
import { createHub, mintToken, silentLogger } from "@uberblick/hub";
import { createMcpServer, resolveMcpConfig } from "@uberblick/mcp-server";
import {
  appendBlock,
  directoryRoom,
  getBlocks,
  initDoc,
  listDirectory,
  roomForDoc,
  upsertDirectoryEntry,
} from "@uberblick/schema";
import * as Y from "yjs";
import { afterEach, describe, expect, it } from "vitest";
import type { Sandbox } from "./helpers.js";
import {
  DEAD_HUB_URL,
  removeTempDirs,
  runUb,
  runUbAsync,
  sandbox,
} from "./helpers.js";

const SECRET = "test-signing-secret-for-the-remote-bridge";
const OTHER_SECRET = "a-different-secret-the-remote-was-deployed-with";
const WORKSPACE = "main";

/** A JWT-ish token: base64url of `{"sub"…` always starts `eyJ`. */
const TOKEN_SHAPE = /eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/;

const hubs: Hub[] = [];

afterEach(async () => {
  for (const hub of hubs.splice(0)) {
    await hub.stop();
  }
  removeTempDirs();
});

async function startHub(authSecret = SECRET): Promise<Hub> {
  const hub = await createHub({
    authSecret,
    port: 0,
    databasePath: join(
      // Its own database, so "two isolated hubs" is a fact rather than a hope.
      sandbox().cwd,
      "hub.sqlite",
    ),
    log: silentLogger,
    debounce: 20,
    maxDebounce: 200,
    shutdownTimeoutMs: 5_000,
  });
  hubs.push(hub);
  return hub;
}

function url(hub: Hub): string {
  return `ws://127.0.0.1:${hub.port}`;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitUntil(
  label: string,
  predicate: () => boolean,
  timeoutMs = 10_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) {
      throw new Error(`timed out waiting for ${label}`);
    }
    await sleep(20);
  }
}

/** A browser-shaped client: a bare provider on one room, nothing else. */
async function openRoom(
  hub: Hub,
  room: string,
  secret: string = SECRET,
): Promise<{ doc: Y.Doc; done: () => Promise<void> }> {
  const doc = new Y.Doc();
  const provider = new HocuspocusProvider({
    url: url(hub),
    name: room,
    token: await mintToken(secret, {
      sub: "test-web-client",
      workspace: WORKSPACE,
      scope: "read-write",
    }),
    document: doc,
  });
  await waitUntil(`${room} to sync`, () => provider.isSynced);
  return {
    doc,
    async done() {
      // Destroying before the hub has acknowledged would drop the very writes
      // the rest of the test is about.
      await waitUntil(
        `${room} to be acknowledged`,
        () => provider.isSynced && !provider.hasUnsyncedChanges,
      );
      provider.destroy();
    },
  };
}

/**
 * A document created the way the web client creates one: written straight into
 * the hub's rooms, never touching any mirror.
 */
async function webDoc(
  hub: Hub,
  title: string,
  secret: string = SECRET,
): Promise<string> {
  const uuid = randomUUID();
  const room = await openRoom(hub, roomForDoc(WORKSPACE, uuid), secret);
  initDoc(room.doc, { uuid, title });
  appendBlock(room.doc, { type: "paragraph", text: `${title} body` });
  await room.done();

  const directory = await openRoom(hub, directoryRoom(WORKSPACE), secret);
  upsertDirectoryEntry(directory.doc, { uuid, title, tags: [] });
  await directory.done();
  return uuid;
}

/** Run one MCP session against a sandbox's mirror and return its client. */
async function withMcp<T>(
  box: Sandbox,
  env: NodeJS.ProcessEnv,
  body: (call: (name: string, args: Record<string, unknown>) => Promise<any>) => Promise<T>,
): Promise<T> {
  const config = resolveMcpConfig({ ...box.env, ...env });
  const instance = createMcpServer(config);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "uberblick-cli-tests", version: "0.0.0" });
  await Promise.all([
    instance.connect(serverTransport),
    client.connect(clientTransport),
  ]);
  try {
    return await body(async (name, args) => {
      const result = await client.callTool({ name, arguments: args });
      const content = result.content as { text?: string }[];
      return JSON.parse(content[0]?.text ?? "null");
    });
  } finally {
    await client.close();
    await instance.close();
  }
}

/** A document created through the MCP tools, so it lands in the update log. */
async function mcpDoc(box: Sandbox, hub: Hub, title: string): Promise<string> {
  return await withMcp(
    box,
    { HUB_URL: url(hub), HUB_AUTH_TOKEN: SECRET, WORKSPACE_ID: WORKSPACE },
    async (call) => {
      const created = await call("create_doc", {
        title,
        blocks: [{ type: "paragraph", text: `${title} body` }],
      });
      // `create_doc` returns before the hub has the write, by design, so wait
      // for the acknowledgement before this session goes away.
      const uuid: string = created.uuid;
      let synced = created.synced === true;
      for (let attempt = 0; attempt < 100 && !synced; attempt += 1) {
        await sleep(50);
        const status = await call("sync_status", {});
        synced = status.rooms.some(
          (room: { room: string; synced: boolean }) =>
            room.room === roomForDoc(WORKSPACE, uuid) && room.synced,
        );
      }
      expect(synced).toBe(true);
      return uuid;
    },
  );
}

/** What a fresh web client finds on a hub: uuid → the document's block texts. */
async function readHub(hub: Hub): Promise<Map<string, string[]>> {
  const directory = await openRoom(hub, directoryRoom(WORKSPACE));
  const entries = listDirectory(directory.doc);
  const found = new Map<string, string[]>();
  for (const entry of entries) {
    const room = await openRoom(hub, roomForDoc(WORKSPACE, entry.uuid));
    found.set(
      entry.uuid,
      getBlocks(room.doc).map((block) => block.text),
    );
    await room.done();
  }
  await directory.done();
  return found;
}

/** What the local update log holds, read offline through the MCP tools. */
async function readMirror(box: Sandbox): Promise<Map<string, string[]>> {
  // No secret: sync is disabled, so every answer comes from the log alone.
  return await withMcp(box, { WORKSPACE_ID: WORKSPACE }, async (call) => {
    const listed = await call("list_docs", {});
    const found = new Map<string, string[]>();
    for (const doc of listed.docs as { uuid: string }[]) {
      const full = await call("get_doc", { uuid: doc.uuid });
      found.set(
        doc.uuid,
        (full.blocks as { text: string }[]).map((block) => block.text),
      );
    }
    return found;
  });
}

function readConfigFile(box: Sandbox, name: string): Record<string, unknown> {
  const path = join(box.configHome, "uberblick", name);
  return JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
}

function persistedHubUrl(box: Sandbox): unknown {
  return readConfigFile(box, "config.json").hubUrl;
}

function storedSecret(box: Sandbox): unknown {
  return readConfigFile(box, "credentials.json").signingSecret;
}

/** A machine already using `hub`, with the secret it is using. */
function machine(hub: Hub): Sandbox {
  return sandbox({
    userConfig: { workspace: WORKSPACE, hubUrl: url(hub) },
    credentials: { signingSecret: SECRET },
  });
}

describe("ub remote", () => {
  it("says so when no remote is configured, and exits 0", () => {
    const run = runUb(["remote"], sandbox());
    expect(run.status).toBe(0);
    expect(run.stdout).toContain("no remote configured");
  });

  it("names the endpoint and the sharing boundary once one is set", () => {
    const box = sandbox();
    expect(runUb(["remote", "set", "wss://hub.example.ts.net"], box).status).toBe(0);

    const run = runUb(["remote"], box);
    expect(run.status).toBe(0);
    expect(run.stdout).toContain("wss://hub.example.ts.net");
    expect(run.stdout).toContain("served bundle");
    expect(run.stdout).toContain("private network");
    // #92, not #79: there is no invite flow to offer.
    expect(run.stdout).not.toMatch(/\bub remote invite\b/);
    expect(persistedHubUrl(box)).toBe("wss://hub.example.ts.net");
  });

  it("refuses a command it does not have", () => {
    const run = runUb(["remote", "invite", "someone@example.com"], sandbox());
    expect(run.status).toBe(2);
    expect(run.stderr).toContain('unknown command "invite"');
  });
});

describe("ub remote promote", () => {
  it("moves web-shaped and MCP-shaped state onto an empty hub, then switches", async () => {
    const local = await startHub();
    const remote = await startHub();
    const box = machine(local);

    const fromWeb = await webDoc(local, "Web note");
    const fromMcp = await mcpDoc(box, local, "Agent note");
    expect(persistedHubUrl(box)).toBe(url(local));

    const run = await runUbAsync(["remote", "promote", url(remote)], box);
    expect(run.stderr).toContain("verifying");
    expect(run.status).toBe(0);
    expect(run.stdout).toContain("promoted 2 documents");

    // The endpoint moved only now — and the far side really holds both.
    expect(persistedHubUrl(box)).toBe(url(remote));
    const seen = await readHub(remote);
    expect([...seen.keys()].sort()).toEqual([fromWeb, fromMcp].sort());
    expect(seen.get(fromWeb)).toEqual(["Web note body"]);
    expect(seen.get(fromMcp)).toEqual(["Agent note body"]);

    // Neither the secret nor a token it signs may appear in either stream.
    expect(run.output).not.toContain(SECRET);
    expect(run.output).not.toMatch(TOKEN_SHAPE);
  });

  it("finishes rather than collides when it is run again", async () => {
    const local = await startHub();
    const remote = await startHub();
    const box = machine(local);
    await webDoc(local, "Web note");

    expect((await runUbAsync(["remote", "promote", url(remote)], box)).status).toBe(
      0,
    );

    const again = await runUbAsync(["remote", "promote", url(remote)], box);
    expect(again.status).toBe(0);
    expect(again.stdout).toContain("promoted 1 document");
    expect(persistedHubUrl(box)).toBe(url(remote));
  });

  it("refuses a remote that already holds documents, naming both counts", async () => {
    const local = await startHub();
    const remote = await startHub();
    const box = machine(local);
    await webDoc(local, "Local note");
    await webDoc(remote, "Somebody else's note");

    const run = await runUbAsync(["remote", "promote", url(remote)], box);
    expect(run.status).toBe(1);
    expect(run.stderr).toContain("already holds 1 document");
    expect(run.stderr).toContain("this workspace does not");
    expect(run.stderr).toContain("Merging two populated workspaces is unsupported");
    expect(run.stderr).toContain("nothing was written");

    // Nothing moved, and the endpoint is still the one that works.
    expect(persistedHubUrl(box)).toBe(url(local));
    expect((await readHub(remote)).size).toBe(1);
  });

  it("refuses when the local hub cannot be reached, so nothing is stranded", async () => {
    const remote = await startHub();
    const box = sandbox({
      userConfig: { workspace: WORKSPACE, hubUrl: DEAD_HUB_URL },
      credentials: { signingSecret: SECRET },
    });

    const run = await runUbAsync(["remote", "promote", url(remote)], box);
    expect(run.status).toBe(1);
    expect(run.stderr).toContain("did not answer");
    expect(run.stderr).toContain("Nothing was written");
    expect(persistedHubUrl(box)).toBe(DEAD_HUB_URL);
  });
});

describe("ub remote join", () => {
  it("hydrates an empty workspace from the remote, then switches", async () => {
    const remote = await startHub(OTHER_SECRET);
    const fromWeb = await webDoc(remote, "Shared note", OTHER_SECRET);
    const other = await webDoc(remote, "Second note", OTHER_SECRET);

    // A fresh second checkout: `ub init` writes configuration, generates a
    // *local* development secret and imports no documents, so this workspace is
    // genuinely empty. The dead endpoint stands in for the hub that is not
    // running on a machine which has never had one.
    const box = sandbox({ userConfig: { hubUrl: DEAD_HUB_URL } });
    expect((await runUbAsync(["init", "--yes"], box)).status).toBe(0);

    // The remote was deployed with its own secret, so this is also the
    // credential path: a file only its owner can read, never an argument.
    const secretFile = join(box.cwd, "remote-secret");
    writeFileSync(secretFile, `${OTHER_SECRET}\n`, { mode: 0o600 });
    chmodSync(secretFile, 0o600);

    const run = await runUbAsync(
      ["remote", "join", url(remote), "--secret-file", secretFile],
      box,
    );
    expect(run.status).toBe(0);
    expect(run.stdout).toContain("joined 2 documents");
    expect(persistedHubUrl(box)).toBe(url(remote));
    // The credential that reached the remote is now this machine's.
    expect(storedSecret(box)).toBe(OTHER_SECRET);

    // The corpus is in the local update log: read back with the hub stopped and
    // no secret configured, so nothing can have come off the wire.
    for (const hub of hubs.splice(0)) {
      await hub.stop();
    }
    const mirror = await readMirror(box);
    expect([...mirror.keys()].sort()).toEqual([fromWeb, other].sort());
    expect(mirror.get(fromWeb)).toEqual(["Shared note body"]);

    expect(run.output).not.toContain(OTHER_SECRET);
    expect(run.output).not.toMatch(TOKEN_SHAPE);
  });

  it("refuses a secret file other users can read", async () => {
    const box = sandbox();
    const secretFile = join(box.cwd, "remote-secret");
    writeFileSync(secretFile, `${OTHER_SECRET}\n`);
    chmodSync(secretFile, 0o644);

    const run = await runUbAsync(
      ["remote", "join", DEAD_HUB_URL, "--secret-file", secretFile],
      box,
    );
    expect(run.status).toBe(2);
    expect(run.stderr).toContain("lets other users read");
    expect(run.output).not.toContain(OTHER_SECRET);
  });

  it("refuses a non-empty local workspace, naming both counts", async () => {
    const local = await startHub();
    const remote = await startHub();
    const box = machine(local);
    await mcpDoc(box, local, "Mine");
    await webDoc(remote, "Theirs");

    const run = await runUbAsync(["remote", "join", url(remote)], box);
    expect(run.status).toBe(1);
    expect(run.stderr).toContain("this workspace already holds 1 document");
    expect(run.stderr).toContain("the remote holds 1 document");
    expect(run.stderr).toContain("Merging two populated workspaces is unsupported");
    expect(persistedHubUrl(box)).toBe(url(local));
  });

  it("persists nothing when the remote is unreachable", async () => {
    const box = sandbox({
      userConfig: { workspace: WORKSPACE, hubUrl: "ws://127.0.0.1:2" },
      credentials: { signingSecret: SECRET },
    });

    const run = await runUbAsync(["remote", "join", DEAD_HUB_URL], box);
    expect(run.status).toBe(1);
    expect(run.stderr).toContain("did not answer");
    expect(persistedHubUrl(box)).toBe("ws://127.0.0.1:2");
  });

  it("persists nothing when the remote rejects the credential", async () => {
    const remote = await startHub(OTHER_SECRET);
    const box = sandbox({
      userConfig: { workspace: WORKSPACE, hubUrl: DEAD_HUB_URL },
      credentials: { signingSecret: SECRET },
    });

    const run = await runUbAsync(["remote", "join", url(remote)], box);
    expect(run.status).toBe(1);
    expect(run.stderr).toContain("rejected the credential");
    expect(run.stderr).toContain("--secret-file");
    expect(persistedHubUrl(box)).toBe(DEAD_HUB_URL);
    expect(run.output).not.toContain(SECRET);
    expect(run.output).not.toMatch(TOKEN_SHAPE);
  });
});

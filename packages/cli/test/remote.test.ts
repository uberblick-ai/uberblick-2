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

import { createHash, randomUUID } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import type { Server } from "node:http";
import { createServer } from "node:http";
import type { Socket } from "node:net";
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
  tombstoneDirectoryEntry,
  upsertDirectoryEntry,
} from "@uberblick/schema";
import * as Y from "yjs";
import { afterEach, describe, expect, it } from "vitest";
import type { Sandbox } from "./helpers.js";
import { setRemote } from "../src/remote.js";
import {
  DEAD_HUB_URL,
  removeTempDirs,
  runUbAsync,
  sandbox,
} from "./helpers.js";

const SECRET = "test-signing-secret-for-the-remote-bridge";
/** No `mise` on PATH, so no `mise trust` subprocess in the middle of a test. */
const WITHOUT_MISE = { PATH: "/usr/bin:/bin" };
const OTHER_SECRET = "a-different-secret-the-remote-was-deployed-with";
const WORKSPACE = "b7c3d914-5a20-4e6f-8d13-9f04a2c68e75";

/** A JWT-ish token: base64url of `{"sub"…` always starts `eyJ`. */
const TOKEN_SHAPE = /eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/;

const hubs: Hub[] = [];

afterEach(async () => {
  for (const hub of hubs.splice(0)) {
    await hub.stop();
  }
  for (const { server, sockets } of silentServers.splice(0)) {
    // The sockets are deliberately never closed by the peer, so `close` would
    // wait for them forever.
    for (const socket of sockets) socket.destroy();
    await new Promise<void>((resolve) => server.close(() => resolve()));
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

const silentServers: { server: Server; sockets: Socket[] }[] = [];

/**
 * A server that completes the websocket handshake and then says nothing.
 *
 * The failure worth having a fixture for: the far side is up, accepts the
 * connection and authenticates nothing, so the room never goes quiet.
 * `waitForQuiet` returns on its deadline exactly as it does on success, which is
 * why the bridge has to tell the two apart by itself.
 */
async function silentServer(): Promise<{ url: string }> {
  const sockets: Socket[] = [];
  const server = createServer();
  server.on("upgrade", (request, socket: Socket) => {
    sockets.push(socket);
    const key = request.headers["sec-websocket-key"] ?? "";
    const accept = createHash("sha1")
      .update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`)
      .digest("base64");
    socket.write(
      "HTTP/1.1 101 Switching Protocols\r\n" +
        "Upgrade: websocket\r\n" +
        "Connection: Upgrade\r\n" +
        `Sec-WebSocket-Accept: ${accept}\r\n\r\n`,
    );
    // …and not one frame after that.
  });
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });
  silentServers.push({ server, sockets });
  const address = server.address();
  if (address === null || typeof address === "string") {
    throw new Error("the silent server did not bind a port");
  }
  return { url: `ws://127.0.0.1:${address.port}` };
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
): Promise<{
  doc: Y.Doc;
  provider: HocuspocusProvider;
  done: () => Promise<void>;
}> {
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
    provider,
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
  // Given explicitly when a test needs the *same* document to exist on two
  // hubs with different contents — identity is the uuid, so that is divergence.
  options: { uuid?: string; body?: string } = {},
): Promise<string> {
  const uuid = options.uuid ?? randomUUID();
  const room = await openRoom(hub, roomForDoc(WORKSPACE, uuid), secret);
  initDoc(room.doc, { uuid, title });
  appendBlock(room.doc, {
    type: "paragraph",
    text: options.body ?? `${title} body`,
  });
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
async function readMirror(
  box: Sandbox,
  workspace: string = WORKSPACE,
): Promise<Map<string, string[]>> {
  // No secret: sync is disabled, so every answer comes from the log alone.
  return await withMcp(box, { WORKSPACE_ID: workspace }, async (call) => {
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
  it("says so when no remote is configured, and exits 0", async () => {
    // A workspace but no remote: `ub remote` reads which workspace it is
    // reporting on, and there is no default workspace to fall back to.
    const run = await runUbAsync(
      ["remote"],
      sandbox({ userConfig: { workspace: WORKSPACE } }),
    );
    expect(run.status).toBe(0);
    expect(run.stdout).toContain("no remote configured");
  });

  it("names the endpoint and the sharing boundary once one is set", async () => {
    const box = sandbox({ userConfig: { workspace: WORKSPACE } });
    expect((await runUbAsync(["remote", "set", "wss://hub.example.ts.net"], box)).status).toBe(
      0,
    );

    const run = await runUbAsync(["remote"], box);
    expect(run.status).toBe(0);
    expect(run.stdout).toContain("wss://hub.example.ts.net");
    expect(run.stdout).toContain("served bundle");
    expect(run.stdout).toContain("private network");
    // The endpoint AND where it came from — a source is what makes the value
    // actionable when something else outranks it.
    expect(run.stdout).toContain("user config");
    expect(persistedHubUrl(box)).toBe("wss://hub.example.ts.net");
  });

  it("refuses a command it does not have", async () => {
    const run = await runUbAsync(
      ["remote", "invite", "someone@example.com"],
      sandbox(),
    );
    expect(run.status).toBe(2);
    expect(run.stderr).toContain('unknown command "invite"');
  });

  // A credential in the URL would be persisted into two files and echoed on
  // stdout. The hub takes its secret in the connection's auth message only.
  it.each([
    ["wss://user:hunter2@hub.example.ts.net/ws", "username or password"],
    ["wss://hub.example.ts.net/ws?token=hunter2", "query string"],
    ["wss://hub.example.ts.net/ws#hunter2", "fragment"],
  ])("refuses %s", async (endpoint, because) => {
    const box = sandbox();
    const run = await runUbAsync(["remote", "set", endpoint], box);
    expect(run.status).toBe(2);
    expect(run.stderr).toContain(because);
    // The refusal must not echo back the credential it is refusing.
    expect(run.output).not.toContain("hunter2");
  });

  it("preserves the other fields in config.json", async () => {
    const box = sandbox({
      userConfig: { workspace: WORKSPACE, displayName: "Someone", color: "#0e8085" },
    });
    expect((await runUbAsync(["remote", "set", "wss://hub.example.ts.net"], box)).status).toBe(
      0,
    );

    const config = readConfigFile(box, "config.json");
    expect(config.displayName).toBe("Someone");
    expect(config.color).toBe("#0e8085");
    expect(config.hubUrl).toBe("wss://hub.example.ts.net");
  });

  it("never writes ./uberblick.json", async () => {
    // It is committable, and `secretAppliesTo` withholds the stored secret from
    // a repository-chosen hub — so an endpoint written there would be dialled
    // with no credential at all.
    const box = sandbox();
    expect((await runUbAsync(["remote", "set", "wss://hub.example.ts.net"], box)).status).toBe(
      0,
    );
    expect(existsSync(join(box.cwd, "uberblick.json"))).toBe(false);
  });

  it("says when ./uberblick.json outranks what it just wrote", async () => {
    // A committable file pins the endpoint, and `secretAppliesTo` withholds the
    // stored secret from a repository-chosen hub — so writing the endpoint
    // *there* is not the fix, and printing the new one without saying this
    // would be printing a value that does not take effect.
    const box = sandbox({ directoryFile: { hubUrl: "ws://127.0.0.1:9999" } });

    const run = await runUbAsync(["remote", "set", "wss://hub.example.ts.net"], box);
    expect(run.status).toBe(1);
    expect(run.stderr).toContain("./uberblick.json");
    expect(run.stderr).toContain("ws://127.0.0.1:9999");
    expect(run.stderr).toContain("outranks");
    // It still wrote the file it was asked to write.
    expect(persistedHubUrl(box)).toBe("wss://hub.example.ts.net");
  });

  it("says when HUB_URL in the environment outranks what it just wrote", async () => {
    const box = sandbox();
    const run = await runUbAsync(["remote", "set", "wss://hub.example.ts.net"], box, {
      HUB_URL: "ws://127.0.0.1:9999",
    });
    expect(run.status).toBe(1);
    expect(run.stderr).toContain("HUB_URL in the environment");
    expect(run.stderr).toContain("outranks");
  });

  it("never leaves the stored credential naming a different hub", () => {
    // The endpoint cannot be written — `config.json` is a directory — after the
    // credential already has been. The credential must go back.
    const box = sandbox({ credentials: { signingSecret: SECRET } });
    mkdirSync(join(box.configHome, "uberblick", "config.json"), { recursive: true });

    expect(() =>
      setRemote("wss://hub.example.ts.net", {
        secret: OTHER_SECRET,
        env: box.env,
        cwd: box.cwd,
      }),
    ).toThrow();
    expect(storedSecret(box)).toBe(SECRET);
  });

  it("keeps the stored credential when a higher layer outranks the endpoint", () => {
    // Same invariant from the other side: the endpoint in force is HUB_URL's,
    // so storing the target's secret would leave *that* hub authenticating
    // with a credential belonging to a hub nobody is dialling. The endpoint is
    // still written — it takes over the moment HUB_URL goes away.
    const box = sandbox({ credentials: { signingSecret: SECRET } });
    box.env.HUB_URL = "ws://127.0.0.1:9999";

    const persistence = setRemote("wss://hub.example.ts.net", {
      secret: OTHER_SECRET,
      env: box.env,
      cwd: box.cwd,
    });

    expect(storedSecret(box)).toBe(SECRET);
    expect(persistence.replacedSecret).toBe(false);
    expect(persistence.warnings.join("\n")).toContain(
      "HUB_URL in the environment",
    );
    expect(persistedHubUrl(box)).toBe("wss://hub.example.ts.net");

    // …but a higher layer naming the endpoint being written outranks nothing
    // that matters, and withholding there would refuse a second machine the
    // credential it ran `join` to get.
    const agreeing = sandbox({ credentials: { signingSecret: SECRET } });
    agreeing.env.HUB_URL = "wss://hub.example.ts.net";

    const stored = setRemote("wss://hub.example.ts.net", {
      secret: OTHER_SECRET,
      env: agreeing.env,
      cwd: agreeing.cwd,
    });

    expect(storedSecret(agreeing)).toBe(OTHER_SECRET);
    expect(stored.replacedSecret).toBe(true);
    expect(stored.warnings).toEqual([]);
    expect(stored.outrankedBy).toBe(null);

    // Same hub, not same spelling: a root slash is what `new URL` adds to an
    // empty path, so a HUB_URL carrying one is not a second hub.
    const slashed = sandbox({ credentials: { signingSecret: SECRET } });
    slashed.env.HUB_URL = "wss://hub.example.ts.net/";

    const spelled = setRemote("wss://hub.example.ts.net", {
      secret: OTHER_SECRET,
      env: slashed.env,
      cwd: slashed.cwd,
    });

    expect(storedSecret(slashed)).toBe(OTHER_SECRET);
    expect(spelled.replacedSecret).toBe(true);
    expect(spelled.warnings).toEqual([]);
    expect(spelled.outrankedBy).toBe(null);
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
    expect(run.stderr).toContain("are not in this workspace");
    expect(run.stderr).toContain("Merging two populated workspaces is unsupported");
    expect(run.stderr).toContain("Nothing was written, and");
    expect(run.stderr).toContain("was not touched");

    // Nothing moved, and the endpoint is still the one that works.
    expect(persistedHubUrl(box)).toBe(url(local));
    expect((await readHub(remote)).size).toBe(1);
  });

  // The source is read once before the upload and again after it. Without the
  // second read a browser edit landing on the local hub mid-run is absent from
  // the upload, absent from the snapshot, and absent from the read-back that
  // compares the two — so verification passes and the change is stranded.
  it("carries a change written to the source hub while it runs", async () => {
    const local = await startHub();
    const remote = await startHub();
    const box = machine(local);
    const uuid = await webDoc(local, "Edited late");

    // A browser that stays on the local hub throughout and writes at exactly
    // the moment that matters: after the bridge has finished reading the source
    // and detached from it. A stopwatch cannot find that boundary, but the
    // bridge's own awareness can — it publishes a user on every room it
    // attaches, so the write goes out when that user disappears again.
    const room = await openRoom(local, roomForDoc(WORKSPACE, uuid));
    let bridgeArrived = false;
    const wroteLate = new Promise<void>((resolve) => {
      const watch = setInterval(() => {
        const present = room.provider.awareness?.getStates().size ?? 0;
        if (present > 1) {
          bridgeArrived = true;
          return;
        }
        if (bridgeArrived) {
          clearInterval(watch);
          appendBlock(room.doc, { type: "paragraph", text: "written late" });
          resolve();
        }
      }, 20);
    });

    const run = await runUbAsync(["remote", "promote", url(remote)], box);
    await wroteLate;
    await room.done();

    expect(run.status).toBe(0);
    // Without the second read of the source this is absent from the upload,
    // absent from the snapshot, and absent from the read-back comparing them.
    expect((await readHub(remote)).get(uuid)).toContain("written late");
  }, 90_000);

  // A shared uuid is one document's lineage on two hubs, which Yjs merges —
  // the resumability the two verbs are built on. Only a uuid this workspace has
  // never heard of is a second workspace.
  it("finishes rather than refuses when the remote shares a document", async () => {
    const local = await startHub();
    const remote = await startHub();
    const box = machine(local);
    const shared = randomUUID();
    await webDoc(local, "Shared", SECRET, { uuid: shared, body: "mine" });
    await webDoc(remote, "Shared", SECRET, { uuid: shared, body: "theirs" });

    const run = await runUbAsync(["remote", "promote", url(remote)], box);
    expect(run.status).toBe(0);
    expect(persistedHubUrl(box)).toBe(url(remote));
    expect([...(await readHub(remote)).keys()]).toEqual([shared]);
  });

  // A previous run that uploaded the directory stub and died before the room
  // arrived leaves a target naming a document it cannot serve. Attaching the
  // local replica is exactly what repairs that, so it must not be a refusal.
  it("finishes a promotion whose earlier run left a stub without its room", async () => {
    const local = await startHub();
    const remote = await startHub();
    const box = machine(local);
    const uuid = await webDoc(local, "Half uploaded");

    // The shape an interrupted promotion leaves: the stub is there, the room
    // never arrived.
    const directory = await openRoom(remote, directoryRoom(WORKSPACE));
    upsertDirectoryEntry(directory.doc, {
      uuid,
      title: "Half uploaded",
      tags: [],
    });
    await directory.done();

    const run = await runUbAsync(["remote", "promote", url(remote)], box);
    expect(run.status).toBe(0);
    expect(persistedHubUrl(box)).toBe(url(remote));
    expect((await readHub(remote)).get(uuid)).toEqual(["Half uploaded body"]);
  });

  // Attaching the populated mirror to the target *is* a merge, so the refusal
  // has to be decided by a throwaway client before that ever happens.
  it("leaves the remote untouched when it refuses", async () => {
    const local = await startHub();
    const remote = await startHub();
    const box = machine(local);
    await webDoc(local, "Mine");
    await webDoc(remote, "Theirs");
    const before = await readHub(remote);

    expect((await runUbAsync(["remote", "promote", url(remote)], box)).status).toBe(
      1,
    );

    const after = await readHub(remote);
    expect([...after.keys()].sort()).toEqual([...before.keys()].sort());
    for (const [uuid, blocks] of before) {
      expect(after.get(uuid)).toEqual(blocks);
    }
  });

  // "Read it and it holds nothing" and "could not finish reading it" are
  // different answers. Treating the second as the first is how a bridge decides
  // a populated hub is safe to promote into.
  it("refuses a hub it connected to but could not finish reading", async () => {
    const local = await startHub();
    const silent = await silentServer();
    const box = machine(local);
    await webDoc(local, "Mine");

    const run = await runUbAsync(["remote", "promote", silent.url], box, {}, 55_000);
    expect(run.status).toBe(1);
    expect(run.stderr).toContain("never finished serving its directory");
    expect(run.stderr).toContain("not the same as holding nothing");
    // The failure it must never become: an empty reading treated as an empty hub.
    expect(run.stderr).not.toContain("already holds 0 documents");
    expect(persistedHubUrl(box)).toBe(url(local));
  }, 60_000);

  it("refuses a remote holding nothing but archived documents", async () => {
    const local = await startHub();
    const remote = await startHub();
    const box = machine(local);
    await webDoc(local, "Mine");

    // A hub somebody used and then emptied is not an empty hub: its directory
    // still carries the tombstones, and they are sticky.
    const gone = await webDoc(remote, "Deleted over there");
    const directory = await openRoom(remote, directoryRoom(WORKSPACE));
    tombstoneDirectoryEntry(directory.doc, gone);
    await directory.done();

    const run = await runUbAsync(["remote", "promote", url(remote)], box);
    expect(run.status).toBe(1);
    expect(run.stderr).toContain("Merging two populated workspaces is unsupported");
    expect(run.stderr).toContain(gone);
    expect(persistedHubUrl(box)).toBe(url(local));
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
    expect(run.stderr).toContain("nothing was written");
    expect(persistedHubUrl(box)).toBe(DEAD_HUB_URL);
  });
});

describe("ub remote join", () => {
  /**
   * The join URL, which is the whole of what a second machine is told: the
   * endpoint with the workspace id as its last path segment.
   */
  function joinUrl(hub: Hub, workspace: string = WORKSPACE): string {
    return `${url(hub)}/${workspace}`;
  }

  /** A secret file the way `join` insists on being given one: mode 0600. */
  function secretFile(box: Sandbox, secret: string): string {
    const path = join(box.cwd, "remote-secret");
    writeFileSync(path, `${secret}\n`, { mode: 0o600 });
    chmodSync(path, 0o600);
    return path;
  }

  it("binds a machine with no configuration at all to the workspace in the URL", async () => {
    const remote = await startHub(OTHER_SECRET);
    const fromWeb = await webDoc(remote, "Shared note", OTHER_SECRET);
    const other = await webDoc(remote, "Second note", OTHER_SECRET);

    // Nothing here: no `ub init`, no workspace, no endpoint, no credential —
    // the second machine as the owner decided it should work.
    const box = sandbox();

    const run = await runUbAsync(
      [
        "remote",
        "join",
        joinUrl(remote),
        "--secret-file",
        secretFile(box, OTHER_SECRET),
      ],
      box,
    );
    expect(run.status).toBe(0);
    expect(run.stdout).toContain("joined 2 documents");

    // The id came off the URL: the endpoint persisted is the URL without it,
    // and the workspace persisted is the one it named.
    expect(persistedHubUrl(box)).toBe(url(remote));
    expect(readConfigFile(box, "config.json").workspace).toBe(WORKSPACE);
    expect(runUb(["workspace"], box).stdout).toContain(WORKSPACE);
    // The credential that reached the remote is this machine's now. Still
    // owner-only afterwards.
    expect(storedSecret(box)).toBe(OTHER_SECRET);
    const mode =
      statSync(join(box.configHome, "uberblick", "credentials.json")).mode & 0o777;
    expect(mode).toBe(0o600);

    // The corpus is in the local update log, and nothing else is: read back
    // with the hub stopped and no secret configured, so nothing can have come
    // off the wire and no starter document can have been seeded here.
    for (const hub of hubs.splice(0)) {
      await hub.stop();
    }
    const mirror = await readMirror(box);
    expect([...mirror.keys()].sort()).toEqual([fromWeb, other].sort());
    expect(mirror.get(fromWeb)).toEqual(["Shared note body"]);

    expect(run.output).not.toContain(OTHER_SECRET);
    expect(run.output).not.toMatch(TOKEN_SHAPE);
  });

  it("adds the remote as a second workspace, leaving the seeded one intact", async () => {
    const remote = await startHub(OTHER_SECRET);
    const theirs = await webDoc(remote, "Shared note", OTHER_SECRET);

    // A machine that has already been set up: `ub init` generated a workspace
    // of its own and seeded the starter documents into it. The dead endpoint
    // stands in for the local hub that is not running.
    const box = sandbox({ userConfig: { hubUrl: DEAD_HUB_URL } });
    expect((await runUbAsync(["init", "--yes"], box)).status).toBe(0);
    const mine = readConfigFile(box, "config.json").workspace as string;
    expect(mine).not.toBe(WORKSPACE);
    const seeded = await readMirror(box, mine);
    expect(seeded.size).toBeGreaterThan(0);

    const run = await runUbAsync(
      [
        "remote",
        "join",
        joinUrl(remote),
        "--secret-file",
        secretFile(box, OTHER_SECRET),
      ],
      box,
    );
    expect(run.status).toBe(0);
    expect(run.stdout).toContain("joined 1 document");
    // Switched to the joined one…
    expect(readConfigFile(box, "config.json").workspace).toBe(WORKSPACE);
    expect(runUb(["workspace"], box).stdout).toContain(WORKSPACE);
    // …and told where the other one went, because it did not go anywhere.
    expect(run.stdout).toContain(mine);
    expect(run.stdout).toContain("was not merged into this one");
    expect(run.stdout).toContain(`ub workspace use ${mine} --user`);
    // Including the hazard the machine-wide endpoint creates for it: documents
    // that only ever reached the local hub are in that hub's database, and
    // nothing dials it any more.
    expect(run.stdout).toContain("nothing points at it any more");
    expect(run.stdout).toContain(`ub remote set ${DEAD_HUB_URL}`);

    // Both are listed, and the first one still holds everything it held.
    const listed = runUb(["workspace", "list"], box);
    expect(listed.stdout).toContain(mine);
    expect(listed.stdout).toContain(WORKSPACE);
    for (const hub of hubs.splice(0)) {
      await hub.stop();
    }
    expect(await readMirror(box, mine)).toEqual(seeded);
    expect([...(await readMirror(box, WORKSPACE)).keys()]).toEqual([theirs]);
  });

  // A join inside a checkout has a third file to keep in step: the derived
  // `mise.local.toml`, which is where `mise run web` and the hub get their
  // workspace, endpoint and secret from. A binding nothing derived from would
  // leave every mise task here serving the workspace this machine just left.
  it("rewrites the checkout's derived mise config, and trusts it again", async () => {
    const remote = await startHub(OTHER_SECRET);
    await webDoc(remote, "Shared note", OTHER_SECRET);

    // A checkout as `ub init` leaves it: a derived file naming this machine's
    // own workspace, its endpoint and its generated secret.
    const box = sandbox({ checkout: true, userConfig: { hubUrl: DEAD_HUB_URL } });
    expect(
      (await runUbAsync(["init", "--yes", "--no-mcp"], box, WITHOUT_MISE)).status,
    ).toBe(0);
    const derived = join(box.cwd, "mise.local.toml");
    const mine = readConfigFile(box, "config.json").workspace as string;
    expect(readFileSync(derived, "utf8")).toContain(`WORKSPACE_ID = "${mine}"`);
    expect(readFileSync(derived, "utf8")).toContain(`HUB_URL = "${DEAD_HUB_URL}"`);

    const run = await runUbAsync(
      [
        "remote",
        "join",
        joinUrl(remote),
        "--secret-file",
        secretFile(box, OTHER_SECRET),
      ],
      box,
      WITHOUT_MISE,
    );
    expect(run.status, run.output).toBe(0);

    // All three values, because all three moved: the file is derived from the
    // authority, not patched.
    const after = readFileSync(derived, "utf8");
    expect(after).toContain(`WORKSPACE_ID = "${WORKSPACE}"`);
    expect(after).toContain(`HUB_URL = "${url(remote)}"`);
    expect(after).toContain(`HUB_AUTH_TOKEN = "${OTHER_SECRET}"`);
    expect(run.stdout).toContain("mise config");
    expect(run.stdout).toContain(derived);

    // mise binds trust to a config file's contents, so a rewrite untrusts what
    // `ub init` had trusted. With no `mise` to run, the command says what to
    // run by hand rather than leaving every task in the directory refused.
    expect(run.stderr).toContain(`mise trust ${derived}`);
  });

  // Nothing is written before the URL is understood — not the endpoint, not a
  // credential, not a workspace — and the message says what the form is,
  // because a URL missing its id is indistinguishable from a correct one.
  it.each([
    // No path at all: nothing was named, not even wrongly.
    ["ws://127.0.0.1:9999", "names no workspace"],
    // The endpoint as it was documented before this command took an id — the
    // paste most likely to happen, and `ws` is not a workspace id.
    ["ws://127.0.0.1:9999/ws", "is not a workspace id"],
    ["ws://127.0.0.1:9999/ws/not-a-workspace-id", "is not a workspace id"],
    // A truncated uuid: a real copy-paste failure, and not a prefix match here.
    ["ws://127.0.0.1:9999/ws/b7c3d914-5a20-4e6f", "is not a workspace id"],
  ])("refuses %s and writes nothing", (target, because) => {
    const box = sandbox();
    const run = runUb(["remote", "join", target], box);
    expect(run.status).toBe(2);
    expect(run.stderr).toContain(because);
    // The expected form, in the refusal itself.
    expect(run.stderr).toContain("wss://hub.example.ts.net/ws/<workspace-id>");
    expect(run.stderr).toContain("usage: ub remote join <url>/<workspace-id>");
    expect(existsSync(join(box.configHome, "uberblick", "config.json"))).toBe(false);
    expect(existsSync(join(box.configHome, "uberblick", "credentials.json"))).toBe(
      false,
    );
  });

  it("refuses a secret file other users can read", async () => {
    const box = sandbox({ userConfig: { workspace: WORKSPACE } });
    const path = join(box.cwd, "remote-secret");
    writeFileSync(path, `${OTHER_SECRET}\n`);
    chmodSync(path, 0o644);

    const run = await runUbAsync(
      ["remote", "join", `${DEAD_HUB_URL}/${WORKSPACE}`, "--secret-file", path],
      box,
    );
    expect(run.status).toBe(2);
    expect(run.stderr).toContain("lets other users read");
    expect(run.output).not.toContain(OTHER_SECRET);
  });

  it("persists nothing when the remote is unreachable", async () => {
    const box = sandbox({
      userConfig: { workspace: WORKSPACE, hubUrl: "ws://127.0.0.1:2" },
      credentials: { signingSecret: SECRET },
    });

    const run = await runUbAsync(
      ["remote", "join", `${DEAD_HUB_URL}/${WORKSPACE}`],
      box,
    );
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

    const run = await runUbAsync(["remote", "join", joinUrl(remote)], box);
    expect(run.status).toBe(1);
    expect(run.stderr).toContain("rejected the credential");
    expect(run.stderr).toContain("--secret-file");
    expect(persistedHubUrl(box)).toBe(DEAD_HUB_URL);
    expect(run.output).not.toContain(SECRET);
    expect(run.output).not.toMatch(TOKEN_SHAPE);
  });
});

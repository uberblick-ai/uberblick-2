/**
 * `ub remote` — what it says about the endpoint, and `join` end to end.
 *
 * Every join test runs a real hub on an ephemeral port with its own SQLite
 * database, and a real mirror in a throwaway XDG home. That is the whole point:
 * the properties worth defending here are about what is actually on the far side
 * and what is actually on disk when a command exits, and neither survives being
 * mocked. The remote corpus is built the way a corpus really arrives — a plain
 * `HocuspocusProvider`, which is exactly what the web client is.
 *
 * What is asserted, and nothing else: the refusal matrix, that a refusal writes
 * nothing, that the endpoint is persisted only after the far side is verified,
 * and that no secret and no token ever reaches either stream.
 */

import { randomUUID } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { HocuspocusProvider } from "@hocuspocus/provider";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { Hub } from "@uberblick/hub";
import {
  createHub,
  importRootSecret,
  MAX_TOKEN_LIFETIME_SECONDS,
  mintToken,
  silentLogger,
} from "@uberblick/hub";
import { SYNC_PROTOCOL_VERSION, wrapToken } from "@uberblick/hub/protocol";
import { createMcpServer, resolveMcpConfig } from "@uberblick/mcp-server";
import {
  appendBlock,
  directoryRoom,
  initDoc,
  roomForDoc,
  tombstoneDirectoryEntry,
  upsertDirectoryEntry,
} from "@uberblick/schema";
import * as Y from "yjs";
import { afterEach, describe, expect, it } from "vitest";
import type { Sandbox } from "./helpers.js";
import { normalizeRemoteUrl, parseJoinTarget, setRemote } from "../src/remote.js";
import {
  DEAD_HUB_URL,
  pointAt,
  removeTempDirs,
  runUbAsync,
  sandbox,
} from "./helpers.js";

const SECRET = "test-signing-secret-for-the-remote-bridge";
const OTHER_SECRET = "a-different-secret-the-remote-was-deployed-with";
const WORKSPACE = "b7c3d914-5a20-4e6f-8d13-9f04a2c68e75";

/**
 * `remote join` can spend 35 s in preflight (connect plus two sync waits),
 * 50 s moving the mirror (connect plus three sync waits), and another 35 s
 * verifying it: 120 s in capped, named waits. Ten seconds above that ceiling
 * also leaves more than twice the slowest observed 57.9 s run.
 */
const LARGE_CORPUS_JOIN_TIMEOUT_MS = 130_000;

/**
 * The slowest observed seed took roughly 25 s. This stays another ten seconds
 * above that seed plus the child deadline, so the child's named failure wins
 * before Vitest's generic timeout.
 */
const LARGE_CORPUS_TEST_TIMEOUT_MS = 165_000;

/** A JWT-ish token: base64url of `{"sub"…` always starts `eyJ`. */
const TOKEN_SHAPE = /eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/;

const hubs: Hub[] = [];

afterEach(async () => {
  for (const hub of hubs.splice(0)) {
    await hub.stop();
  }
  removeTempDirs();
});

async function startHub(
  authSecret = SECRET,
  options: { protocolVersion?: number } = {},
): Promise<Hub> {
  const hub = await createHub({
    authSecret,
    port: 0,
    ...(options.protocolVersion === undefined
      ? {}
      : { protocolVersion: options.protocolVersion }),
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
): Promise<{
  doc: Y.Doc;
  provider: HocuspocusProvider;
  done: () => Promise<void>;
}> {
  const doc = new Y.Doc();
  const provider = new HocuspocusProvider({
    url: url(hub),
    name: room,
    token: wrapToken(
      await mintToken(await importRootSecret(secret), {
        typ: "room",
        sub: "test-web-client",
        workspace: WORKSPACE,
        scope: "read-write",
        kid: null,
        lifetimeSeconds: MAX_TOKEN_LIFETIME_SECONDS,
      }),
    ),
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

/** Put a tombstone in a hub's directory without ever creating its document room. */
async function webTombstone(
  hub: Hub,
  uuid: string,
  title: string,
  secret: string = SECRET,
): Promise<void> {
  const directory = await openRoom(hub, directoryRoom(WORKSPACE), secret);
  upsertDirectoryEntry(directory.doc, { uuid, title, tags: [] });
  tombstoneDirectoryEntry(directory.doc, uuid);
  await directory.done();
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

/** Seed a large local replica without paying one MCP round trip per document. */
async function seedLocalCorpus(box: Sandbox, count: number): Promise<void> {
  const config = resolveMcpConfig({ ...box.env, WORKSPACE_ID: WORKSPACE });
  const instance = createMcpServer(config);
  const directory = new Y.Doc();
  try {
    for (let index = 0; index < count; index += 1) {
      const uuid = randomUUID();
      const title = `Small note ${index}`;
      const doc = new Y.Doc();
      initDoc(doc, { uuid, title });
      appendBlock(doc, { type: "paragraph", text: `body ${index}` });
      instance.store.appendUpdate(
        roomForDoc(WORKSPACE, uuid),
        Y.encodeStateAsUpdate(doc),
        "local",
      );
      upsertDirectoryEntry(directory, { uuid, title, tags: [] });
      doc.destroy();
    }
    instance.store.appendUpdate(
      directoryRoom(WORKSPACE),
      Y.encodeStateAsUpdate(directory),
      "local",
    );
  } finally {
    directory.destroy();
    await instance.close();
  }
}

/** Put the same directory-only archive shape in a local update log. */
async function seedLocalTombstone(
  box: Sandbox,
  uuid: string,
  title: string,
): Promise<void> {
  const config = resolveMcpConfig({ ...box.env, WORKSPACE_ID: WORKSPACE });
  const instance = createMcpServer(config);
  const directory = new Y.Doc();
  try {
    upsertDirectoryEntry(directory, { uuid, title, tags: [] });
    tombstoneDirectoryEntry(directory, uuid);
    instance.store.appendUpdate(
      directoryRoom(WORKSPACE),
      Y.encodeStateAsUpdate(directory),
      "local",
    );
  } finally {
    directory.destroy();
    await instance.close();
  }
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

  it("names the endpoint and the sharing boundary once one is configured", async () => {
    const box = sandbox({
      userConfig: { workspace: WORKSPACE, hubUrl: "wss://hub.example.ts.net" },
    });

    const run = await runUbAsync(["remote"], box);
    expect(run.status).toBe(0);
    expect(run.stdout).toContain("wss://hub.example.ts.net");
    // The boundary as it now works: the host serves the secret to the app
    // (#426), rather than the bundle carrying it. Same consequence, and it is
    // the consequence this line exists to keep on screen.
    expect(run.stdout).toContain("the host serves it to the app");
    expect(run.stdout).toContain("private network");
    // And where it came from: the user config is the only place it can be.
    expect(run.stdout).toContain("user config");
  });

  it("refuses a command it does not have", async () => {
    const run = await runUbAsync(
      ["remote", "invite", "someone@example.com"],
      sandbox(),
    );
    expect(run.status).toBe(2);
    expect(run.stderr).toContain('unknown command "invite"');
  });

  // One normalizer for `ub remote join` and `ub init` alike (#436): the host
  // `tailscale status` prints and the address a browser hands back both name
  // the deployment's endpoint, and an endpoint somebody typed in full is what
  // they meant — including a plain hub, which has no path at all.
  it.each([
    ["hub.example.ts.net", "wss://hub.example.ts.net/ws"],
    ["https://hub.example.ts.net", "wss://hub.example.ts.net/ws"],
    ["https://hub.example.ts.net/", "wss://hub.example.ts.net/ws"],
    ["http://hub.example.ts.net", "ws://hub.example.ts.net/ws"],
    ["https://hub.example.ts.net/proxy", "wss://hub.example.ts.net/proxy"],
    ["hub.example.ts.net/ws", "wss://hub.example.ts.net/ws"],
    // An invented form is rewritten, so it is folded as `URL` folds: the host's
    // case, a trailing slash and the scheme's own default port all go.
    ["Hub.Example.TS.net", "wss://hub.example.ts.net/ws"],
    ["hub.example.ts.net/", "wss://hub.example.ts.net/ws"],
    ["https://hub.example.ts.net:443", "wss://hub.example.ts.net/ws"],
    ["http://hub.example.ts.net:80/", "ws://hub.example.ts.net/ws"],
    ["wss://hub.example.ts.net/ws", "wss://hub.example.ts.net/ws"],
    ["ws://127.0.0.1:1234", "ws://127.0.0.1:1234"],
  ])("reads %s as %s", (typed, stored) => {
    expect(normalizeRemoteUrl(typed)).toBe(stored);
  });

  // An endpoint somebody typed in full comes back byte for byte. Folding the
  // host's case, dropping an explicit :443 or eating a trailing slash would each
  // rewrite a value this then stores and compares against on every later run.
  it.each([
    ["wss://Hub.Example.TS.net/ws"],
    ["wss://hub.example.ts.net:443/ws"],
    ["ws://hub.example.ts.net/"],
  ])("keeps %s exactly as it was typed", (typed) => {
    expect(normalizeRemoteUrl(typed)).toBe(typed);
  });

  // `join` gets the same acceptance from the same reader: the id is split off
  // after the URL has been understood, never by a second parser beside it — so
  // a host with nothing but the id after it still names the deployed path, and
  // a root slash the id left behind collapses into it rather than standing as
  // a path nobody typed.
  it.each([
    ["hub.example.ts.net/ws", "wss://hub.example.ts.net/ws"],
    ["https://hub.example.ts.net/ws", "wss://hub.example.ts.net/ws"],
    ["hub.example.ts.net", "wss://hub.example.ts.net/ws"],
    ["https://hub.example.ts.net", "wss://hub.example.ts.net/ws"],
    ["https://hub.example.ts.net/", "wss://hub.example.ts.net/ws"],
    // Folded, unlike the explicit spellings below: an invented form has no
    // spelling to preserve, and :443 is what wss:// dials anyway.
    ["https://Hub.Example.TS.net:443", "wss://hub.example.ts.net/ws"],
  ])("takes a join URL written as %s", (typed, endpoint) => {
    expect(parseJoinTarget(`${typed}/${WORKSPACE}`).endpoint).toBe(endpoint);
  });

  // The other half of the same rule: an endpoint typed in full is cut out of
  // the string it was typed in, so `join` stores exactly what `ub init` would.
  // Rebuilding it through `URL` would fold the case and drop the port, and the
  // two verbs would then disagree about the endpoint they had both been given.
  it.each([
    ["wss://Hub.Example.TS.net:443/ws"],
    ["ws://127.0.0.1:1234"],
    ["wss://hub.example.ts.net/proxy//ws"],
  ])("keeps the endpoint of a join URL written as %s", (endpoint) => {
    expect(parseJoinTarget(`${endpoint}/${WORKSPACE}`).endpoint).toBe(endpoint);
  });

  it("still refuses what is not an endpoint at all, and repeats none of it", () => {
    // The value that could not be read is exactly the one somebody may have
    // pasted a credential into, so no refusal quotes it back.
    const refusal = (value: string): string => {
      try {
        normalizeRemoteUrl(value);
        return "accepted";
      } catch (error) {
        return error instanceof Error ? error.message : String(error);
      }
    };
    expect(refusal("ftp://hub.example.ts.net")).toMatch(/ws:\/\/ or wss:\/\//);
    expect(refusal("not a hub")).toMatch(/is not a URL/);
    for (const pasted of [
      "wss://user:hunter2@hub.example.ts.net:notaport/ws",
      "ftp://user:hunter2@hub.example.ts.net",
    ]) {
      expect(refusal(pasted)).not.toContain("hunter2");
    }
  });

  // A credential in the URL would be persisted into two files and echoed on
  // stdout. The hub takes its secret in the connection's auth message only.
  it.each([
    ["wss://user:hunter2@hub.example.ts.net/ws", "username or password"],
    ["wss://hub.example.ts.net/ws?token=hunter2", "query string"],
    ["wss://hub.example.ts.net/ws#hunter2", "fragment"],
  ])("refuses %s", async (endpoint, because) => {
    const box = sandbox();
    const run = await runUbAsync(
      ["remote", "join", `${endpoint}/${WORKSPACE}`],
      box,
    );
    expect(run.status).toBe(2);
    expect(run.stderr).toContain(because);
    // The refusal must not echo back the credential it is refusing.
    expect(run.output).not.toContain("hunter2");
  });

  it("preserves the other fields in config.json", () => {
    const box = sandbox({
      userConfig: { workspace: WORKSPACE, displayName: "Someone", color: "#0e8085" },
    });
    setRemote("wss://hub.example.ts.net", { env: box.env });

    const config = readConfigFile(box, "config.json");
    expect(config.displayName).toBe("Someone");
    expect(config.color).toBe("#0e8085");
    expect(config.hubUrl).toBe("wss://hub.example.ts.net");
  });

  it("ignores an endpoint in the environment, in every command", async () => {
    // The layer that redirected a bound workspace at whatever a checkout
    // exported (#376). There is no such layer any more: the user config's
    // endpoint is what `ub status` reports and what a spawned server dials.
    const box = sandbox({
      userConfig: { workspace: WORKSPACE, hubUrl: DEAD_HUB_URL },
    });

    const shown = await runUbAsync(["remote"], box, {
      HUB_URL: "ws://127.0.0.1:9999",
    });
    expect(shown.status).toBe(0);
    expect(shown.stdout).toContain(DEAD_HUB_URL);
    expect(shown.stdout).not.toContain("9999");

    const status = await runUbAsync(["status", "--json"], box, {
      HUB_URL: "ws://127.0.0.1:9999",
    });
    expect(status.status).toBe(0);
    const report = JSON.parse(status.stdout);
    expect(report.hubUrl).toBe(DEAD_HUB_URL);
    expect(report.sources.hubUrl).toBe("user config");
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
      }),
    ).toThrow();
    expect(storedSecret(box)).toBe(SECRET);
  });

  it("stores the credential that reached the endpoint being written", () => {
    // The endpoint and the credential land together, and an ambient `HUB_URL`
    // is not a reason to withhold one: it is not a layer any more, so the file
    // just written *is* the endpoint in force.
    const box = sandbox({ credentials: { signingSecret: SECRET } });
    box.env.HUB_URL = "ws://127.0.0.1:9999";

    const persistence = setRemote("wss://hub.example.ts.net", {
      secret: OTHER_SECRET,
      env: box.env,
    });

    expect(storedSecret(box)).toBe(OTHER_SECRET);
    expect(persistence.replacedSecret).toBe(true);
    expect(persistence.warnings).toEqual([]);
    expect(persistedHubUrl(box)).toBe("wss://hub.example.ts.net");
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
    expect((await runUbAsync(["workspace"], box)).stdout).toContain(WORKSPACE);
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

  it("moves an archived document room and restores it from a fresh replica", async () => {
    const local = sandbox();
    const archived = await withMcp(
      local,
      { WORKSPACE_ID: WORKSPACE },
      async (call) => {
        const created = await call("create_doc", {
          title: "Archived field notes",
          description: "A bridge fixture whose hidden room must remain restorable.",
          blocks: [{ type: "paragraph", text: "Keep the hidden history." }],
        });
        const read = await call("get_doc", { uuid: created.uuid });
        await call("annotate", {
          uuid: created.uuid,
          block_id: read.blocks[0].id,
          start: 0,
          end: 4,
          text: "This annotation must travel too.",
        });
        await call("archive_doc", { uuid: created.uuid });
        return created.uuid as string;
      },
    );

    const remote = await startHub(OTHER_SECRET);
    const moved = await runUbAsync(
      [
        "remote",
        "join",
        joinUrl(remote),
        "--secret-file",
        secretFile(local, OTHER_SECRET),
      ],
      local,
    );
    expect(moved.status).toBe(0);
    expect(moved.stdout).toContain("1 archived document moved and verified");
    expect(moved.stdout).not.toContain("joined 0 documents");
    expect(moved.stdout).not.toContain("content is not moved");

    // A different sandbox has no access to the first machine's update log. Its
    // join and restore therefore read the archived room back from the hub.
    const fresh = sandbox();
    const joined = await runUbAsync(
      [
        "remote",
        "join",
        joinUrl(remote),
        "--secret-file",
        secretFile(fresh, OTHER_SECRET),
      ],
      fresh,
    );
    expect(joined.status).toBe(0);
    expect(joined.stderr).toContain("hydrating 1 document");
    expect(joined.stderr).not.toContain("hydrating 0 documents");
    expect(joined.stdout).toContain("1 archived document moved and verified");
    expect(joined.stdout).not.toContain("holds nothing yet");

    const restored = await withMcp(
      fresh,
      { WORKSPACE_ID: WORKSPACE },
      async (call) => {
        await call("restore_doc", { uuid: archived });
        return await call("get_doc", { uuid: archived });
      },
    );
    expect(restored.blocks.map((block: { text: string }) => block.text)).toEqual([
      "Keep the hidden history.",
    ]);
    expect(restored.annotations).toHaveLength(1);
    expect(restored.annotations[0].comments[0].text).toBe(
      "This annotation must travel too.",
    );
  });

  it("repairs a remote directory-only tombstone from a local archived room", async () => {
    const title = "Archive from the old hub";
    const local = sandbox();
    const archived = await withMcp(
      local,
      { WORKSPACE_ID: WORKSPACE },
      async (call) => {
        const created = await call("create_doc", {
          title,
          description: "An archived room that can repair an old remote.",
          blocks: [{ type: "paragraph", text: "Recoverable content." }],
        });
        await call("archive_doc", { uuid: created.uuid });
        return created.uuid as string;
      },
    );
    const remote = await startHub(OTHER_SECRET);
    await webTombstone(remote, archived, title, OTHER_SECRET);

    const moved = await runUbAsync(
      [
        "remote",
        "join",
        joinUrl(remote),
        "--secret-file",
        secretFile(local, OTHER_SECRET),
      ],
      local,
    );
    expect(moved.status).toBe(0);
    expect(moved.stdout).toContain("1 archived document moved and verified");

    const fresh = sandbox();
    const joined = await runUbAsync(
      [
        "remote",
        "join",
        joinUrl(remote),
        "--secret-file",
        secretFile(fresh, OTHER_SECRET),
      ],
      fresh,
    );
    expect(joined.status).toBe(0);
    const restored = await withMcp(
      fresh,
      { WORKSPACE_ID: WORKSPACE },
      async (call) => {
        await call("restore_doc", { uuid: archived });
        return await call("get_doc", { uuid: archived });
      },
    );
    expect(restored.blocks.map((block: { text: string }) => block.text)).toEqual([
      "Recoverable content.",
    ]);
  });

  it("refuses an archive whose content neither side can produce", async () => {
    const title = "Lost archive";
    const archived = randomUUID();
    const source = await startHub();
    await webDoc(source, title, SECRET, {
      uuid: archived,
      body: "Recoverable on the old endpoint.",
    });
    await webTombstone(source, archived, title);
    const local = sandbox({ credentials: { signingSecret: SECRET } });
    pointAt(local, url(source));
    await seedLocalTombstone(local, archived, title);
    const remote = await startHub(OTHER_SECRET);
    await webTombstone(remote, archived, title, OTHER_SECRET);

    const run = await runUbAsync(
      [
        "remote",
        "join",
        joinUrl(remote),
        "--secret-file",
        secretFile(local, OTHER_SECRET),
      ],
      local,
    );
    expect(run.status).toBe(1);
    expect(run.stderr).toContain(`ub remote join ${url(source)}/${WORKSPACE}`);
    expect(run.stderr).toContain("another replica that still holds the content");
    expect(run.stderr).not.toContain("Rerun to finish");
    expect(run.stdout).not.toContain("moved and verified");
    expect(readConfigFile(local, "config.json")).toEqual({ hubUrl: url(source) });
  });

  it("offers a local retry when the hub stops after preflight", async () => {
    const local = sandbox();
    const remote = await startHub(OTHER_SECRET);
    let stopping: Promise<void> | undefined;

    const run = await runUbAsync(
      [
        "remote",
        "join",
        joinUrl(remote),
        "--secret-file",
        secretFile(local, OTHER_SECRET),
      ],
      local,
      {},
      25_000,
      (stderr) => {
        if (stopping === undefined && stderr.includes("hydrating 0 documents")) {
          stopping = remote.stop();
        }
      },
    );
    if (stopping !== undefined) await stopping;

    expect(run.status).toBe(1);
    expect(run.stderr).toContain("Rerun this command on this machine");
    expect(run.stderr).not.toContain("missing content");
    expect(existsSync(join(local.configHome, "uberblick", "config.json"))).toBe(
      false,
    );
  });

  it(
    "joins 5,000 local documents and persists the verified binding",
    async () => {
      const remote = await startHub(OTHER_SECRET);
      const local = sandbox();
      await seedLocalCorpus(local, 5_000);

      const run = await runUbAsync(
        [
          "remote",
          "join",
          joinUrl(remote),
          "--secret-file",
          secretFile(local, OTHER_SECRET),
        ],
        local,
        { UB_TEST_MAX_WAIT_MS: "15000" },
        LARGE_CORPUS_JOIN_TIMEOUT_MS,
      );

      expect(run.status, run.stderr).toBe(0);
      expect(run.stdout).toContain("joined 5000 documents — directory verified");
      expect(run.stdout).toContain("one live document's content");
      expect(run.stdout).not.toContain("a fresh client read\nthem back");
      expect(persistedHubUrl(local)).toBe(url(remote));
      expect(readConfigFile(local, "config.json").workspace).toBe(WORKSPACE);
    },
    LARGE_CORPUS_TEST_TIMEOUT_MS,
  );

  it("adds the remote as a second workspace, leaving the seeded one intact", async () => {
    const remote = await startHub(OTHER_SECRET);
    const theirs = await webDoc(remote, "Shared note", OTHER_SECRET);

    // A machine that has already been set up: `ub init` generated a workspace
    // of its own and seeded the starter documents into it, locally, and was
    // pointed at an endpoint afterwards — the dead one standing in for the
    // local hub that is not running. In that order because the two halves are
    // ordered in life too: a machine bound to a hub is one `ub init` expects to
    // hold that hub's credential and to reach it (#436).
    const box = sandbox({ credentials: { signingSecret: SECRET } });
    expect((await runUbAsync(["init", "--yes"], box)).status).toBe(0);
    pointAt(box, DEAD_HUB_URL);
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
    expect((await runUbAsync(["workspace"], box)).stdout).toContain(WORKSPACE);
    // …and told where the other one went, because it did not go anywhere.
    expect(run.stdout).toContain(mine);
    expect(run.stdout).toContain("was not merged into this one");
    expect(run.stdout).toContain(`ub workspace use ${mine}`);
    expect(run.stdout).not.toContain(`ub workspace use ${mine} --user`);
    // Including the hazard the machine-wide endpoint creates for it: documents
    // that only ever reached the local hub are in that hub's database, and
    // nothing dials it any more.
    expect(run.stdout).toContain("nothing points at it any more");
    expect(run.stdout).toContain(`ub remote join ${DEAD_HUB_URL}/${mine}`);
    // And that rejoining it needs the secret this join replaced: a hub reads
    // HUB_AUTH_TOKEN from its own environment.
    expect(run.stdout).toContain("HUB_AUTH_TOKEN from its own");
    expect(run.stdout).toContain("ub open --no-browser");

    // Both are listed, and the first one still holds everything it held.
    const listed = await runUbAsync(["workspace", "list"], box);
    expect(listed.stdout).toContain(mine);
    expect(listed.stdout).toContain(WORKSPACE);
    for (const hub of hubs.splice(0)) {
      await hub.stop();
    }
    expect(await readMirror(box, mine)).toEqual(seeded);
    expect([...(await readMirror(box, WORKSPACE)).keys()]).toEqual([theirs]);
  });

  // The split is byte-for-byte: the endpoint stored is what was typed with the
  // id and its separator taken off, and nothing else tidied. An empty segment
  // is somebody's reverse proxy path — `/proxy//ws` and `/proxy/ws` may route
  // to different places, and only the person who typed it knows which.
  it.each([
    [`wss://hub.example.ts.net/ws/${WORKSPACE}`, "wss://hub.example.ts.net/ws"],
    [`wss://hub.example.ts.net/${WORKSPACE}`, "wss://hub.example.ts.net"],
    [
      `wss://hub.example.ts.net/proxy//ws/${WORKSPACE}`,
      "wss://hub.example.ts.net/proxy//ws",
    ],
    [`wss://hub.example.ts.net/ws//${WORKSPACE}`, "wss://hub.example.ts.net/ws/"],
    // The decorated spelling is an id like any other, and is kept as typed.
    [
      `wss://hub.example.ts.net/ws/notes-${WORKSPACE}`,
      "wss://hub.example.ts.net/ws",
    ],
  ])("takes the id off %s and leaves the endpoint alone", (url, endpoint) => {
    const target = parseJoinTarget(url);
    expect(target.endpoint).toBe(endpoint);
    // Lossless: the two halves put back together are the URL that was typed.
    expect(`${target.endpoint}/${target.workspace}`).toBe(url);
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
  ])("refuses %s and writes nothing", async (target, because) => {
    const box = sandbox();
    const run = await runUbAsync(["remote", "join", target], box);
    expect(run.status).toBe(2);
    expect(run.stderr).toContain(because);
    // The expected form, in the refusal itself.
    expect(run.stderr).toContain("wss://hub.example.ts.net/ws/<workspace-id>");
    expect(run.stderr).toContain("usage: ub remote join <url-with-workspace-id>");
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

  it("persists nothing when the remote speaks another sync protocol", async () => {
    // A hub from another release. `join` refuses it upstream of the only write,
    // and the wording is the point: "did not answer" would send a person to
    // check whether the deployment is running, which it is.
    const remote = await startHub(SECRET, {
      protocolVersion: SYNC_PROTOCOL_VERSION + 1,
    });
    const box = sandbox({
      userConfig: { workspace: WORKSPACE, hubUrl: DEAD_HUB_URL },
      credentials: { signingSecret: SECRET },
    });

    const run = await runUbAsync(["remote", "join", joinUrl(remote)], box);

    expect(run.status).toBe(1);
    expect(run.stderr).toContain("different sync protocol");
    expect(run.stderr).toContain("update this client");
    expect(run.stderr).toContain("Nothing was written");
    expect(run.stderr).not.toContain("did not answer");
    // A different credential cannot fix a version skew, so `join` must not
    // suggest one: that is `credentialCouldFix` answering false for the new
    // status, read here through the sentence it gates.
    expect(run.stderr).not.toContain("--secret-file");
    // Zero writes on this side; nothing on the remote either, because `join`
    // reads it as a fresh client and never got past the refusal.
    expect(persistedHubUrl(box)).toBe(DEAD_HUB_URL);
    expect(run.output).not.toContain(SECRET);
    expect(run.output).not.toMatch(TOKEN_SHAPE);
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
    // This run is exactly the probe `join` makes before it can ask for a
    // secret — no TTY here, so the prompt is skipped — and the refusal above is
    // the whole of what it is allowed to say. The probe's own reading reaching
    // stderr is what put an ERROR in front of the prompt on an interactive join
    // that then succeeded (#447).
    expect(run.stderr).not.toContain("hub rejected the token");
  });

  it("says nothing about running local-only before it would ask for a secret", async () => {
    // The other reading that reaches the prompt, and the machine `join` exists
    // for: nothing configured at all, so the pre-prompt probe has no credential
    // to send and is a disabled client. `running local-only` is that client
    // announcing itself — on a run that is about to be neither local nor only.
    const remote = await startHub(OTHER_SECRET);
    const box = sandbox();

    const run = await runUbAsync(["remote", "join", joinUrl(remote)], box);

    expect(run.stderr).not.toContain("running local-only");
    // Everything the refusal owes a person is unchanged.
    expect(run.status).toBe(1);
    expect(run.stderr).toContain("no signing secret is configured");
    expect(run.stderr).toContain("--secret-file");
    expect(run.stderr).toContain("run this from a terminal");
    expect(run.stderr).toContain("Nothing was written");
    expect(existsSync(join(box.configHome, "uberblick", "config.json"))).toBe(false);
    expect(existsSync(join(box.configHome, "uberblick", "credentials.json"))).toBe(
      false,
    );
  });
});

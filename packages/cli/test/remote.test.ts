/**
 * Workspace joining — endpoint configuration and verified joining end to end.
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

import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { createServer as createHttpServer } from "node:http";
import { createServer as createTlsServer } from "node:tls";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import net, { createConnection, createServer, type Socket } from "node:net";
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
import { writeHubLogin, removeHubLogin } from "@uberblick/hub/auth-store";
import { startDeviceSyncHub } from "@uberblick/hub/test-device-sync";
import {
  bridgeConfig,
  createMcpServer,
  inspectRemote,
  resolveMcpConfig,
} from "@uberblick/mcp-server";
import {
  appendBlock,
  directoryRoom,
  getBlocks,
  getMeta,
  initDoc,
  roomForDoc,
  tombstoneDirectoryEntry,
  upsertDirectoryEntry,
} from "@uberblick/schema";
import * as Y from "yjs";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Sandbox } from "./helpers.js";
import { normalizeRemoteUrl, parseJoinTarget, setRemote } from "../src/remote.js";
import {
  DEAD_HUB_URL,
  PACKAGE_ROOT,
  pointAt,
  removeTempDirs,
  runUbAsync,
  sandbox,
} from "./helpers.js";
import { observePreflight } from "./remote-observation.js";

const SECRET = "test-signing-secret-for-the-remote-bridge";
const OTHER_SECRET = "a-different-secret-the-remote-was-deployed-with";
const WORKSPACE = "b7c3d914-5a20-4e6f-8d13-9f04a2c68e75";

/**
 * One `workspace join` can spend 20 s reading the directory, 50 s moving the
 * mirror (connect plus three sync waits), and another 35 s verifying it: 105 s
 * in capped, named waits. Ten seconds above that ceiling keeps a child-process
 * timeout from replacing the condition the command itself can name.
 */
const LARGE_CORPUS_JOIN_ATTEMPT_TIMEOUT_MS = 115_000;

/**
 * A retryable first attempt stops before verification, after at most 70 s of
 * named waits. One such refusal plus one complete attempt and twenty seconds
 * of scheduling margin therefore fit inside this overall recovery bound.
 */
const LARGE_CORPUS_JOIN_RECOVERY_TIMEOUT_MS = 195_000;

/**
 * The slowest observed seed took roughly 25 s. This stays another ten seconds
 * above that seed plus the recovery bound, so a command or harness diagnostic
 * wins before Vitest's generic timeout.
 */
const LARGE_CORPUS_TEST_TIMEOUT_MS = 230_000;

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

/** Put a live entry in the hub's directory without creating its document room. */
async function webDirectoryOnly(
  hub: Hub,
  uuid: string,
  title: string,
  secret: string = SECRET,
): Promise<void> {
  const directory = await openRoom(hub, directoryRoom(WORKSPACE), secret);
  upsertDirectoryEntry(directory.doc, { uuid, title, tags: [] });
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
  return await withMcp(box, { WORKSPACE_ID: workspace, HUB_AUTH_TOKEN: "" }, async (call) => {
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
  const path = name === "config.json" ? join(box.cwd, ".uberblick.json") : join(box.configHome, "uberblick", name);
  return JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
}

function persistedHubUrl(box: Sandbox): unknown {
  return readConfigFile(box, "config.json").hubUrl;
}

function storedSecret(box: Sandbox): unknown {
  return readConfigFile(box, "credentials.json").signingSecret;
}

describe("workspace join configuration", () => {
  // One normalizer for `ub workspace join` and `ub init` alike (#436): the host
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
      ["workspace", "join", `${endpoint}/${WORKSPACE}`],
      box,
    );
    expect(run.status).toBe(2);
    expect(run.stderr).toContain(because);
    // The refusal must not echo back the credential it is refusing.
    expect(run.output).not.toContain("hunter2");
  });

  it("preserves the other fields in config.json", () => {
    const box = sandbox({ projectBinding: { workspaceId: WORKSPACE, hubUrl: null },
      userConfig: { workspace: WORKSPACE, displayName: "Someone", color: "#0e8085" },
    });
    setRemote("wss://hub.example.ts.net", { env: box.env, cwd: box.cwd });

    const config = JSON.parse(readFileSync(join(box.configHome, "uberblick", "config.json"), "utf8"));
    expect(config.displayName).toBe("Someone");
    expect(config.color).toBe("#0e8085");
    expect(persistedHubUrl(box)).toBe("wss://hub.example.ts.net");
  });

  it("rejects obsolete partial environment selection rather than silently ignoring it", async () => {
    const original = { workspaceId: WORKSPACE, hubUrl: DEAD_HUB_URL };
    const box = sandbox({ projectBinding: original });
    for (const command of [["workspace"], ["status", "--json"]]) {
      const run = await runUbAsync(command, box, { HUB_URL: "ws://127.0.0.1:9999" });
      expect(run.status).toBe(1);
      expect(run.stderr).toContain("Legacy WORKSPACE_ID / HUB_URL");
      expect(readConfigFile(box, "config.json")).toEqual(original);
    }
  });

  it("preserves other endpoint modes and clears only the selected endpoint's device admission", () => {
    const first = "ws://localhost:8080/one";
    const second = "ws://localhost:8081/two";
    const box = sandbox({
      projectBinding: { workspaceId: WORKSPACE, hubUrl: first },
      userConfig: { displayName: "Synthetic operator", hubUrl: first, hubAdmission: "device" },
    });
    const readPrivate = () => JSON.parse(readFileSync(join(box.configHome, "uberblick", "config.json"), "utf8"));
    // Even an already-known mode must move out of legacy selector fields before
    // those obsolete keys can be removed during project migration.
    setRemote(first, { env: box.env, cwd: box.cwd, deviceAdmission: true });
    expect(readPrivate().hubAdmissions).toEqual({ [first]: "device" });
    expect(readPrivate().hubAdmission).toBeUndefined();
    setRemote(second, { env: box.env, cwd: box.cwd, deviceAdmission: true });
    expect(readPrivate()).toEqual({ displayName: "Synthetic operator", hubUrl: first, hubAdmissions: { [first]: "device", [second]: "device" } });
    expect(readConfigFile(box, "config.json")).toEqual({ workspaceId: WORKSPACE, hubUrl: second });
    setRemote(first, { env: box.env, cwd: box.cwd });
    expect(readPrivate().hubAdmissions).toEqual({ [second]: "device" });
    expect(readPrivate().hubAdmission).toBeUndefined();
  });

  it("leaves the project binding intact when private admission persistence fails", () => {
    const original = { workspaceId: WORKSPACE, hubUrl: null };
    const box = sandbox({ projectBinding: original });
    mkdirSync(join(box.configHome, "uberblick", "config.json"), { recursive: true });
    expect(() => setRemote("ws://localhost:8080/ws", { env: box.env, cwd: box.cwd, deviceAdmission: true })).toThrow();
    expect(readConfigFile(box, "config.json")).toEqual(original);
  });

  it("preserves credentials when binding publication fails", () => {
    // Binding publication cannot modify the private credential store.
    const box = sandbox({ credentials: { signingSecret: SECRET } });
    mkdirSync(join(box.cwd, ".uberblick.json"), { recursive: true });

    expect(() =>
      setRemote("wss://hub.example.ts.net", {
        env: box.env, cwd: box.cwd, workspace: WORKSPACE,
      }),
    ).toThrow();
    expect(storedSecret(box)).toBe(SECRET);
  });

  it("preserves the loopback secret when storing a remote endpoint", () => {
    // The endpoint is the only value published; the local secret remains for
    // loopback use, and ambient HUB_URL still has no authority.
    const box = sandbox({ credentials: { signingSecret: SECRET } });
    box.env.HUB_URL = "ws://127.0.0.1:9999";

    const persistence = setRemote("wss://hub.example.ts.net", {
      env: box.env, cwd: box.cwd, workspace: WORKSPACE,
    });

    expect(storedSecret(box)).toBe(SECRET);
    expect(persistence.warnings).toEqual([]);
    expect(persistedHubUrl(box)).toBe("wss://hub.example.ts.net");
  });
});

describe("ub workspace join", () => {
  it("retains both Docker endpoints after logout and selects either with complete environment pins", async () => {
    const box = sandbox({ credentials: { signingSecret: SECRET } });
    const dirs = [join(box.cwd, "first-hub"), join(box.cwd, "second-hub")] as const;
    for (const dir of dirs) mkdirSync(dir);
    const first = await startDeviceSyncHub({ directory: dirs[0] });
    const second = await startDeviceSyncHub({ directory: dirs[1] });
    try {
      for (const hub of [first, second]) {
        hub.grant(WORKSPACE);
        await writeHubLogin(hub.origin, hub.issue({ workspaces: [WORKSPACE] }), box.env);
        const joined = await runUbAsync(["workspace", "join", `${hub.url}/ws/${WORKSPACE}`], box);
        expect(joined.status, joined.output).toBe(0);
        await removeHubLogin(hub.origin, box.env);
      }
      for (const hub of [first, second]) {
        const shown = await runUbAsync(["status", "--json"], box, { UB_WORKSPACE_ID: WORKSPACE, UB_HUB_URL: `${hub.url}/ws` });
        expect(shown.status, shown.output).toBe(0);
        expect(shown.stdout).toContain(`${hub.url}/ws`);
        expect(JSON.parse(shown.stdout).hub.status).toBe("auth-failed");
        expect(JSON.parse(shown.stdout).credentialPresent).toBe(false);
        expect(shown.stdout).toContain("ub auth login");
        expect(shown.stdout).not.toContain("configured (credentials file)");
      }
      expect(readConfigFile(box, "config.json")).toEqual({ workspaceId: WORKSPACE, hubUrl: `${second.url}/ws` });
    } finally { await first.close(); await second.close(); }
  });

  it.each([false, true])("joins a loopback deployment using its origin login and persists device admission (old local secret: %s)", async withSecret => {
    const box = sandbox({ ...(withSecret ? { credentials: { signingSecret: SECRET } } : {}) });
    const remote = await startDeviceSyncHub({ directory: box.cwd });
    try {
      remote.grant(WORKSPACE);
      const target = `${remote.url}/custom-proxy-path/${WORKSPACE}`;
      const beforeLogin = await runUbAsync(["workspace", "join", target], box);
      expect(beforeLogin.status).toBe(1);
      expect(beforeLogin.stderr).toContain(`ub auth login ${remote.origin}`);
      expect(beforeLogin.stderr).not.toContain("secret is wrong");
      expect(beforeLogin.stderr).not.toContain("HUB_AUTH_TOKEN");
      expect(beforeLogin.stderr).not.toContain("make them equal");
      expect(existsSync(join(box.configHome, "uberblick", "config.json"))).toBe(false);
      await writeHubLogin(remote.origin, remote.issue({ workspaces: [WORKSPACE] }), box.env);
      const joined = await runUbAsync(["workspace", "join", target], box);
      expect(joined.status, joined.output).toBe(0);
      expect(readConfigFile(box, "config.json")).toEqual({ hubUrl: `${remote.url}/custom-proxy-path`, workspaceId: WORKSPACE });
      const privateConfig = JSON.parse(readFileSync(join(box.configHome, "uberblick", "config.json"), "utf8"));
      expect(privateConfig.hubAdmissions).toEqual({ [`${remote.url}/custom-proxy-path`]: "device" });
      expect(privateConfig.workspace).toBeUndefined();
      expect(privateConfig.hubUrl).toBeUndefined();
      if (withSecret) expect(readConfigFile(box, "credentials.json").signingSecret).toBe(SECRET);
      await removeHubLogin(remote.origin, box.env);
      const loggedOut = await runUbAsync(["status", "--json"], box);
      expect(JSON.parse(loggedOut.stdout).hub.status).toBe("auth-failed");
      expect(JSON.parse(loggedOut.stdout).credentialPresent).toBe(false);
      expect(loggedOut.stdout).toContain("ub auth login");
      expect(loggedOut.stdout).not.toContain("configured (credentials file)");
    } finally { await remote.close(); }
  });

  /**
   * The join URL, which is the whole of what a second machine is told: the
   * endpoint with the workspace id as its last path segment.
   */
  function joinUrl(hub: Hub, workspace: string = WORKSPACE): string {
    return `${url(hub)}/${workspace}`;
  }

  /** Loopback admission still uses a local signing secret, never a join input. */
  function localJoinUrl(hub: Hub, box: Sandbox, secret: string): string {
    box.env.HUB_AUTH_TOKEN = secret;
    return joinUrl(hub);
  }

  it.each(["file", "environment"] as const)("rejoins a loopback hub from a remote binding using the retained %s secret", async (source) => {
    const hub = await startHub(SECRET);
    const fromHub = await webDoc(hub, "Hub document");
    const box = sandbox({ projectBinding: { workspaceId: WORKSPACE, hubUrl: "wss://previous.invalid/ws" },
      userConfig: { workspace: WORKSPACE, hubUrl: "wss://previous.invalid/ws" },
      credentials: { signingSecret: source === "file" ? SECRET : OTHER_SECRET, future: { retained: true } },
    });
    const mine = await withMcp(box, { WORKSPACE_ID: WORKSPACE, HUB_AUTH_TOKEN: "" }, async (call) => {
      const created = await call("create_doc", {
        title: "Unshared local document", description: "A local edit retained while changing endpoints.", blocks: [{ type: "paragraph", text: "Pending local edit" }],
      });
      return created.uuid as string;
    });
    const storeBefore = readFileSync(join(box.configHome, "uberblick", "credentials.json"));
    const joined = await runUbAsync(["workspace", "join", joinUrl(hub)], box,
      source === "environment" ? { HUB_AUTH_TOKEN: SECRET } : {});
    expect(joined.status, joined.stderr).toBe(0);
    expect(persistedHubUrl(box)).toBe(url(hub));
    expect(readFileSync(join(box.configHome, "uberblick", "credentials.json"))).toEqual(storeBefore);
    const mirror = await readMirror(box);
    expect([...mirror.keys()].sort()).toEqual([mine, fromHub].sort());
    expect(mirror.get(mine)).toEqual(["Pending local edit"]);
    expect(joined.output).not.toContain(SECRET);
    expect(joined.output).not.toContain(OTHER_SECRET);
  });

  it("binds a machine with no configuration at all to the workspace in the URL", async () => {
    const remote = await startHub(OTHER_SECRET);
    const fromWeb = await webDoc(remote, "Shared note", OTHER_SECRET);
    const other = await webDoc(remote, "Second note", OTHER_SECRET);

    // Nothing here: no `ub init`, no workspace, no endpoint, no credential —
    // the second machine as the owner decided it should work.
    const box = sandbox({ credentials: { signingSecret: OTHER_SECRET } });

    const run = await runUbAsync(
      [
        "workspace",
        "join",
        localJoinUrl(remote, box, OTHER_SECRET),
      ],
      box,
    );
    expect(run.status).toBe(0);
    expect(run.stdout).toContain("joined 2 documents");

    // The id came off the URL: the endpoint persisted is the URL without it,
    // and the workspace persisted is the one it named.
    expect(persistedHubUrl(box)).toBe(url(remote));
    expect(readConfigFile(box, "config.json").workspaceId).toBe(WORKSPACE);
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
        "workspace",
        "join",
        localJoinUrl(remote, local, OTHER_SECRET),
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
        "workspace",
        "join",
        localJoinUrl(remote, fresh, OTHER_SECRET),
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
        "workspace",
        "join",
        localJoinUrl(remote, local, OTHER_SECRET),
      ],
      local,
    );
    expect(moved.status).toBe(0);
    expect(moved.stdout).toContain("1 archived document moved and verified");

    const fresh = sandbox();
    const joined = await runUbAsync(
      [
        "workspace",
        "join",
        localJoinUrl(remote, fresh, OTHER_SECRET),
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

  it("repairs a remote directory-only live document from the local replica", async () => {
    const title = "Partial join held here";
    const local = sandbox();
    const uuid = await withMcp(
      local,
      { WORKSPACE_ID: WORKSPACE },
      async (call) => {
        const created = await call("create_doc", {
          title,
          description: "A live room held only by the joining machine.",
          blocks: [{ type: "paragraph", text: "Upload me on the rerun." }],
        });
        return created.uuid as string;
      },
    );
    const remote = await startHub(OTHER_SECRET);
    await webDirectoryOnly(remote, uuid, title, OTHER_SECRET);

    const run = await runUbAsync(
      [
        "workspace",
        "join",
        localJoinUrl(remote, local, OTHER_SECRET),
      ],
      local,
    );
    expect(run.status, run.stderr).toBe(0);
    expect(run.stdout).toContain("joined 1 document — directory verified");
    expect(persistedHubUrl(local)).toBe(url(remote));
    expect(readConfigFile(local, "config.json").workspaceId).toBe(WORKSPACE);

    const remoteCopy = await openRoom(
      remote,
      roomForDoc(WORKSPACE, uuid),
      OTHER_SECRET,
    );
    try {
      expect(getMeta(remoteCopy.doc).uuid).toBe(uuid);
      expect(getBlocks(remoteCopy.doc).map((block) => block.text)).toEqual([
        "Upload me on the rerun.",
      ]);
    } finally {
      await remoteCopy.done();
    }
  });

  it("reports a sampled live directory entry with no document room as missing", async () => {
    const title = "Missing sampled room";
    const uuid = randomUUID();
    const remote = await startHub();
    await webDirectoryOnly(remote, uuid, title);
    const local = sandbox();

    const corpus = await inspectRemote(
      bridgeConfig(
        resolveMcpConfig({ ...local.env, WORKSPACE_ID: WORKSPACE }),
        { hubUrl: url(remote), authSecret: SECRET },
      ),
      { documents: "sample" },
    );

    expect(corpus.complete).toBe(true);
    expect(corpus.unsettled).toEqual([]);
    expect(corpus.missing).toEqual([{ uuid, title }]);
    expect(corpus.entries).toEqual([]);
  });

  it("refuses a live directory entry whose content neither side can produce", async () => {
    const title = "Missing live room";
    const uuid = randomUUID();
    const remote = await startHub(OTHER_SECRET);
    await webDirectoryOnly(remote, uuid, title, OTHER_SECRET);
    const local = sandbox();

    const run = await runUbAsync(
      [
        "workspace",
        "join",
        localJoinUrl(remote, local, OTHER_SECRET),
      ],
      local,
    );
    expect(run.status).toBe(1);
    expect(run.stderr).toContain(uuid);
    expect(run.stderr).toContain(title);
    expect(run.stderr).toContain("another replica that still holds the content");
    expect(run.stdout).not.toContain("moved and verified");
    expect(existsSync(join(local.configHome, "uberblick", "config.json"))).toBe(
      false,
    );
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
    const local = sandbox({ projectBinding: { workspaceId: WORKSPACE, hubUrl: url(source) }, credentials: { signingSecret: SECRET } });
    await seedLocalTombstone(local, archived, title);
    const remote = await startHub(OTHER_SECRET);
    await webTombstone(remote, archived, title, OTHER_SECRET);

    const run = await runUbAsync(
      [
        "workspace",
        "join",
        localJoinUrl(remote, local, OTHER_SECRET),
      ],
      local,
    );
    expect(run.status).toBe(1);
    expect(run.stderr).toContain(`ub workspace join ${url(source)}/${WORKSPACE}`);
    expect(run.stderr).toContain("another replica that still holds the content");
    expect(run.stderr).not.toContain("Rerun to finish");
    expect(run.stdout).not.toContain("moved and verified");
    expect(readConfigFile(local, "config.json")).toEqual({ workspaceId: WORKSPACE, hubUrl: url(source) });
  });

  it("offers a local retry when the hub stops after preflight", async () => {
    const local = sandbox();
    const remote = await startHub(OTHER_SECRET);
    let stopping: Promise<void> | undefined;

    const run = await runUbAsync(
      [
        "workspace",
        "join",
        localJoinUrl(remote, local, OTHER_SECRET),
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
      // Loaded-host proof, 2026-09-06: this exact case passed in 16.45 s with
      // eight foreground `yes` workers (the #803 probe shape), and the cleanup
      // trap left `pgrep -c -x yes` at zero. Under a slower runner, only the
      // command's own specific local-rerun instruction earns the second try.
      const remote = await startHub(OTHER_SECRET);
      const local = sandbox();
      await seedLocalCorpus(local, 5_000);

      const args = [
        "workspace",
        "join",
        localJoinUrl(remote, local, OTHER_SECRET),
      ];
      const deadline = Date.now() + LARGE_CORPUS_JOIN_RECOVERY_TIMEOUT_MS;
      const runAttempt = async () => {
        const remaining = deadline - Date.now();
        if (remaining <= 0) {
          throw new Error(
            `timed out waiting for the 5,000-document join recovery within ${LARGE_CORPUS_JOIN_RECOVERY_TIMEOUT_MS}ms`,
          );
        }
        return await runUbAsync(
          args,
          local,
          { UB_TEST_MAX_WAIT_MS: "15000" },
          Math.min(LARGE_CORPUS_JOIN_ATTEMPT_TIMEOUT_MS, remaining),
        );
      };

      let run = await runAttempt();
      const instructedRerun =
        run.status === 1 &&
        /has not acknowledged \d+ rooms?, so this sync did not finish inside its time limit:/.test(
          run.stderr,
        ) &&
        run.stderr.includes("Rerun this command on this machine once");
      if (instructedRerun) {
        run = await runAttempt();
      }

      expect(run.status, run.stderr).toBe(0);
      expect(run.stdout).toContain("joined 5000 documents — directory verified");
      expect(run.stdout).toContain("one live document's content");
      expect(run.stdout).not.toContain("a fresh client read\nthem back");
      expect(persistedHubUrl(local)).toBe(url(remote));
      expect(readConfigFile(local, "config.json").workspaceId).toBe(WORKSPACE);
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
    const mine = readConfigFile(box, "config.json").workspaceId as string;
    expect(mine).not.toBe(WORKSPACE);
    const seeded = await readMirror(box, mine);
    expect(seeded.size).toBeGreaterThan(0);

    const run = await runUbAsync(
      [
        "workspace",
        "join",
        localJoinUrl(remote, box, OTHER_SECRET),
      ],
      box,
    );
    expect(run.status).toBe(0);
    expect(run.stdout).toContain("joined 1 document");
    // Switched to the joined one…
    expect(readConfigFile(box, "config.json").workspaceId).toBe(WORKSPACE);
    expect((await runUbAsync(["workspace"], box)).stdout).toContain(WORKSPACE);
    // …and told where the other one went, because it did not go anywhere.
    expect(run.stdout).toContain(mine);
    expect(run.stdout).toContain("was not merged into this one");
    expect(run.stdout).toContain("previous workspace and its documents remain unchanged");
    expect(run.stdout).toContain(`ub workspace use ${mine} --hub '${DEAD_HUB_URL}'`);
    const restored = await runUbAsync(["workspace", "use", mine, "--hub", DEAD_HUB_URL], box);
    expect(restored.status, restored.output).toBe(0);
    expect(readConfigFile(box, "config.json")).toEqual({ workspaceId: mine, hubUrl: DEAD_HUB_URL });
    expect(run.stdout).not.toContain("endpoint, though, is machine-wide");

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
    const run = await runUbAsync(["workspace", "join", target], box);
    expect(run.status).toBe(2);
    expect(run.stderr).toContain(because);
    // The expected form, in the refusal itself.
    expect(run.stderr).toContain("wss://hub.example.ts.net/ws/<workspace-id>");
    expect(run.stderr).toContain("usage: ub workspace join <url-with-workspace-id>");
    expect(existsSync(join(box.configHome, "uberblick", "config.json"))).toBe(false);
    expect(existsSync(join(box.configHome, "uberblick", "credentials.json"))).toBe(
      false,
    );
  });

  it("refuses a secret file other users can read", async () => {
    const box = sandbox({ projectBinding: { workspaceId: WORKSPACE, hubUrl: null }, userConfig: { workspace: WORKSPACE } });
    const path = join(box.cwd, "remote-secret");
    writeFileSync(path, `${OTHER_SECRET}\n`);
    chmodSync(path, 0o644);

    const run = await runUbAsync(
      ["workspace", "join", `${DEAD_HUB_URL}/${WORKSPACE}`, "--secret-file", path],
      box,
    );
    expect(run.status).toBe(2);
    expect(run.stderr).toContain("Unknown option");
    expect(run.output).not.toContain(OTHER_SECRET);
  });

  it("persists nothing when the remote is unreachable", async () => {
    const box = sandbox({ projectBinding: { workspaceId: WORKSPACE, hubUrl: "ws://127.0.0.1:2" },
      userConfig: { workspace: WORKSPACE, hubUrl: "ws://127.0.0.1:2" },
      credentials: { signingSecret: SECRET },
    });

    const run = await runUbAsync(
      ["workspace", "join", `${DEAD_HUB_URL}/${WORKSPACE}`],
      box,
    );
    expect(run.status).toBe(1);
    expect(run.stderr).toContain("did not answer");
    expect(run.stderr.match(/retrying once/g)).toHaveLength(1);
    expect(persistedHubUrl(box)).toBe("ws://127.0.0.1:2");
  });

  it.each([true, false])("retries a stalled initial handshake once (recovery: %s)", async (recover) => {
    const remote = await startHub();
    const sockets = new Set<Socket>();
    let connections = 0;
    const proxy = createServer((socket) => {
      sockets.add(socket);
      socket.on("error", () => {});
      socket.on("close", () => sockets.delete(socket));
      connections += 1;
      // Keep TCP open without answering the WebSocket upgrade. The client
      // must exhaust its connection budget and dispose that attempt itself.
      if (!recover || connections === 1) return;
      const upstream = createConnection({ host: "127.0.0.1", port: remote.port });
      sockets.add(upstream);
      upstream.on("error", () => socket.destroy());
      upstream.on("close", () => sockets.delete(upstream));
      socket.on("close", () => upstream.destroy());
      socket.pipe(upstream).pipe(socket);
    });
    await new Promise<void>((resolve) => proxy.listen(0, "127.0.0.1", resolve));
    try {
      const address = proxy.address();
      if (address === null || typeof address === "string") throw new Error("missing proxy port");
      const box = sandbox({ credentials: { signingSecret: SECRET } });
      const target = `ws://127.0.0.1:${address.port}`;
      const run = await runUbAsync(["workspace", "join", `${target}/${WORKSPACE}`], box);
      expect(run.stderr.match(/retrying once/g)).toHaveLength(1);
      expect(run.output).not.toContain(SECRET);
      expect(run.output).not.toMatch(TOKEN_SHAPE);
      if (recover) {
        expect(run.status, run.output).toBe(0);
        expect(persistedHubUrl(box)).toBe(target);
      } else {
        expect(run.status).toBe(1);
        // The provider has its own bounded reconnect activity inside each
        // preflight; raw socket count is not the CLI retry allowance.
        expect(run.stderr).toContain("Nothing was written");
        expect(existsSync(join(box.configHome, "uberblick", "config.json"))).toBe(false);
      }
    } finally {
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve) => proxy.close(() => resolve()));
    }
  });

  it("persists nothing when the remote speaks another sync protocol", async () => {
    // A hub from another release. `join` refuses it upstream of the only write,
    // and the wording is the point: "did not answer" would send a person to
    // check whether the deployment is running, which it is.
    const remote = await startHub(SECRET, {
      protocolVersion: SYNC_PROTOCOL_VERSION + 1,
    });
    const box = sandbox({ projectBinding: { workspaceId: WORKSPACE, hubUrl: DEAD_HUB_URL },
      userConfig: { workspace: WORKSPACE, hubUrl: DEAD_HUB_URL },
      credentials: { signingSecret: SECRET },
    });

    const run = await runUbAsync(["workspace", "join", joinUrl(remote)], box);

    expect(run.status).toBe(1);
    expect(run.stderr).toContain("different sync protocol");
    expect(run.stderr).not.toContain("retrying once");
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
    const box = sandbox({ projectBinding: { workspaceId: WORKSPACE, hubUrl: DEAD_HUB_URL },
      userConfig: { workspace: WORKSPACE, hubUrl: DEAD_HUB_URL },
      credentials: { signingSecret: SECRET },
    });

    const run = await runUbAsync(["workspace", "join", joinUrl(remote)], box);
    expect(run.status).toBe(1);
    expect(run.stderr).toContain("rejected the credential");
    expect(run.stderr).not.toContain("retrying once");
    expect(run.stderr).not.toContain("--secret-file");
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

  it("asks an unconfigured client to sign in without a local-secret diagnostic", async () => {
    const remote = await startHub(OTHER_SECRET);
    const box = sandbox();

    const run = await runUbAsync(["workspace", "join", joinUrl(remote)], box);

    expect(run.stderr).not.toContain("running local-only");
    expect(run.status).toBe(1);
    expect(run.stderr).toContain("ub auth login");
    expect(run.stderr).not.toContain("no signing secret is configured");
    expect(run.stderr).not.toContain("--secret-file");
    expect(run.stderr).not.toContain("remote signing secret (");
    expect(run.stderr).toContain("Nothing was written");
    expect(existsSync(join(box.configHome, "uberblick", "config.json"))).toBe(false);
    expect(existsSync(join(box.configHome, "uberblick", "credentials.json"))).toBe(
      false,
    );
  });
});

describe("preflight observation instrument", () => {
  const workspace = WORKSPACE;
  const secret = SECRET;
  const tokenShape = /eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/;

  function config(hubUrl: string) {
    return bridgeConfig(resolveMcpConfig({ WORKSPACE_ID: workspace, HUB_URL: hubUrl, HUB_AUTH_TOKEN: secret }));
  }

  it("measures full-budget directory preflights without local or remote state writes", async () => {
    const box = sandbox({ projectBinding: { workspaceId: workspace, hubUrl: "ws://127.0.0.1:1" },
      userConfig: { workspace, hubUrl: "ws://127.0.0.1:1" },
      credentials: { signingSecret: secret },
    });
    const hub = await createHub({ authSecret: secret, port: 0,
      databasePath: join(box.cwd, "hub.sqlite"), log: silentLogger });
    const endpoint = `ws://127.0.0.1:${hub.port}`;
    const dir = new Y.Doc();
    const provider = new HocuspocusProvider({ url: endpoint, name: directoryRoom(workspace),
      document: dir, token: wrapToken(await mintToken(await importRootSecret(secret), {
        typ: "room", sub: "seed", workspace, scope: "read-write", kid: null, lifetimeSeconds: 60,
      })) });
    try {
      await waitUntil("seed directory sync", () => provider.isSynced);
      upsertDirectoryEntry(dir, { uuid: randomUUID(), title: "private title", tags: [] });
      await waitUntil("seed directory acknowledgement", () => !provider.hasUnsyncedChanges);
      provider.destroy();
      await waitUntil("seed presence withdrawn", () => {
        const doc = hub.hocuspocus.documents.get(directoryRoom(workspace));
        return doc !== undefined && doc.awareness.getStates().size === 0;
      });
      let changes = 0;
      let presence = 0;
      const loads: string[] = [];
      hub.hocuspocus.configuration.extensions.push({
        onChange: async () => { changes += 1; },
        onAwarenessUpdate: async ({ added, updated }) => { presence += added.length + updated.length; },
        onLoadDocument: async ({ documentName }) => { loads.push(documentName); },
      });
      const userConfig = join(box.configHome, "uberblick", "config.json");
      const credentials = join(box.configHome, "uberblick", "credentials.json");
      writeFileSync(userConfig, JSON.stringify({ workspace, hubUrl: endpoint }));
      // No store is opened, even if the resolved environment names this file.
      writeFileSync(join(box.cwd, "local-store"), "local workspace sentinel");
      const files = [userConfig, credentials, join(box.cwd, "local-store")];
      const before = files.map(path => readFileSync(path));
      const run = await new Promise<{ stdout: string; stderr: string; code: number | null }>((resolve, reject) => {
        const child = spawn(process.execPath, ["--import", "tsx", "test/observe-remote-join.ts", "3"], {
          cwd: PACKAGE_ROOT, timeout: 30_000,
          env: { ...box.env, UB_WORKSPACE_ID: workspace, UB_HUB_URL: endpoint, UB_TEST_MAX_WAIT_MS: undefined, UBERBLICK_DB: files[2] },
        });
        let stdout = "";
        let stderr = "";
        child.stdout.on("data", chunk => { stdout += chunk; });
        child.stderr.on("data", chunk => { stderr += chunk; });
        child.on("error", reject);
        child.on("close", code => resolve({ stdout, stderr, code }));
      });
      expect(run.code, run.stderr).toBe(0);
      const records = run.stdout.trim().split("\n").map(line => JSON.parse(line));
      expect(records[0]).toMatchObject({ connectTimeoutMs: 5_000, syncTimeoutMs: 15_000 });
      expect(records.filter(row => row.kind === "attempt")).toHaveLength(3);
      for (const row of records.filter(row => row.kind === "attempt")) {
        expect(row).toMatchObject({ status: "connected", complete: true, stage: null, dials: 1 });
        expect(row.events.some((event: { kind: string }) => event.kind === "websocket-open")).toBe(true);
      }
      expect(records.at(-2)).toMatchObject({ bindingAndCredentialFilesUnchanged: true });
      expect(records.at(-1)).toMatchObject({ attempts: 3, successes: 3, connectionFailures: 0 });
      expect(files.map(path => readFileSync(path))).toEqual(before);
      expect(changes).toBe(0);
      expect(presence).toBe(0);
      expect(loads.every(room => room === directoryRoom(workspace))).toBe(true);
      expect(run.stdout + run.stderr).not.toContain(secret);
      expect(run.stdout + run.stderr).not.toContain("private title");
      expect(run.stdout + run.stderr).not.toMatch(tokenShape);
    } finally {
      provider.destroy();
      dir.destroy();
      await hub.stop();
    }
  });

  it("places a TCP-accepted, stalled upgrade at the upgrade stage and cleans up", async () => {
    const sockets = new Set<Socket>();
    const server = createServer(socket => {
      sockets.add(socket);
      // Consume the request without answering it, so end/close can be observed.
      socket.resume();
      socket.on("close", () => sockets.delete(socket));
      socket.on("error", () => {});
    });
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    const native = globalThis.WebSocket;
    try {
      const address = server.address();
      if (!address || typeof address === "string") throw new Error("missing port");
      const result = await observePreflight(config(`ws://127.0.0.1:${address.port}`));
      expect(result).toMatchObject({ complete: false, stage: "websocket-upgrade" });
      expect(["connecting", "hub-down"]).toContain(result.status);
      expect(result.elapsedMs).toBeGreaterThanOrEqual(5_000);
      expect(result.elapsedMs).toBeLessThan(10_000);
      expect(result.events.some(event => event.kind === "transport-connected")).toBe(true);
      expect(result.events.some(event => event.kind === "websocket-open")).toBe(false);
      expect(globalThis.WebSocket).toBe(native);
      await waitUntil("observer sockets closed", () => sockets.size === 0);
    } finally {
      for (const socket of sockets) socket.destroy();
      await new Promise<void>(resolve => server.close(() => resolve()));
    }
  });

  it("leaves a connected first dial followed by a pending reconnect unattributable", async () => {
    const sockets = new Set<Socket>();
    let requestReceived = false;
    const server = createServer(socket => {
      sockets.add(socket);
      socket.on("close", () => sockets.delete(socket));
      socket.on("error", () => {});
      socket.once("data", () => {
        requestReceived = true;
        // Drop the first real transport as soon as its upgrade request arrives,
        // leaving the entire remaining connect budget for the native retry.
        socket.destroy();
      });
    });
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("missing port");
    let pendingLookups = 0;
    // The first dial uses real TCP. Later native sockets start connecting but
    // their lookup never answers: no OS backlog sizes, filler races or blocked
    // worker can turn this pending transport into a completed one. Undici and
    // the observer still produce all diagnostics themselves.
    const nativeConnect = net.connect;
    const connect = vi.spyOn(net, "connect")
      .mockImplementationOnce(nativeConnect)
      .mockImplementation(() => {
        const socket = new net.Socket();
        socket.on("error", () => {});
        sockets.add(socket);
        socket.on("close", () => sockets.delete(socket));
        return socket.connect({ host: "pending-reconnect.invalid", port: address.port,
          lookup: () => { pendingLookups += 1; } });
      });
    try {
      const result = await observePreflight(config(`ws://127.0.0.1:${address.port}`));
      const setup = (condition: string) => `pending reconnect precondition: ${condition}; ${JSON.stringify(result)}`;
      const kinds = result.events.map(event => event.kind);
      const connected = kinds.indexOf("transport-connected");
      const upgrade = kinds.indexOf("upgrade-request-sent");
      const reconnect = kinds.indexOf("connect-start", upgrade + 1);
      expect(requestReceived, setup("first connection received its upgrade request")).toBe(true);
      expect(connected, setup("first connection completed transport")).toBeGreaterThanOrEqual(0);
      expect(upgrade, setup("first connection sent an upgrade request after transport connected")).toBeGreaterThan(connected);
      expect(reconnect, setup("a later connection started after the first upgrade request")).toBeGreaterThan(upgrade);
      expect(pendingLookups, setup("reconnect reached the held native lookup")).toBeGreaterThan(0);
      expect(kinds.slice(reconnect), setup("reconnect transport remained pending through the preflight deadline"))
        .not.toContain("transport-connected");
      expect(kinds, setup("no connect-error replaced the pending transport"))
        .not.toContain("connect-error");
      expect(kinds, setup("no WebSocket opened instead of a pending transport")).not.toContain("websocket-open");
      expect(result).toMatchObject({ complete: false, stage: "unattributable" });
      expect(result.dials).toBeGreaterThan(1);
    } finally {
      connect.mockRestore();
      for (const socket of sockets) socket.destroy();
      await new Promise<void>(resolve => server.close(() => resolve()));
    }
  });

  it.each([false, true])("records credential and protocol refusal as authentication (skew: %s)", async skew => {
    const hub = await createHub({ authSecret: skew ? secret : "different-secret", port: 0,
      ...(skew ? { protocolVersion: SYNC_PROTOCOL_VERSION + 1 } : {}),
      databasePath: join(sandbox().cwd, "hub.sqlite"), log: silentLogger });
    try {
      const result = await observePreflight(config(`ws://127.0.0.1:${hub.port}`));
      expect(result).toMatchObject({ complete: false, stage: "hub-authentication",
        status: skew ? "update-required" : "auth-failed" });
      expect(JSON.stringify(result)).not.toContain(secret);
      expect(JSON.stringify(result)).not.toMatch(tokenShape);
    } finally { await hub.stop(); }
  });

  it("retains native TCP refusal evidence and distinguishes raw dials from preflights", async () => {
    const server = createServer();
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("missing port");
    await new Promise<void>(resolve => server.close(() => resolve()));
    const result = await observePreflight(config(`ws://127.0.0.1:${address.port}`));
    expect(result).toMatchObject({ complete: false, status: "hub-down", stage: "tcp" });
    expect(result.dials).toBeGreaterThan(1);
    expect(result.events.some(event => event.code === "ECONNREFUSED" && event.stage === "tcp")).toBe(true);
  });

  it("attributes a TLS handshake refusal from its native error code", async () => {
    // No certificate/cipher shared: the peer rejects TLS before any upgrade.
    const server = createTlsServer();
    server.on("tlsClientError", () => {});
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    try {
      const address = server.address();
      if (!address || typeof address === "string") throw new Error("missing port");
      const result = await observePreflight(config(`wss://127.0.0.1:${address.port}`));
      expect(result).toMatchObject({ complete: false, stage: "tls" });
      expect(result.events.some(event => event.stage === "tls")).toBe(true);
    } finally { await new Promise<void>(resolve => server.close(() => resolve())); }
  });

  it("leaves a socket that opens without serving auth or directory unattributable", async () => {
    const hub = await createHub({ authSecret: secret, port: 0,
      databasePath: join(sandbox().cwd, "hub.sqlite"), log: silentLogger });
    let release: (() => void) | undefined;
    const pending = new Promise<void>(resolve => { release = resolve; });
    hub.hocuspocus.configuration.extensions.push({ onAuthenticate: () => pending });
    try {
      const result = await observePreflight(config(`ws://127.0.0.1:${hub.port}`));
      expect(result).toMatchObject({ complete: false, status: "connected", stage: "unattributable" });
      expect(result.elapsedMs).toBeGreaterThanOrEqual(15_000);
      expect(result.events.some(event => event.kind === "websocket-open")).toBe(true);
    } finally { release?.(); await hub.stop(); }
  });

  it("does not attribute mixed known and unknown transport failures to the known stage", async () => {
    const server = createTlsServer();
    let connections = 0;
    server.on("tlsClientError", () => {});
    server.on("connection", socket => {
      connections += 1;
      // One TLS alert followed by abrupt resets whose stage is unproven.
      if (connections > 1) socket.destroy();
    });
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    try {
      const address = server.address();
      if (!address || typeof address === "string") throw new Error("missing port");
      const result = await observePreflight(config(`wss://127.0.0.1:${address.port}`));
      expect(result).toMatchObject({ complete: false, stage: "unattributable" });
      expect(result.events.some(event => event.kind === "connect-error" && event.stage === "tls")).toBe(true);
      expect(result.events.some(event => event.kind === "connect-error" && event.stage === "unattributable")).toBe(true);
    } finally { await new Promise<void>(resolve => server.close(() => resolve())); }
  });

  it("never retains a credential or token echoed in an authentication refusal", async () => {
    const hub = await createHub({ authSecret: secret, port: 0,
      databasePath: join(sandbox().cwd, "hub.sqlite"), log: silentLogger });
    const token = await mintToken(await importRootSecret(secret), {
      typ: "room", sub: "echo", workspace, scope: "read-write", kid: null, lifetimeSeconds: 60,
    });
    hub.hocuspocus.configuration.extensions.push({ onAuthenticate: async () => {
      throw { reason: `${secret} ${token}` };
    } });
    try {
      const result = await observePreflight(config(`ws://127.0.0.1:${hub.port}`));
      expect(result).toMatchObject({ status: "auth-failed", stage: "hub-authentication" });
      const printed = JSON.stringify(result);
      expect(printed).not.toContain(secret);
      expect(printed).not.toMatch(tokenShape);
    } finally { await hub.stop(); }
  });

  it("retains a transport close code while discarding the remote close reason", async () => {
    const server = createHttpServer();
    const sockets = new Set<Socket>();
    server.on("upgrade", (request, socket) => {
      sockets.add(socket as Socket);
      socket.resume();
      socket.on("error", () => {});
      socket.on("close", () => sockets.delete(socket as Socket));
      const accept = createHash("sha1")
        .update(`${request.headers["sec-websocket-key"]}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`).digest("base64");
      socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
      const reason = Buffer.from(secret);
      // Real server close frame, code 1011, carrying hostile wire text.
      socket.end(Buffer.concat([Buffer.from([0x88, reason.length + 2, 0x03, 0xf3]), reason]));
    });
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    try {
      const address = server.address();
      if (!address || typeof address === "string") throw new Error("missing port");
      const result = await observePreflight(config(`ws://127.0.0.1:${address.port}`));
      expect(result.complete).toBe(false);
      expect(result.stage).toBe("unattributable");
      expect(result.events.some(event => event.kind === "websocket-close" &&
        event.code === 1011 && event.local === false && event.stage === "unattributable")).toBe(true);
      expect(JSON.stringify(result)).not.toContain(secret);
      expect(JSON.stringify(result)).not.toMatch(tokenShape);
    } finally {
      for (const socket of sockets) socket.destroy();
      await new Promise<void>(resolve => server.close(() => resolve()));
    }
  });
});

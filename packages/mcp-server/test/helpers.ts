/**
 * Test rig.
 *
 * Tests here talk to a real MCP server over a real transport, with a real
 * SQLite file and — where the hub is part of the story — a real hub on an
 * ephemeral port. The interesting behaviour is durability, hydration order and
 * what happens when the network is absent, so mocking any of those three would
 * test nothing.
 *
 * Temp databases and ephemeral ports keep suites independent and parallel-safe.
 */

import { randomUUID } from "node:crypto";
import type { ChildProcess } from "node:child_process";
import type { Server, Socket } from "node:net";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { HocuspocusProvider, HocuspocusProviderWebsocket } from "@hocuspocus/provider";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { JsonSchemaValidator, jsonSchemaValidator } from "@modelcontextprotocol/sdk/validation";
import { AjvJsonSchemaValidator } from "@modelcontextprotocol/sdk/validation/ajv";
import type { Hub, HubLogger, HubLogRecord } from "@uberblick/hub";
import { createHub, silentLogger } from "@uberblick/hub";
import { importRootSecret, MAX_TOKEN_LIFETIME_SECONDS, mintToken } from "@uberblick/schema/token";
import { wrapToken } from "@uberblick/schema/protocol";
import { parseRoom } from "@uberblick/schema";
import * as Y from "yjs";
import type { McpConfig } from "../src/config.js";
import { createMcpServer } from "../src/server.js";
import type { UberblickMcpServer } from "../src/server.js";
import { MirrorStore } from "../src/store.js";
import type { UpdateOrigin } from "../src/store.js";
import { HubConnection } from "../src/hub-connection.js";
import { drainWaits, waitUntil } from "./lifecycle.js";

export { drainWaits, waitUntil } from "./lifecycle.js";

export type TestCleanup = () => unknown;

/** Close dependents before their servers, preserving every failure. */
export async function cleanupTestResources(resources: {
  clients?: TestCleanup[];
  peers?: TestCleanup[];
  hubs?: TestCleanup[];
  after?: TestCleanup[];
}): Promise<void> {
  const errors: unknown[] = [];
  for (const close of [
    drainWaits,
    ...(resources.clients ?? []),
    ...(resources.peers ?? []),
    ...(resources.hubs ?? []),
    ...(resources.after ?? []),
    removeTempDirs,
  ]) {
    try { await close(); } catch (error) { errors.push(error); }
  }
  if (errors.length) throw new AggregateError(errors, "test teardown failed");
}

const childClosures = new WeakMap<ChildProcess, Promise<{ error?: Error }>>();

/** Capture completion at spawn, before an exit can precede its pipe closure. */
export function trackChild<T extends ChildProcess>(child: T): T {
  let error: Error | undefined;
  childClosures.set(child, new Promise((resolve) => {
    child.once("error", (failure) => { error = failure; });
    child.once("close", () => resolve(error ? { error } : {}));
  }));
  return child;
}

/** Kill a leftover test process and await release of its sockets and pipes. */
export async function closeChild(child: ChildProcess): Promise<void> {
  const closed = childClosures.get(child);
  if (closed === undefined) throw new Error("test child was not tracked at spawn");
  if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
  const result = await closed;
  if (result.error) throw result.error;
}

/** Own accepted sockets, including upgrades which HTTP no longer closes. */
export function trackListener(server: Server): {
  sockets: Set<Socket>;
  close(): Promise<void>;
} {
  const sockets = new Set<Socket>();
  const errors: Error[] = [];
  const closed = new Map<Socket, Promise<void>>();
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.on("error", (error: NodeJS.ErrnoException) => {
      if (error.code !== "ECONNRESET") errors.push(error);
    });
    closed.set(socket, new Promise<void>((resolve) => {
      socket.once("close", () => { sockets.delete(socket); resolve(); });
    }));
  });
  return {
    sockets,
    async close() {
      const stopped = server.listening
        ? new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))
        : Promise.resolve();
      for (const socket of sockets) socket.destroy();
      const results = await Promise.allSettled([stopped, ...closed.values()]);
      for (const result of results) if (result.status === "rejected") errors.push(result.reason);
      closed.clear();
      const failures = errors.splice(0);
      if (failures.length) throw new AggregateError(failures, `test listener failed: ${failures.map(String).join("; ")}`);
    },
  };
}

/**
 * A store whose appends can be made to fail, as a full or read-only disk would.
 *
 * The seam every "the log refused a write" test drives: real store, real code
 * path, one failure injected where the failure actually happens.
 */
export class FailingStore extends MirrorStore {
  failing = false;

  /**
   * Which rooms the failure applies to. Null — the default — is every room; a
   * predicate is how a test fails one room of a call that writes several.
   */
  failRoom: ((room: string) => boolean) | null = null;

  override appendUpdate(
    room: string,
    payload: Uint8Array,
    origin: UpdateOrigin,
  ): number {
    if (this.failing && (this.failRoom === null || this.failRoom(room))) {
      throw new Error("simulated disk failure");
    }
    return super.appendUpdate(room, payload, origin);
  }
}

/** The hub's HMAC secret in tests. Never a valid token itself. */
export const TEST_SECRET = "test-hmac-secret-for-the-mcp-server";
/** The workspace under test. A uuid, like every real workspace id. */
export const WORKSPACE = "9c1f0b4a-6d27-4e83-9b5a-1f2e3d4c5b6a";

/** The package root, so a test can spawn `src/main.ts` the way a client would. */
export const PACKAGE_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));

/**
 * How to run a package's `src/main.ts` as exactly one process, from that
 * package's directory.
 *
 * `node --import tsx`, never the `tsx` binary: tsx's CLI runs the script in a
 * grandchild process, so a `SIGKILL` to the child kills the launcher and leaves
 * the server itself running — which would quietly hollow out every test that
 * kills one.
 */
export function mainTsProcess(): { command: string; args: string[] } {
  return {
    command: process.execPath,
    args: ["--import", "tsx", join("src", "main.ts")],
  };
}

const tempDirs: string[] = [];

export function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "uberblick-mcp-"));
  tempDirs.push(dir);
  return dir;
}

/** A fresh database path. Its directory is removed by {@link removeTempDirs}. */
export function tempDatabasePath(): string {
  return join(tempDir(), "mirror.sqlite");
}

export function removeTempDirs(): void {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * How long one awaited condition gets before the wait gives up.
 *
 * Generous rather than tight, and deliberately so: these suites run real hubs,
 * real sockets and real SQLite files, and the review container runs every
 * package's suite at once on whatever cores are left. A deadline sized for a
 * quiet machine turns load into a red gate, which trains everyone to re-run —
 * and a re-run habit is how a real regression eventually walks through. What
 * has to stay sharp is the *message*, not the clock: a wait that expires still
 * names the condition it was waiting for, so a genuine hang is still reported
 * as one, just later.
 */
export const WAIT_TIMEOUT_MS = 20_000;

export interface TestConfigOptions {
  databasePath?: string;
  /** Null (the default) disables hub sync entirely: local-only. */
  authSecret?: string | null;
  hubUrl?: string;
  workspaceId?: string;
  compactAfter?: number;
  reconcileRetryMs?: number;
  cursorTtlMs?: number;
  updatedAtCoarsenessMs?: number;
  /** See {@link LIVE_HUB_SETTLE}. */
  connectTimeoutMs?: number;
  /** See {@link LIVE_HUB_SETTLE}. */
  syncTimeoutMs?: number;
}

/**
 * Settle bounds for a rig whose *first* tool call must answer from the hub.
 *
 * A tool call's settle is bounded on purpose — no tool blocks on the network —
 * and the defaults below are sized for the opposite case: a port nothing
 * answers, where the whole grace is pure waiting. That makes the connect grace
 * a race for a rig pointed at a hub that really is listening: on a loaded
 * machine it expires while the socket is still handshaking, the settle gives
 * up, and the call answers — correctly, as an offline-first server must —
 * from an empty replica. A test reads that as a lost corpus.
 *
 * So a suite that cannot wait for hydration itself, because waiting would
 * destroy what it is testing, spreads these instead. Nothing waits on them
 * when the hub answers promptly.
 */
export const LIVE_HUB_SETTLE = {
  connectTimeoutMs: 10_000,
  syncTimeoutMs: 10_000,
} as const;

/**
 * A config with test-scale timings.
 *
 * The default `hubUrl` is a port nothing listens on, and the default secret is
 * null — so a test that says nothing about the hub is testing the offline path,
 * which is the one that must always work.
 */
export function testConfig(options: TestConfigOptions = {}): McpConfig {
  return {
    workspaceId: options.workspaceId ?? WORKSPACE,
    hubUrl: options.hubUrl ?? "ws://127.0.0.1:1",
    authSecret: options.authSecret === undefined ? null : options.authSecret,
    databasePath: options.databasePath ?? tempDatabasePath(),
    sessionId: `agent-test-${randomUUID()}`,
    color: "#7b5ec7",
    // Short on purpose: the offline tests dial a port nothing listens on, where
    // the connect fails immediately and the timeout is pure waiting. A rig on a
    // hub that answers wants the opposite — see LIVE_HUB_SETTLE.
    connectTimeoutMs: options.connectTimeoutMs ?? 150,
    syncTimeoutMs: options.syncTimeoutMs ?? 2_000,
    reconnectMaxDelayMs: 250,
    cursorTtlMs: options.cursorTtlMs ?? 30_000,
    compactAfter: options.compactAfter ?? 500,
    // No cooldown by default: a suite that wants to watch a retry happen should
    // not wait out a production pause for it. Tests about the pacing itself set
    // this deliberately.
    reconcileRetryMs: options.reconcileRetryMs ?? 0,
    // The production window, on purpose: the coarseness is the contract, and a
    // suite that wants to cross it moves the clock rather than shrinking it.
    updatedAtCoarsenessMs: options.updatedAtCoarsenessMs ?? 5 * 60_000,
  };
}

export interface ToolCall {
  isError: boolean;
  // Tool payloads are JSON by contract; tests assert on their fields.
  payload: any;
}

export interface Rig {
  readonly instance: UberblickMcpServer;
  readonly client: Client;
  readonly config: McpConfig;
  /** The name this test client announced at `initialize`. */
  readonly clientName: string;
  call(name: string, args?: Record<string, unknown>): Promise<ToolCall>;
  /** Call a tool and fail the test if it returned an error. */
  ok(name: string, args?: Record<string, unknown>): Promise<any>;
  close(): Promise<void>;
}

/**
 * Output validators shared by every rig's client. `listTools` otherwise compiles
 * every output schema with Ajv, about 55 ms a rig; a compiled validator depends
 * only on its schema, so sharing it checks exactly what a fresh client would.
 */
const outputSchemaCompiler = new AjvJsonSchemaValidator();
const compiledOutputSchemas = new Map<string, JsonSchemaValidator<unknown>>();
const sharedOutputValidators: jsonSchemaValidator = {
  getValidator<T>(schema: Parameters<jsonSchemaValidator["getValidator"]>[0]) {
    const key = JSON.stringify(schema);
    let validator = compiledOutputSchemas.get(key);
    if (validator === undefined) {
      validator = outputSchemaCompiler.getValidator(schema);
      compiledOutputSchemas.set(key, validator);
    }
    return validator as JsonSchemaValidator<T>;
  },
};

/** The name the test client identifies itself with over MCP. */
export const CLIENT_NAME = "uberblick-tests";

/**
 * Start a server and an MCP client joined by an in-memory transport pair.
 *
 * `store` is injectable so a suite can drive persistence failures through the
 * real code path rather than around it, and `clientInfo` so a suite can say
 * what the client calls itself at `initialize` — which is where the awareness
 * name comes from.
 */
export async function startServer(
  config: McpConfig = testConfig(),
  store?: MirrorStore,
  clientInfo: { name: string; title?: string; version: string } = {
    name: CLIENT_NAME,
    version: "0.0.0",
  },
): Promise<Rig> {
  const instance =
    store === undefined
      ? createMcpServer(config)
      : createMcpServer(config, store);
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();

  const client = new Client(clientInfo, {
    jsonSchemaValidator: sharedOutputValidators,
  });
  await Promise.all([
    instance.connect(serverTransport),
    client.connect(clientTransport),
  ]);
  // The SDK caches advertised output validators here. Every behavior test
  // therefore checks the result contract a schema-aware client actually sees.
  await client.listTools();

  const call = async (
    name: string,
    args: Record<string, unknown> = {},
  ): Promise<ToolCall> => {
    const result = await client.callTool({ name, arguments: args });
    const content = result.content as { type: string; text?: string }[];
    const text = content[0]?.text ?? "null";
    // Tool payloads are JSON. A schema rejection never reaches the handler, so
    // the SDK answers with its own plain-text error — keep it readable, and
    // label it as the boundary class it is rather than as one of the codes a
    // handler can return. See ../src/failures.ts and ./failures.test.ts.
    try {
      return { isError: result.isError === true, payload: JSON.parse(text) };
    } catch {
      return {
        isError: result.isError === true,
        payload: { error: "schema_validation", message: text },
      };
    }
  };

  let closing: Promise<void> | undefined;
  return {
    instance,
    client,
    config,
    clientName: clientInfo.name,
    call,
    async ok(name, args) {
      const result = await call(name, args);
      if (result.isError) {
        throw new Error(
          `tool ${name} failed: ${JSON.stringify(result.payload)}`,
        );
      }
      return result.payload;
    },
    close() {
      closing ??= (async () => {
        const errors: unknown[] = [];
        try { await client.close(); } catch (error) { errors.push(error); }
        try { await instance.close(); } catch (error) { errors.push(error); }
        if (errors.length) throw new AggregateError(errors, "MCP rig close failed");
      })();
      return closing;
    },
  };
}

/**
 * Wait until a replica's directory names every one of `uuids`.
 *
 * The wait a test needs before it may read a fresh replica as if it knew the
 * corpus. A first tool call settles, and the settle waits for the hub — but
 * bounded, because no tool call may block on the network, so on a loaded
 * machine the call can legitimately answer from a directory that has not
 * arrived yet. Asserting on that answer tests the machine's spare capacity;
 * waiting for the directory itself tests hydration, and an empty listing after
 * this returns can only mean the corpus never came.
 *
 * It waits for the directory and nothing else, deliberately: which document
 * matches which query is what the caller is there to assert, and a wait that
 * already knew the answer would assert nothing. So this is not enough on its
 * own for a caller that then reads the *index* — the FTS rows are filled by
 * the settle, not by the directory, and a rig whose searches must land wants
 * {@link LIVE_HUB_SETTLE} as well.
 */
export async function waitForCorpus(
  rig: Rig,
  uuids: readonly string[],
): Promise<void> {
  const wanted = [...uuids].sort();
  await waitUntil(
    `the replica to hydrate the corpus (${wanted.join(", ")}) from the hub`,
    async () => {
      const listed = await rig.ok("list_docs", {});
      const here = new Set(
        (listed.docs as { uuid: string }[]).map((doc) => doc.uuid),
      );
      return wanted.every((uuid) => here.has(uuid));
    },
  );
}

export interface HubOptions {
  port?: number;
  databasePath?: string;
  authSecret?: string;
  /**
   * An optional observer, in addition to this instance's captured records.
   */
  log?: HubLogger;
  /** A hub from another release, for the tests about protocol skew. */
  protocolVersion?: number;
  /** A deliberately tiny pending-room ceiling for admission-bound tests. */
  maxPendingDocuments?: number;
}

export interface TestHub extends Hub {
  readonly records: readonly HubLogRecord[];
}

export async function startHub(options: HubOptions = {}): Promise<TestHub> {
  // A restarted hub owns a new collector. Late callbacks from a stopped hub
  // remain in its own evidence instead of crossing an array-clear boundary.
  const records: HubLogRecord[] = [];
  const hub = await createHub({
    authSecret: options.authSecret ?? TEST_SECRET,
    port: options.port ?? 0,
    databasePath: options.databasePath ?? tempDatabasePath(),
    log: (record) => { records.push(record); (options.log ?? silentLogger)(record); },
    ...(options.protocolVersion === undefined
      ? {}
      : { protocolVersion: options.protocolVersion }),
    ...(options.maxPendingDocuments === undefined
      ? {}
      : { maxPendingDocuments: options.maxPendingDocuments }),
    debounce: 20,
    maxDebounce: 200,
    shutdownTimeoutMs: 5_000,
  });
  return Object.assign(hub, { records });
}

export function hubUrl(port: number): string {
  return `ws://127.0.0.1:${port}`;
}

export interface PeerClient {
  readonly doc: Y.Doc;
  readonly provider: HocuspocusProvider;
  readonly synced: Promise<void>;
  destroy(): Promise<void>;
}

/**
 * A second client on a room, standing in for the web UI: a plain
 * `HocuspocusProvider` over a Y.Doc, so what it observes is what a browser
 * would observe.
 *
 * The token's workspace claim comes from the room, exactly as the web client
 * mints it (`packages/web/src/collab/rooms.ts`): the hub refuses a room outside
 * the claim, so a claim pinned to one workspace would make a peer on a second
 * workspace's room fail authentication rather than observe it.
 */
export async function peerClient(
  port: number,
  room: string,
  doc: Y.Doc = new Y.Doc(),
): Promise<PeerClient> {
  // Wrapped like every real client: the hub reads the protocol version out of
  // the auth message before it looks at the token at all.
  const token = wrapToken(
    await mintToken(await importRootSecret(TEST_SECRET), {
      typ: "room",
      sub: "test-peer",
      workspace: parseRoom(room).workspaceId,
      scope: "read-write",
      kid: null,
      lifetimeSeconds: MAX_TOKEN_LIFETIME_SECONDS,
    }),
  );
  const connection = new HubConnection(1_500);
  const provider = new HocuspocusProvider({
    websocketProvider: new HocuspocusProviderWebsocket({
      url: hubUrl(port),
      WebSocketPolyfill: connection.websocket(),
    }),
    name: room,
    token,
    document: doc,
  });
  const synced = new Promise<void>((resolve) => {
    provider.on("synced", () => resolve());
  });
  provider.attach();
  let closing: Promise<void> | undefined;
  return {
    doc,
    provider,
    synced,
    destroy() {
      closing ??= connection.close(() => {
          provider.destroy();
          provider.configuration.websocketProvider.destroy();
        });
      return closing;
    },
  };
}

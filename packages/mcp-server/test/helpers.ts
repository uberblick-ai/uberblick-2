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
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
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
import { parseRoom } from "@uberblick/schema";
import * as Y from "yjs";
import type { McpConfig } from "../src/config.js";
import { createMcpServer } from "../src/server.js";
import type { UberblickMcpServer } from "../src/server.js";
import { MirrorStore } from "../src/store.js";
import type { UpdateOrigin } from "../src/store.js";

/**
 * A store whose appends can be made to fail, as a full or read-only disk would.
 *
 * The seam every "the log refused a write" test drives: real store, real code
 * path, one failure injected where the failure actually happens.
 */
export class FailingStore extends MirrorStore {
  failing = false;

  override appendUpdate(
    room: string,
    payload: Uint8Array,
    origin: UpdateOrigin,
  ): number {
    if (this.failing) {
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

/** Wait for `predicate`, polling. Throws with `label` on timeout. */
export async function waitUntil(
  label: string,
  predicate: () => boolean | Promise<boolean>,
  timeoutMs = 10_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await predicate())) {
    if (Date.now() > deadline) {
      throw new Error(`timed out waiting for ${label}`);
    }
    await sleep(25);
  }
}

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
}

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
    // the connect fails immediately and the timeout is pure waiting.
    connectTimeoutMs: 150,
    syncTimeoutMs: 2_000,
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

/** The name the test client identifies itself with over MCP. */
export const CLIENT_NAME = "uberblick-tests";

/**
 * Start a server and an MCP client joined by an in-memory transport pair.
 *
 * `store` is injectable so a suite can drive persistence failures through the
 * real code path rather than around it.
 */
export async function startServer(
  config: McpConfig = testConfig(),
  store?: MirrorStore,
): Promise<Rig> {
  const instance =
    store === undefined
      ? createMcpServer(config)
      : createMcpServer(config, store);
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();

  const client = new Client({ name: CLIENT_NAME, version: "0.0.0" });
  await Promise.all([
    instance.connect(serverTransport),
    client.connect(clientTransport),
  ]);

  const call = async (
    name: string,
    args: Record<string, unknown> = {},
  ): Promise<ToolCall> => {
    const result = await client.callTool({ name, arguments: args });
    const content = result.content as { type: string; text?: string }[];
    const text = content[0]?.text ?? "null";
    // Tool payloads are JSON. A schema rejection never reaches the handler, so
    // the SDK answers with its own plain-text error — keep it readable.
    try {
      return { isError: result.isError === true, payload: JSON.parse(text) };
    } catch {
      return {
        isError: result.isError === true,
        payload: { error: "invalid_arguments", message: text },
      };
    }
  };

  return {
    instance,
    client,
    config,
    clientName: CLIENT_NAME,
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
    async close() {
      await client.close();
      await instance.close();
    },
  };
}

export interface HubOptions {
  port?: number;
  databasePath?: string;
  authSecret?: string;
}

export function startHub(options: HubOptions = {}): Promise<Hub> {
  return createHub({
    authSecret: options.authSecret ?? TEST_SECRET,
    port: options.port ?? 0,
    databasePath: options.databasePath ?? tempDatabasePath(),
    log: silentLogger,
    debounce: 20,
    maxDebounce: 200,
    shutdownTimeoutMs: 5_000,
  });
}

export function hubUrl(port: number): string {
  return `ws://127.0.0.1:${port}`;
}

export interface PeerClient {
  readonly doc: Y.Doc;
  readonly provider: HocuspocusProvider;
  readonly synced: Promise<void>;
  destroy(): void;
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
  const token = await mintToken(await importRootSecret(TEST_SECRET), {
    typ: "room",
    sub: "test-peer",
    workspace: parseRoom(room).workspaceId,
    scope: "read-write",
    kid: null,
    lifetimeSeconds: MAX_TOKEN_LIFETIME_SECONDS,
  });
  const provider = new HocuspocusProvider({
    url: hubUrl(port),
    name: room,
    token,
    document: doc,
  });
  const synced = new Promise<void>((resolve) => {
    provider.on("synced", () => resolve());
  });
  return {
    doc,
    provider,
    synced,
    destroy() {
      provider.destroy();
    },
  };
}

/** Integration rigs use a real MCP transport, file-backed store and optional hub. */

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
import type { MirrorStore } from "../src/store.js";
import { HubConnection } from "../src/hub-connection.js";
import { waitUntil } from "./lifecycle.js";

export { drainWaits, waitUntil } from "./lifecycle.js";

export * from "./shared.js";
import { CLIENT_NAME, TEST_SECRET, tempDatabasePath, testConfig } from "./shared.js";
import type { ToolCall } from "./shared.js";

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

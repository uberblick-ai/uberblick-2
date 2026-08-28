/**
 * Integration test rig.
 *
 * Every test here talks to a real hub over a real websocket with a real
 * `@hocuspocus/provider` client and a real SQLite file: the interesting
 * behaviour (auth handshake, convergence, restart durability) lives in the
 * protocol and the persistence layer, so mocking either would test nothing.
 *
 * Hubs bind an ephemeral port (`port: 0`) and each gets its own temp database,
 * so suites can run in parallel.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { HocuspocusProvider } from "@hocuspocus/provider";
import * as Y from "yjs";
import type { HubConfig } from "../src/config.js";
import { silentLogger } from "../src/log.js";
import type { Hub } from "../src/server.js";
import { createHub } from "../src/server.js";
import type { TokenScope } from "../src/token.js";
import { importRootSecret, MAX_TOKEN_LIFETIME_SECONDS, mintToken } from "../src/token.js";
import { SYNC_PROTOCOL_VERSION, wrapToken } from "../src/protocol.js";

/** The hub's HMAC secret in tests. Never a valid token itself. */
export const TEST_SECRET = "test-hmac-secret-for-the-hub";
/** The workspace under test. A uuid, like every real workspace id. */
export const WORKSPACE = "3f6a1c20-9d84-4b1e-8a77-2c5e9b0d4411";
/** A second workspace, for the tests that prove one token cannot open another. */
export const OTHER_WORKSPACE = "5b2d7e10-4c33-4f92-9e08-71a6d3c85220";

/** The Y.Text every test edits. */
export const TEXT_KEY = "body";

const tempDirs: string[] = [];

export function tempDatabasePath(): string {
  const dir = mkdtempSync(join(tmpdir(), "uberblick-hub-"));
  tempDirs.push(dir);
  return join(dir, "hub.sqlite");
}

/**
 * A room's persisted state, read straight out of the hub's SQLite file rather
 * than inferred from a client: durability tests have to look at the disk.
 * `null` when the room has no row yet.
 */
export function storedText(databasePath: string, room: string): string | null {
  const database = new DatabaseSync(databasePath, { readOnly: true });
  try {
    const row = database
      .prepare('SELECT data FROM "documents" WHERE name = ?')
      .get(room);
    if (!(row?.data instanceof Uint8Array)) {
      return null;
    }
    const doc = new Y.Doc();
    Y.applyUpdate(doc, row.data);
    const text = doc.getText(TEXT_KEY).toString();
    doc.destroy();
    return text;
  } finally {
    database.close();
  }
}

export function removeTempDatabases(): void {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** A room in the test workspace: `<workspaceUuid>/<docUuid>`, like the real thing. */
export function testRoom(workspace: string = WORKSPACE): string {
  return `${workspace}/${randomUUID()}`;
}

export function startHub(overrides: Partial<HubConfig> = {}): Promise<Hub> {
  return createHub({
    authSecret: TEST_SECRET,
    port: 0,
    databasePath: tempDatabasePath(),
    log: silentLogger,
    // Long enough that a store is still pending when a test flushes, so the
    // flush is what makes the data durable — the point of the restart tests.
    debounce: 5_000,
    maxDebounce: 30_000,
    shutdownTimeoutMs: 5_000,
    ...overrides,
  });
}

export async function token(
  scope: TokenScope = "read-write",
  options: {
    sub?: string;
    workspace?: string;
    secret?: string;
    lifetimeSeconds?: number;
  } = {},
): Promise<string> {
  return mintToken(await importRootSecret(options.secret ?? TEST_SECRET), {
    typ: "room",
    sub: options.sub ?? "test-client",
    workspace: options.workspace ?? WORKSPACE,
    scope,
    kid: null,
    lifetimeSeconds: options.lifetimeSeconds ?? MAX_TOKEN_LIFETIME_SECONDS,
  });
}

/**
 * Correctly sign an arbitrary payload with the hub's own secret — a token the
 * minter would refuse to produce, which is exactly what the hub's own clamp and
 * claim checks are for. `secret` is the wrong-key case.
 */
export async function forgeToken(
  claims: Record<string, unknown>,
  secret: string = TEST_SECRET,
): Promise<string> {
  const payload = Buffer.from(JSON.stringify(claims)).toString("base64url");
  const key = await importRootSecret(secret);
  const signature = Buffer.from(
    await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(payload)),
  ).toString("base64url");
  return `${payload}.${signature}`;
}

export class AuthenticationFailed extends Error {
  readonly reason: string;

  constructor(reason: string) {
    super(`authentication failed: ${reason}`);
    this.name = "AuthenticationFailed";
    this.reason = reason;
  }
}

export interface TestClient {
  readonly provider: HocuspocusProvider;
  readonly doc: Y.Doc;
  readonly text: Y.Text;
  /** Resolves on the first sync, rejects if the hub denies the connection. */
  readonly synced: Promise<void>;
  /** Resolves with the denial reason the hub sent. */
  readonly denied: Promise<string>;
  destroy(): void;
}

export interface ClientOptions {
  port: number;
  room: string;
  token: string;
  /** Reuse a document — for reconnecting a client that edited while offline. */
  doc?: Y.Doc;
  /**
   * Extra headers on the WebSocket upgrade — how a test plays the proxy that
   * sits in front of the deployed hub.
   */
  headers?: Record<string, string>;
  /**
   * The provider's dead-connection timer, 30s by default: with no message for
   * that long it closes the socket itself and reconnects. A test about what the
   * *hub* tells a client sets it out of reach, so that passing cannot mean the
   * client eventually timed itself out.
   */
  messageReconnectTimeout?: number;
  /**
   * The protocol version this client claims, or `null` to send the token bare —
   * a client from before the envelope, which is what the flag day refuses.
   *
   * Defaults to this build's, because a real client always wraps: a test that
   * hands this rig a garbage or forged *token* is asking what the hub makes of
   * the token, and it must reach the token check to find out.
   */
  protocolVersion?: number | null;
}

export function createClient(options: ClientOptions): TestClient {
  const doc = options.doc ?? new Y.Doc();
  const headers = options.headers;
  const claimed = options.protocolVersion;

  const provider = new HocuspocusProvider({
    // Loopback is a test concern: the hub itself never names an address.
    url: `ws://127.0.0.1:${options.port}`,
    name: options.room,
    token:
      claimed === null
        ? options.token
        : wrapToken(options.token, claimed ?? SYNC_PROTOCOL_VERSION),
    document: doc,
    // The provider builds its socket from this same object, so the socket's
    // options travel through it — its public type just does not say so.
    ...(options.messageReconnectTimeout === undefined
      ? {}
      : { messageReconnectTimeout: options.messageReconnectTimeout }),
    ...(headers === undefined
      ? {}
      : {
          // Node's WebSocket takes headers in its options argument; the
          // provider constructs the socket with the URL alone, so the headers
          // ride in on a subclass.
          WebSocketPolyfill: class extends WebSocket {
            constructor(url: string | URL) {
              super(url, { headers } as unknown as string[]);
            }
          },
        }),
  });

  const denied = new Promise<string>((resolve) => {
    provider.on("authenticationFailed", ({ reason }: { reason: string }) => {
      resolve(reason);
    });
  });

  const synced = new Promise<void>((resolve, reject) => {
    provider.on("synced", () => {
      resolve();
    });
    provider.on("authenticationFailed", ({ reason }: { reason: string }) => {
      reject(new AuthenticationFailed(reason));
    });
  });
  // A test that only asserts the denial must not trip an unhandled rejection.
  synced.catch(() => {});

  return {
    provider,
    doc,
    text: doc.getText(TEXT_KEY),
    synced,
    denied,
    destroy() {
      provider.destroy();
    },
  };
}

/** Wait for `predicate`, polling. Throws with `label` on timeout. */
export async function waitUntil(
  label: string,
  predicate: () => boolean,
  timeoutMs = 5_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) {
      throw new Error(`timed out waiting for ${label}`);
    }
    await sleep(20);
  }
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Wait for a document's text to equal `expected` on both sides of a sync. */
export function waitForText(
  label: string,
  text: Y.Text,
  expected: string,
  timeoutMs = 5_000,
): Promise<void> {
  return waitUntil(
    `${label} to read ${JSON.stringify(expected)} (last saw ${JSON.stringify(text.toString())})`,
    () => text.toString() === expected,
    timeoutMs,
  );
}

/**
 * Tear down clients before hubs: a live provider reconnects on close, and would
 * otherwise spend the shutdown racing the server it is being torn down with.
 */
export async function teardown(
  clients: TestClient[],
  hubs: Hub[],
): Promise<void> {
  for (const client of clients) {
    client.destroy();
  }
  for (const hub of hubs) {
    await hub.stop();
  }
}

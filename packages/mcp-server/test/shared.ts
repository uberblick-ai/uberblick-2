import { randomUUID } from "node:crypto";
import type { ChildProcess } from "node:child_process";
import type { Server, Socket } from "node:net";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { McpConfig } from "../src/config.js";
import { MirrorStore } from "../src/store.js";
import type { UpdateOrigin } from "../src/store.js";
import { tools } from "../src/tool-table.js";
import type { Tool } from "../src/tool-table.js";
import { drainWaits } from "./lifecycle.js";

export { drainWaits, waitUntil } from "./lifecycle.js";

export const PACKAGE_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));

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
    localWorkspace: options.hubUrl === undefined && options.authSecret == null,
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

/** The name used by test tool callers. */
export const CLIENT_NAME = "uberblick-tests";

/** A registered tool's table entry. */
export function toolNamed(name: string): Tool {
  const tool = tools.find((entry) => entry.name === name);
  if (tool === undefined) throw new Error(`Unknown tool: ${name}`);
  return tool;
}

/**
 * Proof 1b harness: upstream hub, "browser" providers over loopback, raw frame
 * injection, store readers, a child stand-in, and a lock holder. Throwaway.
 */

import { spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { createWriteStream, mkdirSync, mkdtempSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { performance } from "node:perf_hooks";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { HocuspocusProvider } from "@hocuspocus/provider";
import type { Hub } from "@uberblick/hub";
import {
  createHub,
  importRootSecret,
  MAX_TOKEN_LIFETIME_SECONDS,
  mintToken,
  silentLogger,
} from "@uberblick/hub";
import { wrapToken } from "@uberblick/hub/protocol";
import { getBlocks, parseRoom } from "@uberblick/schema";
import * as encoding from "lib0/encoding";
import * as Y from "yjs";
import { blockText } from "../../src/replica.js";

export const SECRET = "proof1b-hmac-secret";
export const WORKSPACE = "9c1f0b4a-6d27-4e83-9b5a-1f2e3d4c5b6a";
export const SPIKE_DIR = dirname(fileURLToPath(import.meta.url));
export const PACKAGE_ROOT = dirname(dirname(SPIKE_DIR));
export const SCRATCH =
  "/private/tmp/claude-501/-Users-ben-Projects-Uberblick-uberblick-crdt--claude-worktrees-open-issues-review-3ad97f/26d31aab-5516-4f34-bbb7-c5d8e86b57f2/scratchpad/proof1b";

mkdirSync(SCRATCH, { recursive: true });

export function tempDir(): string {
  return mkdtempSync(join(tmpdir(), "proof1b-"));
}

export const sleep = (ms: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, ms));

export async function waitUntil(
  label: string,
  predicate: () => boolean | Promise<boolean>,
  timeoutMs = 15_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await predicate())) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}`);
    await sleep(10);
  }
}

export function withTimeout<T>(work: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`timeout after ${ms}ms: ${label}`)), ms);
  });
  return Promise.race([work, timeout]).finally(() => clearTimeout(timer));
}

export function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address !== null ? address.port : 0;
      server.close(() => resolve(port));
    });
    server.on("error", reject);
  });
}

export function startHub(options: { port?: number; databasePath: string }): Promise<Hub> {
  return createHub({
    authSecret: SECRET,
    port: options.port ?? 0,
    databasePath: options.databasePath,
    log: silentLogger,
    debounce: 20,
    maxDebounce: 200,
    shutdownTimeoutMs: 5_000,
  });
}

export async function hubToken(sub: string, workspace = WORKSPACE): Promise<string> {
  return wrapToken(
    await mintToken(await importRootSecret(SECRET), {
      typ: "room",
      sub,
      workspace,
      scope: "read-write",
      kid: null,
      lifetimeSeconds: MAX_TOKEN_LIFETIME_SECONDS,
    }),
  );
}

export interface Frames {
  step1: number;
  step2: number;
  updates: number;
  awareness: number;
  acks: number;
  nacks: number;
  closes: number;
  other: number;
}

export interface Client {
  readonly name: string;
  readonly doc: Y.Doc;
  readonly provider: HocuspocusProvider;
  readonly frames: Frames;
  readonly closes: { code: number | undefined; reason: string | undefined; at: number }[];
  readonly unsyncedEvents: number[];
  /** Wait for the room to be fully synced with nothing outstanding. */
  settled(timeoutMs?: number): Promise<void>;
  destroy(): void;
}

/** A plain HocuspocusProvider over loopback — what a browser tab is. */
export function connect(options: {
  name: string;
  url: string;
  room: string;
  token: string;
  doc?: Y.Doc;
  /** Socket retry delay; the library default is 1s. */
  delayMs?: number;
  awareness?: null;
}): Client {
  const doc = options.doc ?? new Y.Doc();
  const frames: Frames = { step1: 0, step2: 0, updates: 0, awareness: 0, acks: 0, nacks: 0, closes: 0, other: 0 };
  const closes: Client["closes"] = [];
  const unsyncedEvents: number[] = [];
  const delay = options.delayMs ?? 100;
  const provider = new HocuspocusProvider({
    url: options.url,
    name: options.room,
    token: options.token,
    document: doc,
    ...(options.awareness === null ? { awareness: null } : {}),
    // The provider forwards its configuration to the socket it builds.
    delay,
    minDelay: Math.max(1, Math.floor(delay / 2)),
    maxDelay: delay * 4,
    onClose: ({ event }: { event?: { code?: number; reason?: string } }) => {
      closes.push({ code: event?.code, reason: event?.reason, at: Date.now() });
    },
    onUnsyncedChanges: ({ number }: { number: number }) => {
      unsyncedEvents.push(number);
    },
  } as ConstructorParameters<typeof HocuspocusProvider>[0]);
  provider.on("message", ({ message }: { message: { readVarString(): string; readVarUint(): number } }) => {
    message.readVarString();
    const type = message.readVarUint();
    if (type === 0) {
      const sub = message.readVarUint();
      if (sub === 0) frames.step1 += 1;
      else if (sub === 1) frames.step2 += 1;
      else if (sub === 2) frames.updates += 1;
      else frames.other += 1;
    } else if (type === 1) frames.awareness += 1;
    else if (type === 8) {
      if (message.readVarUint() === 1) frames.acks += 1;
      else frames.nacks += 1;
    } else if (type === 7) frames.closes += 1;
    else frames.other += 1;
  });
  return {
    name: options.name,
    doc,
    provider,
    frames,
    closes,
    unsyncedEvents,
    settled: (timeoutMs = 15_000) =>
      waitUntil(
        `${options.name} to sync ${options.room}`,
        () => provider.isSynced && provider.unsyncedChanges === 0,
        timeoutMs,
      ),
    destroy() {
      provider.destroy();
    },
  };
}

/** Resolve on the next SyncStatus(true) that brings the client back to 0 outstanding. */
export function nextAck(client: Client): Promise<void> {
  return new Promise((resolve) => {
    const handler = ({ number }: { number: number }) => {
      if (number === 0) {
        client.provider.off("unsyncedChanges", handler);
        resolve();
      }
    };
    client.provider.on("unsyncedChanges", handler);
  });
}

export function textOf(doc: Y.Doc, blockId: string): string {
  return blockText(doc, blockId)?.toString() ?? "";
}

/** One keystroke: append `text` to a block. One Yjs update, one frame. */
export function typeInto(doc: Y.Doc, blockId: string, text: string): void {
  const target = blockText(doc, blockId);
  if (target === null) throw new Error(`block ${blockId} missing`);
  target.insert(target.length, text);
}

/** Type one character and wait for its acknowledgement; returns the latency in ms. */
export async function typeAcked(client: Client, blockId: string, ch: string, timeoutMs = 10_000): Promise<number> {
  const t0 = performance.now();
  const ack = nextAck(client);
  typeInto(client.doc, blockId, ch);
  await withTimeout(ack, timeoutMs, `${client.name} ack for ${JSON.stringify(ch)}`);
  return performance.now() - t0;
}

export function blocksOf(doc: Y.Doc): { id: string; type: string; text: string }[] {
  return getBlocks(doc).map(({ id, type, text }) => ({ id, type, text }));
}

export function sameBlocks(a: ReturnType<typeof blocksOf>, b: ReturnType<typeof blocksOf>): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

export function duplicateIds(blocks: ReturnType<typeof blocksOf>): string[] {
  const seen = new Set<string>();
  const dupes: string[] = [];
  for (const block of blocks) {
    if (seen.has(block.id)) dupes.push(block.id);
    seen.add(block.id);
  }
  return dupes;
}

/** Send a raw y-sync update frame carrying arbitrary bytes, as a hostile or buggy tab would. */
export function sendRawUpdate(client: Client, room: string, bytes: Uint8Array): void {
  const encoder = encoding.createEncoder();
  encoding.writeVarString(encoder, room);
  encoding.writeVarUint(encoder, 0); // MessageType.Sync
  encoding.writeVarUint(encoder, 2); // messageYjsUpdate
  encoding.writeVarUint8Array(encoder, bytes);
  client.provider.configuration.websocketProvider.send(encoding.toUint8Array(encoder));
}

export interface StoreView {
  updates: number;
  local: number;
  remote: number;
  maxSeq: number;
  pending: { room: string; seq: number }[];
}

/** Read the store from an independent read-only connection. */
export function storeView(databasePath: string, room: string): StoreView {
  const db = new DatabaseSync(databasePath, { readOnly: true });
  try {
    const rows = db
      .prepare("SELECT origin, COUNT(*) AS n, MAX(seq) AS maxSeq FROM updates WHERE room = ? GROUP BY origin")
      .all(room) as { origin: string; n: number; maxSeq: number }[];
    const pending = db.prepare("SELECT room, seq FROM pending_rooms ORDER BY room").all() as { room: string; seq: number }[];
    const local = rows.find((r) => r.origin === "local")?.n ?? 0;
    const remote = rows.find((r) => r.origin === "remote")?.n ?? 0;
    return {
      updates: local + remote,
      local,
      remote,
      maxSeq: Math.max(0, ...rows.map((r) => r.maxSeq ?? 0)),
      pending,
    };
  } finally {
    db.close();
  }
}

/** Hydrate a room exactly as `Replicas.poll` does, from a fresh read-only connection. */
export function hydrateFromStore(databasePath: string, room: string): Y.Doc {
  const db = new DatabaseSync(databasePath, { readOnly: true });
  try {
    const doc = new Y.Doc();
    const snapshot = db.prepare("SELECT state, through_seq FROM snapshots WHERE room = ?").get(room) as
      | { state: Uint8Array; through_seq: number }
      | undefined;
    let from = 0;
    if (snapshot !== undefined) {
      Y.applyUpdate(doc, snapshot.state);
      from = snapshot.through_seq;
    }
    const rows = db.prepare("SELECT payload FROM updates WHERE room = ? AND seq > ? ORDER BY seq").all(room, from) as {
      payload: Uint8Array;
    }[];
    for (const row of rows) Y.applyUpdate(doc, row.payload);
    return doc;
  } finally {
    db.close();
  }
}

export function hubDoc(hub: Hub, room: string): Y.Doc | undefined {
  return hub.hocuspocus.documents.get(room);
}

export function roomUuid(room: string): string {
  return parseRoom(room).uuid;
}

export interface ChildStandin {
  child: ChildProcess;
  port: number;
  pid: number;
  kill(): void;
  stop(): Promise<void>;
  exited: Promise<number | null>;
}

/** The stand-in as its own process (one process, so SIGKILL kills the server). */
export async function spawnStandin(options: {
  port: number;
  databasePath: string;
  hubUrl: string;
  logPath: string;
}): Promise<ChildStandin> {
  const child = spawn(
    process.execPath,
    ["--no-warnings", "--import", "tsx", join(SPIKE_DIR, "open-standin.ts")],
    {
      cwd: PACKAGE_ROOT,
      env: {
        ...process.env,
        PROOF1B_CHILD: "1",
        PROOF1B_WORKSPACE: WORKSPACE,
        PROOF1B_DB: options.databasePath,
        PROOF1B_HUB_URL: options.hubUrl,
        PROOF1B_SECRET: SECRET,
        PROOF1B_PORT: String(options.port),
      },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  const log = createWriteStream(options.logPath, { flags: "a" });
  child.stderr?.pipe(log);
  const exited = new Promise<number | null>((resolve) => child.once("exit", (code) => resolve(code)));
  const ready = new Promise<{ port: number; pid: number }>((resolve, reject) => {
    let buffer = "";
    child.stdout?.on("data", (chunk: Buffer) => {
      buffer += chunk.toString();
      const line = buffer.split("\n").find((l) => l.includes("\"ready\":true"));
      if (line !== undefined) resolve(JSON.parse(line));
    });
    child.once("exit", (code) => reject(new Error(`stand-in exited before ready (${code})`)));
  });
  const info = await withTimeout(ready, 30_000, "stand-in ready");
  return {
    child,
    port: info.port,
    pid: info.pid,
    kill() {
      child.kill("SIGKILL");
    },
    async stop() {
      child.kill("SIGTERM");
      await withTimeout(exited, 10_000, "stand-in stop").catch(() => child.kill("SIGKILL"));
    },
    exited,
  };
}

/** Hold the store's write lock from another process for `ms`. */
export function holdLock(databasePath: string, ms: number): { acquired: Promise<void>; released: Promise<void> } {
  const child = spawn(process.execPath, [join(SPIKE_DIR, "lock-holder.mjs"), databasePath, String(ms)], {
    stdio: ["ignore", "pipe", "inherit"],
  });
  let acquire!: () => void;
  let release!: () => void;
  const acquired = new Promise<void>((resolve) => {
    acquire = resolve;
  });
  const released = new Promise<void>((resolve) => {
    release = resolve;
  });
  child.stdout?.on("data", (chunk: Buffer) => {
    const text = chunk.toString();
    if (text.includes("locked")) acquire();
    if (text.includes("released")) release();
  });
  child.once("exit", () => release());
  return { acquired, released };
}

export function percentile(values: number[], p: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[index] ?? 0;
}

export function summarize(values: number[]): { n: number; p50: number; p95: number; max: number; mean: number } {
  const round = (v: number) => Math.round(v * 1000) / 1000;
  return {
    n: values.length,
    p50: round(percentile(values, 50)),
    p95: round(percentile(values, 95)),
    max: round(Math.max(0, ...values)),
    mean: round(values.reduce((a, b) => a + b, 0) / Math.max(1, values.length)),
  };
}

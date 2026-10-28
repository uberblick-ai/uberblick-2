import { createHash } from "node:crypto";
import { statSync } from "node:fs";
import { isMainThread, parentPort, Worker, workerData } from "node:worker_threads";
import * as Y from "yjs";
import { snapshotRevision, type RevisionEntry } from "@uberblick/schema";
import {
  HistoryCache,
  type CachedHistoryCatalog,
  type HistoryCacheResult,
  type HistoryCacheFileIdentity,
  type HistoryCacheStamp,
  type HistoryCacheToken,
} from "./history-cache.js";
import type { HistoryRetention } from "./local-settings.js";

type CatalogInput = Omit<CachedHistoryCatalog, "catalog">;
type Command =
  | { operation: "open"; stamp: HistoryCacheStamp }
  | { operation: "listPages" | "resume" }
  | { operation: "readCatalog" | "markRefreshFailed"; uuid: string }
  | { operation: "readSnapshot" | "hold"; uuid: string; revision: string }
  | { operation: "releaseHold"; hold: number }
  | { operation: "putCatalog"; uuid: string; input: CatalogInput }
  | { operation: "evict"; uuid: string; retention: HistoryRetention; now: number }
  | { operation: "hasSnapshot"; uuid: string; revision: string; checksum: string }
  | { operation: "newestDownloadedRevision"; uuid: string; revisions: readonly RevisionEntry[] }
  | { operation: "putVerifiedSnapshot"; uuid: string; revision: string; checksum: string; state: Uint8Array };
type Request = Command & { id: number };
type Reply = { id: number; result: HistoryCacheResult<unknown> } | { ready: true };
interface CacheWorkerData {
  uberblickHistoryCache: true;
  moduleUrl: string;
  sourceLoader: string | null;
  path: string;
  workspace: string;
  env: NodeJS.ProcessEnv;
  identity: HistoryCacheFileIdentity | null;
}

const REQUEST_TIMEOUT_MS = 30_000;
const STARTUP_TIMEOUT_MS = 15_000;

function verifiedSnapshot(cache: HistoryCache, token: HistoryCacheToken,
  command: Extract<Command, { operation: "putVerifiedSnapshot" }>): HistoryCacheResult<boolean> {
  const document = new Y.Doc();
  try {
    Y.applyUpdate(document, command.state);
    const checksum = createHash("sha256").update(snapshotRevision(document).checksum).digest("hex");
    if (checksum !== command.checksum) return { status: "ready", value: false };
    const stored = cache.putSnapshot(token, command.uuid, command.revision, checksum, command.state);
    return stored.status === "ready" ? { status: "ready", value: true } : stored;
  } catch {
    return { status: "ready", value: false };
  } finally {
    document.destroy();
  }
}

async function serveCacheWorker(data: CacheWorkerData): Promise<void> {
  const port = parentPort;
  if (port === null) throw new Error("History cache worker requires a parent port.");
  const cache = new HistoryCache(data.path, data.workspace, data.env, data.identity);
  let token: HistoryCacheToken | null = null;
  let nextHold = 0;
  const holds = new Map<number, { release(): void }>();
  const execute = (command: Command): HistoryCacheResult<unknown> => {
    if (command.operation === "releaseHold") {
      holds.get(command.hold)?.release();
      holds.delete(command.hold);
      return { status: "ready", value: undefined };
    }
    if (command.operation === "open") {
      const opened = cache.open(command.stamp);
      token = opened.status === "ready" ? opened.value : null;
      return opened;
    }
    if (command.operation === "resume") {
      const resumed = cache.resume();
      token = resumed.status === "ready" ? resumed.value : null;
      return resumed;
    }
    if (token === null) return { status: "unavailable" };
    switch (command.operation) {
      case "readCatalog": return cache.readCatalog(token, command.uuid);
      case "readSnapshot": return cache.readSnapshot(token, command.uuid, command.revision);
      case "hold": {
        const held = cache.hold(token, command.uuid, command.revision);
        if (held.status !== "ready") return held;
        const id = nextHold++;
        holds.set(id, held.value);
        return { status: "ready", value: id };
      }
      case "listPages": return cache.listPages(token);
      case "markRefreshFailed": return cache.markRefreshFailed(token, command.uuid);
      case "putCatalog": return cache.putCatalog(token, command.uuid, command.input);
      case "evict": return cache.evict(token, command.uuid, command.retention, command.now);
      case "hasSnapshot": return cache.hasSnapshot(token, command.uuid, command.revision, command.checksum);
      case "newestDownloadedRevision": return cache.newestDownloadedRevision(token, command.uuid, command.revisions);
      case "putVerifiedSnapshot": return verifiedSnapshot(cache, token, command);
    }
  };
  try {
    await new Promise<void>(resolve => {
      port.on("message", (command: Request) => {
        let result: HistoryCacheResult<unknown>;
        try { result = execute(command); }
        catch { result = { status: "unavailable" }; }
        port.postMessage({ id: command.id, result } satisfies Reply);
      });
      port.once("close", resolve);
      port.postMessage({ ready: true } satisfies Reply);
    });
  } finally {
    for (const hold of holds.values()) hold.release();
    holds.clear();
    cache.close();
    port.close();
  }
}

// A bundled worker imports the enclosing executable, so stop before its entry runs.
if (!isMainThread && workerData?.uberblickHistoryCache === true) {
  await serveCacheWorker(workerData as CacheWorkerData);
  process.exit(0);
}

/** Keep cache contention, chunk writes and canonical snapshot decoding off live sync. */
export class HistoryMirrorCache {
  private readonly worker: Worker;
  private readonly started: Promise<boolean>;
  private readonly pending = new Map<number, {
    resolve(result: HistoryCacheResult<unknown>): void;
    timer: NodeJS.Timeout;
  }>();
  private nextId = 0;
  private stopped = false;
  private closing: Promise<void> | null = null;
  private termination: Promise<number> | null = null;

  constructor(path: string, workspace: string, env: NodeJS.ProcessEnv = process.env) {
    let identity: HistoryCacheFileIdentity | null = null;
    try {
      const current = statSync(path);
      identity = { dev: current.dev, ino: current.ino };
    } catch {
      // Storage missing at construction must not bind a later workspace copy.
    }
    const data: CacheWorkerData = {
      uberblickHistoryCache: true,
      moduleUrl: import.meta.url,
      sourceLoader: import.meta.url.endsWith(".ts") ? import.meta.resolve("tsx/esm/api") : null,
      path, workspace, env, identity,
    };
    this.worker = new Worker(`(async () => {
      const { workerData } = await import("node:worker_threads");
      if (workerData.sourceLoader !== null) {
        const { register } = await import(workerData.sourceLoader);
        register({ tsconfig: false });
      }
      await import(workerData.moduleUrl);
    })().catch(error => { throw error; });`, {
      eval: true, workerData: data, execArgv: ["--no-experimental-webstorage"],
    });
    this.started = new Promise(resolve => {
      const timer = setTimeout(() => {
        resolve(false);
        this.stop();
      }, STARTUP_TIMEOUT_MS);
      timer.unref();
      const finishStartup = (ready: boolean) => {
        clearTimeout(timer);
        resolve(ready);
      };
      this.worker.on("message", (reply: Reply) => {
        if ("ready" in reply) { finishStartup(true); return; }
        const pending = this.pending.get(reply.id);
        if (pending === undefined) return;
        this.pending.delete(reply.id);
        clearTimeout(pending.timer);
        pending.resolve(reply.result);
      });
      this.worker.once("error", () => { finishStartup(false); this.stop(); });
      this.worker.once("exit", () => { finishStartup(false); this.stop(); });
    });
    this.worker.unref();
  }

  private stop(): void {
    if (this.stopped) return;
    this.stopped = true;
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.resolve({ status: "unavailable" });
    }
    this.pending.clear();
    this.termination = this.worker.terminate();
  }

  private async request<T>(command: Command): Promise<HistoryCacheResult<T>> {
    if (this.closing !== null) return { status: "unavailable" };
    if (this.stopped || !(await this.started)) return { status: "unavailable" };
    if (this.stopped) return { status: "unavailable" };
    return new Promise<HistoryCacheResult<T>>(resolve => {
      const id = this.nextId++;
      const timer = setTimeout(() => this.stop(), REQUEST_TIMEOUT_MS);
      timer.unref();
      this.pending.set(id, { resolve: result => resolve(result as HistoryCacheResult<T>), timer });
      try { this.worker.postMessage({ ...command, id } satisfies Request); }
      catch { this.stop(); }
    });
  }

  open(stamp: HistoryCacheStamp): Promise<HistoryCacheResult<HistoryCacheToken>> {
    return this.request({ operation: "open", stamp });
  }

  resume(): Promise<HistoryCacheResult<HistoryCacheToken | null>> {
    return this.request({ operation: "resume" });
  }

  readCatalog(uuid: string): Promise<HistoryCacheResult<CachedHistoryCatalog | null>> {
    return this.request({ operation: "readCatalog", uuid });
  }

  readSnapshot(uuid: string, revision: string): Promise<HistoryCacheResult<{ state: Uint8Array; checksum: string } | null>> {
    return this.request({ operation: "readSnapshot", uuid, revision });
  }

  async hold(uuid: string, revision: string): Promise<HistoryCacheResult<{ release(): Promise<void> }>> {
    const held = await this.request<number>({ operation: "hold", uuid, revision });
    if (held.status !== "ready") return held;
    let released = false;
    return { status: "ready", value: { release: async () => {
      if (released) return;
      released = true;
      await this.request({ operation: "releaseHold", hold: held.value });
    } } };
  }

  listPages(): Promise<HistoryCacheResult<string[]>> {
    return this.request({ operation: "listPages" });
  }

  putCatalog(uuid: string, input: CatalogInput): Promise<HistoryCacheResult<void>> {
    return this.request({ operation: "putCatalog", uuid, input });
  }

  markRefreshFailed(uuid: string): Promise<HistoryCacheResult<void>> {
    return this.request({ operation: "markRefreshFailed", uuid });
  }

  evict(uuid: string, retention: HistoryRetention, now: number): Promise<HistoryCacheResult<void>> {
    return this.request({ operation: "evict", uuid, retention, now });
  }

  hasSnapshot(uuid: string, revision: string, checksum: string): Promise<HistoryCacheResult<boolean>> {
    return this.request({ operation: "hasSnapshot", uuid, revision, checksum });
  }

  newestDownloadedRevision(uuid: string, revisions: readonly RevisionEntry[]): Promise<HistoryCacheResult<string | null>> {
    return this.request({ operation: "newestDownloadedRevision", uuid, revisions });
  }

  putVerifiedSnapshot(uuid: string, revision: string, checksum: string, state: Uint8Array): Promise<HistoryCacheResult<boolean>> {
    return this.request({ operation: "putVerifiedSnapshot", uuid, revision, checksum, state });
  }

  close(): Promise<void> {
    this.closing ??= (async () => {
      this.stop();
      await this.termination;
    })();
    return this.closing;
  }
}

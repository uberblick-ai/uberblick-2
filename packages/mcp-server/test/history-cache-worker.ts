import { DatabaseSync } from "node:sqlite";
import type { RevisionEntry } from "@uberblick/schema";
import { HistoryCache, type HistoryCacheResult } from "../src/history-cache.js";

const [mode, path, workspace, configDirectory] = process.argv.slice(2) as [string, string, string, string];
const HUB = "wss://history.example.test/ws";
const PAGE = "1840680a-c086-44bd-b54a-b4be9adc7d84";
const CHECKSUM = "a".repeat(64);
const env = { XDG_CONFIG_HOME: configDirectory, XDG_DATA_HOME: configDirectory, HOME: configDirectory };
const deadline = setTimeout(() => process.exit(1), 60_000);
let cache: HistoryCache | undefined;
let lock: DatabaseSync | undefined;

function ready<T>(result: HistoryCacheResult<T>): T {
  if (result.status !== "ready") throw new Error(`history cache returned ${result.status}`);
  return result.value;
}

function finish(message: object): void {
  cache?.close();
  lock?.close();
  clearTimeout(deadline);
  process.send?.(message, () => process.disconnect?.());
}

function revisions(): RevisionEntry[] {
  return Array.from({ length: 4 }, (_, index) => ({
    id: `revision-${index}`, author: null, startedAt: 1, endedAt: 2, final: true, checksum: CHECKSUM,
  }));
}

if (mode === "lock") {
  lock = new DatabaseSync(path);
  lock.exec("BEGIN IMMEDIATE");
  process.on("message", (message: { type: string }) => {
    if (message.type === "release") {
      lock!.exec("COMMIT");
      finish({ type: "done" });
    }
  });
  process.send?.({ type: "ready" });
} else {
  cache = new HistoryCache(path, workspace, env);
  const token = ready(cache.open({ hub: HUB, workspace, account: "123" }));
  if (mode === "hold") {
    ready(cache.hold(token, PAGE, "revision-2"));
    process.send?.({ type: "ready" });
    process.on("message", (message: { type: string }) => {
      if (message.type === "close") finish({ type: "done" });
    });
  } else if (mode === "exercise") {
    const state = new Uint8Array(4 * 1024 * 1024).fill(71);
    const pages = [PAGE, "20526151-0db8-4132-8d0f-1220069e5482", "76a1c93c-2616-46fc-9671-e275dc64c710", "de7cbcae-008c-4921-8334-82dca17e742a"];
    for (const page of pages) {
      ready(cache.putCatalog(token, page, { revisions: revisions(), version: "version", refreshedAt: 1, complete: true, failed: false }));
    }
    ready(cache.putSnapshot(token, pages[1]!, "revision-0", CHECKSUM, new Uint8Array([1])));
    ready(cache.putSnapshot(token, pages[1]!, "revision-2", CHECKSUM, state));
    ready(cache.putSnapshot(token, pages[2]!, "revision-0", CHECKSUM, state));
    ready(cache.putSnapshot(token, pages[3]!, "revision-0", CHECKSUM, state));
    process.send?.({ type: "ready" });
    process.on("message", (message: { type: string }) => {
      if (message.type !== "start") return;
      try {
        const operations = [
          ["put", () => ready(cache!.putSnapshot(token, PAGE, "revision-0", CHECKSUM, state))],
          ["evict", () => ready(cache!.evict(token, pages[1]!, { mode: "named" }, Date.now()))],
          ["purge", () => ready(cache!.purgeDoc(pages[2]!))],
          ["reset", () => {
            const database = new DatabaseSync(path);
            database.exec("PRAGMA busy_timeout = 5000");
            database.exec("UPDATE history_cache SET account = 'previous-account'");
            database.close();
            ready(cache!.open({ hub: HUB, workspace, account: "123" }));
          }],
        ] as const;
        for (const [name, action] of operations) {
          const started = Date.now();
          action();
          process.send?.({ type: "operation", name, started, ended: Date.now() });
        }
        finish({ type: "done" });
      } catch (error) {
        finish({ type: "failed", error: String(error) });
      }
    });
  } else throw new Error(`Unknown worker mode ${mode}`);
}

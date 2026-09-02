/**
 * Scale probe — one *real* full replica in its own process.
 *
 * `MirrorStore` + `Replicas` from `packages/mcp-server/src`, on a fresh temp
 * SQLite file, pointed at the probe hub: the same engine an `ub mcp serve`
 * process runs. It answers three questions the synthetic load clients cannot:
 * how long a brand-new machine takes to hydrate the whole corpus while everyone
 * else is attached, what one such process costs in RSS, and how long an edit
 * takes to cross from one identity's process to another's.
 *
 * Forked with IPC. Messages in: hydrate, stats, edit, watch, stop.
 */

import { randomUUID } from "node:crypto";
import { getBlocks } from "@uberblick/schema";
import type { McpConfig } from "../../src/config.js";
import { Replicas } from "../../src/replica.js";
import { MirrorStore } from "../../src/store.js";
import { corpusUuids, SECRET, WORKSPACE } from "./common.js";

const databasePath = process.argv[2] ?? ":memory:";
const hubUrl = process.argv[3] ?? "";
const documentCount = Number(process.argv[4] ?? 0);
const role = process.argv[5] ?? "probe";

const uuids = corpusUuids(documentCount);

const config: McpConfig = {
  workspaceId: WORKSPACE,
  hubUrl,
  authSecret: process.env.PROBE_SECRET ?? SECRET,
  databasePath,
  sessionId: `${role}-${randomUUID()}`,
  color: "#7b5ec7",
  connectTimeoutMs: 10_000,
  syncTimeoutMs: 5_000,
  reconnectMaxDelayMs: 4_000,
  cursorTtlMs: 30_000,
  compactAfter: 500,
  reconcileRetryMs: 0,
  updatedAtCoarsenessMs: 5 * 60_000,
};

const store = new MirrorStore(databasePath, WORKSPACE);
const replicas = new Replicas(config, store);

/** How many corpus documents are attached and carry content. */
function hydratedCount(): number {
  let count = 0;
  for (const uuid of uuids) {
    if (!replicas.known(uuid)) continue;
    const replica = replicas
      .attachedReplicas()
      .find((candidate) => candidate.id === uuid);
    if (replica === undefined) continue;
    if (getBlocks(replica.doc).length > 0) count += 1;
  }
  return count;
}

/** Cheaper variant used inside the hydration loop. */
function hydratedCountFast(): number {
  let count = 0;
  for (const replica of replicas.attachedReplicas()) {
    if (replica.isDirectory || replica.isSidebar || replica.isFeedback) continue;
    if (getBlocks(replica.doc).length > 0) count += 1;
  }
  return count;
}

async function hydrate(timeoutMs: number): Promise<Record<string, unknown>> {
  const started = Date.now();
  let directoryAtMs: number | null = null;
  let lastCount = -1;
  for (;;) {
    await replicas.settle({ requireHealthy: false });
    const attached = replicas.attachedReplicas().length;
    if (directoryAtMs === null && attached > 3) {
      directoryAtMs = Date.now() - started;
    }
    const count = hydratedCountFast();
    if (count !== lastCount) {
      lastCount = count;
      process.send?.({ type: "progress", hydrated: count, elapsedMs: Date.now() - started });
    }
    if (count >= documentCount) {
      return {
        ok: true,
        hydratedMs: Date.now() - started,
        directoryMs: directoryAtMs,
        hydrated: count,
      };
    }
    if (Date.now() - started > timeoutMs) {
      return {
        ok: false,
        hydratedMs: Date.now() - started,
        directoryMs: directoryAtMs,
        hydrated: count,
      };
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

/** The block seeded as the propagation slot. */
function markerBlock(uuid: string): { doc: import("yjs").Doc; id: string; text: string } | null {
  const replica = replicas
    .attachedReplicas()
    .find((candidate) => candidate.id === uuid);
  if (replica === undefined) return null;
  const blocks = getBlocks(replica.doc);
  const block = blocks.find((candidate) => candidate.text.startsWith("PROBE-MARKER"));
  if (block === undefined) return null;
  return { doc: replica.doc, id: block.id, text: block.text };
}

const watchers = new Map<string, () => void>();

process.on("message", (message: Record<string, unknown>) => {
  const type = message.type as string;
  if (type === "hydrate") {
    void hydrate(message.timeoutMs as number).then((result) =>
      process.send?.({ type: "hydrated", ...result }),
    );
    return;
  }
  if (type === "settle") {
    void replicas.settle({ requireHealthy: false }).then(() =>
      process.send?.({ type: "settled", hydrated: hydratedCountFast() }),
    );
    return;
  }
  if (type === "stats") {
    const memory = process.memoryUsage();
    process.send?.({
      type: "stats",
      rssMb: memory.rss / 1e6,
      heapUsedMb: memory.heapUsed / 1e6,
      attached: replicas.attachedReplicas().length,
      hydrated: hydratedCount(),
      hubStatus: replicas.sync.state.status,
    });
    return;
  }
  if (type === "watch") {
    // Arm an observer on one document; report the moment a marker lands.
    const uuid = message.uuid as string;
    const marker = markerBlock(uuid);
    if (marker === null) {
      process.send?.({ type: "watching", ok: false, uuid });
      return;
    }
    watchers.get(uuid)?.();
    const listener = (): void => {
      const now = Date.now();
      const current = markerBlock(uuid);
      if (current !== null && current.text.includes("::")) {
        process.send?.({
          type: "observed",
          uuid,
          text: current.text,
          atMs: now,
        });
      }
    };
    marker.doc.on("update", listener);
    watchers.set(uuid, () => marker.doc.off("update", listener));
    process.send?.({ type: "watching", ok: true, uuid });
    return;
  }
  if (type === "edit") {
    const uuid = message.uuid as string;
    const marker = markerBlock(uuid);
    if (marker === null) {
      process.send?.({ type: "edited", ok: false, uuid });
      return;
    }
    void import("@uberblick/schema").then(({ editBlock }) => {
      const next = `PROBE-MARKER::${message.stamp as string}`;
      editBlock(marker.doc, marker.id, marker.text, next);
      process.send?.({ type: "edited", ok: true, uuid, atMs: Date.now() });
    });
    return;
  }
  if (type === "stop") {
    replicas.destroy();
    process.send?.({ type: "stopped" });
    setTimeout(() => process.exit(0), 50);
  }
});

process.send?.({ type: "ready", pid: process.pid });

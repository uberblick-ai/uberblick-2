import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, expect, it, vi } from "vitest";
import { GuidanceBriefing } from "../src/briefing.js";
import type { McpConfig } from "../src/config.js";
import { operations } from "../src/operations.js";
import { outputSchemas } from "../src/outputs.js";
import { Replicas } from "../src/replica.js";
import { MirrorStore } from "../src/store.js";
import { ServerWork } from "../src/server-work.js";
import type { UpdateOrigin } from "../src/store.js";
import { createToolContext } from "../src/tools/context.js";
import { createDocOperation } from "../src/tools/create-doc.js";
import { getDocOperation } from "../src/tools/get-doc.js";
import type { OperationRequest } from "../src/tools/operation.js";
import { setMetadataOperation } from "../src/tools/set-metadata.js";

const workspaceId = "9c1f0b4a-6d27-4e83-9b5a-1f2e3d4c5b6a";
const request: OperationRequest = { signal: new AbortController().signal };
const close: (() => Promise<void>)[] = [];

/** A real log seam, without constructing or importing an MCP server. */
class FailingOperationStore extends MirrorStore {
  failRoom: ((room: string) => boolean) | null = null;

  override appendUpdate(room: string, payload: Uint8Array, origin: UpdateOrigin): number {
    if (this.failRoom?.(room)) throw new Error("simulated operation log failure");
    return super.appendUpdate(room, payload, origin);
  }
}

function local(databasePath?: string) {
  const directory = databasePath === undefined ? mkdtempSync(join(tmpdir(), "uberblick-operation-")) : null;
  const config: McpConfig = {
    workspaceId,
    databasePath: databasePath ?? join(directory as string, "mirror.sqlite"),
    hubUrl: "ws://127.0.0.1:1",
    authSecret: null,
    sessionId: `operation-test-${randomUUID()}`,
    color: "#7b5ec7",
    connectTimeoutMs: 150,
    syncTimeoutMs: 2_000,
    reconnectMaxDelayMs: 250,
    cursorTtlMs: 30_000,
    compactAfter: 500,
    reconcileRetryMs: 0,
    updatedAtCoarsenessMs: 5 * 60_000,
  };
  const store = new FailingOperationStore(config.databasePath, workspaceId);
  const replicas = new Replicas(config, store);
  const context = createToolContext(replicas, new GuidanceBriefing(replicas), new ServerWork());
  close.push(async () => {
    replicas.destroy();
    await replicas.sync.waitForDeviceWork();
    store.close();
    if (directory !== null) rmSync(directory, { recursive: true, force: true });
  });
  return { config, store, replicas, context };
}

interface FixtureDoc {
  uuid: string;
  blocks: { id: string; rev: string; text: string }[];
}

async function document(context: ReturnType<typeof createToolContext>, title = "Operation fixture") {
  return await createDocOperation(context, {
    title,
    description: "A transport-free operation fixture.",
    blocks: [{ type: "paragraph", text: "first paragraph" }],
  }, request) as unknown as FixtureDoc;
}

afterEach(async () => {
  vi.restoreAllMocks();
  for (const cleanup of close.splice(0).reverse()) await cleanup();
});

it("exposes every tool operation and settles foreign durable updates before direct reads", async () => {
  expect(Object.keys(operations).sort()).toEqual(Object.keys(outputSchemas).sort());
  const writer = local();
  const reader = local(writer.config.databasePath);
  const created = await document(writer.context);
  const renamed = await setMetadataOperation(writer.context, { uuid: created.uuid, title: "Written elsewhere" }, request);
  expect(renamed).toMatchObject({ applied: true, synced: false, hub: { status: "disabled" } });
  expect(await getDocOperation(reader.context, { uuid: created.uuid }, request)).toMatchObject({ title: "Written elsewhere" });
});

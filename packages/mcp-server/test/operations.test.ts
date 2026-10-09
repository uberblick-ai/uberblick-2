import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createTagCatalogEntry, getMeta, setTags, tombstoneDirectoryEntry, upsertDirectoryEntry } from "@uberblick/schema";
import { afterEach, expect, it, vi } from "vitest";
import { GuidanceBriefing } from "../src/briefing.js";
import type { McpConfig } from "../src/config.js";
import { toFailure } from "../src/failures.js";
import { operations } from "../src/operations.js";
import { outputSchemas } from "../src/outputs.js";
import { PersistenceError, Replicas } from "../src/replica.js";
import { pinDocOperation, unpinDocOperation } from "../src/sidebar-tools.js";
import { MirrorStore } from "../src/store.js";
import { ServerWork } from "../src/server-work.js";
import type { UpdateOrigin } from "../src/store.js";
import { guarded } from "../src/tool-adapter.js";
import { createToolContext } from "../src/tools/context.js";
import { createDocOperation } from "../src/tools/create-doc.js";
import { editBlockOperation } from "../src/tools/edit-block.js";
import { getDocOperation } from "../src/tools/get-doc.js";
import type { OperationRequest } from "../src/tools/operation.js";
import { setMetadataOperation } from "../src/tools/set-metadata.js";
import { syncStatusOperation } from "../src/tools/sync-status.js";

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

async function refused(tool: string, answer: Promise<object>) {
  try {
    await answer;
  } catch (error) {
    return toFailure(tool, error);
  }
  throw new Error(`Expected ${tool} to refuse`);
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

it("keeps settle, briefing, archive and hydration refusals in that order for direct writes", async () => {
  const rig = local();
  const guide = await document(rig.context, "Read before writing");
  const archived = randomUUID();
  upsertDirectoryEntry(rig.replicas.directory().doc, { uuid: archived, title: "Unhydrated archived fixture", tags: [] });
  tombstoneDirectoryEntry(rig.replicas.directory().doc, archived);
  const marker = randomUUID();
  createTagCatalogEntry(rig.replicas.settings().doc, "guidance", marker);
  setTags(rig.replicas.replica(guide.uuid).doc, [marker]);
  const args = { uuid: archived, title: "Refused title" };
  const settleFailure = new Error("settle refuses before briefing");
  vi.spyOn(rig.replicas, "settle").mockRejectedValueOnce(settleFailure);
  await expect(setMetadataOperation(rig.context, args, request)).rejects.toBe(settleFailure);
  expect(await refused("set_metadata", setMetadataOperation(rig.context, args, request))).toMatchObject({
    isError: true, payload: { error: "guidance_required", applied: false, partial: false, synced: false },
  });
  const pinned = await pinDocOperation(rig.context, { uuid: archived, group: "Archived" }, request);
  expect(pinned).toMatchObject({ applied: true, groups: [{ docs: [{ uuid: archived, status: "archived" }] }] });
  expect(await unpinDocOperation(rig.context, { uuid: randomUUID() }, request)).toMatchObject({ unpinned: false, applied: true });
  await getDocOperation(rig.context, { uuid: guide.uuid }, request);
  expect(await refused("set_metadata", setMetadataOperation(rig.context, args, request))).toMatchObject({
    isError: true, payload: { error: "doc_archived", uuid: archived },
  });
});

it("retains decided-content locks without locking editable metadata", async () => {
  const rig = local();
  const decided = await createDocOperation(rig.context, {
    title: "Decided operation fixture", description: "A decided-record refusal fixture.",
    kind: "decision", status: "decided", blocks: [{ type: "paragraph", text: "Approved content" }],
  }, request) as unknown as FixtureDoc;
  const block = decided.blocks[0];
  if (block === undefined) throw new Error("Missing decision fixture block");
  const writes = [
    ["edit_block", () => operations.edit_block(rig.context, { uuid: decided.uuid, block_id: block.id, old_text: block.text, new_text: "Changed", rev: block.rev }, request)],
    ["insert_block", () => operations.insert_block(rig.context, { uuid: decided.uuid, type: "paragraph", text: "Changed" }, request)],
    ["delete_block", () => operations.delete_block(rig.context, { uuid: decided.uuid, block_id: block.id }, request)],
    ["link_range", () => operations.link_range(rig.context, { uuid: decided.uuid, block_id: block.id, start: 0, end: 1, doc_id: decided.uuid, rev: block.rev }, request)],
    ["set_metadata", () => operations.set_metadata(rig.context, { uuid: decided.uuid, title: "Changed" }, request)],
    ["set_metadata", () => operations.set_metadata(rig.context, { uuid: decided.uuid, tldr: "Changed" }, request)],
    ["update_data", () => operations.update_data(rig.context, { uuid: decided.uuid, operations: [] }, request)],
  ] as const;
  const size = rig.store.logSize();
  for (const [tool, write] of writes) {
    expect(await refused(tool, write()), tool).toMatchObject({
      isError: true, payload: { error: "decision_read_only", applied: false, partial: false, synced: false },
    });
    expect(rig.store.logSize(), tool).toBe(size);
  }
  expect(await setMetadataOperation(rig.context, { uuid: decided.uuid, description: "Editable metadata" }, request)).toMatchObject({ applied: true });
  expect(getMeta(rig.replicas.replica(decided.uuid).doc).description).toBe("Editable metadata");
});

it("assembles ordinary and content durability on the operation path", async () => {
  const rig = local();
  const created = await document(rig.context);
  const block = created.blocks[0];
  if (block === undefined) throw new Error("Missing fixture block");
  const metadata = await setMetadataOperation(rig.context, { uuid: created.uuid, title: "Renamed" }, request);
  expect(metadata).toMatchObject({ applied: true, synced: false, hub: { status: "disabled" } });
  expect(metadata).not.toHaveProperty("tldrHint");
  const content = await editBlockOperation(rig.context, {
    uuid: created.uuid, block_id: block.id, old_text: block.text, new_text: "Changed content", rev: block.rev,
  }, request);
  expect(content).toMatchObject({ applied: true, synced: false, tldr: null, tldrHint: expect.any(String) });
});

it("maps a direct failed append neutrally while sync_status still answers diagnostics", async () => {
  const rig = local();
  const created = await document(rig.context);
  rig.store.failRoom = room => room.endsWith(`/${created.uuid}`);
  expect(await refused("set_metadata", setMetadataOperation(rig.context, { uuid: created.uuid, title: "Not durable" }, request))).toMatchObject({
    isError: true, payload: { error: "persistence_failed", applied: false, partial: false, synced: false, room: `${workspaceId}/${created.uuid}` },
  });
  await expect(getDocOperation(rig.context, { uuid: created.uuid }, request)).rejects.toBeInstanceOf(PersistenceError);
  expect(await syncStatusOperation(rig.context, {}, request)).toMatchObject({ persistence: { room: `${workspaceId}/${created.uuid}` } });
});

it("preserves the durable stages of a direct create failure", async () => {
  const rig = local();
  rig.store.failRoom = room => room.endsWith("/_directory");
  expect(await refused("create_doc", createDocOperation(rig.context, {
    title: "Partial operation fixture", description: "A staged direct failure fixture.",
  }, request))).toMatchObject({
    isError: true,
    payload: {
      error: "persistence_failed", applied: false, partial: true, synced: false, rolledBack: false,
      completed: [{ purpose: "document", applied: true }], failed: { purpose: "directory" },
    },
  });
});

it.each(["progress-token", 0])("forwards the signal, metadata and %s token through the MCP adapter", async progressToken => {
  const rig = local();
  const signal = new AbortController().signal;
  const _meta = { progressToken, customField: { retained: true } };
  const payload = { workspace: workspaceId, groups: [], hub: rig.replicas.sync.state() };
  const operation = vi.fn(async (_context, _args: Record<string, never>, forwarded: OperationRequest) => {
    expect(forwarded.signal).toBe(signal);
    expect(forwarded._meta).toBe(_meta);
    expect(forwarded.progressToken).toBe(progressToken);
    return payload;
  });
  const answer = await guarded("get_sidebar", rig.context, operation)({}, { signal, _meta });
  expect(operation).toHaveBeenCalledWith(rig.context, {}, { signal, _meta, progressToken });
  expect(answer.structuredContent).toEqual(payload);
  expect(answer.content).toEqual([{ type: "text", text: JSON.stringify(payload, null, 2) }]);
});

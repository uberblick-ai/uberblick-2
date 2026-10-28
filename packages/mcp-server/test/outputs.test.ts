import { randomUUID } from "node:crypto";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { appendBlock, CALLOUT_VARIANTS } from "@uberblick/schema";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import * as Y from "yjs";
import * as revisionClient from "../src/revision-client.js";
import { INTERNAL_ERROR_MESSAGE } from "../src/failures.js";
import { guarded } from "../src/tool-adapter.js";
import { ServerWork } from "../src/server-work.js";
import type { ToolContext } from "../src/tools/context.js";
import { outputSchemas } from "../src/outputs.js";
import { removeTempDirs, startServer, toolNamed } from "./helpers.js";

const close: (() => Promise<void>)[] = [];
const hub = { status: "disabled", url: null, protocolVersion: 1 };
const history = { complete: true, lastRefresh: "2026-10-28T00:00:00.000Z",
  refreshFailed: false, offline: true, newestDownloadedRevision: null };

function textPayload(result: CallToolResult): any {
  expect(result.content).toHaveLength(1);
  const block = result.content[0];
  if (block?.type !== "text") throw new Error("Expected the JSON text block");
  return JSON.parse(block.text);
}

/** Inject a handler result through the real server and schema-aware SDK client. */
async function probe(
  tool: keyof typeof outputSchemas,
  answer: Record<string, unknown> | (() => CallToolResult),
) {
  const server = new McpServer({ name: "output-contract-probe", version: "0.0.0" });
  server.registerTool(tool, {
    inputSchema: z.object({}).strict(),
    outputSchema: outputSchemas[tool],
  }, guarded({
    ...toolNamed(tool),
    operation: async () => typeof answer === "function" ? answer() : answer,
  }, { work: new ServerWork() } as ToolContext));
  const client = new Client({ name: "output-contract-client", version: "0.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  close.push(async () => {
    await client.close();
    await server.close();
  });
  await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);
  await client.listTools();
  return await client.callTool({ name: tool, arguments: {} }) as CallToolResult;
}

afterEach(async () => {
  for (const cleanup of close.splice(0)) await cleanup();
  vi.restoreAllMocks();
});
afterAll(removeTempDirs);

describe("successful MCP output contracts", () => {
  it("delivers chart seed, batch and edit summaries through the schema-aware SDK client", async () => {
    const rig = await startServer();
    close.push(() => rig.close());
    const success = async (name: string, args: Record<string, unknown>) => {
      const result = await rig.client.callTool({ name, arguments: args }) as CallToolResult;
      expect(result.isError, JSON.stringify(result.content)).not.toBe(true);
      const payload = textPayload(result);
      expect(result.structuredContent).toEqual(payload);
      return payload;
    };
    const line = JSON.stringify({ version: 1, type: "line", collection: "observations",
      x: { field: "day", type: "date" }, y: [{ field: "count" }] });
    const table = JSON.stringify({ version: 1, type: "table", collection: "observations",
      columns: [{ field: "count", format: "number" }] });
    const created = await success("create_doc", {
      title: "Chart output contract", description: "Chart summaries pass the advertised output schemas.",
      blocks: [{ type: "chart", text: line }, { type: "chart", text: "{ incomplete" }],
    });
    expect(created.blocks.map((block: { chart: { status: string } }) => block.chart.status))
      .toEqual(["collection-absent", "invalid-configuration"]);
    await success("update_data", { uuid: created.uuid, operations: [{
      collection: "observations", schema: { version: 1, schema: { type: "object" } },
      upsert: [{ id: "point", value: { day: "2026-09-10", count: 17 } }],
    }] });
    const inserted = await success("insert_block", { uuid: created.uuid, blocks: [
      { type: "paragraph", text: "Context" }, { type: "chart", text: line }, { type: "chart", text: table },
    ] });
    expect(inserted.blocks[0]).not.toHaveProperty("chart");
    expect(inserted.blocks[1].chart).toMatchObject({ status: "ready", recordCount: 1, plottedCount: 1,
      series: [{ field: "count", pointCount: 1 }], firstX: "2026-09-10", lastX: "2026-09-10" });
    expect(inserted.blocks[2].chart).toEqual({ status: "ready", recordCount: 1, rowCount: 1, invalidRecordCount: 0, warnings: [] });
    const empty = line.replace('"count"', '"coutn"');
    const edited = await success("edit_block", { uuid: created.uuid,
      block_id: inserted.blocks[1].id, rev: inserted.blocks[1].rev, old_text: line, new_text: empty });
    expect(edited.block.chart).toMatchObject({ status: "no-records", recordCount: 1, plottedCount: 0,
      series: [{ field: "coutn", pointCount: 0 }] });
    const emptyTable = await success("create_doc", {
      title: "Empty table output", description: "Empty table projections retain their own counts.",
    });
    await success("update_data", { uuid: emptyTable.uuid, operations: [{
      collection: "observations", schema: { version: 1, schema: { type: "object" } },
    }] });
    const noRows = await success("insert_block", { uuid: emptyTable.uuid, blocks: [{ type: "chart", text: table }] });
    expect(noRows.blocks[0].chart).toMatchObject({ status: "no-records", recordCount: 0, rowCount: 0, invalidRecordCount: 0 });
  });

  it("delivers callout prose, attributes and document links in current and historical reads", async () => {
    const rig = await startServer();
    close.push(() => rig.close());
    const created = textPayload(await rig.client.callTool({ name: "create_doc", arguments: {
      title: "Callout reads", description: "Current and historical callouts use the declared output shape.",
    } }) as CallToolResult);
    const docId = randomUUID();
    const document = rig.instance.replicas.replica(created.uuid).doc;
    const expected = CALLOUT_VARIANTS.map((variant, index) => {
      const icon = [undefined, "🚀", "⏱️", ":codex:", ":claude:"][index];
      const inline = [{ text: "Read ", marks: {} }, { text: "the page", marks: { docLink: docId } }];
      const id = appendBlock(document, { type: "callout", variant, ...(icon === undefined ? {} : { icon }), inline });
      return { id, type: "callout", text: "Read the page", variant, ...(icon === undefined ? {} : { icon }),
        doc_links: [{ start: 5, end: 13, docId }], inline };
    });
    vi.spyOn(revisionClient, "readDocumentRevision").mockImplementation(async () => {
      const snapshot = new Y.Doc();
      Y.applyUpdate(snapshot, Y.encodeStateAsUpdate(document));
      return { doc: snapshot, history };
    });
    for (const name of ["get_doc", "get_revision"]) {
      const result = await rig.client.callTool({ name, arguments: { uuid: created.uuid,
        ...(name === "get_revision" ? { revision: "callout-revision" } : {}) } }) as CallToolResult;
      expect(result.isError, JSON.stringify(result.content)).not.toBe(true);
      const payload = textPayload(result);
      expect(result.structuredContent).toEqual(payload);
      expect(payload.blocks).toEqual(expected.map(block => ({ ...block,
        ...(name === "get_doc" ? { rev: expect.any(String) } : {}) })));
    }
  });

  it("advertises the validating definition and mirrors a client-accepted success from every tool", async () => {
    const rig = await startServer();
    close.push(() => rig.close());
    const registered = (await rig.client.listTools()).tools;
    expect(registered.map(({ name }) => name).sort()).toEqual(Object.keys(outputSchemas).sort());
    for (const tool of registered) {
      const schema = outputSchemas[tool.name as keyof typeof outputSchemas];
      expect(tool.outputSchema, tool.name).toEqual(z.toJSONSchema(schema, { target: "draft-7", io: "output" }));
      expect(tool.outputSchema?.type, tool.name).toBe("object");
      expect(tool.outputSchema?.additionalProperties, tool.name).toBe(false);
    }

    const seen = new Set<string>();
    const success = async (name: string, args: Record<string, unknown> = {}): Promise<any> => {
      const result = await rig.client.callTool({ name, arguments: args }) as CallToolResult;
      expect(result.isError, `${name}: ${JSON.stringify(result.content)}`).not.toBe(true);
      const payload = textPayload(result);
      expect(result.structuredContent, name).toEqual(payload);
      seen.add(name);
      return payload;
    };

    const tags = await success("list_tags");
    const tag = await success("create_tag", { name: "release", description: "Use for release coordination." });
    await success("edit_tag", { id: tag.id, description: null });
    const created = await success("create_doc", {
      title: "Output contract", description: "A fixture for every MCP answer.",
      blocks: [{ type: "paragraph", text: "first paragraph" }],
    });
    const target = await success("create_doc", {
      title: "Link target", description: "The target of this fixture's links.",
    });
    const uuid = created.uuid;
    const read = await success("get_doc", { uuid });
    vi.spyOn(revisionClient, "readDocumentHistory").mockResolvedValue({ revisions: [], history });
    vi.spyOn(revisionClient, "readDocumentRevision").mockImplementation(async () => {
      const snapshot = new Y.Doc();
      Y.applyUpdate(snapshot, Y.encodeStateAsUpdate(rig.instance.replicas.replica(uuid).doc));
      return { doc: snapshot, history };
    });
    await success("list_revisions", { uuid });
    vi.spyOn(revisionClient, "mutateDocumentRevision").mockResolvedValue({ id: "fixture-revision", author: null,
      startedAt: null, endedAt: 1, name: { text: "Reviewed", namer: null, namedAt: 1, canManage: true } });
    await success("name_revision", { uuid, name: "Reviewed" });
    const restore = vi.spyOn(revisionClient, "restoreDocumentRevision");
    const restoredRevision = { id: "restored-revision", author: null, startedAt: 1, endedAt: 1, name: null };
    for (const applied of [true, false]) {
      restore.mockResolvedValue({ revision: restoredRevision, applied });
      expect(await success("restore_revision", { uuid, revision: "fixture-revision" })).toMatchObject({
        revision: { id: "restored-revision", startedAt: new Date(1).toISOString(), endedAt: new Date(1).toISOString(), name: null },
        applied, synced: true,
      });
    }
    await success("get_revision", { uuid, revision: "fixture-revision" });
    await success("list_docs");
    await success("search", { query: "Output contract" });
    await success("find_decisions", { github_ref: "uberblick-ai/uberblick-2#1429" });
    await success("backlinks", { uuid });
    await success("set_metadata", {
      uuid, title: "Output contract renamed", description: "The renamed contract fixture.",
      tldr: "All advertised tool answers are checked.",
      tags: tags.tags.slice(0, 1).map((tag: { id: string }) => tag.id), links: [target.uuid],
      code_check: { repository: "uberblick-ai/uberblick-2", commit: "a".repeat(40), result: "matches", rev: read.rev, paths: ["packages/schema/"] },
    });
    await success("set_status", { uuid: target.uuid, status: "open" });
    const edited = await success("edit_block", {
      uuid, block_id: created.blocks[0].id, old_text: "first paragraph", new_text: "edited paragraph",
      rev: created.blocks[0].rev,
    });
    await success("link_range", {
      uuid, block_id: created.blocks[0].id, start: 0, end: 6, doc_id: target.uuid, rev: edited.block.rev,
    });
    await success("annotate", { uuid, block_id: created.blocks[0].id, start: 7, end: 16, text: "A comment." });
    const inserted = await success("insert_block", { uuid, blocks: [{ type: "paragraph", text: "temporary block" }] });
    const moved = await success("move_block", {
      uuid, block_ids: [inserted.blocks[0].id], after_block_id: created.blocks[0].id,
    });
    expect(moved.blocks).toEqual([{ id: inserted.blocks[0].id, rev: inserted.blocks[0].rev }]);
    await success("delete_block", { uuid, block_id: inserted.blocks[0].id });
    await success("get_data", { uuid });
    const storedValue = { arbitrary: { nested: [null, 4, { undeclared: true }] } };
    const storedSchema = { version: 1, schema: { type: "object" } };
    const updated = await success("update_data", { uuid, operations: [{
      collection: "fixture", schema: storedSchema, upsert: [{ id: "row", value: storedValue }],
    }] });
    expect(updated.collections).toEqual([{ name: "fixture", recordCount: 1, deleted: false }]);
    expect(updated).not.toHaveProperty("records");
    expect(updated).not.toHaveProperty("schema");
    const page = await success("get_data", { uuid, collection: "fixture" });
    expect(page.schema).toEqual(storedSchema);
    expect(page.records[0].value).toEqual(storedValue);
    await success("export_markdown", { uuid });
    const pinned = await success("pin_doc", { uuid, group: "Output fixtures" });
    await success("get_sidebar");
    await success("sidebar_group", { action: "rename", group: pinned.group.id, name: "Renamed fixtures" });
    await success("unpin_doc", { uuid });
    await success("archive_doc", { uuid });
    await success("restore_doc", { uuid });
    await success("archive_doc", { uuid });
    await success("delete_doc", { uuid });
    await success("sync_status");
    await success("get_help");
    await success("get_help", { topic: "get_doc" });
    expect([...seen].sort()).toEqual(registered.map(({ name }) => name).sort());
  });

  it("delivers existing read and write failures as JSON text without client output-validation errors", async () => {
    const rig = await startServer();
    close.push(() => rig.close());
    const uuid = randomUUID();
    for (const [name, args, writes] of [
      ["get_doc", { uuid }, false],
      ["set_metadata", { uuid, title: "Missing" }, true],
    ] as const) {
      const result = await rig.client.callTool({ name, arguments: args }) as CallToolResult;
      expect(result.isError).toBe(true);
      expect(result).not.toHaveProperty("structuredContent");
      expect(textPayload(result)).toEqual({
        error: "doc_not_found", message: `No document ${uuid} in workspace ${rig.config.workspaceId}`,
        uuid, inDirectory: false, hub: rig.instance.replicas.sync.state(),
        recoveryClass: "reread", recovery: expect.any(String),
        ...(writes ? { applied: false, partial: false, synced: false } : {}),
      });
    }
  });

  it("projects connection causes out of both MCP answers without changing the source reading", async () => {
    const reading = {
      status: "hub-down", url: "wss://hub.example.test", protocolVersion: 1,
      reason: "no connection to wss://hub.example.test", recoveryClass: "retry",
      cause: "dns", detail: "ENOTFOUND hub.example.test",
    };
    const result = await probe("list_docs", { workspace: "fixture", complete: true, docs: [], hub: reading });
    const expected = {
      workspace: "fixture", complete: true, docs: [], hub: {
        status: reading.status, url: reading.url, protocolVersion: reading.protocolVersion,
        reason: reading.reason, recoveryClass: reading.recoveryClass,
      },
    };
    expect(result.isError).not.toBe(true);
    expect(textPayload(result)).toEqual(expected);
    expect(result.structuredContent).toEqual(expected);
    expect(reading).toMatchObject({ cause: "dns", detail: "ENOTFOUND hub.example.test" });
  });

  it.each([
    ["missing field", { workspace: "fixture", complete: true, docs: [] }, "hub"],
    ["wrong field type", { workspace: "fixture", complete: true, docs: "wrong", hub }, "docs"],
    ["undeclared root key", { workspace: "fixture", complete: true, docs: [], hub, extra: true }, "extra"],
    ["undeclared nested key", { workspace: "fixture", complete: true, docs: [], hub: { ...hub, extra: true } }, "extra"],
  ])("answers a %s with internal_error and logs the mismatch on stderr", async (_name, payload, detail) => {
    const stderr = vi.spyOn(console, "error").mockImplementation(() => {});
    const result = await probe("list_docs", payload);
    expect(result.isError).toBe(true);
    expect(result).not.toHaveProperty("structuredContent");
    expect(textPayload(result)).toEqual({ error: "internal_error", message: INTERNAL_ERROR_MESSAGE });
    expect(stderr.mock.calls.flat().join("\n")).toContain("list_docs");
    expect(stderr.mock.calls.flat().join("\n")).toContain(detail);
  });

  it("refuses a text-only success before the SDK can produce its plain-text validation error", async () => {
    const stderr = vi.spyOn(console, "error").mockImplementation(() => {});
    const result = await probe("list_docs", () => ({
      content: [{ type: "text", text: JSON.stringify({ workspace: "fixture", complete: true, docs: [], hub }) }],
    }));
    expect(result.isError).toBe(true);
    expect(result).not.toHaveProperty("structuredContent");
    expect(textPayload(result)).toEqual({ error: "internal_error", message: INTERNAL_ERROR_MESSAGE });
    expect(stderr.mock.calls.flat().join("\n")).toContain("list_docs");
  });

  it("keeps the internal_error floor on a write mismatch without inventing durability", async () => {
    const stderr = vi.spyOn(console, "error").mockImplementation(() => {});
    const result = await probe("update_data", {
      uuid: randomUUID(), changed: true, collections: [], applied: "invalid", synced: false, hub,
    });
    expect(result.isError).toBe(true);
    expect(result).not.toHaveProperty("structuredContent");
    expect(textPayload(result)).toEqual({ error: "internal_error", message: INTERNAL_ERROR_MESSAGE });
    expect(stderr.mock.calls.flat().join("\n")).toContain("update_data");
    expect(stderr.mock.calls.flat().join("\n")).toContain("applied");
  });

  it("keeps get_data modes exclusive while passing caller JSON and diagnostic details through", async () => {
    const summary = { uuid: randomUUID(), data: null };
    const page = {
      uuid: summary.uuid, collection: "raw", schema: { unsupported: [null, { userKey: "raw" }] },
      valid: false, errors: [{ code: "custom", reason: "Merged diagnostic", details: { freeForm: { nested: [1, true] } } }],
      recordCount: 1, invalidRecordCount: 1,
      records: [{ id: "row", value: [null, { freeForm: true }], valid: false, errors: [] }],
      bytes: 42, complete: true, next_after: null,
    };
    for (const payload of [summary, page, { ...summary, revision: "snapshot", history }, { ...page, revision: "snapshot", history }]) {
      const result = await probe("get_data", payload);
      expect(result.isError).not.toBe(true);
      expect(result.structuredContent).toEqual(payload);
      expect(textPayload(result)).toEqual(payload);
    }
    const stderr = vi.spyOn(console, "error").mockImplementation(() => {});
    const incompletePage: Record<string, unknown> = { ...page };
    delete incompletePage.complete;
    for (const payload of [
      { ...page, data: null },
      { uuid: summary.uuid },
      { ...summary, records: [] },
      incompletePage,
      { ...page, records: [{ id: "row", valid: false, errors: [] }] },
      { ...page, records: [{ ...page.records[0], extra: true }] },
      { ...page, errors: [{ ...page.errors[0], extra: true }] },
      { ...summary, revision: "snapshot" },
      { ...summary, history },
      { ...page, revision: "snapshot", history: { ...history, extra: true } },
    ]) {
      const result = await probe("get_data", payload);
      expect(result.isError).toBe(true);
      expect(result).not.toHaveProperty("structuredContent");
      expect(textPayload(result)).toEqual({ error: "internal_error", message: INTERNAL_ERROR_MESSAGE });
    }
    expect(stderr).toHaveBeenCalled();
  });

  it("requires cache freshness on catalog and snapshot results", async () => {
    const catalog = { uuid: randomUUID(), revisions: [], history };
    const snapshot = { uuid: catalog.uuid, revision: "snapshot", title: "Downloaded", blocks: [], data: null, history };
    for (const [name, payload] of [["list_revisions", catalog], ["get_revision", snapshot]] as const) {
      const result = await probe(name, payload);
      expect(result.isError).not.toBe(true);
      expect(result.structuredContent).toEqual(payload);
    }
    const stderr = vi.spyOn(console, "error").mockImplementation(() => {});
    for (const [name, payload] of [["list_revisions", catalog], ["get_revision", snapshot]] as const) {
      const missing: Record<string, unknown> = { ...payload };
      delete missing.history;
      const result = await probe(name, missing);
      expect(result.isError).toBe(true);
      expect(textPayload(result)).toEqual({ error: "internal_error", message: INTERNAL_ERROR_MESSAGE });
    }
    expect(stderr).toHaveBeenCalled();
  });
});

import { randomUUID } from "node:crypto";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { INTERNAL_ERROR_MESSAGE } from "../src/failures.js";
import { guarded } from "../src/tool-adapter.js";
import { ServerWork } from "../src/server-work.js";
import type { ToolContext } from "../src/tools/context.js";
import { outputSchemas } from "../src/outputs.js";
import { removeTempDirs, startServer } from "./helpers.js";

const close: (() => Promise<void>)[] = [];
const hub = { status: "disabled", url: null, protocolVersion: 1 };

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
  }, guarded(tool, { work: new ServerWork() } as ToolContext, async () => typeof answer === "function" ? answer() : answer));
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
    const created = await success("create_doc", {
      title: "Output contract", description: "A fixture for every MCP answer.",
      blocks: [{ type: "paragraph", text: "first paragraph" }],
    });
    const target = await success("create_doc", {
      title: "Link target", description: "The target of this fixture's links.",
    });
    const uuid = created.uuid;
    await success("get_doc", { uuid });
    await success("list_docs");
    await success("search", { query: "Output contract" });
    await success("find_decisions", { github_ref: "uberblick-ai/uberblick-2#1429" });
    await success("backlinks", { uuid });
    await success("set_metadata", {
      uuid, title: "Output contract renamed", description: "The renamed contract fixture.",
      tldr: "All advertised tool answers are checked.",
      tags: tags.tags.slice(0, 1).map((tag: { id: string }) => tag.id), links: [target.uuid],
    });
    await success("set_status", { uuid, status: "draft" });
    const edited = await success("edit_block", {
      uuid, block_id: created.blocks[0].id, old_text: "first paragraph", new_text: "edited paragraph",
      rev: created.blocks[0].rev,
    });
    await success("link_range", {
      uuid, block_id: created.blocks[0].id, start: 0, end: 6, doc_id: target.uuid, rev: edited.block.rev,
    });
    await success("annotate", { uuid, block_id: created.blocks[0].id, start: 7, end: 16, text: "A comment." });
    const inserted = await success("insert_block", { uuid, type: "paragraph", text: "temporary block" });
    await success("delete_block", { uuid, block_id: inserted.block.id });
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

  it.each([
    ["missing field", { workspace: "fixture", docs: [] }, "hub"],
    ["wrong field type", { workspace: "fixture", docs: "wrong", hub }, "docs"],
    ["undeclared root key", { workspace: "fixture", docs: [], hub, extra: true }, "extra"],
    ["undeclared nested key", { workspace: "fixture", docs: [], hub: { ...hub, extra: true } }, "extra"],
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
      content: [{ type: "text", text: JSON.stringify({ workspace: "fixture", docs: [], hub }) }],
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
    for (const payload of [summary, page]) {
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
    ]) {
      const result = await probe("get_data", payload);
      expect(result.isError).toBe(true);
      expect(result).not.toHaveProperty("structuredContent");
      expect(textPayload(result)).toEqual({ error: "internal_error", message: INTERNAL_ERROR_MESSAGE });
    }
    expect(stderr).toHaveBeenCalled();
  });
});

import { randomUUID } from "node:crypto";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { afterAll, afterEach, expect, it } from "vitest";
import * as Y from "yjs";
import { removeTempDirs, startServer, type Rig } from "./helpers.js";

const rigs: Rig[] = [];
const FLOW = 'flow v0\ncolumns main\nbox a "Draft"\nbox b "Review"\na --> b';

afterEach(async () => { for (const rig of rigs.splice(0)) await rig.close(); });
afterAll(removeTempDirs);

async function fixture(text = FLOW) {
  const rig = await startServer();
  rigs.push(rig);
  const created = await rig.ok("create_doc", { title: "Render fixture", description: "Inspect a drawing without writes.",
    blocks: [{ type: "code", language: "ablauf", text }] });
  return { rig, args: { uuid: created.uuid, block_id: created.blocks[0].id }, drawing: created.blocks[0].drawing };
}

async function render(rig: Rig, args: Record<string, unknown>): Promise<CallToolResult> {
  return await rig.client.callTool({ name: "render_block", arguments: args }) as CallToolResult;
}

function payload(result: CallToolResult) {
  const text = result.content[0];
  if (text?.type !== "text") throw new Error("Expected JSON metadata first");
  return JSON.parse(text.text);
}

it("delivers one PNG image with dimensions and SVG text through a schema-aware client without changing state or log", async () => {
  const { rig, args, drawing } = await fixture();
  const before = await rig.ok("get_doc", { uuid: args.uuid });
  const doc = rig.instance.replicas.replica(args.uuid).doc;
  const state = Y.encodeStateAsUpdate(doc);
  const logSize = rig.instance.store.logSize();
  const png = await render(rig, args);
  expect(png.isError).not.toBe(true);
  const answer = payload(png);
  expect(png.structuredContent).toEqual(answer);
  expect(answer).toMatchObject({ ...args, format: "png", width: 1000, height: expect.any(Number), drawing });
  expect(png.content).toHaveLength(2);
  const image = png.content[1];
  if (image?.type !== "image") throw new Error("Expected a PNG image");
  expect(image.mimeType).toBe("image/png");
  const bytes = Buffer.from(image.data, "base64");
  expect(bytes.subarray(0, 8)).toEqual(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
  expect(bytes.readUInt32BE(16)).toBe(answer.width);
  expect(bytes.readUInt32BE(20)).toBe(answer.height);
  expect(answer).not.toHaveProperty("data");
  const svg = await render(rig, { ...args, format: "svg" });
  expect(svg.isError).not.toBe(true);
  expect(svg.content).toHaveLength(1);
  expect(svg.structuredContent).toEqual(payload(svg));
  expect(payload(svg)).toMatchObject({ ...args, format: "svg", drawing, svg: expect.stringContaining("<svg") });
  const smaller = payload(await render(rig, { ...args, width: 500 }));
  expect(smaller.width).toBe(500);
  expect(Math.abs(smaller.height * 2 - answer.height)).toBeLessThanOrEqual(1);
  expect(await rig.ok("get_doc", { uuid: args.uuid })).toEqual(before);
  expect(Y.encodeStateAsUpdate(doc)).toEqual(state);
  expect(rig.instance.store.logSize()).toBe(logSize);
  const registered = (await rig.client.listTools()).tools.find(tool => tool.name === "render_block")!;
  expect(registered.annotations).toMatchObject({ readOnlyHint: true, idempotentHint: true, destructiveHint: false });
});

it("returns best-effort drawings with the same capped diagnostics as writes", async () => {
  const source = `flow v0\ncolumns main\n${Array.from({ length: 25 }, (_, i) => `unknown line${i}`).join("\n")}`;
  const { rig, args, drawing } = await fixture(source);
  const result = await render(rig, args);
  expect(result.isError).not.toBe(true);
  expect(result.content.some(item => item.type === "image")).toBe(true);
  expect(payload(result).drawing).toEqual(drawing);
  expect(drawing.status).toBe("errors");
  expect(drawing.diagnostics).toHaveLength(20);
  expect(drawing.diagnosticCount).toBe(25);
  expect(drawing.diagnostics[0]).toMatchObject({ line: 3, severity: "error", message: expect.any(String) });
});

it("refuses oversized PNGs with a shared failure and permits SVG recovery", async () => {
  const { rig, args } = await fixture('flow v0\ncolumns main\nbox a "A" gap=100000\nbox b "B"');
  const result = await render(rig, args);
  expect(result.isError).toBe(true);
  expect(result.structuredContent).toBeUndefined();
  expect(result.content).toHaveLength(1);
  expect(payload(result)).toMatchObject({ error: "render_too_large", maxPixels: 4_000_000,
    recoveryClass: "manual", recovery: expect.stringContaining('format: "svg"') });
  expect(payload(result)).not.toHaveProperty("applied");
  const svg = await render(rig, { ...args, format: "svg" });
  expect(svg.isError).not.toBe(true);
  expect(payload(svg).svg).toContain("<svg");
});

it("refuses unsupported blocks and missing identities with read-tool failures, and validates widths before rendering", async () => {
  const { rig, args } = await fixture();
  for (const block of [{ type: "code", language: "wireframe", text: "page" }, { type: "chart", text: "{}" }]) {
    const inserted = await rig.ok("insert_block", { uuid: args.uuid, blocks: [block] });
    const result = await render(rig, { ...args, block_id: inserted.blocks[0].id });
    expect(result.isError).toBe(true);
    expect(result.content).toHaveLength(1);
    expect(payload(result)).toMatchObject({ error: "unsupported_block_type", recoveryClass: "manual",
      message: expect.stringContaining("ablauf") });
  }
  for (const [request, code] of [[{ ...args, uuid: randomUUID() }, "doc_not_found"],
    [{ ...args, block_id: "unknown" }, "block_not_found"]] as const) {
    const result = await render(rig, request);
    expect(result.isError).toBe(true);
    expect(payload(result)).toMatchObject({ error: code, recovery: expect.any(String), recoveryClass: expect.any(String) });
    expect(result.content).toHaveLength(1);
  }
  for (const width of [99, 2001, 100.5, "1000", null]) {
    const result = await render(rig, { ...args, width });
    expect(result.isError).toBe(true);
    expect(result.content).toHaveLength(1);
    expect(payload(result)).toMatchObject({ error: "invalid_render_options", field: "width", recoveryClass: "manual" });
  }
  const invalidFormat = await render(rig, { ...args, format: "pdf" });
  expect(invalidFormat.isError).toBe(true);
  expect(payload(invalidFormat)).toMatchObject({ error: "invalid_render_options", field: "format" });
});

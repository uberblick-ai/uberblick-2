import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { canonicalJson, compareCodePoints, readDocData } from "@uberblick/schema";
import { z } from "zod";
import { failureContract, guarded, ToolError } from "../failures.js";
import { strictInput } from "../inputs.js";
import { outputSchemas } from "../outputs.js";
import type { ToolContext } from "./context.js";
import { json } from "./helpers.js";
import { uuidArg } from "./schemas.js";

const encoder = new TextEncoder();

export function registerGetData(server: McpServer, context: ToolContext): void {
  const { replicas, requireDoc } = context;
  server.registerTool("get_data", {
    title: "Read document data",
    description:
      "Read structured data deliberately. Without `collection`, return `data: null` for none, or an area " +
      "summary of collection names, record counts, validity and invalid-record counts, canonical UTF-8 bytes, " +
      "area validity and area error count. Summary reads return no schemas, record values or id lists.\n\n" +
      "With `collection`, return its raw schema, validity, collection-level errors, counts and one detached " +
      "page of records. Each record has `id`, `value`, `valid` and its errors. Records are in Unicode code-point " +
      "id order, starting exclusively after `after`. `limit` defaults to 100, at most 1000; 0 reads only the " +
      "schema. `max_bytes` defaults to 65536 (64 KiB), at most 1048576 (1 MiB). It bounds canonical JSON of " +
      "the page's `{id, value}` array, including brackets and commas, excluding schema, diagnostics and MCP " +
      "formatting. A nonzero-limit page always includes the first remaining record, even if it exceeds that " +
      "budget. These bounds do not bound the full response size or client token count. `bytes` reports those " +
      "canonical page bytes.\n\n" +
      "`next_after` is the last returned id when more remain, otherwise null; `complete` states whether the " +
      "filtered collection is exhausted. For schema-only reads with remaining records, keep the current " +
      "cursor and use a positive limit to advance. Optional `ids` (up to 1000) filters the same ordered paging " +
      "and returns `missing_ids` for requested ids absent from the collection. Cursors are not snapshots: " +
      "following them visits each record exactly once only while the data stays unchanged.\n\n" +
      "Merged invalidity is observed through the shared reader without dropping, repairing or writing values. " +
      "Archived and decided documents remain readable; access to their room is unchanged." +
      failureContract("get_data"),
    outputSchema: outputSchemas.get_data,
    inputSchema: strictInput({
      uuid: uuidArg,
      collection: z.string().optional().describe("Collection name; omit for the area summary."),
      after: z.string().optional().describe("Exclusive record-id cursor."),
      limit: z.number().int().min(0).max(1000).optional(),
      max_bytes: z.number().int().min(1).max(1024 * 1024).optional(),
      ids: z.array(z.string()).max(1000).optional(),
    }, [
      { title: "Area summary", when: { field: "collection", present: false }, forbids: ["after", "limit", "max_bytes", "ids"] },
      { title: "Collection page", when: { field: "collection", present: true } },
    ]),
  }, guarded("get_data", async ({ uuid, collection, after, limit = 100, max_bytes = 64 * 1024, ids }) => {
    await replicas.settle();
    const data = readDocData(requireDoc(uuid).doc);
    if (collection === undefined) {
      return json({ uuid, data: data === null ? null : {
        collections: data.collections.map((entry) => ({
          name: entry.name, recordCount: entry.records.length,
          valid: entry.valid, invalidRecordCount: entry.invalidRecordIds.length,
        })),
        bytes: data.bytes, valid: data.valid, errorCount: data.errors.length,
      } });
    }
    const selected = data?.collections.find((entry) => entry.name === collection);
    if (selected === undefined) {
      throw new ToolError("data_collection_not_found", `No collection ${collection} in document ${uuid}`, { uuid, collection });
    }
    const requested = ids === undefined ? undefined : new Set(ids);
    const existing = new Set(selected.records.map((record) => record.id));
    const remaining = selected.records.filter((record) =>
      (requested === undefined || requested.has(record.id)) &&
      (after === undefined || compareCodePoints(record.id, after) > 0));
    const page: typeof selected.records = [];
    let bytes = 2; // The canonical array's brackets; commas add one byte each.
    for (const record of remaining) {
      if (page.length === limit) break;
      const added = encoder.encode(canonicalJson(record, Infinity)).byteLength + (page.length === 0 ? 0 : 1);
      if (page.length > 0 && bytes + added > max_bytes) break;
      page.push(record);
      bytes += added;
    }
    const complete = page.length === remaining.length;
    const invalid = new Set(selected.invalidRecordIds);
    const collectionErrors = selected.errors.filter((error) => error.details.recordId === undefined);
    const recordErrors = new Map<string, typeof selected.errors>();
    for (const error of selected.errors) {
      const id = error.details.recordId;
      if (typeof id !== "string") continue;
      const errors = recordErrors.get(id) ?? [];
      errors.push(error);
      recordErrors.set(id, errors);
    }
    return json({
      uuid, collection, schema: selected.schema, valid: selected.valid, errors: collectionErrors,
      recordCount: selected.records.length, invalidRecordCount: selected.invalidRecordIds.length,
      records: page.map((record) => ({
        ...record, valid: !invalid.has(record.id),
        errors: [
          ...(recordErrors.get(record.id) ?? []),
          ...collectionErrors.filter((error) => error.details.limit === "area"),
        ],
      })),
      bytes, complete,
      next_after: complete ? null : (page.at(-1)?.id ?? after ?? null),
      ...(requested === undefined ? {} : {
        missing_ids: [...requested].filter((id) => !existing.has(id)).sort(compareCodePoints),
      }),
    });
  }, context.work));
}

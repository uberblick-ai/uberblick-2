import type { ToolRegistrar } from "../help-resources.js";
import { failureContract } from "../failures.js";
import { outputSchemas } from "../outputs.js";
import type { ToolContext } from "../tools/context.js";

import { guarded } from "../tool-adapter.js";
import { inputSchema, getDataOperation } from "../tools/get-data.js";

export function registerGetData(server: ToolRegistrar, context: ToolContext): void {
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
    inputSchema,
  }, guarded("get_data", context, getDataOperation));
}

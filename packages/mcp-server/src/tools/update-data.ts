import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { applyDocData, summarizeDocData } from "@uberblick/schema";
import type { DataOperation } from "@uberblick/schema";
import { z } from "zod";
import { guarded } from "../failures.js";
import { strictInput } from "../inputs.js";
import { outputSchemas } from "../outputs.js";
import type { ToolContext } from "./context.js";
import { ARCHIVED_IS_READ_ONLY, DECIDED_IS_READ_ONLY, SYNCED_IS_ACKNOWLEDGED } from "./descriptions.js";
import { json } from "./helpers.js";
import { uuidArg } from "./schemas.js";

// Only the operation envelope is parsed. Unknown JSON passes through untouched
// so the shared validator can refuse unsupported rules and unsafe own keys.
const record = strictInput({ id: z.string(), value: z.unknown() });
const operation = strictInput({
  collection: z.string(),
  schema: z.unknown().optional().describe("Raw versioned collection schema, validated by applyDocData."),
  replaceRecords: z.array(record).optional(),
  deleteRecords: z.array(z.string()).optional(),
  upsert: z.array(record).optional(),
  deleteCollection: z.boolean().optional(),
});

export function registerUpdateData(server: McpServer, context: ToolContext): void {
  const { replicas, briefing, requireWritableDoc, durability, toolContract } = context;
  server.registerTool("update_data", {
    title: "Update document data",
    description:
      "Apply one validated batch through the shared applyDocData operation. Name each touched collection once. " +
      "Within each collection, set `schema`, optionally `replaceRecords`, then `deleteRecords`, then `upsert` " +
      "whole `{id, value}` records. `deleteCollection: true` is exclusive of other changes. Schema and value JSON " +
      "reach the shared validator unaltered; unsupported schema versions/rules and invalid retained records are " +
      "refused before mutation. The whole batch commits as one local transaction. An identical refresh reports " +
      "`changed: false` and emits no update. The answer summarizes touched collection names, counts and deletion " +
      "without schemas or record values, plus the normal durability fields.\n\n" +
      "A producer owns its collections and refreshes them by upsert or full-set replacement. Keep human " +
      "dispositions in a separate collection keyed by the producer's record ids; refreshing producer records " +
      "leaves that collection unchanged. Split changes exceeding the 1 MiB operation budget (schemas plus " +
      "changed record values) across calls; those calls are not atomic together. No CAS, distributed lock " +
      "or new concurrency guarantee is introduced. Inspect with get_data; get_doc only summarizes data.\n\n" +
      DECIDED_IS_READ_ONLY + "\n\n" + ARCHIVED_IS_READ_ONLY + "\n\n" + SYNCED_IS_ACKNOWLEDGED +
      toolContract("update_data"),
    outputSchema: outputSchemas.update_data,
    inputSchema: strictInput({ uuid: uuidArg, operations: z.array(operation) }),
  }, guarded("update_data", async ({ uuid, operations }) => {
    await replicas.settle();
    briefing.require();
    const replica = requireWritableDoc(uuid, true);
    const { changed } = applyDocData(replica.doc, replicas.directory().doc, operations as DataOperation[]);
    const counts = new Map((summarizeDocData(replica.doc) ?? []).map((entry) => [entry.name, entry.recordCount]));
    return json({
      uuid, changed,
      collections: operations.map(({ collection: name }) => ({
        name, recordCount: counts.get(name) ?? 0, deleted: !counts.has(name),
      })),
      ...durability(replica),
    });
  }, context.work));
}

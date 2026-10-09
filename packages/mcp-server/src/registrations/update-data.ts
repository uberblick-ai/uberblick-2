import type { ToolRegistrar } from "../help-resources.js";
import { outputSchemas } from "../outputs.js";
import type { ToolContext } from "../tools/context.js";
import { ARCHIVED_IS_READ_ONLY, DECIDED_IS_READ_ONLY, SYNCED_IS_ACKNOWLEDGED } from "../tools/descriptions.js";

import { guarded } from "../tool-adapter.js";
import { inputSchema, updateDataOperation } from "../tools/update-data.js";

export function registerUpdateData(server: ToolRegistrar, context: ToolContext): void {
  const { toolContract } = context;
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
    inputSchema,
  }, guarded("update_data", context, updateDataOperation));
}

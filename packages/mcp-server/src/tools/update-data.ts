import { prepareDocData } from "@uberblick/schema";
import type { DataOperation } from "@uberblick/schema";
import { z } from "zod";
import { strictInput } from "../inputs.js";
import type { Replica } from "../replica.js";
import type { ToolContext } from "./context.js";
import { uuidArg } from "./schemas.js";
import { documentOperation } from "./operation.js";

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

export const inputSchema = strictInput({ uuid: uuidArg, operations: z.array(operation) });

/** Both transports validate the same batch before any proposed keys are written. */
export function prepareDataUpdate(context: ToolContext, args: z.infer<typeof inputSchema>, replica: Replica) {
  return prepareDocData(replica.doc, context.replicas.directory().doc, args.operations as DataOperation[], replica.id);
}

export const updateDataOperation = documentOperation({ content: true, contentDurability: false }, inputSchema, (context, args, _request, replica) => {
  const update = prepareDataUpdate(context, args, replica);
  update.commit();
  return {
    uuid: args.uuid, changed: update.changed,
    collections: update.collections.map(({ name, recordCount, deleted }) => ({ name, recordCount, deleted })),
  };
});

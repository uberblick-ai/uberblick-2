import { applyDocData, summarizeDocData } from "@uberblick/schema";
import type { DataOperation } from "@uberblick/schema";
import { z } from "zod";
import { strictInput } from "../inputs.js";
import { uuidArg } from "./schemas.js";
import { documentOperation } from "./operation.js";

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

export const updateDataOperation = documentOperation("update_data", inputSchema, (context, { uuid, operations }, _request, replica) => {
  const { replicas } = context;

  const { changed } = applyDocData(replica.doc, replicas.directory().doc, operations as DataOperation[]);
  const counts = new Map((summarizeDocData(replica.doc) ?? []).map((entry) => [entry.name, entry.recordCount]));
  return {
    uuid, changed,
    collections: operations.map(({ collection: name }) => ({
      name, recordCount: counts.get(name) ?? 0, deleted: !counts.has(name),
    })),
  };
});

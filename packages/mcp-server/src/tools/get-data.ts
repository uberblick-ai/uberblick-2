import { canonicalJson, compareCodePoints, readDocData } from "@uberblick/schema";
import { z } from "zod";
import { ToolError } from "../failures.js";
import { strictInput } from "../inputs.js";
import { uuidArg } from "./schemas.js";
import { operation } from "./operation.js";

const encoder = new TextEncoder();

export const inputSchema = strictInput({
  uuid: uuidArg,
  collection: z.string().optional().describe("Collection name; omit for the area summary."),
  after: z.string().optional().describe("Exclusive record-id cursor."),
  limit: z.number().int().min(0).max(1000).optional(),
  max_bytes: z.number().int().min(1).max(1024 * 1024).optional(),
  ids: z.array(z.string()).max(1000).optional(),
}, [
  { title: "Area summary", when: { field: "collection", present: false }, forbids: ["after", "limit", "max_bytes", "ids"] },
  { title: "Collection page", when: { field: "collection", present: true } },
]);

export const getDataOperation = operation("get_data", inputSchema, (context, { uuid, collection, after, limit = 100, max_bytes = 64 * 1024, ids }, _request) => {
  const { requireDoc } = context;

  const data = readDocData(requireDoc(uuid).doc);
  if (collection === undefined) {
    return { uuid, data: data === null ? null : {
      collections: data.collections.map((entry) => ({
        name: entry.name, recordCount: entry.records.length,
        valid: entry.valid, invalidRecordCount: entry.invalidRecordIds.length,
      })),
      bytes: data.bytes, valid: data.valid, errorCount: data.errors.length,
    } };
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
  return {
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
  };
});

import { canonicalJson, compareCodePoints, readDocData } from "@uberblick/schema";
import { z } from "zod";
import { ToolError } from "../failures.js";
import { strictInput } from "../inputs.js";
import { getDocumentRevision } from "../revision-client.js";
import { revisionArg, uuidArg } from "./schemas.js";
import { READ, operation } from "./operation.js";

const encoder = new TextEncoder();

export const inputSchema = strictInput({
  uuid: uuidArg,
  revision: revisionArg.optional(),
  collection: z.string().optional().describe("Collection name; omit for the area summary."),
  after: z.string().optional().describe("Exclusive record-id cursor; needs collection."),
  limit: z.number().int().min(0).max(1000).optional().describe("Records per page, 0 for the schema only; needs collection."),
  max_bytes: z.number().int().min(1).max(1024 * 1024).optional().describe("Page record budget in bytes; needs collection."),
  ids: z.array(z.string()).max(1000).optional().describe("Only these record ids; needs collection."),
}, [
  { title: "Area summary", when: { field: "collection", present: false }, forbids: ["after", "limit", "max_bytes", "ids"] },
  { title: "Collection page", when: { field: "collection", present: true } },
]);

export function dataSummary(data: ReturnType<typeof readDocData>) {
  return data === null ? null : {
    collections: data.collections.map((entry) => ({
      name: entry.name, recordCount: entry.records.length,
      valid: entry.valid, invalidRecordCount: entry.invalidRecordIds.length,
    })),
    bytes: data.bytes, valid: data.valid, errorCount: data.errors.length,
  };
}

export const getDataOperation = operation(READ, inputSchema, async (context, args) => {
  const { uuid, revision } = args;
  if (revision !== undefined) context.requireKnownDoc(uuid);
  const doc = revision === undefined ? context.requireDoc(uuid).doc
    : await getDocumentRevision(context.replicas, uuid, revision);
  try {
    return { ...readData(doc, args), ...(revision === undefined ? {} : { revision }) };
  } finally {
    if (revision !== undefined) doc.destroy();
  }
});

function readData(doc: Parameters<typeof readDocData>[0], {
  uuid, collection, after, limit = 100, max_bytes = 64 * 1024, ids, revision,
}: z.infer<typeof inputSchema>) {
  const data = readDocData(doc);
  if (collection === undefined) {
    return { uuid, data: dataSummary(data) };
  }
  const selected = data?.collections.find((entry) => entry.name === collection);
  if (selected === undefined) {
    throw new ToolError("data_collection_not_found", `No collection ${collection} in document ${uuid}`, {
      uuid, collection,
      ...(revision === undefined ? {} : { revision,
        recovery: "Call get_data with this uuid and revision to list that revision's collections, then choose an existing collection.",
      }),
    });
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
}

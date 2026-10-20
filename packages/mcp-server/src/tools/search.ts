import { isDirectoryEntryArchived, isDirectoryEntryDeleted, resolveDecisionTopics, resolveTagAssignments } from "@uberblick/schema";
import { z } from "zod";
import { strictInput } from "../inputs.js";
import { resolveTagFilter } from "../tag-catalog.js";
import { operation } from "./operation.js";

export const inputSchema = strictInput({
  query: z
    .string()
    .min(1)
    .describe(
      "Match any word in title, description, content or assigned tag names, including English word forms. Case and accents fold; `list_docs` matches adjacent `list docs`, and a trailing * matches prefixes. Results use title-weighted bm25 relevance.",
    ),
  limit: z.number().int().min(1).max(100).optional().describe("Maximum hits, from 1 to 100; defaults to 20 after filters."),
  tag: z.union([z.string().min(1), z.array(z.string().min(1)).min(1)]).optional()
    .describe("One catalog tag id or name (case ignored), or a nonempty list. Match any listed tag; carrying more listed tags boosts relevance. Unknown tags refuse."),
  kind: z.enum(["regular", "decision"]).optional()
    .describe("Only regular documents (including stored requirements) or decision records, including superseded, rejected and withdrawn records."),
});

type RecordState = "in-force" | "superseded" | "open" | "rejected" | "withdrawn" | "conflict";

export const searchOperation = operation("search", inputSchema, (context, { query, limit, tag, kind }, _request) => {
  const { replicas, tagCatalog } = context;

  const catalog = tagCatalog();
  const tagIds = tag === undefined ? undefined : [...new Set(
    (Array.isArray(tag) ? tag : [tag]).map((value) => resolveTagFilter(replicas, value)),
  )];
  const hits = replicas.store.search(query, limit ?? 20, tagIds, kind)
    .filter(hit => !isDirectoryEntryDeleted(replicas.directory().doc, hit.uuid) &&
      !isDirectoryEntryArchived(replicas.directory().doc, hit.uuid));
  const states = new Map<string, RecordState>();
  if (hits.some((hit) => hit.kind === "decision")) {
    for (const topic of resolveDecisionTopics(replicas.directory().doc)) {
      for (const record of topic.records) {
        states.set(record.uuid, record.status === "rejected" || record.status === "withdrawn" ? record.status : "open");
      }
      for (const record of topic.superseded) states.set(record.uuid, "superseded");
      for (const record of topic.conflicts) states.set(record.uuid, "conflict");
      if (topic.inForce !== null) states.set(topic.inForce.uuid, "in-force");
    }
  }
  return {
    query,
    ...(tag === undefined ? {} : { tag }),
    ...(kind === undefined ? {} : { kind }),
    hits: hits.map((hit) => ({
      ...hit,
      ...(hit.kind === "decision" ? { state: states.get(hit.uuid) ?? "open" } : {}),
      tags: resolveTagAssignments(catalog, hit.tags),
    })),
  };
});

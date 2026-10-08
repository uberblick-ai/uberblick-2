import { resolveTagAssignments } from "@uberblick/schema";
import { z } from "zod";
import { strictInput } from "../inputs.js";
import { resolveTagFilter } from "../tag-catalog.js";
import { operation } from "./operation.js";

export const inputSchema = strictInput({
  query: z
    .string()
    .min(1)
    .describe(
      "Words to match; every term must occur in one document, `list_docs` matches both `list_docs` and `list docs` but not `a list of docs`, and a trailing * makes its term a prefix match.",
    ),
  limit: z.number().int().min(1).max(100).optional(),
  tag: z.string().min(1).optional().describe("Only documents carrying this catalog tag id or exact name."),
});

export const searchOperation = operation("search", inputSchema, (context, { query, limit, tag }, _request) => {
  const { replicas, tagCatalog } = context;

  const catalog = tagCatalog();
  const tagId = tag === undefined ? undefined : resolveTagFilter(replicas, tag);
  const hits = replicas.store.search(query, limit ?? 20, tagId);
  return {
    query,
    ...(tag === undefined ? {} : { tag }),
    hits: hits.map((hit) => ({
      ...hit,
      tags: resolveTagAssignments(catalog, hit.tags),
    })),
  };
});

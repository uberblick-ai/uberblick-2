import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { resolveTagAssignments } from "@uberblick/schema";
import { z } from "zod";
import { failureContract, guarded } from "../failures.js";
import { strictInput } from "../inputs.js";
import { outputSchemas } from "../outputs.js";
import { resolveTagFilter } from "../tag-catalog.js";
import type { ToolContext } from "./context.js";
import { json } from "./helpers.js";

export function registerSearch(server: McpServer, context: ToolContext): void {
  const { replicas, tagCatalog } = context;

  server.registerTool(
    "search",
    {
      title: "Search documents",
      description:
        "Full-text search over document titles, descriptions and block text, from the local FTS5 index. " +
        "The index is derived from the replicas and updated as updates are observed, so it reflects edits from any client this replica has seen.\n\n" +
        "Matching is all-terms: every searchable term in `query` must occur in one and the same document. " +
        "Letters and digits make a term; punctuation and emoji are not terms, so a query holding only those matches nothing. " +
        "An underscore-separated group matches its words as an adjacent phrase: `list_docs` matches both `list_docs` and `list docs`, but not `a list of docs`. " +
        "Case and accents are folded, but nothing is stemmed — `withdrawal` does not find a document that says " +
        "`withdrawing`. A trailing `*` loosens one term to a prefix match, which is how to reach an inflection: " +
        "`withdraw*` finds both `withdrawal` and `withdrawing`. No hits means no indexed document matched the whole query under those rules; it does not by itself mean the index is empty.\n\n" +
        "Every hit carries the document's `description` — null where nobody has written one — so relevance can be " +
        "judged from the result list rather than by opening each document in turn. Its tag assignments carry " +
        "canonical ids, current names and retirement state. Pass `tag` as a catalog id or exact current name to " +
        "restrict hits to that assignment; a value this catalog does not have is refused rather than answered with " +
        "no hits." +
        failureContract("search"),
      outputSchema: outputSchemas.search,
      inputSchema: strictInput({
        query: z
          .string()
          .min(1)
          .describe(
            "Words to match; every term must occur in one document, `list_docs` matches both `list_docs` and `list docs` but not `a list of docs`, and a trailing * makes its term a prefix match.",
          ),
        limit: z.number().int().min(1).max(100).optional(),
        tag: z.string().min(1).optional().describe("Only documents carrying this catalog tag id or exact name."),
      }),
    },
    guarded("search", async ({ query, limit, tag }) => {
      await replicas.settle();
      const catalog = tagCatalog();
      const tagId = tag === undefined ? undefined : resolveTagFilter(replicas, tag);
      const hits = replicas.store.search(query, limit ?? 20, tagId);
      return json({
        query,
        ...(tag === undefined ? {} : { tag }),
        hits: hits.map((hit) => ({
          ...hit,
          tags: resolveTagAssignments(catalog, hit.tags),
        })),
      });
    }),
  );
}

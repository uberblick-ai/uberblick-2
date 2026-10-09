import type { ToolRegistrar } from "../help-resources.js";
import { outputSchemas } from "../outputs.js";
import type { ToolContext } from "../tools/context.js";
import { ARCHIVED_IS_READ_ONLY, DECIDED_IS_READ_ONLY, SYNCED_IS_ACKNOWLEDGED } from "../tools/descriptions.js";

import { guarded } from "../tool-adapter.js";
import { inputSchema, setTitleOperation } from "../tools/set-title.js";

export function registerSetTitle(server: ToolRegistrar, context: ToolContext): void {
  const { toolContract } = context;
  server.registerTool("set_title", {
    title: "Rename a document",
    description:
      "Replace the document's title. A title is rewritten rather than patched, so there is nothing to splice " +
      "here and no `old_text` to assert. Identity is the uuid and a rename never touches it, so every link, " +
      "backlink and annotation survives one.\n\n" +
      "`meta.title` in the document is authoritative and the directory stub caches it. This writes the " +
      "document and the stub follows in the same call, so the next search and get_sidebar answer with the new " +
      "title without opening a single document room. list_docs does too; for a decision, pass a matching `kind`, " +
      "`status` or `tag` predicate.\n\n" +
      "An empty title, and a title of nothing but whitespace, are both refused: a document nobody can name is " +
      "a document nobody can pick out of a listing.\n\n" +
      DECIDED_IS_READ_ONLY +
      "\n\n" +
      ARCHIVED_IS_READ_ONLY +
      "\n\n" +
      SYNCED_IS_ACKNOWLEDGED +
      toolContract("set_title"),
    outputSchema: outputSchemas.set_title,
    inputSchema,
  }, guarded("set_title", context, setTitleOperation));
}

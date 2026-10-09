import type { ToolRegistrar } from "../help-resources.js";
import { helpPointer } from "../help.js";
import { outputSchemas } from "../outputs.js";
import type { ToolContext } from "../tools/context.js";
import { guarded } from "../tool-adapter.js";
import { inputSchema, setTitleOperation } from "../tools/set-title.js";

export function registerSetTitle(server: ToolRegistrar, context: ToolContext): void {
  server.registerTool("set_title", {
    title: "Rename a document",
    description:
      "Replace the document's title. A title is rewritten rather than patched, so there is nothing to splice " +
      "here and no `old_text` to assert. Identity is the uuid and a rename never touches it, so every link, " +
      "backlink and annotation survives one.\n\n" +
      "`meta.title` in the document is authoritative and the directory stub caches it. This writes the document " +
      "and the stub follows in the same call, so the next search and get_sidebar answer with the new title " +
      "without opening a single document room. list_docs does too.\n\n" +
      "An empty title, and a title of nothing but whitespace, are both refused: a document nobody can name is a " +
      "document nobody can pick out of a listing." +
      helpPointer("set_title"),
    outputSchema: outputSchemas.set_title,
    inputSchema,
  }, guarded("set_title", context, setTitleOperation));
}

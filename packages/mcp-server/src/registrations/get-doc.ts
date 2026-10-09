import type { ToolRegistrar } from "../help-resources.js";
import { failureContract } from "../failures.js";
import { outputSchemas } from "../outputs.js";
import type { ToolContext } from "../tools/context.js";
import { DECISION_AUTHORITY, DECISION_EDGES, LIFECYCLE_RECORDS_STATE } from "../tools/descriptions.js";

import { guarded } from "../tool-adapter.js";
import { inputSchema, getDocOperation } from "../tools/get-doc.js";

export function registerGetDoc(server: ToolRegistrar, context: ToolContext): void {
  server.registerTool("get_doc", {
    title: "Read a document",
    description:
      "Read a document's metadata — including `description` and the person-facing `tldr`, each null when nobody " +
      "has written one — its blocks " +
      "and its annotation threads. Lifecycle documents include `kind` and their compatible `status`; ordinary " +
      "documents omit both. " +
      "When structured data exists, `data` lists collection names and record counts and names `get_data` " +
      "for deliberate reads. It contains no schemas or record values; documents without data omit it. " +
      LIFECYCLE_RECORDS_STATE +
      "\n\n" +
      DECISION_EDGES +
      "\n\n" +
      DECISION_AUTHORITY +
      "\n\n" +
      "Every block carries a `rev` content hash — pass it back to edit_block to assert nothing changed since this read.\n\n" +
      "For a table, `text` is canonical GFM with cell formatting as inline markdown, literal punctuation and pipes " +
      "escaped, and every row padded to the widest row; `rev` includes that formatting. For other blocks `text` " +
      "is plain text and `rev` ignores marks. A prose block that carries inline references to other " +
      "documents also carries `doc_links`: `[{start, end, docId}]` in characters, the same offsets annotate and " +
      "link_range speak in, and absent where there are none. Table cell links count toward backlinks but do not " +
      "have block-level `doc_links` ranges.\n\n" +
      "Reading eligible guidance with get_doc counts toward this process’s briefing. The last required read " +
      "starts a ten-minute lease; expiry requires fresh reads. This best-effort memory never fails the read " +
      "or writes usage to a room or update log, and is lost on restart." +
      failureContract("get_doc"),
    outputSchema: outputSchemas.get_doc,
    inputSchema,
  }, guarded("get_doc", context, getDocOperation));
}

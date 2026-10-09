import type { ToolRegistrar } from "../help-resources.js";
import { failureContract } from "../failures.js";
import { outputSchemas } from "../outputs.js";
import type { ToolContext } from "../tools/context.js";
import { DECISION_AUTHORITY, LIFECYCLE_RECORDS_STATE } from "../tools/descriptions.js";

import { guarded } from "../tool-adapter.js";
import { inputSchema, listDocsOperation } from "../tools/list-docs.js";

export function registerListDocs(server: ToolRegistrar, context: ToolContext): void {
  server.registerTool("list_docs", {
    title: "List documents",
    description:
      "Documents in the workspace, from the synced directory document — never from locally observed creations. " +
      "The unfiltered orientation listing omits `kind: \"decision\"` records. Pass any `kind`, `status` or `tag` " +
      "predicate to ask for its exact matches, including matching decisions; `kind: \"decision\"` lists decision " +
      "topics with one row per topic. Each row presents the record in force, else a pending record, else the first record, " +
      "and names all pending records and all conflicting maximal decided records. `inForce: null` means no answer is in force. " +
      "A status or tag predicate matches a topic if any live record matches; each predicate may match a different live record. Resolution still uses its whole graph. " +
      "`include_superseded: true` returns every record with predicates applied per record. `include_deleted` admits archived topics but is not a predicate and does not lift the default omission, " +
      "so an archived decision needs it together with a matching predicate. A fresh replica can list the whole " +
      "corpus once the directory room has synced.\n\n" +
      "`description` is the document's own one-or-two-sentence description, cached in the stub so this listing " +
      "answers with it without opening a single room — read it before deciding what to get_doc. It is null for a " +
      "document nobody has described yet; documents created in the web UI start that way, and set_description " +
      "fixes one.\n\n" +
      "`pinned` says whether the sidebar carries the document as an entry point — derived from the sidebar doc, " +
      "read with get_sidebar. Unpinned documents are fully alive; the flag separates entry points from the long tail.\n\n" +
      "`createdAt` and `updatedAt` are epoch milliseconds, present only where known — sort keys, not history. " +
      "`updatedAt` says when someone changed the document, not when a replica noticed: each replica stamps only for " +
      "the changes it made itself, so a document you never edit keeps the stamp its editor wrote. Concurrent stamps " +
      "resolve to the greater value, so a future-skewed clock pins the hint until a later stamp exceeds it. It is also " +
      "deliberately coarse — at most one re-stamp every few minutes of its own edits, immediately on a title or tag " +
      "change. Both come from the clock of whichever replica wrote them, so treat them " +
      "as approximate, and expect either to be missing on a stub written before they existed.\n\n" +
      "Lifecycle documents include `kind` and their compatible `status`; ordinary documents omit both. " +
      "The optional `kind` and `status` filters are answered from those directory stubs without opening a " +
      "document room, and combine with `tag`. A tag filter accepts a catalog id or exact current name; a value " +
      "this catalog does not have is refused rather than answered with an empty listing. Each " +
      "returned assignment carries its canonical id, current name (or null while unresolved), and active, retired " +
      "or unresolved state. " +
      LIFECYCLE_RECORDS_STATE +
      "\n\n" +
      DECISION_AUTHORITY +
      failureContract("list_docs"),
    outputSchema: outputSchemas.list_docs,
    inputSchema,
  }, guarded("list_docs", context, listDocsOperation));
}

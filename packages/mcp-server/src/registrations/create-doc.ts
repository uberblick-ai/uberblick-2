import type { ToolRegistrar } from "../help-resources.js";
import { helpPointer } from "../help.js";
import { outputSchemas } from "../outputs.js";
import type { ToolContext } from "../tools/context.js";
import { guarded } from "../tool-adapter.js";
import { inputSchema, createDocOperation } from "../tools/create-doc.js";

export function registerCreateDoc(server: ToolRegistrar, context: ToolContext): void {
  server.registerTool("create_doc", {
    title: "Create a document",
    description:
      "Create a document and stub; optional blocks and regular-page TL;DR. Nonblank title/description required. " +
      "Tags use active ids/exact names; unknown/retired refuse. Kind defaults to its first status; invalid pairs refuse. " +
      "Decisions use one to three short answer blocks and a brief reason; guidance belongs on the related page, " +
      "discussion in an RFC. TL;DR, unsupported/excess blocks refuse. Open/decided only; deciding needs valid " +
      "nonblank blocks without TL;DR/data, and successors need a person's recorded answer. related selects a " +
      "live, locally readable regular page; successors inherit unless supplied. supersedes names a hydrated " +
      "decision in a live topic. Invalid targets refuse before writes. discussion connects a live, " +
      "readable non-decision RFC UUID. Reuse or create the RFC first; new workspaces have an ordinary rfc tag. " +
      "Discussion never inherits; " +
      "set_metadata corrects/clears only while open, then it is fixed. Connecting leaves RFC and page untouched. " +
      "Discussion differs from curated links and recorded answer {who, when, where}. Sidebar uses an existing " +
      "get_sidebar group id; invalid ids give group_not_found and create nothing; omit to stay unpinned. " +
      "Independent rooms: persistence_failed names uuid, completed/failed rooms, rolledBack: false and recovery " +
      "avoiding duplicates. answerPreview uses legacy TL;DR/first paragraph/list; discussion is UUID/null, " +
      "absent if unknown. Page get_doc marks topics related or linked." +
      helpPointer("create_doc"),
    outputSchema: outputSchemas.create_doc,
    inputSchema,
  }, guarded("create_doc", context, createDocOperation));
}

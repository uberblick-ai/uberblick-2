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
      "Create doc/stub; optional blocks/regular-page TL;DR. Require nonblank title/description. " +
      "Active tag ids/exact names; unknown/retired refuse. Kind defaults to first status; invalid pairs refuse. " +
      "Before creating a decision topic, consult get_help({topic: \"lifecycle\"}) for when to create a record. " +
      "For decision answers, see lifecycle's Decision answers and topics section. " +
      "Unsupported/excess blocks/TL;DR refuse. Open/decided; deciding needs valid nonblank blocks, no TL;DR/data; decided successors need recorded human answer. " +
      "related: live, locally readable regular page; successors inherit unless supplied. supersedes: hydrated decision in live topic. Targets validated pre-write. " +
      "discussion: live, readable non-decision RFC UUID; reuse/create first; ordinary rfc tag in new workspaces. Never inherited; set_metadata corrects/clears while open, then fixed. RFC/page untouched. Separate from curated links/recorded answer {who, when, where}. " +
      "Sidebar: get_sidebar group id; invalid = group_not_found, no creation; omit = unpinned. Independent rooms: persistence_failed: uuid, completed/failed, rolledBack: false, duplicate-safe recovery. " +
      "Decisions have no TL;DR; answerPreview: first answer paragraph/list; discussion UUID/null, absent if unknown. Page get_doc: related/linked topics." +
      helpPointer("create_doc"),
    outputSchema: outputSchemas.create_doc,
    inputSchema,
  }, guarded("create_doc", context, createDocOperation));
}

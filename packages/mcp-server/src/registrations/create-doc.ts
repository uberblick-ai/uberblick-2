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
      "Create doc/stub; optional blocks/regular-page TL;DR. Require nonblank description; title is required except for successors. " +
      "A decision topic has one title stored on its first record. Renaming any record renames the topic. Successors inherit it: omit title or supply the same title; another refuses. " +
      "List-item seeds: bullet/ordered list, integer indent 0–3 (defaults bullet/0). " +
      "Active tags by id/name (case ignored); unknown/retired refuse. Kind defaults first status; invalid pairs refuse. " +
      "Before creating a decision topic, consult get_help({topic: \"lifecycle\"}) for when to create a record. " +
      "For decision answers, see lifecycle's Decision answers and topics section. " +
      "Open/decided only; deciding needs supported nonblank answer blocks, no TL;DR/data; decided successors require recorded human answer. " +
      "related: live readable regular page; inherited unless supplied. supersedes: hydrated decision in live topic. Targets validated pre-write. " +
      "discussion: live, readable regular RFC UUID; reuse/create first. Never inherited; set_metadata corrects/clears while open, then fixed. RFC/page untouched. Separate from curated links/recorded answer. " +
      "Sidebar: get_sidebar group id; invalid = group_not_found, no creation; omit = unpinned. Independent rooms: persistence_failed: uuid, completed/failed, rolledBack: false, duplicate-safe recovery. " +
      "answerPreview: first answer paragraph/list. Page get_doc: related/linked topics." +
      helpPointer("create_doc"),
    outputSchema: outputSchemas.create_doc,
    inputSchema,
  }, guarded("create_doc", context, createDocOperation));
}

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
      "Create a document and directory stub with optional seed blocks and regular-page TL;DR. Nonblank title " +
      "and description are required. Tags select active catalog ids or exact names; unknown or retired " +
      "selections refuse creation. A kind defaults to its first status; incompatible kind/status refuses. " +
      "Decisions use one to three short answer blocks with a brief reason, with guidance on the related " +
      "regular page and discussion in an RFC; they refuse TL;DR, unsupported blocks and excess answer blocks. " +
      "related selects one live, locally readable regular page; successors inherit it unless another is given. " +
      "Decisions start open or decided; deciding requires a non-blank valid answer without TL;DR or data. " +
      "supersedes names a hydrated decision in a live topic. Invalid targets or a decided successor without " +
      "a person's answer refuse before writes. Optional sidebar placement pins into a get_sidebar group id; " +
      "unknown or empty ids return group_not_found and create nothing. Omit placement to create unpinned. " +
      "Rooms persist independently; partial persistence_failed carries uuid, completed and failed rooms, " +
      "rolledBack: false and stage-aware recovery that avoids duplicate creation. Directory answerPreview uses " +
      "legacy TL;DR or the first paragraph/list; page get_doc reads mark topics related or linked. Answer " +
      "blocks differ from recorded answer attribution {who, when, where}." +
      helpPointer("create_doc"),
    outputSchema: outputSchemas.create_doc,
    inputSchema,
  }, guarded("create_doc", context, createDocOperation));
}

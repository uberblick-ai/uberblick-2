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
      "Create a document and its directory stub, with optional seed blocks and TL;DR. Requires nonblank title " +
      "and description. Tags select active catalog ids or exact names; unknown or retired selections refuse " +
      "before creation. A kind defaults to its first status; incompatible kind/status combinations refuse. " +
      "Decisions start open or decided; governs requires a live, hydrated requirement, and supersedes a " +
      "hydrated decision in a live topic. Invalid targets and a decided successor without a person's answer " +
      "refuse before any room is written. Optional sidebar placement pins into an existing group id from " +
      "get_sidebar; an unknown or empty id returns group_not_found and creates nothing. Omit placement to " +
      "create unpinned. The answer reports each independently persisted room; writes are not transactional. A " +
      "partial persistence_failed carries uuid, completed and failed rooms, rolledBack: false and stage-aware " +
      "recovery: follow it to finish without creating a duplicate." +
      helpPointer("create_doc"),
    outputSchema: outputSchemas.create_doc,
    inputSchema,
  }, guarded("create_doc", context, createDocOperation));
}

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { outputSchemas } from "../outputs.js";
import type { ToolContext } from "../tools/context.js";
import { DECIDED_IS_READ_ONLY, DECISION_AUTHORITY, DESCRIPTION_IS_FOR_CHOOSING, LIFECYCLE_RECORDS_STATE, SYNCED_MEANS } from "../tools/descriptions.js";

const CREATE_DOC_PLACEMENT =
  "`sidebar` is optional and is the only way to say where the document goes: omit it and the document is created " +
  "unpinned (the default, unchanged), or pass `{group: {id, position?}}` to pin it into a group that ALREADY " +
  "exists — the id comes from get_sidebar, `position` is clamped into range and omitted means last. There is no " +
  "`pinned` flag and no `state`: placement implies pinning, so a contradiction cannot be expressed. An unknown or " +
  "empty group id fails with `group_not_found` and creates nothing at all; this tool never creates a group, never " +
  "resolves one by name, and never guesses a default — pin_doc is what brings a group into being. The answer " +
  "echoes the placement it made as `sidebar: {group: {id, name}, position}`.";

const CREATE_DOC_DURABILITY =
  "This call writes up to three independently persisted rooms — the document, the directory, and the " +
  "sidebar when you place it — so it reports them one by one. The governing requirement is never written. " +
  "`rooms` lists every room it touched with its own `applied` and `synced`; the top-level `synced` is the AND over " +
  "all of them and is never true while one is still pending. It is NOT transactional: there is no rollback and " +
  "no remote atomicity. If the local update log refuses a write part-way, the call fails with `persistence_failed` " +
  "carrying the `uuid`, the rooms already `completed`, the `failed` room, `rolledBack: false`, and a stage-aware " +
  "`recovery` line — the earlier rooms stay durable, and recovery never risks creating the decision twice.";

import { guarded } from "../tool-adapter.js";
import { inputSchema, createDocOperation } from "../tools/create-doc.js";

export function registerCreateDoc(server: McpServer, context: ToolContext): void {
  const { toolContract } = context;
  server.registerTool("create_doc", {
    title: "Create a document",
    description:
      "Create a document and publish its directory stub, so every client can discover it through list_docs or " +
      "search; a decision needs a matching `kind`, `status` or `tag` predicate in list_docs. " +
      "Blocks are optional: pass them to seed the document, or add them later with insert_block. " +
      "Optional `tldr` supplies the decision line before a decided record freezes it, under set_tldr rules and limit. " +
      "When the call seeds at least one block and stays editable, its answer carries the non-blocking TL;DR review reminder; " +
      "a metadata-only create carries no such reminder. " +
      "The write applies to the local replica and syncs in the background.\n\n" +
      "`tags` is a complete assignment set of active catalog ids or exact active names. Names are selectors; " +
      "the document stores canonical ids and the answer resolves each id beside its current name. An unknown or " +
      "retired selection refuses the whole call before a document exists; list_tags is the active vocabulary.\n\n" +
      "A `title` and a `description` are both REQUIRED here and the call fails without either, creating nothing. " +
      "A title cannot be empty or whitespace: an untitled document cannot be picked out of a listing, and " +
      "set_title is the repair for the untitled ones the web UI creates. " +
      DESCRIPTION_IS_FOR_CHOOSING +
      "\n\n" +
      "Pass `kind` to create a lifecycle document. Its `status` defaults to that kind's first state; `status` " +
      "without `kind`, or a status owned by the other kind, is refused before a document is created. " +
      LIFECYCLE_RECORDS_STATE +
      " A decision may pass `governs`, the UUID of a live, hydrated requirement in this replica. The decision " +
      "stores `governs` in its own metadata; the requirement's decision log is derived from directory stubs. Any other use " +
      "of `governs` is refused before a UUID is allocated or a room is written. " +
      "A decision may also pass `supersedes`, the UUID of a hydrated decision in a live topic it replaces. The " +
      "reference is immutable, and its predecessor's topic is copied forward; a first record uses its own UUID as topic. " +
      "`topic` is never an input. Supersession is returned by get_doc and is a derived link: backlinks on the earlier " +
      "decision exposes every successor without editing that earlier document. A non-decision target or a " +
      "self-reference is refused before any room is written. An archived predecessor topic is refused with " +
      "`doc_archived` before a UUID is allocated or a room is written; restore the topic before reconsidering it. " +
      "Decisions are created only `open` or `decided`; rejected and withdrawn records must first exist as proposals. " +
      "A decided successor without an answer is refused before allocating a UUID or writing any room. " +
      DECISION_AUTHORITY +
      "\n\n" +
      DECIDED_IS_READ_ONLY +
      "\n\n" +
      CREATE_DOC_PLACEMENT +
      "\n\n" +
      CREATE_DOC_DURABILITY +
      "\n\n" +
      SYNCED_MEANS +
      toolContract("create_doc"),
    outputSchema: outputSchemas.create_doc,
    inputSchema,
  }, guarded("create_doc", context, createDocOperation));
}

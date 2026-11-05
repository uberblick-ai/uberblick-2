/**
 * Every registered tool, in tools/list order. Registration, MCP annotations,
 * failure payloads and per-tool help read this table; each operation's wrapper
 * fixes what it writes. SDK-free, so callers without MCP use the same entries.
 */
import type { z } from "zod";
import { helpPointer } from "./help.js";
import { toolHelpDetails } from "./help-details.js";
import { outputSchemas } from "./outputs.js";
import {
  getSidebarInput,
  getSidebarOperation,
  pinDocInput,
  pinDocOperation,
  sidebarGroupInput,
  sidebarGroupOperation,
  unpinDocInput,
  unpinDocOperation,
} from "./sidebar-tools.js";
import { inputSchema as annotateInput, annotateOperation } from "./tools/annotate.js";
import { inputSchema as archiveDocInput, archiveDocOperation } from "./tools/archive-doc.js";
import { inputSchema as backlinksInput, backlinksOperation } from "./tools/backlinks.js";
import { inputSchema as createDocInput, createDocOperation } from "./tools/create-doc.js";
import { inputSchema as createTagInput, createTagOperation } from "./tools/create-tag.js";
import { inputSchema as deleteBlockInput, deleteBlockOperation } from "./tools/delete-block.js";
import { inputSchema as deleteDocInput, deleteDocOperation } from "./tools/delete-doc.js";
import { inputSchema as editBlockInput, editBlockOperation } from "./tools/edit-block.js";
import { inputSchema as editTagInput, editTagOperation } from "./tools/edit-tag.js";
import { inputSchema as exportMarkdownInput, exportMarkdownOperation } from "./tools/export-markdown.js";
import { inputSchema as findDecisionsInput, findDecisionsOperation } from "./tools/find-decisions.js";
import { inputSchema as getDataInput, getDataOperation } from "./tools/get-data.js";
import { inputSchema as getDocInput, getDocOperation } from "./tools/get-doc.js";
import { inputSchema as getHelpInput, getHelpOperation } from "./tools/get-help.js";
import { inputSchema as getRevisionInput, getRevisionOperation } from "./tools/get-revision.js";
import { inputSchema as insertBlockInput, insertBlockOperation } from "./tools/insert-block.js";
import { inputSchema as linkRangeInput, linkRangeOperation } from "./tools/link-range.js";
import { inputSchema as listDocsInput, listDocsOperation } from "./tools/list-docs.js";
import { inputSchema as listTagsInput, listTagsOperation } from "./tools/list-tags.js";
import { inputSchema as listRevisionsInput, listRevisionsOperation } from "./tools/list-revisions.js";
import { inputSchema as moveBlockInput, moveBlockOperation } from "./tools/move-block.js";
import { inputSchema as nameRevisionInput, nameRevisionOperation } from "./tools/name-revision.js";
import { inputSchema as restoreRevisionInput, restoreRevisionOperation } from "./tools/restore-revision.js";
import type { Operation, ToolOperation, Writes } from "./tools/operation.js";
import { inputSchema as restoreDocInput, restoreDocOperation } from "./tools/restore-doc.js";
import { inputSchema as renderBlockInput, renderBlockOperation } from "./tools/render-block.js";
import { inputSchema as searchInput, searchOperation } from "./tools/search.js";
import { inputSchema as setMetadataInput, setMetadataOperation } from "./tools/set-metadata.js";
import { inputSchema as setStatusInput, setStatusOperation } from "./tools/set-status.js";
import { inputSchema as syncStatusInput, syncStatusOperation } from "./tools/sync-status.js";
import { inputSchema as updateDataInput, updateDataOperation } from "./tools/update-data.js";

export type ToolName = keyof typeof outputSchemas;

/** MCP advisory annotations, kept free of SDK types like the rest of the operation path. */
export interface ToolHints {
  readonly readOnlyHint: boolean;
  readonly destructiveHint: boolean;
  readonly idempotentHint: boolean;
  readonly openWorldHint: boolean;
}

export interface Tool {
  readonly name: ToolName;
  readonly title: string;
  /** The registered description, ending with its help pointer. */
  readonly description: string;
  readonly input: z.ZodObject;
  readonly output: z.ZodObject;
  readonly operation: Operation<Record<string, unknown>>;
  readonly writes: Writes;
  readonly annotations: ToolHints;
  readonly example: Record<string, unknown>;
  readonly related: readonly string[];
  readonly details?: string;
}

interface WriteHints {
  readonly destructive: boolean;
  readonly idempotent: boolean;
}

type ToolSpec<Input extends z.ZodObject, W extends Writes> = {
  readonly name: ToolName;
  readonly title: string;
  /** Tool-specific prose; the help pointer is appended. */
  readonly description: string;
  readonly input: Input;
  readonly operation: ToolOperation<z.output<Input>, object, W>;
  readonly example: Record<string, unknown>;
  readonly related: readonly string[];
  readonly details?: string;
} & (W extends null ? { readonly hints?: never } : { readonly hints: WriteHints });

function tool<Input extends z.ZodObject, W extends Writes>(spec: ToolSpec<Input, W>): Tool {
  return {
    name: spec.name,
    title: spec.title,
    description: spec.description + helpPointer(spec.name, spec.related),
    input: spec.input,
    output: outputSchemas[spec.name],
    // ToolSpec ties the operation's Args to input; the SDK parses every call
    // with that input before the operation runs.
    operation: spec.operation as unknown as Operation<Record<string, unknown>>,
    writes: spec.operation.writes,
    // Tools stay within this workspace's replica and hub, including revision reads.
    annotations: {
      readOnlyHint: spec.operation.writes === null,
      destructiveHint: spec.hints?.destructive ?? false,
      idempotentHint: spec.hints?.idempotent ?? true,
      openWorldHint: false,
    },
    example: spec.example,
    related: spec.related,
    ...(spec.details === undefined ? {} : { details: spec.details }),
  };
}

const uuid = "11111111-1111-4111-8111-111111111111";
const targetUuid = "11111111-1111-4111-8111-111111111112";
const documentContracts = ["workspaces", "tool-contracts"];
const decisionContracts = [...documentContracts, "decisions"];
const proseContracts = ["edit_doc", ...decisionContracts, "markdown"];
const dataContracts = [...documentContracts, "data"];

export const tools: readonly Tool[] = [
  tool({
    name: "list_tags",
    title: "List assignable tags",
    description:
      "List existing tag ids, names and LLM usage guidance in name order. complete:false means the hub catalog " +
      "has not arrived. Reuse meanings; tag only to improve discovery, or leave untagged. " +
      "Use create_tag for missing categories and edit_tag to change guidance.",
    input: listTagsInput,
    operation: listTagsOperation,
    example: {},
    related: ["workspaces", "tool-contracts"],
    details: toolHelpDetails.list_tags,
  }),
  tool({
    name: "create_tag",
    title: "Create or reuse a tag",
    description:
      "Create a missing workspace catalog tag. Read list_tags and check complete: an incomplete catalog can hide " +
      "existing or deleted names. Reuse meanings; keep a small vocabulary of reusable subjects/purposes, avoiding " +
      "synonyms and one-off task, file, issue or version tags. Tag only to improve discovery, or leave untagged. " +
      "Names trim and lowercase; an existing name returns its canonical entry without changing LLM usage guidance " +
      "(use edit_tag). Assigns no documents. Retains Workspace settings permissions/offline recovery; " +
      "local workspaces need no hub or sign-in.",
    input: createTagInput,
    operation: createTagOperation,
    hints: { destructive: false, idempotent: true },
    example: { name: "release", description: "Use for release planning and coordination across versions." },
    related: ["list_tags", ...documentContracts],
    details: toolHelpDetails.create_tag,
  }),
  tool({
    name: "edit_tag",
    title: "Edit a tag's usage guidance",
    description:
      "Replace an existing tag's LLM usage guidance. Read list_tags and check complete; use its id and keep its " +
      "meaning, name and document assignments. Never creates tags. Null/blank clears; identical edits do nothing. " +
      "Keep a small subject/purpose vocabulary, avoiding synonyms and one-off task, file, issue or version tags. " +
      "Use guidance when tags improve discovery; documents may remain untagged. Workspace settings still govern " +
      "permissions and offline recovery; a local workspace needs neither hub nor sign-in.",
    input: editTagInput,
    operation: editTagOperation,
    hints: { destructive: true, idempotent: true },
    example: { id: targetUuid, description: "Use for release planning and coordination across versions." },
    related: ["list_tags", "create_tag", ...documentContracts],
    details: toolHelpDetails.edit_tag,
  }),
  tool({
    name: "create_doc",
    title: "Create a document",
    description:
      "Create a regular page or a decision record, optionally with starting blocks, tags, a TL;DR (regular " +
      "pages only) and a sidebar pin. A description is required, and a title except on a decision successor, " +
      "which takes its topic's title. References are checked before writing; refusals create nothing. " +
      "Create a decision record only for a significant, lasting choice with meaningful alternatives that " +
      "current guidance doesn't settle; routine details belong on the owning regular page. Its answer " +
      "states only the decision, in about 60 words; reasoning and alternatives go in the linked discussion " +
      "RFC. The document, directory and sidebar are separate writes; persistence_failed reports completed " +
      "rooms and duplicate-safe recovery.",
    input: createDocInput,
    operation: createDocOperation,
    // Adds a fresh document and optional pin; repeating adds another document.
    hints: { destructive: false, idempotent: false },
    example: {
      title: "Release checklist",
      description: "The steps and checks used to prepare a product release.",
      blocks: [{
        type: "list-item", text: "Review the release notes before publishing.", list: "ordered", indent: 0,
      }],
    },
    related: proseContracts,
    details: toolHelpDetails.create_doc,
  }),
  tool({
    name: "get_doc",
    title: "Read a document",
    description:
      "Read live metadata, blocks with edit-assertion rev hashes, table column_widths, comment threads and decision context. " +
      "Creation time createdAt and decision entries' createdAt/updatedAt are ISO 8601 UTC strings when known and representable. " +
      "Data lists collections/counts; use get_data for records. Use get_revision for a historical state.",
    input: getDocInput,
    operation: getDocOperation,
    example: { uuid },
    related: [...proseContracts, "data"],
    details: toolHelpDetails.get_doc,
  }),
  tool({
    name: "render_block",
    title: "Render an Ablauf drawing",
    description:
      "View one ablauf code block as a PNG image (default 1000 px wide) or standalone SVG text, with drawing diagnostics. " +
      "PNG dimensions are bounded to 4,000,000 pixels before raster allocation; reduce width or request SVG when refused. " +
      "Uses the renderer's light palette and bundled Geist Mono. Inspect the image after writing and fix crowded or crossing geometry.",
    input: renderBlockInput,
    operation: renderBlockOperation,
    example: { uuid, block_id: "<block-id>" },
    related: [...documentContracts, "ablauf"],
    details: toolHelpDetails.render_block,
  }),
  tool({
    name: "list_revisions",
    title: "List document revisions",
    description:
      "List this computer's cached revision catalog newest first, including archived documents, with cache freshness. " +
      "Missing history downloads when connected; cached reads work offline. Use refresh: true to check an unknown mutation outcome. " +
      "IDs work with get_revision/get_data/restore_revision. Empty means a complete downloaded catalog has no history.",
    input: listRevisionsInput,
    operation: listRevisionsOperation,
    example: { uuid },
    related: documentContracts,
    details: toolHelpDetails.list_revisions,
  }),
  tool({
    name: "name_revision",
    title: "Name the current document revision",
    description:
      "Name the current synchronized state only when a person asks. Requires team-hub write access; " +
      "closes its stretch. One name per revision; manage it in the web. " +
      "Decision records can be named in any status.",
    input: nameRevisionInput,
    operation: nameRevisionOperation,
    hints: { destructive: false, idempotent: true },
    example: { uuid, name: "Reviewed after auth rewrite" },
    related: documentContracts,
    details: toolHelpDetails.name_revision,
  }),
  tool({
    name: "restore_revision",
    title: "Restore a document revision",
    description:
      "Restore title, blocks and data from a hub revision as a new revision. Requires synchronized write access " +
      "to a live document; history and other metadata stay. An identical state writes nothing. " +
      "A decided decision record refuses with decision_read_only.",
    input: restoreRevisionInput,
    operation: restoreRevisionOperation,
    hints: { destructive: true, idempotent: true },
    example: { uuid, revision: "revision-id-from-list_revisions" },
    related: documentContracts,
    details: toolHelpDetails.restore_revision,
  }),
  tool({
    name: "get_revision",
    title: "Read a document revision",
    description:
      "Read a cached revision from list_revisions: title, visible blocks without rev, data summary and cache freshness. " +
      "Missing snapshots download when connected; downloaded history works offline. Archived documents work. Page records with get_data and the same revision.",
    input: getRevisionInput,
    operation: getRevisionOperation,
    example: { uuid, revision: "revision-id-from-list_revisions" },
    related: [...documentContracts, "data"],
    details: toolHelpDetails.get_revision,
  }),
  tool({
    name: "get_data",
    title: "Read document data",
    description:
      "Read a data summary, or name collection for bounded records and diagnostics. limit: 0 reads schema; " +
      "follow next_after until complete. Optional revision reads this computer's cached snapshot using an ID from list_revisions, " +
      "fetching it when connected if missing, including archived documents; omission reads live data. Live data and open revisions can change between calls.",
    input: getDataInput,
    operation: getDataOperation,
    example: { uuid, collection: "tasks", limit: 20 },
    related: dataContracts,
    details: toolHelpDetails.get_data,
  }),
  tool({
    name: "update_data",
    title: "Update document data",
    description:
      "Apply one validated batch of changes to a document's structured data, naming each touched collection " +
      "once. Within a collection the steps run in order: set `schema`, optionally `replaceRecords`, then " +
      "`deleteRecords`, then `upsert` whole `{id, value}` records; `deleteCollection: true` excludes other " +
      "changes. Schema and value JSON are validated as sent, and unsupported schemas or invalid retained " +
      "records refuse before anything changes. The batch is one local transaction; an identical refresh " +
      "returns `changed: false` without writing. The result summarizes touched collections, record counts " +
      "and deletions with durability, without values.\n\n" +
      "Refresh producer-owned collections by upsert or full-set replacement, and keep human dispositions in " +
      "a separate collection keyed by producer record ids. Split changes above the 1 MiB schema/value " +
      "budget across calls; separate calls are not atomic together and offer no compare-and-swap or lock. " +
      "Read records with get_data. Decision records refuse data with decision_data_unsupported, decided " +
      "records refuse it with decision_read_only, and legacy data stays readable.",
    input: updateDataInput,
    operation: updateDataOperation,
    // Replaces, upserts and deletes data; an identical repeat reports changed: false.
    hints: { destructive: true, idempotent: true },
    example: {
      uuid,
      operations: [{
        collection: "tasks",
        schema: {
          version: 1,
          schema: {
            type: "object",
            properties: {
              title: { type: "string" },
              done: { type: "boolean" },
            },
            required: ["title", "done"],
            additionalProperties: false,
          },
        },
        upsert: [{ id: "review-notes", value: { title: "Review release notes", done: false } }],
      }],
    },
    related: dataContracts,
  }),
  tool({
    name: "list_docs",
    title: "List documents",
    description:
      "List documents from this replica's directory, including local writes the hub has not acknowledged " +
      "yet, without opening document rooms. Rows carry uuid, title, tags, description, updatedAt (ISO 8601 " +
      "UTC when known and representable), openThreadCount (absent when unknown) and pinned. Unfiltered " +
      "listings omit decisions; kind, status, tag and has_open_threads include them. A decision topic row " +
      "shows the record in force, else pending, else first, with status, topic, discussion, answerPreview " +
      "and inForce/pending/conflicts UUIDs. include_superseded lists every record; include_deleted adds " +
      "archived rows (`deleted: true`). Filters combine; unknown tags refuse; has_open_threads accepts only " +
      "true. get_doc reads code checks, threads and lifecycle details.",
    input: listDocsInput,
    operation: listDocsOperation,
    example: { kind: "decision", status: "open" },
    related: decisionContracts,
    details: toolHelpDetails.list_docs,
  }),
  tool({
    name: "search",
    title: "Search documents",
    description:
      "Find live documents matching any query word in titles, descriptions, content, assigned tag names or code block languages. " +
      "English word forms match; case/accents fold, underscores join adjacent words, trailing * matches stem prefixes. " +
      "Use whole words or short prefixes: `decisi*` can miss `decision`, unlike `decis*`. Punctuation/emoji alone " +
      "matches nothing. Title-weighted bm25 ranks without strict title-first or matched-word-count order. " +
      "kind narrows to regular documents or decisions. tag accepts a catalog id/current name (case ignored) " +
      "or list: any listed tag matches, more boost relevance; unknown tags refuse. Hits carry kind and canonical " +
      "tags; decisions carry current state, including superseded/conflict. No hits proves neither an empty index " +
      "nor replica completeness. Ask whether to create a missing needed page.",
    input: searchInput,
    operation: searchOperation,
    example: { query: "release checklist", kind: "regular", tag: ["mcp", "cli"], limit: 10 },
    related: decisionContracts,
    details: toolHelpDetails.search,
  }),
  tool({
    name: "backlinks",
    title: "Documents linking here",
    description:
      "Documents that reference this one, by UUID and never by path or title. The answer is the union of two " +
      "kinds of edge, which it does not distinguish: the curated doc-level `links` set_metadata owns, and every " +
      "inline reference in a prose block or table cell — written by link_range, an `inline` run, or a table " +
      "cell's inline markdown. A citation needs no `links` entry to appear here.\n\n" +
      "Each one carries its `description` — null where it has none — so a citing document can be judged without opening it.",
    input: backlinksInput,
    operation: backlinksOperation,
    example: { uuid },
    related: documentContracts,
  }),
  tool({
    name: "find_decisions",
    title: "Find decisions linking a GitHub item",
    description:
      "Find live decision records whose prose links one GitHub issue or PR, using this replica's derived index " +
      "without opening document rooms or calling GitHub. Only external link hrefs in prose count; labels, " +
      "unlinked text and source blocks do not. Pass github_ref as owner/repo#n or an http(s) github.com " +
      "/issues/n or /pull/n URL. Equivalent case/path spellings and suffixes normalize to the same identity; " +
      "bare #n and other hosts refuse with invalid_github_reference. Returns every indexed live matching record " +
      "once, ordered by title under SQLite binary collation then UUID, without pagination or topic resolution. " +
      "Archived records are omitted. Results may lag unseen or unindexed content; an empty array does not prove " +
      "replica completeness.",
    input: findDecisionsInput,
    operation: findDecisionsOperation,
    example: { github_ref: "example/project#42" },
    related: decisionContracts,
    details: toolHelpDetails.find_decisions,
  }),
  tool({
    name: "edit_block",
    title: "Edit one block",
    description:
      "Change one block's text by diff-and-splice, so concurrent edits elsewhere in the block survive; a " +
      "list item's `list` and `indent` can also change in place. Assert `old_text` and preferably the `rev` " +
      "from get_doc: a mismatch refuses with stale_block or old_text_mismatch and returns currentText and " +
      "currentRev to re-diff against. The assertion checks this replica only. A splice that touches a " +
      "formatting mark's edge can re-anchor the mark, so check formatted text with export_markdown " +
      "afterwards. An edit that would remove an open thread's last anchor refuses with " +
      "open_thread_anchored; resolve the thread or move its anchor with annotate first. Tables take GFM and " +
      "need `table_mapping` for structural or multi-cell edits; `column_widths` sizes columns (see markdown help). Card and Figma blocks take their `:::` " +
      "content and cannot be converted to or from other types. New document-link targets must be known to " +
      "this replica.",
    input: editBlockInput,
    operation: editBlockOperation,
    // Replaces text; table_mapping can replace rows again under identical text and rev.
    hints: { destructive: true, idempotent: false },
    example: {
      uuid,
      block_id: "list-item-1",
      old_text: "Confirm the final checks passed.",
      new_text: "Confirm the final checks passed.",
      rev: "revision-from-get_doc",
      indent: 1,
    },
    related: proseContracts,
    details: toolHelpDetails.edit_block,
  }),
  tool({
    name: "insert_block",
    title: "Insert blocks",
    description:
      "Insert a nonempty blocks array consecutively after after_block_id, or first when omitted. Entries match create_doc; " +
      "one block is a one-entry array. Returns ordered blocks with id/rev. Every entry is checked before writing: " +
      "refusals retain their code and name the 1-based entry_index; nothing is written. Decision answers " +
      "must keep their supported shape across the batch. Success sends one document update and moves the cursor " +
      "once to the final block's stored text end. Adjacent list-item entries take list/indent (bullet/0 by " +
      "default). Container syntax goes in text; chart source stays literal. Document-link targets must be " +
      "known locally. Tables accept column_widths; sizing, links and GitHub references are in markdown help.",
    input: insertBlockInput,
    operation: insertBlockOperation,
    // Adds blocks; repeating adds another batch.
    hints: { destructive: false, idempotent: false },
    example: {
      uuid,
      after_block_id: "list-item-1",
      blocks: [{
        type: "list-item",
        text: "Confirm the final checks passed.",
        list: "ordered",
        indent: 2,
      }],
    },
    related: proseContracts,
    details: toolHelpDetails.insert_block,
  }),
  tool({
    name: "move_block",
    title: "Move blocks",
    description:
      "Reorder existing blocks after after_block_id, or first when omitted/null, in block_ids order. " +
      "Preserves ids, revs, content, attributes and comment anchors in one update; invalid moves write nothing. " +
      "Concurrent edits or new comments on moved blocks before their replica receives the move are dropped, including offline edits.",
    input: moveBlockInput,
    operation: moveBlockOperation,
    hints: { destructive: true, idempotent: true },
    example: { uuid, block_ids: ["heading-1", "paragraph-2"], after_block_id: "paragraph-3" },
    related: proseContracts,
    details: toolHelpDetails.move_block,
  }),
  tool({
    name: "delete_block",
    title: "Delete a block",
    description:
      "Delete one block. Deleting is never how a block changes type — use insert_block plus edit_block only for " +
      "new content, and never delete-and-reinsert to re-type, which churns the block id and orphans its " +
      "annotations. Refuses with open_thread_anchored if any open thread would lose its last document anchor. " +
      "Use annotate to resolve that thread or move its anchor before deleting. Use move_block to reorder blocks.",
    input: deleteBlockInput,
    operation: deleteBlockOperation,
    // Removes a block; repeating finds no block to remove.
    hints: { destructive: true, idempotent: true },
    example: { uuid, block_id: "paragraph-1" },
    related: proseContracts,
    details: toolHelpDetails.delete_block,
  }),
  tool({
    name: "set_metadata",
    title: "Set document metadata together",
    description:
      "Change one or more of a document's title, description, TL;DR, tags, curated links and code check, or " +
      "an open decision's discussion RFC. Name at least one field; omitted fields keep their values. The " +
      "call is all or nothing: a refusal writes none of the named fields and names the failing `field`. " +
      "Tags and links replace the whole set, and `[]` clears it. Title and description cannot be cleared; " +
      "`tldr: null` clears the TL;DR. Decision records take no TL;DR or code check, and decided records " +
      "also refuse discussion. Archived documents refuse every field; lifecycle status belongs to " +
      "set_status.",
    input: setMetadataInput,
    operation: setMetadataOperation,
    // Replaces named fields and sets; repeating a code check records a new time.
    hints: { destructive: true, idempotent: false },
    example: {
      uuid,
      title: "Release preparation checklist",
      description: "The release preparation steps, checks and responsibilities for the team.",
      tldr: "Review the release notes and confirm all checks before publishing.",
      tags: ["Release"],
      links: [targetUuid],
    },
    related: decisionContracts,
    details: toolHelpDetails.set_metadata,
  }),
  tool({
    name: "set_status",
    title: "Set a document's lifecycle status",
    description:
      "Record a document's lifecycle status. On an ordinary document this also adopts the kind that owns the " +
      "status; the result names both, so adoption is never silent. A document that already has a kind accepts " +
      "only that kind's statuses. Its kind is fixed through MCP: if it was adopted in error, retrying with the " +
      "other kind's status cannot change it. An open record can be withdrawn without an answer; decided records " +
      "cannot reopen or withdraw. Rejected and withdrawn are final. Rejection requires a non-empty `reason` and " +
      "a recorded person's answer, and applies only to an open proposal, an agent stance or a decided record in " +
      "a conflict. It stores `rejectionReason`. Validation refusals change nothing.",
    input: setStatusInput,
    operation: setStatusOperation,
    // Overwrites lifecycle and answer; repeating leaves the same state or is refused.
    hints: { destructive: true, idempotent: true },
    example: { uuid, status: "open" },
    related: decisionContracts,
  }),
  tool({
    name: "archive_doc",
    title: "Archive a document",
    description:
      "Archive a document or every record of a decision topic, preserving content and UUID reads while hiding " +
      "directory/search entries and unpinning. unpinned asserts the unpin, not whether a pin was found. " +
      "An unseen concurrent pin may survive; get_sidebar shows it as archived and unpin_doc removes it. " +
      "Restoration uses restore_doc and never re-pins. To delete an archived topic, call delete_doc with topic: true; " +
      "one decision record cannot be deleted on its own yet. Directory/sidebar rooms persist independently without " +
      "rollback. Results name rooms and indexed; persistence_failed names completed/failed rooms and recovery. " +
      "Follow recovery before retrying.",
    input: archiveDocInput,
    operation: archiveDocOperation,
    // Tombstones and unpins; every repeat raises the unpin counter, suppressing later pins.
    hints: { destructive: true, idempotent: false },
    example: { uuid },
    related: documentContracts,
    details: toolHelpDetails.archive_doc,
  }),
  tool({
    name: "delete_doc",
    title: "Permanently delete an archived document",
    description:
      "Permanently delete an archived regular document, or with topic: true an archived decision topic given its " +
      "topic UUID or any record UUID. Every topic record goes, including individually archived records. Deletes " +
      "content, comments, data and history; only permanent UUID deletion evidence remains. Offline restores cannot undo it; " +
      "replicas drop copies and the hub refuses rooms. Live topics/documents refuse with doc_not_archived; deleted " +
      "UUIDs with doc_deleted. A decision UUID " +
      "without topic: true refuses; one decision record cannot be deleted on its own yet. " +
      "Other documents keep stored links. Directory/sidebar writes report independent durability.",
    input: deleteDocInput,
    operation: deleteDocOperation,
    hints: { destructive: true, idempotent: true },
    example: { uuid },
    related: documentContracts,
    details: toolHelpDetails.delete_doc,
  }),
  tool({
    name: "restore_doc",
    title: "Restore an archived document",
    description:
      "Remove one archive layer: restore an archived decision topic first, retaining records archived individually " +
      "beforehand; in a live topic restore the addressed record. The archived result says whether that answer " +
      "remains archived. Restore directory visibility and search indexing, using its recorded " +
      "title and tags. It never restores a sidebar pin; use pin_doc for placement. On an already live regular document " +
      "it can repair a drifted directory stub. Check indexed: false means this replica lacks the content or its " +
      "index write failed. The restore still applies and replicates; search catches up when content arrives or " +
      "a later call retries. Offline content arrival requires hub recovery.",
    input: restoreDocInput,
    operation: restoreDocOperation,
    // Removes one archive layer; repeating can restore a previously archived record.
    hints: { destructive: true, idempotent: false },
    example: { uuid },
    related: documentContracts,
    details: toolHelpDetails.restore_doc,
  }),
  tool({
    name: "annotate",
    title: "Comment, reply, resolve, move, edit or delete your comment",
    description:
      "Open with block_id/start/end, reply with thread_id, or move with both; text required, author optional. " +
      "Only replies accept resolved: true; resolving is final, false is refused. Resolved threads refuse replies/moves. " +
      "New threads may cover resolved text, removing every old anchor while retaining the resolved comments. " +
      "Open-thread overlap refuses without writing; moves refuse other threads and replace all their own marks. " +
      "Edit with action: edit, thread_id, comment_id and text; delete permanently with action: delete and both ids. " +
      "Edit/delete require an open thread " +
      "and a stored account matching this session's workspace sign-in GitHub account, ignoring case, including " +
      "agent comments. Deleting the opener requires every reply to be yours. Tables need zero-based row/column " +
      "(header 0); offsets count displayed characters and edge whitespace. Cards/Figma refuse opening/moving in; " +
      "open threads permit replies, resolution and moves to prose/tables.",
    input: annotateInput,
    operation: annotateOperation,
    // Resolving changes thread state; repeating a reply adds another comment.
    hints: { destructive: true, idempotent: false },
    example: {
      uuid,
      block_id: "paragraph-1",
      start: 0,
      end: 6,
      text: "Who will review the release notes?",
    },
    related: proseContracts,
    details: toolHelpDetails.annotate,
  }),
  tool({
    name: "link_range",
    title: "Link a range of a block to another document",
    description:
      "Link selected prose without changing characters/rev. start/end are character offsets at the required " +
      "rev; stale_block returns currentText/currentRev to remeasure. Offsets clamp and swap if reversed; " +
      "empty ranges refuse. Retargets document links; external links, source, tables, cards and Figma refuse. " +
      "Use inline Markdown for card/Figma caption links. doc_id must be in this replica's directory or " +
      "doclink_target_not_known_locally refuses before writing; archived targets work. Returns the target " +
      "title; the label keeps selected text through renames. Updates backlinks, never curated meta.links.",
    input: linkRangeInput,
    operation: linkRangeOperation,
    // Retargets a document link; unchanged rev lets repeats write the same mark.
    hints: { destructive: true, idempotent: true },
    example: {
      uuid,
      block_id: "paragraph-1",
      start: 11,
      end: 24,
      doc_id: targetUuid,
      rev: "revision-from-get_doc",
    },
    related: proseContracts,
    details: toolHelpDetails.link_range,
  }),
  tool({
    name: "export_markdown",
    title: "Export a document as markdown",
    description:
      "Render one document as read-only Markdown for reading, review or checking formatting. Markdown is " +
      "never how documents are stored, and MCP has no Markdown import. The default frontmatter carries " +
      "uuid, title, tags and, when set, description, kind and status; the TL;DR is not exported. Document " +
      "links export as `[label](document-uuid)`. Comments are dropped unless `annotations` is " +
      "`html-comments`, and structured data records are left out with a notice. Source blocks keep their " +
      "fences, tables export as GFM, and cards and Figma blocks export as `:::` containers whose syntax " +
      "markdown help gives.",
    input: exportMarkdownInput,
    operation: exportMarkdownOperation,
    example: { uuid, frontmatter: true, annotations: "drop" },
    related: [...proseContracts, "data"],
  }),
  tool({
    name: "sync_status",
    title: "Sync status",
    description:
      "Inspect sync state. hub.status: connecting means the first attempt is pending without failures; " +
      "hub-down means retryable connection/renewal failure or a first attempt pending for 30s; auth-failed " +
      "needs action; update-required means protocol mismatch; local and disabled are local-only. " +
      "Applied writes are saved here and sync once connected; do not repeat. hub.recoveryClass, authRecovery " +
      "and reason guide recovery; protocolVersion and hubProtocolVersion identify the incompatible side. " +
      "Tools work locally. unsyncedChanges counts durable pending rooms; inFlightUpdates counts provider sync " +
      "messages, resetting on reconnect. lastSync is this machine's stored UTC when the full replica caught " +
      "up, or null; never backwards across processes. persistence reports a failed log append and stays " +
      "readable while ordinary replica tools are quarantined until restart.",
    input: syncStatusInput,
    operation: syncStatusOperation,
    example: {},
    related: ["workspaces", "tool-contracts"],
    details: toolHelpDetails.sync_status,
  }),
  tool({
    name: "get_sidebar",
    title: "Read the sidebar",
    description:
      "Read named groups of pinned documents in stored order. Unpinned documents remain live and reachable " +
      "through list_docs, search, links and backlinks; they are absent only from curated navigation.",
    input: getSidebarInput,
    operation: getSidebarOperation,
    example: {},
    related: documentContracts,
  }),
  tool({
    name: "pin_doc",
    title: "Pin a document into a sidebar group",
    description:
      "Pin into a named group, creating it if absent. `index` places the document; omission appends. One pin " +
      "per document: pinning an existing pin moves it without re-pinning, so concurrent unpin wins. " +
      "`index` counts target-group positions after removing the document.",
    input: pinDocInput,
    operation: pinDocOperation,
    // Moves an existing pin; repeating leaves it in the requested place.
    hints: { destructive: true, idempotent: true },
    example: { uuid, group: "Release", index: 0 },
    related: documentContracts,
  }),
  tool({
    name: "unpin_doc",
    title: "Unpin a document",
    description:
      "Unpin without changing the document. archive_doc hides documents or topics; delete_doc permanently deletes " +
      "archived documents or whole topics with topic: true. One decision record cannot be deleted on its own yet. Unpin " +
      "beats concurrent moves; no group is needed because each document has at most one pin. unpinned:false " +
      "means none existed. Empty groups remain; groupHint names sidebar_group to delete them.",
    input: unpinDocInput,
    operation: unpinDocOperation,
    // Removes a pin; repeating reports unpinned: false.
    hints: { destructive: true, idempotent: true },
    example: { uuid },
    related: documentContracts,
  }),
  tool({
    name: "sidebar_group",
    title: "Rename, delete or move a sidebar group",
    description:
      "Rename, move or delete a group. Deletion removes its pins, leaving documents unchanged and reachable through list_docs " +
      "and search. `action` selects fields: rename requires `name` and refuses `index`; move takes `index` " +
      "(omitted: last) and refuses `name`; delete takes neither. Mixed shapes refuse before any sidebar change. " +
      "No create action: pin_doc creates a missing named group with its first pin.",
    input: sidebarGroupInput,
    operation: sidebarGroupOperation,
    // Renames, moves or deletes groups/pins; repeated rename/delete by name can reach a namesake.
    hints: { destructive: true, idempotent: false },
    example: { action: "rename", group: "Release", name: "Release preparation" },
    related: documentContracts,
  }),
  tool({
    name: "get_help",
    title: "Read product help",
    description:
      "Read version-matched product help by topic/tool name; omit topic for the catalog. " +
      "Workspace-agnostic; available offline and during quarantine.",
    input: getHelpInput,
    operation: getHelpOperation,
    example: { topic: "get_doc" },
    related: ["orientation", "tools", "tool-contracts"],
    details: toolHelpDetails.get_help,
  }),
];

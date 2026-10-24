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
import { inputSchema as deleteBlockInput, deleteBlockOperation } from "./tools/delete-block.js";
import { inputSchema as deleteDocInput, deleteDocOperation } from "./tools/delete-doc.js";
import { inputSchema as editBlockInput, editBlockOperation } from "./tools/edit-block.js";
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
      "List existing tag ids, names and descriptions in name order. complete:false means the hub catalog " +
      "has not arrived. MCP cannot curate tags; people add them in Workspace settings.",
    input: listTagsInput,
    operation: listTagsOperation,
    example: {},
    related: ["workspaces", "tool-contracts"],
    details: toolHelpDetails.list_tags,
  }),
  tool({
    name: "create_doc",
    title: "Create a document",
    description:
      "Create a regular page or a decision record, optionally with starting blocks, tags, a TL;DR (regular " +
      "pages only) and a sidebar pin. A description is always required, and so is a title except on a " +
      "decision successor, which takes its topic's title. Every reference (tags, related pages, supersedes, " +
      "discussion and sidebar group) is checked before anything is written, so a refusal creates nothing. A " +
      "decision is created open or decided: deciding needs supported answer blocks and no TL;DR or data, " +
      "and a decided successor also needs a recorded person's answer. The document, directory and sidebar " +
      "are separate writes; if one fails, persistence_failed names the completed rooms and gives a recovery " +
      "that cannot create a duplicate.",
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
      "Read live metadata, blocks with edit-assertion rev hashes, comment threads and decision context. " +
      "Creation time createdAt and decision entries' createdAt/updatedAt are ISO 8601 UTC strings when known and representable. " +
      "Data lists collections/counts; use get_data for records. Use get_revision for a historical state.",
    input: getDocInput,
    operation: getDocOperation,
    example: { uuid },
    related: [...proseContracts, "data"],
    details: toolHelpDetails.get_doc,
  }),
  tool({
    name: "list_revisions",
    title: "List document revisions",
    description:
      "List hub revisions newest first, including archived documents, with names, namers and times or null. " +
      "IDs work with get_revision/get_data/restore_revision. Empty means hub-confirmed no history. " +
      "Listing a decision record refuses with decision_no_history.",
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
      "Naming a decision record refuses with decision_no_history.",
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
      "Restoring a decision record refuses with decision_no_history.",
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
      "Read a hub revision from list_revisions: title, visible blocks without rev, and data summary. " +
      "Archived documents work. Page records with get_data and the same revision. " +
      "Reading a decision record's revision refuses with decision_no_history.",
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
      "follow next_after until complete. Optional revision uses a hub ID from list_revisions, including " +
      "archived documents; omission reads live data. Live data and open revisions can change between calls. " +
      "Historical decision data refuses with decision_no_history.",
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
      "Find live documents containing any query word in titles, descriptions, content or assigned tag names. " +
      "English word forms match; case and accents fold, underscore groups match adjacent words and a trailing * " +
      "matches stem prefixes. A prefix past the stem can miss: `decisi*` can miss `decision`; search the whole word or a shorter prefix, `decis*`. " +
      "Punctuation or emoji alone matches nothing. Results use title-weighted bm25 relevance, " +
      "without a strict title-first or matched-word-count order. Optional kind narrows to regular documents or " +
      "decision records. Optional tag accepts one catalog id or current name (case ignored), or a list: any listed tag " +
      "matches and more listed tags boost relevance; unknown tags refuse. Every hit includes kind and canonical " +
      "tags; decision hits include current record state, including superseded and conflict. No hits does not " +
      "prove the index is empty or the replica complete. If a needed page is missing, ask whether to create it.",
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
      "need `table_mapping` for structural or multi-cell edits. Card and Figma blocks take their `:::` " +
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
      "Insert a nonempty blocks array consecutively after after_block_id, or at the top when omitted. " +
      "Use the same entries as create_doc; one block is a one-entry array. Returns the new blocks in " +
      "order, each with id and rev. Every entry is checked before anything is written: a refusal keeps " +
      "its error code, names the 1-based entry_index and says nothing was written. Decision answers " +
      "must keep their supported shape across the whole batch. Success sends one document update " +
      "and moves the cursor once, to the end of the last inserted block's stored text. Lists use " +
      "adjacent list-item entries with list/indent (default bullet/0). Container syntax lives in " +
      "each entry's text field. Document-link targets must be known locally; chart source stays literal. " +
      "For links and GitHub references, see markdown.",
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
      "Archive a document or every record in a decision topic: tombstone directory entries, drop local search " +
      "rows and unconditionally unpin without erasing content. Reads by UUID remain available. unpinned reports " +
      "the asserted unpin, not whether a pin was found. An unseen concurrent pin can survive with archived " +
      "status; use get_sidebar then unpin_doc to remove it. This writes directory and sidebar rooms " +
      "independently, without rollback or remote atomicity. The answer reports rooms; partial " +
      "persistence_failed carries uuid, completed/failed rooms, rolledBack: false and recovery. Follow recovery " +
      "to finish. indexed is false only on index-write failure; the archive remains applied and a later call " +
      "retries indexing. Restoration uses restore_doc; pin_doc deliberately places the restored document back " +
      "in navigation.",
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
      "Permanently delete an archived regular document, including content, comments, data and history. " +
      "Only its UUID and permanent deletion mark remain. Replicas remove their copies when they learn the mark; " +
      "the hub refuses later room updates. This cannot be undone, including by an offline restore. " +
      "Live documents refuse with doc_not_archived; deleted UUIDs refuse with doc_deleted; decision records refuse. " +
      "Links stored in other documents stay unchanged. Directory and sidebar writes report independent durability.",
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
    title: "Annotate a range, reply, resolve or move a thread's anchor",
    description:
      "Open a thread with block_id/start/end; reply with thread_id and no range fields; move an anchor with " +
      "thread_id plus block_id/start/end. text adds a comment in every mode; author is optional. Only replies " +
      "accept resolved to resolve or reopen. Moves remove all previous marks in the document and keep the " +
      "thread's id, earlier replies and resolution, including for orphaned threads. Incomplete ranges refuse. " +
      "Table targets need zero-based row/column GFM projection indices including header row 0. Offsets count " +
      "displayed characters, including stored edge whitespace: remove exactly the GFM padding before decoding " +
      "inline syntax. Coordinates follow moved cells; orphaned ranges are null. Bad or missing cell coordinates " +
      "refuse with annotation_cell; empty or other-thread overlap ranges with annotation_range. Offsets clamp " +
      "to text; a move may overlap its own anchor. Opening or moving into cards/Figma refuses with " +
      "annotation_card/annotation_figma. Existing card/Figma threads accept replies, resolution, reopening " +
      "or moves to prose/table cells; Figma ranges name caption.",
    input: annotateInput,
    operation: annotateOperation,
    // Replies can overwrite thread resolution; repeating adds another comment.
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
      "Mark selected prose text as a document reference without changing its characters or rev. start/end are " +
      "character offsets measured against the required rev; stale_block returns currentText/currentRev for " +
      "remeasurement. Indices clamp to text and swap if reversed; empty ranges refuse. Existing document " +
      "references are retargeted; external links, source blocks, tables, cards and Figma blocks refuse. Write card and Figma caption links " +
      "as inline Markdown in their container text. doc_id must be known to this replica's directory or doclink_target_not_known_locally refuses " +
      "before writing; archived targets are accepted. The answer includes the target title, but the label stays " +
      "the selected text and does not follow renames. Backlinks update without changing curated meta.links.",
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
      "Inspect local replica state, pending rooms and hub connection/acknowledgements. hub.status distinguishes " +
      "local, disabled, retryable hub-down, auth-failed requiring action, and update-required protocol mismatch. " +
      "hub.recoveryClass, authRecovery and reason explain recovery; protocolVersion and hubProtocolVersion " +
      "identify the incompatible side. Tools still work locally. unsyncedChanges counts durable pending rooms; " +
      "inFlightUpdates counts provider sync messages on the current connection, resetting on reconnect. " +
      "lastSync is this machine's stored UTC time when its full replica caught up, or null; it never moves " +
      "backwards across processes. persistence diagnoses a failed log append and remains readable when ordinary " +
      "replica tools are quarantined until restart. See this tool's help for counter units and lastSync " +
      "conditions.",
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
      "The workspace's curated navigation: named groups of pinned documents, in the order they are stored. This " +
      "is not the corpus — unpinned documents are fully alive and reachable through list_docs, search, links " +
      "and backlinks. Unpinned documents are simply not entry points.",
    input: getSidebarInput,
    operation: getSidebarOperation,
    example: {},
    related: documentContracts,
  }),
  tool({
    name: "pin_doc",
    title: "Pin a document into a sidebar group",
    description:
      "Pin a document into a group, creating the group when no group carries that name. `index` places it; omit " +
      "it to append.\n\n" +
      "One pin per document across the whole sidebar, so this is also how a pinned document is moved or " +
      "reordered: pinning one that is already pinned moves it to `index` in the named group — carrying the pin " +
      "as it stands rather than re-pinning it, so a concurrent unpin still wins — and `index` then counts " +
      "positions in the target group after the document has been taken out of it.",
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
      "Remove a document from the sidebar, wherever it sits; the document itself is untouched. archive_doc " +
      "hides a document; delete_doc permanently deletes an archived regular document.\n\n" +
      "An unpin beats a concurrent move on another replica, so a dragged document does not reappear. It takes " +
      "no group: a document has at most one pin. `unpinned` is false when the document was not pinned. A group " +
      "left empty stays until sidebar_group deletes it; `groupHint` names that call.",
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
      "Manage the groups themselves. `delete` removes the group and its pins — the documents are untouched, " +
      "because the group only ever held their uuids, and they stay reachable through list_docs and search.\n\n" +
      "`action` picks one of three shapes and each takes only its own field: `rename` needs `name` and refuses " +
      "`index`, `move` takes `index` (omitted: last) and refuses `name`, `delete` takes neither. A field " +
      "belonging to another action is refused at the input boundary before the sidebar is touched, rather than " +
      "ignored — so a call that says two things is a failure you can see, not a silent half-success.\n\n" +
      "There is no create action: pin_doc creates a group by naming one that does not exist, which is how a " +
      "group comes into being with something in it rather than empty.",
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

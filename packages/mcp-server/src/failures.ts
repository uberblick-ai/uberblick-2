import {
  DataError,
  SchemaError,
} from "@uberblick/schema";
import { log } from "./log.js";
import { PersistenceError } from "./replica.js";
import { RevisionClientError, type RevisionClientFailure } from "./revision-client.js";
import { ServerShuttingDownError } from "./server-work.js";
import { WorkspaceRemovedError } from "./store.js";
import type { Writes } from "./tools/operation.js";

/** Keep unclassified exception text out of caller-visible failures. */
export const INTERNAL_ERROR_MESSAGE =
  "The tool failed for an unhandled reason. Nothing here says whether anything was written; check sync_status, " +
  "re-read the document, and see this server's stderr log for the cause.";

/** Shared tool/resource quarantine refusal; raw store detail belongs to sync_status and stderr. */
export const PERSISTENCE_ERROR_MESSAGE =
  "The replica refused a write to its update log; check sync_status and restart the MCP server.";

export class ToolError extends Error {
  readonly code: string;

  readonly detail: Record<string, unknown>;

  constructor(
    code: string,
    message: string,
    detail: Record<string, unknown> = {},
  ) {
    super(message);
    this.name = "ToolError";
    this.code = code;
    this.detail = detail;
  }
}

export type RecoveryClass = "retry" | "reread" | "manual";

/**
 * The failing tool and what it may write. Read failures omit mutation state
 * because the caller requested no write.
 */
export interface FailedTool {
  readonly name: string;
  readonly writes: Writes;
}

interface Recovery {
  readonly recoveryClass: RecoveryClass;
  readonly guidance: string;
}

/**
 * Mapped codes supply default recovery and mutation state. Throw sites with
 * more context may replace recovery, including its class; never suggest retry
 * when the unchanged call cannot succeed after a transient condition passes.
 */
const RECOVERIES: Record<string, Recovery> = {
  unknown_help_topic: {
    recoveryClass: "manual",
    guidance: "Choose one of the valid topic ids in topics, or call get_help with no topic to discover the catalog.",
  },
  server_shutting_down: {
    recoveryClass: "manual",
    guidance: "Start a new MCP server session, then repeat the refused call. Nothing was written.",
  },
  data_collection_not_found: {
    recoveryClass: "reread",
    guidance: "Call get_data with this uuid and no collection to read the collection summary, then choose an existing collection.",
  },
  data_invalid_input: {
    recoveryClass: "manual",
    guidance:
      "Correct the collection operation, record ids or JSON values named in this failure, then apply the update again. No data was written.",
  },
  data_schema_invalid: {
    recoveryClass: "manual",
    guidance:
      "Correct the collection schema at the reported path using the supported vocabulary and version, then apply the update again. No data was written.",
  },
  data_record_invalid: {
    recoveryClass: "manual",
    guidance:
      "Correct the named record or change its collection schema so every retained record validates, then apply the update again. No data was written.",
  },
  data_limit_exceeded: {
    recoveryClass: "manual",
    guidance:
      "Reduce the reported data size or nesting depth to its limit, or shrink an already over-limit area, then apply the update again. No data was written.",
  },
  invalid_table: {
    recoveryClass: "manual",
    guidance:
      "Supply exactly one GFM table, with a header and matching delimiter row, then call again. Alignment markers are accepted but not stored; inline markdown writes cell formatting and escaped punctuation stays literal.",
  },
  invalid_card: {
    recoveryClass: "manual",
    guidance: "Supply card content without its :::card and ::: delimiter lines: label, title and footer at most once, a nonempty title, any number of button lines, then a blank line and optional prose body. Each button contains exactly one [Text](destination) link, with nonempty plain text and an https URL or claude://code/new, claude-cli://open or codex://new, optionally followed by ?query. After its link, allow at most one style (outline or filled) and one color (neutral, blue, green or violet), in either order; defaults are outline neutral. Remove other trailing text, unknown keys and non-key header lines. Nothing was written.",
  },
  annotation_card: {
    recoveryClass: "manual",
    guidance: "Open a card comment on selected text in the web editor, then use annotate with its thread_id to reply, resolve or reopen it. Nothing was written.",
  },
  invalid_figma: {
    recoveryClass: "manual",
    guidance: "Supply Figma content without its :::figma and ::: delimiter lines: required url, optional plain one-line title and optional whole-number height from 240 to 960, each at most once, then a blank line and optional prose caption. Use an https figma.com or www.figma.com design, file, proto, board, slides or community/file link. Remove unknown or duplicate keys and non-key header lines. Nothing was written.",
  },
  annotation_figma: {
    recoveryClass: "manual",
    guidance: "Use annotate with an existing Figma thread_id to reply, resolve or reopen it; MCP cannot open a new Figma caption thread. Nothing was written.",
  },
  table_mapping_required: {
    recoveryClass: "manual",
    guidance:
      "Supply table_mapping with rows and columns naming the surviving old projection indices, or null for new positions. Include header row 0; an identity map supports a positional multi-cell batch. No table change was written.",
  },
  invalid_table_mapping: {
    recoveryClass: "manual",
    guidance:
      "Correct table_mapping for this table: match the new dimensions, keep header row 0, and use unique increasing old indices in bounds or null for new positions. No table change was written.",
  },
  invalid_list_attributes: {
    recoveryClass: "manual",
    guidance: "Supply list or indent only when editing a list-item block, with list bullet or ordered and indent an integer from 0 to 3. Nothing was written.",
  },
  annotation_cell: {
    recoveryClass: "manual",
    guidance:
      "Call get_doc and name a table cell with both row and column in its zero-based GFM projection (header row 0); omit both coordinates for a non-table block, then annotate its character range.",
  },
  invalid_github_reference: {
    recoveryClass: "manual",
    guidance:
      "Correct github_ref to one owner/repo#n reference or an http(s) github.com URL naming /issues/n or /pull/n, then call find_decisions again.",
  },
  persistence_failed: {
    recoveryClass: "manual",
    guidance:
      "The update log refused a write, so this server is fail-stopped: ordinary workspace tools refuse until the process is " +
      "restarted, and repeating this call now cannot succeed. Restart the MCP server, then re-read before writing " +
      "again — a refused write never became durable anywhere.",
  },
  workspace_removed: {
    recoveryClass: "manual",
    guidance: "Restart the MCP server to open a new copy of the workspace before writing again.",
  },
  stale_block: {
    recoveryClass: "reread",
    guidance:
      "The block changed under you. This answer already carries `currentText` and `currentRev`, so call the same " +
      "tool again with `currentRev` — re-diffing against `currentText` first for edit_block, and re-measuring the " +
      "offsets against it for link_range. No extra read is needed.",
  },
  old_text_mismatch: {
    recoveryClass: "manual",
    guidance:
      "The asserted `rev` is current, but `old_text` does not match this block. This answer already carries " +
      "`currentText` and `currentRev`; correct `old_text`, re-diff the intended change against `currentText`, " +
      "and call edit_block again with `currentRev`. No extra read is needed.",
  },
  block_not_found: {
    recoveryClass: "reread",
    guidance:
      "Call get_doc for the block ids this document actually holds, then call again with one of them.",
  },
  duplicate_block_id: {
    recoveryClass: "manual",
    guidance: "Include each block id only once in block_ids, then retry the move. Nothing was written.",
  },
  move_target_in_selection: {
    recoveryClass: "manual",
    guidance: "Choose after_block_id outside block_ids, or omit it to move the blocks first. Nothing was written.",
  },
  annotation_range: {
    recoveryClass: "reread",
    guidance:
      "Call get_doc for the block's current text and its existing threads, then annotate a range that fits it — " +
      "`reason` says which of the two is in the way.",
  },
  open_thread_anchored: {
    recoveryClass: "manual",
    guidance:
      "Use annotate with each named thread_id and text to resolve it (resolved: true), or move its anchor to a new range in this document (block_id, start, end; row and column for a table cell), then repeat the write. Nothing was written.",
  },
  thread_not_found: {
    recoveryClass: "reread",
    guidance:
      "Call get_doc for the threads this document holds, or omit `thread_id` to open a new one over a range.",
  },
  inline_link_range: {
    recoveryClass: "reread",
    guidance:
      "Call get_doc for the block's current text, its type and its `doc_links`, then link a range that fits — " +
      "`reason` says which of the three is in the way: `empty` (the range covers no characters), `not-prose` " +
      "(code, terminal and chart hold source text; table, card and Figma links belong to their parts and have no block-level ranges) or `overlap` (the range " +
      "is already an external link, and one range cannot be both).",
  },
  // Repeating a lookup cannot deliver a missing directory entry; hub sync may.
  doclink_target_not_known_locally: {
    recoveryClass: "reread",
    guidance:
      "This replica's directory holds no such document, so the link would point at a uuid nothing here can " +
      "resolve. Call list_docs or search for the target's real uuid — and if you believe it exists elsewhere, " +
      "`hub` says whether this replica could have received it yet; sync_status says the same in full.",
  },
  doc_not_found: {
    recoveryClass: "reread",
    guidance:
      "Nothing in this workspace answers to that uuid. Call list_docs or search to find the document — identity " +
      "is the uuid, never the title.",
  },
  // requireDoc must replace this default with hydrationRecovery's hub-aware pair.
  doc_not_hydrated: {
    recoveryClass: "retry",
    guidance:
      "The document is known but its room has not reached this replica yet, and nothing was written. Call again " +
      "in a moment; sync_status says whether the hub can still deliver it.",
  },
  doc_archived: {
    recoveryClass: "manual",
    guidance:
      "Archived documents are read-only. Call restore_doc for this uuid before editing. To permanently delete, call delete_doc for an archived regular document, or delete_doc with topic: true for an archived decision topic. One decision record cannot be deleted on its own yet.",
  },
  doc_deleted: {
    recoveryClass: "manual",
    guidance: "This UUID was permanently deleted and cannot be restored or reused. Choose another document from list_docs or search. Nothing was written.",
  },
  revisions_local_only: {
    recoveryClass: "manual",
    guidance: "Automatic revisions require a team hub. Use a workspace connected to a team hub before reading revisions.",
  },
  decision_no_history: {
    recoveryClass: "manual",
    guidance: "Call get_doc for the topic UUID in topic, then read its inForce, pending, conflicts, predecessors and successors records; the topic's records are its history.",
  },
  revisions_unreachable: {
    recoveryClass: "retry",
    guidance: "Call again once the hub is reachable; sync_status reports the connection state.",
  },
  revisions_sign_in_required: {
    recoveryClass: "manual",
    guidance: "Run ub auth login to sign in, restart the MCP server, then read revisions again.",
  },
  revisions_forbidden: {
    recoveryClass: "manual",
    guidance: "Ask a workspace maintainer to grant read access before reading this document's revisions again.",
  },
  revisions_unsupported: {
    recoveryClass: "manual",
    guidance: "Ask the hub operator to update the hub to a version that serves automatic document revisions, then read revisions again.",
  },
  revision_stale_state: {
    recoveryClass: "reread",
    guidance: "Wait for synchronization, read the current document with get_doc, review the newer changes, then try again. Nothing was changed.",
  },
  revision_invalid_name: {
    recoveryClass: "manual",
    guidance: "Supply a name containing 1 to 100 characters on one line. Nothing was named.",
  },
  revision_already_named: {
    recoveryClass: "manual",
    guidance: "This state already has existingName. Its namer may rename or remove that name in the web; naming it again changes nothing.",
  },
  revision_not_namer: {
    recoveryClass: "manual",
    guidance: "Ask the account that named this revision to rename or remove it in the web. Nothing changed.",
  },
  revision_naming_outcome_unknown: {
    recoveryClass: "reread",
    guidance: "Call list_revisions to check whether the hub applied the name before trying again. A missing reply does not establish that nothing changed; reason distinguishes a silent admitted hub from a lost connection.",
  },
  revision_restore_outcome_unknown: {
    recoveryClass: "reread",
    guidance: "Read list_revisions and get_doc before retrying: the restore may have committed even though its reply was lost. Update the hub if reason is unsupported.",
  },
  revision_not_found: {
    recoveryClass: "reread",
    guidance: "Call list_revisions for this document's uuid, then choose one of its revision IDs. A revision from another document cannot be read here.",
  },
  doc_not_archived: {
    recoveryClass: "manual",
    guidance: "Call archive_doc for this UUID before deliberately calling delete_doc; decision topics require topic: true. One decision record cannot be deleted on its own yet. Nothing was written.",
  },
  decision_delete_unsupported: {
    recoveryClass: "manual",
    guidance: "One decision record cannot be deleted on its own yet. To permanently delete every record, archive the whole topic with archive_doc, then call delete_doc with this UUID and topic: true. Nothing was written.",
  },
  group_not_found: {
    recoveryClass: "reread",
    guidance:
      "Call get_sidebar for the group ids that exist. pin_doc is what brings a group into being, by naming one " +
      "that does not exist yet.",
  },
  invalid_document_lifecycle: {
    recoveryClass: "manual",
    guidance:
      "The document's stored kind is fixed through MCP. Choose a status in that kind's lifecycle; if the kind " +
      "itself is wrong, retrying cannot change or clear it through this interface.",
  },
  decision_read_only: {
    recoveryClass: "manual",
    guidance:
      "A decided record's answer blocks, structured data and discussion reference are read-only. Decisions have no TL;DR. Create an open superseding record " +
      "for any answer change, then record a person's answer to decide it. Titles stay editable without changing approval; comments stay open.",
  },
  decision_answer_required: {
    recoveryClass: "manual",
    guidance:
      "Record the person's answer with answer: {who, when, where}, then call again. No proposal or " +
      "lifecycle change was written by this refused call.",
  },
  decision_reason_required: {
    recoveryClass: "manual",
    guidance: "Supply a non-empty rejection reason and the person's answer, then call set_status again.",
  },
  decision_transition_invalid: {
    recoveryClass: "manual",
    guidance:
      "Create a decision as open or decided. Only an open proposal can withdraw; rejection is for an open " +
      "proposal, an agent stance or a decided record in conflict and records a person's answer and reason. " +
      "Decided records cannot reopen or withdraw, and rejected and withdrawn records are final.",
  },
  related_not_regular_document: {
    recoveryClass: "reread",
    guidance:
      "Choose a live regular document UUID from list_docs, then call create_doc again. " +
      "Nothing was created by this refused call.",
  },
  discussion_not_regular_document: {
    recoveryClass: "reread",
    guidance:
      "Choose a live, locally readable document that is not a decision record for discussion, then call again. " +
      "No reference or document was written by this refused call.",
  },
  discussion_not_writable: {
    recoveryClass: "manual",
    guidance:
      "Only an open decision record accepts a discussion change. Create an open decision record or successor " +
      "to connect a new discussion; rejected and withdrawn references stay in history. Nothing was written.",
  },
  decision_answer_empty: {
    recoveryClass: "manual",
    guidance: "Add non-blank answer text in a paragraph, code block, table or list before deciding the record. Nothing was written.",
  },
  decision_tldr_unsupported: {
    recoveryClass: "manual",
    guidance: "Decisions have no TL;DR. Put the answer in content blocks and omit tldr or pass null on an open record. Nothing was written.",
  },
  invalid_code_check: {
    recoveryClass: "manual",
    guidance: "Read the page again with get_doc and compare it with code before recording code_check; do not just resend with a new rev. Supply repository (owner/name), a full 40- or 64-character hexadecimal commit, result (matches, ahead or drift), that page rev and optional paths. Paths must be 1–20 literal repo-relative files/folders, at most 200 characters each, with no leading /, .. segments or glob characters (* ? [ ] { }); trailing / marks a folder. Omit checked_at; this replica supplies it. Nothing was written.",
  },
  decision_code_check_unsupported: {
    recoveryClass: "manual",
    guidance: "Record code_check on the regular page whose described behavior was compared with code, and omit it from decision records. Nothing was written.",
  },
  tldr_opted_out: {
    recoveryClass: "manual",
    guidance: "Keep this page without a TL;DR, or pass tldr_opt_in: true with a non-null tldr in set_metadata to opt back in. Nothing was written.",
  },
  decision_data_unsupported: {
    recoveryClass: "manual",
    guidance: "Keep structured data on a regular document. Decision records accept answer blocks only; no data or lifecycle change was written.",
  },
  decision_block_unsupported: {
    recoveryClass: "manual",
    guidance: "Use only paragraphs, code blocks, tables and lists for a decision answer. Put guidance on the related page and discussion in an RFC. Nothing was written.",
  },
  decision_answer_too_long: {
    recoveryClass: "manual",
    guidance: "Reduce the answer to at most three blocks; adjacent list items count as one list. Put guidance on the related page and discussion in an RFC. Nothing was written.",
  },
  invalid_tag_assignment: {
    recoveryClass: "manual",
    guidance:
      "Call list_tags for the complete existing catalog, then call again with existing ids or names (case ignored). " +
      "Hidden references awaiting a catalog entry stay stored automatically; deleted tags cannot be assigned.",
  },
  supersedes_not_decision: {
    recoveryClass: "reread",
    guidance:
      "Choose a decision UUID from list_docs with `kind: decision`, then call create_doc again. Nothing was " +
      "created by this refused call.",
  },
  decision_title_mismatch: {
    recoveryClass: "reread",
    guidance: "Read the topic's current title with get_doc, then omit title or supply that title when creating its successor. Nothing was created.",
  },
};

/**
 * Retry only for a connected, connecting or automatically reconnecting hub.
 * Disabled, refused or quarantined connections need manual repair; their
 * directory stubs stay dangling while the room cannot arrive.
 */
export function hydrationRecovery(hubStatus: string): {
  recoveryClass: RecoveryClass;
  recovery: string;
} {
  const stub =
    "The document is known from the directory but its room has not reached this replica, and nothing was written. ";
  switch (hubStatus) {
    case "disabled":
      return {
        recoveryClass: "manual",
        recovery:
          `${stub}No hub is configured, so the room cannot arrive at all and this stub stays dangling: ` +
          "configure the hub (HUB_AUTH_TOKEN, HUB_URL) and restart the MCP server. If the document is gone for " +
          "good, archive_doc retires the stub — it needs only the directory.",
      };
    case "auth-failed":
      return {
        recoveryClass: "manual",
        recovery:
          `${stub}The hub rejected this replica's credential, so nothing will arrive until a human fixes it — ` +
          "sync_status carries the reason. Retrying cannot help, and the stub stays dangling meanwhile.",
      };
    case "update-required":
      return {
        recoveryClass: "manual",
        recovery:
          `${stub}This replica and the hub speak different sync protocols, so the hub refuses the connection ` +
          "outright and no room will arrive until the older side is updated — sync_status names both versions " +
          "and which one that is. Retrying cannot help, and the stub stays dangling meanwhile.",
      };
    case "quarantined":
      return {
        recoveryClass: "manual",
        recovery:
          `${stub}This replica is quarantined after a refused write to the update log and receives nothing ` +
          "until the process restarts. Restart the MCP server, then read again.",
      };
    case "hub-down":
      return {
        recoveryClass: "retry",
        recovery:
          `${stub}The hub is unreachable and this replica is reconnecting on its own, so the same call succeeds ` +
          "once it is back. Call again in a moment; sync_status says whether it has returned.",
      };
    case "local":
      return {
        recoveryClass: "manual",
        recovery:
          `${stub}This local workspace's hub runs only while \`ub open\` does, so the room arrives once someone ` +
          "runs it. Retrying before then cannot help.",
      };
    default:
      return {
        recoveryClass: "retry",
        recovery:
          `${stub}The hub can still deliver it — the room may be in flight. Call again in a moment; sync_status ` +
          "says where the connection stands.",
      };
  }
}

/**
 * An incomplete catalog uses the same delivery test as an unhydrated room.
 * Do not prescribe list_tags: it reads the same missing catalog.
 */
export function incompleteCatalogRecovery(hubStatus: string): {
  recoveryClass: RecoveryClass;
  recovery: string;
} {
  return {
    recoveryClass: hydrationRecovery(hubStatus).recoveryClass,
    recovery:
      "The workspace tag catalog has not reached this replica, so this may be a real workspace tag and list_tags " +
      "cannot name it either — it answers `complete: false` while that is so. Nothing was written. sync_status says " +
      "whether the catalog can still arrive; until it has, only a value this replica already holds can be used.",
  };
}

/**
 * Contract tests require recovery coverage for every code except internal_error.
 */
export const FAILURE_CODES: readonly string[] = [
  ...Object.keys(RECOVERIES),
  "internal_error",
];

const REVISION_FAILURE_CODES: Record<RevisionClientFailure, string> = {
  "local-only": "revisions_local_only",
  unreachable: "revisions_unreachable",
  "sign-in-required": "revisions_sign_in_required",
  forbidden: "revisions_forbidden",
  deleted: "doc_deleted",
  "decision-no-history": "decision_no_history",
  "revision-not-found": "revision_not_found",
  unsupported: "revisions_unsupported",
  "stale-state": "revision_stale_state",
  "invalid-name": "revision_invalid_name",
  "already-named": "revision_already_named",
  "not-namer": "revision_not_namer",
  archived: "doc_archived",
  "naming-outcome-unknown": "revision_naming_outcome_unknown",
  "restore-outcome-unknown": "revision_restore_outcome_unknown",
};

/**
 * Bundle shared failure prose once in tool-contracts; per-tool descriptions
 * point to that help topic.
 */
export const FAILURE_INSTRUCTIONS =
  "Failures are JSON with a stable `error` code and a human `message`, and — wherever recovery is actionable — a " +
  "`recoveryClass` and a `recovery` sentence saying what to do. `retry` means this same call succeeds once a " +
  "transient condition passes; `reread` means read current state and call again with what it says; `manual` means " +
  "nothing you can repeat helps until something changes — correct the arguments, run the repair tool the sentence " +
  "names, fix configuration, or restart the server. A retry that cannot work is never labelled `retry`. Domain " +
  "detail stays with its code: `stale_block` and `old_text_mismatch` carry `currentText` and `currentRev`, so an " +
  "edit can be re-diffed without another read; `persistence_failed` names the `room`. A failure of a WRITING tool also says what became " +
  "of the write: `applied` (everything it meant to write is durable in this server's update log), `partial` (only " +
  "some of it is — `completed` names the rooms that are) and `synced`; `applied: false, partial: false` means " +
  "nothing changed locally, and nothing is ever rolled back — a partial write is finished by following `recovery`. " +
  "A failure of a reading tool carries none of those three: there was no write to report on. The hub-only " +
  "name_revision and restore_revision report applied: null when a sent request has no acknowledged outcome; read list_revisions and get_doc before retrying. `internal_error` is " +
  "the one code with no class and no detail — an unmapped crash cannot honestly say what it did — and arguments " +
  "that do not match a tool's input schema never reach the tool at all: the MCP layer rejects them with its own " +
  "plain-text validation error, and nothing durable changes.";

export interface ToolFailure {
  isError: true;
  payload: Record<string, unknown>;
}

function failure(payload: Record<string, unknown>): ToolFailure {
  return { isError: true, payload };
}

/**
 * Spread the payload last to preserve partial writes' recovery, completed
 * rooms and partial: true.
 */
function stamped(
  tool: FailedTool,
  payload: Record<string, unknown> & { error: string; message: string },
): ToolFailure {
  const recovery = RECOVERIES[payload.error];
  if (recovery === undefined) {
    // An unmapped crash cannot claim whether a write landed or how to recover.
    return failure(payload);
  }
  return failure({
    ...(tool.writes !== null
      ? { applied: false, partial: false, synced: false }
      : {}),
    recoveryClass: recovery.recoveryClass,
    recovery: recovery.guidance,
    ...payload,
    ...((tool.name === "insert_block" || tool.name === "move_block") && [
      "block_not_found", "doc_not_found", "doc_not_hydrated", "doc_archived", "doc_deleted",
      "decision_read_only", "server_shutting_down",
      ...(tool.name === "move_block" ? ["duplicate_block_id", "move_target_in_selection"] : []),
    ].includes(payload.error) && !/nothing was written/i.test(payload.message)
      ? { message: `${payload.message} Nothing was written.` }
      : {}),
  });
}

export function toFailure(tool: FailedTool, error: unknown): ToolFailure {
  if (error instanceof WorkspaceRemovedError ||
    (error instanceof PersistenceError && error.cause instanceof WorkspaceRemovedError)) {
    return stamped(tool, { error: "workspace_removed", message: new WorkspaceRemovedError().message });
  }
  if (error instanceof ServerShuttingDownError) {
    return stamped(tool, { error: "server_shutting_down", message: error.message });
  }
  if (error instanceof RevisionClientError) {
    return stamped(tool, { error: REVISION_FAILURE_CODES[error.code], message: error.message, ...error.details,
      ...(tool.name === "name_revision" && error.code === "forbidden"
        ? { recovery: "Ask a workspace maintainer to grant write access before naming this document. Nothing was named." }
        : {}),
      ...(tool.name === "restore_revision" && error.code === "forbidden"
        ? { recovery: "Ask a workspace maintainer to grant write access before restoring this revision. Nothing was changed." }
        : {}),
    });
  }
  if (error instanceof SchemaError || error instanceof DataError) {
    return stamped(tool, {
      error: error.code,
      message: error.message,
      ...error.details,
      ...(error instanceof SchemaError && error.code === "invalid_tag_assignment" && tool.name === "set_metadata"
        ? { field: "tags" }
        : {}),
    });
  }
  if (error instanceof PersistenceError) {
    // Refuse reads too: memory ahead of the log can expose state a restart drops.
    return stamped(tool, {
      error: "persistence_failed",
      message: PERSISTENCE_ERROR_MESSAGE,
      room: error.room,
    });
  }
  if (error instanceof ToolError) {
    return stamped(tool, {
      error: error.code,
      message: error.message,
      ...error.detail,
    });
  }
  // Raw exceptions may contain paths, SQL or secrets; keep them on stderr.
  log.error("tool call failed", error);
  return stamped(tool, { error: "internal_error", message: INTERNAL_ERROR_MESSAGE });
}

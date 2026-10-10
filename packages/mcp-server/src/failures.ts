/**
 * The failure contract: what a tool answers with when it cannot do what it was
 * asked, and what a caller may rely on without knowing which tool it called.
 *
 * One floor, stated additively. Every failure a handler generates is JSON
 * carrying a stable machine-readable `error` code and a human `message`, and
 * keeps whatever domain detail that code already carried — `stale_block`'s
 * `currentText` and `currentRev`, `persistence_failed`'s `room`, a partial
 * create's `completed` and `failed`. Two things are stamped here rather than
 * restated at every throw site:
 *
 * - **What happened to the write.** A failure of a MUTATING tool says
 *   `applied` (all of this call's work is durable in the update log), `partial`
 *   (only some of it is, and `completed` names the rooms that are) and
 *   `synced`. A read-only tool's failure says none of the three: inventing them
 *   would be claiming knowledge of a write nobody attempted.
 * - **How to recover.** `recoveryClass` is one of `retry` (this same call,
 *   unchanged, succeeds once a transient condition passes), `reread` (read
 *   current state and call again with what it says) or `manual` (nothing the
 *   caller can repeat helps until something changes: correct the arguments,
 *   run a named repair tool, fix configuration, or restart the server), and
 *   `recovery` is the sentence saying what to do. A retry that cannot work is
 *   never labelled `retry`: `persistence_failed` is sticky until the process
 *   restarts, so it is `manual`, and `doc_not_hydrated` is `retry` only while
 *   a hub that could still deliver the room is in the picture — see
 *   {@link hydrationRecovery}.
 *
 * Two classes sit deliberately outside the table.
 *
 * `internal_error` is the unclassified fallback. A handler that threw something
 * nobody mapped cannot honestly claim its write did not land, so it carries the
 * floor — `error` and a fixed `message` — and nothing else. Stamping
 * `applied: false` onto it would be the one lie this contract exists to
 * prevent, and returning the exception's own text would ship whatever it
 * happens to hold — a path, a SQL statement, a token — to the caller. The
 * original goes to the log, on stderr, where an operator reads it.
 *
 * Over MCP, arguments that do not match a tool's input schema never reach a
 * handler: the MCP SDK rejects them at the protocol boundary with its own
 * plain-text validation error, before any code here runs and therefore before
 * anything durable could change. That class is documented rather than wrapped —
 * disguising it as a handler failure would make a boundary rejection look like
 * a call that got somewhere. It covers every wrong argument, including the ones
 * that are individually well-formed but do not add up to a call: ./inputs.ts
 * states each multiplexed tool's valid shapes in the schema itself, so no
 * handler here is left holding an arguments complaint of its own. Direct
 * operation callers must parse the exported inputSchema before calling it.
 *
 * Nothing here promises a rollback, and nothing here reconciles: a call that
 * touched several rooms reports what is durable and names the call that
 * finishes the job. See ./tools/create-doc.ts (`create_doc`'s `RECOVERY`) for the
 * room-by-room wording.
 */

import type { ToolAnnotations } from "@modelcontextprotocol/sdk/types.js";
import {
  AnnotationCellError,
  AnnotationRangeError,
  BlockNotFoundError,
  ConflictingLinkMarksError,
  DataError,
  InvalidDocumentLifecycleError,
  InvalidTableError,
  InvalidTableMappingError,
  InvalidTagAssignmentError,
  InlineLinkRangeError,
  OldTextMismatchError,
  StaleBlockError,
  TableMappingRequiredError,
} from "@uberblick/schema";
import { log } from "./log.js";
import { PersistenceError } from "./replica.js";
import { ServerShuttingDownError } from "./server-work.js";

/**
 * What the caller is told when a handler threw something nobody mapped. Fixed
 * on purpose — see {@link toFailure}; the exception itself goes to the log.
 */
export const INTERNAL_ERROR_MESSAGE =
  "The tool failed for an unhandled reason. Nothing here says whether anything was written; check sync_status, " +
  "re-read the document, and see this server's stderr log for the cause.";

/** Shared tool/resource quarantine refusal; raw store detail belongs to sync_status and stderr. */
export const PERSISTENCE_ERROR_MESSAGE =
  "The replica refused a write to its update log; check sync_status and restart the MCP server.";

/** A tool failure with a stable machine-readable code. */
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

/** What a caller should do next, in three words the machine can branch on. */
export type RecoveryClass = "retry" | "reread" | "manual";

/**
 * The tools that can change durable state, and therefore the tools whose
 * failures say what happened to the write.
 *
 * The split is about what the CALLER asked for, which is what a failure has to
 * report on.
 *
 * A hand-kept list on purpose: "does this tool write" is a fact about the tool,
 * not something to infer at runtime. {@link READ_ONLY_TOOLS} holds the other
 * half, and a contract test checks the two together against what the server
 * actually registers — so a tool added later is classified or the suite fails.
 */
export const DOCUMENT_MUTATING_TOOLS: ReadonlySet<string> = new Set([
  "create_doc",
  "edit_block",
  "insert_block",
  "delete_block",
  "set_metadata",
  "set_status",
  "archive_doc",
  "restore_doc",
  "annotate",
  "link_range",
  "update_data",
]);

export const MUTATING_TOOLS: ReadonlySet<string> = new Set([
  ...DOCUMENT_MUTATING_TOOLS,
  "pin_doc",
  "unpin_doc",
  "sidebar_group",
]);

/**
 * The tools the caller asks nothing of but an answer. Their failures invent no
 * mutation state — see {@link MUTATING_TOOLS} for what "read-only" does and
 * does not claim.
 */
export const READ_ONLY_TOOLS: ReadonlySet<string> = new Set([
  "get_help",
  "list_tags",
  "get_doc",
  "get_data",
  "list_docs",
  "search",
  "backlinks",
  "find_decisions",
  "export_markdown",
  "sync_status",
  "get_sidebar",
]);

type ToolHints = Required<Pick<ToolAnnotations,
  "readOnlyHint" | "destructiveHint" | "idempotentHint" | "openWorldHint"
>>;

/**
 * Advisory MCP hints, not security guarantees. Keep a row for every tool:
 * registration refuses omissions and the contract test checks coverage.
 * All tools stay within the workspace replica and hub, including the local
 * GitHub-reference lookup in find_decisions, so none is open-world.
 */
export const TOOL_ANNOTATIONS: Readonly<Record<string, ToolHints>> = {
  get_help: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  list_tags: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  get_doc: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  get_data: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  list_docs: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  search: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  backlinks: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  find_decisions: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  export_markdown: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  sync_status: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  get_sidebar: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  // Adds a fresh document and optional pin; repeating adds another document.
  create_doc: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  // Adds a block; repeating adds another block.
  insert_block: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  // Replies can overwrite thread resolution; repeating adds another comment.
  annotate: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
  // Retargets a document link; unchanged rev lets repeats write the same mark.
  link_range: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
  // Replaces text; table_mapping can replace rows again under identical text and rev.
  edit_block: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
  // Removes a block; repeating finds no block to remove.
  delete_block: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
  // Replaces named fields and whole tag/link sets; repeating leaves the same values.
  set_metadata: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
  // Overwrites lifecycle and answer; repeating leaves the same state or is refused.
  set_status: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
  // Tombstones and unpins; every repeat raises the unpin counter, suppressing later pins.
  archive_doc: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
  // Clears the tombstone and overwrites stub metadata; repeating leaves the same state.
  restore_doc: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
  // Replaces, upserts and deletes data; an identical repeat reports changed: false.
  update_data: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
  // Moves an existing pin; repeating leaves it in the requested place.
  pin_doc: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
  // Removes a pin; repeating reports unpinned: false.
  unpin_doc: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
  // Renames, moves or deletes groups/pins; repeated rename/delete by name can reach a namesake.
  sidebar_group: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
};

interface Recovery {
  readonly recoveryClass: RecoveryClass;
  readonly guidance: string;
}

/**
 * Every failure code a handler generates, with what to do about it.
 *
 * A code in this table is one whose state is known: the stamp can say what
 * happened to the write and what fixes it. A code outside it is
 * `internal_error` and gets the floor alone. Individual throw sites override
 * `recovery` where they know more — a partial `create_doc` names the room and
 * the call that finishes it — but never contradict the class.
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
  guidance_required: {
    recoveryClass: "reread",
    guidance: "Read each unread guidance document with get_doc, then retry the refused tool call.",
  },
  persistence_failed: {
    recoveryClass: "manual",
    guidance:
      "The update log refused a write, so this server is fail-stopped: ordinary workspace tools refuse until the process is " +
      "restarted, and repeating this call now cannot succeed. Restart the MCP server, then re-read before writing " +
      "again — a refused write never became durable anywhere.",
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
  annotation_range: {
    recoveryClass: "reread",
    guidance:
      "Call get_doc for the block's current text and its existing threads, then annotate a range that fits it — " +
      "`reason` says which of the two is in the way.",
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
      "(code, mermaid, terminal and chart hold source text; table links belong to cells and have no block-level ranges) or `overlap` (the range " +
      "is already an external link, and one range cannot be both).",
  },
  // Never `retry`: the directory is a synced document, so a target this
  // replica has not heard of does not arrive by calling again — it arrives, if
  // it ever does, over the hub.
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
  // The default, and the one row a throw site always replaces: whether waiting
  // can work depends on the hub this replica has, so `requireDoc` derives the
  // pair from the hub state it is already carrying. See {@link hydrationRecovery}.
  doc_not_hydrated: {
    recoveryClass: "retry",
    guidance:
      "The document is known but its room has not reached this replica yet, and nothing was written. Call again " +
      "in a moment; sync_status says whether the hub can still deliver it.",
  },
  doc_archived: {
    recoveryClass: "manual",
    guidance:
      "Archived documents are read-only. Call restore_doc for this uuid — the only mutation an archived document " +
      "accepts — and then make this call again.",
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
      "A decided record's title, decision line, blocks and structured data are read-only. Create an open superseding record " +
      "for any content change, then record a person's answer to decide it. Comments stay open.",
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
  governs_not_requirement: {
    recoveryClass: "reread",
    guidance:
      "Choose a live requirement UUID from list_docs with `kind: requirement`, then call create_doc again. " +
      "Nothing was created by this refused call.",
  },
  invalid_tag_assignment: {
    recoveryClass: "manual",
    guidance:
      "Call list_tags for the complete active catalog, then call again with active ids or exact active names. " +
      "An existing retired or unresolved assignment can be preserved by passing the id returned by the document read.",
  },
  supersedes_not_decision: {
    recoveryClass: "reread",
    guidance:
      "Choose a decision UUID from list_docs with `kind: decision`, then call create_doc again. Nothing was " +
      "created by this refused call.",
  },
};

/**
 * What to do about `doc_not_hydrated`, read from the hub this replica has.
 *
 * The room is missing, not lost: it arrives over the hub, or it does not
 * arrive at all. So the class is a statement about the connection rather than
 * about the document. `retry` while a hub that could still deliver it is in the
 * picture — connected, connecting, or down and reconnecting on its own —
 * because the same call then succeeds unchanged and nothing was written. Where
 * no hub can deliver it — none configured, a credential the hub refused, a
 * protocol version the hub refuses, a replica quarantined after a refused log
 * write — waiting is advice that loops,
 * so it is `manual` and says what a human has to change. In that state the
 * directory stub stays dangling: an entry pointing at a room this replica will
 * never receive.
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
 * What to do about an invalid tag value on a replica whose catalog has not
 * arrived.
 *
 * The class answers the same question an unhydrated room asks — can this hub
 * still deliver it? — so it comes from {@link hydrationRecovery} rather than
 * being classified twice. The sentence is the part that differs: the table's
 * "call list_tags" is advice that loops here, because the catalog `list_tags`
 * would answer from is the one that has not arrived.
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
 * Every code this server can answer with, the unclassified fallback included.
 * The contract test enumerates it, so a code added without a recovery class is
 * a test failure rather than a surprise for an agent.
 */
export const FAILURE_CODES: readonly string[] = [
  ...Object.keys(RECOVERIES),
  "internal_error",
];

/**
 * The whole contract, in the words an agent reads — carried ONCE, in the
 * bundled tool-contracts help topic (see ./help-topics.ts).
 *
 * Repeating a hundred and fifty words on every tool cost each session tens of
 * kilobytes of `tools/list` to say the same thing once per tool, and the bill
 * grew with the tool set. The prose belongs where a client reads it once;
 * per-tool descriptions point to tool-contracts for the shared failure shape.
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
  "A failure of a reading tool carries none of those three: there was no write to report on. `internal_error` is " +
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
 * Stamp the common floor onto one failure payload.
 *
 * The payload is spread last, so a throw site that knows more than the table
 * wins: a partial `create_doc` keeps its own `recovery`, its `completed` rooms
 * and the `partial: true` that goes with them.
 */
function stamped(
  tool: string,
  payload: Record<string, unknown> & { error: string },
): ToolFailure {
  const recovery = RECOVERIES[payload.error];
  if (recovery === undefined) {
    return failure(payload);
  }
  return failure({
    ...(MUTATING_TOOLS.has(tool)
      ? { applied: false, partial: false, synced: false }
      : {}),
    recoveryClass: recovery.recoveryClass,
    recovery: recovery.guidance,
    ...payload,
  });
}

/**
 * Map a thrown error onto a tool failure.
 *
 * Block comparison errors come back with `currentText` and `currentRev`, so a
 * caller can re-diff and retry without another round trip.
 */
export function toFailure(tool: string, error: unknown): ToolFailure {
  if (error instanceof ServerShuttingDownError) {
    return stamped(tool, { error: "server_shutting_down", message: error.message });
  }
  if (error instanceof DataError) {
    return stamped(tool, {
      error: error.code,
      message: error.message,
      ...error.details,
    });
  }
  if (error instanceof TableMappingRequiredError) {
    return stamped(tool, { error: "table_mapping_required", message: error.message });
  }
  if (error instanceof InvalidTableMappingError) {
    return stamped(tool, { error: "invalid_table_mapping", message: error.message });
  }
  if (error instanceof InvalidTableError) {
    return stamped(tool, { error: "invalid_table", message: error.message });
  }
  if (error instanceof AnnotationCellError) {
    return stamped(tool, {
      error: "annotation_cell",
      message: error.message,
      blockId: error.blockId,
      reason: error.reason,
    });
  }
  if (error instanceof PersistenceError) {
    // Fail-stop: later ordinary workspace calls land here until restart
    // — reads included, because a replica ahead of its own log may not hand out
    // what a restart will drop. The mutation state comes from the stamp like
    // every other code's, so a READ that lands here still reports on no write.
    return stamped(tool, {
      error: "persistence_failed",
      message: PERSISTENCE_ERROR_MESSAGE,
      room: error.room,
    });
  }
  if (error instanceof StaleBlockError) {
    return stamped(tool, {
      error: "stale_block",
      message: error.message,
      blockId: error.blockId,
      expectedText: error.expectedText ?? null,
      expectedRev: error.expectedRev ?? null,
      currentText: error.currentText,
      currentRev: error.currentRev,
      retry: "re-read nothing: call again with currentRev, against currentText",
    });
  }
  if (error instanceof OldTextMismatchError) {
    return stamped(tool, {
      error: "old_text_mismatch",
      message: error.message,
      blockId: error.blockId,
      expectedText: error.expectedText,
      expectedRev: error.expectedRev,
      currentText: error.currentText,
      currentRev: error.currentRev,
      retry: "correct old_text, re-diff against currentText, and call again with currentRev",
    });
  }
  if (error instanceof BlockNotFoundError) {
    return stamped(tool, {
      error: "block_not_found",
      message: error.message,
      blockId: error.blockId,
    });
  }
  // The two ways a range refuses an inline link, under one code with a
  // `reason` — the shape `annotation_range` already has. The conflicting-marks
  // error is #443's own boundary and names both targets, so it keeps them.
  if (error instanceof InlineLinkRangeError) {
    return stamped(tool, {
      error: "inline_link_range",
      message: error.message,
      reason: error.reason,
      blockId: error.blockId,
      blockType: error.blockType ?? null,
    });
  }
  if (error instanceof ConflictingLinkMarksError) {
    return stamped(tool, {
      error: "inline_link_range",
      message: error.message,
      reason: "overlap",
      href: error.href,
      docId: error.docId,
    });
  }
  if (error instanceof AnnotationRangeError) {
    return stamped(tool, {
      error: "annotation_range",
      message: error.message,
      reason: error.reason,
      blockId: error.blockId,
      conflictingThreadId: error.conflictingThreadId ?? null,
    });
  }
  if (error instanceof InvalidDocumentLifecycleError) {
    return stamped(tool, {
      error: "invalid_document_lifecycle",
      message: error.message,
      kind: error.kind,
      status: error.status,
    });
  }
  if (error instanceof InvalidTagAssignmentError) {
    return stamped(tool, {
      error: "invalid_tag_assignment",
      message: error.message,
      unknown: error.unknown,
      retired: error.retired,
      ...(tool === "set_metadata" ? { field: "tags" } : {}),
    });
  }
  if (error instanceof ToolError) {
    return stamped(tool, {
      error: error.code,
      message: error.message,
      ...error.detail,
    });
  }
  // The exception's own text is for the operator, never for the caller: it can
  // hold an absolute path, a SQL statement, or whatever a dependency put in it.
  // stderr keeps the original; the client gets a sentence that says as much as
  // is safe to say.
  log.error("tool call failed", error);
  return stamped(tool, { error: "internal_error", message: INTERNAL_ERROR_MESSAGE });
}

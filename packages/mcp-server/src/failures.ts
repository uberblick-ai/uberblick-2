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
 *   unchanged, can succeed later), `reread` (read current state and call again
 *   with it) or `manual` (a named repair — another tool, or a restart), and
 *   `recovery` is the sentence saying what to do. A retry that cannot work is
 *   never labelled `retry`: `persistence_failed` is sticky until the process
 *   restarts, so it is `manual`.
 *
 * Two classes sit deliberately outside the table.
 *
 * `internal_error` is the unclassified fallback. A handler that threw something
 * nobody mapped cannot honestly claim its write did not land, so it carries the
 * floor — `error` and `message` — and nothing else. Stamping `applied: false`
 * onto it would be the one lie this contract exists to prevent.
 *
 * Arguments that do not match a tool's input schema never reach a handler at
 * all: the MCP SDK rejects them at the protocol boundary with its own
 * plain-text validation error, before any code here runs and therefore before
 * anything durable could change. That class is documented rather than wrapped —
 * disguising it as a handler failure would make a boundary rejection look like
 * a call that got somewhere.
 *
 * Nothing here promises a rollback, and nothing here reconciles: a call that
 * touched several rooms reports what is durable and names the call that
 * finishes the job. See ./tools.ts (`create_doc`'s `RECOVERY`) for the
 * room-by-room wording.
 */

import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import {
  AnnotationRangeError,
  BlockNotFoundError,
  StaleBlockError,
} from "@uberblick/schema";
import { log } from "./log.js";
import { PersistenceError } from "./replica.js";

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
 * A hand-kept list on purpose: "does this tool write" is a fact about the tool,
 * not something to infer at runtime. {@link READ_ONLY_TOOLS} holds the other
 * half, and a contract test checks the two together against what the server
 * actually registers — so a tool added later is classified or the suite fails.
 */
export const MUTATING_TOOLS: ReadonlySet<string> = new Set([
  "create_doc",
  "edit_block",
  "insert_block",
  "delete_block",
  "set_tags",
  "set_links",
  "set_title",
  "set_description",
  "archive_doc",
  "restore_doc",
  "annotate",
  "pin_doc",
  "unpin_doc",
  "sidebar_group",
  "rate_doc",
]);

/** The tools that only read. Their failures invent no mutation state. */
export const READ_ONLY_TOOLS: ReadonlySet<string> = new Set([
  "get_doc",
  "list_docs",
  "search",
  "backlinks",
  "export_markdown",
  "sync_status",
  "get_sidebar",
  "feedback_report",
]);

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
  persistence_failed: {
    recoveryClass: "manual",
    guidance:
      "The update log refused a write, so this server is fail-stopped: every tool refuses until the process is " +
      "restarted, and repeating this call now cannot succeed. Restart the MCP server, then re-read before writing " +
      "again — a refused write never became durable anywhere.",
  },
  stale_block: {
    recoveryClass: "reread",
    guidance:
      "The block changed under you. This answer already carries `currentText` and `currentRev`, so re-diff " +
      "against them and call edit_block again with `currentRev` — no extra read is needed.",
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
  doc_not_found: {
    recoveryClass: "reread",
    guidance:
      "Nothing in this workspace answers to that uuid. Call list_docs or search to find the document — identity " +
      "is the uuid, never the title.",
  },
  doc_not_hydrated: {
    recoveryClass: "retry",
    guidance:
      "The document is known but its room has not reached this replica yet, and nothing was written. Call again " +
      "in a moment: sync_status says whether the hub is reachable, and a document that stays unhydrated is " +
      "waiting on a reconnect or a restart.",
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
  invalid_arguments: {
    recoveryClass: "manual",
    guidance:
      "The arguments are each valid but do not add up to a call this tool can make — `message` says which. " +
      "Repeating them unchanged fails the same way; fix them and call again.",
  },
};

/**
 * Every code this server can answer with, the unclassified fallback included.
 * The contract test enumerates it, so a code added without a recovery class is
 * a test failure rather than a surprise for an agent.
 */
export const FAILURE_CODES: readonly string[] = [
  ...Object.keys(RECOVERIES),
  "internal_error",
];

/** The floor, in the words an agent reads. Carried by every tool. */
const FAILURE_FLOOR =
  "Failures: every failure this tool generates is JSON with a stable `error` code and a human `message`, and — " +
  "wherever recovery is actionable — a `recoveryClass` of `retry` (this same call can succeed later), `reread` " +
  "(read current state and call again with it) or `manual` (a named repair: another tool, or a restart), plus a " +
  "`recovery` sentence saying what to do. Domain detail stays where it was: `stale_block` still carries " +
  "`currentText` and `currentRev`, `persistence_failed` still names the `room`. `internal_error` is the one code " +
  "with no class, because a handler that threw something unmapped cannot honestly say what to do about it. " +
  "Arguments that do not match this schema never reach the tool at all: the MCP layer rejects them with its own " +
  "plain-text validation error, and nothing durable changes.";

/** What a failing WRITE additionally owes its caller. */
const MUTATION_FLOOR =
  "A failure here also says what happened to your write: `applied` (everything this call meant to write is " +
  "durable in this server's update log), `partial` (only some of it is — `completed` names the rooms that are) " +
  "and `synced`. `applied: false, partial: false` is the ordinary case and means nothing changed locally. " +
  "Nothing is ever rolled back: a partial write is finished by following `recovery`, not undone.";

/**
 * The failure paragraphs for one tool's description, ready to append.
 *
 * Derived from {@link MUTATING_TOOLS} rather than written per tool, so a
 * mutating tool cannot document the read-only contract by accident.
 */
export function failureContract(tool: string): string {
  return MUTATING_TOOLS.has(tool)
    ? `\n\n${FAILURE_FLOOR}\n\n${MUTATION_FLOOR}`
    : `\n\n${FAILURE_FLOOR}`;
}

function failure(payload: Record<string, unknown>): CallToolResult {
  return {
    isError: true,
    content: [{ type: "text", text: JSON.stringify(payload, null, 2) }],
  };
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
): CallToolResult {
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
 * `StaleBlockError` is the interesting one: it comes back as the re-read
 * payload — `currentText` and `currentRev` — so a caller can re-diff and retry
 * without another round trip.
 */
export function toFailure(tool: string, error: unknown): CallToolResult {
  if (error instanceof PersistenceError) {
    // Fail-stop: every later call lands here too, until the server is restarted.
    // The mutation state is spelled out rather than stamped, because this is the
    // one failure a READ answers with as well — the log, not the tool, is what
    // failed — and `applied: false` is the true statement in both cases.
    return stamped(tool, {
      error: "persistence_failed",
      message: error.message,
      room: error.room,
      applied: false,
      partial: false,
      synced: false,
    });
  }
  if (error instanceof StaleBlockError) {
    return stamped(tool, {
      error: "stale_block",
      message: error.message,
      blockId: error.blockId,
      expectedText: error.expectedText,
      expectedRev: error.expectedRev ?? null,
      currentText: error.currentText,
      currentRev: error.currentRev,
      retry: "re-diff against currentText and call edit_block again with currentRev",
    });
  }
  if (error instanceof BlockNotFoundError) {
    return stamped(tool, {
      error: "block_not_found",
      message: error.message,
      blockId: error.blockId,
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
  if (error instanceof ToolError) {
    return stamped(tool, {
      error: error.code,
      message: error.message,
      ...error.detail,
    });
  }
  log.error("tool call failed", error);
  return stamped(tool, {
    error: "internal_error",
    message: error instanceof Error ? error.message : String(error),
  });
}

/**
 * Wrap a handler so every throw becomes a structured tool failure.
 *
 * The tool's own name is what tells the contract whether this call could have
 * written anything — the single fact a failure payload cannot work out for
 * itself, since the same `doc_not_found` is a read's dead end and a write's.
 */
export function guarded<Args>(
  tool: string,
  handler: (args: Args) => Promise<CallToolResult>,
): (args: Args) => Promise<CallToolResult> {
  return async (args: Args) => {
    try {
      return await handler(args);
    } catch (error) {
      return toFailure(tool, error);
    }
  };
}

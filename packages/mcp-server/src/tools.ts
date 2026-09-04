/**
 * The v0 MCP tool set.
 *
 * Twenty-four tools and no more: create_doc, get_doc, list_docs, search,
 * backlinks, edit_block, insert_block, delete_block, set_tags, set_links,
 * set_title, set_description, set_status, set_changelog_suggestion, archive_doc,
 * restore_doc, annotate, link_range,
 * export_markdown, sync_status, the four sidebar tools registered from
 * ./sidebar-tools.ts — get_sidebar, pin_doc, unpin_doc, sidebar_group. There is
 * deliberately no whole-document write — every
 * content change names one block — no markdown-import tool, because markdown
 * is an export format, and no hard delete: archive_doc tombstones the
 * directory stub and leaves every byte of the document where it was. An
 * archived document is read-only rather than gone — every mutator goes through
 * `requireWritableDoc`, which refuses one and names restore_doc.
 *
 * Every handler starts with `replicas.settle()`: replay the log tail (another
 * MCP instance may have written since the last call) and, on boot or after a
 * reconnect, wait briefly for the hub. Every mutating handler ends with
 * `{applied, synced}` plus the hub's state, because "applied locally" is not
 * "synced" and an agent deserves to know which one it got — and `synced` is not
 * "stored by the hub" either, which is why {@link SYNCED_MEANS} says so in the
 * tool descriptions rather than leaving the word to be read generously.
 *
 * Every handler is wrapped by `guarded` from ./failures.ts, which owns the
 * other half of that honesty: what a call answers with when it fails. The
 * failure floor — the `error` code, the `message`, what happened to the write
 * and how to recover — is stamped there rather than restated at each throw
 * site, so the throw sites here carry only what they know on top of it.
 *
 * All document reads and writes go through `@uberblick/schema`. That is not
 * politeness: the web editor destroys content outside its palette, and the
 * schema helpers are what keep this server inside it.
 */

import { randomUUID } from "node:crypto";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import {
  BLOCK_TYPES,
  DECISION_STATUSES,
  DOCUMENT_KINDS,
  InvalidDocumentLifecycleError,
  MAX_DESCRIPTION_LENGTH,
  REQUIREMENT_STATUSES,
  addDecision,
  addComment,
  appendBlock,
  canonicalDocumentUuid,
  createAnnotation,
  deleteBlock,
  editBlock,
  exportMarkdown,
  getBlock,
  getBlockRev,
  getBlocksWithInline,
  getDirectoryEntry,
  getMeta,
  initDoc,
  insertBlock,
  isDocumentStatusForKind,
  isProseBlockType,
  listAnnotations,
  listDirectory,
  readDecisions,
  resolveAnnotationRange,
  restoreDirectoryEntry,
  setChangelogSuggestion,
  setDescription,
  setInlineLink,
  setKind,
  setLinks,
  setStatus,
  setTags,
  setTitle,
  tombstoneDirectoryEntry,
  upsertDirectoryEntry,
} from "@uberblick/schema";
import type {
  Annotation,
  BlockInput,
  DirectoryEntry,
  DocumentKind,
  DocumentStatus,
  HeadingLevel,
  InlineMarkSet,
  InlineRun,
} from "@uberblick/schema";
import { z } from "zod";
import {
  ToolError,
  failureContract,
  guarded,
  hydrationRecovery,
} from "./failures.js";
import { strictInput } from "./inputs.js";
import type { ToolMode } from "./inputs.js";
import { docLinkRanges } from "./replica.js";
import type { Replica, Replicas } from "./replica.js";
import {
  pinnedUuids,
  placeInGroup,
  registerSidebarTools,
  requireGroup,
} from "./sidebar-tools.js";
import type { SidebarPlacement } from "./sidebar-tools.js";
import { collectSyncStatus } from "./status.js";

function json(payload: unknown): CallToolResult {
  return {
    content: [{ type: "text", text: JSON.stringify(payload, null, 2) }],
  };
}

/**
 * The exact claim `synced: true` makes, in the words an agent reads.
 *
 * The hub acknowledges an update on receipt and only schedules the write, so an
 * acknowledged update is in the hub's memory, not on its disk. Narrowing the
 * word here is the honest fix: the hub cannot store per update, because its
 * SQLite extension writes the whole document state per store call.
 */
const SYNCED_MEANS =
  "`synced: true` means the hub acknowledged this update: it is in the hub's memory, and a healthy hub has " +
  "scheduled the write on its store debounce — by default 2s after the last change to the document, 10s at the " +
  "outside. It does NOT mean the hub has stored it: the write is still ahead of the hub's disk, and the store " +
  "itself can fail. A hub that dies abruptly inside that window (SIGKILL, a crash, power loss) loses its " +
  "volatile copy of the update. That is recoverable rather than fatal: `applied: true` is the durable half — " +
  "this server's append-only update log holds the write before the tool returns and re-sends it on reconnect — " +
  "so losing it for good takes the crash plus no replica holding that update ever coming back.";

/**
 * What concurrency does to an archive, in the words an agent reads.
 *
 * A directory stub is written whole, so two replicas disagreeing about one
 * document's fate converge on an update order rather than on an intent. Saying
 * so is cheaper than an agent inferring a guarantee that is not there.
 */
const ARCHIVE_IS_LAST_WRITE_WINS =
  "Concurrency: a directory entry is written as a whole object, so an archive_doc racing a restore_doc on another " +
  "replica converges on whichever update Yjs orders last — not on whichever call happened later by the clock. The same " +
  "applies to a plain rename or retag made on a replica that had not yet seen the archive: it is a whole-entry write " +
  "too, so it can bring the document back with nobody calling restore_doc. An archive holds against writers that have " +
  "seen it, which is not the same as holding against every concurrent one. When it matters which way it went, re-read " +
  "with list_docs and `include_deleted: true`; for a decision, also pass a matching `kind`, `status` or `tag` predicate.";

/**
 * What an archive costs a writer, in the words an agent reads.
 *
 * Every mutator carries this, because "archived" is otherwise indistinguishable
 * from "gone" — and the honest half matters as much as the refusal: this is a
 * check against one replica's directory stub, not a lock over the corpus.
 */
const ARCHIVED_IS_READ_ONLY =
  "Archived documents are read-only. While a document's directory stub is tombstoned this tool refuses with " +
  "`doc_archived` and changes nothing; restore_doc is the only mutation an archived document accepts, and the only " +
  "way back. Reading is unaffected — get_doc, export_markdown, backlinks and `list_docs` with `include_deleted: true` " +
  "all still answer for it; a decision additionally needs a matching `kind`, `status` or `tag` predicate in list_docs.\n\n" +
  "The honest scope, the same discipline `rev` has: the check runs against THIS replica's directory stub at the " +
  "moment of the call. It is refusal-at-call, not a cross-replica lock — an edit made on a replica that has not seen " +
  "the archive yet is an ordinary CRDT write and merges normally when the two replicas meet.";

/**
 * What a splice costs the marks already in a block — the boundary that is
 * mechanically fine and semantically wrong, so it has to be said rather than
 * left to be discovered in a damaged document.
 */
const MARKS_ANCHOR_TO_POSITIONS =
  "Marks anchor to positions in the block's text, not to the words they cover, and this tool writes text " +
  "without ever writing a mark. A splice strictly inside unmarked text leaves every mark — inline formatting " +
  "and annotation anchors alike — exactly where it was. A splice that touches a mark's edge re-anchors it: " +
  "rewrite a bolded term, or the separator between two marked ones, and the mark can open mid-word, swallow " +
  "the punctuation beside it, or spread over text nobody formatted. The marks survived; the formatting is now " +
  "wrong, and nothing here detects that.\n\n" +
  "So edit a block that carries formatting only where the changed range lies strictly inside unmarked text. " +
  "For anything else — a marked span itself, or a range whose edges touch one — delete_block plus insert_block " +
  "is the repair: it writes plain text, losing the formatting instead of corrupting it. Check the result with " +
  "export_markdown, where a mark whose edges are whitespace, or that has swallowed a `, ` or an ` and `, is the " +
  "damage showing.";

/** The same narrowing for the mutators that do not restate it in full. */
const SYNCED_IS_ACKNOWLEDGED =
  "`synced` here means hub-acknowledged, not hub-stored — see sync_status for the exact claim and its crash window.";

// Identity is UUIDs, so the boundary checks for one. A tool that accepted any
// string would let an agent persist an identity nothing can ever resolve.
const uuidArg = z.uuid().describe("Document UUID.");

const linkArg = z
  .uuid("a link is a target document UUID, never a path or a title")
  .describe("Target document UUID.");

/**
 * What a description is for, in the words an agent reads. Stated wherever one is
 * asked for, because a description written for a human reader — "notes", "misc"
 * — costs the corpus the whole benefit of having them.
 */
const DESCRIPTION_IS_FOR_CHOOSING =
  "A description is written for an agent deciding whether to open this document. One or two sentences saying what " +
  "is in it and what it is for, concrete enough to tell it apart from its neighbours — list_docs, search and " +
  "backlinks all answer with it, so a good one saves a get_doc and a bad one wastes it. " +
  `At most ${MAX_DESCRIPTION_LENGTH} characters.`;

/** The one-line prompt a mutating tool carries when a document has none. */
const DESCRIPTION_NUDGE =
  "This document has no description: call set_description with one or two sentences saying what it is for, so " +
  "list_docs and search can answer for it without anyone opening it.";

/**
 * `trim` before the length checks, and the order is the point: it makes both
 * bounds measure the description rather than the whitespace around it. Without
 * it `"   "` is a legal description — it would pass `min(1)`, be stored in the
 * document and the stub, and silence the very nudge that exists to get a real
 * one written. The parsed value is the trimmed one, so what is stored is what
 * was checked.
 */
const descriptionArg = z
  .string({
    error:
      "create_doc and set_description require a `description`: one or two sentences saying what the document " +
      "is for, so agents can judge it from list_docs and search without opening it.",
  })
  .trim()
  .min(1, "a description cannot be empty or whitespace")
  .max(
    MAX_DESCRIPTION_LENGTH,
    `a description is at most ${MAX_DESCRIPTION_LENGTH} characters — one or two sentences, not a summary`,
  )
  .describe(DESCRIPTION_IS_FOR_CHOOSING);

/**
 * What a changelog suggestion is, and how its three states are asked for.
 *
 * The same trim-then-measure discipline {@link descriptionArg} has, and the
 * same ceiling: document metadata has one length to remember. The field is
 * required, so each state is a value rather than an absence — omitting it would
 * be a fourth, unstated answer.
 */
const changelogSuggestionArg = z
  .string({
    error:
      "set_changelog_suggestion requires a `suggestion`: the sentence, null for a change that deliberately " +
      "needs no user-facing entry, or the empty string to take back whatever is stored.",
  })
  .trim()
  .max(
    MAX_DESCRIPTION_LENGTH,
    `a changelog suggestion is at most ${MAX_DESCRIPTION_LENGTH} characters — one sentence of release-note copy`,
  )
  .nullable()
  .describe(
    "One sentence of draft release-note copy in simple English, about what a user can now do rather than how it " +
      "was built. `null` records that this work deliberately needs no user-facing entry; the empty string — or " +
      "only whitespace, which trims to it — takes back whatever is stored, leaving the document as one nobody " +
      "has written a suggestion for. " +
      `At most ${MAX_DESCRIPTION_LENGTH} characters.`,
  );

/**
 * A title, trimmed before it is measured — the same discipline
 * {@link descriptionArg} has, and for the same reason: `"   "` would otherwise
 * be a legal title, stored in the document, cached in the stub, and answered
 * with by every discovery surface. Length is not bounded, because nothing
 * bounds a title anywhere else; emptiness is the only thing that makes a
 * document unfindable in a listing.
 *
 * `create_doc` and `set_title` share it so the MCP surface has one rule for
 * titles: neither tool can put a document into a state the other refuses to
 * leave it in.
 */
const titleArg = z
  .string()
  .trim()
  .min(1, "a title cannot be empty or whitespace")
  .describe("Display title. Identity is the document's UUID, never this.");

const documentKindArg = z.enum(DOCUMENT_KINDS).describe(
  "The document's record kind. Omit it for an ordinary working document.",
);

const documentStatusArg = z
  .enum([...REQUIREMENT_STATUSES, ...DECISION_STATUSES])
  .describe("The recorded lifecycle state. Its kind owns the legal values.");

const CREATE_DOC_LIFECYCLE_MODES: readonly ToolMode[] = [
  {
    title: "A decision document (`kind: decision`)",
    when: { field: "kind", is: "decision" },
  },
  {
    title: "A requirement document (`kind: requirement`)",
    when: { field: "kind", is: "requirement" },
    forbids: ["governs"],
  },
  {
    title: "An ordinary document",
    when: { field: "kind", present: false },
    forbids: ["status", "governs"],
  },
];

const LIFECYCLE_RECORDS_STATE =
  "`kind` and `status` record what sort of document this is and where it stands. They do not authorize " +
  "execution: that authority comes from the owner's recorded GitHub decision.";

const DECISION_EDGES =
  "A document's `decisions` are an ordered log resolved from its decision slot. Their UUIDs are also derived " +
  "outbound edges in `links`. `set_links` still replaces only the curated link array with exactly what it is " +
  "given, so passing get_doc's effective `links` back to it stores any decision UUIDs there too; get_doc " +
  "deduplicates the resulting edge.";

function firstStatus(kind: DocumentKind): DocumentStatus {
  return kind === "requirement"
    ? REQUIREMENT_STATUSES[0]
    : DECISION_STATUSES[0];
}

function kindForStatus(status: DocumentStatus): DocumentKind {
  return REQUIREMENT_STATUSES.some((candidate) => candidate === status)
    ? "requirement"
    : "decision";
}

/** What `inline` is for, in the words an agent reads. */
const INLINE_RUNS =
  "Formatted content for a PROSE block (paragraph, heading, list-item, quote), as runs of equally-marked text: " +
  "`[{text, marks}]`, where marks are `bold`, `italic`, `strike`, `inlineCode`, `link` (an external http(s) URL) " +
  "and `docLink` (another document's UUID — the inline way to cite one). When present it REPLACES `text`, so the " +
  "run texts joined together are the block's text. Source blocks — code, mermaid, table — hold source text and " +
  "ignore it.\n\n" +
  "A `docLink` run with an EMPTY `text` is filled in for you with the target's current title, so `{text: \"\", " +
  "marks: {docLink: \"<uuid>\"}}` is how you cite a document without looking its title up first. A target this " +
  "replica's directory has never heard of fails the call with `doclink_target_not_known_locally` and writes " +
  "nothing; an archived target is fine.";

/**
 * `link`'s boundary check, kept identical to the schema's `isExternalHref`.
 *
 * At the input boundary rather than in the handler on purpose: a target the
 * model refuses is a wrong argument, and the MCP layer rejects those before a
 * handler runs and therefore before anything durable could change.
 */
const EXTERNAL_HREF = /^https?:\/\/\S+$/i;

/**
 * A document reference's target, canonicalised at the boundary.
 *
 * One document has one spelling. An upper-cased uuid names the same document —
 * room names are case-sensitive keys, so `A…` and `a…` would be two rooms
 * holding one document — and the schema canonicalises it down at the write. Do
 * it here instead, once, so the directory lookup, the label, the write and the
 * answer all speak the id the model stores rather than the one the caller
 * happened to type. The refusal branch is `z.uuid`'s leftovers: this is the
 * model's own rule, not a second one.
 */
const docLinkTargetArg = z
  .uuid("a document reference is a target document UUID, never a path or a title")
  .transform((value, ctx) => {
    const docId = canonicalDocumentUuid(value);
    if (docId === null) {
      ctx.addIssue({ code: "custom", message: "not a document UUID" });
      return z.NEVER;
    }
    return docId;
  });

const inlineArg = z
  .array(
    z
      .object({
        text: z.string(),
        marks: z
          .object({
            bold: z.boolean().optional(),
            italic: z.boolean().optional(),
            strike: z.boolean().optional(),
            inlineCode: z.boolean().optional(),
            link: z
              .string()
              .regex(EXTERNAL_HREF, "a link is an external http(s) URL")
              .optional(),
            docLink: docLinkTargetArg.optional(),
          })
          .strict()
          // Refused as the wrong argument it is, not as a range conflict: one
          // run carrying both link marks has no honest rendering, and there is
          // nothing to re-read that would make the call valid.
          .refine(
            (marks) => marks.link === undefined || marks.docLink === undefined,
            "a run is an external link or a document reference, never both",
          ),
      })
      .strict(),
  )
  .optional()
  .describe(INLINE_RUNS);

/**
 * One input run's marks as the model's mark set.
 *
 * Zod spells an optional property `T | undefined`; the model spells it absent —
 * and absent is what the model means, since a flag it reads as anything but
 * `true` is not that mark. So a key nobody set, and a flag explicitly set to
 * `false`, both simply do not appear.
 */
function inlineMarks(
  marks: NonNullable<z.infer<typeof inlineArg>>[number]["marks"],
): InlineMarkSet {
  return {
    ...(marks.bold === true ? { bold: true } : {}),
    ...(marks.italic === true ? { italic: true } : {}),
    ...(marks.strike === true ? { strike: true } : {}),
    ...(marks.inlineCode === true ? { inlineCode: true } : {}),
    ...(marks.link === undefined ? {} : { link: marks.link }),
    ...(marks.docLink === undefined ? {} : { docLink: marks.docLink }),
  };
}

const blockShape = {
  type: z.enum([...BLOCK_TYPES]),
  text: z.string().optional(),
  level: z
    .number()
    .int()
    .min(1)
    .max(6)
    .optional()
    .describe("Heading level. Headings only."),
  language: z
    .string()
    .optional()
    .describe("Code language, e.g. \"ts\". Code blocks only."),
  inline: inlineArg,
};

// Strict, like the sibling placement object: `create_doc`'s guarantee has to
// reach inside the array, or a block carrying a key the schema never declared
// is created with the key discarded. `insert_block` spreads the same shape at
// its top level, where strictInput already applies the rule.
const blockInputSchema = z.object(blockShape).strict();

/**
 * One block input, ready for the schema.
 *
 * `inline` arrives already resolved — see `resolveInline`, which fills an empty
 * docLink label with the target's title and refuses a target this replica has
 * never heard of. Resolution happens before this because it can fail, and a
 * refusal must leave nothing written.
 */
function toBlockInput(
  input: z.infer<typeof blockInputSchema>,
  inline?: InlineRun[],
): BlockInput {
  return {
    type: input.type,
    ...(input.text === undefined ? {} : { text: input.text }),
    ...(input.level === undefined
      ? {}
      : { level: input.level as HeadingLevel }),
    ...(input.language === undefined ? {} : { language: input.language }),
    ...(inline === undefined ? {} : { inline }),
  };
}

/**
 * Where a new document goes in the sidebar — optional, and the whole of it.
 *
 * Placement implies pinning, so there is no `pinned` boolean and no `state`
 * enum: a contradictory pair like `{pinned: false, group: …}` is not a state
 * this input can express. Both objects are `.strict()`, so a caller reaching
 * for either is told rather than having it silently dropped — and the group is
 * an object with an id rather than a bare name, because creating a group is
 * pin_doc's job and must not happen as a side effect of creating a document.
 */
const sidebarPlacementArg = z
  .object({
    group: z
      .object({
        id: z
          .string()
          .min(1)
          .describe(
            "An EXISTING group's id, as get_sidebar returns it. Never a name: an unknown id fails the call.",
          ),
        position: z
          .number()
          .int()
          .min(0)
          .optional()
          .describe("Position in the group, clamped into range. Omitted means last."),
      })
      .strict(),
  })
  .strict()
  .optional()
  .describe(
    "Optional sidebar placement. Omitted, the document is created unpinned — alive and reachable, simply not an " +
      "entry point.",
  );

/** What `create_doc` says about placement, in the words an agent reads. */
const CREATE_DOC_PLACEMENT =
  "`sidebar` is optional and is the only way to say where the document goes: omit it and the document is created " +
  "unpinned (the default, unchanged), or pass `{group: {id, position?}}` to pin it into a group that ALREADY " +
  "exists — the id comes from get_sidebar, `position` is clamped into range and omitted means last. There is no " +
  "`pinned` flag and no `state`: placement implies pinning, so a contradiction cannot be expressed. An unknown or " +
  "empty group id fails with `group_not_found` and creates nothing at all; this tool never creates a group, never " +
  "resolves one by name, and never guesses a default — pin_doc is what brings a group into being. The answer " +
  "echoes the placement it made as `sidebar: {group: {id, name}, position}`.";

/** What `create_doc` says about touching its rooms, in the words an agent reads. */
const CREATE_DOC_DURABILITY =
  "This call writes up to four independently persisted rooms — the document, the directory, the governed " +
  "requirement when `governs` is present, and the sidebar when you place it — so it reports them one by one. " +
  "`rooms` lists every room it touched with its own `applied` and `synced`; the top-level `synced` is the AND over " +
  "all of them and is never true while one is still pending. It is NOT transactional: there is no rollback and " +
  "no remote atomicity. If the local update log refuses a write part-way, the call fails with `persistence_failed` " +
  "carrying the `uuid`, the rooms already `completed`, the `failed` room, `rolledBack: false`, and a stage-aware " +
  "`recovery` line — the earlier rooms stay durable, and recovery never risks creating the decision twice.";

/** What to do after a partial create, by the room whose write the log refused. */
const RECOVERY: Record<string, string> & { other: string } = {
  document:
    "Nothing survived: the refused write is the document's own room, and neither the directory stub nor the " +
    "sidebar was touched. Restart the MCP server — the failure is sticky and every tool refuses until then — " +
    "then call create_doc again.",
  directory:
    "The document's own room is durable, but it has no directory stub, so list_docs and search will not show it. " +
    "Restart the MCP server, then get_doc with this uuid: hydrating the document republishes its stub. Add " +
    "pin_doc afterwards if you wanted the sidebar placement.",
  sidebar:
    "The document and its directory stub are durable; only the sidebar placement is missing. Restart the MCP " +
    "server, then pin_doc with this uuid and the same group id to finish it.",
  requirement:
    "The decision and its directory stub are durable, but the requirement it governs does not reference it. " +
    "Restart the MCP server, then read both with get_doc. If the requirement still has no such decision, use " +
    "archive_doc on this uuid to retire the orphan; do NOT call create_doc again as recovery for this call.",
  other:
    "The log refused a write to a room this call does not own — another document syncing while it ran. Restart " +
    "the MCP server, then check with list_docs and get_sidebar what the rooms in `completed` left behind.",
};

const REQUIREMENT_DIRECTORY_RECOVERY =
  "The decision, its directory stub and the governed requirement update are durable; a later directory append " +
  "was refused, usually the requirement's follow-up stub repair. Restart the MCP server, then read the requirement " +
  "and this uuid with get_doc. When `decisions` contains this uuid, the create succeeded — do NOT call create_doc " +
  "again.";

const DECISION_DIRECTORY_RECOVERY =
  "The decision's own room is durable, but it has no directory stub and the governed requirement does not " +
  "reference it. Restart the MCP server, then get_doc with this uuid to republish its stub. Use archive_doc on " +
  "this uuid to retire the orphan; do NOT call create_doc again as recovery for this call.";

/**
 * `annotate`'s two shapes, stated once for the boundary and for `tools/list`.
 *
 * The fields are not independently optional: a reply names a thread, opening
 * one names a block and a range, and a call carrying both says two things at
 * once. The shape is selected on `thread_id` rather than on an added `action`
 * field, so every call an agent already writes stays valid.
 */
const ANNOTATE_MODES: readonly ToolMode[] = [
  {
    title: "A reply (`thread_id`)",
    when: { field: "thread_id", present: true },
    forbids: ["block_id", "start", "end"],
  },
  {
    title: "Opening a thread over a range",
    when: { field: "thread_id", present: false },
    requires: ["block_id", "start", "end"],
  },
];

/** What `annotate` says about its two shapes, in the words an agent reads. */
const ANNOTATE_SHAPES =
  "Two shapes, and a call is exactly one of them: open a thread with `block_id`, `start` and `end` — all three, " +
  "none of them optional — or reply to one with `thread_id` and no range fields at all. Mixing them, or leaving a " +
  "range half-stated, is refused at the input boundary before anything is written, rather than resolved by " +
  "ignoring whichever fields do not fit. `text` and `author` belong to both.";

export function registerTools(server: McpServer, replicas: Replicas): void {
  /**
   * Resolve a document, or fail with a hub-aware message: a uuid in the
   * directory whose room has not reached this replica yet is a different
   * problem from a uuid nobody has heard of, and saying which is more useful
   * than "not found".
   *
   * A uuid nobody has heard of must not be opened as a room: joining one would
   * create an empty document on the hub for what is almost certainly a typo.
   */
  const requireDoc = (uuid: string): Replica => {
    const stub = getDirectoryEntry(replicas.directory().doc, uuid);
    if (!replicas.known(uuid) && stub === null && !replicas.hasLog(uuid)) {
      throw new ToolError(
        "doc_not_found",
        `No document ${uuid} in workspace ${replicas.config.workspaceId}`,
        { uuid, inDirectory: false, hub: replicas.sync.state() },
      );
    }

    const replica = replicas.replica(uuid);
    if (getMeta(replica.doc).uuid !== "") {
      // This boundary is what "working in a document" means: every tool that
      // reads or writes the room comes through here, and the ones that answer
      // from the derived index or the directory stub — `list_docs`, `search`,
      // `backlinks`, `archive_doc`, `restore_doc` — deliberately do not.
      replicas.touch(replica);
      return replica;
    }
    // Whether waiting can work is a fact about the hub, not about the document:
    // a room arrives over a connection, so a replica with none is not waiting
    // for anything. `hydrationRecovery` turns the hub state this failure is
    // already carrying into the class and the sentence that go with it.
    const hub = replicas.sync.state();
    throw new ToolError(
      "doc_not_hydrated",
      `Document ${uuid} is known but its room has not synced to this replica yet`,
      {
        uuid,
        inDirectory: stub !== null,
        hub,
        ...hydrationRecovery(hub.status),
      },
    );
  };

  /**
   * Resolve a document for an operation that writes only its directory stub.
   *
   * Deliberately weaker than {@link requireDoc}: archiving and restoring change
   * the directory, not the document, so demanding that the document itself have
   * reached this replica would strand exactly the case that needs the tool — a
   * fresh server that knows an archived document only from the directory could
   * never restore it, because an archived room is not one `adoptKnownDocs`
   * attaches.
   *
   * A uuid the directory has never seen is still refused. Tombstoning a typo
   * would publish an entry for a document that never existed, and a tombstone
   * is sticky.
   */
  const requireStub = (uuid: string): DirectoryEntry => {
    const stub = getDirectoryEntry(replicas.directory().doc, uuid);
    if (stub === null) {
      throw new ToolError(
        "doc_not_found",
        `No document ${uuid} in the directory of workspace ${replicas.config.workspaceId}`,
        { uuid, inDirectory: false, hub: replicas.sync.state() },
      );
    }
    return stub;
  };

  /**
   * Resolve a document for a write. The one choke point every mutator that
   * touches a document goes through — archived means read-only, and saying so
   * in one place is what keeps that true of tools written later.
   *
   * The archive check comes before {@link requireDoc} on purpose: an archived
   * room is not one `adoptKnownDocs` attaches, so a replica that knows the
   * document only from the directory would otherwise answer `doc_not_hydrated`
   * — technically true, and useless. The caller needs to hear `restore_doc`.
   *
   * Scope, stated the way {@link ARCHIVED_IS_READ_ONLY} states it to agents:
   * this reads THIS replica's stub at call time. There is no cross-replica
   * lock, so an edit racing an archive that has not arrived yet is an ordinary
   * CRDT write and merges. Enforcement is refusal-at-call — a client
   * convention, which is all the spike has; real enforcement belongs to the
   * hosted-auth era.
   */
  const requireWritableDoc = (uuid: string): Replica => {
    if (getDirectoryEntry(replicas.directory().doc, uuid)?.deleted === true) {
      throw new ToolError(
        "doc_archived",
        `Document ${uuid} is archived — restore_doc to edit`,
        { uuid, archived: true },
      );
    }
    return requireDoc(uuid);
  };

  /**
   * The document's own title where this replica holds it, the stub's cached one
   * otherwise — `meta.title` wins whenever there is a document to ask.
   */
  const titleFor = (uuid: string, stub: DirectoryEntry): string =>
    replicas.hydrated(uuid)
      ? getMeta(replicas.replica(uuid).doc).title
      : stub.title;

  /**
   * The title an inline reference to `docId` is written with, or a refusal.
   *
   * Refusing is the honest half: offline the directory hydrates from the log
   * like any other document, so "this replica has never heard of it" is not
   * "it does not exist" — hence the named code and the hub state, rather than
   * `doc_not_found`. An ARCHIVED target resolves: a tombstoned stub is still a
   * document, and reading one is allowed.
   */
  const linkTitle = (docId: string): string => {
    const stub = getDirectoryEntry(replicas.directory().doc, docId);
    if (stub === null) {
      throw new ToolError(
        "doclink_target_not_known_locally",
        `No document ${docId} in the directory of workspace ${replicas.config.workspaceId}, so an inline ` +
          "reference to it would point at nothing this replica can resolve",
        { docId, inDirectory: false, hub: replicas.sync.state() },
      );
    }
    return titleFor(docId, stub);
  };

  /**
   * Resolve an input's inline runs before a single byte is written.
   *
   * The one write that resolves a title: an empty-labelled docLink run gets the
   * target's current title, because a label is display text fixed at the moment
   * the link is made. A resolved title that is itself empty — a document the
   * web UI created and nobody has named — falls back to the uuid, since
   * `applyInlineRuns` drops an empty run and a dropped run is a link silently
   * lost.
   */
  const resolveInline = (
    runs: z.infer<typeof inlineArg>,
  ): InlineRun[] | undefined =>
    runs?.map((run) => {
      const marks = inlineMarks(run.marks);
      const docId = marks.docLink;
      if (docId === undefined) return { text: run.text, marks };
      // Resolved even when a label is already written: an unknown target is
      // refused either way, so a citation never points at nothing.
      const title = linkTitle(docId);
      if (run.text !== "") return { text: run.text, marks };
      return { text: title === "" ? docId : title, marks };
    });

  /**
   * One block input, with `inline` resolved only where it is going to be used.
   *
   * A source block — code, mermaid, table — carries no inline marks, so the
   * schema writes its `text` and drops `inline` entirely. Resolving anyway
   * would make an unknown reference target refuse a call whose inline runs were
   * never going to be written, so the type check lives here, once, in front of
   * both call sites.
   */
  const blockInputFor = (
    block: z.infer<typeof blockInputSchema>,
  ): BlockInput =>
    toBlockInput(
      block,
      isProseBlockType(block.type) ? resolveInline(block.inline) : undefined,
    );

  /**
   * A document's blocks as a read answers with them: every block exactly as it
   * has always been, plus the inline references it carries.
   *
   * `doc_links` is additive and absent where a block has none. `text` and `rev`
   * are untouched — they come off the same `Block` as before, and neither has
   * ever seen a mark.
   */
  const blocksJson = (replica: Replica): Record<string, unknown>[] =>
    getBlocksWithInline(replica.doc).map(({ block, inline }) => {
      const links = docLinkRanges(block, inline);
      return { ...block, ...(links.length === 0 ? {} : { doc_links: links }) };
    });

  /**
   * The backfill nudge, on every mutating answer for a document that has no
   * description.
   *
   * Enforcement is asymmetric on purpose: `create_doc` refuses without one, but
   * the web UI creates documents that have none, and refusing to edit those
   * would punish the agent for somebody else's omission. So a write succeeds and
   * says what is missing — and it says it to exactly the right party, since an
   * agent already working inside a document is the one who can describe it.
   *
   * Sitting in {@link durability} rather than in each handler is deliberate:
   * every mutator that touches a document goes through it, including ones
   * written later. The workspace's own rooms are skipped — the directory and
   * the sidebar are not documents and have no description to miss.
   */
  const descriptionGap = (replica: Replica): Record<string, unknown> => {
    if (replica.isDirectory || replica.isSidebar) {
      return {};
    }
    if (getMeta(replica.doc).description !== null) {
      return {};
    }
    return { description: null, descriptionHint: DESCRIPTION_NUDGE };
  };

  /**
   * What a mutating tool owes its caller: the write landed locally, and whether
   * it has reached the hub — which, right after a write, it has not.
   *
   * `synced` is "the hub acknowledged it", never "the hub stored it"; see
   * {@link SYNCED_MEANS} for the window that distinction leaves open.
   *
   * `assertHealthy` runs here, after the write: an append that failed during
   * *this* call must not be reported as applied. It throws, so the tool answers
   * with `persistence_failed` instead.
   */
  const durability = (replica: Replica): Record<string, unknown> => {
    replicas.assertHealthy();
    return {
      applied: true,
      synced: replicas.isRoomQuiet(replica.room),
      hub: replicas.sync.state(),
      ...descriptionGap(replica),
    };
  };

  /**
   * The same honesty for a call that mutated more than one room.
   *
   * The rooms are independently logged, independently sent and independently
   * acknowledged, so one boolean cannot describe them: `rooms` says where each
   * one stands, and the aggregate `synced` is the AND over all of them — never
   * true while a room this call touched is still pending. `applied` stays a
   * single word because it is one: {@link Replicas.assertHealthy} throws unless
   * every append reached the log, so the call either answers with all of them
   * durable or fails as `persistence_failed`.
   */
  const durabilityAcross = (
    primary: Replica,
    rooms: { purpose: string; room: string }[],
  ): Record<string, unknown> => {
    replicas.assertHealthy();
    const detail = rooms.map((entry) => ({
      ...entry,
      applied: true,
      synced: replicas.isRoomQuiet(entry.room),
    }));
    return {
      applied: true,
      synced: detail.every((entry) => entry.synced),
      rooms: detail,
      hub: replicas.sync.state(),
      ...descriptionGap(primary),
    };
  };

  const annotationJson = (
    replica: Replica,
    annotation: Annotation,
  ): Record<string, unknown> => ({
    ...annotation,
    range: resolveAnnotationRange(replica.doc, annotation.id),
  });

  server.registerTool(
    "create_doc",
    {
      title: "Create a document",
      description:
        "Create a document and publish its directory stub, so every client can discover it. " +
        "Blocks are optional: pass them to seed the document, or add them later with insert_block. " +
        "The write applies to the local replica and syncs in the background.\n\n" +
        "A `title` and a `description` are both REQUIRED here and the call fails without either, creating nothing. " +
        "A title cannot be empty or whitespace: an untitled document cannot be picked out of a listing, and " +
        "set_title is the repair for the untitled ones the web UI creates. " +
        DESCRIPTION_IS_FOR_CHOOSING +
        "\n\n" +
        "Pass `kind` to create a lifecycle document. Its `status` defaults to that kind's first state; `status` " +
        "without `kind`, or a status owned by the other kind, is refused before a document is created. " +
        LIFECYCLE_RECORDS_STATE +
        " A decision may pass `governs`, the UUID of a live, hydrated requirement in this replica. The decision " +
        "is made durable before its UUID is appended to that requirement's ordered decision log; any other use " +
        "of `governs` is refused before a UUID is allocated or a room is written. " +
        "\n\n" +
        CREATE_DOC_PLACEMENT +
        "\n\n" +
        CREATE_DOC_DURABILITY +
        "\n\n" +
        SYNCED_MEANS +
        failureContract("create_doc"),
      // `{sidebar: {...}, pinned: true}` must be refused wherever the redundant
      // key sits, so the nested placement object is strict too — see
      // {@link sidebarPlacementArg}. The top level is strict like every tool's.
      inputSchema: strictInput(
        {
          title: titleArg,
          description: descriptionArg,
          tags: z.array(z.string().min(1)).optional(),
          kind: documentKindArg.optional(),
          status: documentStatusArg.optional(),
          governs: uuidArg
            .optional()
            .describe(
              "Requirement UUID whose ordered decision log receives this new decision. Accepted only with `kind: decision`.",
            ),
          blocks: z
            .array(blockInputSchema)
            .optional()
            .describe("Initial blocks, in order."),
          sidebar: sidebarPlacementArg,
        },
        CREATE_DOC_LIFECYCLE_MODES,
      ),
    },
    guarded("create_doc", async ({
      title,
      description,
      tags,
      kind,
      status,
      governs,
      blocks,
      sidebar,
    }) => {
      await replicas.settle();

      const lifecycle =
        kind === undefined ? null : { kind, status: status ?? firstStatus(kind) };
      if (
        lifecycle !== null &&
        !isDocumentStatusForKind(lifecycle.kind, lifecycle.status)
      ) {
        const error = new InvalidDocumentLifecycleError(
          lifecycle.kind,
          lifecycle.status,
        );
        throw new ToolError("invalid_document_lifecycle", error.message, {
          kind: lifecycle.kind,
          status: lifecycle.status,
          recoveryClass: "manual",
          recovery:
            `Choose a status in the ${lifecycle.kind} lifecycle and call create_doc again. ` +
            "Nothing was created by this refused call.",
        });
      }

      const requirement =
        governs === undefined ? null : requireWritableDoc(governs);
      const requirementKind =
        requirement === null ? null : (getMeta(requirement.doc).kind ?? null);
      if (requirement !== null && requirementKind !== "requirement") {
        throw new ToolError(
          "governs_not_requirement",
          `Document ${governs} is not a requirement, so this decision cannot govern it`,
          { governs, kind: requirementKind },
        );
      }

      // Resolved before a uuid exists, because this is the one part of the call
      // that can still be all-or-nothing: an unknown group must fail having
      // created nothing. Everything after it is four independently persisted
      // rooms, reported one by one.
      const group =
        sidebar === undefined
          ? null
          : requireGroup(replicas, sidebar.group.id);

      // Same reason, same place: an inline reference to a target this replica
      // does not know refuses the whole call before there is a document.
      const inputs = (blocks ?? []).map(blockInputFor);

      const uuid = randomUUID();
      const replica = replicas.replica(uuid);
      // The one write that opens its room directly instead of through
      // `requireWritableDoc`, and it is working in the document like any other.
      replicas.touch(replica);
      const directory = replicas.directory();
      const sidebarReplica = replicas.sidebar();
      const completed: { purpose: string; room: string }[] = [];

      /** Which of this call's rooms a failed append names. */
      const purposeOf = (room: string): string => {
        if (room === replica.room) return "document";
        if (room === directory.room) return "directory";
        if (requirement !== null && room === requirement.room) {
          return "requirement";
        }
        if (room === sidebarReplica.room) return "sidebar";
        return "other";
      };

      /**
       * Write one room, then check the log took it before touching the next.
       *
       * A refused append is recorded rather than thrown (see replica.ts), so
       * without this check the next room would be written on top of a failure
       * and the caller would hear one room name for a call that had touched
       * three. Stopping here is what makes `completed` true.
       *
       * The failed room is the one the log named, not the stage that noticed:
       * writing a document publishes its directory stub through the observer,
       * so the directory is where a document write can fail. The recorded
       * failure is the first refused append, so a room written before it — this
       * stage's own, when the two names differ — did reach the log.
       *
       * The boundary: a second room failing inside this same call (another
       * document syncing while it ran) is the one case where the sticky failure
       * names a room this stage did not write, so the stage's own append is
       * reported durable without having been re-checked. `RECOVERY.other` is
       * why that is survivable — it tells the caller to re-verify with
       * list_docs and get_sidebar rather than trust `completed`.
       */
      /**
       * The one answer a create that stopped part-way gives, whichever way it
       * stopped: what is durable, what is not, that nothing was rolled back,
       * and what to do. One shape, because a caller that learns to read a
       * refused append must not have to learn a second one for a group that
       * disappeared underneath the same call.
       */
      const stoppedPartWay = (
        code: string,
        message: string,
        failed: { purpose: string; room: string },
        recovery: string,
        extra: Record<string, unknown> = {},
      ): ToolError =>
        // `applied`, `partial` and `synced` come from the shared stamp in
        // ./failures.ts; only what this call knows on top of them is here.
        new ToolError(code, message, {
          uuid,
          // Some of this call's work is durable whenever a room completed
          // before the one that failed — `completed` is which, and there is no
          // rollback that could make it false.
          partial: completed.length > 0,
          recoveryClass: "manual",
          rolledBack: false,
          completed: completed.map((entry) => ({ ...entry, applied: true })),
          failed,
          // The room every other failure of this kind names, kept so a caller
          // that reads one field reads the same field here.
          room: failed.room,
          recovery,
          ...extra,
        });

      const stage = (
        purpose: string,
        target: Replica,
        write: () => void,
      ): void => {
        write();
        const failure = replicas.persistenceError();
        if (failure === null) {
          completed.push({ purpose, room: target.room });
          return;
        }
        const failedAt = purposeOf(failure.room);
        if (failure.room !== target.room) {
          completed.push({ purpose, room: target.room });
        }
        throw stoppedPartWay(
          "persistence_failed",
          `The update log refused the write to ${failure.room}, so create_doc stopped part-way. ` +
            "Nothing was rolled back: the rooms in `completed` are durable and the rooms after " +
            `the failure were never written. Cause: ${failure.message}`,
          { purpose: failedAt, room: failure.room },
          purpose === "requirement" && failedAt === "directory"
            ? REQUIREMENT_DIRECTORY_RECOVERY
            : requirement !== null && failedAt === "directory"
              ? DECISION_DIRECTORY_RECOVERY
            : (RECOVERY[failedAt] ?? RECOVERY.other),
        );
      };

      stage("document", replica, () => {
        // One transaction, so the document's room is ONE append: without it the
        // metadata and each initial block are separate updates, and a refusal
        // on the third block would leave the first two — and the directory stub
        // the observer repaired from them — durable, under an error that says
        // nothing survived. The stage boundary this call reports is only true
        // if the write underneath it is atomic in the log.
        replica.doc.transact(() => {
          initDoc(replica.doc, {
            uuid,
            title,
            description,
            ...(tags === undefined ? {} : { tags }),
          });
          if (lifecycle !== null) {
            setKind(replica.doc, lifecycle.kind);
            setStatus(replica.doc, lifecycle.status);
          }
          for (const input of inputs) {
            appendBlock(replica.doc, input);
          }
        });
      });

      // Observing the document's own update repairs the stub, but a brand-new
      // document must be discoverable because create_doc said so, not because
      // a side effect happened to fire.
      stage("directory", directory, () => {
        if (getDirectoryEntry(directory.doc, uuid) !== null) return;
        const now = Date.now();
        upsertDirectoryEntry(directory.doc, {
          uuid,
          title,
          description,
          ...(tags === undefined ? {} : { tags }),
          ...(lifecycle === null ? {} : lifecycle),
          createdAt: now,
          updatedAt: now,
        });
      });

      if (requirement !== null) {
        stage("requirement", requirement, () => {
          addDecision(requirement.doc, uuid);
        });
      }

      let placement: SidebarPlacement | null = null;
      if (group !== null && sidebar !== undefined) {
        stage("sidebar", sidebarReplica, () => {
          // The same pin operation pin_doc runs — see placeInGroup. A brand-new
          // uuid is pinned rather than moved, so it can only appear once.
          try {
            const { position } = placeInGroup(
              replicas,
              group.id,
              uuid,
              sidebar.group.position,
            );
            placement = { group: { id: group.id, name: group.name }, position };
          } catch (error) {
            // A concurrent sidebar_group delete, landing between the lookup at
            // the top of this call and this write. pin_doc answers that with
            // its own `group_not_found` and nothing else to say; here the
            // document and its stub are already durable, so the caller has to
            // hear that before it retries a create it does not need.
            if (
              !(error instanceof ToolError) ||
              error.code !== "group_not_found"
            ) {
              throw error;
            }
            throw stoppedPartWay(
              "group_not_found",
              `Document ${uuid} was created, but sidebar group ${group.id} disappeared before it ` +
                "could be pinned there. Nothing was rolled back: the document and its directory " +
                "stub are durable, and only the placement is missing.",
              { purpose: "sidebar", room: sidebarReplica.room },
              `The document exists — do NOT create it again. Call pin_doc with uuid ${uuid} and a ` +
                "group that exists (get_sidebar lists them; pin_doc creates one by name).",
              { group: group.id },
            );
          }
        });
      }

      return json({
        uuid,
        room: replica.room,
        title,
        description,
        tags: tags ?? [],
        ...(lifecycle === null ? {} : lifecycle),
        ...(governs === undefined ? {} : { governs }),
        blocks: blocksJson(replica),
        ...(placement === null ? {} : { sidebar: placement }),
        ...durabilityAcross(replica, completed),
      });
    }),
  );

  server.registerTool(
    "get_doc",
    {
      title: "Read a document",
      description:
        "Read a document's metadata — including its `description`, null when nobody has written one — its blocks " +
        "and its annotation threads. Lifecycle documents include `kind` and their compatible `status`; ordinary " +
        "documents omit both. " +
        LIFECYCLE_RECORDS_STATE +
        "\n\n" +
        DECISION_EDGES +
        "\n\n" +
        "Every block carries a `rev` content hash — pass it back to edit_block to assert nothing changed since this read.\n\n" +
        "`text` is plain and mark-free, as it has always been. A block that carries inline references to other " +
        "documents also carries `doc_links`: `[{start, end, docId}]` in characters, the same offsets annotate and " +
        "link_range speak in, and absent where there are none. Only prose blocks can hold them." +
        failureContract("get_doc"),
      inputSchema: strictInput({ uuid: uuidArg }),
    },
    guarded("get_doc", async ({ uuid }) => {
      await replicas.settle();
      const replica = requireDoc(uuid);
      const meta = getMeta(replica.doc);
      return json({
        ...meta,
        room: replica.room,
        decisions: readDecisions(replica.doc, replicas.directory().doc),
        blocks: blocksJson(replica),
        annotations: listAnnotations(replica.doc).map((annotation) =>
          annotationJson(replica, annotation),
        ),
      });
    }),
  );

  server.registerTool(
    "list_docs",
    {
      title: "List documents",
      description:
        "Documents in the workspace, from the synced directory document — never from locally observed creations. " +
        "The unfiltered orientation listing omits `kind: \"decision\"` records. Pass any `kind`, `status` or `tag` " +
        "predicate to ask for its exact matches, including matching decisions; `kind: \"decision\"` lists decision " +
        "records. `include_deleted` admits tombstones but is not a predicate and does not lift the default omission, " +
        "so an archived decision needs it together with a matching predicate. A fresh replica can list the whole " +
        "corpus once the directory room has synced.\n\n" +
        "`description` is the document's own one-or-two-sentence description, cached in the stub so this listing " +
        "answers with it without opening a single room — read it before deciding what to get_doc. It is null for a " +
        "document nobody has described yet; documents created in the web UI start that way, and set_description " +
        "fixes one.\n\n" +
        "`pinned` says whether the sidebar carries the document as an entry point — derived from the sidebar doc, " +
        "read with get_sidebar. Unpinned documents are fully alive; the flag separates entry points from the long tail.\n\n" +
        "`createdAt` and `updatedAt` are epoch milliseconds, present only where known — sort keys, not history. " +
        "`updatedAt` says when someone changed the document, not when a replica noticed: each replica stamps only for " +
        "the changes it made itself, so a document you never edit keeps the stamp its editor wrote. Concurrent stamps " +
        "resolve to the greater value, so a future-skewed clock pins the hint until a later stamp exceeds it. It is also " +
        "deliberately coarse — at most one re-stamp every few minutes of its own edits, immediately on a title or tag " +
        "change. Both come from the clock of whichever replica wrote them, so treat them " +
        "as approximate, and expect either to be missing on a stub written before they existed.\n\n" +
        "Lifecycle documents include `kind` and their compatible `status`; ordinary documents omit both. " +
        "The optional `kind` and `status` filters are answered from those directory stubs without opening a " +
        "document room, and combine with `tag`. " +
        LIFECYCLE_RECORDS_STATE +
        failureContract("list_docs"),
      inputSchema: strictInput({
        tag: z.string().min(1).optional().describe("Only documents carrying this tag."),
        kind: documentKindArg.optional().describe("Only documents of this kind."),
        status: documentStatusArg.optional().describe("Only documents at this lifecycle state."),
        include_deleted: z.boolean().optional(),
      }),
    },
    guarded("list_docs", async ({ tag, kind, status, include_deleted }) => {
      await replicas.settle();
      const hasPredicate = tag !== undefined || kind !== undefined || status !== undefined;
      const entries = listDirectory(replicas.directory().doc, {
        includeDeleted: include_deleted ?? false,
      }).filter(
        (entry) =>
          (hasPredicate || entry.kind !== "decision") &&
          (tag === undefined || entry.tags.includes(tag)) &&
          (kind === undefined || entry.kind === kind) &&
          (status === undefined || entry.status === status),
      );
      // Derived, never stored: the sidebar doc is the one place a pin lives.
      const pinned = pinnedUuids(replicas);
      return json({
        workspace: replicas.config.workspaceId,
        docs: entries.map((entry) => ({
          ...entry,
          // Always present, null when absent: an agent scanning this listing
          // should read one shape, not test for a missing key.
          description: entry.description ?? null,
          pinned: pinned.has(entry.uuid),
        })),
        hub: replicas.sync.state(),
      });
    }),
  );

  server.registerTool(
    "search",
    {
      title: "Search documents",
      description:
        "Full-text search over document titles, descriptions and block text, from the local FTS5 index. " +
        "The index is derived from the replicas and updated as updates are observed, so it reflects edits from any client this replica has seen.\n\n" +
        "Matching is all-terms: every searchable term in `query` must occur in one and the same document. " +
        "Letters and digits make a term; punctuation and emoji are not terms, so a query holding only those matches nothing. " +
        "An underscore-separated group matches its words as an adjacent phrase: `list_docs` matches both `list_docs` and `list docs`, but not `a list of docs`. " +
        "Case and accents are folded, but nothing is stemmed — `withdrawal` does not find a document that says " +
        "`withdrawing`. A trailing `*` loosens one term to a prefix match, which is how to reach an inflection: " +
        "`withdraw*` finds both `withdrawal` and `withdrawing`. No hits means no indexed document matched the whole query under those rules; it does not by itself mean the index is empty.\n\n" +
        "Every hit carries the document's `description` — null where nobody has written one — so relevance can be " +
        "judged from the result list rather than by opening each document in turn." +
        failureContract("search"),
      inputSchema: strictInput({
        query: z
          .string()
          .min(1)
          .describe(
            "Words to match; every term must occur in one document, `list_docs` matches both `list_docs` and `list docs` but not `a list of docs`, and a trailing * makes its term a prefix match.",
          ),
        limit: z.number().int().min(1).max(100).optional(),
      }),
    },
    guarded("search", async ({ query, limit }) => {
      await replicas.settle();
      return json({
        query,
        hits: replicas.store.search(query, limit ?? 20),
      });
    }),
  );

  server.registerTool(
    "backlinks",
    {
      title: "Documents linking here",
      description:
        "Documents that reference this one, by UUID and never by path or title. The answer is the union of two " +
        "kinds of edge, which it does not distinguish: the curated doc-level `links` set_links owns, and every " +
        "inline reference in a prose block — the `doc_links` get_doc reports, written by link_range or by an " +
        "`inline` run. A document citing this one in a sentence needs no `links` entry to appear here.\n\n" +
        "Each one carries its `description` — null where it has none — so a citing document can be judged without " +
        "opening it." +
        failureContract("backlinks"),
      inputSchema: strictInput({ uuid: uuidArg }),
    },
    guarded("backlinks", async ({ uuid }) => {
      await replicas.settle();
      return json({ uuid, backlinks: replicas.store.backlinks(uuid) });
    }),
  );

  server.registerTool(
    "edit_block",
    {
      title: "Edit one block",
      description:
        "Replace one block's text by diff-and-splice: only the characters that actually changed are touched, " +
        "so a concurrent human edit elsewhere in the block survives.\n\n" +
        MARKS_ANCHOR_TO_POSITIONS +
        "\n\n" +
        "Plain text, both ways: `old_text` and `new_text` are the block's text with no markdown in it, the text " +
        "get_doc returns. Spliced-in text inherits the formatting of the character to its left, and `rev` " +
        "ignores marks, so formatting a range never makes a prepared edit stale.\n\n" +
        "Pass `old_text` (and the `rev` from get_doc) to assert what you are editing. A mismatched asserted rev " +
        "refuses with `stale_block`. When the rev is current but `old_text` is wrong, the refusal is " +
        "`old_text_mismatch`; without a rev, a text mismatch remains `stale_block` because the server cannot tell " +
        "a bad argument from a stale read. Both errors carry `currentText` and `currentRev` to re-diff against.\n\n" +
        "Scope of that guarantee, stated plainly: it is a check against THIS replica at the moment of the call. " +
        "There is no cross-replica compare-and-swap — an edit made elsewhere that has not reached this replica yet " +
        "cannot be detected, and the window widens the longer this server stays offline.\n\n" +
        ARCHIVED_IS_READ_ONLY +
        "\n\n" +
        SYNCED_MEANS +
        failureContract("edit_block"),
      inputSchema: strictInput({
        uuid: uuidArg,
        block_id: z.string().min(1),
        old_text: z.string().describe("The block text you read. Asserted before the splice."),
        new_text: z.string(),
        rev: z
          .string()
          .min(1)
          .optional()
          .describe("The block's `rev` from get_doc. Asserted alongside old_text."),
      }),
    },
    guarded("edit_block", async ({ uuid, block_id, old_text, new_text, rev }) => {
      await replicas.settle();
      const replica = requireWritableDoc(uuid);
      editBlock(replica.doc, block_id, old_text, new_text, {
        ...(rev === undefined ? {} : { rev }),
      });
      replicas.publishCursor(replica, block_id, new_text.length);
      return json({
        uuid,
        block: getBlock(replica.doc, block_id),
        ...durability(replica),
      });
    }),
  );

  server.registerTool(
    "insert_block",
    {
      title: "Insert a block",
      description:
        "Insert one block after `after_block_id`, or at the top of the document when it is omitted. " +
        `Block types are the closed set the schema owns — ${BLOCK_TYPES.join(", ")} — which is the editor's ` +
        "whole palette too. Nothing nests: a list is a run of adjacent list-item blocks, and a table's text is " +
        "GFM table source, so every block has one text an agent can edit.\n\n" +
        ARCHIVED_IS_READ_ONLY +
        "\n\n" +
        SYNCED_IS_ACKNOWLEDGED +
        failureContract("insert_block"),
      inputSchema: strictInput({
        uuid: uuidArg,
        after_block_id: z
          .string()
          .min(1)
          .nullish()
          .describe("Insert after this block. Omit or null to insert first."),
        ...blockShape,
      }),
    },
    guarded("insert_block", async ({ uuid, after_block_id, type, text, level, language, inline }) => {
      await replicas.settle();
      const replica = requireWritableDoc(uuid);
      // Before the insert: an unknown reference target refuses the call with
      // nothing written.
      const input = blockInputFor({ type, text, level, language, inline });
      const blockId = insertBlock(replica.doc, after_block_id ?? null, input);
      const block = getBlock(replica.doc, blockId);
      // The caret goes after what was actually written, which is not `text`
      // when `inline` replaced it — and joined runs are usually longer.
      replicas.publishCursor(replica, blockId, block?.text.length ?? 0);
      return json({
        uuid,
        block,
        ...durability(replica),
      });
    }),
  );

  server.registerTool(
    "delete_block",
    {
      title: "Delete a block",
      description:
        "Delete one block. Deleting is never how a block changes type — use insert_block plus edit_block only for new content, " +
        "and never delete-and-reinsert to re-type, which churns the block id and orphans its annotations.\n\n" +
        ARCHIVED_IS_READ_ONLY +
        "\n\n" +
        SYNCED_IS_ACKNOWLEDGED +
        failureContract("delete_block"),
      inputSchema: strictInput({ uuid: uuidArg, block_id: z.string().min(1) }),
    },
    guarded("delete_block", async ({ uuid, block_id }) => {
      await replicas.settle();
      const replica = requireWritableDoc(uuid);
      deleteBlock(replica.doc, block_id);
      return json({ uuid, blockId: block_id, ...durability(replica) });
    }),
  );

  server.registerTool(
    "set_tags",
    {
      title: "Set a document's tags",
      description:
        "Replace the document's tag set. The directory stub is updated to match, so list_docs and tag filters follow.\n\n" +
        ARCHIVED_IS_READ_ONLY +
        "\n\n" +
        SYNCED_IS_ACKNOWLEDGED +
        failureContract("set_tags"),
      inputSchema: strictInput({ uuid: uuidArg, tags: z.array(z.string().min(1)) }),
    },
    guarded("set_tags", async ({ uuid, tags }) => {
      await replicas.settle();
      const replica = requireWritableDoc(uuid);
      setTags(replica.doc, tags);
      return json({ uuid, tags, ...durability(replica) });
    }),
  );

  server.registerTool(
    "set_links",
    {
      title: "Set a document's outbound links",
      description:
        "Replace the document's curated outbound link set. Values are target document UUIDs — never paths, never titles. " +
        DECISION_EDGES +
        " " +
        "The backlinks index follows immediately.\n\n" +
        ARCHIVED_IS_READ_ONLY +
        "\n\n" +
        SYNCED_IS_ACKNOWLEDGED +
        failureContract("set_links"),
      inputSchema: strictInput({ uuid: uuidArg, links: z.array(linkArg) }),
    },
    guarded("set_links", async ({ uuid, links }) => {
      await replicas.settle();
      const replica = requireWritableDoc(uuid);
      setLinks(replica.doc, links);
      return json({ uuid, links, ...durability(replica) });
    }),
  );

  server.registerTool(
    "set_title",
    {
      title: "Rename a document",
      description:
        "Replace the document's title. A title is rewritten rather than patched, so there is nothing to splice " +
        "here and no `old_text` to assert. Identity is the uuid and a rename never touches it, so every link, " +
        "backlink and annotation survives one.\n\n" +
        "`meta.title` in the document is authoritative and the directory stub caches it. This writes the " +
        "document and the stub follows in the same call, so the next list_docs, search and get_sidebar answer " +
        "with the new title without opening a single document room.\n\n" +
        "An empty title, and a title of nothing but whitespace, are both refused: a document nobody can name is " +
        "a document nobody can pick out of a listing.\n\n" +
        ARCHIVED_IS_READ_ONLY +
        "\n\n" +
        SYNCED_IS_ACKNOWLEDGED +
        failureContract("set_title"),
      inputSchema: strictInput({ uuid: uuidArg, title: titleArg }),
    },
    guarded("set_title", async ({ uuid, title }) => {
      await replicas.settle();
      const replica = requireWritableDoc(uuid);
      setTitle(replica.doc, title);
      return json({ uuid, title, ...durability(replica) });
    }),
  );

  server.registerTool(
    "set_description",
    {
      title: "Set a document's description",
      description:
        "Replace the document's description wholesale. A description is rewritten rather than patched, so there is " +
        "nothing to splice here and no `old_text` to assert. The directory stub follows immediately, the way it " +
        "does for a rename, so the next list_docs, search and backlinks answer with it.\n\n" +
        DESCRIPTION_IS_FOR_CHOOSING +
        "\n\n" +
        "This is the tool the `descriptionHint` on a write points at: a document created in the web UI has no " +
        "description, and an agent that has just worked inside one is the party who can write it.\n\n" +
        "There is no way to clear a description from here: the empty string, and a string of nothing but " +
        "whitespace, are both refused. Removing one is a schema-level operation, not a tool — a document that " +
        "advertises nothing is a gap to fill rather than a state to ask for. Replace a description you dislike " +
        "with a better one.\n\n" +
        ARCHIVED_IS_READ_ONLY +
        "\n\n" +
        SYNCED_IS_ACKNOWLEDGED +
        failureContract("set_description"),
      inputSchema: strictInput({ uuid: uuidArg, description: descriptionArg }),
    },
    guarded("set_description", async ({ uuid, description }) => {
      await replicas.settle();
      const replica = requireWritableDoc(uuid);
      setDescription(replica.doc, description);
      return json({ uuid, description, ...durability(replica) });
    }),
  );

  server.registerTool(
    "set_status",
    {
      title: "Set a document's lifecycle status",
      description:
        "Record a document's lifecycle status. On an ordinary document this also adopts the kind that owns the " +
        "status; the result names both, so adoption is never silent. A document that already has a kind accepts " +
        "only that kind's statuses. Its kind is fixed through MCP: if it was adopted in error, retrying with the " +
        "other kind's status cannot change it.\n\n" +
        LIFECYCLE_RECORDS_STATE +
        "\n\n" +
        ARCHIVED_IS_READ_ONLY +
        "\n\n" +
        SYNCED_IS_ACKNOWLEDGED +
        failureContract("set_status"),
      inputSchema: strictInput({ uuid: uuidArg, status: documentStatusArg }),
    },
    guarded("set_status", async ({ uuid, status }) => {
      await replicas.settle();
      const replica = requireWritableDoc(uuid);
      const stored = getMeta(replica.doc);
      const kind = stored.kind ?? kindForStatus(status);

      replica.doc.transact(() => {
        if (stored.kind === undefined) {
          // Adoption is unconditional on the tolerant read. Clear any hidden,
          // incompatible raw pair before writing the derived legal pair; the
          // outer transaction keeps the replacement in one logged update.
          setKind(replica.doc, "");
          setKind(replica.doc, kind);
        }
        setStatus(replica.doc, status);
      });

      const failure = replicas.persistenceError();
      if (failure !== null && failure.room === replicas.directory().room) {
        throw new ToolError(
          "persistence_failed",
          `The lifecycle update is durable in ${replica.room}, but its directory stub could not be updated: ${failure.message}`,
          {
            uuid,
            kind,
            status,
            applied: false,
            partial: true,
            synced: false,
            rolledBack: false,
            completed: [
              { purpose: "document", room: replica.room, applied: true },
            ],
            failed: { purpose: "directory", room: failure.room },
            room: failure.room,
            recoveryClass: "manual",
            recovery:
              "Restart the MCP server. The document lifecycle is already durable; the next settle repairs the " +
              "directory stub from it, so do not repeat set_status before re-reading.",
          },
        );
      }

      return json({ uuid, kind, status, ...durability(replica) });
    }),
  );

  server.registerTool(
    "set_changelog_suggestion",
    {
      title: "Set a document's changelog suggestion",
      description:
        "Record one sentence of draft release-note copy for the work this document describes — what a reader of a " +
        "changelog would want to know, in simple English about the user-visible outcome. Write it when delivered " +
        "work makes you update the document; nothing generates, publishes or asks for one, and nothing renders it " +
        "yet.\n\n" +
        "It is document metadata beside the description, not prose in the document: writing it leaves the title, " +
        "description, tags, links, kind and status exactly where they were, and get_doc answers with it as " +
        "`changelogSuggestion`.\n\n" +
        "Three states, and they are different answers. No `changelogSuggestion` at all means nobody has written " +
        "one. `null` means this work deliberately needs no user-facing entry — say it, so an internal-only change " +
        "does not read as unfinished. A non-empty string is the suggestion itself. The empty string — or any " +
        "string that is only whitespace, since the argument is trimmed first — is not a fourth state: it takes " +
        "the stored value back to the first one.\n\n" +
        "That clear is the one answer whose concurrency guarantee is weaker, and it is local: it takes back only " +
        "the value this replica has already seen, so a concurrent `null` or sentence from another writer outlives " +
        "it and the field converges on theirs. Writing `null` or a sentence competes normally — concurrent " +
        "writers converge on one of the two. If a clear must stick, read the document back with get_doc.\n\n" +
        "The directory stub does not cache it and the search index does not carry it, so list_docs and search " +
        "neither answer with it nor match on it.\n\n" +
        ARCHIVED_IS_READ_ONLY +
        "\n\n" +
        SYNCED_IS_ACKNOWLEDGED +
        failureContract("set_changelog_suggestion"),
      inputSchema: strictInput({
        uuid: uuidArg,
        suggestion: changelogSuggestionArg,
      }),
    },
    guarded("set_changelog_suggestion", async ({ uuid, suggestion }) => {
      await replicas.settle();
      const replica = requireWritableDoc(uuid);
      setChangelogSuggestion(replica.doc, suggestion);
      return json({
        uuid,
        // The answer carries the state the document now holds, in the shape
        // get_doc reads it back in: the key is absent exactly when nobody has
        // written a suggestion.
        ...(suggestion === "" ? {} : { changelogSuggestion: suggestion }),
        ...durability(replica),
      });
    }),
  );

  /**
   * Archiving and restoring both write the *directory*, not the document.
   *
   * Two consequences. They report durability for the directory room, because
   * that is the room whose update has to reach the hub. And they do not touch
   * the derived index themselves: `Replicas` reconciles it from the directory
   * update, which means the index follows an archive on every replica that
   * observes it, not only on the one that called the tool.
   */
  server.registerTool(
    "archive_doc",
    {
      title: "Archive a document",
      description:
        "Hide a document: tombstones its directory stub, so it leaves list_docs, the web sidebar and the search index. " +
        "This is not erasure and not a delete. Every block, mark and annotation stays exactly where it was: get_doc still " +
        "serves the document by uuid, and list_docs with `include_deleted: true` still lists it, flagged `deleted`; " +
        "for a decision, add a matching `kind`, `status` or `tag` predicate. " +
        "There is no tool that erases content, by design.\n\n" +
        "What the tombstone does cost is writing: while it stands the document is read-only, and every mutating tool " +
        "refuses it with `doc_archived`. restore_doc is the way back, and the only mutation an archived document " +
        "accepts.\n\n" +
        "`indexed` says this replica's search index has dropped the document. Dropping it needs only its uuid, so " +
        "unlike restore_doc this does not depend on holding the document — it is false only if the index write itself " +
        "failed, and then the document stays queued and a later call retries it. The archive itself is unaffected " +
        "either way: `applied` is the durable half.\n\n" +
        ARCHIVE_IS_LAST_WRITE_WINS +
        "\n\n" +
        SYNCED_IS_ACKNOWLEDGED +
        failureContract("archive_doc"),
      inputSchema: strictInput({ uuid: uuidArg }),
    },
    guarded("archive_doc", async ({ uuid }) => {
      await replicas.settle();
      const stub = requireStub(uuid);
      const directory = replicas.directory();
      const title = titleFor(uuid, stub);
      tombstoneDirectoryEntry(directory.doc, uuid);
      return json({
        uuid,
        title,
        archived: true,
        // Withdrawing a document needs no copy of it, so hydration cannot make
        // this false — but a store that refused the write can, and then the
        // uuid stays queued for a later retry rather than being reported done.
        indexed: replicas.indexReconciled(uuid),
        ...durability(directory),
      });
    }),
  );

  server.registerTool(
    "restore_doc",
    {
      title: "Restore an archived document",
      description:
        "Lift a document's archive tombstone: it returns to the default list_docs listing unless it is a decision, " +
        "returns to matching filtered listings either way, and returns to the web sidebar and search index, with the " +
        "title and tags the directory recorded for it. The counterpart to archive_doc, and the sanctioned way " +
        "back — a rename or a retag from a replica that has seen the archive deliberately cannot revive a document. " +
        "Restoring one that is not archived leaves its archive state alone, but is not quite a no-op: the directory " +
        "entry is a cache of the document's own metadata, and this trues it up, so a stub that had drifted is " +
        "repaired in passing.\n\n" +
        "Check `indexed`. It is true when this replica holds the document itself and has just re-derived its search " +
        "rows — the usual case. It is false in two: when this replica knows the document only from the directory, and " +
        "when the index write was refused. Either way the restore is real, replicates, and shows immediately in the " +
        "list_docs collection that includes its kind, but SEARCH ON THIS REPLICA will not find the document yet — it " +
        "catches up when the content " +
        "arrives or on a later call, whichever was missing. Offline, content arriving means the hub coming back.\n\n" +
        ARCHIVE_IS_LAST_WRITE_WINS +
        "\n\n" +
        SYNCED_IS_ACKNOWLEDGED +
        failureContract("restore_doc"),
      inputSchema: strictInput({ uuid: uuidArg }),
    },
    guarded("restore_doc", async ({ uuid }) => {
      await replicas.settle();
      const stub = requireStub(uuid);
      const directory = replicas.directory();
      restoreDirectoryEntry(directory.doc, uuid);
      // A rename or a retag that landed while the document was archived never
      // reached its stub, because stub repair skips tombstoned entries. Catch
      // the directory up here, or the document comes back under the metadata it
      // was archived with while search answers from the newer.
      //
      // Hydration is what makes re-indexing possible; it is not proof that it
      // happened. Both have to hold, and the store gets the last word — read
      // after the republish, whose own directory write reconciles again.
      const hydrated = replicas.republishStub(uuid);
      return json({
        uuid,
        title: titleFor(uuid, stub),
        archived: false,
        indexed: hydrated && replicas.indexReconciled(uuid),
        ...durability(directory),
      });
    }),
  );

  server.registerTool(
    "annotate",
    {
      title: "Annotate a range, or comment on a thread",
      description:
        "Open an annotation thread over a range of a block's text, or — with `thread_id` — add a comment to an existing thread. " +
        "The range is anchored by a formatting mark on the text itself, so it survives edits, splits and re-types.\n\n" +
        ANNOTATE_SHAPES +
        "\n\n" +
        ARCHIVED_IS_READ_ONLY +
        "\n\n" +
        SYNCED_IS_ACKNOWLEDGED +
        failureContract("annotate"),
      inputSchema: strictInput(
        {
          uuid: uuidArg,
          text: z.string().min(1).describe("The comment body."),
          thread_id: z
            .string()
            .min(1)
            .optional()
            .describe("Comment on this existing thread instead of opening a new one."),
          block_id: z.string().min(1).optional().describe("The block to annotate. New thread only."),
          start: z.number().int().min(0).optional().describe("Range start, in characters. New thread only."),
          end: z.number().int().min(0).optional().describe("Range end, exclusive. New thread only."),
          author: z.string().min(1).optional(),
        },
        ANNOTATE_MODES,
      ),
    },
    guarded("annotate", async ({ uuid, text, thread_id, block_id, start, end, author }) => {
      await replicas.settle();
      const replica = requireWritableDoc(uuid);
      const who = author ?? replicas.name;

      if (thread_id !== undefined) {
        const updated = addComment(replica.doc, thread_id, who, text);
        if (updated === null) {
          throw new ToolError(
            "thread_not_found",
            `No annotation thread ${thread_id} in document ${uuid}`,
            { uuid, threadId: thread_id },
          );
        }
        return json({
          uuid,
          annotation: annotationJson(replica, updated),
          ...durability(replica),
        });
      }

      // No `thread_id` is the other shape, and the input boundary refused the
      // call unless all three range fields came with it — see
      // {@link ANNOTATE_MODES}. The assertions stand in for what TypeScript
      // cannot read off fields the object declares once for both shapes.
      const created = createAnnotation(
        replica.doc,
        block_id as string,
        start as number,
        end as number,
        who,
        text,
      );
      return json({
        uuid,
        annotation: annotationJson(replica, created),
        ...durability(replica),
      });
    }),
  );

  server.registerTool(
    "link_range",
    {
      title: "Link a range of a block to another document",
      description:
        "Turn a range of a block's text into an inline reference to another document. The range's own characters " +
        "are the label — this tool writes a mark and never a character, so the block's `text` and `rev` come back " +
        "exactly as get_doc gave them. `annotate` anchors a comment to a range the same way; this is that " +
        "operation with a document uuid instead of a thread.\n\n" +
        "`start` and `end` are character offsets into the block's text, and `rev` is REQUIRED: offsets mean " +
        "nothing without the text they were measured against. A stale `rev` refuses with `stale_block`, carrying " +
        "`currentText` and `currentRev` to re-measure against. Indices are clamped to the text and swapped if " +
        "reversed; a range that clamps to nothing is refused.\n\n" +
        "A range that is already a reference is RETARGETED. A range that is already an external link is refused — " +
        "one range cannot be both — and so is a code, mermaid or table block, which holds source text. The answer " +
        "carries the target's current `title` for information; the label in the document is the text you linked, " +
        "and it does not follow a later rename.\n\n" +
        "The target must be a document this replica's directory knows, or the call refuses with " +
        "`doclink_target_not_known_locally` and writes nothing. An archived target is accepted.\n\n" +
        "The edge shows up in backlinks without touching `meta.links`, which stays the curated doc-level list " +
        "set_links owns.\n\n" +
        ARCHIVED_IS_READ_ONLY +
        "\n\n" +
        SYNCED_IS_ACKNOWLEDGED +
        failureContract("link_range"),
      inputSchema: strictInput({
        uuid: uuidArg,
        block_id: z.string().min(1),
        start: z.number().int().min(0).describe("Range start, in characters."),
        end: z.number().int().min(0).describe("Range end, exclusive."),
        doc_id: docLinkTargetArg.describe("Target document UUID."),
        rev: z
          .string()
          .min(1)
          .describe("The block's `rev` from get_doc. Required, and asserted."),
      }),
    },
    guarded("link_range", async ({ uuid, block_id, start, end, doc_id, rev }) => {
      await replicas.settle();
      const replica = requireWritableDoc(uuid);
      // Before the mark: an unknown target refuses with nothing written.
      const title = linkTitle(doc_id);
      setInlineLink(replica.doc, block_id, { start, end }, doc_id, { rev });
      return json({
        uuid,
        blockId: block_id,
        docId: doc_id,
        title,
        // Unchanged by construction — marks are not part of a rev — and
        // answered with so the next call needs no re-read.
        rev: getBlockRev(replica.doc, block_id),
        ...durability(replica),
      });
    }),
  );

  server.registerTool(
    "export_markdown",
    {
      title: "Export a document as markdown",
      description:
        "Render the document as markdown, including fenced code and mermaid blocks. " +
        "Export only: markdown is never the storage format, and there is no import tool." +
        failureContract("export_markdown"),
      inputSchema: strictInput({
        uuid: uuidArg,
        frontmatter: z
          .boolean()
          .optional()
          .describe(
            "Emit a YAML frontmatter block with uuid, title, tags and — when present — description, kind and " +
              "status. The lifecycle fields record state; they do not authorize execution. Default true.",
          ),
        annotations: z
          .enum(["html-comments", "drop"])
          .optional()
          .describe("How to render annotation threads. Default drop."),
      }),
    },
    guarded("export_markdown", async ({ uuid, frontmatter, annotations }) => {
      await replicas.settle();
      const replica = requireDoc(uuid);
      return json({
        uuid,
        markdown: exportMarkdown(replica.doc, {
          ...(frontmatter === undefined ? {} : { frontmatter }),
          ...(annotations === undefined ? {} : { annotations }),
        }),
      });
    }),
  );

  server.registerTool(
    "sync_status",
    {
      title: "Sync status",
      description:
        "What this replica holds and what the hub has acknowledged.\n\n" +
        "`hub.status` distinguishes a hub that is down from a token the hub rejected — the first resolves itself, " +
        "the second needs a human — and `disabled` means no secret was configured, so this server is local-only. " +
        "`update-required` is the third kind: this replica and the hub speak different sync protocol versions, so " +
        "the hub refuses the connection outright. `hub.protocolVersion` is this replica's and " +
        "`hub.hubProtocolVersion` the hub's, and `hub.reason` says which side is older; nothing syncs until that " +
        "side is updated, and no amount of waiting changes it. Every tool still works locally throughout.\n\n" +
        "The two counts here are in different units, so they are not expected to agree. `unsyncedChanges` counts " +
        "ROOMS, not updates: the rooms holding local changes the hub has not acknowledged, the ones `pendingRooms` " +
        "names. It is read from the durable pending set, so it survives a restart and is non-zero in local-only " +
        "mode: work that never left this machine is unsynced, whether or not a connection was ever attempted. " +
        "`inFlightUpdates` counts provider SYNC MESSAGES awaiting acknowledgement on the current connection, " +
        "which is not a count of Yjs updates: the provider merges a batch of updates into one message, counts a " +
        "message before it goes out, and resets the backlog to the single sync-handshake message on every " +
        "reconnect — so it can read 1 for a whole document's worth of unsent work. It is in memory and resets " +
        "with the connection. The web client's status line shows the same counter for the room it has open, " +
        "labelled `N sync messages unacked`.\n\n" +
        `${SYNCED_MEANS} The same holds for \`rooms[].synced\` below and for \`unsyncedChanges: 0\`: both are ` +
        "statements about acknowledgement, so a hub that dies inside the debounce comes back missing updates " +
        "this tool has already reported as synced, until a replica holding them reconnects and re-sends.\n\n" +
        "`persistence` is null unless an update failed to reach the log, in which case every other tool refuses " +
        "to serve until the server is restarted." +
        failureContract("sync_status"),
      inputSchema: strictInput({}),
    },
    // The same snapshot `ub status` prints — see ./status.ts. Diagnostics must
    // still answer when persistence has failed, which is exactly when someone
    // needs to know why every other tool stopped.
    guarded("sync_status", async () => json(await collectSyncStatus(replicas))),
  );

  // The sidebar tools live in ./sidebar-tools.ts and are handed exactly what
  // every tool here uses — the identity check and the durability responder — so
  // curation shares this file's contract without either module importing the
  // other. The failure contract is not passed: ./failures.ts is a module both
  // sides import.
  registerSidebarTools(server, replicas, {
    requireStub,
    durability,
    json,
  });

}

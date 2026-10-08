import { MAX_DESCRIPTION_LENGTH } from "@uberblick/schema";

/**
 * The exact claim `synced: true` makes, in the words an agent reads.
 *
 * The hub acknowledges an update on receipt and only schedules the write, so an
 * acknowledged update is in the hub's memory, not on its disk. Narrowing the
 * word here is the honest fix: the hub cannot store per update, because its
 * SQLite extension writes the whole document state per store call.
 */
export const SYNCED_MEANS =
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
export const ARCHIVE_IS_LAST_WRITE_WINS =
  "Concurrency: a directory entry is written as a whole object, so an archive_doc racing a restore_doc on another " +
  "replica converges on whichever update Yjs orders last — not on whichever call happened later by the clock. The same " +
  "applies to a plain rename or retag made on a replica that had not yet seen the archive: it is a whole-entry write " +
  "too, so it can bring the document back with nobody calling restore_doc. An archive holds against writers that have " +
  "seen it, which is not the same as holding against every concurrent one. When it matters which way it went, re-read " +
  "with list_docs and `include_deleted: true`; for a decision, also pass a matching `kind`, `status` or `tag` predicate.";

/** Topic lifecycle is independent of its governing document. */
export const DECISION_TOPIC_LIFECYCLE =
  "For a decision, this acts on every record in its topic. Only the first record's directory tombstone " +
  "decides whether the topic is archived; individual tombstones never change resolution. No individual " +
  "decision record can be archived or restored. It does not change the governing requirement, and archiving " +
  "a requirement does not archive its decision topics.";

/**
 * What an archive costs a writer, in the words an agent reads.
 *
 * Every mutator carries this, because "archived" is otherwise indistinguishable
 * from "gone" — and the honest half matters as much as the refusal: this is a
 * check against one replica's directory stub, not a lock over the corpus.
 */
export const ARCHIVED_IS_READ_ONLY =
  "Archived documents are read-only. While a document's directory stub is tombstoned this tool refuses with " +
  "`doc_archived` and changes nothing; restore_doc is the only mutation an archived document accepts, and the only " +
  "way back. Reading is unaffected — get_doc, export_markdown, backlinks and `list_docs` with `include_deleted: true` " +
  "all still answer for it; a decision additionally needs a matching `kind`, `status` or `tag` predicate in list_docs.\n\n" +
  "The honest scope, the same discipline `rev` has: the check runs against THIS replica's directory stub at the " +
  "moment of the call. It is refusal-at-call, not a cross-replica lock — an edit made on a replica that has not seen " +
  "the archive yet is an ordinary CRDT write and merges normally when the two replicas meet.";

export const DECIDED_IS_READ_ONLY =
  "A decided decision record's title, decision line and blocks are read-only: this tool refuses with " +
  "`decision_read_only` and changes nothing. Use a new superseding record for any content change. Comments, " +
  "description, tags, curated links and changelog suggestion stay writable. This check runs on this replica " +
  "at call time; an unseen offline edit can still merge later, detected as changed after approval.";

export const DECISION_AUTHORITY =
  "A decision record is a topic followed by the decision itself, then its enduring reasons and guidance. " +
  "A Reconsidering section is optional. Every MCP call follows the agent-account rule: a topic's first record, " +
  "with no `supersedes`, may become `decided` as an `agentStance`. A topic crossing the agent workflow's boundary " +
  "table starts `open` with the agent's recommendation, even as a first record. Any other move to `decided`, " +
  "or confirming an agent stance, requires `answer: {who, when, where}`, recording a person's answer. " +
  "The answer stores `decidedBy`, `decidedAt` and `decidedWhere`, clears the stance marker and approves the " +
  "current title, decision line and ordered block text with an `approvalFingerprint`. Comments, comment " +
  "anchors and approval bookkeeping are excluded. `approvalChanged: true` means changed after approval; " +
  "recording an answer again approves the current content. get_doc returns where; list_docs and every " +
  "`inForce`, `pending` and `conflicts` entry expose the stance, who, when and approvalChanged from stubs.";

/** The same narrowing for the mutators that do not restate it in full. */
export const SYNCED_IS_ACKNOWLEDGED =
  "`synced` here means hub-acknowledged, not hub-stored — see sync_status for the exact claim and its crash window.";

/**
 * What a description is for, in the words an agent reads. Stated wherever one is
 * asked for, because a description written for a human reader — "notes", "misc"
 * — costs the corpus the whole benefit of having them.
 */
export const DESCRIPTION_IS_FOR_CHOOSING =
  "A description is written for an agent deciding whether to open this document. One or two sentences saying what " +
  "is in it and what it is for, concrete enough to tell it apart from its neighbours — list_docs, search and " +
  "backlinks all answer with it, so a good one saves a get_doc and a bad one wastes it. " +
  `At most ${MAX_DESCRIPTION_LENGTH} characters.`;

/** The expectation carried by every successful block-content mutation. */
export const TLDR_AFTER_CONTENT_CHANGE =
  "After changing document content, review its TL;DR and call set_tldr when the summary needs to change.";

export const LIFECYCLE_RECORDS_STATE =
  "`kind` and `status` record what sort of document this is and where it stands. They do not authorize " +
  "execution: that authority comes from the owner's recorded GitHub decision.";

export const DECISION_EDGES =
  "A requirement's `decisions` are a derived, oldest-topic-first log resolved entirely from directory stubs. " +
  "Each decision carries its own `governs`, immutable `topic` and immutable `supersedes`. `governs` and " +
  "`supersedes` are derived outbound edges in the decision's effective `links`: backlinks on a requirement " +
  "finds its decisions, and backlinks on a predecessor finds its direct successors without editing those documents. A decision read returns every " +
  "predecessor, every direct successor with its status, and its topic's resolution. Conflicts name every " +
  "maximal decided record and have nothing in force; no successor is selected as the replacement. " +
  "`set_links` still replaces only the curated link array; passing get_doc's effective `links` back to it " +
  "stores those UUIDs there too, and get_doc deduplicates the resulting edges.";

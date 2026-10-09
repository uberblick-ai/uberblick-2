/** Tool-specific constraints kept out of tools/list; read on demand through per-tool help. */
import { BLOCK_TYPES } from "@uberblick/schema";

export const toolHelpDetails = {
  create_doc:
    "Create a document and publish its directory stub, so every client can discover it through list_docs or " +
    "search. Blocks are optional: pass them to seed the document, or add them later with insert_block. " +
    "Optional `tldr` supplies the decision line before a decided record freezes it, under set_tldr rules and " +
    "limit. When the call seeds at least one block and stays editable, its answer carries the non-blocking " +
    "TL;DR review reminder; a metadata-only create carries no such reminder.\n\n" +
    "`tags` is a complete assignment set of active catalog ids or exact active names. Names are selectors; " +
    "the document stores canonical ids and the answer resolves each id beside its current name. An unknown or " +
    "retired selection refuses the whole call before a document exists; list_tags is the active vocabulary.\n\n" +
    "A `title` and a `description` are both REQUIRED here and the call fails without either, creating " +
    "nothing. A title cannot be empty or whitespace: an untitled document cannot be picked out of a listing, " +
    "and set_title is the repair for the untitled ones the web UI creates.\n\n" +
    "Pass `kind` to create a lifecycle document. Its `status` defaults to that kind's first state; `status` " +
    "without `kind`, or a status owned by the other kind, is refused before a document is created. A decision " +
    "may pass `governs`, the UUID of a live, hydrated requirement in this replica. The decision stores " +
    "`governs` in its own metadata; the requirement's decision log is derived from directory stubs. Any other " +
    "use of `governs` is refused before a UUID is allocated or a room is written. A decision may also pass " +
    "`supersedes`, the UUID of a hydrated decision in a live topic it replaces. The reference is immutable, " +
    "and its predecessor's topic is copied forward; a first record uses its own UUID as topic. `topic` is " +
    "never an input. Supersession is returned by get_doc and is a derived link: backlinks on the earlier " +
    "decision exposes every successor without editing that earlier document. A non-decision target or a " +
    "self-reference is refused before any room is written. An archived predecessor topic is refused with " +
    "`doc_archived` before a UUID is allocated or a room is written; restore the topic before reconsidering " +
    "it. Decisions are created only `open` or `decided`; rejected and withdrawn records must first exist as " +
    "proposals. A decided successor without an answer is refused before allocating a UUID or writing any " +
    "room.\n\n" +
    "`sidebar` is optional and is the only way to say where the document goes: omit it and the document is " +
    "created unpinned (the default, unchanged), or pass `{group: {id, position?}}` to pin it into a group " +
    "that ALREADY exists — the id comes from get_sidebar, `position` is clamped into range and omitted means " +
    "last. There is no `pinned` flag and no `state`: placement implies pinning, so a contradiction cannot be " +
    "expressed. An unknown or empty group id fails with `group_not_found` and creates nothing at all; this " +
    "tool never creates a group, never resolves one by name, and never guesses a default — pin_doc is what " +
    "brings a group into being. The answer echoes the placement it made as `sidebar: {group: {id, name}, " +
    "position}`.\n\n" +
    "This call writes up to three independently persisted rooms — the document, the directory, and the " +
    "sidebar when you place it — so it reports them one by one. The governing requirement is never written. " +
    "If the local update log refuses a write part-way, the call fails with `persistence_failed` carrying the " +
    "`uuid`, the rooms already `completed`, the `failed` room, `rolledBack: false`, and a stage-aware " +
    "`recovery` line — the earlier rooms stay durable, and recovery never risks creating the decision twice.",
  get_doc:
    "Read a document's metadata — including `description` and the person-facing `tldr`, each null when nobody " +
    "has written one — its blocks and its annotation threads. Lifecycle documents include `kind` and their " +
    "compatible `status`; ordinary documents omit both. When structured data exists, `data` lists collection " +
    "names and record counts and names `get_data` for deliberate reads. It contains no schemas or record " +
    "values; documents without data omit it.\n\n" +
    "Every block carries a `rev` content hash — pass it back to edit_block to assert nothing changed since this read.\n\n" +
    "For a table, `text` is canonical GFM with cell formatting as inline markdown, literal punctuation and " +
    "pipes escaped, and every row padded to the widest row; `rev` includes that formatting. For other blocks " +
    "`text` is plain text and `rev` ignores marks. A prose block that carries inline references to other " +
    "documents also carries `doc_links`: `[{start, end, docId}]` in characters, the same offsets annotate and " +
    "link_range speak in, and absent where there are none. Table cell links count toward backlinks but do not " +
    "have block-level `doc_links` ranges.\n\n" +
    "Reading eligible guidance with get_doc counts toward this process’s briefing. This best-effort " +
    "bookkeeping never fails the read or writes usage to a room or update log.",
  get_data:
    "Read structured data deliberately. Without `collection`, return `data: null` for none, or an area " +
    "summary of collection names, record counts, validity and invalid-record counts, canonical UTF-8 bytes, " +
    "area validity and area error count. Summary reads return no schemas, record values or id lists.\n\n" +
    "With `collection`, return its raw schema, validity, collection-level errors, counts and one detached " +
    "page of records. Each record has `id`, `value`, `valid` and its errors. Records are in Unicode " +
    "code-point id order, starting exclusively after `after`. `limit` defaults to 100, at most 1000; 0 reads " +
    "only the schema. `max_bytes` defaults to 65536 (64 KiB), at most 1048576 (1 MiB). It bounds canonical " +
    "JSON of the page's `{id, value}` array, including brackets and commas, excluding schema, diagnostics and " +
    "MCP formatting. A nonzero-limit page always includes the first remaining record, even if it exceeds that " +
    "budget. These bounds do not bound the full response size or client token count. `bytes` reports those " +
    "canonical page bytes.\n\n" +
    "`next_after` is the last returned id when more remain, otherwise null; `complete` states whether the " +
    "filtered collection is exhausted. For schema-only reads with remaining records, keep the current cursor " +
    "and use a positive limit to advance. Optional `ids` (up to 1000) filters the same ordered paging and " +
    "returns `missing_ids` for requested ids absent from the collection. Cursors are not snapshots: following " +
    "them visits each record exactly once only while the data stays unchanged.\n\n" +
    "Merged invalidity is observed through the shared reader without dropping, repairing or writing values.",
  list_docs:
    "Documents in the workspace, from the synced directory document — never from locally observed creations. " +
    "The unfiltered orientation listing omits `kind: \"decision\"` records. Pass any `kind`, `status` or `tag` " +
    "predicate to ask for its exact matches, including matching decisions; `kind: \"decision\"` lists decision " +
    "topics with one row per topic. Each row presents the record in force, else a pending record, else the " +
    "first record, and names all pending records and all conflicting maximal decided records. `inForce: null` " +
    "means no answer is in force. A status or tag predicate matches a topic if any live record matches; each " +
    "predicate may match a different live record. Resolution still uses its whole graph. `include_superseded: " +
    "true` returns every record with predicates applied per record. `include_deleted` admits archived topics " +
    "but is not a predicate and does not lift the default omission, so an archived decision needs it together " +
    "with a matching predicate. A fresh replica can list the whole corpus once the directory room has " +
    "synced.\n\n" +
    "`description` is the document's own one-or-two-sentence description, cached in the stub so this listing " +
    "answers with it without opening a single room — read it before deciding what to get_doc. It is null for " +
    "a document nobody has described yet; documents created in the web UI start that way, and set_description " +
    "fixes one.\n\n" +
    "`pinned` says whether the sidebar carries the document as an entry point — derived from the sidebar doc, " +
    "read with get_sidebar. Unpinned documents are fully alive; the flag separates entry points from the long " +
    "tail.\n\n" +
    "`createdAt` and `updatedAt` are epoch milliseconds, present only where known — sort keys, not history. " +
    "`updatedAt` says when someone changed the document, not when a replica noticed: each replica stamps only " +
    "for the changes it made itself, so a document you never edit keeps the stamp its editor wrote. " +
    "Concurrent stamps resolve to the greater value, so a future-skewed clock pins the hint until a later " +
    "stamp exceeds it. It is also deliberately coarse — at most one re-stamp every few minutes of its own " +
    "edits, immediately on a title or tag change. Both come from the clock of whichever replica wrote them, " +
    "so treat them as approximate, and expect either to be missing on a stub written before they existed.\n\n" +
    "Lifecycle documents include `kind` and their compatible `status`; ordinary documents omit both. The " +
    "optional `kind` and `status` filters are answered from those directory stubs without opening a document " +
    "room, and combine with `tag`. A tag filter accepts a catalog id or exact current name; a value this " +
    "catalog does not have is refused rather than answered with an empty listing. Each returned assignment " +
    "carries its canonical id, current name (or null while unresolved), and active, retired or unresolved " +
    "state.",
  search:
    "Full-text search over document titles, descriptions and block text, from the local FTS5 index. The index " +
    "is derived from the replicas and updated as updates are observed, so it reflects edits from any client " +
    "this replica has seen.\n\n" +
    "Matching is all-terms: every searchable term in `query` must occur in one and the same document. Letters " +
    "and digits make a term; punctuation and emoji are not terms, so a query holding only those matches " +
    "nothing. An underscore-separated group matches its words as an adjacent phrase: `list_docs` matches both " +
    "`list_docs` and `list docs`, but not `a list of docs`. Case and accents are folded, but nothing is " +
    "stemmed — `withdrawal` does not find a document that says `withdrawing`. A trailing `*` loosens one term " +
    "to a prefix match, which is how to reach an inflection: `withdraw*` finds both `withdrawal` and " +
    "`withdrawing`. No hits means no indexed document matched the whole query under those rules; it does not " +
    "by itself mean the index is empty.\n\n" +
    "Every hit carries the document's `description` — null where nobody has written one — so relevance can be " +
    "judged from the result list rather than by opening each document in turn. Its tag assignments carry " +
    "canonical ids, current names and retirement state. Pass `tag` as a catalog id or exact current name to " +
    "restrict hits to that assignment; a value this catalog does not have is refused rather than answered " +
    "with no hits.",
  find_decisions:
    "Find every live decision record whose prose links one GitHub issue or pull request. This replica-local " +
    "derived index reads only external link hrefs in decision prose; display labels, unlinked text, source " +
    "blocks and non-decision documents do not contribute references. It reflects updates this replica has " +
    "observed and indexed and may lag unseen or unindexed content. The lookup opens no decision document room " +
    "and makes no GitHub API call.\n\n" +
    "Pass `github_ref` as owner/repo#n or an http(s) github.com URL with /issues/n or /pull/n. Owner and " +
    "repository case, the issue/PR path spelling, and further path, query or fragment after the number all " +
    "identify the same item. The answer returns its normalized owner/repo#n identity. A value that identifies " +
    "no single GitHub issue or pull request is refused with `invalid_github_reference`; bare #n and other " +
    "GitHub hosts are not accepted.\n\n" +
    "`decisions` contains each matching record once, with uuid, title and directory-cached status (null where " +
    "absent). Archived records are omitted. Every live matching record is returned, without resolving a " +
    "topic's current answer. Order is title ascending under SQLite binary collation, then UUID ascending. " +
    "There is no pagination or truncation; an empty array means no indexed live decision links this item, not " +
    "proof that the replica is complete.",
  edit_block:
    "Replace one block's text by diff-and-splice: only the characters that actually changed are touched, so a " +
    "concurrent human edit elsewhere in the block survives.\n\n" +
    "Marks anchor to positions in the block's text, not to the words they cover, and this tool writes text " +
    "without ever writing a mark. A splice strictly inside unmarked text leaves every mark — inline " +
    "formatting and annotation anchors alike — exactly where it was. A splice that touches a mark's edge " +
    "re-anchors it: rewrite a bolded term, or the separator between two marked ones, and the mark can open " +
    "mid-word, swallow the punctuation beside it, or spread over text nobody formatted. The marks survived; " +
    "the formatting is now wrong, and nothing here detects that.\n\n" +
    "So edit a block that carries formatting only where the changed range lies strictly inside unmarked text. " +
    "For anything else — a marked span itself, or a range whose edges touch one — delete_block plus " +
    "insert_block is the repair: it writes plain text, losing the formatting instead of corrupting it. Check " +
    "the result with export_markdown, where a mark whose edges are whitespace, or that has swallowed a `, ` " +
    "or an ` and `, is the damage showing.\n\n" +
    "`old_text` and `new_text` are the block text get_doc returns. For a table this is GFM: each must be " +
    "exactly one table, or `invalid_table` refuses the write. Alignment markers are accepted but not stored; " +
    "inline markdown writes cell formatting and escaped punctuation stays literal. Newly added cell document " +
    "targets must be known to this replica's directory or `doclink_target_not_known_locally` refuses before " +
    "writing. Existing targets in surviving cells remain editable. A table no-op keeps every stored character " +
    "and mark, including those GFM cannot express. Table edits splice only changed characters and mark keys " +
    "in changed cells. Without `table_mapping`, only a parsed no-op or exactly one positional cell change at " +
    "unchanged dimensions is accepted. Structural and multi-cell edits require `table_mapping`, including an " +
    "identity mapping for a positional batch; otherwise `table_mapping_required` refuses before any " +
    "mutation.\n\n" +
    "`table_mapping` applies only to tables and has both `rows` and `columns` arrays. Each new position names " +
    "its surviving old zero-based GFM projection index, or null for a new row or column; omitted old indices " +
    "are deleted. Rows include the header, and `rows[0]` must be 0. Array lengths must match the new table; " +
    "non-null indices must be safe non-negative integers in old bounds, unique and strictly increasing. Body " +
    "rows cannot reuse the header. If a retained ragged row selects only virtual empty padding, one fresh " +
    "empty cell keeps that row editable; other padding stays virtual. Reordering is not supported. Untouched " +
    "surviving shared cells keep their identity, formatting and delayed collaborator edits; null entries " +
    "create fresh shared cells. An explicit nonidentity mapping executes even when the GFM text is unchanged. " +
    "A semantically invalid mapping returns `invalid_table_mapping`; both mapping refusals have manual " +
    "recovery and `applied: false`, `partial: false`, `synced: false`. Stale assertions retain precedence and " +
    "invalid GFM remains `invalid_table`. Malformed input shapes are refused by the MCP input schema before " +
    "the handler. Previously accepted structural and multi-cell table calls must now supply mappings as part " +
    "of the coordinated table cutover. Other blocks use plain text with no markdown and reject " +
    "`table_mapping`. In other blocks, spliced-in text inherits the formatting of the character to its left, " +
    "and `rev` ignores marks. A table's `rev` includes its projected formatting. Inserting a read table's GFM " +
    "preserves representable cells and marks, subject to trimmed cell-edge whitespace and renderInline's " +
    "marked whitespace and meeting code-span limits; after one round trip the text is stable.\n\n" +
    "Pass `old_text` (and the `rev` from get_doc) to assert what you are editing. A mismatched asserted rev " +
    "refuses with `stale_block`. When the rev is current but `old_text` is wrong, the refusal is " +
    "`old_text_mismatch`; without a rev, a text mismatch remains `stale_block` because the server cannot tell " +
    "a bad argument from a stale read. Both errors carry `currentText` and `currentRev` to re-diff against.\n\n" +
    "Scope of that guarantee, stated plainly: it is a check against THIS replica at the moment of the call. " +
    "There is no cross-replica compare-and-swap — an edit made elsewhere that has not reached this replica " +
    "yet cannot be detected, and the window widens the longer this server stays offline.",
  insert_block:
    "Insert one block after `after_block_id`, or at the top of the document when it is omitted. Block types " +
    `are the closed set the schema owns — ${BLOCK_TYPES.join(", ")} — which is the editor's whole palette too. ` +
    "A list is a run of adjacent list-item blocks. " +
    "A table's `text` must be exactly one GFM table, or `invalid_table` refuses the write; its rows and cells " +
    "are stored structurally. Alignment markers are accepted but not stored. Inline markdown stores cell " +
    "formatting and escaped punctuation stays literal. Document-link targets must be known to this replica's " +
    "directory, otherwise `doclink_target_not_known_locally` refuses before any write. A terminal's text is a " +
    "transcript in which a line beginning `$ ` is a command typed out and every other line is output shown " +
    "whole — the format has no escape, so an output line that itself begins `$ ` cannot be written. A chart's " +
    "text is a JSON mapping, for example " +
    "`{\"version\":1,\"type\":\"line\",\"collection\":\"observations\",\"x\":{\"field\":\"day\",\"type\":\"date\"},\"y\":[{\"field\":\"count\"}]}`. It names top-level record fields: x type is number or date, and y has one to eight numeric series. Optional x and y labels, y units, title and missing (gap or connect, default gap) control presentation. The chart only reads its document's collection; use update_data to write records. Invalid mappings stay editable source and show a problem message. Every block has one text an agent can edit.",
  set_changelog_suggestion:
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
    "neither answer with it nor match on it.",
  archive_doc:
    "Hide a document: tombstones its directory stub, so it leaves list_docs and the search index. This is not " +
    "erasure and not a delete. Every block, mark and annotation stays exactly where it was: get_doc still " +
    "serves the document by uuid, and list_docs with `include_deleted: true` still lists it, flagged " +
    "`deleted`. There is no tool that erases content, by design.\n\n" +
    "It also leaves the sidebar, because it is unpinned: a document that has left every other listing is not " +
    "an entry point. The unpin is unconditional — it does not first look for a pin, and it hides every pin " +
    "this replica can see — so `unpinned` says what the call asserted, not that a pin was found: it is true " +
    "whenever the archive completed. It is not a cross-replica lock over pinning, any more than the tombstone " +
    "is over writing: a pin made elsewhere that this replica has not received can still merge in behind the " +
    "archive and leave the document archived AND pinned. get_sidebar is where you see that — such a pin lists " +
    "with `status: \"archived\"` — and unpin_doc is what removes it. restore_doc does NOT put a pin back — " +
    "pin_doc is how a restored document becomes an entry point again, and it still wins over this unpin.\n\n" +
    "So this call always writes two independently persisted rooms — the directory and the sidebar —. If the " +
    "local update log refuses the unpin, the call fails with `persistence_failed` carrying the `uuid`, the " +
    "rooms already `completed`, the `failed` room, `rolledBack: false` and a recovery line — never as a " +
    "completed archive.\n\n" +
    "`indexed` says this replica's search index has dropped the document. Dropping it needs only its uuid, so " +
    "unlike restore_doc this does not depend on holding the document — it is false only if the index write " +
    "itself failed, and then the document stays queued and a later call retries it. The archive itself is " +
    "unaffected either way: `applied` is the durable half.",
  restore_doc:
    "Lift a document's archive tombstone: it returns to the default list_docs listing unless it is a " +
    "decision, returns to matching filtered listings either way, and returns to the search index, with the " +
    "title and tags the directory recorded for it. It does NOT return to the sidebar: archive_doc unpinned " +
    "it, and putting an entry point back is pin_doc's deliberate act, not a side effect of restoring. The " +
    "counterpart to archive_doc, and the sanctioned way back — a rename or a retag from a replica that has " +
    "seen the archive deliberately cannot revive a document. Restoring one that is not archived leaves its " +
    "archive state alone, but is not quite a no-op: the directory entry is a cache of the document's own " +
    "metadata, and this trues it up, so a stub that had drifted is repaired in passing.\n\n" +
    "Check `indexed`. It is true when this replica holds the document itself and has just re-derived its " +
    "search rows — the usual case. It is false in two: when this replica knows the document only from the " +
    "directory, and when the index write was refused. Either way the restore is real, replicates, and shows " +
    "immediately in the list_docs collection that includes its kind, but SEARCH ON THIS REPLICA will not find " +
    "the document yet — it catches up when the content arrives or on a later call, whichever was missing. " +
    "Offline, content arriving means the hub coming back.",
  annotate:
    "Open an annotation thread over a range of a block's text, or — with `thread_id` — add a comment to an " +
    "existing thread and optionally resolve or reopen it. The range is anchored by a formatting mark on the " +
    "text itself, so it survives edits, splits and re-types.\n\n" +
    "For a table, supply `row` and `column`: zero-based GFM projection indices with the header as row 0, the " +
    "same indices as `table_mapping`. `start` and `end` count the cell's displayed characters, without inline " +
    "Markdown syntax or escapes, including stored cell-edge whitespace. Canonical GFM `text` preserves that " +
    "whitespace and adds one padding space on either side: remove exactly that padding before decoding the " +
    "cell's inline syntax, rather than trimming it. Offsets are clamped to the cell's text. The returned " +
    "range adds `row` and `column`, recomputed as cells move; it is null when orphaned. Coordinates on a " +
    "non-table block, missing coordinates or a cell outside the projection refuse with `annotation_cell` " +
    "before anything is written. Empty and overlapping ranges refuse with `annotation_range`. Orphaned legacy " +
    "table threads stay orphaned and accept replies, resolution and reopening.\n\n" +
    "Two shapes, and a call is exactly one of them: open a thread with `block_id`, `start` and `end` — all " +
    "three, none of them optional — plus `row` and `column` for a table cell, or reply to one with " +
    "`thread_id` and no range fields at all. Mixing them, or leaving a range half-stated, is refused at the " +
    "input boundary before anything is written, rather than resolved by ignoring whichever fields do not fit. " +
    "`text` and `author` belong to both. A reply may also carry `resolved`: true resolves the thread and " +
    "false reopens it in the same document update as the reply; a new thread cannot carry that field.",
  link_range:
    "Turn a range of a block's text into an inline reference to another document. The range's own characters " +
    "are the label — this tool writes a mark and never a character, so the block's `text` and `rev` come back " +
    "exactly as get_doc gave them. `annotate` anchors a comment to a range the same way; this is that " +
    "operation with a document uuid instead of a thread.\n\n" +
    "`start` and `end` are character offsets into the block's text, and `rev` is REQUIRED: offsets mean " +
    "nothing without the text they were measured against. A stale `rev` refuses with `stale_block`, carrying " +
    "`currentText` and `currentRev` to re-measure against. Indices are clamped to the text and swapped if " +
    "reversed; a range that clamps to nothing is refused.\n\n" +
    "A range that is already a reference is RETARGETED. A range that is already an external link is refused — " +
    "one range cannot be both — and so is a code, mermaid, table, terminal or chart block, which holds source " +
    "text. The answer carries the target's current `title` for information; the label in the document is the " +
    "text you linked, and it does not follow a later rename.\n\n" +
    "The target must be a document this replica's directory knows, or the call refuses with " +
    "`doclink_target_not_known_locally` and writes nothing. An archived target is accepted.\n\n" +
    "The edge shows up in backlinks without touching `meta.links`, which stays the curated doc-level list set_links owns.",
  sync_status:
    "What this replica holds and what the hub has acknowledged.\n\n" +
    "`hub.status` distinguishes `hub-down`, a retryable connection or renewal failure, from `auth-failed`, an " +
    "authentication problem that needs human action. `disabled` means sync is disabled, so this server is " +
    "local-only. Every reading carries `hub.recoveryClass`: `retry` means a missing room can still arrive as " +
    "the connection recovers; `manual` means a person must act before sync can resume. This also applies to " +
    "shared-secret readings. `hub.authRecovery`, when present on `auth-failed`, distinguishes " +
    "`sign-in-required`, `no-workspace-access`, `credential-store` and `renewal-unavailable`; `hub.reason` " +
    "gives the needed action. `update-required` is the third kind: this replica and the hub speak different " +
    "sync protocol versions, so the hub refuses the connection outright. `hub.protocolVersion` is this " +
    "replica's and `hub.hubProtocolVersion` the hub's, and `hub.reason` says which side is older; nothing " +
    "syncs until that side is updated, and no amount of waiting changes it. Every tool still works locally " +
    "throughout.\n\n" +
    "The two counts here are in different units, so they are not expected to agree. `unsyncedChanges` counts " +
    "ROOMS, not updates: the rooms holding local changes the hub has not acknowledged, the ones " +
    "`pendingRooms` names. It is read from the durable pending set, so it survives a restart and is non-zero " +
    "in local-only mode: work that never left this machine is unsynced, whether or not a connection was ever " +
    "attempted. `inFlightUpdates` counts provider SYNC MESSAGES awaiting acknowledgement on the current " +
    "connection, which is not a count of Yjs updates: the provider merges a batch of updates into one " +
    "message, counts a message before it goes out, and resets the backlog to the single sync-handshake " +
    "message on every reconnect — so it can read 1 for a whole document's worth of unsent work. It is in " +
    "memory and resets with the connection. The web client's status line shows the same counter for the room " +
    "it has open, labelled `N sync messages unacked`.\n\n" +
    "`lastSync` is the stored time this machine last found its full replica caught up: connected to the hub, " +
    "no pending room or attach drain, and every attached room acknowledged with no unapplied database " +
    "changes. It is UTC ISO 8601 to the second, or null when no time is stored. It records acknowledgement by " +
    "the hub, not storage there. Each process records it after settling, at most once every five seconds; `ub " +
    "open` also checks while idle. The value never moves backwards across processes.\n\n" +
    "`rooms[].synced` and `unsyncedChanges: 0` report hub acknowledgement under the tool-contracts durability contract.\n\n" +
    "`persistence` is null unless an update failed to reach the log, in which case ordinary replica tools " +
    "refuse to serve until the server is restarted.",
};

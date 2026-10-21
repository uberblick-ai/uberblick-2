/** Tool-specific constraints kept out of tools/list; read on demand through per-tool help. */
import { BLOCK_TYPES } from "@uberblick/schema";

export const toolHelpDetails = {
  create_doc:
    "Create a document and publish its directory stub, so every client can discover it through list_docs or " +
    "search. Blocks are optional: pass them to seed the document, or add them later with insert_block. " +
    "List-item seeds accept optional `list` (`bullet` or `ordered`, default `bullet`) and `indent` " +
    "(integer 0–3, default 0). These fields apply only to list-item blocks; invalid values refuse before " +
    "creating anything. For example, `{\"type\":\"list-item\",\"text\":\"Review notes\",\"list\":\"ordered\",\"indent\":2}` " +
    "creates a nested ordered item. " +
    "Figma seeds take the :::figma body without delimiters, as insert_block does; invalid_figma refuses " +
    "before creating anything. See markdown for keys, accepted links and normalization. " +
    "Optional `tldr` supplies a regular document's person-facing summary under set_metadata rules and limit. " +
    "Before creating a decision topic, consult [When to create a decision record](uberblick://help/lifecycle). " +
    "For decision answer guidance, see [Decision answers and topics](uberblick://help/lifecycle). " +
    "Decision records accept paragraph, code, " +
    "table or a maximal run of adjacent list-item blocks. Other types refuse with decision_block_unsupported; " +
    "more than three answer blocks refuse with decision_answer_too_long, and either writes nothing. " +
    "A decision refuses non-null tldr with " +
    "decision_tldr_unsupported. Creation as decided requires a non-blank answer and valid shape, without " +
    "TL;DR or data. Answer blocks differ from `answer: {who, when, where}`, the recorded person's attribution. " +
    "Decision writes carry no TL;DR review reminder; an editable regular document seeded with blocks does.\n\n" +
    "`tags` is a complete assignment set of active catalog ids or active names. Name matching ignores case. Names are selectors; " +
    "the document stores canonical ids and the answer resolves each id beside its current name. An unknown or " +
    "retired selection refuses the whole call before a document exists; list_tags is the active vocabulary.\n\n" +
    "A `description` is REQUIRED; `title` is also required except for a successor with `supersedes`. " +
    "A missing required field creates nothing. A title cannot be empty or whitespace: an untitled document cannot be picked out of a listing, " +
    "and set_metadata with `title` is the repair for the untitled ones the web UI creates.\n\n" +
    "Pass `kind: decision` to create a decision record. Its `status` defaults to `open`; `status` " +
    "without `kind` is refused before a document is created. A decision " +
    "may pass `related`, the UUID of one live, locally readable regular page. " +
    "A decision target refuses with related_not_regular_document. The page is fixed at creation, stored as " +
    "`governs` for compatibility; existing governs values stay related pages without migration. Any other " +
    "use of `related` is refused before a UUID is allocated or a room is written. A decision may also pass " +
    "`supersedes`, the UUID of a hydrated decision in a live topic it replaces. The reference is immutable, " +
    "and its predecessor's topic is copied forward; a successor without related also inherits its page. " +
    "An explicit related selects the page given. A first record uses its own UUID as topic. `topic` is " +
    "never an input. Supersession is returned by get_doc and is a derived link: backlinks on the earlier " +
    "decision exposes every successor without editing that earlier document. A non-decision target or a " +
    "self-reference is refused before any room is written. An archived predecessor topic is refused with " +
    "`doc_archived` before a UUID is allocated or a room is written; restore the topic before reconsidering " +
    "it. Decisions are created only `open` or `decided`; rejected and withdrawn records must first exist as " +
    "proposals. A decided successor without an answer is refused before allocating a UUID or writing any " +
    "room. Optional `discussion` names a live, locally readable regular document " +
    "for this record's RFC. Create or reuse it first as an ordinary regular document. New " +
    "workspaces include an ordinary `rfc` tag to apply deliberately; connecting never requires or applies " +
    "that tag, creates an RFC or edits the RFC or related page. A decision target refuses with " +
    "`discussion_not_regular_document`; archived, unknown or unhydrated targets refuse with `doc_archived`, " +
    "`doc_not_found` or `doc_not_hydrated`, before a UUID is allocated or a room is written. `discussion` " +
    "without `kind: \"decision\"` is an argument error. For a new topic, create an open first record with " +
    "related and discussion; it has no answer until one is recorded. For reconsideration, create an open " +
    "successor with supersedes and discussion; the current answer stays in force. In both flows, the title " +
    "names the stable topic or question, never the answer. A topic has one title, stored on its first record. " +
    "Successors take the topic's title: omit title or supply that exact title; a different title refuses " +
    "with field title and creates nothing. A rename through any record renames the topic. " +
    "Decision answer guidance is in [Decision answers and topics](uberblick://help/lifecycle). " +
    "These answer blocks are distinct from " +
    "recorded `answer: {who, when, where}` attribution. A record created decided " +
    "can also name its discussion. Successors never inherit discussion, even when they inherit the related " +
    "page. set_metadata can correct or clear it only while open; set_status settles, rejects or withdraws " +
    "under the existing recorded-answer contract. The reference is fixed once the record leaves open. " +
    "It is returned separately from curated links and recorded answer attribution. Directory decision " +
    "entries cache discussion, null for none and absent when unknown, and derive answerPreview from the " +
    "first answer paragraph/list; decisions have no TL;DR. " +
    "get_doc on the related page returns its topic marked related, and other linking topics marked linked.\n\n" +
    "`sidebar` is optional and is the only way to say where the document goes: omit it and the document is " +
    "created unpinned (the default, unchanged), or pass `{group: {id, position?}}` to pin it into a group " +
    "that ALREADY exists — the id comes from get_sidebar, `position` is clamped into range and omitted means " +
    "last. There is no `pinned` flag and no `state`: placement implies pinning, so a contradiction cannot be " +
    "expressed. An unknown or empty group id fails with `group_not_found` and creates nothing at all; this " +
    "tool never creates a group, never resolves one by name, and never guesses a default — pin_doc is what " +
    "brings a group into being. The answer echoes the placement it made as `sidebar: {group: {id, name}, " +
    "position}`.\n\n" +
    "This call writes up to three independently persisted rooms — the document, the directory, and the " +
    "sidebar when you place it — so it reports them one by one. The related page and RFC are never written. " +
    "If the local update log refuses a write part-way, the call fails with `persistence_failed` carrying the " +
    "`uuid`, the rooms already `completed`, the `failed` room, `rolledBack: false`, and a stage-aware " +
    "`recovery` line — the earlier rooms stay durable, and recovery never risks creating the decision twice.",
  get_doc:
    "Read a document's metadata — including `description` and the person-facing `tldr`, each null when nobody " +
    "has written one, with tldr always null for decisions, which have no TL;DR — its blocks and its annotation threads. A regular page with a deliberate TL;DR removal " +
    "returns `tldr: null` and `tldrOptOut: true`; content writes give no TL;DR hints. Opt back in through the " +
    "web's Add TL;DR, or set_metadata with `tldr_opt_in: true` and a non-null `tldr`. Summary text takes " +
    "precedence over the mark, including after concurrent or older-client writes. Unmarked pages and " +
    "decision records omit `tldrOptOut`. Lifecycle documents include `kind` and their " +
    "compatible `status`; ordinary documents omit both. When structured data exists, `data` lists collection " +
    "names and record counts and names `get_data` for deliberate reads. It contains no schemas or record " +
    "values; documents without data omit it.\n\n" +
    "Every document returns a page-level `rev`, identical to the web status row's full revision of its ordered block content. Metadata and comments do not affect it. " +
    "Regular documents return `code_check`: the latest comparison per repository, or [] when never checked. " +
    "Each entry has repository (owner/name), commit, checked_at (writer's UTC recording time) and result: " +
    "matches means agreement, ahead means intentionally undelivered behavior, drift means unintended " +
    "disagreement. Each entry may also carry `rev`, the page revision the comparison read, and `paths`, the repo-relative files or folders looked at. Paths are hints, not a complete dependency list; an absent rev means the compared text is unknown. Earlier entries and entries rewritten by older clients can omit either field. Decision records omit code_check. Content edits and other metadata writes leave these " +
    "entries unchanged; they never appear in blocks or Markdown export.\n\n" +
    "Regular-page `decisions` resolve live topics without opening decision rooms: related topics first, " +
    "then other topics found in backlinks, marked `relation: \"related\"` or `relation: \"linked\"`. Any " +
    "record can establish either relation, including superseded, rejected or withdrawn history. Each group " +
    "is oldest-topic-first, deduplicated, with archived topics omitted; indexed links can lag content. " +
    "Decision-record metadata returns `discussion` as the connected RFC UUID or null. Every decision " +
    "directory entry, including page decisions, predecessors, successors, inForce, pending and conflicts, " +
    "caches it: null means no reference, absent means unknown until stub repair. The discussion is a " +
    "derived outbound edge in effective links, separately from curated links and recorded answer " +
    "attribution. The backlinks tool on the RFC lists its records; reading the RFC returns their topic marked " +
    "linked unless it is also the topic's related page. Renaming or archiving the RFC preserves each " +
    "reference, and an archived RFC remains readable. Decision entries include a cached answerPreview: " +
    "the first answer paragraph/list as plain " +
    "text, list items joined by `; `, whitespace collapsed, at most 300 characters with `…` when cut. " +
    "It is null without a paragraph or list, or absent when the cache is unknown. For decision answers, " +
    "see [Decision answers and topics](uberblick://help/lifecycle). " +
    "Recorded `answer: {who, when, where}` is attribution, not the answer content.\n\n" +
    "Every block carries a `rev` content hash — pass it back to edit_block to assert nothing changed since this read.\n\n" +
    "For a table, `text` is canonical GFM with cell formatting as inline markdown, literal punctuation and " +
    "pipes escaped, and every row padded to the widest row; `rev` includes that formatting. Card text is " +
    "canonical container content with inline Markdown prose parts and repeated `button: [Text](destination)` " +
    "lines after footer in authored order. Each button has nonempty plain text and an https URL or exactly " +
    "claude://code/new, claude-cli://open or codex://new, alone or followed by ?query. Optional style outline/filled " +
    "and color neutral/blue/green/violet default to outline neutral; output puts style before color and omits " +
    "the defaults. Its rev includes every button's text, destination, appearance and order, and prose formatting. Card thread " +
    "ranges name their anchored part. Figma text is canonical :::figma content without delimiters: url, " +
    "optional plain title and height, a blank line and inline-Markdown caption. URL normalization keeps " +
    "only path kind, key/id, name and node-id, starting-point-node-id and version-id on https://www.figma.com. " +
    "Its formatting-sensitive rev includes the caption, and thread ranges use part caption with offsets in " +
    "caption text. The read-only figma field returns kind (frame, file, prototype, board, slides or community " +
    "file), file and optional percent-decoded fileName with dashes read as spaces, plus optional node in " +
    "colon form. See markdown for accepted paths and container validation. For other blocks " +
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
    "The unfiltered orientation listing omits `kind: \"decision\"` records. Pass any `kind`, `status`, `tag` or `has_open_threads` " +
    "predicate to ask for its exact matches, including matching decisions; `kind: \"decision\"` lists decision " +
    "topics with one row per topic. Each row presents the record in force, else a pending record, else the " +
    "first record, and names all pending records and all conflicting maximal decided records. `inForce: null` " +
    "means no answer is in force. A status, tag or open-thread predicate matches a topic if any live record matches; each " +
    "predicate may match a different live record. Resolution still uses its whole graph. `include_superseded: " +
    "true` returns every record with predicates applied per record. Permanently deleted UUIDs are always excluded. `include_deleted` admits archived topics " +
    "but is not a predicate and does not lift the default omission, so an archived decision needs it together " +
    "with a matching predicate. A fresh replica can list the whole corpus once the directory room has " +
    "synced. See [Decision answers and topics](uberblick://help/lifecycle) for decision answer guidance. " +
    "Every decision directory entry, " +
    "including inForce, pending and conflicts, caches `discussion` as the RFC UUID, null when none or " +
    "absent when unknown until a newer client repairs the stub. Each pending proposal therefore names " +
    "its own discussion without opening its room. The reference is distinct from curated links and " +
    "recorded answer attribution. Every decision directory entry also carries a derived " +
    "answerPreview when known: plain text of the first answer paragraph or list, list items " +
    "joined by `; ` and whitespace collapsed, at most 300 characters with `…` when cut. It is null when " +
    "neither exists, and absent when unknown. Decisions have no TL;DR and their directory entries omit tldr. Page get_doc reads mark related and linked topics separately; " +
    "recorded `answer: {who, when, where}` is attribution, separate from these answer blocks.\n\n" +
    "Regular entries cache `code_check` without opening document rooms: [] means never checked, while " +
    "absence means not cached yet. Decision entries omit it. Each entry records repository, commit, " +
    "writer-stamped UTC checked_at and result: matches (agreement), ahead (intentionally undelivered " +
    "behavior) or drift (unintended disagreement), plus recorded `rev` and `paths` when known. Paths are hints, not a complete dependency list. A missing rev means the compared text is unknown, including after an older client drops it. The page's current rev is not cached or returned by list_docs. Content edits leave the checks unchanged. A local " +
    "set_metadata code_check write appears in the next listing. As with openThreadCount, hydration and " +
    "peer updates repair this cache; an older whole-stub writer can drop it until a current replica " +
    "recomputes it after a document change or restart.\n\n" +
    "Every entry, regular or decision, including `inForce`, `pending` and `conflicts`, carries " +
    "`openThreadCount` when known: the count of that document's threads whose `resolved` is not `true`, " +
    "including threads whose anchored text was deleted (`range: null`). Resolved threads do not count; " +
    "replies do not add threads. An absent field means the stub cache is unknown, not zero. " +
    "`has_open_threads: true` matches known counts of at least one and combines with the other filters. " +
    "`has_open_threads: false` refuses at argument validation. A topic matches through any live record " +
    "(not rejected or withdrawn), including a superseded answer, while its representative's own count may " +
    "be zero or unknown. With `include_superseded: true`, the predicate applies to each record instead.\n\n" +
    "To discover topics, call `list_docs({has_open_threads: true})`. To read every matching document's " +
    "threads, call `list_docs({has_open_threads: true, include_superseded: true})`, then `get_doc` on each " +
    "hit for threads and anchors, then `annotate` with `thread_id` to reply, resolve or reopen. Resolving " +
    "the last open thread sets that document's count to zero and removes its per-record match; the topic " +
    "leaves the topic-row filter when none of its live records matches.\n\n" +
    "Hydrated MCP and web replicas recompute the cache after document changes, including peer updates. " +
    "Local `annotate` results are reflected in the next listing; web changes appear once synced. Existing " +
    "live documents gain a known count on hydration or replay without a thread change. Whole-entry stub " +
    "writes use Yjs ordering: during version skew an older writer can drop the field, making it unknown " +
    "and excluding it from the filter until a current replica sees another document change or replays it " +
    "on restart. Archived regular stubs are not repaired; restore supplies the current count and code checks.\n\n" +
    "`description` is the document's own one-or-two-sentence description, cached in the stub so this listing " +
    "answers with it without opening a single room — read it before deciding what to get_doc. It is null for " +
    "a document nobody has described yet; documents created in the web UI start that way, and set_metadata " +
    "with `description` fixes one.\n\n" +
    "`pinned` says whether the sidebar carries the document as an entry point — derived from the sidebar doc, " +
    "read with get_sidebar. Unpinned documents are fully alive; the flag separates entry points from the long " +
    "tail.\n\n" +
    "`createdAt` and `updatedAt` are epoch milliseconds, present only where known — sort keys, not history. " +
    "`updatedAt` says when someone changed the document, not when a replica noticed: each replica stamps only " +
    "for the changes it made itself, so a document you never edit keeps the stamp its editor wrote. " +
    "Concurrent stamps resolve to the greater value, so a future-skewed clock pins the hint until a later " +
    "stamp exceeds it. It is also deliberately coarse — at most one re-stamp every few minutes of its own " +
    "edits, immediately on a metadata or cached thread-count change. Recording only a code check leaves updatedAt unchanged. Both come from the clock of whichever replica wrote them, " +
    "so treat them as approximate, and expect either to be missing on a stub written before they existed.\n\n" +
    "Lifecycle documents include `kind` and their compatible `status`; ordinary documents omit both. The " +
    "optional `kind` and `status` filters are answered from those directory stubs without opening a document " +
    "room, and combine with `tag` and `has_open_threads`. A tag filter accepts a catalog id or current name, ignoring name case; a value this " +
    "catalog does not have is refused rather than answered with an empty listing. Each returned assignment " +
    "carries its canonical id, current name (or null while unresolved), and active, retired or unresolved " +
    "state.",
  search:
    "Full-text search over live document titles, descriptions, content and assigned tag names, from the local FTS5 index. The index " +
    "is derived from the replicas and updated as updates are observed, so it reflects edits from any client " +
    "this replica has seen. Archived documents stay out until restored; use `list_docs` with `include_deleted` " +
    "to find them.\n\n" +
    "Matching is any-word: any searchable word in `query` can match a document. Letters " +
    "and digits make a term; punctuation and emoji are not terms, so a query holding only those matches " +
    "nothing. An underscore-separated group matches its words as an adjacent phrase: `list_docs` matches both " +
    "`list_docs` and `list docs`, but not `a list of docs`. English word forms use FTS5's Porter stemmer: " +
    "`launch` finds `launching` and `launched`. Other languages match exact words or prefixes. Case and accents " +
    "fold, so `ecole` finds `École`. A trailing `*` makes a prefix match: `work*` finds `worktree` and `workspace`; " +
    "prefixes match stems, so `withdraw*` also finds `withdrawal` and `withdrawing`. A prefix past the stem can miss: " +
    "`decisi*` can miss `decision`; search the whole word or a shorter prefix, `decis*`. No hits means no indexed " +
    "document matched any query word under those rules; it does not " +
    "by itself mean the index is empty.\n\n" +
    "Results use title-weighted bm25 relevance: a title word weighs more than the same word elsewhere, " +
    "without guaranteeing that every title match beats a body-only match or that more matched words come first. " +
    "Pass `kind: regular` for regular documents, including stored requirements, or `kind: decision` for all " +
    "decision records, including superseded, rejected and withdrawn records. Pass `tag` as one catalog id or " +
    "current name (case ignored), or a nonempty list. Any listed tag matches; carrying more listed tags boosts the word " +
    "score. Filters combine and apply before `limit`, which defaults to 20 and accepts up to 100. Unknown tags " +
    "refuse.\n\n" +
    "Every hit carries `kind`, `description` (null when unwritten), a snippet and canonical tag assignments " +
    "with current names and retirement state. Every decision hit carries `state`: `in-force`, `superseded`, " +
    "`open`, `rejected`, `withdrawn` or `conflict`. State is resolved from the current topic records, so a " +
    "previously indexed answer can become superseded without being edited. Tag-name matching uses the names " +
    "the hit shows, updated when catalog tags are renamed.",
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
    "For an existing list item, optional `list` (`bullet` or `ordered`) and `indent` (integer 0–3) change " +
    "its style and depth in place, together with a text edit or alone. To re-indent without changing text, " +
    "pass the same read text as `old_text` and `new_text`, the read `rev`, and the new `indent`. " +
    "Omitted list fields keep their existing values. The same old_text/rev assertions guard both text " +
    "and attribute changes in one write; failures change neither. The result returns the new list fields " +
    "and rev. Attribute-only changes keep the block id, text, inline formatting and comment threads, " +
    "and concurrent text edits from another replica survive the merge. These fields refuse on any " +
    "other block type; they do not convert blocks or move an item.\n\n" +
    "Marks anchor to positions in the block's text, not to the words they cover, and this tool writes text " +
    "without ever writing a mark. A splice strictly inside unmarked text leaves every mark — inline " +
    "formatting and annotation anchors alike — exactly where it was. A splice that touches a mark's edge " +
    "re-anchors it: rewrite a bolded term, or the separator between two marked ones, and the mark can open " +
    "mid-word, swallow the punctuation beside it, or spread over text nobody formatted. The marks survived; " +
    "the formatting is now wrong, and nothing here detects that.\n\n" +
    "So edit a block that carries formatting only where the changed range lies strictly inside unmarked text. " +
    "For anything else — a marked span itself, or a range whose edges touch one — delete_block plus " +
    "insert_block writes plain text, losing the formatting instead of corrupting it. An open comment's last " +
    "anchor cannot be replaced this way: first resolve the thread or move its anchor with annotate. Check " +
    "the result with export_markdown, where a mark whose edges are whitespace, or that has swallowed a `, ` " +
    "or an ` and `, is the damage showing.\n\n" +
    "`open_thread_anchored` refuses before any write when the actual splice would remove every remaining " +
    "anchored character of an open thread. The failure names every affected thread by id and anchored text, " +
    "with `recoveryClass: \"manual\"`, `applied: false` and `partial: false`. Use annotate to resolve each " +
    "thread, or to move its anchor to a new range in this document, then retry. A surviving comment mark " +
    "anywhere in the document is enough, including another block, table cell, card part or Figma caption; " +
    "the recorded thread blockId does not limit this check. Resolved threads and already orphaned open " +
    "threads do not block. Survival follows the characters the splice keeps: changing `8s timeout` to " +
    "`10s timeout` keeps `s timeout` anchored. The check also covers table cells, rows/columns removed by " +
    "`table_mapping`, card parts and Figma captions. It sees this replica's state, so concurrent peer edits " +
    "can still remove a remaining anchor.\n\n" +
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
    "of the coordinated table cutover. Cards take the canonical content between :::card and :::, with " +
    "inline Markdown in each prose part and one `button: [Text](destination)` header per button, after footer " +
    "in authored order. Each button's text is nonempty plain text; its destination is an https URL or " +
    "claude://code/new, claude-cli://open or codex://new, alone or followed by an opaque ?query. At most one " +
    "style word (outline/filled) and one color word (neutral/blue/green/violet) may follow the link in either " +
    "order; defaults are outline neutral. Canonical output puts style before color and omits default words. " +
    "Unknown or repeated appearance words, other trailing text and invalid links refuse with invalid_card " +
    "before writing. Repeated label, title or footer headers remain invalid. An edit splices " +
    "only changed parts, characters and mark keys; unchanged parts and comment anchors on unchanged " +
    "characters survive. Newly added document targets must be known locally; existing targets in a part " +
    "remain editable. Unchanged buttons keep their appearances and order during prose or other button edits; " +
    "removing a header line removes that button. The complete button list is one atomic synced value; concurrent " +
    "button edits may overwrite each other without mixing text and destinations. A card's rev includes every " +
    "button's text, destination, style, color and order, and prose formatting. Figma takes the content between :::figma and :::; " +
    "url, optional plain one-line title, optional whole-pixel height 240–960 and an inline-Markdown caption " +
    "after the first blank line. The markdown topic owns its accepted links and normalization. " +
    "Invalid content refuses with invalid_figma before writing. Header edits update only changed " +
    "URL, title or height attributes; caption edits splice changed characters and mark keys, preserving " +
    "unchanged marks and comment anchors. Newly added caption document targets must be known locally. " +
    "Figma revisions include caption formatting. Conversions to or from card or figma are refused. " +
    "Cards and Figma reject table_mapping. Other blocks use plain text with no markdown and reject " +
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
    "Insert the ordered, nonempty `blocks` array consecutively after `after_block_id`, or at the top " +
    "when it is omitted. Each entry has the same shape as a `create_doc` seed; a single block uses a " +
    "one-entry array. The answer's `blocks` lists the inserted blocks in order, each with id and rev. " +
    "Every entry is checked before the live write. A refusal retains its error code, gives the " +
    "1-based `entry_index` in both the message and structured detail, says what to do next and that " +
    "nothing was written. Call-level refusals, such as an unknown anchor or a content lock, have no " +
    "entry index and also write nothing. Decision answer limits are checked against each resulting " +
    "prefix, naming the first entry that breaks the shape. Success reaches peers as one document " +
    "update and moves the cursor once to the end of the last inserted block's stored text. Block types " +
    `are the closed set the schema owns — ${BLOCK_TYPES.join(", ")}. ` +
    "A list is a run of adjacent list-item blocks. Optional `list` is `bullet` or `ordered` (default " +
    "`bullet`), and `indent` is an integer 0–3 (default 0); both apply only to list-item blocks. " +
    "For example, `list: \"ordered\", indent: 2` creates a nested numbered item. Invalid values refuse " +
    "before writing. Depth need not follow the preceding item's depth. " +
    "A table's `text` must be exactly one GFM table, or `invalid_table` refuses the write; its rows and cells " +
    "are stored structurally. Alignment markers are accepted but not stored. Inline markdown stores cell " +
    "formatting and escaped punctuation stays literal. Document-link targets must be known to this replica's " +
    "directory, otherwise `doclink_target_not_known_locally` refuses before any write. A card's text is the " +
    "content between lines exactly :::card and :::. Header keys are lowercase label, title, footer and button " +
    "in any order. Prose keys occur at most once; any number of button lines preserve authored order. " +
    "A nonempty title is required. Prose values are one-line inline Markdown after the colon and one optional " +
    "space, not YAML; quotes stay literal. Each button value contains exactly one `[Text](destination)` " +
    "link with nonempty plain text and an https URL or exactly claude://code/new, claude-cli://open or " +
    "codex://new, alone or followed by an opaque ?query. It accepts no formatting, document links or comments " +
    "in its text. At most one style (outline/filled) and one color (neutral/blue/green/violet) may follow the " +
    "link in either order; defaults are outline neutral, and all other trailing text is invalid. The first blank line ends the " +
    "header, and the remainder is one optional prose body. Parts keep table-cell inline marks. Missing " +
    "title, invalid buttons, unknown or duplicate prose keys and non-key header lines refuse with invalid_card and write nothing. " +
    "get_doc orders present prose keys label, title, footer, then buttons in authored order, a blank line and body. " +
    "Canonical buttons put style before color and omit outline and neutral. Export wraps that content " +
    "in :::card and :::, folds header newlines to spaces, omits empty keys and escapes prose/body lines " +
    "beginning :::. Invalid imports become plain paragraphs preserving all container text. " +
    "A figma block takes the :::figma body without delimiters: required url, optional plain one-line title " +
    "and whole-pixel height 240–960 (default 480), then a blank line and optional inline-Markdown caption. " +
    "Lowercase keys occur at most once; unknown, duplicate or non-key headers refuse. Accepted links are " +
    "HTTPS figma.com/www.figma.com design, file, proto, board, slides and community/file paths with one " +
    "key/id and optional name. Saving rebuilds https://www.figma.com with those path parts and only " +
    "node-id, starting-point-node-id and version-id; it drops other parameters and fragments. Unsupported " +
    "paths, missing url and invalid height refuse with invalid_figma before writing; a non-Figma URL " +
    "gives exactly: figma blocks take figma.com links only; use a plain link for other sites. get_doc returns " +
    "canonical text and derived kind, file, optional fileName and node; see markdown for their meaning. " +
    "Caption document links count toward backlinks and need locally known targets. Documents with figma " +
    "stay read-only in the web unsupported-block fallback, and these writes make no Figma request. " +
    "A terminal's text is a " +
    "transcript in which a line beginning `$ ` is a command typed out and every other line is output shown " +
    "whole — the format has no escape, so an output line that itself begins `$ ` cannot be written. A chart's " +
    "text is a JSON mapping, for example " +
    "`{\"version\":1,\"type\":\"line\",\"collection\":\"observations\",\"x\":{\"field\":\"day\",\"type\":\"date\"}," +
    "\"y\":[{\"field\":\"count\"}]}`. It names top-level record fields: x type is number or date, " +
    "and y has one to eight numeric series. Optional y series type is line or bar, default line. " +
    "Bars-only charts keep top-level type line and draw grouped bars from zero. " +
    "In overlay, a mixed chart draws its bars behind its lines on a separate right-hand value axis. " +
    "Missing, null or wrong-type bar values draw no bar; missing affects only lines. Optional x and y labels, y units, title and " +
    "missing (gap or connect, default gap) control presentation. Optional layout is overlay or panels, default overlay. " +
    "panels draws one compact line or bar chart per y series in mapping order, in a responsive grid; each panel shows its label " +
    "and latest plotted value. Panels share the x range and share y ranges within each unit group. " +
    "layout is invalid for table mappings. Each y series optionally accepts range [min, max], exactly two finite numbers " +
    "with min lower than max, and reference, one finite number. In overlay, both apply to the series' left or right value axis. " +
    "In panels, range applies to the series' unit group and reference draws only on that series' own panel. " +
    "A range is a minimum span: the axis covers every declared range, and plotted or reference values outside it widen the axis. " +
    "A declared range replaces the zero-baseline rule for line-only axes and panel unit groups. " +
    "Axes and panel unit groups containing bars always include zero. A reference draws a horizontal line across the plot; " +
    "each distinct reference value appears once per axis or panel. A panel's reference value also widens its unit group's shared range. " +
    "range and reference are invalid on x and in table mappings. Optional limit is an integer of 1 or more " +
    "and selects the latest N records with a valid x in x-then-record-id order, still at most 5,000. " +
    "A data table also uses a chart block, " +
    "for example `{\"version\":1,\"type\":\"table\",\"collection\":\"observations\",\"columns\":[{\"field\":\"day\",\"format\":\"date\"}," +
    "{\"field\":\"count\",\"label\":\"Count\",\"format\":\"number\"}],\"sort\":{\"field\":\"day\",\"direction\":\"desc\"}}`. " +
    "Its one to thirty ordered columns name fields, optional labels and formats text (default), number, date or link. " +
    "Only number accepts unit (a suffix) and decimals (an integer from zero to ten). Optional title " +
    "supplies only the table's accessible name, and sort (one column field, direction asc or desc) orders rows. " +
    "Optional limit is an integer of 1 or more and shows only the first N valid rows in sort order " +
    "(record-id order without sort). Without limit, every valid record appears in one continuous native table, " +
    "with Generated from document data · read-only below it. Limited rows remain one continuous table, " +
    "with no pager or page state; when limit hides rows, the footnote includes shown and total valid-record counts. " +
    "Open table source appears on hover or keyboard focus and stays reachable without hover. " +
    "Existing pageSize values remain accepted as integers from one to one hundred for compatibility and never affect display; " +
    "omit pageSize from new mappings. For both views, limit has no upper bound of its own. Records hidden by " +
    "the author limit are not omissions. When it hides chart records, a muted note shows the latest shown and " +
    "total valid-x counts; when it hides nothing, no count appears. The chart's 5,000 cap retains its existing " +
    "notice and diagnostics when N exceeds 5,000. update_data recomputes a limited window without changing its source. " +
    "Unknown mapping keys and options are invalid. Both views only " +
    "read their document's collection and contain no record values; use update_data to write records. Invalid mappings stay " +
    "editable source and show a problem message. Every block has one text an agent can edit.",
  set_metadata:
    "Update one or more of `title`, `description`, `tldr`, `tags`, curated `links`, `code_check` and decision `discussion` " +
    "together. At least one " +
    "must be named, and undeclared fields are refused. Each field keeps its own type and limit; a field " +
    "refusal writes none of the named fields and adds `field` to its existing error. Document-level " +
    "refusals keep their usual shape.\n\n" +
    "On a regular document, `code_check: {repository, commit, result, rev, paths?}` records the latest comparison " +
    "with code for one repository. Repository is owner/name, case-insensitive; commit is a full 40- or " +
    "64-character hexadecimal Git commit hash, normalized to lowercase. Results are matches (the page agrees " +
    "with that commit), ahead (intended behavior not yet " +
    "delivered there) and drift (unintended disagreement). Only that repository's entry is replaced; " +
    "other repositories remain and concurrent writes for different repositories survive synchronization. " +
    "Read the page with get_doc and compare its content with code; `rev` must be that page-level revision and must still match this replica when recording. A missing or stale rev refuses the entire call. Read the page again with get_doc and compare it again before recording; do not just resend with a new rev. " +
    "Optional `paths` contains 1–20 literal repo-relative files or folders looked at, each at most 200 characters: no leading /, .. segment or glob characters (* ? [ ] { }); trailing / marks a folder. Duplicates are removed. Paths are hints, not a complete dependency list, and unchanged paths do not prove the page is still right. " +
    "The writing replica sets checked_at to the current UTC time; callers do not supply it. Invalid " +
    "repository, commit, result, rev or paths values and any decision-record code_check write refuse with " +
    "`field: \"code_check\"`, preserving every field in the call. Entries live only in metadata: " +
    "content edits and other metadata writes leave them unchanged, and Markdown export omits them. " +
    "get_doc returns the entries, or []; list_docs caches them on regular entries, with absence meaning " +
    "not cached yet. Earlier entries and older clients can omit rev and paths; those entries still return without the missing fields. No removal or check history is provided.\n\n" +
    "A title is replaced wholesale without changing the document UUID, so links, backlinks and annotations " +
    "survive a rename. A decision topic has one title, stored on its first record; a rename through any " +
    "record renames the topic by writing only that first record. Successors take the topic's title. " +
    "Title and description are trimmed and cannot be empty or cleared; replace a " +
    "description you dislike with a better one. The directory caches both and follows in the same call, " +
    "so list_docs and search answer with their new values; backlinks also returns the description.\n\n" +
    "The person-facing TL;DR is independent of the agent-facing description. Empty, whitespace-only and " +
    "overlong TL;DR values are refused; use null to clear it. A person can deliberately remove a regular " +
    "page's TL;DR through the web menu; MCP cannot set that mark. On a marked page, non-null `tldr` " +
    "without `tldr_opt_in: true` refuses with `tldr_opted_out` and `field: \"tldr\"`, writing nothing. " +
    "Pass `tldr_opt_in: true` with a non-null `tldr` to write the summary and lift the mark. The flag " +
    "requires a non-null `tldr` in the same call, even when false; on an unmarked page it adds no effect. " +
    "`tldr: null` alone preserves the mark. Summary text takes precedence over the mark, including " +
    "concurrent and older-client writes. Only get_doc reports the mark as `tldrOptOut: true`. " +
    "On an open decision, non-null tldr refuses with " +
    "decision_tldr_unsupported; null is accepted. Decisions have no TL;DR and return tldr: null. Decision answer guidance is in " +
    "[Decision answers and topics](uberblick://help/lifecycle). Their " +
    "directory answerPreview derives from the first answer paragraph/list. It is distinct from " +
    "recorded `answer: {who, when, where}` attribution. get_doc page decisions are marked related or linked. " +
    "Ordinary document stubs, search and Markdown do not carry TL;DR.\n\n" +
    "Tags replace the assignment set with catalog ids or active names; name matching ignores case and names resolve to canonical ids " +
    "before storage. Already assigned retired or unresolved ids may be preserved or removed, but cannot be " +
    "newly added. Invalid values produce `invalid_tag_assignment` with `field: \"tags\"` before the document, " +
    "directory or index changes.\n\n" +
    "Links replace the curated UUID array and update backlinks. A newly added target unknown to this " +
    "replica's directory produces `doclink_target_not_known_locally` with `field: \"links\"`; archived " +
    "targets are accepted and an existing curated target can be retained unchanged. Passing get_doc's " +
    "effective links back stores derived governs, supersedes and discussion UUIDs in the curated array too; " +
    "get_doc " +
    "deduplicates the resulting edges. Empty arrays clear tags or curated links.\n\n" +
    "An open decision accepts `discussion` as a live, locally readable regular document UUID, " +
    "or null to clear it. Create or reuse the RFC first as an ordinary regular document. " +
    "A decision target refuses with `discussion_not_regular_document`; archived, unknown and unhydrated " +
    "targets refuse with `doc_archived`, `doc_not_found` and `doc_not_hydrated`, each naming field discussion. " +
    "Rejected or withdrawn records and non-decision documents refuse with `discussion_not_writable` and " +
    "`field: \"discussion\"`. The reference is fixed once the record leaves open. Changing or clearing " +
    "it never creates a document, tags or edits the RFC or related page, or changes approvalFingerprint " +
    "or approvalChanged. It is distinct from curated links and recorded answer attribution.\n\n" +
    "A decided record refuses tldr or discussion with `decision_read_only` and the refused field, " +
    "but accepts title, description, tags and links. Title-only renames preserve answer approval, including " +
    "an existing changed-after-approval warning. An archived document refuses every metadata field. A success " +
    "returns uuid and the descriptive metadata fields, including unchanged values and " +
    "code_check for regular documents or discussion for decision records, plus shared write durability and " +
    "applicable description or tag hints; it carries no `tldrHint`.",
  archive_doc:
    "Hide a document: tombstones its directory stub, so it leaves list_docs and the search index. This is not " +
    "erasure and not a delete. Every block, mark and annotation stays exactly where it was: get_doc still " +
    "serves the document by uuid, and list_docs with `include_deleted: true` still lists it, flagged " +
    "`deleted`. For a decision UUID it always archives the whole topic, including records previously " +
    "archived individually in the web. No MCP argument archives one record. delete_doc permanently removes " +
    "an archived regular document.\n\n" +
    "It also leaves the sidebar, because it is unpinned: a document that has left every other listing is not " +
    "an entry point. The unpin is unconditional — it does not first look for a pin, and it hides every pin " +
    "this replica can see — so `unpinned` says what the call asserted, not that a pin was found: it is true " +
    "whenever the archive completed. It is not a cross-replica lock over pinning, any more than the tombstone " +
    "is over writing: a pin made elsewhere that this replica has not received can still merge in behind the " +
    "archive and leave the document archived AND pinned. get_sidebar is where you see that — such a pin lists " +
    "with `status: \"archived\"` — and unpin_doc is what removes it. restore_doc does NOT put a pin back — " +
    "pin_doc is how a restored document becomes an entry point again, and it still wins over this unpin.\n\n" +
    "So this call always writes two independently persisted rooms — the directory and the sidebar. If the " +
    "local update log refuses the unpin, the call fails with `persistence_failed` carrying the `uuid`, the " +
    "rooms already `completed`, the `failed` room, `rolledBack: false` and a recovery line — never as a " +
    "completed archive.\n\n" +
    "`indexed` says this replica's search index has dropped the document. Dropping it needs only its uuid, so " +
    "unlike restore_doc this does not depend on holding the document — it is false only if the index write " +
    "itself failed, and then the document stays queued and a later call retries it. The archive itself is " +
    "unaffected either way: `applied` is the durable half.",
  delete_doc:
    "Permanently remove an archived regular document's content, comments, structured data and history. " +
    "Archive first: a live document refuses with doc_not_archived. Decision records and topics refuse with " +
    "decision_delete_unsupported until their deletion operation is available. A repeated deletion refuses with doc_deleted.\n\n" +
    "Only its UUID and permanent mark remain in the directory. The mark wins over concurrent or offline restores, " +
    "renames, retags and stub repair. A missing directory entry never authorizes removing a copy. Hubs purge " +
    "the room and refuse all later connections and updates; replicas remove stored and in-memory copies when " +
    "they learn the mark or receive the deleted-room refusal, without an authentication error.\n\n" +
    "Deleted UUIDs never appear in discovery, search or sidebar results, including include_deleted listings. " +
    "Reads, writes and newly added references refuse with doc_deleted. Other documents keep their stored links. " +
    "The result reports uuid, title, records: [uuid], deleted: true and independent directory/sidebar durability. " +
    "Protocol 4 requires a matching hub and client. Freed SQLite pages and earlier backups are not overwritten.",
  restore_doc:
    "Remove one archive layer. In an archived decision topic this restores the topic and the records archived " +
    "with it, leaving records archived individually beforehand unchanged. In a live topic it restores the " +
    "addressed record. A repeated call can therefore remove the next layer. `archived` reports whether the " +
    "addressed answer remains archived; `records` names those affected by this call. No sidebar pins return.\n\n" +
    "A restored document returns to the default list_docs listing unless it is a " +
    "decision, returns to matching filtered listings either way, and returns to the search index, with the " +
    "title and tags the directory recorded for it. It does NOT return to the sidebar: archive_doc unpinned " +
    "it, and putting an entry point back is pin_doc's deliberate act, not a side effect of restoring. The " +
    "counterpart to archive_doc, and the sanctioned way back — a rename or a retag from a replica that has " +
    "seen the archive deliberately cannot revive a document. Restoring a regular document that is not archived leaves its " +
    "archive state alone, but is not quite a no-op: the directory entry is a cache of the document's own " +
    "metadata, and this trues it up, so a stub that had drifted is repaired in passing.\n\n" +
    "Check `indexed`. It is true when this replica holds the document itself and has just re-derived its " +
    "search rows — the usual case. It is false in two: when this replica knows the document only from the " +
    "directory, and when the index write was refused. Either way the restore is real, replicates, and shows " +
    "immediately in the list_docs collection that includes its kind, except for individual record archives " +
    "left in place. SEARCH ON THIS REPLICA will not find a restored but unindexed " +
    "document yet — it catches up when the content arrives or on a later call, whichever was missing. " +
    "Offline, content arriving means the hub coming back.",
  delete_block:
    "Remove the block only if no open comment thread would lose its last anchored character anywhere in " +
    "the document. `open_thread_anchored` refuses without writing and names every affected thread by id and " +
    "anchored text, with `recoveryClass: \"manual\"`, `applied: false` and `partial: false`. Either resolve " +
    "each thread with annotate, or move its anchor with annotate to another block, then retry. Threads " +
    "already orphaned or resolved never block. A surviving comment mark in any block, table cell, card " +
    "part or Figma caption suffices, even outside the thread's recorded blockId. The check uses this " +
    "replica's state; a concurrent peer edit can still remove a remaining anchor.",
  annotate:
    "Open an annotation thread over a range of a block's text, or — with `thread_id` — add a comment to an " +
    "existing thread and optionally resolve or reopen it. The range is anchored by a formatting mark on the " +
    "text itself, so it follows surviving characters through edits, splits and re-types. To move an existing " +
    "thread's anchor, supply `thread_id` together with a complete target range. In one document update, " +
    "the move removes every old comment mark for that thread in every block, marks the new range, changes " +
    "its recorded blockId and appends `text` as a reply. It preserves the id, earlier replies and resolution, " +
    "and works on already orphaned threads. The answer and get_doc report the new blockId and range.\n\n" +
    "For a table, supply `row` and `column`: zero-based GFM projection indices with the header as row 0, the " +
    "same indices as `table_mapping`. `start` and `end` count the cell's displayed characters, without inline " +
    "Markdown syntax or escapes, including stored cell-edge whitespace. Canonical GFM `text` preserves that " +
    "whitespace and adds one padding space on either side: remove exactly that padding before decoding the " +
    "cell's inline syntax, rather than trimming it. Offsets are clamped to the cell's text. The returned " +
    "range adds `row` and `column`, recomputed as cells move; it is null when orphaned. Coordinates on a " +
    "non-table block, missing coordinates or a cell outside the projection refuse with `annotation_cell` " +
    "before anything is written. Empty ranges and ranges overlapping another thread refuse with " +
    "`annotation_range`; moving onto the thread's own current anchor is allowed. Unknown thread ids refuse " +
    "with `thread_not_found`. Invalid move targets leave the old anchor, replies and thread unchanged. " +
    "Card comments are opened in the web editor; opening or moving into a card refuses with annotation_card. " +
    "Existing card ranges name label, title, body or footer in part. Opening or moving into a Figma caption " +
    "refuses with annotation_figma. Existing Figma ranges name part caption and measure caption characters. " +
    "Card and Figma threads can receive replies, resolution and reopening, or move to prose or a table cell.\n\n" +
    "Three shapes, and a call is exactly one: open with `block_id`, `start` and `end`; reply with `thread_id` " +
    "and no range fields; or move with `thread_id`, `block_id`, `start` and `end`. Range targets require all " +
    "three range fields, plus `row` and `column` for a table cell. Incomplete ranges refuse at the input " +
    "boundary before writing. Every mode requires `text` and accepts optional `author`. Only a reply may " +
    "carry `resolved`: true resolves and false reopens in the same update as the reply. Opening and moving " +
    "forbid `resolved`; a move keeps the thread's existing resolution.",
  link_range:
    "Turn a range of a block's text into an inline reference to another document. The range's own characters " +
    "are the label — this tool writes a mark and never a character, so the block's `text` and `rev` come back " +
    "exactly as get_doc gave them. `annotate` anchors a comment to a range the same way; this is that " +
    "operation with a document uuid instead of a thread.\n\n" +
    "`link_range` counts as a block write: a decided decision record refuses it with `decision_read_only`, " +
    "even though its text and rev do not change.\n\n" +
    "`start` and `end` are character offsets into the block's text, and `rev` is REQUIRED: offsets mean " +
    "nothing without the text they were measured against. A stale `rev` refuses with `stale_block`, carrying " +
    "`currentText` and `currentRev` to re-measure against. Indices are clamped to the text and swapped if " +
    "reversed; a range that clamps to nothing is refused.\n\n" +
    "A range that is already a reference is RETARGETED. A range that is already an external link is refused — " +
    "one range cannot be both — and so are source blocks, tables, cards and figma. Write card and Figma caption links as inline " +
    "Markdown through insert_block or edit_block. The answer carries the target's current `title` for information; the label in the document is the " +
    "text you linked, and it does not follow a later rename.\n\n" +
    "The target must be a document this replica's directory knows, or the call refuses with " +
    "`doclink_target_not_known_locally` and writes nothing. An archived target is accepted.\n\n" +
    "The edge shows up in backlinks without touching `meta.links`, which stays the curated doc-level list set_metadata owns.",
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

/** Built-in product concepts. No workspace content or replica state enters these pages. */
import { BLOCK_TYPES, DATA_LIMITS, MAX_DESCRIPTION_LENGTH, MAX_TLDR_LENGTH } from "@uberblick/schema";
import { GUIDANCE_INSTRUCTIONS } from "./briefing.js";
import { FAILURE_INSTRUCTIONS } from "./failures.js";
import { TLDR_AFTER_CONTENT_CHANGE } from "./tools/descriptions.js";

export interface HelpTopic {
  id: string;
  title: string;
  description: string;
  text: string;
}

/** The same orientation is served in initialize.instructions and its help topic. */
export const STARTUP_ORIENTATION =
  "Uberblick organizes local-first workspaces into documents, blocks and decision records. " +
  "Document tools operate on your selected workspace: discover with `get_sidebar`, `list_docs` or `search`, " +
  "then read with `get_doc` before editing. Use returned text and rev for block edits. " +
  "Structured data has dedicated tools and can supply document views. Discover version-matched product help " +
  "through MCP resources, or call `get_help(topic)`, for concepts, lifecycle, supported Markdown syntax and tool usage. " +
  "Built-in help is workspace-agnostic; workspace conventions are ordinary documents, not initialization " +
  "instructions or help resources. Follow recovery guidance on failures. " +
  "Help topics: orientation, workspaces, lifecycle, markdown, data, tools, tool-contracts. " +
  "Read uberblick://help/{topic} or get_help({topic}). Registered tool names are per-tool topic ids; " +
  "discover them with get_help({}) or tools.";

const workspaces = `# Workspaces and documents

Document tools use the workspace selected when this MCP server starts. Project binding and the server's configuration choose it; document calls do not switch workspaces. Built-in help is identical in every workspace. Discover workspace conventions explicitly with normal document tools.

## Discover, read, edit

Start with \`get_sidebar({})\` for curated entry points, \`list_docs({})\` for discovery, or \`search({query: "release plan"})\` for relevant content. Read a discovered UUID with \`get_doc\` before changing it. A document's UUID is its identity; its title is display text. Blocks have their own ids, types, text and revisions. Edit one block against the returned \`old_text\` and \`rev\`; there is no whole-document replacement. A revision checks this replica's current content at call time and is not a distributed lock. Read \`markdown\` for block syntax and \`data\` for dedicated collection reads.

## Metadata

- \`title\` names the document. MCP creation requires a non-empty title and description; \`set_metadata\` with \`title\` repairs untitled documents.
- \`description\` is written for an agent deciding whether to open this document. One or two sentences saying what is in it and what it is for, concrete enough to tell it apart from its neighbours — list_docs, search and backlinks all answer with it, so a good one saves a get_doc and a bad one wastes it. At most ${MAX_DESCRIPTION_LENGTH} characters.
- \`tldr\` is one or two sentences of plain English for a person opening a regular document, independent of its description. \`set_metadata\` accepts up to ${MAX_TLDR_LENGTH} characters for it, refuses empty or whitespace-only strings, and accepts null to clear it. Decision records use answer blocks instead and refuse new TL;DR values; stored legacy values remain readable. Ordinary stubs, search and Markdown do not carry TL;DR. ${TLDR_AFTER_CONTENT_CHANGE}
- \`tags\` store stable catalog ids. Call \`list_tags\` before choosing existing ids or exact names; each entry includes its optional one-line description. Document answers show existing catalog tags only. \`set_metadata\` with \`tags\` replaces existing assignments; an empty array clears them. Stored references awaiting catalog synchronization remain stored; confirmed-deleted references are cleaned only during a later permitted document write. MCP cannot curate the catalog. \`list_tags\` reports \`complete: false\` until initial catalog synchronization completes, so an unseen selection cannot be assumed invalid in the full workspace. Even \`complete: true\` does not prove that a later document reference has its catalog entry locally.
- Curated \`links\` are target document UUIDs, replaced by \`set_metadata\` with \`links\`; an empty array clears them. Newly added targets must be known to this replica's directory, archived targets are accepted, and existing curated targets can be retained unchanged. Inline document references also contribute backlinks. Decision-derived links and lifecycle metadata are explained in \`lifecycle\`.

\`set_metadata\` accepts any non-empty subset of these five fields and leaves unnamed fields untouched. All named fields are validated before any write; a field-specific refusal preserves its error code and names \`field\`. Title and description cannot be cleared. Its successful answer returns all five fields as get_doc would read them, with shared write durability and no TL;DR review reminder.

Reads return absent description and TL;DR as null. Document writes can return non-blocking hints for a missing description, missing tags or a TL;DR needing review. Lifecycle metadata and content locks belong to \`lifecycle\`; write durability and the guidance briefing belong to \`tool-contracts\`.

## Sidebar organization

The sidebar holds ordered named groups and pinned document UUIDs. Unpinned documents remain discoverable through listings, search, links and backlinks. Every sidebar tool returns the whole sidebar: ordered \`groups\` with \`id\`, \`name\` and ordered \`docs\`, so a caller never has to re-read to see where a change landed. Pinned titles come from directory stubs without opening document rooms. A pin's status is \`ok\`, \`archived\` (the document is tombstoned but still pinned — archive_doc unpins, so this pin outlived the archive), or \`unknown\` (no directory entry at all — a document nothing can resolve, left visible so it can be unpinned).

\`pin_doc\` creates a missing group by name and pins or moves a document; each document has at most one pin. \`index\` chooses its position, omitted means last. \`unpin_doc\` removes the pin without changing the document, and beats a concurrent move. \`sidebar_group\` renames, moves or deletes a group; deleting removes its pins and leaves its documents intact. \`create_doc\` may place a new document in an existing group by the id returned by \`get_sidebar\`; omitting placement creates it unpinned.

## Related

[Lifecycle](uberblick://help/lifecycle) · [Supported Markdown](uberblick://help/markdown) · [Structured data](uberblick://help/data) · [Tool contracts](uberblick://help/tool-contracts)`;

const lifecycle = `# Decision records and lifecycle

Ordinary documents omit \`kind\` and \`status\`. Requirements have kind \`requirement\` and states \`draft\`, \`planned\`, \`implementing\`, \`done\`; decisions have kind \`decision\` and states \`open\`, \`decided\`, \`rejected\`, \`withdrawn\`. \`kind\` and \`status\` record what sort of document this is and where it stands; they do not grant permission to act.

\`create_doc\` with a kind defaults to its first state. \`set_status\` can adopt the kind owning a status on an ordinary document; an existing kind is fixed through MCP. A decision is created only open or decided. An open proposal may withdraw without an answer. Decided records cannot reopen or withdraw; rejected and withdrawn records are final. Rejection requires a non-empty reason and a recorded person's answer, and applies to an open proposal, an agent stance or a decided record in conflict.

## Decision answers and topics

A decision record holds its current answer with a brief reason in one to three short answer blocks: paragraphs, code blocks, tables or lists. A list is a maximal run of adjacent \`list-item\` blocks, regardless of style or indent, and counts as one answer block. Guidance belongs on the related regular page and discussion in a separately connected RFC. Headings, quotes, Mermaid, terminal, chart and card blocks refuse with \`decision_block_unsupported\`; creation or insertion that would exceed three answer blocks refuses with \`decision_answer_too_long\`, without writing anything.

Open records may be empty. Every move from another state to \`decided\`, including creation and kind adoption, requires at least one answer block with non-blank text, a valid answer shape, no TL;DR and no structured data. Refusals use \`decision_answer_empty\`, \`decision_tldr_unsupported\`, \`decision_data_unsupported\` or the matching shape code and write nothing. Decision content writes carry no TL;DR review reminder. Legacy content remains readable; an already decided record is not re-checked when its stance is confirmed or rejected.

The answer blocks are separate from \`answer: {who, when, where}\`, which records a person's attribution. A topic's first record, with no \`supersedes\`, may become \`decided\` as an \`agentStance\` without that attribution. Every later move to \`decided\`, and confirmation of an agent stance, requires a recorded person's answer. Recording it stores \`decidedBy\`, \`decidedAt\` and \`decidedWhere\`, clears the stance marker and approves the current title, legacy TL;DR, ordered block text and structured data with an \`approvalFingerprint\`. Comments, comment anchors, \`discussion\` and approval bookkeeping are excluded. \`approvalChanged: true\` means changed after approval; recording an answer again approves the current content. Existing approved legacy content retains its fingerprint. get_doc returns where; list_docs and every \`inForce\`, \`pending\` and \`conflicts\` entry expose the stance, who, when and approvalChanged from stubs. During version skew, older clients fingerprint without structured data, so a decided record holding data can show \`approvalChanged\` differently per client.

MCP validates the lifecycle transition and whether a recorded answer is required. It stores the supplied answer; it does not authenticate that person's external approval or decide which choices a project's workflow reserves to a person. Callers must obtain the authority their workflow requires before recording an answer or acting on a decision.

A first record uses its own UUID as its immutable \`topic\`. A superseding record names its predecessor with \`supersedes\` and inherits that topic; topic is not a caller-supplied field. Optional \`related\` on create_doc identifies one live, locally readable regular page, including a requirement; a decision-record target refuses with \`related_not_regular_document\`. That page is fixed at creation. A successor inherits its predecessor's page unless \`related\` gives another. Metadata and stubs retain the stored key \`governs\`, including existing records, without migration. Creation targets must be readable on this replica. A successor to an archived topic is refused until that topic is restored.

### Connect RFC discussion

Create or reuse the RFC first as an ordinary regular document. New workspaces include an ordinary \`rfc\` tag that can be applied deliberately; no tool requires it. For a new topic, create an open first record with \`related\` and \`discussion\`: it has no answer until one is recorded. To reconsider an answer, create an open successor with \`supersedes\` and \`discussion\`; the current answer stays in force while the proposal is open. Optional \`discussion\` also works when recording a decision directly with \`status: "decided"\`. It names that record's RFC, separately from curated \`links\` and recorded \`answer\` attribution. A successor never inherits its predecessor's discussion.

The discussion UUID must name a live, locally readable non-decision document, including a requirement. A decision-record target refuses with \`discussion_not_regular_document\`; archived, unknown and unhydrated targets refuse with \`doc_archived\`, \`doc_not_found\` and \`doc_not_hydrated\`. These checks happen before allocation or writes. \`discussion\` without \`kind: "decision"\` is an argument error. While the record is open, \`set_metadata\` can correct the UUID with the same checks or clear it with \`discussion: null\`, atomically with its other named fields. Settle, reject or withdraw with \`set_status\` under the recorded-answer contract above. The reference is fixed once the record leaves \`open\` and survives RFC renaming or archival. Connecting, changing or clearing it never creates a document, tags or edits the RFC or related page, or changes \`approvalFingerprint\` or \`approvalChanged\`.

Reading any regular page returns live topics in \`decisions\`: first those whose any record has this related page, marked \`relation: "related"\`, then other topics whose any record links to it through the backlinks index, marked \`relation: "linked"\`. Each group is oldest-topic-first, with each topic appearing once; superseded, rejected and withdrawn records still establish the relation. Archived topics are omitted. Resolution uses directory stubs without opening decision rooms; indexed links can lag content that has not been indexed. Each record carries its stored \`governs\`, immutable \`topic\`, immutable \`supersedes\` and \`discussion\`, which is null when absent. \`governs\`, \`supersedes\` and \`discussion\` are derived outbound edges in its effective \`links\`; backlinks on a predecessor finds direct successors, and backlinks on an RFC finds its connected records. Reading the RFC returns its topic marked linked unless the RFC is also its related page. A decision read returns every predecessor, every direct successor with its status, and its topic's resolution. Conflicts name every maximal decided record and have nothing in force; no successor is selected as the replacement. \`set_metadata\` with \`links\` replaces only the curated link array; passing get_doc's effective \`links\` back stores those UUIDs there too, and get_doc deduplicates the resulting edges.

Decision directory entries cache \`discussion\` and a derived \`answerPreview\` for listings, page decisions, predecessors, successors and all resolution entries, including every pending proposal. A null discussion means no reference; a missing value means the cache is unknown until a newer client repairs the stub. The preview is the stored legacy TL;DR when present; otherwise it is plain text from the first paragraph or list, with list items joined by \`; \`, marks dropped and whitespace collapsed. At most 300 characters are shown, ending in \`…\` when cut. Code-only or table-only answers return null. A missing preview is unknown until a newer client repairs the stub; it does not mean an empty answer. No tool accepts a preview as input.

\`list_docs({})\` omits decision records. Use \`list_docs({kind: "decision"})\` for one row per topic; a status or tag filter also asks for exact matching topics. Each row presents its record in force, otherwise a pending record, otherwise the first record. \`include_superseded: true\` returns individual records. A topic with conflicting maximal decided records has nothing in force; get_doc returns every predecessor, direct successor and the resolution rather than choosing one replacement.

### When to create a decision record

A decision record preserves a deliberate architectural, product or UX choice and its enduring reason. Put the guidance future work should follow on its related regular page. The record adds something that reading the code or configuration alone cannot tell you.

**Do** propose a record when the choice will guide multiple tasks, prevent a consequential accidental reversal, or settle a topic repeatedly debated or reconsidered. A rarely consulted record can still be valuable if it protects an important compatibility, security or product commitment. Issues, reviews and Git history can reveal repeated uncertainty; they do not prove historical intent.

**Do not** create a record just to describe existing code, configuration, a routine fix, a temporary workaround or implementation mechanics. Do not turn every changed detail into policy. Keep the meaningful choice precise while leaving its implementation flexible.

| Useful decision | Description that does not justify a record |
| --- | --- |
| Support these iOS versions because of our users’ devices and maintenance budget; reconsider when those conditions change. Specify whether this means minimum support, an explicit set or tested versions. | The deployment target is set to this version. |
| Users can read and edit previously opened documents offline, so interrupted connectivity does not interrupt their work. | This function reads from the local database. |
| Use shadcn/ui as the sole component library and prefer its standard components to custom implementations, to keep the UI consistent and reduce maintenance. Custom alternatives require clear justification and human approval. | This screen imports a Button component from shadcn/ui. |
| Clients synchronize through a shared service rather than directly with each other, for stated operational and connectivity reasons. | A list of endpoints, classes or dependencies. |

Before proposing a record, ask: **What concrete future choice would it guide, or what consequential mistake would it prevent?** If neither has a credible answer, keep the explanation in ordinary documentation, code comments, an issue or a PR.

Check existing decision topics first. Reuse the current topic; when changing its answer, follow the successor lifecycle. A useful candidate is not automatically authorized for creation: follow the project’s approval rules. These examples illustrate how to judge a candidate; they do not establish policies for your project.

## Content locks

Both content locks leave document-room access and structured-data reads available.

A decided decision record's title, answer blocks and legacy TL;DR or structured data are read-only: content-writing tools refuse with \`decision_read_only\` and change nothing. A \`set_metadata\` call naming title, tldr or discussion also refuses the whole call and names the locked field. Discussion changes on rejected or withdrawn records, or non-decision documents, refuse with \`discussion_not_writable\` and \`field: "discussion"\`. An open decision refuses non-null tldr with \`decision_tldr_unsupported\`; null clears a legacy TL;DR. \`update_data\` on other decision states refuses with \`decision_data_unsupported\`. Use a new superseding record for a decided content change. Comments, description, tags and curated links stay writable. This check runs on this replica at call time; an unseen offline edit can still merge later, detected as changed after approval.

Archived documents are read-only. While a document's directory stub is tombstoned document mutations refuse with \`doc_archived\` and change nothing; restore_doc is the only mutation an archived document accepts, and the only way back. Reading is unaffected — get_doc, export_markdown, backlinks and \`list_docs\` with \`include_deleted: true\` all still answer for it; a decision additionally needs a matching \`kind\`, \`status\` or \`tag\` predicate in list_docs.

The honest scope, the same discipline \`rev\` has: the check runs against THIS replica's directory stub at the moment of the call. It is refusal-at-call, not a cross-replica lock — an edit made on a replica that has not seen the archive yet is an ordinary CRDT write and merges normally when the two replicas meet.

## Archive and explicit restoration

\`archive_doc\` tombstones the directory entry and removes its sidebar pin. \`restore_doc\` is an explicit lifecycle action: it reactivates the document without changing its content, bypassing decided-content locks or changing workspace access. A generic content or metadata write cannot restore a document.

For a decision, archive_doc and restore_doc act on every record in its topic. Only the first record's directory tombstone decides whether the topic is archived; individual tombstones never change resolution. No individual decision record can be archived or restored. This does not change the related page, and archiving that page does not archive its decision topics.

Concurrency: a directory entry is written as a whole object, so an archive_doc racing a restore_doc on another replica converges on whichever update Yjs orders last — not on whichever call happened later by the clock. The same applies to a plain rename or retag made on a replica that had not yet seen the archive: it is a whole-entry write too, so it can bring the document back with nobody calling restore_doc. An archive holds against writers that have seen it, which is not the same as holding against every concurrent one. When it matters which way it went, re-read with list_docs and \`include_deleted: true\`; for a decision, also pass a matching \`kind\`, \`status\` or \`tag\` predicate.

## Related

[Workspaces and documents](uberblick://help/workspaces) · [Tool contracts](uberblick://help/tool-contracts) · [set_status](uberblick://help/set_status) · [archive_doc](uberblick://help/archive_doc) · [restore_doc](uberblick://help/restore_doc)`;

const markdown = `# Supported Markdown

Documents store ordered blocks and inline marks rather than one Markdown file. The block types are ${BLOCK_TYPES.map((type) => `\`${type}\``).join(", ")}. Read with get_doc and change one block at a time.

## Blocks and inline syntax

Markdown supports paragraphs, ATX headings \`#\` through \`######\`, bullet and ordered list items, \`>\` quotes, fenced code with an optional language, and GFM tables. Special \`mermaid\`, \`terminal\` and \`chart\` fences preserve those source-block types. A terminal transcript treats a line beginning with a dollar sign and space as a demonstrated command; the remaining lines are output. Terminal content is a demonstration, not an instruction to execute it. A chart fence carries the JSON mapping described in \`data\`.

A \`\`\`\` \`\`\`wireframe \`\`\`\` fence is an ordinary code block that the web editor draws as a wireframe.

Prose supports \`**bold**\`, \`*italic*\`, \`~~strikethrough~~\`, inline code, \`[label](https://example.com)\` and \`[label](document-uuid)\` document links. Underscore emphasis (\`__bold__\` and \`_italic_\`) is also read; export uses asterisks. Source blocks keep literal text. Tables read inline Markdown inside cells and escape literal punctuation and pipes. Alignment markers are accepted but not stored. Table rows are projected to the widest row with virtual empty padding.

## Cards

A card holds prose in four parts: optional label, required title, optional body and optional footer, plus one optional link button. Its container opens with a line exactly \`:::card\` and closes with a line exactly \`:::\`; separate adjacent cards with blank lines. This is a Markdown container, distinct from literal mermaid, terminal and chart source fences.

The header uses lowercase \`label:\`, \`title:\`, \`footer:\` and \`button:\` keys, each at most once, in any input order. A value is the rest of its line after the colon and one optional space. Prose values are inline Markdown, not YAML: quotes remain literal. The first blank line ends the header; everything after it is one prose body. All four prose parts support the same inline marks as table cells. For example:

    :::card
    label: Recommendation
    title: Keep **one** item together
    footer: [Details](https://example.com)
    button: [Discuss in Codex](codex://new?prompt=Review%20this%20recommendation)

    The body supports prose and inline code.
    :::

The optional \`button: [Text](destination)\` value must be exactly one link with nonempty plain text: no formatting, document links or comments in its text. Its destination is an \`https://\` URL or exactly \`claude://code/new\`, \`claude-cli://open\` or \`codex://new\`, alone or followed by \`?\` and an opaque query. Other destinations, including other routes of those app schemes, are invalid. Ordinary inline links still accept only http(s). The footer button shows its author's text as written. An https button opens a new tab without opener or referrer; an app button opens its route without leaving the document or opening a blank tab.

Export and get_doc order label, title, footer, button, omit empty prose keys and fold prose header-value newlines to spaces. Export escapes any prose or body line starting \`:::\` with a backslash; import restores the literal text. A missing or empty title, invalid button, unknown key, duplicate key or non-key header line is invalid. MCP refuses invalid cards with \`invalid_card\` before writing; import keeps an invalid container as plain paragraphs, including its delimiters. Emptying the title in the web editor therefore makes its later export invalid on import.

The document model is flat: one list item is one block, nested to at most four levels (indent 0–3). Markdown import does not read continuation lines or nested block content inside a list item. Consecutive quote lines form one quote block. HTML comments are skipped on import. Frontmatter can carry document identity and metadata; without a frontmatter title, a leading level-1 heading becomes the title.

## MCP content writes

For ordinary blocks, \`text\` is plain text: inserting Markdown punctuation does not add inline formatting. Creation and insertion may supply explicit inline runs for prose. A table's text must be exactly one GFM table and writes its parsed cell formatting. A card's text is the content between the container delimiters. get_doc exposes canonical table GFM and card content; their revisions include inline formatting, while prose revisions ignore marks. Prose document links also appear as character ranges in \`doc_links\`.

Table structural and multi-cell edits require \`table_mapping\` rows and columns; see \`edit_block\` for the full mapping contract. For prose carrying formatting, text splices can re-anchor a mark when a changed range touches its edge. See \`edit_block\` before changing a marked span and verify the result with \`export_markdown\`.

Card edits splice only changed parts and characters, preserving an unchanged button, marks and comment anchors. Remove the button header line to remove its button. Prose card links count toward backlinks. Open card comments in the web editor: MCP \`annotate\` refuses new card anchors but accepts replies, resolution and reopening by thread_id. \`link_range\` refuses cards; write prose links as inline Markdown in their text. Returned annotation ranges name the card part.

## Export

\`export_markdown\` renders each block and its supported inline marks. Fenced source blocks retain their source. The default frontmatter carries UUID, title, tags, optional description and lifecycle fields. Pass \`frontmatter: false\` to omit it. Comments are dropped by default; \`annotations: "html-comments"\` exports anchored threads as HTML comments, which Markdown import does not restore.

Requirement decision logs are exported as a derived topic summary, not restorable directory relationships. Structured record data is omitted and the export states that omission; chart mappings remain ordinary exported content. Markdown is a readable projection rather than a backup of datasets, lifecycle relationships, comment anchors or CRDT history.

## Related

[Workspaces and documents](uberblick://help/workspaces) · [Structured data](uberblick://help/data) · [edit_block](uberblick://help/edit_block) · [export_markdown](uberblick://help/export_markdown)`;

const data = `# Structured data and views

A document can own named collections beside its prose. Each collection has one schema and identified whole JSON-object records. Collection names and record ids are non-empty well-formed Unicode strings; ids are unique within a collection and ordered by Unicode code point. Different collections and records merge independently, with eventual consistency and competing-write loss rather than distributed atomicity or compare-and-swap.

## Deliberate reads and validated updates

\`get_doc\` reports collection names and record counts without schemas or values. \`get_data({uuid})\` returns an area summary, or \`data: null\` when no data exists. Add \`collection\` to read its stored schema, validity, diagnostics and a detached page of records. Use \`limit: 0\` for the schema only. Unknown collections are refused and direct the caller to the summary read.

\`after\` is an exclusive id cursor. \`limit\` defaults to 100 and is at most 1,000; \`max_bytes\` defaults to 65,536 and is at most 1,048,576. An optional \`ids\` filter accepts at most 1,000 ids and reports missing ids. The byte budget measures canonical UTF-8 JSON of the page's id/value array, excluding schemas, diagnostics and response formatting. With a positive limit, the first remaining record is included even when it exceeds that budget. Follow \`next_after\` until \`complete\`; pages are not snapshots and traverse each record once only while the data stays unchanged. Invalid merged data stays visible with diagnostics; reads neither repair nor discard it.

\`update_data\` takes one validated batch, naming each touched collection once. For each collection it sets \`schema\`, optionally \`replaceRecords\`, then applies \`deleteRecords\` and \`upsert\` whole id/value records. \`deleteCollection: true\` excludes other changes. Every retained record must satisfy the resulting schema before the batch commits in one local transaction. An identical refresh returns \`changed: false\` and emits no update. Keep producer records and human dispositions in separate collections, sharing ids by convention. Content locks are in \`lifecycle\`; briefing and durability are in \`tool-contracts\`.

## Closed version-1 schema vocabulary

A collection schema is exactly \`{version: 1, schema: {...}}\`; no other envelope keys or versions are accepted. The record schema must have exactly \`type: "object"\`. Nested schemas are objects and may omit type. This is a deliberately closed vocabulary, not unrestricted JSON Schema: every unsupported or malformed keyword is refused with a JSON Pointer path, including at nested depths.

| Keyword | Accepted value |
| --- | --- |
| type | object, array, string, number, integer, boolean or null; or a two-element array pairing one non-null supported type with null, in either order. |
| properties | An object mapping literal property names to nested schema objects. |
| required | An array of unique string property names. |
| additionalProperties | false or omitted; true and schema values are refused. |
| items | One nested schema object, applied to every array element; tuple schemas are refused. |
| enum | A non-empty array of unique scalar values: string, finite number, boolean or null. |
| const | One scalar value: string, finite number, boolean or null. |
| minimum, maximum | Finite numeric bounds. |
| minLength, maxLength | Non-negative integer string-length bounds, counted by Unicode code point. |
| minItems, maxItems | Non-negative integer array-length bounds. |

For example:

\`\`\`json
{"version":1,"schema":{"type":"object","properties":{"day":{"type":"string"},"count":{"type":"integer","minimum":0},"note":{"type":["string","null"]}},"required":["day","count"],"additionalProperties":false}}
\`\`\`

Records are ordinary JSON objects, including nested objects and arrays, with finite numbers and well-formed Unicode strings and property names. Own \`__proto__\` keys are refused at every depth, and a stored value's root cannot have its own \`constructor\` key; nested constructor keys and those words as string values, names or ids remain valid. Scalars and property names are not traversed as schema keywords.

Canonical UTF-8 JSON limits are ${DATA_LIMITS.area} bytes (4 MiB) for the data area including keys, ${DATA_LIMITS.record} bytes (64 KiB) per record and per collection schema, and ${DATA_LIMITS.operation} bytes (1 MiB) for schemas plus changed record values in one operation. JSON container depth is at most ${DATA_LIMITS.depth}, counting the schema envelope with its root at depth one. There is no record-count ceiling. An already over-limit merged area may shrink incrementally if touched collections are otherwise valid. Split larger writes into calls; separate calls are not atomic together. Encoded transport size and retained CRDT history are outside these budgets.

## Bind a document view to data

A \`chart\` block holds editable JSON source, configured with ordinary \`create_doc\`, \`insert_block\` or \`edit_block\` calls. A line chart or data table reads a collection from its own document. Its mapping names literal top-level fields; it contains no record values:

\`\`\`json
{"version":1,"type":"line","collection":"observations","x":{"field":"day","type":"date"},"y":[{"field":"count","label":"Count"}],"missing":"gap"}
\`\`\`

Mapping fields are version 1, type line, collection, x with field and type number or date (optional label), and one to eight numeric y series with field (optional label and unit). Optional title and missing gap or connect control presentation; gap is the default. Optional layout is overlay or panels, default overlay. panels draws one compact line chart per y series in mapping order, in a responsive grid; each panel shows its label and latest plotted value. Panels share the x range and share y ranges within each unit group. layout is invalid for table mappings. Optional limit is an integer of 1 or more and selects the latest N records with a valid x in x-then-record-id order, still at most 5,000. A numeric x is finite; a date x is an ISO date-only string or an RFC 3339 date-time string with an explicit timezone. Date-only values are UTC days. Charts sort by x then record id, never coerce or aggregate values, omit schema-invalid records and report omissions. Missing/null y values break a series under gap and bridge under connect; wrong types remain gaps. At most the latest 5,000 eligible x records are plotted.

### Data tables

People insert Data table from the block menu, then edit its JSON source. Agents use the same \`chart\` block type:

\`\`\`json
{"version":1,"type":"table","collection":"observations","columns":[{"field":"day","label":"Day","format":"date"},{"field":"count","label":"Count","format":"number","decimals":0},{"field":"run_h","label":"Run time","format":"number","unit":"h","decimals":1},{"field":"url","format":"link"}],"sort":{"field":"day","direction":"desc"}}
\`\`\`

A table mapping has version 1, type table, collection and 1–30 ordered columns. Each column has field, optional label and optional format: text (default), number, date or link. Only number accepts unit as a suffix and decimals as an integer from 0–10 setting exact fraction digits; without decimals it uses the line chart's number formatting. Optional title supplies only the table's accessible name; otherwise it is \`Data table of <collection>\`. Optional sort names one column field and direction asc or desc. Optional limit is an integer of 1 or more and shows only the first N valid rows in sort order (record-id order without sort). Existing pageSize values remain accepted as integers from 1–100 for compatibility and never affect display; omit pageSize from new mappings. Unknown keys or options are invalid, including percent, currency, duration and textField.

Text shows strings verbatim and other values as compact JSON. Number shows JSON numbers in the reader's locale. Date accepts the line chart's ISO dates and RFC 3339 date-times. Link shows only external http(s) URLs as links, opening without an opener or referrer. Absent, null and invalid values have distinct visible markers; invalid markers include the stored value as text. Values never become markup. Sort uses numbers, date instants or Unicode code points for text and links; absent, null and invalid values follow valid ones in either direction. Ties and unsorted rows follow record id. Schema-invalid records are omitted and counted. Without limit, every valid record appears in one continuous native table styled like an ordinary document table, with Generated from document data · read-only below it. Limited rows remain one continuous table, with no pager or page state. When limit hides rows, the footnote includes shown and total valid-record counts. Open table source and copy appear on hover or keyboard focus without moving the table; source stays reachable on devices without hover.

For both views, limit has no upper bound of its own. Records hidden by the author limit are not omissions. When it hides chart records, a muted note shows the latest shown and total valid-x counts; when it hides nothing, no count appears. The chart's 5,000 cap retains its existing notice and diagnostics when N exceeds 5,000.

\`update_data\` refreshes open charts and tables and recomputes a limited window without changing their source. All mounted views in one document share one validated data snapshot. Views are read-only; invalid mappings, missing collections, unsupported schemas and incompatible fields show problems without repairing stored content. Tables also report an empty collection. Charts and tables remain readable in locked documents; their source follows existing content locks. Search indexes titles, descriptions and block text, not record values; Markdown exports mappings while omitting datasets.

## Related

[get_data](uberblick://help/get_data) · [update_data](uberblick://help/update_data) · [Lifecycle](uberblick://help/lifecycle) · [Tool contracts](uberblick://help/tool-contracts) · [Supported Markdown](uberblick://help/markdown)`;

const toolContracts = `# Shared tool contracts

## Arguments and results

Every registered tool declares its input and output schemas. Input objects accept only declared fields; unknown or misspelled fields and mixed action shapes are refused before the handler runs. Successful results carry \`structuredContent\` and a text block containing the same JSON. Server-produced result objects are closed: an undeclared key, missing required field or wrong type yields a text-only \`internal_error\`, with mismatch detail on server stderr. Caller-stored schemas and record values are passed through without normalization, and data diagnostics remain free-form.

## Failures and recovery

${FAILURE_INSTRUCTIONS}

Failures are marked \`isError: true\` and omit structuredContent, so success-schema validation does not misinterpret a failure. A call started after shutdown begins is refused with \`server_shutting_down\`; begin a new MCP session before repeating that call. A persistence failure quarantines the replica until restart: ordinary workspace reads also refuse rather than returning state ahead of its durable log. The diagnostic tool sync_status still answers. Static help reads and get_help remain available because they do not open or settle replicas.

Unknown help topics through get_help are manual refusals and name all valid topic ids. An unknown \`uberblick://help/{topic}\` resource raises JSON-RPC resource-not-found error -32002 naming its URI. Help is built in and version matched; no workspace document, tag or guidance content supplies it.

## Write durability and synced

Successful writes report \`applied\`, \`synced\` and \`hub\`. Applied means this server's local update log holds the write. Hub describes the connection, not remote storage. Calls touching multiple rooms report each room independently; aggregate synced is true only when every touched room is acknowledged. There is no rollback or cross-room remote atomicity.

\`synced: true\` means the hub acknowledged this update: it is in the hub's memory, and a healthy hub has scheduled the write on its store debounce — by default 2s after the last change to the document, 10s at the outside. It does NOT mean the hub has stored it: the write is still ahead of the hub's disk, and the store itself can fail. A hub that dies abruptly inside that window (SIGKILL, a crash, power loss) loses its volatile copy of the update. That is recoverable rather than fatal: \`applied: true\` is the durable half — this server's append-only update log holds the write before the tool returns and re-sends it on reconnect — so losing it for good takes the crash plus no replica holding that update ever coming back.

## Guidance briefing

${GUIDANCE_INSTRUCTIONS}

## Related

[Lifecycle and content locks](uberblick://help/lifecycle) · [Workspaces and metadata](uberblick://help/workspaces) · [Structured data](uberblick://help/data) · [sync_status](uberblick://help/sync_status)`;

/** One owner for each shared contract; per-tool pages link to these topics. */
export const conceptTopics: readonly HelpTopic[] = [
  {
    id: "orientation",
    title: "Startup orientation",
    description: "Brief starting directions and how to discover deeper version-matched product help.",
    text: STARTUP_ORIENTATION,
  },
  {
    id: "workspaces",
    title: "Workspaces and documents",
    description: "Workspace selection, document and block identities, metadata, links, tags and sidebar organization.",
    text: workspaces,
  },
  {
    id: "lifecycle",
    title: "Decision records and lifecycle",
    description: "Requirements, decision topics, when to create decision records, supersession, status, authority, content locks, archive and restoration.",
    text: lifecycle,
  },
  {
    id: "markdown",
    title: "Supported Markdown",
    description: "Supported block and inline syntax, tables, content writes and Markdown export behavior.",
    text: markdown,
  },
  {
    id: "data",
    title: "Structured data and views",
    description: "Collections, the closed version-1 schema vocabulary, deliberate reads and updates, and chart mappings.",
    text: data,
  },
  {
    id: "tools",
    title: "Tool index",
    description: "Every registered MCP tool with its purpose and a link to its full per-tool help.",
    text: "# Tool index",
  },
  {
    id: "tool-contracts",
    title: "Shared tool contracts",
    description: "Arguments and results, failure recovery, local write durability, synced and the guidance briefing.",
    text: toolContracts,
  },
];

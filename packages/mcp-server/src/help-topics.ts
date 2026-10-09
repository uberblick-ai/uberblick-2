/** Built-in product concepts. No workspace content or replica state enters these pages. */
import { BLOCK_TYPES, DATA_LIMITS, MAX_TLDR_LENGTH } from "@uberblick/schema";
import { GUIDANCE_INSTRUCTIONS } from "./briefing.js";
import { FAILURE_INSTRUCTIONS } from "./failures.js";
import {
  ARCHIVED_IS_READ_ONLY,
  ARCHIVE_IS_LAST_WRITE_WINS,
  DECIDED_IS_READ_ONLY,
  DECISION_AUTHORITY,
  DECISION_EDGES,
  DECISION_TOPIC_LIFECYCLE,
  DESCRIPTION_IS_FOR_CHOOSING,
  LIFECYCLE_RECORDS_STATE,
  SYNCED_MEANS,
  TLDR_AFTER_CONTENT_CHANGE,
} from "./tools/descriptions.js";

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

- \`title\` names the document. MCP creation requires a non-empty title and description; \`set_title\` repairs untitled documents.
- \`description\` helps an agent choose whether to open a document. ${DESCRIPTION_IS_FOR_CHOOSING}
- \`tldr\` is one or two sentences of plain English for a person opening the document, independent of its description. \`set_tldr\` accepts up to ${MAX_TLDR_LENGTH} characters, refuses empty or whitespace-only strings, and accepts null to clear it. Decision directory stubs cache it as the decision line; ordinary stubs, search and Markdown do not carry it. ${TLDR_AFTER_CONTENT_CHANGE}
- \`tags\` store stable catalog ids. Call \`list_tags\` before choosing active ids or exact current names. \`set_tags\` replaces the complete assignment set. Existing retired or unresolved assignments may be preserved by their returned ids, or removed; they cannot be newly assigned. MCP cannot curate the catalog. \`list_tags\` reports \`complete: false\` until the catalog arrives from a configured hub, so an unseen selection cannot be assumed invalid in the full workspace.
- Curated \`links\` are target document UUIDs, replaced by \`set_links\`. Inline document references also contribute backlinks. Decision-derived links and lifecycle metadata are explained in \`lifecycle\`.

Reads return absent description and TL;DR as null. Document writes can return non-blocking hints for a missing description, missing tags or a TL;DR needing review. Lifecycle metadata and content locks belong to \`lifecycle\`; write durability and the guidance briefing belong to \`tool-contracts\`.

## Sidebar organization

The sidebar holds ordered named groups and pinned document UUIDs. Unpinned documents remain discoverable through listings, search, links and backlinks. Every sidebar tool returns the whole sidebar: ordered \`groups\` with \`id\`, \`name\` and ordered \`docs\`. Pinned titles come from directory stubs without opening document rooms. A pin's status is \`ok\`, \`archived\` (a pin that outlived an archive), or \`unknown\` (no directory entry).

\`pin_doc\` creates a missing group by name and pins or moves a document; each document has at most one pin. \`index\` chooses its position, omitted means last. \`unpin_doc\` removes the pin without changing the document, and beats a concurrent move. \`sidebar_group\` renames, moves or deletes a group; deleting removes its pins and leaves its documents intact. \`create_doc\` may place a new document in an existing group by the id returned by \`get_sidebar\`; omitting placement creates it unpinned.

## Related

[Lifecycle](uberblick://help/lifecycle) · [Supported Markdown](uberblick://help/markdown) · [Structured data](uberblick://help/data) · [Tool contracts](uberblick://help/tool-contracts)`;

const lifecycle = `# Decision records and lifecycle

Ordinary documents omit \`kind\` and \`status\`. Requirements have kind \`requirement\` and states \`draft\`, \`planned\`, \`implementing\`, \`done\`; decisions have kind \`decision\` and states \`open\`, \`decided\`, \`rejected\`, \`withdrawn\`. ${LIFECYCLE_RECORDS_STATE}

\`create_doc\` with a kind defaults to its first state. \`set_status\` can adopt the kind owning a status on an ordinary document; an existing kind is fixed through MCP. A decision is created only open or decided. An open proposal may withdraw without an answer. Decided records cannot reopen or withdraw; rejected and withdrawn records are final. Rejection requires a non-empty reason and a recorded person's answer, and applies to an open proposal, an agent stance or a decided record in conflict.

## Decision topics and authority

${DECISION_AUTHORITY}

MCP validates the lifecycle transition and whether a recorded answer is required. It stores the supplied answer; it does not authenticate that person's external approval or decide which choices a project's workflow reserves to a person. Callers must obtain the authority their workflow requires before recording an answer or acting on a decision.

A first record uses its own UUID as its immutable \`topic\`. A superseding record names its predecessor with \`supersedes\` and inherits that topic; topic is not a caller-supplied field. Optional \`governs\` identifies a live requirement. Both targets must be readable on this replica at creation. A successor to an archived topic is refused until that topic is restored.

${DECISION_EDGES}

\`list_docs({})\` omits decision records. Use \`list_docs({kind: "decision"})\` for one row per topic; a status or tag filter also asks for exact matching topics. Each row presents its record in force, otherwise a pending record, otherwise the first record. \`include_superseded: true\` returns individual records. A topic with conflicting maximal decided records has nothing in force; get_doc returns every predecessor, direct successor and the resolution rather than choosing one replacement.

## Content locks

${DECIDED_IS_READ_ONLY.replace("this tool refuses", "content-writing tools refuse")}

${ARCHIVED_IS_READ_ONLY.replace("this tool refuses", "document mutations refuse")}

## Archive and explicit restoration

\`archive_doc\` tombstones the directory entry and removes its sidebar pin. \`restore_doc\` is an explicit lifecycle action: it reactivates the document without changing its content, bypassing decided-content locks or changing workspace access. A generic content or metadata write cannot restore a document.

${DECISION_TOPIC_LIFECYCLE}

${ARCHIVE_IS_LAST_WRITE_WINS}

## Related

[Workspaces and documents](uberblick://help/workspaces) · [Tool contracts](uberblick://help/tool-contracts) · [set_status](uberblick://help/set_status) · [archive_doc](uberblick://help/archive_doc) · [restore_doc](uberblick://help/restore_doc)`;

const markdown = `# Supported Markdown

Documents store ordered blocks and inline marks rather than one Markdown file. The block types are ${BLOCK_TYPES.map((type) => `\`${type}\``).join(", ")}. Read with get_doc and change one block at a time.

## Blocks and inline syntax

Markdown supports paragraphs, ATX headings \`#\` through \`######\`, bullet and ordered list items, \`>\` quotes, fenced code with an optional language, and GFM tables. Special \`mermaid\`, \`terminal\` and \`chart\` fences preserve those source-block types. A terminal transcript treats a line beginning with a dollar sign and space as a demonstrated command; the remaining lines are output. Terminal content is a demonstration, not an instruction to execute it. A chart fence carries the JSON mapping described in \`data\`.

Prose supports \`**bold**\`, \`*italic*\`, \`~~strikethrough~~\`, inline code, \`[label](https://example.com)\` and \`[label](document-uuid)\` document links. Underscore emphasis (\`__bold__\` and \`_italic_\`) is also read; export uses asterisks. Source blocks keep literal text. Tables read inline Markdown inside cells and escape literal punctuation and pipes. Alignment markers are accepted but not stored. Table rows are projected to the widest row with virtual empty padding.

The document model is flat: one list item is one block, nested to at most four levels (indent 0–3). Markdown import does not read continuation lines or nested block content inside a list item. Consecutive quote lines form one quote block. HTML comments are skipped on import. Frontmatter can carry document identity and metadata; without a frontmatter title, a leading level-1 heading becomes the title.

## MCP content writes

For ordinary blocks, \`text\` is plain text: inserting Markdown punctuation does not add inline formatting. Creation and insertion may supply explicit inline runs for prose. A table's text must be exactly one GFM table and writes its parsed cell formatting. get_doc exposes table text as canonical GFM; its revision includes cell formatting, while prose revisions ignore marks. Prose document links also appear as character ranges in \`doc_links\`.

Table structural and multi-cell edits require \`table_mapping\` rows and columns; see \`edit_block\` for the full mapping contract. For prose carrying formatting, text splices can re-anchor a mark when a changed range touches its edge. See \`edit_block\` before changing a marked span and verify the result with \`export_markdown\`.

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

A \`chart\` block holds editable JSON source, configured with ordinary \`create_doc\`, \`insert_block\` or \`edit_block\` calls. A line chart reads a collection from its own document. Its mapping names literal top-level fields; it contains no record values:

\`\`\`json
{"version":1,"type":"line","collection":"observations","x":{"field":"day","type":"date"},"y":[{"field":"count","label":"Count"}],"missing":"gap"}
\`\`\`

Mapping fields are version 1, type line, collection, x with field and type number or date (optional label), and one to eight numeric y series with field (optional label and unit). Optional title and missing gap or connect control presentation; gap is the default. A numeric x is finite; a date x is an ISO date-only string or an RFC 3339 date-time string with an explicit timezone. Date-only values are UTC days. Charts sort by x then record id, never coerce or aggregate values, omit schema-invalid records and report omissions. Missing/null y values break a series under gap and bridge under connect; wrong types remain gaps. At most the latest 5,000 eligible x records are plotted.

\`update_data\` refreshes an open chart without changing its source. A chart is a read-only view of data; invalid mappings, missing collections, unsupported schemas and incompatible fields show problems without repairing stored content. Charts remain readable in locked documents. Search indexes titles, descriptions and block text, not record values; Markdown exports mappings while omitting datasets.

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

${SYNCED_MEANS}

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
    description: "Requirements, decision topics, supersession, status, authority, content locks, archive and restoration.",
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

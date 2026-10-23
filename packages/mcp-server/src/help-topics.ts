/** Built-in product concepts. No workspace content or replica state enters these pages. */
import { BLOCK_TYPES, DATA_LIMITS, INLINE_ICONS, MAX_DESCRIPTION_LENGTH, MAX_TLDR_LENGTH } from "@uberblick/schema";
import { FAILURE_INSTRUCTIONS } from "./failures.js";
import { TLDR_AFTER_CONTENT_CHANGE } from "./tools/descriptions.js";

export interface HelpTopic {
  id: string;
  title: string;
  description: string;
  text: string;
}

/** Workspace-independent orientation shared by startup and its help topic. */
export const STARTUP_ORIENTATION =
  "Uberblick stores this repo's documents and decision records. " +
  "Before you change anything, search the corpus for relevant documents and decisions, then read them with `get_doc`. " +
  "If the request conflicts with a decision in force, ask before building. " +
  "`list_docs` lists documents; with `kind: \"decision\"`, decision topics. " +
  "Read `get_help(edit_doc)` before you create or edit a document, and follow each failure's recovery. " +
  "This repo's conventions are in the corpus, not in help. " +
  "Help topics, through `get_help({topic})` or uberblick://help/{topic}: orientation, edit_doc, decisions, " +
  "workspaces, markdown, ablauf, wireframe, data, tools, tool-contracts.";

const workspaces = `# Workspaces and documents

Document tools use the workspace selected when this MCP server starts. Project binding and the server's configuration choose it; document calls do not switch workspaces. Built-in help is identical in every workspace. Discover workspace conventions explicitly with normal document tools.

## Discover, read, edit

Start with \`get_sidebar({})\` for curated entry points, \`list_docs({})\` for discovery, or \`search({query: "release plan"})\` for relevant content. Read a discovered UUID with \`get_doc\` before changing it. A document's UUID is its identity; its title is display text. Blocks have their own ids, types, text and revisions. Edit one block against the returned \`old_text\` and \`rev\`; there is no whole-document replacement. A revision checks this replica's current content at call time and is not a distributed lock. Read \`markdown\` for block syntax and \`data\` for dedicated collection reads.

## Metadata

- \`title\` names the document. MCP creation requires a non-empty title and description; \`set_metadata\` with \`title\` repairs untitled documents.
- \`description\` is read only by agents and never shown to people. Write whatever best helps an agent find this document with list_docs and search and decide whether to open it: what it covers, how it differs from its neighbours and the terms someone would search for. A keyword list is fine. list_docs, search and backlinks all answer with it, so a good one saves a get_doc and a bad one wastes it. At most ${MAX_DESCRIPTION_LENGTH} characters.
- \`tldr\` is one or two sentences of plain English for a person opening a regular document, independent of its description. \`set_metadata\` accepts up to ${MAX_TLDR_LENGTH} characters for it, refuses empty or whitespace-only strings, and accepts null to clear it. A person can choose Remove TL;DR from the web's Document actions to clear the summary and mark the page as having none on purpose. Marked pages return \`tldr: null\` and \`tldrOptOut: true\` only in \`get_doc\`, and content writes omit TL;DR hints. A non-null summary on a marked page refuses with \`tldr_opted_out\` and \`field: "tldr"\` unless \`set_metadata\` passes \`tldr_opt_in: true\` in the same call. The flag requires a non-null \`tldr\`; writing it lifts the mark. Null preserves the mark. The web's Add TL;DR lifts it before editing, even if editing is cancelled. Summary text takes precedence over the mark after concurrent or older-client writes. MCP cannot set the mark. Decisions have no TL;DR: they use answer blocks, return \`tldr: null\`, omit it from directory entries and never report the mark. Ordinary stubs, search and Markdown do not carry TL;DR or the mark. ${TLDR_AFTER_CONTENT_CHANGE}
- \`tags\` store stable catalog ids. Call \`list_tags\` before choosing existing ids or names (case ignored); entries include optional descriptions. Document reads show only existing catalog tags. \`set_metadata\` with \`tags\` replaces existing-tag assignments; an empty array clears those assignments. References awaiting their catalog entry stay stored and hidden; confirmed-deleted references are cleaned only during later permitted document writes. MCP cannot curate the catalog. \`list_tags\` reports \`complete: false\` until the catalog arrives from a configured hub, so an unseen selection cannot be assumed invalid in the full workspace.
- Curated \`links\` are target document UUIDs, replaced by \`set_metadata\` with \`links\`; an empty array clears them. Newly added targets must be known to this replica's directory, archived targets are accepted, and existing curated targets can be retained unchanged. Inline document references also contribute backlinks. Decision-derived links and decision metadata are explained in \`decisions\`.
- \`code_check\` records a regular page's latest comparison with code per repository. \`set_metadata\` takes one \`{repository, commit, result, rev, paths?}\` entry: \`matches\` means agreement with the commit, \`ahead\` means intentionally undelivered behavior, and \`drift\` means unintended disagreement. \`rev\` must match the page-level revision read with \`get_doc\`, the same value the web status row shows for regular pages and decisions. Missing or stale rev refuses the whole call with \`field: "code_check"\`: read the page again and compare it with code before recording, rather than just resending with a new rev. Optional \`paths\` are hints about repo-relative files/folders looked at, not a complete dependency list; see \`set_metadata\` help for limits. Repository identity ignores case; the writing replica supplies \`checked_at\` in UTC. Only that repository's entry is replaced. \`get_doc\` returns the entries or [], with recorded rev and paths when present; earlier entries and older-client rewrites can omit them, making compared text or paths unknown. list_docs does not return checks. Decisions omit the attribute and refuse writes to it. Content edits and other metadata writes leave it unchanged; blocks and Markdown export never carry it.

\`set_metadata\` accepts any non-empty subset of these fields and leaves unnamed fields untouched. All named fields are validated before any write; a field-specific refusal preserves its error code and names \`field\`. Title and description cannot be cleared. Its successful answer returns the descriptive metadata as get_doc would read it, with shared write durability and no TL;DR review reminder. Open decision records additionally accept \`discussion\`, as explained in \`decisions\`.

Reads return absent description and TL;DR as null. Document writes can return non-blocking hints for a missing description, missing tags or a TL;DR needing review. Decision metadata and the decided-answer lock belong to \`decisions\`, the archive lock to \`archive_doc\`; write durability belongs to \`tool-contracts\`.

## Sidebar organization

The sidebar holds ordered named groups and pinned document UUIDs. Unpinned documents remain discoverable through listings, search, links and backlinks. Every sidebar tool returns the whole sidebar: ordered \`groups\` with \`id\`, \`name\` and ordered \`docs\`, so a caller never has to re-read to see where a change landed. Pinned titles come from directory stubs without opening document rooms. A pin's status is \`ok\`, \`archived\` (the document is tombstoned but still pinned — archive_doc unpins, so this pin outlived the archive), or \`unknown\` (no directory entry at all — a document nothing can resolve, left visible so it can be unpinned).

\`pin_doc\` creates a missing group by name and pins or moves a document; each document has at most one pin. \`index\` chooses its position, omitted means last. \`unpin_doc\` removes the pin without changing the document, and beats a concurrent move. \`sidebar_group\` renames, moves or deletes a group; deleting removes its pins and leaves its documents intact. \`create_doc\` may place a new document in an existing group by the id returned by \`get_sidebar\`; omitting placement creates it unpinned.

## Related

[Decision records](uberblick://help/decisions) · [Supported Markdown](uberblick://help/markdown) · [Structured data](uberblick://help/data) · [Tool contracts](uberblick://help/tool-contracts)`;

const editDoc = `# Editing documents

Create and change documents with the fewest calls. Details live in \`decisions\`, \`markdown\`, \`data\` and each tool's own help.

## Before you write

- Search first. Change the page that already owns a fact instead of creating another one.
- Read the document with \`get_doc\`. It returns each block's \`id\`, \`text\` and \`rev\`; edits assert them.

## Regular page or decision record

- A **regular page** holds content that changes over time. Most edits belong here.
- A **decision record** (\`kind: "decision"\`) holds the short answer to one lasting question. Once decided, its answer is read-only and changes only through a successor record. Read \`decisions\` before you create or change one.
- Archived documents are read-only until \`restore_doc\`.

## Create and change

- \`create_doc\` needs a title and a description. Only agents read the description: write whatever helps \`list_docs\` and \`search\` find the page; a keyword list is fine. Tags come from \`list_tags\`.
- \`insert_block\` adds blocks after a block id, or at the top. \`edit_block\` changes one block against the \`old_text\` and \`rev\` you read. \`move_block\` reorders existing blocks with their ids and comment anchors intact; read its help for the concurrent-edit limit. \`delete_block\` removes one. There is no whole-document replace.
- Documents merge live (Yjs): people and other agents may edit at the same time and watch your changes. Change only the words that need changing; \`edit_block\` keeps everyone else's edits and comment anchors, while deleting and re-inserting a block drops them.
- A refused edit returns \`currentText\` and \`currentRev\`: apply your change to them and retry, without another read.
- \`set_metadata\` changes title, description, tags, links and TL;DR, a regular page's code check and an open decision's \`discussion\`. Structured data uses \`get_data\` and \`update_data\`.

## Markdown essentials

- One block per paragraph, heading, list item, quote, code fence or table. Lists are flat: \`indent\` 0–3.
- A block's \`text\` is plain text: \`**bold**\` stays literal. For formatting or links in prose, pass \`inline\` runs with marks when creating or inserting.
- Tables, cards, embeds and GitHub references are in \`markdown\`.
- Check the result with \`export_markdown\`.

## Related

[Decision records](uberblick://help/decisions) · [Markdown](uberblick://help/markdown) · [Structured data](uberblick://help/data) · [Tool contracts](uberblick://help/tool-contracts)`;

const decisions = `# Decision records

A decision record holds the short answer to one lasting question. Ordinary documents omit \`kind\` and \`status\`; a decision record has \`kind: "decision"\` and a status: \`open\`, \`decided\`, \`rejected\` or \`withdrawn\`. The status says where the question stands; it grants no permission to act.

## When to create one

Create a first record only when all four hold:

1. **Significance:** a central product principle, an architectural direction, a substantial system-wide commitment or a major change to user-facing behavior. Judge by consequences, not implementation size.
2. **Meaningful alternatives:** credible approaches have materially different consequences, and current guidance does not settle the choice.
3. **Lasting consequences:** the choice constrains work beyond the current task.
4. **Useful rationale:** future work needs to understand the tradeoff.

Routine feature details, formatting, refactors and bug fixes belong on the owning regular page and in the issue or pull request. When in doubt, do not create a topic. Check existing topics first with \`list_docs({kind: "decision"})\` or \`search\` with \`kind: "decision"\`.

## Topics and titles

A topic is the question; it keeps its identity while its answer changes. The first record's UUID is the topic's address for citations and pins. The title names the question, never the answer, and is stored once on the first record: renaming any record renames the topic. A successor takes the topic's title; omit \`title\` when creating it.

## Writing the answer

- Lead with the choice in one plain sentence naming the chosen option, without hedging such as "should consider". Give the reason in one clause or sentence.
- Keep the whole answer to 60 words or fewer, in one to three answer blocks: paragraphs, code blocks, tables or lists (adjacent list items count as one). Other block types refuse.
- Short is not vague: keep the concrete terms needed to apply the answer.
- Put alternatives, extended rationale and process in a linked RFC, and product detail on the owning regular page. Do not restate the topic or write a specification.
- Decisions have no TL;DR, and a decided record holds no structured data.

## Status changes

- \`create_doc\` with \`kind: "decision"\` creates an open record, or a decided one with its answer. \`set_status\` moves it later, or turns an ordinary page into a decision record.
- An open record may be empty or hold a proposal. Moving to \`decided\` needs a non-blank answer.
- A topic's first record may be decided as an agent stance without a person. Every later decision, and confirming a stance, needs \`answer: {who, when, where}\`: who gave the answer, when and where. MCP stores it without verifying it, so have that authority first.
- An open proposal may be withdrawn. Rejecting needs a reason and a person's answer. Decided records cannot reopen; rejected and withdrawn records are final.

## Changing a decided answer

A decided record's answer is read-only: content writes refuse with \`decision_read_only\`. Title, description, tags, links and comments stay editable, and a rename keeps the approval. To change the answer, create a successor with \`create_doc\`, \`kind: "decision"\` and \`supersedes\` naming the record it replaces. It joins the same topic, and the current answer stays in force while the successor is open. State the changed outcome and why. An answer edit that still arrives, for example from an offline editor, shows \`approvalChanged: true\` until a person's answer is recorded again.

## Discussion and related pages

- \`related\` accepts one regular-page UUID or a non-empty list of them. The set is fixed at creation. A successor that omits \`related\` inherits its predecessor's whole set; supplying it replaces that set for the successor only.
- \`discussion\` names the RFC: an ordinary regular page holding the options and reasoning. Create or reuse it first. While the record is open, \`set_metadata\` can change or clear it; after that it is fixed. A successor never inherits it.
- Reading a regular page returns its topics in \`decisions\`: related topics first, then topics whose records link to it.

## Reading topics

- \`list_docs({kind: "decision"})\` lists one row per topic: the record in force, else a pending one, else the first, with the UUIDs of the record in force, the pending records and any conflicts. \`include_superseded: true\` lists every record.
- \`get_doc\` on a record returns its predecessors, direct successors and the topic's resolution. Competing decided answers form a conflict with nothing in force; a decided record in conflict can be rejected with a person's answer.

## Related

[Editing documents](uberblick://help/edit_doc) · [archive_doc](uberblick://help/archive_doc) · [set_status](uberblick://help/set_status) · [create_doc](uberblick://help/create_doc)`;

const markdown = `# Supported Markdown

Documents store ordered blocks and inline marks rather than one Markdown file. The block types are ${BLOCK_TYPES.map((type) => `\`${type}\``).join(", ")}. Read with get_doc and change one block at a time.

## Blocks and inline syntax

Markdown supports paragraphs, ATX headings \`#\` through \`######\`, bullet and ordered list items, \`>\` quotes, fenced code with an optional language, and GFM tables. Special \`terminal\` and \`chart\` fences preserve those source-block types. A \`mermaid\` fence is ordinary code with language \`mermaid\` and is never drawn. A terminal transcript treats a line beginning with a dollar sign and space as a demonstrated command; the remaining lines are output. Terminal content is a demonstration, not an instruction to execute it. A chart fence carries the JSON mapping described in \`data\`.

Stored Mermaid blocks are deleted automatically, including in archived documents and decision records; their source is not retained. Their comment threads remain available with no anchor. Removing an approved answer block reports \`approvalChanged: true\` without recording another approval.

A \`\`\`\` \`\`\`wireframe \`\`\`\` fence is an ordinary code block that the web editor draws as a wireframe; see [Wireframes](uberblick://help/wireframe) for writing one.

An \`ablauf\` fence is an ordinary code block that the web editor draws as a diagram. It supports \`flow v0\` and \`fan-out v0\`; see [Ablauf diagrams](uberblick://help/ablauf) for reading, writing and editing. Import, export and MCP preserve its literal source.

Prose supports \`**bold**\`, \`*italic*\`, \`~~strikethrough~~\`, inline code, \`[label](https://example.com)\` and \`[label](document-uuid)\` document links. Underscore emphasis (\`__bold__\` and \`_italic_\`) is also read; export uses asterisks. Source blocks keep literal text. Tables read inline Markdown inside cells and escape literal punctuation and pipes. Alignment markers are accepted but not stored. Table rows are projected to the widest row with virtual empty padding.

### GitHub references

To cite a GitHub issue or pull request, write an external link to the item's \`github.com\` address with the reference as its text: \`owner/repo#n\`, \`repo#n\`, \`#n\` or the URL itself. The text must name the same item as the address. The web shows it as a pill; everywhere else it stays an ordinary link. Pills need no special syntax or mark.

Use \`/pull/<n>\` for a pull request and \`/issues/<n>\` for an issue; the pill's icon follows the address. Link the reference, not a title: a linked title stays a plain link. Plain \`owner/repo#n\` text renders as text, and \`find_decisions\` does not find it because it reads only external link addresses in prose.

For a paragraph in \`create_doc\` or \`insert_block\`, supply inline runs:

\`\`\`json
"inline": [
  {"text": "Make caret placement deterministic (", "marks": {}},
  {"text": "app#2005", "marks": {"link": "https://github.com/acme/app/pull/2005"}},
  {"text": ").", "marks": {}}
]
\`\`\`

### Inline icons

Write \`:name:\` to show a curated icon in the web app. Available names are ${Object.keys(INLINE_ICONS).map((name) => `\`:${name}:\``).join(", ")}. Names use lowercase kebab case. Icons use the surrounding text's size and color in paragraphs, headings, list items, quotes, table cells, all four card prose parts, Figma captions and card button labels. For example, \`button: [:claude: Discuss with Claude](claude://code/new?prompt=Review)\` shows the Claude mark beside its label.

Unknown names such as \`:rocket:\` stay literal, unchanged text, as do \`10:30:15\` and \`note:this:\`. Inline code and code, terminal and chart source never render icons; use inline code to show a known name literally. Stored text, MCP reads and writes, search, decision approval and Markdown import/export keep the literal \`:name:\` source. This is presentation only, without an icon node or mark; MCP does not validate icon names.

Write emoji as characters, such as 😃 or 🚀. MCP never converts \`:name:\` to emoji: \`:smiley:\` and \`:rocket:\` remain literal in writes, reads and Markdown import/export. The web editor's typed emoji conversion does not apply to MCP or imported Markdown.

## Cards

A card holds prose in four parts: optional label, required title, optional body and optional footer, plus any number of link buttons. Its container opens with a line exactly \`:::card\` and closes with a line exactly \`:::\`; separate adjacent cards with blank lines. This is a Markdown container, distinct from literal code, terminal and chart source fences.

The header uses lowercase \`label:\`, \`title:\`, \`footer:\` and \`button:\` keys in any input order. Each prose key appears at most once; each button has its own \`button:\` line, in authored order. A value is the rest of its line after the colon and one optional space. Prose values are inline Markdown, not YAML: quotes remain literal. The first blank line ends the header; everything after it is one prose body. All four prose parts support the same inline marks as table cells. For example:

    :::card
    label: Recommendation
    title: Keep **one** item together
    footer: [Details](https://example.com)
    button: [Discuss in Codex](codex://new?prompt=Review%20this%20recommendation) filled blue
    button: [View details](https://example.com)

    The body supports prose and inline code.
    :::

Each \`button: [Text](destination)\` value has exactly one link with nonempty plain text: no formatting, document links or comments in its text. Inline icon source such as \`:claude:\` is plain text and renders as its icon. Its destination is an \`https://\` URL or exactly \`claude://code/new\`, \`claude-cli://open\` or \`codex://new\`, alone or followed by \`?\` and an opaque query. After the link, at most one style word (\`outline\` or \`filled\`) and at most one color word (\`neutral\`, \`blue\`, \`green\` or \`violet\`) are accepted in either order, with no other text. Defaults are \`outline neutral\`. Other destinations, including other routes of those app schemes, are invalid. Ordinary inline links still accept only http(s). Buttons show their author's label with inline icons in a compact, right-aligned group below the footer; content-sized buttons wrap onto further right-aligned rows. An https button opens a new tab without opener or referrer; an app button opens its route without leaving the document or opening a blank tab.

Export and get_doc order label, title, footer, then every button in authored order. Button output writes style before color and omits \`outline\` and \`neutral\`; import restores the same buttons and appearances. Empty prose keys are omitted and prose header-value newlines fold to spaces. Export escapes any prose or body line starting \`:::\` with a backslash; import restores the literal text. A missing or empty title, invalid button, unknown key, duplicate prose key or non-key header line is invalid. MCP refuses invalid cards with \`invalid_card\` before writing; import keeps an invalid container as plain paragraphs, including its delimiters. Emptying the title in the web editor therefore makes its later export invalid on import.

## Figma

A Figma block holds one design reference. Its container opens on a line exactly \`:::figma\` and closes on a line exactly \`:::\`. It uses the card container rules, separate from literal source fences: lowercase keys, each at most once and in any input order, one optional space after the colon, and the first blank line ending the header. The closed keys are required \`url\`, optional \`title\` and optional \`height\`; the remaining text is one optional prose caption with bold, italic, strike, inline code, http(s) external links and document links.

    :::figma
    url: https://www.figma.com/design/k3Lm9QzT2x/Checkout-flow?node-id=12-345&t=AbC123-1
    title: Payment, mobile
    height: 560

    Card form after the **address** step.
    :::

The URL accepts only HTTPS on \`www.figma.com\` or \`figma.com\`, with \`/design/<key>[/<name>]\`, \`/file/<key>[/<name>]\`, \`/proto/<key>[/<name>]\`, \`/board/<key>[/<name>]\`, \`/slides/<key>[/<name>]\` or \`/community/file/<id>[/<name>]\`. Saving rebuilds it on \`https://www.figma.com\` with only the path kind, file key/id, file name, \`node-id\`, \`starting-point-node-id\` and \`version-id\`. Other parameters, including \`t\`, and fragments are dropped. Branch paths, \`/deck/\` and extra path segments are unsupported. No schema, MCP, CLI or hub operation contacts Figma.

Title is literal one-line plain text, without inline Markdown; an empty title is absent and export folds title newlines to spaces. Height is a whole number from 240 to 960 pixels, defaulting to 480 when absent. get_doc orders url, title, height, omits absent keys, then writes a blank line and the caption as inline Markdown. It also returns read-only \`figma: {kind, file, fileName?, node?}\`: kind is frame for design/file with node-id, otherwise file; proto gives prototype, then board, slides or community file. The optional fileName is percent-decoded with dashes read as spaces; node changes \`12-345\` or \`12%3A345\` to \`12:345\`. The revision includes caption formatting.

Missing URL, unknown or duplicate keys, non-key header lines, unsupported paths and invalid height refuse before writing with \`invalid_figma\`. A non-Figma or HTTP link gives exactly \`figma blocks take figma.com links only; use a plain link for other sites\`. Markdown import retains invalid or unclosed containers as plain paragraph text, delimiters included. Export escapes caption and ordinary prose lines beginning \`:::\` with a backslash, and import restores them; adjacent containers stay separate.

The document model is flat: one list item is one block, nested to at most four levels (indent 0–3). Markdown import does not read continuation lines or nested block content inside a list item. Consecutive quote lines form one quote block. HTML comments are skipped on import. Frontmatter can carry document identity and metadata; without a frontmatter title, a leading level-1 heading becomes the title.

## MCP content writes

For ordinary blocks, \`text\` is plain text: inserting Markdown punctuation does not add inline formatting. Creation and insertion may supply explicit inline runs for prose. A table's text must be exactly one GFM table and writes its parsed cell formatting. Card and figma text is the content between its container delimiters, including create_doc seeds. get_doc exposes canonical table GFM, card content and Figma content; their revisions include inline formatting, while prose revisions ignore marks. Prose document links also appear as character ranges in \`doc_links\`.

Table structural and multi-cell edits require \`table_mapping\` rows and columns; see \`edit_block\` for the full mapping contract. For prose carrying formatting, text splices can re-anchor a mark when a changed range touches its edge. See \`edit_block\` before changing a marked span and verify the result with \`export_markdown\`.

Card edits splice only changed parts and characters, preserving unchanged buttons, their appearances and order, marks and comment anchors. Remove a button header line to remove that button. A card's rev includes every button's text, destination, style, color and order. The entire button list syncs as one atomic value, so concurrent button edits may overwrite each other without mixing text and destinations. Approval counts button text in order but excludes destinations, styles and colors. Prose card links count toward backlinks. Open card comments in the web editor: MCP \`annotate\` refuses new card anchors but accepts replies, resolution and reopening by thread_id. \`link_range\` refuses cards; write prose links as inline Markdown in their text. Returned annotation ranges name the card part.

Figma header edits update only changed URL, title or height fields, and caption edits preserve marks and comment anchors on unchanged characters. New caption document-link targets must be known locally; caption links count toward backlinks. Conversions to or from figma, like card, are refused. MCP \`annotate\` refuses opening a Figma thread with \`annotation_figma\`, while existing threads accept replies, resolution and reopening. Their get_doc ranges name \`part: "caption"\` and count caption characters. \`link_range\` refuses Figma blocks; write caption links through inline Markdown. The web editor keeps documents containing figma read-only with an unsupported-block fallback until its viewer is available.

## Export

\`export_markdown\` renders each block and its supported inline marks. Fenced source blocks retain their source. The default frontmatter carries UUID, title, tags, optional description and lifecycle fields. Pass \`frontmatter: false\` to omit it. Comments are dropped by default; \`annotations: "html-comments"\` exports anchored threads as HTML comments, which Markdown import does not restore.

The decision log of any regular page is exported as a derived topic summary, not restorable directory relationships. Structured record data is omitted and the export states that omission; chart mappings remain ordinary exported content. Markdown is a readable projection rather than a backup of datasets, lifecycle relationships, comment anchors or CRDT history.

## Related

[Workspaces and documents](uberblick://help/workspaces) · [Structured data](uberblick://help/data) · [edit_block](uberblick://help/edit_block) · [export_markdown](uberblick://help/export_markdown)`;

const ablauf = `# Ablauf diagrams

You choose placement; the renderer sizes and draws without moving nodes or
rerouting edges. In Uberblick, write the source in an \`ablauf\` fenced code block.
Import, export and MCP preserve its literal source.

## Flow syntax and nodes

Start with \`flow v0\`, then \`columns\` naming columns left to right, once,
before nodes. Declarations occupy one line. Blank lines and whole-line
\`#\` comments are allowed. Keep declarations unindented; indent panel
children and legend entries two spaces. Use each key once per line.

Nodes: \`kind unique-id "text" key=value\`.
Double quotes group spaces, including \`title="Readable title"\`; strings
have no escape syntax. Use typographic quotes inside them; backslashes are
literal. Edge labels are unquoted text after the colon.

| Kind | Meaning of text | Default tone |
| --- | --- | --- |
| \`text\` | caption | \`muted\` |
| \`pill\` | dotted label | \`muted\` |
| \`box\` | subtitle; id supplies title | \`agent\` |
| \`end\` | final caption | \`done\` |
| \`panel\` | indented children only | \`stop\` |
| \`decision\` | question over a diamond | \`neutral\` |

Omitted text uses the id, except boxes have no subtitle; panels show only
children. \`title=\` overrides
the visible title; outside boxes, use it instead of quoted text. Use readable
box titles; subtitles should add information.
Panel children: \`pill\`, \`text\`, \`muted\`, \`strong\` followed by text, or
\`rule\` alone.

\`tone=\` accepts \`ink\`, \`muted\`, \`neutral\`, \`agent\`, \`system\`, \`done\`, \`rework\`,
\`stop\` on nodes, edges and legend entries. Neutral gives grey fills; ink and
muted keep surface fills. System suits automated steps, agent suits workers,
done success, rework retries and stop human intervention.

## Layout and edges

Rows follow **node declaration order**. Each node starts the next row unless
\`row=other-id\` joins another node's row. \`col=name\` selects a column; omission
inherits the **previously declared node's column**. The first node needs
\`col=\`. \`span=N\` covers N
rows downwards (default 1). \`section "Title"\` starts a band for following
nodes; give every section nodes. \`gap=60\` requests a minimum 60px gap after
the node's last covered row, across all columns; use non-negative whole
pixels and omit it on the final row.

Edges: \`a --> b key=value : label\`; \`-.->\` is dashed. Label and keys
are optional: \`tone=\` (default \`ink\`), \`from=\`, \`to=\`, \`label=\`.
Sides are \`top\`, \`right\`, \`bottom\`, \`left\`. Defaults: same column uses
bottom-to-top; overlapping rows use facing sides; otherwise leave toward
the target's column and enter its top or bottom.

Slots such as \`to=top.1\` count left-to-right on top/bottom, top-to-bottom on
left/right. Leave both ends of a same-column bottom-to-top main edge
unnumbered to keep it centred; other entries use off-centre slots.
Unnumbered entries use available slots in source order, favouring the side
facing their other node when a main edge reserves the centre.
Decisions have one midpoint port per side: omit slot numbers.

\`label=start\` (default) sits beside the source segment; \`label=end\` beside
the target segment. \`label=inline\` makes a gap on the longest segment; use
it for decision answers.

\`\`\`ablauf
flow v0
columns main stop
text start col=main "A maintainer starts"
pill ready
box work title="Do work" "Prepare the change"
decision approved "Is it approved?"
end shipped "Shipped"
panel human col=stop row=work span=2
  pill needs-human
  muted "Waiting for approval"
  rule
  strong "A person decides"
  text "Continue when ready"

start --> ready
ready --> work
work --> approved
approved --> shipped label=inline : yes
approved --> human tone=stop label=inline : no

legend
  pill "status" sample=ready
  box "worker"
  panel tone=stop "human intervention"
\`\`\`

One \`legend\` has indented \`pill\`, \`box\`, \`end\`, \`panel\`, \`decision\`, \`edge\`
or \`dashed\` entries: kind, optional \`tone=\`, required quoted meaning.
Defaults match nodes; line samples default to ink. Shape entries additionally
accept non-empty \`sample=ready\` or \`sample="two words"\` for text inside them.

## Editing a diagram

- Insert between \`a\` and \`b\`: declare the new node after \`a\`, before \`b\`
  in row order. Replace \`a --> b\` with \`a --> new\` and \`new --> b\`.
  Deliberately preserve or redirect every other connection.
- Remove a step: delete its declaration and incident edges, reconnect its
  predecessor and successor, and update references to its id, including \`row=\`.
- Put a branch beside its source with explicit \`col=side row=source\`.
  Reset the next declaration's \`col=\` if needed.
- Add a column by editing \`columns\`; put its node in an
  existing row with \`col=new-column row=existing-id\`, then connect those ids.
- Order shared-side slots spatially: nearer branches take slots nearer
  the main path. On a shared right side, put an upward edge at \`right.1\`,
  a horizontal branch at \`right.2\`.
- After inserting/removing rows, review every affected \`span=\` count to
  preserve its intended coverage.

## Making it look good

Keep main paths downward in one column and branches beside their sources.
Span shared stop panels across incoming rows. Keep labels short;
choose start/end/inline to leave room. Trace all routes before adding a
branch, including existing edges to farther columns; choose sides and slot
order so nested branches and returns avoid crossings.

Common fixes: correct unknown ids/columns; remove duplicate
nodes in a cell; shorten overlapping labels or move them with \`label=\`;
increase \`gap=\` for cramped vertical labels; change sides, slots or placement
for edges crossing nodes or edges. A visible crossing gap still needs fixing.

After every edit, check the drawing in the web editor. MCP does not return the
renderer's diagnostics; the editor lists them with source lines below the drawing.
Inspect the drawing for crossings as well as fixing reported problems.

## Fan-out

\`\`\`ablauf
fan-out v0
style branches
step "Record the result"
outcome "Success" reason="Checks passed" destination="Review" tone="done"
outcome "Blocked" reason="A decision is needed" destination="Ask a person" tone="stop"
\`\`\`

Declare one non-empty \`step\`, then at least one outcome with required
non-empty text, \`reason=\` and \`destination=\`; optional \`tone=\` accepts every
flow tone, defaulting to a plain box. Fields may appear in any order, once
each. All values are double-quoted JSON strings: escape quotes as \`\\"\`,
backslashes as \`\\\\\`. Indentation is optional; blank lines and whole-line
comments work. There are no ids, authored edges or placement keys;
destinations are text. Outcomes stay in source order even with
matching destinations. Before the step, choose \`style branches\` (default:
step left, branches to outcomes, arrows to destinations with reasons below)
or \`style ladder\` (step above, rail of dots, reasons below outcomes,
destinations right-aligned, no arrows).

[Full Ablauf authoring primer](https://github.com/uberblick-ai/ablauf/blob/v0.2.0/spike/PRIMER.md)`;

const wireframe = `# Wireframes

A wireframe is a static UI sketch that the web editor draws from a fenced code block whose info string is exactly \`wireframe\`. This topic follows Format v0.1 of \`@uberblick/wireframe\` 0.3.0. Import, export and MCP keep the source as a code block with language \`wireframe\`. Nothing else goes on the fence line.

\`\`\`wireframe
dialog Delete “Q3 launch draft”?
  text It will be gone for everyone, with its comments and history. This can't be undone.
  row.end
    button.focus Cancel
    button.danger Delete
\`\`\`

## Lines

Each line is one node: \`kind.variant#id key=value Label\`.

- **kind** is the first word, from the table below. Variants are dot classes and combine: \`button.link.danger\`. An optional \`#id\` comes last in the first word and does not change the drawing.
- **Attributes** sit between the first word and the label: \`label=\` on \`input\` and \`select\`, such as \`label="Work email"\`, and \`width=\` on \`page\`, \`card\` and \`image\`, in whole CSS pixels from 1 to 9999: \`width=256\`.
- **The label** is the rest of the line. Only \`text\` lines format anything: paired single backticks draw monospace. Other Markdown shows as written, and typographic quotes are plain text.
- **Quote a label** only when it starts with \`word=\` or with \`"\`. Quote all of it, escape \`"\` as \`\\"\` and \`\\\` as \`\\\\\`, and end the line at the closing quote.
- **Indent** a child by exactly two spaces more than its parent, with spaces only. The first line has none. Blank lines are skipped but count as lines, and several roots draw one after another.
- **Limits:** 64,000 characters, 200 lines and 8 levels.

## Kinds

Roots stand at the top level: \`dialog\`, whose label is its title; \`banner\` with \`.neutral\`, \`.info\`, \`.warning\`, \`.danger\` or \`.success\`; \`page\` and \`phone\`, which take no label, so their title goes on a \`text.title\` line; and \`frame\`, whose label is a caption and whose direct buttons sit in that caption row. A \`card\` may also stand at the top level.

| Kind | Directly inside | Variants | Label |
| --- | --- | --- | --- |
| \`text\` | root, dock, card, row | \`.muted\`, \`.strong\`, \`.title\`, \`.small\`, \`.red\`, \`.amber\`, \`.green\`, \`.blue\` | the text |
| \`row\` | root, dock, card, table | one of \`.end\`, \`.between\`, \`.scroll\`; \`.head\` for a table's header row | none |
| \`card\` | top level, root, dock, row | none; optional \`width=\` | none: it holds text, images and rows |
| \`image\` | root, dock, card, row | \`.square\`, \`.round\`; optional \`width=\` | what it shows |
| \`button\` | row, cell, frame | \`.primary\`, \`.danger\`, \`.link\`, \`.focus\` | the caption, or none when it holds an icon |
| \`icon\` | root, dock, cell, button, option | \`.filled\` and the four colours | an exact kebab-case Tabler name, such as \`pin\` or \`dots-vertical\` |
| \`input\`, \`select\` | root, dock, row | none; optional \`label=\` | the placeholder, or the chosen value |
| \`toggle\` | root, dock, row | none | none: its choices are \`option\` lines, \`.current\` for the chosen one |
| \`table\` | root, dock | none | none: its rows hold only \`cell\` lines |
| \`cell\` | a table's row | \`.end\`; on header cells \`.sortable\`, \`.ascending\` or \`.descending\` | its text, or none |
| \`chip\` | row, cell | \`.more\` for the count of the rest | the tag |
| \`divider\` | dialog, page, frame, phone, dock | none | none |
| \`dock\` | a phone, as its last child | none | none |

Write \`icon.filled pin\`, not \`pin-filled\`. Use one colour per node and pair a coloured state with words. Give every table row the same number of cells, with an empty \`cell\` where a column has nothing.

\`\`\`wireframe
page
  text.title All documents
  input Search titles
  row
    toggle
      option.current Documents
      option Decisions
    select label=Tag Any tag
  table
    row.head
      cell.ascending Title
      cell.end Changed
      cell
    row
      cell Web UI system
      cell.end 2 hours ago
      cell
        button.link
          icon pin
  row.end
    text.muted 1–10 of 24
    button Previous
    button.primary Next
\`\`\`

\`\`\`wireframe
banner.warning
  icon archive
  text Archived. Read-only and hidden from the document list.
  row.end
    button Restore
    button.link.danger Delete…
\`\`\`

## Checking a wireframe

Errors stop the drawing: tabs or odd indentation, a jump of more than one level, an indented first line, an unterminated quote, text after a closing quote, or an exceeded limit. Warnings still draw, but the block no longer says what you meant: an unknown kind, variant, attribute or icon, a label on a kind that takes none, or a node in the wrong place. The usual misplacements are a \`button\` outside a \`row\`, \`cell\` or \`frame\`, anything but a \`cell\` in a table's row, and a root inside another node. Fix both.

MCP stores the source without checking it. The web editor lists each diagnostic with its line number. When nobody can open the editor, keep to the kinds and places above and report the wireframe as unchecked. The full primer, with every kind's drawing, phones, docks and each mistake with its diagnostic, ships as \`AUTHORING.md\` in \`@uberblick/wireframe\` 0.3.0.`;

const data = `# Structured data and views

A document can own named collections beside its prose. Each collection has one schema and identified whole JSON-object records. Collection names and record ids are non-empty well-formed Unicode strings; ids are unique within a collection and ordered by Unicode code point. Different collections and records merge independently, with eventual consistency and competing-write loss rather than distributed atomicity or compare-and-swap.

## Deliberate reads and validated updates

\`get_doc\` reports collection names and record counts without schemas or values. \`get_data({uuid})\` returns an area summary, or \`data: null\` when no data exists. Add \`collection\` to read its stored schema, validity, diagnostics and a detached page of records. Use \`limit: 0\` for the schema only. Unknown collections are refused and direct the caller to the summary read.

\`after\` is an exclusive id cursor. \`limit\` defaults to 100 and is at most 1,000; \`max_bytes\` defaults to 65,536 and is at most 1,048,576. An optional \`ids\` filter accepts at most 1,000 ids and reports missing ids. The byte budget measures canonical UTF-8 JSON of the page's id/value array, excluding schemas, diagnostics and response formatting. With a positive limit, the first remaining record is included even when it exceeds that budget. Follow \`next_after\` until \`complete\`; live pages are not snapshots and traverse each record once only while the data stays unchanged. Invalid merged data stays visible with diagnostics; reads neither repair nor discard it.

For an earlier state, pass \`revision\`, a hub revision ID returned by \`list_revisions\`, to \`get_data\`. It uses the same summary and bounded collection paging from that revision, including for archived documents. Keep the same revision on every page; an open revision can still change between calls. An unavailable revision refuses rather than falling back to live data. \`get_revision\` returns the same area summary beside the revision's title and blocks. Hub revision IDs differ from \`get_doc\`'s page and block \`rev\` content hashes, and writing tools do not accept them.

\`update_data\` takes one validated batch, naming each touched collection once. For each collection it sets \`schema\`, optionally \`replaceRecords\`, then applies \`deleteRecords\` and \`upsert\` whole id/value records. \`deleteCollection: true\` excludes other changes. Every retained record must satisfy the resulting schema before the batch commits in one local transaction. An identical refresh returns \`changed: false\` and emits no update. Keep producer records and human dispositions in separate collections, sharing ids by convention. The decided-answer lock is in \`decisions\` and the archive lock in \`archive_doc\`; durability is in \`tool-contracts\`.

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

A \`chart\` block holds editable JSON source, configured with ordinary \`create_doc\`, \`insert_block\` or \`edit_block\` calls. A line chart, bar chart or data table reads a collection from its own document. Its mapping names literal top-level fields; it contains no record values:

\`\`\`json
{"version":1,"type":"line","collection":"observations","x":{"field":"day","type":"date"},"y":[{"field":"count","label":"Count"}],"missing":"gap"}
\`\`\`

Mapping fields are version 1, type line, collection, x with field and type number or date (optional label), and one to eight numeric y series with field (optional label and unit). Optional y series type is line or bar, default line. Bars-only charts keep top-level type line and draw grouped bars from zero. In overlay, a mixed chart draws its bars behind its lines on a separate right-hand value axis. Optional title and missing gap or connect control presentation; gap is the default. Optional layout is overlay or panels, default overlay. panels draws one compact line or bar chart per y series in mapping order, in a responsive grid; each panel shows its label and latest plotted value. Panels share the x range and share y ranges within each unit group. layout is invalid for table mappings. Each y series optionally accepts range [min, max], exactly two finite numbers with min lower than max, and reference, one finite number. In overlay, both apply to the series' left or right value axis. In panels, range applies to the series' unit group and reference draws only on that series' own panel. A range is a minimum span: the axis covers every declared range, and plotted or reference values outside it widen the axis. A declared range replaces the zero-baseline rule for line-only axes and panel unit groups. Axes and panel unit groups containing bars always include zero. A reference draws a horizontal line across the plot; each distinct reference value appears once per axis or panel. A panel's reference value also widens its unit group's shared range. range and reference are invalid on x and in table mappings. Optional limit is an integer of 1 or more and selects the latest N records with a valid x in x-then-record-id order, still at most 5,000. A numeric x is finite; a date x is an ISO date-only string or an RFC 3339 date-time string with an explicit timezone. Date-only values are UTC days. Charts sort by x then record id, never coerce or aggregate values, omit schema-invalid records and report omissions. Missing/null y values break a line series under gap and bridge under connect; wrong types remain gaps. Missing, null or wrong-type bar values draw no bar. At most the latest 5,000 eligible x records are plotted.

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

[get_data](uberblick://help/get_data) · [update_data](uberblick://help/update_data) · [Decision records](uberblick://help/decisions) · [Tool contracts](uberblick://help/tool-contracts) · [Supported Markdown](uberblick://help/markdown)`;

const toolContracts = `# Shared tool contracts

## Arguments and results

Every registered tool declares its input and output schemas. Input objects accept only declared fields; unknown or misspelled fields and mixed action shapes are refused before the handler runs. Successful results carry \`structuredContent\` and a text block containing the same JSON. Server-produced result objects are closed: an undeclared key, missing required field or wrong type yields a text-only \`internal_error\`, with mismatch detail on server stderr. Caller-stored schemas and record values are passed through without normalization, and data diagnostics remain free-form.

## Failures and recovery

${FAILURE_INSTRUCTIONS}

Failures are marked \`isError: true\` and omit structuredContent, so success-schema validation does not misinterpret a failure. A call started after shutdown begins is refused with \`server_shutting_down\`; begin a new MCP session before repeating that call. A persistence failure quarantines the replica until restart: ordinary workspace reads also refuse rather than returning state ahead of its durable log. A workspace removed from this computer refuses with \`workspace_removed\`; writes report \`applied: false\`. Fetching a new copy does not revive the old session: restart the MCP server to use it. The diagnostic tool sync_status still answers. Static help reads and get_help remain available because they do not open or settle replicas.

\`list_revisions\`, \`get_revision\` and \`get_data\` with \`revision\` read history from the hub, never from the local replica. An unknown document UUID refuses with \`doc_not_found\` before any hub request; permanent deletion refuses with \`doc_deleted\`. History failures keep these specific codes and recoveries:

| Code | Recovery |
| --- | --- |
| \`revisions_local_only\` | Use a team-hub workspace; local-only workspaces have no hub history. |
| \`revisions_unreachable\` | Restore the hub connection, then retry the same read; sync_status reports the connection state. |
| \`revisions_sign_in_required\` | Run ub auth login, restart the MCP server, then repeat the read. |
| \`revisions_forbidden\` | Ask a workspace maintainer to grant read access before repeating the read. |
| \`revisions_unsupported\` | Ask the hub operator to update to a version that serves automatic revisions. |
| \`revision_not_found\` | List this document's revisions again and select an ID belonging to it. |

An empty history is returned only when the hub confirms it has no revisions. Archived documents remain readable.

Unknown help topics through get_help are manual refusals and name all valid topic ids. An unknown \`uberblick://help/{topic}\` resource raises JSON-RPC resource-not-found error -32002 naming its URI. Help is built in and version matched; no workspace document, tag or guidance content supplies it.

## Write durability and synced

Successful writes report \`applied\`, \`synced\` and \`hub\`. Applied means this server's local update log holds the write. Hub describes the connection, not remote storage. Calls touching multiple rooms report each room independently; aggregate synced is true only when every touched room is acknowledged. There is no rollback or cross-room remote atomicity.

\`synced: true\` means the hub acknowledged this update: it is in the hub's memory, and a healthy hub has scheduled the write on its store debounce — by default 2s after the last change to the document, 10s at the outside. It does NOT mean the hub has stored it: the write is still ahead of the hub's disk, and the store itself can fail. A hub that dies abruptly inside that window (SIGKILL, a crash, power loss) loses its volatile copy of the update. That is recoverable rather than fatal: \`applied: true\` is the durable half — this server's append-only update log holds the write before the tool returns and re-sends it on reconnect — so losing it for good takes the crash plus no replica holding that update ever coming back.

## Related

[Decision records](uberblick://help/decisions) · [Workspaces and metadata](uberblick://help/workspaces) · [Structured data](uberblick://help/data) · [sync_status](uberblick://help/sync_status)`;

/** One owner for each shared contract; per-tool pages link to these topics. */
export const conceptTopics: readonly HelpTopic[] = [
  {
    id: "orientation",
    title: "Startup orientation",
    description: "Brief starting directions and how to discover deeper version-matched product help.",
    text: STARTUP_ORIENTATION,
  },
  {
    id: "edit_doc",
    title: "Editing documents",
    description: "One short entry point before creating or changing a document: regular page or decision record, the read-and-edit loop and Markdown essentials.",
    text: editDoc,
  },
  {
    id: "workspaces",
    title: "Workspaces and documents",
    description: "Workspace selection, document and block identities, metadata, links, tags and sidebar organization.",
    text: workspaces,
  },
  {
    id: "decisions",
    title: "Decision records",
    description: "When to create a decision record, writing the short answer, status changes and recorded answers, successors, RFC discussion and reading topics.",
    text: decisions,
  },
  {
    id: "markdown",
    title: "Supported Markdown",
    description: "Supported block and inline syntax, tables, content writes and Markdown export behavior.",
    text: markdown,
  },
  {
    id: "ablauf",
    title: "Ablauf diagrams",
    description: "Reading, writing and editing flow and fan-out diagrams: placement, nodes, edges, legends and editing recipes.",
    text: ablauf,
  },
  {
    id: "wireframe",
    title: "Wireframes",
    description: "Writing wireframe blocks: line syntax, kinds and where they go, quoting, examples and checking a block without the web editor.",
    text: wireframe,
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
    description: "Arguments and results, failure recovery, local write durability and synced.",
    text: toolContracts,
  },
];

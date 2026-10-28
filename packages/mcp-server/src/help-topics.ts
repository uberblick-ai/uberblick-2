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

Start with \`get_sidebar({})\` for curated entry points, \`list_docs({})\` for discovery, or \`search({query: "release plan"})\` for relevant content. Read a discovered UUID with \`get_doc\` before changing it. A document's UUID is its identity; its title is display text. Blocks have their own ids, types, text and revisions. Edit one block against the returned \`old_text\` and \`rev\`; whole-document restoration is available only through \`restore_revision\` with a hub revision ID. A revision checks this replica's current content at call time and is not a distributed lock. Read \`markdown\` for block syntax and \`data\` for dedicated collection reads.

## Metadata

- \`title\` names the document. MCP creation requires a non-empty title and description; \`set_metadata\` with \`title\` repairs untitled documents.
- \`description\` is read only by agents and never shown to people. Write whatever best helps an agent find this document with list_docs and search and decide whether to open it: what it covers, how it differs from its neighbours and the terms someone would search for. A keyword list is fine. list_docs, search and backlinks all answer with it, so a good one saves a get_doc and a bad one wastes it. At most ${MAX_DESCRIPTION_LENGTH} characters.
- \`tldr\` is one or two sentences of plain English for a person opening a regular document, independent of its description. \`set_metadata\` accepts up to ${MAX_TLDR_LENGTH} characters for it, refuses empty or whitespace-only strings, and accepts null to clear it. A person can choose Remove TL;DR from the web's Document actions to clear the summary and mark the page as having none on purpose. Marked pages return \`tldr: null\` and \`tldrOptOut: true\` only in \`get_doc\`, and content writes omit TL;DR hints. A non-null summary on a marked page refuses with \`tldr_opted_out\` and \`field: "tldr"\` unless \`set_metadata\` passes \`tldr_opt_in: true\` in the same call. The flag requires a non-null \`tldr\`; writing it lifts the mark. Null preserves the mark. The web's Add TL;DR lifts it before editing, even if editing is cancelled. Summary text takes precedence over the mark after concurrent or older-client writes. MCP cannot set the mark. Decisions have no TL;DR: they use answer blocks, return \`tldr: null\`, omit it from directory entries and never report the mark. Ordinary stubs, search and Markdown do not carry TL;DR or the mark. Content writes to an unmarked regular page with a TL;DR return \`tldrHint\`: "${TLDR_AFTER_CONTENT_CHANGE}" A create_doc call that supplies \`tldr\` returns none.
- \`tags\` store stable catalog ids. Read \`list_tags\` and check \`complete\` before choosing existing ids or names (case ignored); descriptions guide LLMs on when to apply a tag. Reuse existing meanings and keep a small vocabulary of lasting, reusable subjects or purposes. Avoid synonyms and one-off task, file, issue or version tags. Apply only tags that improve discovery; leaving a document untagged is valid. \`create_tag\` creates a missing category or reuses an existing normalized name without changing its description; \`edit_tag\` explicitly replaces or clears an existing tag's description. Both retain Workspace settings' authority and offline recovery, and neither changes document assignments. Document reads show only existing catalog tags. \`set_metadata\` with \`tags\` replaces existing-tag assignments; an empty array clears those assignments. References another replica wrote before their catalog entry arrived stay stored and hidden, but a tag this replica's catalog lacks is refused in every write and filter; confirmed-deleted references are cleaned only during later permitted document writes. \`list_tags\` reports \`complete: false\` until the catalog arrives from a configured hub: an unseen name is not evidence of a missing category. Creating then can converge with an unseen tag or recreate a name deleted elsewhere; see \`create_tag\` help.
- Curated \`links\` are target document UUIDs, replaced by \`set_metadata\` with \`links\`; an empty array clears them. Newly added targets must be known to this replica's directory, archived targets are accepted, and existing curated targets can be retained unchanged. Inline document references also contribute backlinks. Decision-derived links and decision metadata are explained in \`decisions\`.
- \`code_check\` records a regular page's latest comparison with code per repository. \`set_metadata\` takes one \`{repository, commit, result, rev, paths?}\` entry: \`matches\` means agreement with the commit, \`ahead\` means intentionally undelivered behavior, and \`drift\` means unintended disagreement. \`rev\` must match the page-level revision read with \`get_doc\`, the same value the web status row shows for regular pages and decisions. Missing or stale rev refuses the whole call with \`field: "code_check"\`: read the page again and compare it with code before recording, rather than just resending with a new rev. Optional \`paths\` are hints about repo-relative files/folders looked at, not a complete dependency list; see \`set_metadata\` help for limits. Repository identity ignores case; the writing replica supplies \`checked_at\` in UTC. Only that repository's entry is replaced. \`get_doc\` returns the entries or [], with recorded rev and paths when present; earlier entries and older-client rewrites can omit them, making compared text or paths unknown. list_docs does not return checks. Decisions omit the attribute and refuse writes to it. Content edits and other metadata writes leave it unchanged; blocks and Markdown export never carry it.

\`set_metadata\` accepts any non-empty subset of these fields and leaves unnamed fields untouched. All named fields are validated before any write; a field-specific refusal preserves its error code and names \`field\`. Title and description cannot be cleared. Its successful answer returns the descriptive metadata as get_doc would read it, with shared write durability and no TL;DR review reminder. Open decision records additionally accept \`discussion\`, as explained in \`decisions\`.

Reads return absent description and TL;DR as null. Document writes can return non-blocking hints for a missing description, missing tags or a TL;DR needing review. Decision metadata and the decided-answer lock belong to \`decisions\`, the archive lock to \`archive_doc\`; write durability belongs to \`tool-contracts\`.

## Sidebar organization

The sidebar holds ordered named groups and pinned document UUIDs. Unpinned documents remain discoverable through listings, search, links and backlinks. \`get_sidebar\` and \`sidebar_group\` return the whole sidebar: ordered \`groups\` with \`id\`, \`name\` and ordered \`docs\`. \`pin_doc\` answers with the pin's group and \`unpin_doc\` with whether a pin was removed; unpinning a group's last document leaves the group empty, and the answer's \`groupHint\` names the \`sidebar_group\` delete that removes it. Pinned titles come from directory stubs without opening document rooms. A pin's status is \`ok\`, \`archived\` (the document is tombstoned but still pinned — archive_doc unpins, so this pin outlived the archive), or \`unknown\` (no directory entry at all — a document nothing can resolve, left visible so it can be unpinned).

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
- \`insert_block\` adds blocks after a block id, or at the top. \`edit_block\` changes one block against the \`old_text\` and \`rev\` you read. \`move_block\` reorders existing blocks with their ids and comment anchors intact; read its help for the concurrent-edit limit. \`delete_block\` removes one. \`restore_revision\` is the whole-document exception: it restores title, blocks and data from a hub revision as a new revision, preserving history and other metadata.
- Documents merge live (Yjs): people and other agents may edit at the same time and watch your changes. Change only the words that need changing; \`edit_block\` keeps everyone else's edits and comment anchors, while deleting and re-inserting a block drops them. Keep the page's overall shape; reshape a section when needed instead of lengthening a paragraph.
- A refused edit returns \`currentText\` and \`currentRev\`: apply your change to them and retry, without another read.
- \`set_metadata\` changes title, description, tags, links and TL;DR, a regular page's code check and an open decision's \`discussion\`. Structured data uses \`get_data\` and \`update_data\`.

## Markdown essentials

- One block per paragraph, heading, list item, quote, callout, code fence or table. Lists are flat: \`indent\` 0–3.
- Write \`---\` with a blank line above it for a divider, or use \`type: "divider"\` with empty text over MCP. Text directly above \`---\` becomes a level-2 heading.
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

- State the decision itself in one plain sentence naming the chosen option, without hedging such as "should consider" and without reasoning. Reasoning, alternatives and process go in a linked RFC; product detail goes on the owning regular page.
- Keep it very short; that matters more than the block count. Aim for 60 words of prose or fewer; this is editorial guidance, not a validated limit. MCP accepts at most three answer blocks: paragraphs, code blocks (a short ablauf diagram can show the decision), tables or lists (adjacent list items count as one). Other block types refuse.
- Short is not vague: keep the concrete terms needed to apply the decision. Do not restate the topic or write a specification.
- Decisions have no TL;DR, and a decided record holds no structured data.

## Status changes

- \`create_doc\` with \`kind: "decision"\` creates an open record, or a decided one with its answer. \`set_status\` moves it later, or turns an ordinary page into a decision record.
- An open record may be empty or hold a proposal. Moving to \`decided\` needs a non-blank answer.
- A topic's first record may be decided as an agent stance without a person. Every later decision, and confirming a stance, needs \`answer: {who, when, where}\`: who gave the answer, when and where. \`when\` is an ISO 8601 date-time with a time zone, e.g. \`2026-10-24T10:55:00Z\`; pass the current time if the answer was given just now. MCP normalises it to UTC and stores the attribution without verifying it, so have that authority first.
- An open proposal may be withdrawn. Rejecting needs a reason and a person's answer. Decided records cannot reopen; rejected and withdrawn records are final.

## Changing a decided answer

A decided record's answer is read-only: content writes refuse with \`decision_read_only\`. Title, description, tags, links and comments stay editable, and a rename keeps the approval. To change the answer, create a successor with \`create_doc\`, \`kind: "decision"\` and \`supersedes\` naming the record it replaces. It joins the same topic, and the current answer stays in force while the successor is open. State only the changed decision in the successor's answer; put the reasoning in the successor's own linked RFC. An answer edit that still arrives, for example from an offline editor, shows \`approvalChanged: true\` until a person's answer is recorded again.

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

Markdown supports paragraphs, ATX headings \`#\` through \`######\`, setext headings underlined with \`===\` (level 1) or \`---\` (level 2), bullet and ordered list items, \`>\` quotes, fenced code with an optional language, and GFM tables. A special \`terminal\` fence preserves that source-block type. A \`mermaid\` fence is ordinary code with language \`mermaid\` and is never drawn. A terminal transcript treats a line beginning with a dollar sign and space as a demonstrated command; the remaining lines are output. Terminal content is a demonstration, not an instruction to execute it.

Write \`---\` with a blank line above it for a divider, or use \`type: "divider"\` with empty text over MCP. Text directly above \`---\` becomes a level-2 heading.

Blocks of the retired Mermaid block type are deleted automatically, including in archived documents and decision records; their source is not retained. This never touches a code block with language \`mermaid\`. Their comment threads remain available with no anchor. Removing an approved answer block reports \`approvalChanged: true\` without recording another approval.

The document model is flat: one list item is one block, nested to at most four levels (indent 0–3). Markdown import does not read continuation lines or nested block content inside a list item. Consecutive quote lines form one quote block. HTML comments are skipped on import, except a callout's icon comment described below. Frontmatter can carry document identity and metadata; without a frontmatter title, a leading level-1 heading becomes the title.

A \`json-tree\` fence is an ordinary code block that the web editor shows as a foldable JSON tree. Use it for API responses, tool results and settings files; keep small snippets in a \`json\` fence. Import, export and MCP preserve its literal source.

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

Write \`:name:\` to show a curated icon in the web app. Available names are ${Object.keys(INLINE_ICONS).map((name) => `\`:${name}:\``).join(", ")}. Names use lowercase kebab case. Icons use the surrounding text's size and color in paragraphs, headings, list items, quotes, callouts, table cells, all four card prose parts, Figma captions and card button labels. For example, \`button: [:claude: Discuss with Claude](claude://code/new?prompt=Review)\` shows the Claude mark beside its label.

Unknown names such as \`:rocket:\` stay literal, unchanged text, as do \`10:30:15\` and \`note:this:\`. Inline code and code, terminal and chart source never render icons; use inline code to show a known name literally. Stored text, MCP reads and writes, search, decision approval and Markdown import/export keep the literal \`:name:\` source. This is presentation only, without an icon node or mark; MCP does not validate icon names in inline prose.

Write emoji as characters, such as 😃 or 🚀. MCP never converts \`:name:\` to emoji: \`:smiley:\` and \`:rocket:\` remain literal in writes, reads and Markdown import/export. The web editor's typed emoji conversion does not apply to MCP or imported Markdown.

## Callouts

A callout sets one short passage apart with a label and an icon: \`note\`, \`tip\`, \`important\`, \`warning\` or \`caution\`. Write it as a quote whose first line is the marker alone:

    > [!WARNING]
    > Restarting the hub signs every browser out.

Import reads the marker in any case; export writes it in uppercase. The following quote lines are one prose body with inline marks; an empty \`>\` line separates paragraphs. Lists, code and nested quotes stay literal text. Any other \`[!WORD]\`, or text after the marker, keeps an ordinary quote.

Each variant has its own icon. To override it, put one HTML comment on the line after the marker: \`> <!-- icon: 🚀 -->\`. The value is one emoji character or a curated icon such as \`:claude:\`. Over MCP, use \`type: "callout"\` with \`variant\` and optional \`icon\`; \`edit_block\` takes either to change it, and an empty \`icon\` restores the default. Override the icon only when it says something the variant's own icon does not, such as the tool a tip is about.

Pick the variant by what happens if a reader skips it: note, missing context; tip, a better way; important, they will not succeed; warning, something breaks or work is lost; caution, an action cannot be undone. Write one to three sentences that stand alone, and do not begin with "Note:" or "Warning:", because the label says it. Use at most a couple per page, never two in a row, never for a whole section. A recommendation to act on belongs in a card; a lasting choice belongs in a decision record.

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

## Embeds

An embed is visual content the web draws from data stored in the document: a flow diagram, a UI sketch, a chart or a live Figma design. The data is written as a fenced block or as a \`:::\` container:

| Embed | Written as | Data |
| --- | --- | --- |
| Ablauf | \`ablauf\` fence | flow or fan-out source; see [Ablauf diagrams](uberblick://help/ablauf) |
| Wireframe | \`wireframe\` fence | wireframe-md source; see [Wireframes](uberblick://help/wireframe) |
| Chart or data table | \`chart\` fence | JSON mapping to the document's structured data; see [Structured data](uberblick://help/data) |
| Figma | \`:::figma\` container | link, title, height and caption |

Markdown and MCP keep an embed's data as text: ablauf and wireframe are code blocks with that language, a chart is its own \`chart\` block, and MCP reads and writes the source as the block's \`text\`. The web draws embeds. Chart-source writes also report what the mapping can draw from the document's current data, and ablauf and wireframe writes report the drawing's diagnostics; inspect appearance in the web editor.

### Figma

A \`:::figma\` container holds a required \`url\`, an optional plain one-line \`title\` and \`height\` (240–960 pixels, default 480), each at most once, then a blank line and an optional caption with inline formatting:

    :::figma
    url: https://www.figma.com/design/k3Lm9QzT2x/Checkout-flow?node-id=12-345
    title: Payment, mobile
    height: 560

    Card form after the **address** step.
    :::

The url is an HTTPS figma.com link to a design, file, prototype, board, slides or community file; Uberblick keeps only its file, name, node and version parts. Invalid headers, links or heights refuse with \`invalid_figma\` before writing, and a non-Figma link gets \`figma blocks take figma.com links only; use a plain link for other sites\`. get_doc returns the content plus read-only \`figma: {kind, file, fileName?, node?}\`. Nothing in MCP contacts Figma, so the title and caption carry the meaning. Invalid or unclosed containers import as plain paragraphs.

## MCP content writes

For ordinary blocks, \`text\` is plain text: inserting Markdown punctuation does not add inline formatting. Creation and insertion may supply explicit inline runs for prose. A table's text must be exactly one GFM table and writes its parsed cell formatting. Card and figma text is the content between its container delimiters, including create_doc seeds. get_doc exposes canonical table GFM, card content and Figma content; their revisions include inline formatting, while prose revisions ignore marks. Prose document links also appear as character ranges in \`doc_links\`.

Table structural and multi-cell edits require \`table_mapping\` rows and columns; see \`edit_block\` for the full mapping contract. For prose carrying formatting, text splices can re-anchor a mark when a changed range touches its edge. See \`edit_block\` before changing a marked span and verify the result with \`export_markdown\`.

Card edits splice only changed parts and characters, preserving unchanged buttons, their appearances and order, marks and comment anchors. Remove a button header line to remove that button. A card's rev includes every button's text, destination, style, color and order. The entire button list syncs as one atomic value, so concurrent button edits may overwrite each other without mixing text and destinations. Approval counts button text in order but excludes destinations, styles and colors. Prose card links count toward backlinks. Open card comments in the web editor: MCP \`annotate\` refuses new card anchors but accepts replies, resolution and reopening by thread_id. \`link_range\` refuses cards; write prose links as inline Markdown in their text. Returned annotation ranges name the card part.

Figma header edits update only changed URL, title or height fields, and caption edits preserve marks and comment anchors on unchanged characters. New caption document-link targets must be known locally; caption links count toward backlinks. Conversions to or from figma, like card, are refused. MCP \`annotate\` refuses opening a Figma thread with \`annotation_figma\`, while existing threads accept replies, resolution and reopening. Their get_doc ranges name \`part: "caption"\` and count caption characters. \`link_range\` refuses Figma blocks; write caption links through inline Markdown. The web editor keeps documents containing figma read-only with an unsupported-block fallback until its viewer is available.

## Export

\`export_markdown\` renders each block and its supported inline marks. Fenced source blocks retain their source. The default frontmatter carries UUID, title, tags, optional description and lifecycle fields, but no TL;DR. Pass \`frontmatter: false\` to omit it. Document links export as \`[label](document-uuid)\`, which import reads back. Comments are dropped by default; \`annotations: "html-comments"\` exports anchored threads as HTML comments, which Markdown import does not restore.

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

Every create_doc, insert_block or edit_block that writes an \`ablauf\` code block
answers with a \`drawing\` summary for it: \`status\` \`clean\`, \`warnings\` or
\`errors\`, and the renderer's diagnostics with their source lines, the same list
the web editor shows below the drawing. Fix every diagnostic and write again.
The check never refuses the write. A clean source can still cross or crowd, so
inspect the drawing in the web editor when someone can open it.

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

A wireframe is a static UI sketch that the web editor draws from a fenced code block whose info string is exactly \`wireframe\`. This topic follows Format v0.1 of \`@uberblick/wireframe\` 0.3.2. Import, export and MCP keep the source as a code block with language \`wireframe\`. Nothing else goes on the fence line.

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
- **Attributes** sit between the first word and the label: \`label=\` on \`input\` and \`select\`, such as \`label="Work email"\`; \`width=\` on \`page\`, \`card\` and \`image\`, in whole CSS pixels from 1 to 9999: \`width=256\`; and \`padding=\` on \`card\`, in whole CSS pixels from 0 to 64: \`padding=8\`. Cards directly inside full-width rows also accept fractional widths such as \`width=1/3\`, described below.
- **The label** is the rest of the line. Only \`text\` lines format anything: paired single backticks draw monospace. Other Markdown shows as written, and typographic quotes are plain text.
- **Quote a label** only when it starts with \`word=\` or with \`"\`. Quote all of it, escape \`"\` as \`\\"\` and \`\\\` as \`\\\\\`, and end the line at the closing quote.
- **Indent** a child by exactly two spaces more than its parent, with spaces only. The first line has none. Blank lines are skipped but count as lines, and several roots draw one after another.
- **Limits:** 64,000 characters, 200 lines and 8 levels.

## Kinds

Roots stand at the top level: \`dialog\`, whose label is its title; \`banner\` with \`.neutral\`, \`.info\`, \`.warning\`, \`.danger\` or \`.success\`; \`page\` and \`phone\`, whose content title goes on a \`text.title\` line; and \`frame\`, whose label is a caption and whose direct buttons sit in that caption row. Plain \`page\` and \`phone\` take no label. \`page.browser\` uses its label as an address in a browser toolbar; \`page.window\` as the title in a macOS title bar. Choose one page variant; both keep the plain page's children and optional \`width=\`, with inert chrome. A \`card\` may also stand at the top level.

| Kind | Directly inside | Variants | Label |
| --- | --- | --- | --- |
| \`text\` | root, dock, card, row, item | \`.muted\`, \`.strong\`, \`.title\`, \`.small\`, \`.red\`, \`.amber\`, \`.green\`, \`.blue\`; backgrounds \`.bg-red\`, \`.bg-amber\`, \`.bg-green\`, \`.bg-blue\` | the text |
| \`row\` | root, dock, card, non-table row, table | one of \`.end\`, \`.between\`, \`.scroll\`, plus \`.stretch\`, only in roots, docks and cards; \`.head\` only in a table | none |
| \`card\` | top level, root, dock, non-table row | none; optional \`width=\` and \`padding=\` | none: it holds text, images, folds, items, rows, switches and tabs |
| \`image\` | root, dock, card, row, item | \`.square\`, \`.round\`; optional \`width=\`; only \`.round\` as an item's first child | what it shows |
| \`fold\` | root, dock, card | none | collapsed content's label, or none for an empty bar |
| \`item\` | root, card | \`.current\` | main line; child text lines and one optional leading icon or round image |
| \`ruler\` | last in a non-table row | none | none: holds marks |
| \`mark\` | ruler | \`.red\`, \`.green\`; warning by default; required \`at=0\` through \`at=100\` | none |
| \`button\` | row, cell, frame | \`.primary\`, \`.danger\`, \`.link\`, \`.focus\`, \`.disabled\` | the caption, or none when it holds an icon |
| \`icon\` | root, dock, cell, button, option, item | \`.filled\` and the four colours; only as an item's first child | an exact kebab-case Tabler name, such as \`pin\` or \`dots-vertical\` |
| \`input\`, \`select\` | root, dock, row | none; optional \`label=\` | the placeholder, or the chosen value |
| \`toggle\` | root, dock, row | none | none: its choices are \`option\` lines, \`.current\` for the chosen one |
| \`switch\` | root, dock, card, non-table row | \`.on\`; off by default | the caption, or none for a bare switch |
| \`tabs\` | root, card | none | none: its tabs are \`option\` lines |
| \`option\` | toggle, tabs | \`.current\` for the chosen one | the caption; may hold one icon |
| \`table\` | root, dock | none | none: its rows hold only \`cell\` lines |
| \`cell\` | a table's row | \`.end\`; on header cells \`.sortable\`, \`.ascending\` or \`.descending\` | its text, or none |
| \`chip\` | row, cell | \`.more\` for the count of the rest | the tag |
| \`divider\` | dialog, page, frame, phone, dock | none | none |
| \`dock\` | a phone, as its last child | none | none |

Write \`icon.filled pin\`, not \`pin-filled\`. Use one text or icon colour per node and pair a coloured state with words. Give every table row the same number of cells, with an empty \`cell\` where a column has nothing.

Plain rows nested in non-table rows group their children side by side as one content-width item. Row variants do not apply to these inner groups. \`row.stretch\` gives direct cards equal heights and aligns other children to the top; it combines with \`.end\` or \`.between\`, but competes with \`.scroll\` (first written wins). Fractional card widths use \`N/M\` with \`1 <= N <= M <= 9999\`, sharing the space left after gaps and fixed-width children. Their row must be directly inside a dialog, page, frame, phone, dock or card and must not scroll; banner rows and nested groups do not accept them. Unsized cards share what remains.

Switches show an inert on/off state; captions wrap beside the track. Tabs underline the first \`option.current\`; later current options warn. They do not change content. An overflowing tab strip scrolls inside the drawing and becomes one native keyboard stop with a visible focus ring; fitting strips and individual tabs add none. Text backgrounds use the existing danger, warning, success and info tints, respectively. Choose one background and one text colour independently; the background alone keeps ink text.

Folds are static dashed bars, not expand controls. Items stack their main line and child text; only the first direct \`item.current\` in each root or card is selected. An item's one optional icon or round image must come first. Disabled buttons combine with other button variants, mute the whole action and announce “unavailable”; they remain inert, without a role or focus target. Rulers and their marks are decorative and never scroll or accept input. A mark needs an integer \`at=\` from 0 to 100; an invalid or missing position warns and draws no mark. Folds and marks take no children.

\`\`\`wireframe
page.window width=720 Revision history
  row.stretch
    card width=1/3
      item.current Reviewed
        icon check
        text.small.muted 2 hours ago
      item Draft
        text.small.muted Yesterday
    card width=2/3
      text.title Goals
      fold 4 unchanged blocks · Steps, Checklist
      text.bg-green Added text
      row.end
        button.disabled Restore
    ruler
      mark.red at=0
      mark at=50
      mark.green at=100
\`\`\`

\`\`\`wireframe
page.browser app.example/documents
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
page.window width=720 Review settings
  tabs
    option.current General
    option Notifications
  row.stretch
    card width=1/3 padding=8
      text.title Display
      switch.on Collapse unchanged
      switch Show whitespace
      text.bg-blue Applies to this device.
    card width=2/3 padding=8
      row.between
        row
          text.strong Notifications
          text.small.muted Daily
        button.link Edit
      text.bg-green + Mentions included
      text.bg-amber Summary pending
      text.bg-red − Email disabled
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

Every create_doc, insert_block or edit_block that writes a \`wireframe\` code block answers with a \`drawing\` summary for it: \`status\` \`clean\`, \`warnings\` or \`errors\`, and the diagnostics with their line numbers, the same list the web editor shows. Fix every diagnostic and write again; the check never refuses the write. A source drawn as ASCII art is a list of unknown-kind warnings, not a wireframe. The [full authoring primer](https://github.com/uberblick-ai/wireframe-md/blob/v0.3.2/AUTHORING.md), with every kind's drawing, phones, docks and each mistake with its diagnostic, ships as \`AUTHORING.md\` in \`@uberblick/wireframe\` 0.3.2.`;

const data = `# Structured data and views

A document can own named collections beside its prose. Each collection has one schema and identified whole JSON-object records. Collection names and record ids are non-empty well-formed Unicode strings; ids are unique within a collection and ordered by Unicode code point. Different collections and records merge independently, with eventual consistency and competing-write loss rather than distributed atomicity or compare-and-swap.

## Deliberate reads and validated updates

\`get_doc\` reports collection names and record counts without schemas or values. \`get_data({uuid})\` returns an area summary, or \`data: null\` when no data exists. Add \`collection\` to read its stored schema, validity, diagnostics and a detached page of records. Use \`limit: 0\` for the schema only. Unknown collections are refused and direct the caller to the summary read.

\`after\` is an exclusive id cursor. \`limit\` defaults to 100 and is at most 1,000; \`max_bytes\` defaults to 65,536 and is at most 1,048,576. An optional \`ids\` filter accepts at most 1,000 ids and reports missing ids. The byte budget measures canonical UTF-8 JSON of the page's id/value array, excluding schemas, diagnostics and response formatting. With a positive limit, the first remaining record is included even when it exceeds that budget. Follow \`next_after\` until \`complete\`; live pages are not snapshots and traverse each record once only while the data stays unchanged. Invalid merged data stays visible with diagnostics; reads neither repair nor discard it.

For an earlier state, pass \`revision\`, a hub revision ID returned by \`list_revisions\`, to \`get_data\`. It uses the same summary and bounded collection paging from that revision's checksum-verified snapshot in this computer's history cache, including for archived documents. Missing snapshots download into the cache when connected within a bounded wait. Downloaded snapshots work offline. Historical results include \`history\` cache freshness; see \`list_revisions\`. Keep the same revision on every page; an open revision can still change between calls. A cursor does not retain an evicted snapshot: offline, a later page can report \`revisions_not_downloaded\`. An unavailable revision refuses rather than falling back to live data. \`get_revision\` returns the same area summary beside the revision's title and blocks. Hub revision IDs differ from \`get_doc\`'s page and block \`rev\` content hashes, and writing tools do not accept them.

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

A \`chart\` block holds editable JSON source, configured with ordinary \`create_doc\`, \`insert_block\` or \`edit_block\` calls. A line chart, bar chart, scatter plot or data table reads a collection from its own document. Its mapping names literal top-level fields; it contains no record values:

\`\`\`json
{"version":1,"type":"line","collection":"observations","x":{"field":"day","type":"date"},"y":[{"field":"count","label":"Count"}],"missing":"gap"}
\`\`\`

Mapping fields are version 1, type line, collection, x with field and type number or date (optional label), and one to eight numeric y series with field (optional label and unit). Optional y series type is line or bar, default line. Bars-only charts keep top-level type line and draw grouped bars from zero. In overlay, a mixed chart draws its bars behind its lines on a separate right-hand value axis. Optional title and missing gap or connect control presentation; gap is the default. Optional layout is overlay or panels, default overlay. panels draws one compact line or bar chart per y series in mapping order, in a responsive grid; each panel shows its label and latest plotted value. Panels share the x range and share y ranges within each unit group. Optional height is a whole number from 100 to 600 pixels. In overlay it sizes the drawing, including axes and legend, excluding the caption row and notices; in panels it sizes each plot below its label and latest value. Without height, overlay stays at 2:1 between 200 and 300 pixels, and each panel plot stays at 150 pixels. layout and height are invalid for table mappings. Each y series optionally accepts range [min, max], exactly two finite numbers with min lower than max, and reference, one finite number. In overlay, both apply to the series' left or right value axis. In panels, range applies to the series' unit group and reference draws only on that series' own panel. A range is a minimum span: the axis covers every declared range, and plotted or reference values outside it widen the axis. A declared range replaces the zero-baseline rule for line-only axes and panel unit groups. Axes and panel unit groups containing bars always include zero. A reference draws a horizontal line across the plot; each distinct reference value appears once per axis or panel. A panel's reference value also widens its unit group's shared range. range and reference are invalid on x and in table mappings. Optional limit is an integer of 1 or more and selects the latest N records with a valid x in x-then-record-id order, still at most 5,000. A numeric x is finite; a date x is an ISO date-only string or an RFC 3339 date-time string with an explicit timezone. Date-only values are UTC days. Charts sort by x then record id, never coerce or aggregate values, omit schema-invalid records and report omissions. Missing/null y values break a line series under gap and bridge under connect; wrong types remain gaps. Missing, null or wrong-type bar values draw no bar. At most the latest 5,000 eligible x records are plotted.

Each chart block written by \`create_doc\`, \`insert_block\` or \`edit_block\` adds a \`chart\` summary beside its id and rev. It uses the web's projection of this replica's current data: \`status\` is ready, invalid-configuration, collection-absent, collection-unusable, mapping-incompatible or no-records. A non-ready status carries the problem message and a warning; invalid JSON carries the parser's message. A missing collection also returns the document's collection names in \`collections\`. Once a line mapping binds its collection (ready or no-records), it reports total \`recordCount\`, \`plottedCount\` and \`series\` entries with each \`field\` and numeric \`pointCount\`; a series with no points adds a warning naming its field. Ready lines also report \`firstX\` and \`lastX\` as numbers for numeric x, or ISO date/date-time strings for date x. Plotted and per-series counts follow the mapping's selected window. Summaries contain no record values or points, apart from these x endpoints. Warnings never refuse, repair or roll back a write, and an unavailable summary leaves the write's application and durability result intact. A new document has no data yet, so a valid seeded mapping reports collection-absent.

### Scatter plots

\`\`\`json
{"version":1,"type":"scatter","collection":"options","x":{"field":"weekly_cost","label":"Weekly cost","lower":"cost_low","upper":"cost_high"},"y":{"field":"quality","label":"Quality","unit":"%","lower":"quality_low","upper":"quality_high","range":[0,100]},"label":"name","group":"tier","details":[{"field":"sample_size","label":"Sample size","format":"number","decimals":0},{"field":"source","label":"Source","format":"link"}],"title":"Quality versus weekly cost","height":320}
\`\`\`

A scatter mapping has version 1, type scatter, collection, numeric x and y axes, and a required label field. Each axis has field and optional label, unit, range, lower and upper; lower and upper name stored numeric bound fields. A range is a minimum span widened by plotted values and their drawn bounds. Absent or null bounds draw nothing; wrong-type bounds and bounds on the wrong side of the value are omitted and counted. No value is coerced, aggregated or calculated. Each schema-valid record with numeric x and y becomes one unconnected point tied to its record id, including records with identical coordinates. At most 5,000 points appear in record-id order, with shown/total counts when capped; omitted records are counted by reason.

Optional group gives up to 8 distinct values a colour and shape pair plus a legend entry; points without a value use a neutral style. With more than 8 values every point is neutral and a warning names the group field. Optional details has at most 8 entries in the data-table column grammar below. Labels use text-cell formatting; colliding labels are hidden but their points remain selectable. A click or tap on a point selects it, and every point is keyboard-selectable. A click elsewhere on the plot or Open chart source opens the source in editable and read-only documents. Details show the label, mapped group, x and y with axis labels, units and stored bounds (for example 82 % (76–87 %)), then details fields in mapping order, using table-cell formatting and links. Details sit below the plot at narrow widths. Selection is never saved, follows its record through updates, clears when that record is no longer plotted, and resets on mapping edits, remount or reload.

Optional title and height behave as for a line overlay, including the resize handle and iPad Height field. layout, limit, missing, reference, unknown keys and more than 8 details are invalid for scatter. Mapped fields missing from or incompatible with the collection schema show the same problem states as other chart mappings. A bound scatter mapping's write summary reports \`status\`, \`recordCount\`, \`plottedCount\` and \`warnings\`, without record values, series or x endpoints. A non-ready summary also carries its problem message and warning; group overflow adds a warning naming the group field.

### Data tables

People insert Data table from the block menu, then edit its JSON source. Agents use the same \`chart\` block type:

\`\`\`json
{"version":1,"type":"table","collection":"observations","columns":[{"field":"day","label":"Day","format":"date"},{"field":"count","label":"Count","format":"number","decimals":0},{"field":"run_h","label":"Run time","format":"number","unit":"h","decimals":1},{"field":"url","format":"link"}],"sort":{"field":"day","direction":"desc"}}
\`\`\`

A table mapping has version 1, type table, collection and 1–30 ordered columns. Each column has field, optional label and optional format: text (default), number, date or link. Only number accepts unit as a suffix and decimals as an integer from 0–10 setting exact fraction digits; without decimals it uses the line chart's number formatting. Optional title supplies only the table's accessible name; otherwise it is \`Data table of <collection>\`. Optional sort names one column field and direction asc or desc. Optional limit is an integer of 1 or more and shows only the first N valid rows in sort order (record-id order without sort). Existing pageSize values remain accepted as integers from 1–100 for compatibility and never affect display; omit pageSize from new mappings. Unknown keys or options are invalid, including percent, currency, duration and textField.

A bound table mapping's write summary reports \`recordCount\`, \`rowCount\` after limit and \`invalidRecordCount\` for schema-invalid records omitted, with no series or x endpoints. The same status, message and warning rules apply. Other block types carry no chart summary. These summaries describe data held at the time of the source write; \`get_doc\`, \`get_revision\`, \`move_block\` and \`update_data\` do not return them.

Text shows strings verbatim and other values as compact JSON. Number shows JSON numbers in the reader's locale. Date accepts the line chart's ISO dates and RFC 3339 date-times. Link shows only external http(s) URLs as links, opening without an opener or referrer. Absent, null and invalid values have distinct visible markers; invalid markers include the stored value as text. Values never become markup. Sort uses numbers, date instants or Unicode code points for text and links; absent, null and invalid values follow valid ones in either direction. Ties and unsorted rows follow record id. Schema-invalid records are omitted and counted. Without limit, every valid record appears in one continuous native table styled like an ordinary document table, with Generated from document data · read-only below it. Limited rows remain one continuous table, with no pager or page state. When limit hides rows, the footnote includes shown and total valid-record counts. Open table source and copy appear on hover or keyboard focus without moving the table; source stays reachable on devices without hover.

For both views, limit has no upper bound of its own. Records hidden by the author limit are not omissions. When it hides chart records, a muted note shows the latest shown and total valid-x counts; when it hides nothing, no count appears. The chart's 5,000 cap retains its existing notice and diagnostics when N exceeds 5,000.

\`update_data\` refreshes open charts and tables and recomputes a limited window without changing their source. All mounted views in one document share one validated data snapshot. Views are read-only; invalid mappings, missing collections, unsupported schemas and incompatible fields show problems without repairing stored content. Tables also report an empty collection. Charts and tables remain readable in locked documents; their source follows existing content locks. Search indexes titles, descriptions, block text, assigned tag names and code block languages, not record values; Markdown exports mappings while omitting datasets.

## Related

[get_data](uberblick://help/get_data) · [update_data](uberblick://help/update_data) · [Decision records](uberblick://help/decisions) · [Tool contracts](uberblick://help/tool-contracts) · [Supported Markdown](uberblick://help/markdown)`;

const toolContracts = `# Shared tool contracts

## Arguments and results

Every registered tool declares its input and output schemas. Input objects accept only declared fields; unknown or misspelled fields and mixed action shapes are refused before the handler runs. Successful results carry \`structuredContent\` and a text block containing the same JSON. Server-produced result objects are closed: an undeclared key, missing required field or wrong type yields a text-only \`internal_error\`, with mismatch detail on server stderr. Caller-stored schemas and record values are passed through without normalization, and data diagnostics remain free-form.

## Failures and recovery

${FAILURE_INSTRUCTIONS}

Failures are marked \`isError: true\` and omit structuredContent, so success-schema validation does not misinterpret a failure. A call started after shutdown begins is refused with \`server_shutting_down\`; begin a new MCP session before repeating that call. A persistence failure quarantines the replica until restart: ordinary workspace reads also refuse rather than returning state ahead of its durable log. A workspace removed from this computer refuses with \`workspace_removed\`; writes report \`applied: false\`. Fetching a new copy does not revive the old session: restart the MCP server to use it. The diagnostic tool sync_status still answers. Static help reads and get_help remain available because they do not open or settle replicas.

\`list_revisions\`, \`get_revision\` and \`get_data\` with \`revision\` answer from this computer's history cache. A cached read sends no hub request and remains readable offline, while signed out or after access is refused. Connected reads first download missing catalogs or checksum-verified snapshots into the cache within a bounded wait. A timed-out download continues and later reads find what it stored. Results include \`history\`: catalog \`complete\`, \`lastRefresh\` (ISO 8601 UTC or null), \`refreshFailed\`, \`offline\` and \`newestDownloadedRevision\` (ID or null). Completeness refers to the full catalog, not downloaded snapshot coverage. The newest downloaded state is not a claim about the hub's current state. Cached \`canManage\` and an open \`endedAt: null\` describe the last refresh. An unknown document UUID refuses with \`doc_not_found\`; permanent deletion refuses with \`doc_deleted\`, and decision records refuse with \`decision_no_history\`, before cache or hub access. History failures keep these specific codes and recoveries:

| Code | Recovery |
| --- | --- |
| \`revisions_local_only\` | Use a team-hub workspace; local-only workspaces have no hub history. |
| \`revisions_downloading\` | The bounded wait ended while history downloads into the cache; retry the same read later. |
| \`revisions_not_downloaded\` | Connect to fetch the missing history, then repeat the read. A never-downloaded catalog says Connect once to download history. |
| \`revisions_unreachable\` | Restore the hub connection, then retry the same read; sync_status reports the connection state. |
| \`revisions_sign_in_required\` | Run ub auth login, restart the MCP server, then repeat the read. |
| \`revisions_forbidden\` | Ask a workspace maintainer to grant read access before repeating the read. |
| \`revisions_unsupported\` | Ask the hub operator to update to a version that serves automatic revisions with snapshot checksums. |
| \`decision_no_history\` | Decision records have no history. Read the topic's records with get_doc instead. |
| \`revision_not_found\` | The catalog was revalidated online; list this document's revisions and select an ID belonging to it. Offline, an unknown ID is not downloaded instead. |
| \`revision_stale_state\` | Synchronize, read and review the current state before naming or restoring. |
| \`revision_restore_outcome_unknown\` | Call list_revisions with refresh: true, wait for success, and read get_doc before retrying a restore whose reply was lost. |
| \`revision_invalid_name\` | Supply 1 to 100 characters on one line. |
| \`revision_already_named\` | Read existingName; anyone with write access can rename or remove it in the web while the document is not archived. |
| \`revision_naming_outcome_unknown\` | A sent request may have applied. Call list_revisions with refresh: true and wait for success before retrying; applied is null. |

An empty history is returned only when a complete downloaded catalog records no revisions. A failed first download is never presented as no revisions. Archived documents remain readable. \`list_revisions({uuid, refresh: true})\` requires online catalog revalidation through the cache; a stale cached answer cannot settle an unknown mutation outcome.

Unknown help topics through get_help are manual refusals and name all valid topic ids. An unknown \`uberblick://help/{topic}\` resource raises JSON-RPC resource-not-found error -32002 naming its URI. Help is built in and version matched; no workspace document, tag or guidance content supplies it.

## Write durability and synced

Successful writes report \`applied\`, \`synced\` and \`hub\`. Applied means this server's local update log holds the write. Hub describes the connection, not remote storage. Calls touching multiple rooms report each room independently; aggregate synced is true only when every touched room is acknowledged. There is no rollback or cross-room remote atomicity. Hub-only \`name_revision\` and \`restore_revision\` are separate: applied means the hub applied the operation and synced means it acknowledged it. Naming writes its result through to the cache before returning; a cache write failure preserves applied: true and synced: true, and the hub's name notice refreshes the cache later. Naming offline refuses; there is no queue. Restore persists content and history before acknowledgement; normal sync delivers the content, followed by a background history refresh. Restore does not write through to the cache, so its new entry can be absent from a cached list until refreshed. An identical restore writes nothing, returning applied: false. A sent naming or restore request whose reply is lost reports \`applied: null\` and \`synced: false\`; call list_revisions with refresh: true and wait for success, and read get_doc for a restore, before retrying.

For ordinary replica writes, \`synced: true\` means the hub acknowledged this update: it is in the hub's memory, and a healthy hub has scheduled the write on its store debounce — by default 2s after the last change to the document, 10s at the outside. It does NOT mean the hub has stored it: the write is still ahead of the hub's disk, and the store itself can fail. A hub that dies abruptly inside that window (SIGKILL, a crash, power loss) loses its volatile copy of the update. That is recoverable rather than fatal: \`applied: true\` is the durable half — this server's append-only update log holds the write before the tool returns and re-sends it on reconnect — so losing it for good takes the crash plus no replica holding that update ever coming back.

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
    description: "Supported block and inline syntax, tables, embeds, content writes and Markdown export behavior.",
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

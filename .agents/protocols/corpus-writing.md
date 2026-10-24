# Corpus writing

Read before writing or rewriting a page in the MCP corpus. Authorization,
intent-versus-code and sync rules stay in
[AGENTS.md's Edit corpus rules](../../AGENTS.md#read-for-the-action).

## What a page is

A page states product intent: what a person can do and what they see. It is not
technical documentation. Leave out stack, architecture, file paths, data
structures and implementation mechanics. A page may describe how the system is
built only when its title clearly says so, for example "Technical: sync
protocol". Intent is written in the present tense and may be ahead of the code.

No PR or issue number, merge date, run id or "since" clause appears in a
Regular Document; GitHub owns that provenance.

## Start small

Write the smallest page that answers the request: the usage and one or two
scenarios. Expand only when a person asks for more. A new section on an
existing page follows the same rule.

## Shape

1. A usage block or a one-line example first.
2. A short section per command, screen or syntax, each with a snippet.
3. Scenarios: an H3 heading per situation with a short paragraph, including the
   exact output or text where it matters. Tables are for real reference data
   only, not scenarios.
4. Related links last.

Add a visual where it shows more than prose would: an `ablauf` diagram for a
flow or states, a `wireframe` for a screen, a code or JSON block for a command,
a tool call or what it returns. Leave it out when the prose is already clear.

## Length and tone

- Intros are one or two sentences. No TL;DR.
- Explain a concept only when the reader needs it to act; a larger concept gets
  its own page.
- Cut any sentence that restates what an example or output already shows.
- Plain words and full sentences.

## Which page owns a fact

Each fact has one owner. Rules that hold on every surface, such as what a
revision is or who may name one, live on the concept's page. How one surface
shows them lives on that surface's page: `Web UI: …`, `CLI: …` or `MCP: …`.
Other pages link to the owner. When a change touches a fact, edit its owner;
on any other page that repeats it, replace the copy with a link instead of
updating it.

## Level of detail

Write what a person needs to use the feature or to judge a change against it.
Keep an edge case when a person decided it or when getting it wrong costs
data, access or trust. Leave the rest to tests and code: focus order, exact
disabled and retry states, avatar shapes, animation timing, and refusals no
person decided.

## Editing

Rewrite, never append. Change the affected sentences to the new truth and
delete what they replace. Add a block only for a fact no existing block owns.

Before writing, read the whole page and decide its shape after the change. A
change that grows a page is a reshape, not a longer paragraph: put the fact
under the section it belongs to, adding an H2 when none fits, merge it with
what it refines, and cut what it supersedes. Reshape in the same edit when the
page shows any of these signs:

- a paragraph over about 120 words;
- a page over about 800 words, or headings missing past the first screen;
- surface detail on a concept page, or the same behavior described on two pages.

Reshaping moves surface detail to its owner and cuts detail the section above
leaves to tests. It never changes or weakens intent.

## A good page

A concept page in the shape above, with surface detail linked away:

```markdown
# Automatic document revisions

Uberblick keeps a document's earlier states, so you can see what a person or
an agent changed and go back to it.

## Example

Ben edits in the browser at 09:00, through Claude Code at 09:06, and in the
browser again at 09:40. History shows three revisions, one per stretch.

## What a revision is

- A revision opens with an author's first change and closes after 15 minutes,
  or earlier when another author edits.
- The author is the GitHub account plus where the edit came from.

## Reading revisions

In the browser: see [Web UI: document history](<uuid>).

    list_revisions({ uuid })
    get_revision({ uuid, revision })

## Scenarios

### What did the agent change overnight?

One short paragraph with the exact text a person sees.

## Related

[Archiving and deleting documents](<uuid>)
```

The opposite: one 600-word paragraph on a concept page listing keyboard focus,
button wording and avatar shapes, grown a sentence per change.

## Naming

The product is "Uberblick", never with an umlaut. Commands, syntax and UI labels
appear in code formatting, exactly as the product shows them.
